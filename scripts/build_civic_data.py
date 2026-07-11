"""Build committed civic-data snapshots served read-only by the site.

Writes docs/data/civic/*.json from free, keyless-or-Congress-keyed sources:
  recent-laws.json       - bills recently signed into public law (/law/{congress})
  hearings.json          - upcoming committee meetings (/committee-meeting)
  executive-orders.json  - recent executive orders (Federal Register API, keyless)
  treaties.json          - recent treaty actions in the Senate (/treaty)
  weekly-brief.json      - ONE AI call summarizing the week in Congress; only
                           regenerated when the underlying digest content changes
                           (input-hash gate), so the model runs strictly on update.

Run by the scheduled static-data workflow; public routes never call upstream or
the model for any of this.
"""

import argparse
import hashlib
import importlib.util
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BACKEND_PATH = REPO / "empty-folder" / "CongressMembers.py"
CIVIC_DIR = REPO / "docs" / "data" / "civic"
DIGEST_PATH = REPO / "docs" / "data" / "recent-bills-digest.json"

WEEKLY_BRIEF_VERSION = "weekly-brief-v1"
WEEKLY_BRIEF_SYSTEM_PROMPT = (
    "You are a nonpartisan congressional correspondent writing a short weekly brief for a "
    "civic-information site read by ordinary citizens. Rules: (1) Summarize only what is in "
    "the provided material -- real bills, real actions; add your background knowledge of the "
    "policy areas to make it meaningful, but never invent bills or outcomes. (2) Plain "
    "language a 9th-grader follows; no jargon without a gloss. (3) Strictly neutral: no "
    "praise, criticism, or passage predictions. (4) 4-6 COMPLETE sentences, at most 120 "
    "words total; never end mid-sentence or with '...'. (5) Lead with the most consequential "
    "activity, not the most recent."
)


def load_backend():
    spec = importlib.util.spec_from_file_location("ygn_backend_civic", BACKEND_PATH)
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


def _stamp(extra=None):
    payload = {"generated_at": datetime.now(timezone.utc).isoformat()}
    if extra:
        payload.update(extra)
    return payload


# --- Recently became law ---------------------------------------------------


def map_law_item(bill):
    laws = bill.get("laws") or []
    law_no = (laws[0] or {}).get("number") if laws else None
    congress = bill.get("congress")
    bill_type = str(bill.get("type") or "").lower()
    number = bill.get("number")
    return {
        "lawNumber": law_no,
        "identifier": f"{str(bill.get('type') or '').upper()} {number}".strip(),
        "title": bill.get("title"),
        "actionDate": (bill.get("latestAction") or {}).get("actionDate"),
        "actionText": (bill.get("latestAction") or {}).get("text"),
        "detailPath": f"{congress}/{bill_type}/{number}"
        if congress and bill_type and number
        else None,
        "url": bill.get("url"),
    }


def build_recent_laws(backend, congress, limit=12):
    data = backend._congress_get(f"/law/{congress}", params={"limit": max(limit, 20)})
    bills = data.get("bills") or []
    total = (data.get("pagination") or {}).get("count")
    items = [map_law_item(b) for b in bills]
    # Most recently acted-on first.
    items.sort(key=lambda i: i.get("actionDate") or "", reverse=True)
    return {
        **_stamp({"congress": congress, "totalLawsThisCongress": total}),
        "laws": items[:limit],
    }


# --- Upcoming committee hearings --------------------------------------------


def build_hearings(backend, congress, scan=40, keep=10):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    listing = backend._congress_get(
        f"/committee-meeting/{congress}", params={"limit": scan}
    )
    meetings = listing.get("committeeMeetings") or []

    def fetch_one(meeting):
        event_id = meeting.get("eventId")
        chamber = str(meeting.get("chamber") or "").lower()
        if not event_id or chamber not in {"house", "senate"}:
            return None
        try:
            detail = backend._congress_get(
                f"/committee-meeting/{congress}/{chamber}/{event_id}"
            ).get("committeeMeeting", {})
        except Exception:  # noqa: BLE001 - individual meetings are best-effort
            return None
        date = str(detail.get("date") or "")[:10]
        if not date or date < today:
            return None
        committees = detail.get("committees") or []
        return {
            "eventId": event_id,
            "chamber": meeting.get("chamber"),
            "date": date,
            "title": detail.get("title"),
            "committee": (committees[0] or {}).get("name") if committees else None,
            "meetingType": detail.get("type"),
            "room": ((detail.get("location") or {}).get("room")),
        }

    with ThreadPoolExecutor(max_workers=8) as pool:
        upcoming = [m for m in pool.map(fetch_one, meetings) if m]
    upcoming.sort(key=lambda m: m["date"])
    return {**_stamp({"congress": congress}), "hearings": upcoming[:keep]}


# --- Executive orders (Federal Register, keyless) ----------------------------


def build_executive_orders(backend, limit=8):
    import requests

    response = requests.get(
        "https://www.federalregister.gov/api/v1/documents.json",
        params={
            "conditions[presidential_document_type]": "executive_order",
            "order": "newest",
            "per_page": limit,
            "fields[]": [
                "title",
                "executive_order_number",
                "publication_date",
                "signing_date",
                "html_url",
                "abstract",
            ],
        },
        timeout=25,
        headers={"User-Agent": backend.WIKI_USER_AGENT},
    )
    response.raise_for_status()
    orders = []
    for doc in response.json().get("results") or []:
        orders.append(
            {
                "number": doc.get("executive_order_number"),
                "title": doc.get("title"),
                "signedDate": doc.get("signing_date"),
                "publicationDate": doc.get("publication_date"),
                "url": doc.get("html_url"),
                "abstract": (doc.get("abstract") or "")[:400] or None,
            }
        )
    return {**_stamp(), "orders": orders}


# --- Treaty actions -----------------------------------------------------------


def build_treaties(backend, limit=8):
    data = backend._congress_get("/treaty", params={"limit": limit, "sort": "updateDate+desc"})
    treaties = []
    for treaty in data.get("treaties") or []:
        parts = treaty.get("parts") or {}
        treaties.append(
            {
                "number": treaty.get("number"),
                "suffix": treaty.get("suffix"),
                "congress": treaty.get("congressReceived"),
                "topic": treaty.get("topic"),
                "transmittedDate": str(treaty.get("transmittedDate") or "")[:10] or None,
                "updateDate": str(treaty.get("updateDate") or "")[:10] or None,
                "resolutionText": None,
                "countriesText": ", ".join(
                    c.get("name") for c in (treaty.get("countriesParties") or []) if c.get("name")
                )[:200]
                or None,
                "partsCount": parts.get("count"),
            }
        )
    return {**_stamp(), "treaties": treaties}


# --- Vote spotlight: notable recent roll-calls --------------------------------


def _vote_notability(vote):
    """Rank votes: close margins and full-chamber participation are the story."""
    totals = vote.get("totals") or {}
    yea, nay = totals.get("Yea", 0), totals.get("Nay", 0)
    cast = yea + nay
    if cast < 30:
        return -1  # procedural/near-empty votes aren't a spotlight
    closeness = 1 - (abs(yea - nay) / cast)  # 1.0 = tied, 0 = unanimous
    return closeness * 100 + min(cast, 435) / 435 * 10


def build_vote_spotlight(backend, digest, laws, keep=5):
    """Collect roll-call votes from recently-active bills + new laws, keep the
    most notable (closest, fullest) ones. Pure precompute -- no model."""
    candidates = []
    seen_paths = set()
    for source in ((digest or {}).get("bills") or [], (laws or {}).get("laws") or []):
        for bill in source:
            path = bill.get("detailPath")
            if not path or path in seen_paths:
                continue
            seen_paths.add(path)
            candidates.append((path, bill.get("identifier"), bill.get("title")))

    def fetch_votes(candidate):
        path, identifier, title = candidate
        parts = path.split("/")
        if len(parts) != 3:
            return []
        # _bill_recorded_votes fetches only /actions + the roll-call XML --
        # far lighter than a full get_bill_detail (no text/cosponsors/summaries).
        bill_ref = {"congress": parts[0], "type": parts[1], "number": parts[2]}
        try:
            votes = backend._bill_recorded_votes(bill_ref, max_votes=2)
        except Exception:  # noqa: BLE001 - per-bill best effort
            return []
        return [(vote, identifier, title, path) for vote in votes or []]

    with ThreadPoolExecutor(max_workers=6) as pool:
        vote_batches = list(pool.map(fetch_votes, candidates[:16]))

    spotlight = []
    for batch in vote_batches:
        for vote, identifier, title, detail_path in batch:
            score = _vote_notability(vote)
            if score < 0:
                continue
            totals = vote.get("totals") or {}
            spotlight.append(
                {
                    "identifier": identifier,
                    "billTitle": (title or "")[:160],
                    "detailPath": detail_path,
                    "chamber": vote.get("chamber"),
                    "rollNumber": vote.get("rollNumber"),
                    "date": str(vote.get("date") or "")[:10] or None,
                    "question": vote.get("question"),
                    "result": vote.get("result"),
                    "yea": totals.get("Yea", 0),
                    "nay": totals.get("Nay", 0),
                    "notVoting": totals.get("Not Voting", 0),
                    "_score": score,
                }
            )

    spotlight.sort(key=lambda v: (v.get("date") or "", v["_score"]), reverse=True)
    for vote in spotlight:
        vote.pop("_score", None)
    return {**_stamp(), "votes": spotlight[:keep]}


# --- Weekly AI brief (model runs ONLY when digest content changes) -----------


def weekly_brief_input(digest):
    lines = []
    for bill in (digest.get("bills") or [])[:15]:
        action = (bill.get("latestAction") or {}).get("text") or ""
        desc = (bill.get("aiDescription") or {}).get("summary") or ""
        lines.append(
            f"- {bill.get('identifier')}: {bill.get('title')} | latest action: {action[:140]}"
            + (f" | what it is: {desc[:200]}" if desc else "")
        )
    return "\n".join(lines)


def build_weekly_brief(backend, force=False):
    """One model call per digest change. Returns (payload, status-string)."""
    digest = read_json(DIGEST_PATH, None)
    if not isinstance(digest, dict) or not digest.get("bills"):
        return None, "no digest available"

    material = weekly_brief_input(digest)
    input_hash = hashlib.sha256(
        f"{WEEKLY_BRIEF_VERSION}|{material}".encode("utf-8")
    ).hexdigest()[:24]

    existing = read_json(CIVIC_DIR / "weekly-brief.json", None)
    if (
        not force
        and isinstance(existing, dict)
        and existing.get("input_hash") == input_hash
        and existing.get("summary")
    ):
        return existing, "unchanged (input hash match)"

    if not backend.ai_insights_available():
        return None, "no AI provider; keeping prior brief"

    user_prompt = (
        "Here are the bills with the most recent activity in Congress this week, with their "
        "latest actions:\n\n"
        f"{material}\n\n"
        "Write the weekly brief now, following your rules (4-6 complete sentences, <=120 "
        "words, most consequential first, nonpartisan)."
    )
    summary = backend._llm_chat(WEEKLY_BRIEF_SYSTEM_PROMPT, user_prompt, max_tokens=300)
    payload = {
        **_stamp(
            {
                "summary": summary,
                "input_hash": input_hash,
                "content_version": WEEKLY_BRIEF_VERSION,
                "model": (backend._ai_provider_config() or {}).get("model"),
                "source": "ai",
                "billCount": len(digest.get("bills") or []),
            }
        )
    }
    return payload, "regenerated"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force-brief", action="store_true")
    parser.add_argument("--skip-brief", action="store_true")
    args = parser.parse_args()

    backend = load_backend()
    if not backend.congress_api_key_available():
        print("CONGRESS_API_KEY not set; cannot build civic data.", file=sys.stderr)
        return 1

    congress = backend._current_congress_number()
    failures = 0
    built = {}

    for name, builder in (
        ("recent-laws.json", lambda: build_recent_laws(backend, congress)),
        ("hearings.json", lambda: build_hearings(backend, congress)),
        ("executive-orders.json", lambda: build_executive_orders(backend)),
        ("treaties.json", lambda: build_treaties(backend)),
    ):
        try:
            payload = builder()
            built[name] = payload
            atomic_write_json(CIVIC_DIR / name, payload)
            count = len(payload.get("laws") or payload.get("hearings") or payload.get("orders") or payload.get("treaties") or [])
            print(f"  wrote civic/{name} ({count} items)")
        except Exception as exc:  # noqa: BLE001 - keep prior committed file on failure
            failures += 1
            print(f"  keep prior civic/{name}: {type(exc).__name__}: {exc}")

    try:
        digest = read_json(DIGEST_PATH, None)
        spotlight = build_vote_spotlight(
            backend, digest, built.get("recent-laws.json") or read_json(CIVIC_DIR / "recent-laws.json", {})
        )
        atomic_write_json(CIVIC_DIR / "vote-spotlight.json", spotlight)
        print(f"  wrote civic/vote-spotlight.json ({len(spotlight.get('votes') or [])} votes)")
    except Exception as exc:  # noqa: BLE001
        failures += 1
        print(f"  keep prior civic/vote-spotlight.json: {type(exc).__name__}: {exc}")

    if not args.skip_brief:
        try:
            brief, status = build_weekly_brief(backend, force=args.force_brief)
            if brief and status == "regenerated":
                atomic_write_json(CIVIC_DIR / "weekly-brief.json", brief)
            print(f"  weekly brief: {status}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"  weekly brief failed: {type(exc).__name__}: {exc}")

    print(f"civic data build complete ({failures} failures).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
