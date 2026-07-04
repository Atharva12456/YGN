import argparse
import importlib.util
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_PATH = PROJECT_ROOT / "empty-folder" / "CongressMembers.py"
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "docs" / "data"


def load_backend():
    spec = importlib.util.spec_from_file_location("ygn_government_backend", BACKEND_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load backend module at {BACKEND_PATH}.")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def parse_generated_at(value):
    if not value:
        return None

    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)

    return parsed


def reusable_wiki_snapshot(path, generated_at, ttl_days):
    if ttl_days <= 0 or not path.exists():
        return None

    try:
        payload = read_json(path)
    except (OSError, json.JSONDecodeError):
        return None

    summary_text = payload.get("summary") or payload.get("extract")
    if not summary_text:
        return None

    snapshot_time = parse_generated_at(payload.get("generated_at"))
    if snapshot_time is None:
        return None

    if generated_at - snapshot_time > timedelta(days=ttl_days):
        return None

    return payload


def safe_id(value):
    return re.sub(r"[^A-Za-z0-9_-]", "", value or "")


def member_bioguide_id(member):
    return member.get("bioguideId") or member.get("bioguideID") or member.get("bioguide_id")


def parse_max_members(value):
    if value is None:
        return None

    normalized = str(value).strip().lower()
    if normalized in {"", "all", "none", "0"}:
        return None

    try:
        max_members = int(normalized)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "--max-members must be a positive integer or 'all'."
        ) from exc

    if max_members < 1:
        raise argparse.ArgumentTypeError("--max-members must be greater than zero or 'all'.")

    return max_members


def current_congress_number(now=None):
    now = now or datetime.now(timezone.utc)
    effective_year = now.year
    if effective_year % 2 == 1 and (now.month, now.day) < (1, 3):
        effective_year -= 1
    return ((effective_year - 1789) // 2) + 1


def default_congress_number():
    raw_value = os.getenv("YGN_CONGRESS", "").strip()
    if not raw_value:
        return current_congress_number()
    return int(raw_value)


def collect_members(backend, limit, max_members, congress, current_member):
    members = []
    offset = 0

    while True:
        page = backend.listCongressMembers(
            limit=limit,
            offset=offset,
            congress=congress,
            current_member=current_member,
        )
        page_members = page.get("members", [])
        if not page_members:
            break

        for member in page_members:
            if max_members is not None and len(members) >= max_members:
                return members
            members.append(member)

        offset += limit
        total = page.get("pagination", {}).get("count", len(members))
        if offset >= total:
            break

    return members


def parse_args():
    parser = argparse.ArgumentParser(description="Generate static JSON snapshots for GitHub Pages.")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument(
        "--max-members",
        type=parse_max_members,
        default=parse_max_members(os.getenv("YGN_MAX_MEMBERS", "all")),
        help="Maximum members to snapshot, or 'all'. Defaults to all.",
    )
    parser.add_argument("--limit", type=int, default=250)
    parser.add_argument(
        "--congress",
        type=int,
        default=default_congress_number(),
        help="Congress number to snapshot. Defaults to the current Congress.",
    )
    parser.add_argument(
        "--include-former-members",
        action="store_true",
        help="Include former members who served in the selected Congress.",
    )
    parser.add_argument("--skip-details", action="store_true")
    parser.add_argument("--skip-wiki", action="store_true")
    parser.add_argument("--skip-nominate", action="store_true")
    parser.add_argument("--skip-recent-bills", action="store_true")
    parser.add_argument(
        "--wiki-static-ttl-days",
        type=int,
        default=int(os.getenv("YGN_WIKI_STATIC_TTL_DAYS", "30")),
        help="Reuse existing docs/data/wiki files for this many days.",
    )
    parser.add_argument(
        "--wiki-delay-seconds",
        type=float,
        default=float(os.getenv("YGN_WIKI_DELAY_SECONDS", "0.5")),
        help="Pause after each new Wikipedia request to avoid rate limits.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    backend = load_backend()

    if not backend.congress_api_key_available():
        print("CONGRESS_API_KEY is required to generate static data.", file=sys.stderr)
        return 2

    output_dir = Path(args.output_dir)
    generated_at = datetime.now(timezone.utc).isoformat()
    generated_at_dt = datetime.fromisoformat(generated_at)
    report = {
        "generated_at": generated_at,
        "congress": args.congress,
        "current_member": not args.include_former_members,
        "members": 0,
        "details": 0,
        "wiki": 0,
        "wiki_reused": 0,
        "nominate": 0,
        "recent_bills": False,
        "errors": [],
    }

    try:
        members = collect_members(
            backend,
            limit=args.limit,
            max_members=args.max_members,
            congress=args.congress,
            current_member=not args.include_former_members,
        )
    except backend.UpstreamDataError as exc:
        print(str(exc), file=sys.stderr)
        return 3

    report["members"] = len(members)
    write_json(
        output_dir / "officials.json",
        {
            "generated_at": generated_at,
            "members": members,
        },
    )

    write_json(
        output_dir / "health.json",
        {
            "generated_at": generated_at,
            "mode": "static",
            "status": "ok",
        },
    )

    if not args.skip_recent_bills:
        try:
            recent_bills = backend.getRecentBills()
            write_json(
                output_dir / "recent-bills.json",
                {
                    "generated_at": generated_at,
                    "data": recent_bills,
                },
            )
            report["recent_bills"] = True
        except Exception as exc:
            report["errors"].append({"stage": "recent-bills", "error": str(exc)})

    for member in members:
        bioguide_id = safe_id(member_bioguide_id(member))
        if not bioguide_id:
            continue

        if not args.skip_details:
            try:
                detail = backend.CongressMembersID(bioguide_id)
                write_json(
                    output_dir / "profiles" / f"{bioguide_id}.json",
                    {
                        "generated_at": generated_at,
                        "data": detail,
                    },
                )
                report["details"] += 1
            except Exception as exc:
                report["errors"].append(
                    {"bioguideId": bioguide_id, "stage": "detail", "error": str(exc)}
                )

        if not args.skip_wiki:
            wiki_path = output_dir / "wiki" / f"{bioguide_id}.json"
            if reusable_wiki_snapshot(wiki_path, generated_at_dt, args.wiki_static_ttl_days):
                report["wiki"] += 1
                report["wiki_reused"] += 1
                continue

            try:
                wiki = backend.get_wiki_summary(bioguide_id)
                write_json(
                    wiki_path,
                    {
                        "generated_at": generated_at,
                        **wiki,
                    },
                )
                report["wiki"] += 1
            except Exception as exc:
                report["errors"].append(
                    {"bioguideId": bioguide_id, "stage": "wiki", "error": str(exc)}
                )
            finally:
                if args.wiki_delay_seconds > 0:
                    time.sleep(args.wiki_delay_seconds)

        if not args.skip_nominate:
            try:
                nominate = backend.get_nominate_score(bioguide_id)
                if nominate is not None:
                    write_json(
                        output_dir / "nominate" / f"{bioguide_id}.json",
                        {
                            "generated_at": generated_at,
                            **nominate,
                        },
                    )
                    report["nominate"] += 1
            except Exception as exc:
                report["errors"].append(
                    {"bioguideId": bioguide_id, "stage": "nominate", "error": str(exc)}
                )

    write_json(output_dir / "manifest.json", report)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
