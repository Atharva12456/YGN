"""Snapshot AI bill descriptions + impacts into docs/data/bill-ai.json so the
live site serves committed content instead of regenerating on every request
(and so it survives Heroku dyno restarts, which wipe the in-memory SQLite AI
cache). Merges with any existing entries, so previously-committed bills persist
even after they age out of the recent feed -- that is the "hardcoded so I don't
regenerate every time" behaviour.

Usage (from repo root):
    python scripts/snapshot_bill_ai.py --limit 25

Requires an AI provider (AZURE_OPENAI_* / OPENAI_*) AND CONGRESS_API_KEY in the
environment -- in CI these are the same secrets the static-data workflow uses.
No-ops gracefully (writes nothing new) when no AI provider is configured.
"""

import argparse
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BACKEND_PATH = REPO / "empty-folder" / "CongressMembers.py"
OUT_PATH = REPO / "docs" / "data" / "bill-ai.json"


def load_backend():
    spec = importlib.util.spec_from_file_location("ygn_backend_snapshot", BACKEND_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _trim(entry):
    """Keep only the fields the live reader needs (summary + provenance)."""
    if not isinstance(entry, dict) or not entry.get("summary"):
        return None
    out = {"summary": entry["summary"]}
    for key in ("model", "provider", "generated_at"):
        if entry.get(key):
            out[key] = entry[key]
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=25, help="How many recent bills to snapshot.")
    args = parser.parse_args()

    backend = load_backend()
    if not backend.ai_insights_available():
        print("No AI provider configured; leaving bill-ai.json unchanged.")
        return 0
    if not backend.congress_api_key_available():
        print("CONGRESS_API_KEY not set; cannot fetch bills.", file=sys.stderr)
        return 1

    existing = {}
    if OUT_PATH.exists():
        try:
            existing = json.loads(OUT_PATH.read_text(encoding="utf-8")).get("bills", {}) or {}
        except (ValueError, OSError):
            existing = {}

    digest = backend.getRecentBillDigest(limit=min(max(args.limit, 1), 40))
    bills = digest.get("bills", []) if isinstance(digest, dict) else []
    added = 0
    for bill in bills:
        path = bill.get("detailPath")
        identifier = bill.get("identifier")
        if not path or not identifier:
            continue
        parts = path.split("/")
        if len(parts) != 3:
            continue
        try:
            detail = backend.get_bill_detail(parts[0], parts[1], parts[2], include_votes=False)
        except Exception as exc:  # noqa: BLE001
            print(f"  skip {identifier}: {type(exc).__name__}")
            continue
        item = (detail or {}).get("bill", {})
        desc = _trim(item.get("aiDescription"))
        impact = _trim(item.get("impact"))
        if not desc and not impact:
            continue
        entry = existing.get(identifier, {})
        if desc:
            entry["description"] = desc
        if impact:
            entry["impact"] = impact
        entry["title"] = item.get("title")
        existing[identifier] = entry
        added += 1
        print(f"  snapshot {identifier}: desc={bool(desc)} impact={bool(impact)}")

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(existing),
        "bills": existing,
    }
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {len(existing)} bill AI entries ({added} refreshed) -> {OUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
