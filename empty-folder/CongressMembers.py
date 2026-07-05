import csv
import json
import logging
import os
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

import requests


BASE_URL = "https://api.congress.gov/v3"
WIKIPEDIA_ACTION_API_URL = "https://en.wikipedia.org/w/api.php"
WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary"
CSV_PATH = Path(__file__).parent / "HSall_members.csv"
DEFAULT_CACHE_PATH = Path(__file__).parent / ".cache" / "ygn_api_cache.sqlite"
DEFAULT_CACHE_TTL_SECONDS = 15 * 60
DEFAULT_WIKI_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
REQUEST_TIMEOUT_SECONDS = 20
WIKI_USER_AGENT = "YGN/1.0 (government-officials-cache)"

LOGGER = logging.getLogger(__name__)
API_KEY = ""
ENV_PATHS = (
    Path(__file__).parent.parent / ".env",
    Path(__file__).parent / ".env",
)

_cache_lock = threading.RLock()
_cache_key_locks = {}
_cache_key_locks_guard = threading.Lock()
_background_refresh_thread = None
_background_refresh_stop = threading.Event()


class MissingCongressApiKey(RuntimeError):
    """Raised when a Congress.gov request is needed but no API key is configured."""


class UpstreamDataError(RuntimeError):
    """Raised when an upstream government data request fails."""


class WikipediaRateLimited(RuntimeError):
    """Raised when Wikipedia asks the generator to slow down."""


def _now_seconds():
    return int(time.time())


def _cache_path():
    return Path(os.getenv("YGN_CACHE_PATH", str(DEFAULT_CACHE_PATH))).expanduser()


def _cache_ttl_seconds():
    raw_value = os.getenv("YGN_CACHE_TTL_SECONDS", str(DEFAULT_CACHE_TTL_SECONDS))
    try:
        ttl_seconds = int(raw_value)
    except ValueError as exc:
        raise ValueError("YGN_CACHE_TTL_SECONDS must be an integer number of seconds.") from exc

    if ttl_seconds < 0:
        raise ValueError("YGN_CACHE_TTL_SECONDS cannot be negative.")

    return ttl_seconds


def _wiki_cache_ttl_seconds():
    raw_value = os.getenv("YGN_WIKI_CACHE_TTL_SECONDS", str(DEFAULT_WIKI_CACHE_TTL_SECONDS))
    try:
        ttl_seconds = int(raw_value)
    except ValueError as exc:
        raise ValueError(
            "YGN_WIKI_CACHE_TTL_SECONDS must be an integer number of seconds."
        ) from exc

    if ttl_seconds < 0:
        raise ValueError("YGN_WIKI_CACHE_TTL_SECONDS cannot be negative.")

    return ttl_seconds


def _load_local_env():
    if os.getenv("CONGRESS_API_KEY"):
        return

    for env_path in ENV_PATHS:
        if not env_path.exists():
            continue

        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue

            key, value = stripped.split("=", 1)
            if key.strip() == "CONGRESS_API_KEY":
                os.environ.setdefault("CONGRESS_API_KEY", value.strip().strip('"').strip("'"))
                return


def congress_api_key_available():
    _load_local_env()
    return bool(os.getenv("CONGRESS_API_KEY") or API_KEY)


def _congress_api_key():
    _load_local_env()
    api_key = os.getenv("CONGRESS_API_KEY") or API_KEY
    if not api_key:
        raise MissingCongressApiKey(
            "CONGRESS_API_KEY is not set. Add it to the backend environment before "
            "calling Congress.gov."
        )

    return api_key


def _connect_cache():
    path = _cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS api_cache (
            cache_key TEXT PRIMARY KEY,
            response_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            source TEXT NOT NULL
        )
        """
    )
    conn.commit()
    return conn


@contextmanager
def _cache_connection():
    conn = _connect_cache()
    try:
        yield conn
    finally:
        conn.close()


def _build_cache_key(namespace, payload):
    encoded_payload = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return f"{namespace}:{encoded_payload}"


def _read_cache(cache_key, allow_stale=False):
    with _cache_lock:
        with _cache_connection() as conn:
            row = conn.execute(
                """
                SELECT response_json, expires_at
                FROM api_cache
                WHERE cache_key = ?
                """,
                (cache_key,),
            ).fetchone()

    if row is None:
        return None

    if not allow_stale and row["expires_at"] <= _now_seconds():
        return None

    return json.loads(row["response_json"])


def _write_cache(cache_key, response_json, source, ttl_seconds=None):
    created_at = _now_seconds()
    ttl = _cache_ttl_seconds() if ttl_seconds is None else ttl_seconds
    expires_at = created_at + ttl

    with _cache_lock:
        with _cache_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO api_cache
                    (cache_key, response_json, created_at, expires_at, source)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    cache_key,
                    json.dumps(response_json),
                    created_at,
                    expires_at,
                    source,
                ),
            )
            conn.commit()


def _cache_lock_for_key(cache_key):
    with _cache_key_locks_guard:
        lock = _cache_key_locks.get(cache_key)
        if lock is None:
            lock = threading.Lock()
            _cache_key_locks[cache_key] = lock
        return lock


def _cached_json(cache_key, source, fetch_json, ttl_seconds=None):
    fresh_response = _read_cache(cache_key)
    if fresh_response is not None:
        return fresh_response

    key_lock = _cache_lock_for_key(cache_key)
    with key_lock:
        fresh_response = _read_cache(cache_key)
        if fresh_response is not None:
            return fresh_response

        try:
            response_json = fetch_json()
        except Exception:
            stale_response = _read_cache(cache_key, allow_stale=True)
            if stale_response is not None:
                LOGGER.warning("Returning stale cache data for %s.", source, exc_info=True)
                return stale_response
            raise

        _write_cache(cache_key, response_json, source, ttl_seconds=ttl_seconds)
        return response_json


def _congress_get(path, params=None, ttl_seconds=None):
    cache_params = dict(params or {})
    cache_params.setdefault("format", "json")
    cache_key = _build_cache_key(
        "congress",
        {
            "path": path,
            "params": cache_params,
        },
    )
    url = f"{BASE_URL}{path}"

    def fetch_json():
        request_params = dict(cache_params)
        request_params["api_key"] = _congress_api_key()

        try:
            response = requests.get(
                url,
                params=request_params,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException:
            raise UpstreamDataError(f"Congress.gov request failed for {path}.") from None

        return response.json()

    return _cached_json(cache_key, f"congress:{path}", fetch_json, ttl_seconds=ttl_seconds)


def listCongressMembers(limit=20, offset=0, congress=None, current_member=None):
    path = "/member"
    if congress is not None:
        path = f"/member/congress/{congress}"

    params = {
        "limit": limit,
        "offset": offset,
        "format": "json",
    }
    if current_member is not None:
        params["currentMember"] = "true" if current_member else "false"

    return _congress_get(
        path,
        params=params,
    )


def getRecentBills():
    return _congress_get(
        "/bill",
        params={
            "limit": 20,
            "format": "json",
        },
    )


def allCongressMembers():
    return listCongressMembers(limit=20, offset=0)


def CongressMembersID(bioGuideID):
    return _congress_get(
        f"/member/{bioGuideID}",
        params={
            "limit": 20,
            "bioguideId": bioGuideID,
            "format": "json",
        },
    )


def _member_terms(member):
    terms = member.get("terms", {}).get("item", [])
    if isinstance(terms, dict):
        return [terms]
    return terms or []


def _optional_float(value):
    if value in (None, ""):
        return None
    return float(value)


def _member_bioguide_id(member):
    return member.get("bioguideId") or member.get("bioguideID")


def _pagination_total(data):
    members = data.get("members", [])
    return data.get("pagination", {}).get("count", len(members))


def _dedupe_strings(values):
    seen = set()
    result = []
    for value in values:
        normalized = re.sub(r"\s+", " ", str(value or "")).strip()
        key = normalized.lower()
        if not normalized or key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return result


def _member_name_candidates(member):
    candidates = [
        member.get("directOrderName"),
        member.get("officialFullName"),
    ]

    first_name = member.get("firstName")
    last_name = member.get("lastName")
    if first_name and last_name:
        candidates.append(f"{first_name} {last_name}")

    for previous_name in member.get("previousNames") or []:
        candidates.append(previous_name.get("directOrderName"))
        first_name = previous_name.get("firstName")
        last_name = previous_name.get("lastName")
        if first_name and last_name:
            candidates.append(f"{first_name} {last_name}")

    inverted_name = member.get("invertedOrderName")
    if inverted_name and "," in inverted_name:
        last, first = inverted_name.split(",", 1)
        candidates.append(f"{first.strip()} {last.strip()}")

    return _dedupe_strings(candidates)


def _latest_member_term(member):
    terms = member.get("terms", [])
    if isinstance(terms, dict):
        terms = terms.get("item", [])
    if isinstance(terms, dict):
        terms = [terms]
    if not terms:
        return {}

    def start_year(term):
        try:
            return int(term.get("startYear") or 0)
        except (TypeError, ValueError):
            return 0

    return max(terms, key=start_year)


def _current_party_name(member):
    party_history = member.get("partyHistory") or []
    if not party_history:
        return None

    def start_year(party):
        try:
            return int(party.get("startYear") or 0)
        except (TypeError, ValueError):
            return 0

    latest_party = max(party_history, key=start_year)
    return latest_party.get("partyName")


def _member_display_name(member):
    names = _member_name_candidates(member)
    if names:
        return names[0]

    return member.get("directOrderName") or member.get("invertedOrderName") or "This official"


def _build_congress_member_summary(member):
    name = _member_display_name(member)
    term = _latest_member_term(member)
    party = _current_party_name(member)
    state = member.get("state") or term.get("stateName")
    district = member.get("district") or term.get("district")
    chamber = term.get("chamber")
    member_type = term.get("memberType")
    start_year = term.get("startYear")

    role_parts = []
    if party:
        role_parts.append(party)
    if member_type:
        role_parts.append(member_type.lower())
    else:
        role_parts.append("member of Congress")

    location = ""
    if state and district not in (None, ""):
        location = f" from {state}'s {district} district"
    elif state:
        location = f" from {state}"

    chamber_text = f" in the {chamber}" if chamber else ""
    since_text = f" since {start_year}" if start_year else ""
    summary = f"{name} is a {' '.join(role_parts)}{location}{chamber_text}{since_text}."

    return {
        "title": name,
        "summary": summary,
        "extract": summary,
        "thumbnail": member.get("depiction", {}).get("imageUrl"),
        "wiki_url": None,
        "source": "congress_fallback",
    }


def _wikipedia_headers():
    return {"User-Agent": WIKI_USER_AGENT}


def _wiki_retry_delay_seconds(response):
    retry_after = getattr(response, "headers", {}).get("Retry-After")
    try:
        return max(0.0, float(retry_after))
    except (TypeError, ValueError):
        pass

    raw_value = os.getenv("YGN_WIKI_RETRY_DELAY_SECONDS", "2")
    try:
        return max(0.0, float(raw_value))
    except ValueError:
        return 2.0


def _wiki_max_attempts():
    raw_value = os.getenv("YGN_WIKI_MAX_ATTEMPTS", "2")
    try:
        return max(1, int(raw_value))
    except ValueError:
        return 2


def _wiki_search_query_limit():
    raw_value = os.getenv("YGN_WIKI_SEARCH_QUERY_LIMIT", "2")
    try:
        return max(1, int(raw_value))
    except ValueError:
        return 2


def _wiki_search_result_limit():
    raw_value = os.getenv("YGN_WIKI_SEARCH_RESULT_LIMIT", "3")
    try:
        return max(1, int(raw_value))
    except ValueError:
        return 3


def _wiki_get(url, *, params=None, max_attempts=None):
    attempts = _wiki_max_attempts() if max_attempts is None else max_attempts
    last_response = None
    for attempt in range(attempts):
        response = requests.get(
            url,
            params=params,
            headers=_wikipedia_headers(),
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        last_response = response

        if getattr(response, "status_code", None) == 429:
            if attempt < attempts - 1:
                time.sleep(_wiki_retry_delay_seconds(response))
                continue
            raise WikipediaRateLimited("Wikipedia returned 429 Too Many Requests.")

        response.raise_for_status()
        return response

    if getattr(last_response, "status_code", None) == 429:
        raise WikipediaRateLimited("Wikipedia returned 429 Too Many Requests.")

    last_response.raise_for_status()
    return last_response


def _wiki_summary_from_page_title(page_title):
    encoded_title = quote(page_title.replace(" ", "_"), safe="")
    url = f"{WIKIPEDIA_SUMMARY_URL}/{encoded_title}"
    data = _wiki_get(url).json()
    extract = data.get("extract")
    return {
        "title": data.get("title") or page_title,
        "type": data.get("type"),
        "summary": extract,
        "extract": extract,
        "thumbnail": data.get("thumbnail", {}).get("source"),
        "wiki_url": data.get("content_urls", {}).get("desktop", {}).get("page"),
        "source": "wikipedia",
        "wiki_page_id": data.get("pageid"),
    }


def _wiki_search_titles(query, limit=None):
    result_limit = _wiki_search_result_limit() if limit is None else limit
    response = _wiki_get(
        WIKIPEDIA_ACTION_API_URL,
        params={
            "action": "query",
            "format": "json",
            "list": "search",
            "srsearch": query,
            "srlimit": result_limit,
        },
    )
    results = response.json().get("query", {}).get("search", [])
    return [item.get("title") for item in results if item.get("title")]


def _is_disambiguation_summary(summary):
    summary_type = str(summary.get("type") or "").lower()
    text = str(summary.get("summary") or summary.get("extract") or "").lower()
    title = str(summary.get("title") or "").lower()
    return (
        summary_type == "disambiguation"
        or "may refer to:" in text
        or "may also refer to:" in text
        or "can refer to:" in text
        or "is the name of:" in text
        or title.endswith("(disambiguation)")
    )


def _wiki_match_score(summary, member):
    if not summary or _is_disambiguation_summary(summary):
        return -100

    title = str(summary.get("title") or "").lower()
    text = f"{title} {summary.get('summary') or summary.get('extract') or ''}".lower()
    title_normalized = re.sub(r"[^a-z0-9]+", " ", title).strip()
    first_name = str(member.get("firstName") or "").lower()
    last_name = str(member.get("lastName") or "").lower()
    state = str(member.get("state") or "").lower()
    term = _latest_member_term(member)
    state_name = str(term.get("stateName") or "").lower()

    score = 0
    for candidate in _member_name_candidates(member):
        candidate_normalized = re.sub(r"[^a-z0-9]+", " ", candidate.lower()).strip()
        if candidate_normalized and candidate_normalized == title_normalized:
            score += 8
        elif candidate_normalized and candidate_normalized in text:
            score += 4

    if last_name and last_name in title:
        score += 4
    elif last_name and last_name in text:
        score += 2

    if first_name and first_name in title:
        score += 3
    elif first_name and first_name in text:
        score += 1
    elif first_name:
        score -= 5

    if first_name and first_name not in title:
        score -= 4

    if state and state in text:
        score += 1
    if state_name and state_name in text and state_name != state:
        score += 1

    official_terms = (
        "american politician",
        "u.s. representative",
        "us representative",
        "united states representative",
        "united states senator",
        "member of the united states house",
        "house of representatives",
        "member of congress",
        "resident commissioner",
        "delegate",
    )
    if any(term in text for term in official_terms):
        score += 4

    return score


def _wiki_search_queries(member):
    term = _latest_member_term(member)
    state = member.get("state") or term.get("stateName")
    member_type = term.get("memberType") or "member of Congress"
    queries = []

    for name in _member_name_candidates(member):
        queries.extend(
            [
                f'"{name}" "{member_type}"',
                f'"{name}" "United States Congress"',
                f'"{name}" politician',
            ]
        )
        if state:
            queries.append(f'"{name}" {state} politician')

    return _dedupe_strings(queries)


def _resolve_wikipedia_summary(member):
    best_summary = None
    best_score = -100
    tried_titles = set()

    for title in _member_name_candidates(member):
        try:
            summary = _wiki_summary_from_page_title(title)
        except WikipediaRateLimited:
            return _build_congress_member_summary(member)
        except requests.HTTPError:
            continue

        score = _wiki_match_score(summary, member)
        if score > best_score:
            best_summary = summary
            best_score = score
        if score >= 7:
            return summary

    for query in _wiki_search_queries(member)[: _wiki_search_query_limit()]:
        try:
            titles = _wiki_search_titles(query)
        except WikipediaRateLimited:
            return _build_congress_member_summary(member)
        except requests.HTTPError:
            continue

        for title in titles:
            title_key = title.lower()
            if title_key in tried_titles:
                continue
            tried_titles.add(title_key)

            try:
                summary = _wiki_summary_from_page_title(title)
            except WikipediaRateLimited:
                return _build_congress_member_summary(member)
            except requests.HTTPError:
                continue

            score = _wiki_match_score(summary, member)
            if score > best_score:
                best_summary = summary
                best_score = score
            if score >= 7:
                return summary

    if best_summary is not None and best_score >= 5:
        return best_summary

    return _build_congress_member_summary(member)


def getMemberID(Name, chamber=None, congress=None):
    """
    Look up a member of Congress's bioguideId by name. (last, first) or (last) works.

    Args:
        Name (str): Full or partial name to search for (e.g. "Pelosi").
        chamber (str, optional): "house" or "senate" to narrow results.
        congress (int, optional): Congress number (e.g. 118) to narrow results.

    Returns:
        str | None: The first matching member's bioguideId, or None if nothing found.
    """
    if not Name:
        return None

    matches = []
    offset = 0
    limit = 250
    name_lower = Name.lower()

    while True:
        data = listCongressMembers(limit=limit, offset=offset)

        members = data.get("members", [])
        if not members:
            break

        for member in members:
            full_name = member.get("name", "")
            if name_lower not in full_name.lower():
                continue

            terms = _member_terms(member)

            if congress is not None:
                if not any(str(term.get("congress")) == str(congress) for term in terms):
                    continue

            if chamber is not None:
                if not any(chamber.lower() in term.get("chamber", "").lower() for term in terms):
                    continue

            matches.append(
                {
                    "bioguideId": member.get("bioguideId"),
                    "name": full_name,
                    "party": member.get("partyName"),
                    "state": member.get("state"),
                }
            )

        offset += limit
        if offset >= data.get("pagination", {}).get("count", 0):
            break

    if not matches:
        return None

    return matches[0].get("bioguideId")


def get_nominate_score(bioguide_id: str):
    """
    Returns a member's most recent NOMINATE dim1 score and geo mean probability
    by scanning the CSV directly. No database needed.

    Returns {"dim1": float, "geo_mean": float} or None if not found.
    """
    if not CSV_PATH.exists():
        raise FileNotFoundError(
            f"Missing NOMINATE CSV at {CSV_PATH}. Add HSall_members.csv next to "
            "CongressMembers.py before calling get_nominate_score."
        )

    best_row = None

    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["bioguide_id"] != bioguide_id:
                continue
            if best_row is None or int(row["congress"]) > int(best_row["congress"]):
                best_row = row

    if best_row is None or not best_row["nominate_dim1"]:
        return None

    return {
        "dim1": float(best_row["nominate_dim1"]),
        "geo_mean": _optional_float(best_row["nominate_geo_mean_probability"]),
    }


def get_wiki_summary(bioguideId):
    cache_key = _build_cache_key(
        "wikipedia-summary-v2",
        {
            "bioguideId": bioguideId,
        },
    )

    def fetch_json():
        member = CongressMembersID(bioguideId).get("member", {})
        if not _member_name_candidates(member):
            raise ValueError(f"No directOrderName found for bioguideId {bioguideId}.")

        return _resolve_wikipedia_summary(member)

    wiki_summary = _cached_json(
        cache_key,
        f"wikipedia:summary:{bioguideId}",
        fetch_json,
        ttl_seconds=_wiki_cache_ttl_seconds(),
    )
    if "summary" not in wiki_summary and "extract" in wiki_summary:
        wiki_summary = {**wiki_summary, "summary": wiki_summary.get("extract")}
    elif "extract" not in wiki_summary and "summary" in wiki_summary:
        wiki_summary = {**wiki_summary, "extract": wiki_summary.get("summary")}

    return wiki_summary


def get_official_profile(bioguideId, include_wiki=True, include_nominate=True):
    detail = CongressMembersID(bioguideId)
    profile = {
        "bioguideId": bioguideId,
        "detail": detail,
        "errors": [],
    }

    if include_wiki:
        try:
            profile["wiki_summary"] = get_wiki_summary(bioguideId)
        except Exception as exc:
            profile["wiki_summary"] = None
            profile["errors"].append(
                {
                    "stage": "wiki",
                    "error": str(exc),
                }
            )

    if include_nominate:
        try:
            profile["nominate_score"] = get_nominate_score(bioguideId)
        except Exception as exc:
            profile["nominate_score"] = None
            profile["errors"].append(
                {
                    "stage": "nominate",
                    "error": str(exc),
                }
            )

    return profile


def refresh_government_officials_cache():
    """
    Refresh the core MVP cache entries used by the government officials surface.

    This can be called by a backend route, startup hook, or scheduled task. Each
    function still respects the 15-minute TTL and only calls upstream APIs when
    the cached response is stale or missing.
    """
    return {
        "allCongressMembers": listCongressMembers(limit=250, offset=0),
        "getRecentBills": getRecentBills(),
    }


def warm_government_officials_cache(
    include_details=True,
    include_wiki=True,
    include_nominate=True,
    include_recent_bills=True,
    max_members=None,
    limit=250,
):
    """
    Fill the cache with the data the officials MVP can currently display.

    This intentionally runs only when called directly. It can make hundreds of
    upstream requests when include_wiki is enabled, so keep it out of the
    automatic 15-minute background refresh.
    """
    if limit < 1 or limit > 250:
        raise ValueError("limit must be between 1 and 250.")

    if max_members is not None and max_members < 1:
        raise ValueError("max_members must be greater than zero when provided.")

    report = {
        "member_pages_cached": 0,
        "members_seen": 0,
        "member_details_cached": 0,
        "wiki_summaries_cached": 0,
        "nominate_scores_checked": 0,
        "recent_bills_cached": False,
        "errors": [],
    }

    if include_recent_bills:
        getRecentBills()
        report["recent_bills_cached"] = True

    offset = 0
    while True:
        page = listCongressMembers(limit=limit, offset=offset)
        report["member_pages_cached"] += 1
        members = page.get("members", [])
        if not members:
            break

        for member in members:
            if max_members is not None and report["members_seen"] >= max_members:
                return report

            report["members_seen"] += 1
            bioguide_id = _member_bioguide_id(member)
            if not bioguide_id:
                continue

            if include_details:
                try:
                    CongressMembersID(bioguide_id)
                    report["member_details_cached"] += 1
                except Exception as exc:
                    report["errors"].append(
                        {
                            "bioguideId": bioguide_id,
                            "stage": "detail",
                            "error": str(exc),
                        }
                    )

            if include_wiki:
                try:
                    get_wiki_summary(bioguide_id)
                    report["wiki_summaries_cached"] += 1
                except Exception as exc:
                    report["errors"].append(
                        {
                            "bioguideId": bioguide_id,
                            "stage": "wiki",
                            "error": str(exc),
                        }
                    )

            if include_nominate:
                try:
                    get_nominate_score(bioguide_id)
                    report["nominate_scores_checked"] += 1
                except Exception as exc:
                    report["errors"].append(
                        {
                            "bioguideId": bioguide_id,
                            "stage": "nominate",
                            "error": str(exc),
                        }
                    )

        offset += limit
        if offset >= _pagination_total(page):
            break

    return report


def get_cache_stats():
    path = _cache_path()
    if not path.exists():
        return {
            "cache_path": str(path),
            "total_entries": 0,
            "fresh_entries": 0,
            "expired_entries": 0,
            "sources": [],
        }

    now = _now_seconds()
    with _cache_lock:
        with _cache_connection() as conn:
            totals = conn.execute(
                """
                SELECT
                    COUNT(*) AS total_entries,
                    SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END) AS fresh_entries,
                    SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) AS expired_entries
                FROM api_cache
                """,
                (now, now),
            ).fetchone()
            sources = conn.execute(
                """
                SELECT source, COUNT(*) AS entries, MIN(expires_at) AS earliest_expires_at
                FROM api_cache
                GROUP BY source
                ORDER BY entries DESC, source
                """
            ).fetchall()

    return {
        "cache_path": str(path),
        "total_entries": totals["total_entries"] or 0,
        "fresh_entries": totals["fresh_entries"] or 0,
        "expired_entries": totals["expired_entries"] or 0,
        "sources": [
            {
                "source": row["source"],
                "entries": row["entries"],
                "earliest_expires_at": row["earliest_expires_at"],
            }
            for row in sources
        ],
    }


def _background_refresh_loop(interval_seconds, stop_event):
    while not stop_event.is_set():
        try:
            refresh_government_officials_cache()
        except Exception:
            LOGGER.exception("Background cache refresh failed.")

        stop_event.wait(interval_seconds)


def start_background_cache_refresh(interval_seconds=None):
    """
    Start a daemon thread that refreshes MVP cache entries on a fixed interval.

    The thread starts only when this function is called, so importing the module
    will not spend API quota or require an API key.
    """
    global _background_refresh_stop
    global _background_refresh_thread

    interval = _cache_ttl_seconds() if interval_seconds is None else int(interval_seconds)
    if interval <= 0:
        raise ValueError("Background refresh interval must be greater than zero seconds.")

    if _background_refresh_thread and _background_refresh_thread.is_alive():
        return _background_refresh_thread

    _background_refresh_stop = threading.Event()
    _background_refresh_thread = threading.Thread(
        target=_background_refresh_loop,
        args=(interval, _background_refresh_stop),
        name="ygn-cache-refresh",
        daemon=True,
    )
    _background_refresh_thread.start()
    return _background_refresh_thread


def stop_background_cache_refresh(timeout=None):
    """Stop the background refresh thread if it is running."""
    global _background_refresh_thread

    thread = _background_refresh_thread
    if thread is None:
        return

    _background_refresh_stop.set()
    thread.join(timeout=timeout)
    if not thread.is_alive():
        _background_refresh_thread = None
