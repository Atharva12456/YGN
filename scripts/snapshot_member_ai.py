"""Generate + commit AI member overviews (docs/data/member-ai/{id}.json).

Budgeted like the FEC ethics sweep: each run refreshes at most --budget members
that lack a current committed overview, so the roster fills across scheduled
runs without a single giant model bill. Public routes never call the model --
they serve these committed files (or the refresh cache) only.
"""

import argparse
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BACKEND_PATH = REPO / "empty-folder" / "CongressMembers.py"
OUT_DIR = REPO / "docs" / "data" / "member-ai"
OFFICIALS_PATH = REPO / "docs" / "data" / "officials.json"


def load_backend():
    spec = importlib.util.spec_from_file_location("ygn_backend_member_ai", BACKEND_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return default


def atomic_write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def entry_is_current(payload, content_version):
    overview = (payload or {}).get("overview") or {}
    return bool(overview.get("summary")) and overview.get("content_version") == content_version


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget", type=int, default=20,
                        help="Max members to generate per run (model calls).")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    backend = load_backend()
    if not backend.ai_insights_available():
        print("No AI provider configured; leaving member-ai snapshots unchanged.")
        return 0
    if not backend.congress_api_key_available():
        print("CONGRESS_API_KEY not set; cannot build member seeds.", file=sys.stderr)
        return 1

    officials = read_json(OFFICIALS_PATH, {})
    members = officials.get("members", []) or []
    if not members:
        print("No officials roster found; run generate_static_data first.", file=sys.stderr)
        return 1

    budget = max(0, args.budget)
    generated = 0
    skipped = 0
    failures = 0

    for member in members:
        if generated >= budget:
            break
        bioguide_id = member.get("bioguideId")
        if not bioguide_id:
            continue
        out_path = OUT_DIR / f"{bioguide_id}.json"
        existing = read_json(out_path, None)
        if not args.force and entry_is_current(existing, backend.AI_MEMBER_CONTENT_VERSION):
            skipped += 1
            continue
        try:
            result = backend.refresh_member_ai(bioguide_id, force=True)
        except Exception as exc:  # noqa: BLE001 - keep prior committed content
            failures += 1
            print(f"  keep prior {bioguide_id}: {type(exc).__name__}")
            continue
        overview = result.get("overview")
        if not (overview and overview.get("summary")):
            failures += 1
            print(f"  no overview for {bioguide_id}: {result.get('reason') or 'empty'}")
            continue
        atomic_write_json(
            out_path,
            {
                "bioguideId": bioguide_id,
                "name": result.get("seedName") or member.get("name"),
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "overview": overview,
            },
        )
        generated += 1
        print(f"  wrote member-ai/{bioguide_id}.json ({result.get('seedName') or ''})")

    total = len(list(OUT_DIR.glob("*.json"))) if OUT_DIR.exists() else 0
    print(
        f"Member AI snapshot: {generated} generated, {skipped} current, "
        f"{failures} failed; {total} committed overall."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
