import argparse
import importlib.util
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
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


def _semantic_payload(payload):
    if isinstance(payload, dict):
        return {key: value for key, value in payload.items() if key != "generated_at"}
    return payload


def write_json(path, payload, *, force=False):
    """Atomically write only when public data changed.

    Per-run timestamps no longer churn thousands of otherwise identical files.
    Returns True when the file changed.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if not force and path.exists():
        try:
            existing = read_json(path)
        except (OSError, json.JSONDecodeError):
            existing = None
        if _semantic_payload(existing) == _semantic_payload(payload):
            return False
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    temporary.replace(path)
    return True


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


def is_fallback_description(payload):
    return payload.get("source") == "congress_fallback"


def is_disambiguation_description(payload):
    summary_type = str(payload.get("type") or "").lower()
    title = str(payload.get("title") or "").lower()
    text = str(payload.get("summary") or payload.get("extract") or "").lower()
    return (
        summary_type == "disambiguation"
        or "may refer to:" in text
        or "may also refer to:" in text
        or "can refer to:" in text
        or "is the name of:" in text
        or title.endswith("(disambiguation)")
    )


def reusable_wiki_snapshot(path, generated_at, ttl_days, fallback_ttl_days):
    if ttl_days <= 0 or not path.exists():
        return None

    try:
        payload = read_json(path)
    except (OSError, json.JSONDecodeError):
        return None

    summary_text = payload.get("summary") or payload.get("extract")
    if not summary_text:
        return None
    if is_disambiguation_description(payload):
        return None

    snapshot_time = parse_generated_at(payload.get("generated_at"))
    if snapshot_time is None:
        return None

    effective_ttl_days = fallback_ttl_days if is_fallback_description(payload) else ttl_days
    if effective_ttl_days <= 0:
        return None

    if generated_at - snapshot_time > timedelta(days=effective_ttl_days):
        return None

    return payload


def read_existing_snapshot(path):
    if not path.exists():
        return None
    try:
        return read_json(path)
    except (OSError, json.JSONDecodeError):
        return None


def reusable_ethics_snapshot(
    path,
    generated_at,
    ttl_days,
    expected_method=None,
    require_funding=False,
):
    """Reuse a committed live (fec_live) ethics grade if it is still fresh, so a
    run doesn't re-spend FEC quota on members already scored. Returns the payload
    with its original data timestamp or None."""
    if ttl_days <= 0:
        return None
    payload = read_existing_snapshot(path)
    if not payload or payload.get("source") != "fec_live" or not payload.get("grade"):
        return None
    if expected_method and payload.get("method") != expected_method:
        return None
    if require_funding and not (payload.get("funding") or {}).get("available"):
        return None
    snapshot_time = parse_generated_at(payload.get("generated_at"))
    if snapshot_time is None or generated_at - snapshot_time > timedelta(days=ttl_days):
        return None
    return payload


def funding_snapshot_from_ethics(ethics):
    """Expose FEC totals already saved with an ethics score to the static dossier."""
    unavailable = {
        "available": False,
        "source": "static",
        "note": "Campaign-funding detail is not available in this snapshot.",
    }
    if not isinstance(ethics, dict):
        return unavailable
    saved = ethics.get("funding")
    if not isinstance(saved, dict) or not saved.get("available"):
        return unavailable

    # Avoid nesting the funding payload inside its own grade context.
    grade = {key: value for key, value in ethics.items() if key != "funding"}
    return {
        "bioguideId": ethics.get("bioguideId"),
        **saved,
        "source": "fec_committed",
        "note": None,
        "grade": grade,
    }


def evidence_backed_ethics(payload, expected_method):
    return bool(
        payload
        and payload.get("source") == "fec_live"
        and payload.get("method") == expected_method
        and payload.get("grade")
        and payload.get("grade") != "N/A"
        and isinstance(payload.get("score"), (int, float))
    )


def ethics_refresh_selection(
    members,
    output_dir,
    generated_at,
    ttl_days,
    expected_method,
    limit,
    previous_cursor=None,
):
    """Choose the next budgeted slice of members that needs a live FEC refresh.

    The cursor advances through the whole roster, including members whose FEC
    lookup fails. Without it, every scheduled run spends its quota retrying the
    same first alphabetical members and the static grade index never fills in.
    """
    member_ids = [safe_id(member_bioguide_id(member)) for member in members]
    member_ids = [bioguide_id for bioguide_id in member_ids if bioguide_id]
    if not member_ids or limit <= 0:
        return [], previous_cursor

    start = 0
    if previous_cursor in member_ids:
        start = (member_ids.index(previous_cursor) + 1) % len(member_ids)
    ordered_ids = member_ids[start:] + member_ids[:start]

    selected = []
    for bioguide_id in ordered_ids:
        path = output_dir / "ethics" / f"{bioguide_id}.json"
        if reusable_ethics_snapshot(
            path,
            generated_at,
            ttl_days,
            expected_method=expected_method,
            require_funding=True,
        ) is not None:
            continue
        selected.append(bioguide_id)
        if len(selected) >= limit:
            break

    return selected, (selected[-1] if selected else previous_cursor)


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


def build_roster_summary(backend, members):
    nonvoting = {"DC", "PR", "GU", "VI", "AS", "MP"}
    summary = {
        "total": len(members),
        "by_chamber": {},
        "by_party": {},
        "by_chamber_party": {},
        "voting_by_chamber_party": {},
    }
    for member in members:
        chamber_text = str(backend._member_chamber(member) or "").lower()
        chamber = "Senate" if "senate" in chamber_text else "House"
        party = backend._party_abbreviation(member) or "Other"
        summary["by_chamber"][chamber] = summary["by_chamber"].get(chamber, 0) + 1
        summary["by_party"][party] = summary["by_party"].get(party, 0) + 1
        chamber_parties = summary["by_chamber_party"].setdefault(chamber, {})
        chamber_parties[party] = chamber_parties.get(party, 0) + 1
        state = backend._member_state_code(member)
        if chamber != "House" or state not in nonvoting:
            voting = summary["voting_by_chamber_party"].setdefault(chamber, {})
            voting[party] = voting.get(party, 0) + 1
    return summary


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
    parser.add_argument("--skip-ethics", action="store_true")
    parser.add_argument("--skip-recent-bills", action="store_true")
    parser.add_argument(
        "--ethics-only",
        action="store_true",
        help="Refresh only the budgeted ethics slice. Reuses all other committed "
        "snapshots and avoids rebuilding hundreds of member dossiers.",
    )
    parser.add_argument(
        "--wiki-static-ttl-days",
        type=int,
        default=int(os.getenv("YGN_WIKI_STATIC_TTL_DAYS", "30")),
        help="Reuse existing docs/data/wiki files for this many days.",
    )
    parser.add_argument(
        "--fallback-static-ttl-days",
        type=int,
        default=int(os.getenv("YGN_FALLBACK_STATIC_TTL_DAYS", "1")),
        help="Reuse non-Wikipedia fallback descriptions for this many days.",
    )
    parser.add_argument(
        "--wiki-delay-seconds",
        type=float,
        default=float(os.getenv("YGN_WIKI_DELAY_SECONDS", "0.5")),
        help="Pause after each new Wikipedia request to avoid rate limits.",
    )
    parser.add_argument(
        "--fec-score-limit",
        type=int,
        default=int(os.getenv("YGN_FEC_SCORE_LIMIT", "12")),
        help="Max members to score against live FEC per run (fits a ~60/hr key). "
        "Members with a fresh committed fec_live grade are kept for free; the rest "
        "fill in over subsequent runs. Raise this if you have a higher-limit key.",
    )
    parser.add_argument(
        "--fec-delay-seconds",
        type=float,
        default=float(os.getenv("YGN_FEC_DELAY_SECONDS", "0")),
        help="Pause after each live FEC-scored member to spread the calls out.",
    )
    parser.add_argument(
        "--fec-workers",
        type=int,
        default=int(os.getenv("YGN_FEC_WORKERS", "1")),
        help="Concurrent live FEC member lookups in ethics-only mode. The number "
        "of API calls is unchanged; only their wall-clock overlap changes.",
    )
    parser.add_argument(
        "--ethics-static-ttl-days",
        type=int,
        default=int(os.getenv("YGN_ETHICS_STATIC_TTL_DAYS", "25")),
        help="Reuse a committed fec_live ethics grade for this many days before "
        "re-scoring it against FEC.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    if args.ethics_only:
        args.skip_details = True
        args.skip_wiki = True
        args.skip_nominate = True
        args.skip_recent_bills = True
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
        "descriptions": 0,
        "wiki": 0,
        "wiki_reused": 0,
        "fallback_descriptions": 0,
        "nominate": 0,
        "ethics": 0,
        "ethics_fallback": 0,
        "member_score_index": False,
        "recent_bills": False,
        "bill_details": 0,
        "dossiers": 0,
        "debt_metric": False,
        "errors": [],
    }
    member_score_index = {
        "generated_at": generated_at,
        "congress": args.congress,
        "nominate": {},
        "ethics": {},
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
    if (
        output_dir.resolve() == DEFAULT_OUTPUT_DIR.resolve()
        and args.max_members is None
        and not args.include_former_members
        and len(members) < 500
    ):
        print(
            f"Refusing to replace the public roster with only {len(members)} current members.",
            file=sys.stderr,
        )
        return 4

    current_member_ids = {
        safe_id(member_bioguide_id(member))
        for member in members
        if safe_id(member_bioguide_id(member))
    }
    previous_score_index = read_existing_snapshot(output_dir / "member-scores.json") or {}
    if previous_score_index.get("congress") == args.congress:
        if args.skip_nominate:
            member_score_index["nominate"] = {
                bioguide_id: score
                for bioguide_id, score in (previous_score_index.get("nominate") or {}).items()
                if bioguide_id in current_member_ids
            }
        member_score_index["ethics"] = {
            bioguide_id: score
            for bioguide_id, score in (previous_score_index.get("ethics") or {}).items()
            if bioguide_id in current_member_ids
            and evidence_backed_ethics(score, backend.ETHICS_METHOD_VERSION)
        }
    # The per-member snapshots are the source of truth. Rebuild from them as
    # well, so a prior partial/--skip-ethics index cannot hide valid grades.
    for bioguide_id in current_member_ids:
        snapshot = read_existing_snapshot(
            output_dir / "ethics" / f"{bioguide_id}.json"
        )
        if evidence_backed_ethics(snapshot, backend.ETHICS_METHOD_VERSION):
            member_score_index["ethics"][bioguide_id] = {
                key: snapshot.get(key)
                for key in (
                    "score",
                    "grade",
                    "source",
                    "method",
                    "updated_at",
                    "cycle",
                )
                if snapshot.get(key) is not None
            }

    previous_manifest = read_existing_snapshot(output_dir / "manifest.json") or {}
    ethics_refresh_ids, ethics_sweep_cursor = ethics_refresh_selection(
        members,
        output_dir,
        generated_at_dt,
        args.ethics_static_ttl_days,
        backend.ETHICS_METHOD_VERSION,
        args.fec_score_limit if not args.skip_ethics else 0,
        previous_manifest.get("ethics_sweep_cursor"),
    )
    ethics_refresh_ids = set(ethics_refresh_ids)
    report["ethics_sweep_cursor"] = ethics_sweep_cursor
    report["roster_summary"] = build_roster_summary(backend, members)
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
        force=True,
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
            recent_bill_digest = backend.getRecentBillDigest(limit=40)
            write_json(
                output_dir / "recent-bills-digest.json",
                {
                    "generated_at": generated_at,
                    **recent_bill_digest,
                },
            )
            for bill in recent_bill_digest.get("bills", []):
                path = str(bill.get("detailPath") or "")
                parts = path.split("/")
                if len(parts) != 3:
                    continue
                try:
                    detail = backend.get_bill_detail(
                        parts[0], parts[1], parts[2], include_votes=False
                    )
                    write_json(
                        output_dir / "bills" / f"{parts[0]}-{parts[1]}-{parts[2]}.json",
                        detail,
                    )
                    report["bill_details"] += 1
                except Exception as exc:
                    report["errors"].append(
                        {"stage": "bill-detail", "bill": path, "error": str(exc)}
                    )
            report["recent_bills"] = True
        except Exception as exc:
            report["errors"].append({"stage": "recent-bills", "error": str(exc)})

    if not args.ethics_only:
        try:
            debt = backend.get_national_debt_metric()
            if debt:
                write_json(output_dir / "metrics" / "debt.json", debt)
                report["debt_metric"] = True
        except Exception as exc:
            report["errors"].append({"stage": "debt-metric", "error": str(exc)})

    fec_scored = 0  # members scored against live FEC this run (budget-limited)
    parallel_ethics = {}
    parallel_ethics_errors = {}
    if (
        args.ethics_only
        and args.fec_workers > 1
        and args.fec_delay_seconds <= 0
        and ethics_refresh_ids
    ):
        with ThreadPoolExecutor(
            max_workers=min(args.fec_workers, len(ethics_refresh_ids))
        ) as executor:
            futures = {
                executor.submit(backend.compute_ethics_score, bioguide_id): bioguide_id
                for bioguide_id in ethics_refresh_ids
            }
            for future in as_completed(futures):
                bioguide_id = futures[future]
                try:
                    parallel_ethics[bioguide_id] = future.result()
                except Exception as exc:
                    parallel_ethics_errors[bioguide_id] = exc

    for member in members:
        bioguide_id = safe_id(member_bioguide_id(member))
        if not bioguide_id:
            continue

        detail = None
        wiki = None
        nominate = None
        ethics = None

        if args.skip_ethics:
            existing_ethics = read_existing_snapshot(
                output_dir / "ethics" / f"{bioguide_id}.json"
            )
            if evidence_backed_ethics(existing_ethics, backend.ETHICS_METHOD_VERSION):
                ethics = existing_ethics

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
        else:
            existing_profile = read_existing_snapshot(
                output_dir / "profiles" / f"{bioguide_id}.json"
            )
            detail = (existing_profile or {}).get("data")

        if not args.skip_wiki:
            wiki_path = output_dir / "wiki" / f"{bioguide_id}.json"
            reusable_wiki = reusable_wiki_snapshot(
                wiki_path,
                generated_at_dt,
                args.wiki_static_ttl_days,
                args.fallback_static_ttl_days,
            )
            if reusable_wiki:
                wiki = {key: value for key, value in reusable_wiki.items() if key != "generated_at"}
                report["descriptions"] += 1
                if is_fallback_description(reusable_wiki):
                    report["fallback_descriptions"] += 1
                else:
                    report["wiki"] += 1
                    report["wiki_reused"] += 1
            else:
                try:
                    wiki = backend.get_wiki_summary(bioguide_id)
                    write_json(
                        wiki_path,
                        {
                            "generated_at": generated_at,
                            **wiki,
                        },
                    )
                    report["descriptions"] += 1
                    if is_fallback_description(wiki):
                        report["fallback_descriptions"] += 1
                    else:
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
                    member_score_index["nominate"][bioguide_id] = nominate
                    report["nominate"] += 1
            except Exception as exc:
                report["errors"].append(
                    {"bioguideId": bioguide_id, "stage": "nominate", "error": str(exc)}
                )

        if not args.skip_ethics:
            ethics_path = output_dir / "ethics" / f"{bioguide_id}.json"
            try:
                reused = reusable_ethics_snapshot(
                    ethics_path,
                    generated_at_dt,
                    args.ethics_static_ttl_days,
                    expected_method=backend.ETHICS_METHOD_VERSION,
                    require_funding=True,
                )
                if reused is not None:
                    # Already have a fresh live grade committed — keep it, no FEC call.
                    ethics = reused
                elif bioguide_id in ethics_refresh_ids:
                    # Spend this run's FEC budget trying to score this member live.
                    fec_scored += 1
                    if bioguide_id in parallel_ethics_errors:
                        raise parallel_ethics_errors[bioguide_id]
                    ethics = parallel_ethics.get(bioguide_id)
                    if ethics is None:
                        ethics = backend.compute_ethics_score(bioguide_id)
                    if (ethics or {}).get("source") != "fec_live":
                        # Rate-limited / no FEC match: prefer an older committed live
                        # grade over a fresh fallback so we never regress a real grade.
                        prior = read_existing_snapshot(ethics_path)
                        if (
                            prior
                            and prior.get("source") == "fec_live"
                            and prior.get("method") == backend.ETHICS_METHOD_VERSION
                            and prior.get("grade")
                        ):
                            ethics = prior
                    if args.fec_delay_seconds > 0:
                        time.sleep(args.fec_delay_seconds)
                else:
                    # Budget spent this run: keep the existing snapshot if any, else a
                    # no-FEC static fallback (subsequent runs will score it live).
                    prior = read_existing_snapshot(ethics_path)
                    if (
                        prior
                        and prior.get("source") == "fec_live"
                        and prior.get("method") == backend.ETHICS_METHOD_VERSION
                        and prior.get("grade")
                    ):
                        ethics = prior
                    elif args.ethics_only and prior is not None:
                        # A checkpoint sweep must not make another Congress API call
                        # for every unselected member just to recreate the same N/A.
                        ethics = prior
                    else:
                        ethics = backend.ethics_fallback_only(bioguide_id)

                if ethics is not None:
                    ethics_payload = (
                        ethics
                        if ethics.get("generated_at")
                        else {"generated_at": generated_at, **ethics}
                    )
                    write_json(ethics_path, ethics_payload)
                    if (
                        ethics.get("source") == "fec_live"
                        and ethics.get("method") == backend.ETHICS_METHOD_VERSION
                    ):
                        member_score_index["ethics"][bioguide_id] = {
                            key: ethics.get(key)
                            for key in (
                                "score",
                                "grade",
                                "source",
                                "method",
                                "updated_at",
                                "cycle",
                            )
                            if ethics.get(key) is not None
                        }
                    report["ethics"] += 1
                    if ethics.get("source") != "fec_live":
                        report["ethics_fallback"] += 1
            except Exception as exc:
                report["errors"].append(
                    {"bioguideId": bioguide_id, "stage": "ethics", "error": str(exc)}
                )

        if detail and not args.ethics_only:
            dossier_errors = []

            def dossier_section(stage, fetcher):
                try:
                    return fetcher()
                except Exception as exc:
                    dossier_errors.append({"stage": stage, "error": str(exc)})
                    return None

            public_ethics = (
                ethics
                if ethics
                and ethics.get("source") == "fec_live"
                and ethics.get("method") == backend.ETHICS_METHOD_VERSION
                else None
            )
            dossier = {
                "generated_at": generated_at,
                "bioguideId": bioguide_id,
                "member": detail.get("member") or member,
                "detail": detail,
                "wiki": wiki,
                "nominate": nominate,
                "ethics": public_ethics,
                "funding": funding_snapshot_from_ethics(public_ethics),
                "committees": dossier_section(
                    "committees", lambda: backend.get_member_committees(bioguide_id)
                ),
                "contact": dossier_section(
                    "contact", lambda: backend.get_member_contact(bioguide_id)
                ),
                "history": dossier_section(
                    "history", lambda: backend.get_member_history(bioguide_id)
                ),
                "legislation": {
                    "available": False,
                    "sponsored": [],
                    "cosponsored": [],
                    "note": "Live legislation detail is available on the hosted API.",
                },
                "stocks": {
                    "available": False,
                    "provider": "static",
                    "trades": [],
                    "filings": [],
                    "note": "Live financial-disclosure detail is available on the hosted API.",
                },
                "errors": dossier_errors,
            }
            write_json(output_dir / "dossier" / f"{bioguide_id}.json", dossier)
            report["dossiers"] += 1

    report["fec_scored_this_run"] = fec_scored

    if member_score_index["nominate"] or member_score_index["ethics"]:
        write_json(output_dir / "member-scores.json", member_score_index)
        report["member_score_index"] = True

    write_json(output_dir / "manifest.json", report, force=True)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
