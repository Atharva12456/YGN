"""Harvest committed bill AI from the LIVE site into docs/data/bill-ai.json.

The scheduled workflow (GitHub Actions) has no AI provider secret, so it cannot
generate bill descriptions/impacts itself. The live Heroku app DOES have the key
and generates them on its background-refresh queue. This script reads that
already-generated content over HTTP (`/bills/{c}/{t}/{n}/ai`) and commits it, so
the static store stays fresh with zero AI key in CI. Bills the live app hasn't
generated yet are queued by the GET and picked up on the next run.

Idempotent and safe: never deletes existing committed content; only adds/updates.
"""

import argparse
import importlib.util
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT_PATH = REPO / "docs" / "data" / "bill-ai.json"
DIGEST_PATH = REPO / "docs" / "data" / "recent-bills-digest.json"
DEFAULT_BASE = os.getenv("YGN_HARVEST_BASE_URL", "https://yourgovtnow.dev").rstrip("/")

# Reuse the snapshot script's canonical keying + store-application helpers so the
# two writers stay byte-compatible.
_spec = importlib.util.spec_from_file_location("snap_bill_ai", REPO / "scripts" / "snapshot_bill_ai.py")
snap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(snap)


def http_json(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": "YGN-harvest/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def trim(field):
    if not isinstance(field, dict) or not field.get("summary"):
        return None
    out = {"summary": field["summary"]}
    for key in ("model", "provider", "generated_at", "content_version", "input_hash"):
        if field.get(key):
            out[key] = field[key]
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    base = args.base_url.rstrip("/")

    # Prefer the freshly-generated committed digest; fall back to the live one.
    digest = snap.read_json(DIGEST_PATH, None)
    if not isinstance(digest, dict) or not digest.get("bills"):
        try:
            digest = http_json(f"{base}/data/recent-bills-digest.json")
        except Exception as exc:  # noqa: BLE001
            print(f"Could not load digest: {exc}", file=sys.stderr)
            return 1
    bills = [b for b in (digest.get("bills") or []) if b.get("detailPath")][: max(1, args.limit)]
    if not bills:
        print("No bills in digest to harvest.")
        return 0

    payload = snap.read_json(OUT_PATH, {})
    existing = payload.get("bills", {}) if isinstance(payload, dict) else {}
    existing = existing if isinstance(existing, dict) else {}

    def fetch(bill):
        path = str(bill.get("detailPath") or "")
        parts = path.split("/")
        if len(parts) != 3:
            return None
        try:
            data = http_json(f"{base}/bills/{parts[0]}/{parts[1]}/{parts[2]}/ai")
        except Exception:  # noqa: BLE001 - a miss just means "not ready yet"
            return None
        return bill, trim(data.get("aiDescription")), trim(data.get("impact"))

    harvested = 0
    pending = 0
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for result in pool.map(fetch, bills):
            if not result:
                continue
            bill, desc, impact = result
            if not desc and not impact:
                pending += 1
                continue
            key = snap.canonical_key(bill)
            if not key:
                continue
            entry = dict(existing.get(key) or {})
            if desc:
                entry["description"] = desc
            if impact:
                entry["impact"] = impact
            entry.update(
                {
                    "canonical_id": key,
                    "identifier": bill.get("identifier"),
                    "title": bill.get("title"),
                    "source_updated_at": bill.get("updatedAt"),
                    "content_version": entry.get("content_version")
                    or (impact or desc or {}).get("content_version"),
                }
            )
            legacy = bill.get("identifier")
            if legacy and legacy != key:
                existing.pop(legacy, None)
            existing[key] = entry
            harvested += 1

    if harvested:
        snap.atomic_write_json(
            OUT_PATH,
            {
                "schema_version": 2,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "count": len(existing),
                "bills": existing,
            },
        )
    digest_changed = snap.apply_store_to_digest(existing)
    details_changed = snap.apply_store_to_bill_details(existing)
    complete = sum(
        1 for v in existing.values()
        if (v.get("description") or {}).get("summary") and (v.get("impact") or {}).get("summary")
    )
    print(
        f"Harvest from {base}: {harvested} updated, {pending} still generating; "
        f"store now {len(existing)} entries ({complete} complete); "
        f"digest_updated={digest_changed}, bill_details_updated={details_changed}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
