"""
member_summary.py

Builds on-demand LLM summaries for a member of Congress using bio, Wikipedia
background, NOMINATE ideology score, and recently sponsored bills.

This module is deliberately separate from CongressMembers.py: it does not
modify that file, it only imports and composes functions that already exist
there. No database — context is assembled live on each call and the final
summary is cached using the same sqlite TTL cache CongressMembers.py already
uses for everything else (Congress.gov responses, Wikipedia lookups, etc).

Usage:
    import member_summary
    result = member_summary.generate_member_summary("P000197")
    print(result["summary"])

Or from the command line:
    python member_summary.py P000197
"""

import os
import CongressMembers as backend


def _openai_api_key():
    backend._load_local_env()
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise backend.MissingCongressApiKey(
            "OPENAI_API_KEY is not set. Add it to the backend environment before "
            "calling generate_member_summary."
        )
    return api_key


def _summary_cache_ttl_seconds():
    raw_value = os.getenv(
        "YGN_SUMMARY_CACHE_TTL_SECONDS", str(backend.DEFAULT_CACHE_TTL_SECONDS)
    )
    try:
        ttl_seconds = int(raw_value)
    except ValueError as exc:
        raise ValueError(
            "YGN_SUMMARY_CACHE_TTL_SECONDS must be an integer number of seconds."
        ) from exc

    if ttl_seconds < 0:
        raise ValueError("YGN_SUMMARY_CACHE_TTL_SECONDS cannot be negative.")

    return ttl_seconds


def build_profile(bioguideId):
    """
    Assemble everything needed for a summary: bio detail, Wikipedia bio,
    NOMINATE ideology score, and recently sponsored bills.

    This is pure composition of calls that already exist in
    CongressMembers.py, each already wrapped in that module's own TTL cache
    — so calling this repeatedly for the same member doesn't mean repeatedly
    hitting Congress.gov or Wikipedia.
    """
    detail = backend.CongressMembersID(bioguideId)
    profile = {"bioguideId": bioguideId, "detail": detail, "errors": []}

    try:
        profile["wiki_summary"] = backend.get_wiki_summary(bioguideId)
    except Exception as exc:
        profile["wiki_summary"] = None
        profile["errors"].append({"stage": "wiki", "error": str(exc)})

    try:
        profile["nominate_score"] = backend.get_nominate_score(bioguideId)
    except Exception as exc:
        profile["nominate_score"] = None
        profile["errors"].append({"stage": "nominate", "error": str(exc)})

    try:
        bills = backend.memberSponsoredBills(bioguideId)
        profile["sponsored_bills"] = bills.get("sponsoredLegislation", [])[:10]
    except Exception as exc:
        profile["sponsored_bills"] = []
        profile["errors"].append({"stage": "sponsored_bills", "error": str(exc)})

    return profile


def _build_summary_prompt(profile):
    member = profile.get("detail", {}).get("member", {})
    name = backend._member_display_name(member)
    term = backend._latest_member_term(member)
    party = backend._current_party_name(member)
    wiki = profile.get("wiki_summary") or {}
    nominate = profile.get("nominate_score") or {}
    bills = profile.get("sponsored_bills") or []

    bill_lines = (
        "\n".join(
            f"- {b.get('title', 'Untitled')} ({b.get('introducedDate', 'n/a')})"
            for b in bills
        )
        or "No sponsored bills found."
    )

    return f"""Write a concise, factual 3-4 sentence summary of this member of Congress using
ONLY the information below. Do not invent details that aren't present.

Name: {name}
Party: {party}
State: {member.get('state')}
Chamber: {term.get('chamber')}
Serving since: {term.get('startYear')}

Background (Wikipedia): {wiki.get('summary') or 'Not available.'}

Ideology (NOMINATE dim1, -1=most liberal, +1=most conservative): {nominate.get('dim1', 'Not available')}

Recently sponsored bills:
{bill_lines}
"""


def generate_member_summary(bioguideId, model="gpt-4o-mini"):
    """
    Build (or retrieve from cache) an LLM summary for a member.

    Uses CongressMembers._cached_json so this shares the exact same sqlite
    TTL cache as the rest of the backend, keyed separately by bioguideId +
    model so different models don't collide. Controlled independently via
    YGN_SUMMARY_CACHE_TTL_SECONDS since LLM calls are more expensive than the
    Wikipedia/Congress.gov lookups that feed into them.
    """
    cache_key = backend._build_cache_key(
        "llm-summary", {"bioguideId": bioguideId, "model": model}
    )

    def fetch_summary():
        profile = build_profile(bioguideId)
        prompt = _build_summary_prompt(profile)

        from openai import OpenAI

        client = OpenAI(api_key=_openai_api_key())
        response = client.chat.completions.create(
            model=model,
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        return {
            "bioguideId": bioguideId,
            "summary": response.choices[0].message.content,
            "profile_errors": profile.get("errors", []),
        }

    return backend._cached_json(
        cache_key,
        f"llm-summary:{bioguideId}",
        fetch_summary,
        ttl_seconds=_summary_cache_ttl_seconds(),
    )