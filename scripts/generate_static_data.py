import argparse
import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timezone
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


def safe_id(value):
    return re.sub(r"[^A-Za-z0-9_-]", "", value or "")


def member_bioguide_id(member):
    return member.get("bioguideId") or member.get("bioguideID") or member.get("bioguide_id")


def collect_members(backend, limit, max_members):
    members = []
    offset = 0

    while True:
        page = backend.listCongressMembers(limit=limit, offset=offset)
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
    parser.add_argument("--max-members", type=int, default=250)
    parser.add_argument("--limit", type=int, default=250)
    parser.add_argument("--skip-details", action="store_true")
    parser.add_argument("--skip-wiki", action="store_true")
    parser.add_argument("--skip-nominate", action="store_true")
    parser.add_argument("--skip-recent-bills", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    backend = load_backend()

    if not backend.congress_api_key_available():
        print("CONGRESS_API_KEY is required to generate static data.", file=sys.stderr)
        return 2

    output_dir = Path(args.output_dir)
    generated_at = datetime.now(timezone.utc).isoformat()
    report = {
        "generated_at": generated_at,
        "members": 0,
        "details": 0,
        "wiki": 0,
        "nominate": 0,
        "recent_bills": False,
        "errors": [],
    }

    try:
        members = collect_members(backend, limit=args.limit, max_members=args.max_members)
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
            try:
                wiki = backend.get_wiki_summary(bioguide_id)
                write_json(
                    output_dir / "wiki" / f"{bioguide_id}.json",
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
