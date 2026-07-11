"""Refresh only new or changed bill AI and persist it for read-only serving.

The scheduled data workflow is the durable writer. Public HTTP routes never call
the model; they serve this file, a refresh cache, or an honest pending fallback.
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
DIGEST_PATH = REPO / "docs" / "data" / "recent-bills-digest.json"
BILLS_DIR = REPO / "docs" / "data" / "bills"


def load_backend():
    spec = importlib.util.spec_from_file_location("ygn_backend_snapshot", BACKEND_PATH)
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


def trim_generated_field(entry):
    """Keep public prose plus the provenance needed for invalidation/auditing."""
    if not isinstance(entry, dict) or not entry.get("summary"):
        return None
    out = {"summary": entry["summary"]}
    for key in (
        "model",
        "provider",
        "generated_at",
        "content_version",
        "input_hash",
    ):
        if entry.get(key):
            out[key] = entry[key]
    return out


def canonical_key(bill):
    path = str(bill.get("detailPath") or "").strip().strip("/")
    parts = path.split("/") if path else []
    if len(parts) == 3 and all(parts):
        return f"{parts[0]}/{parts[1].lower()}/{parts[2]}"
    congress = bill.get("congress")
    bill_type = bill.get("type")
    number = bill.get("number")
    if congress and bill_type and number:
        return f"{congress}/{str(bill_type).lower()}/{number}"
    return None


def entry_is_current(entry, bill, content_version):
    return bool(
        isinstance(entry, dict)
        and (entry.get("description") or {}).get("summary")
        and (entry.get("impact") or {}).get("summary")
        and entry.get("content_version") == content_version
        and entry.get("source_updated_at") == bill.get("updatedAt")
    )


def store_entry_for_bill(store, bill):
    """Read the canonical record, with one-release legacy display-key support."""
    key = canonical_key(bill)
    if key and isinstance(store.get(key), dict):
        return store[key]
    legacy_key = bill.get("identifier")
    if legacy_key and isinstance(store.get(legacy_key), dict):
        return store[legacy_key]
    return None


def apply_store_to_digest(store):
    digest = read_json(DIGEST_PATH, None)
    if not isinstance(digest, dict) or not isinstance(digest.get("bills"), list):
        return False
    changed = False
    cached = 0
    for bill in digest["bills"]:
        entry = store_entry_for_bill(store, bill)
        if not isinstance(entry, dict):
            continue
        description = entry.get("description")
        impact = entry.get("impact")
        if isinstance(description, dict) and description.get("summary"):
            rendered = {**description, "source": "committed"}
            if bill.get("aiDescription") != rendered:
                bill["aiDescription"] = rendered
                changed = True
        if isinstance(impact, dict) and impact.get("summary"):
            rendered = {
                **(bill.get("impact") or {}),
                **impact,
                "status": "AI impact analysis",
                "source": "committed",
            }
            if bill.get("impact") != rendered:
                bill["impact"] = rendered
                changed = True
            cached += 1
    status = "cached" if cached else "queued_for_refresh"
    if digest.get("impact_status") != status or digest.get("ai_cached") != cached:
        digest["impact_status"] = status
        digest["ai_cached"] = cached
        digest["ai_queued"] = max(0, len(digest["bills"]) - cached)
        digest["ai_mode"] = "cache_refresh_only"
        changed = True
    if changed:
        atomic_write_json(DIGEST_PATH, digest)
    return changed


def apply_store_to_bill_details(store):
    changed_files = 0
    if not BILLS_DIR.exists():
        return changed_files
    for path in BILLS_DIR.glob("*.json"):
        payload = read_json(path, None)
        bill = (payload or {}).get("bill") if isinstance(payload, dict) else None
        if not isinstance(bill, dict):
            continue
        entry = store_entry_for_bill(store, bill)
        if not isinstance(entry, dict):
            continue
        changed = False
        description = entry.get("description")
        impact = entry.get("impact")
        if isinstance(description, dict) and description.get("summary"):
            rendered = {**description, "source": "committed"}
            if bill.get("aiDescription") != rendered:
                bill["aiDescription"] = rendered
                changed = True
        if isinstance(impact, dict) and impact.get("summary"):
            rendered = {**impact, "status": "AI impact analysis", "source": "committed"}
            if bill.get("impact") != rendered:
                bill["impact"] = rendered
                changed = True
        pending = not (bill.get("aiDescription") and bill.get("impact"))
        if bill.get("aiPending") != pending:
            bill["aiPending"] = pending
            changed = True
        if changed:
            atomic_write_json(path, payload)
            changed_files += 1
    return changed_files


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=40, help="Recent bills to inspect.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Regenerate even when source timestamp and prompt version are unchanged.",
    )
    args = parser.parse_args()

    backend = load_backend()
    if not backend.ai_insights_available():
        print("No AI provider configured; leaving bill-ai.json unchanged.")
        return 0
    if not backend.congress_api_key_available():
        print("CONGRESS_API_KEY not set; cannot fetch bills.", file=sys.stderr)
        return 1

    payload = read_json(OUT_PATH, {})
    existing = payload.get("bills", {}) if isinstance(payload, dict) else {}
    existing = existing if isinstance(existing, dict) else {}

    digest = backend.getRecentBillDigest(limit=min(max(args.limit, 1), 40))
    bills = digest.get("bills", []) if isinstance(digest, dict) else []
    refreshed = 0
    skipped = 0
    failures = 0

    for bill in bills:
        key = canonical_key(bill)
        path = str(bill.get("detailPath") or "")
        parts = path.split("/")
        if not key or len(parts) != 3:
            continue
        legacy_key = bill.get("identifier")
        current = store_entry_for_bill(existing, bill) or {}
        if not args.force and entry_is_current(
            current, bill, backend.AI_BILL_CONTENT_VERSION
        ):
            skipped += 1
            continue
        try:
            generated = backend.refresh_bill_ai(
                parts[0], parts[1], parts[2], force=True
            )
        except Exception as exc:  # noqa: BLE001 - keep prior committed content
            failures += 1
            print(f"  keep prior {key}: {type(exc).__name__}")
            continue

        description = trim_generated_field(generated.get("aiDescription"))
        impact = trim_generated_field(generated.get("impact"))
        if not description and not impact:
            failures += 1
            continue
        entry = dict(current)
        if description:
            entry["description"] = description
        if impact:
            entry["impact"] = impact
        entry.update(
            {
                "canonical_id": key,
                "identifier": bill.get("identifier"),
                "title": bill.get("title"),
                "source_updated_at": bill.get("updatedAt"),
                "content_version": backend.AI_BILL_CONTENT_VERSION,
            }
        )
        existing[key] = entry
        if legacy_key and legacy_key != key:
            existing.pop(legacy_key, None)
        refreshed += 1
        print(f"  refreshed {key}: desc={bool(description)} impact={bool(impact)}")

    if refreshed:
        atomic_write_json(
            OUT_PATH,
            {
                "schema_version": 2,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "count": len(existing),
                "bills": existing,
            },
        )
    digest_changed = apply_store_to_digest(existing)
    bill_details_changed = apply_store_to_bill_details(existing)
    print(
        f"AI snapshot: {refreshed} refreshed, {skipped} unchanged, "
        f"{failures} failed, digest_updated={digest_changed}, "
        f"bill_details_updated={bill_details_changed}."
    )
    return 1 if failures and not existing else 0


if __name__ == "__main__":
    raise SystemExit(main())
