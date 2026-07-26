import csv
import hashlib
import html
import io
import json
import logging
import os
import re
import sqlite3
import threading
import time
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import requests
import yaml


BASE_URL = "https://api.congress.gov/v3"
FEC_BASE_URL = "https://api.open.fec.gov/v1"
TREASURY_DEBT_URL = (
    "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/"
    "accounting/od/debt_to_penny"
)
WIKIPEDIA_ACTION_API_URL = "https://en.wikipedia.org/w/api.php"
WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary"
CSV_PATH = Path(__file__).parent / "HSall_members.csv"
DEFAULT_CACHE_PATH = Path(__file__).parent / ".cache" / "ygn_api_cache.sqlite"
STATIC_MEMBER_OVERRIDES_PATH = Path(__file__).parent / "static_member_overrides.json"
STATIC_WIKI_DIR = Path(__file__).parent.parent / "docs" / "data" / "wiki"
# Build-time-computed live FEC ethics grades (written by generate_static_data.py,
# committed under docs/data/ethics/). The live API prefers these so it doesn't
# spend per-request FEC quota — see get_ethics_score.
STATIC_PRECOMPUTED_ETHICS_DIR = Path(__file__).parent.parent / "docs" / "data" / "ethics"
# Committed AI content for bills (descriptions + impacts), keyed by bill
# identifier. Served before calling the AI so known bills never regenerate —
# survives Heroku dyno restarts (the SQLite AI cache does not) and works even
# when no AI provider is configured. Refreshed by scripts/snapshot_bill_ai.py.
STATIC_BILL_AI_PATH = Path(__file__).parent.parent / "docs" / "data" / "bill-ai.json"
# Committed 40-bill recent-bills digest (written by generate_static_data.py). The
# background AI refresh reads it to enqueue generation for every bill in the feed,
# not just the handful the live digest warms each cycle — see
# _enqueue_committed_digest_ai_jobs.
STATIC_RECENT_DIGEST_PATH = (
    Path(__file__).parent.parent / "docs" / "data" / "recent-bills-digest.json"
)
STATIC_MEMBER_AI_DIR = Path(__file__).parent.parent / "docs" / "data" / "member-ai"
# Committed AI-written foreign-affairs brief (conflicts + diplomacy outlook). Like
# the bill/member AI stores this is served instantly and survives dyno restarts;
# the model regenerates it at most once every FOREIGN_BRIEF_TTL_SECONDS.
STATIC_FOREIGN_BRIEF_PATH = (
    Path(__file__).parent.parent / "docs" / "data" / "civic" / "foreign-brief.json"
)
STATIC_CIVIC_DIR = Path(__file__).parent.parent / "docs" / "data" / "civic"
DEFAULT_CACHE_TTL_SECONDS = 15 * 60
DEFAULT_WIKI_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
CACHE_LOCK_STRIPES = 256
CACHE_STALE_RETENTION_SECONDS = 90 * 24 * 60 * 60
CACHE_PRUNE_EVERY_WRITES = 256
REQUEST_TIMEOUT_SECONDS = 20
WIKI_USER_AGENT = "YGN/1.0 (government-officials-cache)"
ETHICS_METHOD_VERSION = "campaign_finance_stock_v4"
# Stock-trading conflict: a member whose household actively trades individual
# stocks (disclosed via House Periodic Transaction Reports) carries a real
# conflict-of-interest concern, so we DEDUCT from the campaign-finance grade
# based on how many PTR filings they've made recently. Deduction-only so members
# who don't trade individual stocks are unaffected. (max_ptr_inclusive, penalty)
STOCK_PENALTY_BANDS = [(0, 0), (2, 10), (5, 22), (9, 32), (19, 42)]
STOCK_PENALTY_MAX = 50

# --- Member dossier data sources -----------------------------------------
# unitedstates/congress-legislators: canonical, free, no-key crosswalk of
# every current member (bio, terms, committee assignments, social media, and
# IDs for Wikipedia/Ballotpedia/GovTrack/OpenSecrets/C-SPAN/FEC). Served as
# YAML from GitHub raw; parsed once and cached.
UNITEDSTATES_BASE_URL = (
    "https://raw.githubusercontent.com/unitedstates/congress-legislators/main"
)
UNITEDSTATES_CACHE_TTL_SECONDS = 24 * 60 * 60
# U.S. House Clerk financial-disclosure index (no key). Each {year}FD.zip holds
# a {year}FD.xml listing every filing (incl. "P" = periodic transaction report,
# i.e. a stock trade report) with the DocID needed to build the official PDF URL.
HOUSE_DISCLOSURE_ZIP_URL = (
    "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.zip"
)
HOUSE_PTR_PDF_URL = (
    "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{year}/{doc_id}.pdf"
)
HOUSE_ANNUAL_PDF_URL = (
    "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}/{doc_id}.pdf"
)
SENATE_EFD_SEARCH_URL = "https://efdsearch.senate.gov/search/"
DISCLOSURE_CACHE_TTL_SECONDS = 6 * 60 * 60
LEGISLATION_CACHE_TTL_SECONDS = 60 * 60
DOSSIER_CACHE_TTL_SECONDS = 15 * 60
HOUSE_FILING_TYPE_LABELS = {
    "P": "Periodic Transaction Report (stock/asset trade)",
    "O": "Annual Report",
    "A": "Annual Report (amendment)",
    "C": "Candidate Report",
    "D": "Financial Disclosure Report",
    "W": "Withdrawal",
    "X": "Filing Extension",
    "T": "Transaction Report",
}

# Congress.gov member payloads carry the full state name (e.g. "Vermont") but
# the FEC and NOMINATE datasets key on the two-letter USPS code (e.g. "VT").
STATE_NAME_TO_USPS = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "district of columbia": "DC", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
    "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY", "american samoa": "AS", "guam": "GU",
    "northern mariana islands": "MP", "puerto rico": "PR", "virgin islands": "VI",
}

BILL_TYPE_SLUGS = {
    "hr": "house-bill",
    "s": "senate-bill",
    "hres": "house-resolution",
    "sres": "senate-resolution",
    "hjres": "house-joint-resolution",
    "sjres": "senate-joint-resolution",
    "hconres": "house-concurrent-resolution",
    "sconres": "senate-concurrent-resolution",
}

LOGGER = logging.getLogger(__name__)
API_KEY = ""
ENV_PATHS = (
    Path(__file__).parent.parent / ".env",
    Path(__file__).parent / ".env",
)

_cache_lock = threading.RLock()
# Cached fetchers can call other cached fetchers while holding their stripe
# (ethics -> member/FEC/disclosure is one example). Two different keys can hash
# to the same stripe, so these locks must be reentrant or that collision
# deadlocks the worker forever.
_cache_key_locks = tuple(threading.RLock() for _ in range(CACHE_LOCK_STRIPES))
_cache_writes_since_prune = 0
_background_refresh_thread = None
_background_refresh_stop = threading.Event()
_ai_refresh_lock = threading.Lock()
_ai_generation_scope = threading.local()


class MissingCongressApiKey(RuntimeError):
    """Raised when a Congress.gov request is needed but no API key is configured."""


class MissingFecApiKey(RuntimeError):
    """Raised when a live FEC request is needed but no API key is configured."""


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
    env_keys = {
        "CONGRESS_API_KEY",
        "FEC_API_KEY",
        "ECON_API_KEY",
        "YGN_ECON_API_KEY",
        "FMP_API_KEY",
        "YGN_STOCK_API_KEY",
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_DEPLOYMENT",
        "AZURE_OPENAI_API_VERSION",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_MODEL",
    }
    for env_path in ENV_PATHS:
        if not env_path.exists():
            continue

        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue

            key, value = stripped.split("=", 1)
            normalized_key = key.strip()
            if normalized_key in env_keys and not os.getenv(normalized_key):
                os.environ[normalized_key] = value.strip().strip('"').strip("'")


def congress_api_key_available():
    _load_local_env()
    return bool(os.getenv("CONGRESS_API_KEY") or API_KEY)


def fec_api_key_available():
    return bool(_fec_api_key_pool())


def _congress_api_key():
    _load_local_env()
    api_key = os.getenv("CONGRESS_API_KEY") or API_KEY
    if not api_key:
        raise MissingCongressApiKey(
            "CONGRESS_API_KEY is not set. Add it to the backend environment before "
            "calling Congress.gov."
        )

    return api_key


_fec_key_cursor = 0
_fec_key_cursor_lock = threading.Lock()


def _fec_api_key_pool():
    """All configured FEC API keys, in order, de-duplicated.

    Multiple keys let the ethics sweep clear a single key's hourly quota / burst
    limit by round-robining requests (and rotating on a 429) across them. Supply
    them as a comma/space/newline-separated ``FEC_API_KEYS`` and/or numbered
    ``FEC_API_KEY``, ``FEC_API_KEY_2``, ``FEC_API_KEY_3`` ... . The legacy ECON
    keys still count."""
    _load_local_env()
    sources = [os.getenv("FEC_API_KEYS"), os.getenv("FEC_API_KEY")]
    sources += [os.getenv(f"FEC_API_KEY_{i}") for i in range(2, 21)]
    sources += [os.getenv("ECON_API_KEY"), os.getenv("YGN_ECON_API_KEY")]
    keys = []
    seen = set()
    for raw in sources:
        for key in re.split(r"[,\s]+", raw or ""):
            key = key.strip()
            if key and key not in seen:
                seen.add(key)
                keys.append(key)
    return keys


def _next_fec_api_key():
    """Round-robin the next FEC key so load spreads evenly across the pool."""
    keys = _fec_api_key_pool()
    if not keys:
        raise MissingFecApiKey(
            "No FEC API key is set. Add FEC_API_KEY (or FEC_API_KEYS / "
            "FEC_API_KEY_2..N for several) to the backend environment before "
            "refreshing live ethics grades."
        )
    global _fec_key_cursor
    with _fec_key_cursor_lock:
        key = keys[_fec_key_cursor % len(keys)]
        _fec_key_cursor += 1
    return key


def _fec_api_key():
    return _next_fec_api_key()


_initialized_cache_paths = set()
_cache_init_lock = threading.Lock()


def _connect_cache():
    path = _cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row

    # Create the schema (and switch to WAL for concurrent readers) once per cache
    # file rather than on every read/write — this ran on the hot path before.
    path_key = str(path)
    if path_key not in _initialized_cache_paths:
        with _cache_init_lock:
            if path_key not in _initialized_cache_paths:
                try:
                    conn.execute("PRAGMA journal_mode=WAL")
                except sqlite3.Error:
                    pass
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
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_api_cache_expires_at "
                    "ON api_cache (expires_at)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_api_cache_source_created "
                    "ON api_cache (source, created_at)"
                )
                conn.commit()
                _initialized_cache_paths.add(path_key)
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
    # No global lock: WAL mode + a fresh connection per read means concurrent
    # readers don't block each other (this is what lets the parallel dossier
    # sections actually overlap on warm-cache hits).
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
    global _cache_writes_since_prune

    created_at = _now_seconds()
    ttl = _cache_ttl_seconds() if ttl_seconds is None else ttl_seconds
    expires_at = created_at + ttl
    # Serialize (potentially multi-MB) payload OUTSIDE the write lock so it does
    # not block other writers while json.dumps runs.
    payload = json.dumps(response_json)

    with _cache_lock:
        with _cache_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO api_cache
                    (cache_key, response_json, created_at, expires_at, source)
                VALUES (?, ?, ?, ?, ?)
                """,
                (cache_key, payload, created_at, expires_at, source),
            )
            _cache_writes_since_prune += 1
            if _cache_writes_since_prune >= CACHE_PRUNE_EVERY_WRITES:
                # Keep expired entries around long enough to serve stale data during
                # an upstream outage, but do not let a long-lived dyno grow forever.
                conn.execute(
                    "DELETE FROM api_cache WHERE expires_at < ?",
                    (created_at - CACHE_STALE_RETENTION_SECONDS,),
                )
                _cache_writes_since_prune = 0
            conn.commit()


def _cache_lock_for_key(cache_key):
    # Fixed lock striping preserves single-flight behavior for a key without an
    # ever-growing dictionary (or a wholesale clear that can duplicate in-flight
    # work). A collision only serializes two unrelated cold misses briefly.
    digest = hashlib.blake2b(str(cache_key).encode("utf-8"), digest_size=2).digest()
    return _cache_key_locks[int.from_bytes(digest, "big") % CACHE_LOCK_STRIPES]


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


# Live FEC-backed results (ethics grades, funding) are cached far longer than the
# default because campaign-finance data changes monthly, not every 15 minutes —
# this cuts FEC calls ~100x for warm members so a modest key covers the roster.
FEC_LIVE_CACHE_TTL_SECONDS = 24 * 60 * 60


def _cached_json_dynamic(cache_key, source, fetch_json, ttl_for):
    """Like _cached_json, but the TTL is derived from the fetched result via
    ttl_for(result). Lets a successful live result cache for a long time while a
    fallback/failure caches briefly so it retries soon (e.g. once quota resets)."""
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

        _write_cache(cache_key, response_json, source, ttl_seconds=ttl_for(response_json))
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


def _fec_api_key_source():
    """Which environment-backed FEC key is in play, or None."""
    return "env" if _fec_api_key_pool() else None


def _fec_retry_delay(response, attempt):
    retry_after = (response.headers.get("Retry-After") or "").strip()
    if retry_after.isdigit():
        return min(float(retry_after), 3.0)
    return min(0.5 * (attempt + 1), 3.0)


def fec_key_diagnostic(probe=False):
    """Report FEC configuration; optionally make one explicit live probe.

    Public status requests never disclose key fragments or spend upstream quota.
    """
    source = _fec_api_key_source()
    if not probe:
        return {
            "configured": source is not None,
            "source": source,
            "probe_performed": False,
        }
    cache_key = _build_cache_key("fec-diagnostic", {"v": 1})

    def fetch_json():
        try:
            api_key = _fec_api_key()
        except MissingFecApiKey:
            return {"ok": False, "reason": "no_key_configured", "source": source}

        meta = {
            "source": source,
            "probe_performed": True,
        }
        try:
            resp = requests.get(
                f"{FEC_BASE_URL}/candidates/search/",
                params={
                    "q": "Sanders",
                    "office": "S",
                    "state": "VT",
                    "per_page": 1,
                    "api_key": api_key,
                },
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except requests.RequestException as exc:
            return {"ok": False, "reason": "request_failed", "error": str(exc), **meta}

        result = {
            "status": resp.status_code,
            "rate_limit": resp.headers.get("X-RateLimit-Limit"),
            "rate_remaining": resp.headers.get("X-RateLimit-Remaining"),
            **meta,
        }
        if resp.status_code == 200:
            try:
                count = len(resp.json().get("results", []))
            except ValueError:
                count = 0
            result["results"] = count
            result["ok"] = count > 0
            result["reason"] = "working" if count > 0 else "no_results"
        else:
            result["ok"] = False
            result["reason"] = {403: "forbidden_or_invalid_key", 429: "rate_limited"}.get(
                resp.status_code, "http_error"
            )
            try:
                result["message"] = ((resp.json() or {}).get("error") or {}).get("message") or resp.text[:180]
            except ValueError:
                result["message"] = resp.text[:180]
        return result

    return _cached_json(cache_key, "fec:diagnostic", fetch_json, ttl_seconds=60)


def _fec_get(path, params=None, ttl_seconds=None):
    cache_params = dict(params or {})
    cache_key = _build_cache_key(
        "fec",
        {
            "path": path,
            "params": cache_params,
        },
    )
    url = f"{FEC_BASE_URL}{path}"

    def fetch_json():
        # Give every key in the pool a shot before giving up on a 429.
        pool_size = max(1, len(_fec_api_key_pool()))
        attempts = max(3, pool_size)

        for attempt in range(attempts):
            request_params = dict(cache_params)
            request_params["api_key"] = _next_fec_api_key()  # rotate across the pool

            try:
                response = requests.get(
                    url,
                    params=request_params,
                    timeout=REQUEST_TIMEOUT_SECONDS,
                )
            except requests.RequestException:
                raise UpstreamDataError(f"FEC request failed for {path}.") from None

            if response.status_code == 429 and attempt + 1 < attempts:
                # Throttled key: rotate straight to the next key (fresh quota).
                # Only back off once we've likely cycled the whole pool.
                if attempt + 1 >= pool_size:
                    time.sleep(_fec_retry_delay(response, attempt))
                continue

            if response.status_code == 429:
                # Surface the key's actual budget: X-RateLimit-Limit ~60 means a
                # demo/unregistered key; a registered key allows 1,000/hour.
                LOGGER.warning(
                    "FEC 429 for %s after %d attempts; X-RateLimit-Limit=%s "
                    "X-RateLimit-Remaining=%s",
                    path,
                    attempts,
                    response.headers.get("X-RateLimit-Limit"),
                    response.headers.get("X-RateLimit-Remaining"),
                )
                raise UpstreamDataError(
                    f"FEC rate limit exceeded for {path}. All configured FEC keys "
                    "are throttled (a demo key allows only ~60 requests/hour; add "
                    "more via FEC_API_KEYS, or use a registered 1,000/hour key)."
                )

            try:
                response.raise_for_status()
            except requests.HTTPError:
                raise UpstreamDataError(
                    f"FEC request failed for {path} (HTTP {response.status_code})."
                ) from None

            return response.json()

        raise UpstreamDataError(f"FEC request failed for {path}.")

    return _cached_json(cache_key, f"fec:{path}", fetch_json, ttl_seconds=ttl_seconds)


def get_national_debt_metric():
    cache_key = _build_cache_key(
        "treasury",
        {
            "metric": "debt_to_penny",
            "sort": "-record_date",
            "page_size": 1,
        },
    )

    def fetch_json():
        try:
            response = requests.get(
                TREASURY_DEBT_URL,
                params={"sort": "-record_date", "page[size]": "1"},
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException:
            raise UpstreamDataError("Treasury Fiscal Data request failed.") from None

        payload = response.json()
        latest = (payload.get("data") or [None])[0]
        if not latest or latest.get("tot_pub_debt_out_amt") is None:
            raise UpstreamDataError("Treasury Fiscal Data did not include debt data.")

        return {
            "amount": str(latest.get("tot_pub_debt_out_amt")),
            "record_date": latest.get("record_date"),
            "source": "treasury_fiscal_data",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    return _cached_json(cache_key, "treasury:debt_to_penny", fetch_json)


# =========================================================================
# Economy dashboard: no-key public macro indicators (World Bank, BLS, Treasury).
# Each metric is cached and the snapshot degrades per-metric (a failed source
# becomes null with an entry in `errors`, never breaking the page).
# =========================================================================

ECONOMY_CACHE_TTL_SECONDS = 6 * 60 * 60


def _worldbank_indicator(indicator):
    cache_key = _build_cache_key("worldbank", {"indicator": indicator})

    def fetch_json():
        try:
            resp = requests.get(
                f"https://api.worldbank.org/v2/country/USA/indicator/{indicator}",
                params={"format": "json", "MRV": 3},
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            resp.raise_for_status()
        except requests.RequestException:
            raise UpstreamDataError(f"World Bank request failed for {indicator}.") from None

        payload = resp.json()
        rows = (
            payload[1]
            if isinstance(payload, list) and len(payload) > 1 and isinstance(payload[1], list)
            else []
        )
        for row in rows:
            if row.get("value") is not None:
                return {"value": float(row["value"]), "date": row.get("date"), "source": "world_bank"}
        raise UpstreamDataError(f"World Bank returned no value for {indicator}.")

    return _cached_json(
        cache_key, f"worldbank:{indicator}", fetch_json, ttl_seconds=ECONOMY_CACHE_TTL_SECONDS
    )


def _bls_series(series_id):
    cache_key = _build_cache_key("bls", {"series": series_id})

    def fetch_json():
        try:
            resp = requests.get(
                f"https://api.bls.gov/publicAPI/v1/timeseries/data/{series_id}",
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            resp.raise_for_status()
        except requests.RequestException:
            raise UpstreamDataError(f"BLS request failed for {series_id}.") from None

        series = (resp.json().get("Results") or {}).get("series") or []
        data = series[0].get("data") if series else []
        if not data:
            raise UpstreamDataError(f"BLS returned no data for {series_id}.")
        return {"data": data, "source": "bls"}

    return _cached_json(
        cache_key, f"bls:{series_id}", fetch_json, ttl_seconds=ECONOMY_CACHE_TTL_SECONDS
    )


def _bls_latest_value(series_id):
    latest = (_bls_series(series_id).get("data") or [{}])[0]
    return {
        "value": float(latest["value"]),
        "period": latest.get("periodName"),
        "year": latest.get("year"),
        "source": "bls",
    }


def _bls_inflation(series_id):
    data = _bls_series(series_id).get("data") or []
    latest = data[0]
    result = {
        "value": None,
        "index": float(latest["value"]),
        "period": latest.get("periodName"),
        "year": latest.get("year"),
        "source": "bls",
    }
    if len(data) >= 13:
        prior = float(data[12]["value"])
        if prior:
            result["value"] = round((float(latest["value"]) - prior) / prior * 100, 1)
    return result


def _treasury_debt_history():
    cache_key = _build_cache_key("treasury", {"metric": "debt_history_monthly"})

    def fetch_json():
        try:
            resp = requests.get(
                TREASURY_DEBT_URL,
                params={
                    "sort": "-record_date",
                    "fields": "record_date,tot_pub_debt_out_amt",
                    "page[size]": "400",
                },
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            resp.raise_for_status()
        except requests.RequestException:
            raise UpstreamDataError("Treasury debt-history request failed.") from None

        rows = resp.json().get("data") or []
        seen_months = set()
        points = []
        for row in rows:  # daily rows, most recent first
            record_date = row.get("record_date") or ""
            month = record_date[:7]
            amount = row.get("tot_pub_debt_out_amt")
            if month and month not in seen_months and amount:
                seen_months.add(month)
                points.append({"date": record_date, "amount": float(amount)})
        points = points[:13][::-1]  # oldest -> newest for charting
        if len(points) < 2:
            raise UpstreamDataError("Treasury debt-history returned too few points.")
        return {"points": points, "source": "treasury_fiscal_data"}

    return _cached_json(
        cache_key, "treasury:debt_history", fetch_json, ttl_seconds=ECONOMY_CACHE_TTL_SECONDS
    )


def get_economy_snapshot():
    snapshot = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "metrics": {},
        "errors": [],
    }

    def add(key, fetcher):
        try:
            snapshot["metrics"][key] = fetcher()
        except Exception as exc:  # noqa: BLE001 - per-metric degradation
            snapshot["metrics"][key] = None
            snapshot["errors"].append({"metric": key, "error": str(exc)})

    add("debt", get_national_debt_metric)
    add("debt_trend", _treasury_debt_history)
    add("gdp", lambda: _worldbank_indicator("NY.GDP.MKTP.CD"))
    add("population", lambda: _worldbank_indicator("SP.POP.TOTL"))
    add("unemployment", lambda: _bls_latest_value("LNS14000000"))
    add("inflation", lambda: _bls_inflation("CUUR0000SA0"))

    metrics = snapshot["metrics"]
    debt = metrics.get("debt")
    gdp = metrics.get("gdp")
    population = metrics.get("population")
    try:
        debt_amount = float(debt["amount"]) if debt else None
    except (TypeError, ValueError):
        debt_amount = None

    if debt_amount and gdp and gdp.get("value"):
        metrics["debt_to_gdp"] = {"value": round(debt_amount / gdp["value"] * 100, 1), "unit": "percent"}
    if debt_amount and population and population.get("value"):
        metrics["debt_per_capita"] = {"value": round(debt_amount / population["value"], 0)}

    return snapshot


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

    data = _congress_get(
        path,
        params=params,
    )
    return _apply_member_enrichment_to_payload(data)


def _current_congress_number(now=None):
    now = now or datetime.now(timezone.utc)
    return (now.year - 1789) // 2 + 1


def getRecentBills():
    # The bare /bill endpoint's default ordering returns decades-old bills, so
    # restrict to bills whose record was updated recently (fromDateTime), then
    # re-sort by latest ACTION date so the digest shows genuinely recent
    # legislative activity (updateDate is a record refresh, not an action).
    now = datetime.now(timezone.utc)
    from_dt = (now - timedelta(days=120)).strftime("%Y-%m-%dT00:00:00Z")
    data = _congress_get(
        "/bill",
        params={
            "limit": 80,
            "sort": "updateDate+desc",
            "fromDateTime": from_dt,
            "format": "json",
        },
    )

    bills = data.get("bills")
    if isinstance(bills, list):
        def _action_date(bill):
            return (bill.get("latestAction") or {}).get("actionDate") or ""

        data = {**data, "bills": sorted(bills, key=_action_date, reverse=True)}
    return data


def _bill_type_code(bill):
    return str(bill.get("type") or bill.get("billType") or "").lower()


def _bill_number(bill):
    value = bill.get("number")
    return "" if value is None else str(value)


def _bill_congress(bill):
    value = bill.get("congress")
    return "" if value is None else str(value)


def _bill_api_path(bill):
    congress = _bill_congress(bill)
    bill_type = _bill_type_code(bill)
    number = _bill_number(bill)
    if not congress or not bill_type or not number:
        return None
    return f"/bill/{congress}/{bill_type}/{number}"


def _bill_identifier(bill):
    bill_type = str(bill.get("type") or bill.get("billType") or "").upper()
    number = _bill_number(bill)
    return " ".join(part for part in (bill_type, number) if part)


def _bill_web_url(bill):
    congress = _bill_congress(bill)
    bill_type = _bill_type_code(bill)
    number = _bill_number(bill)
    slug = BILL_TYPE_SLUGS.get(bill_type)
    if not congress or not slug or not number:
        return bill.get("url")
    return f"https://www.congress.gov/bill/{congress}th-congress/{slug}/{number}"


def _strip_markup(value):
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _first_nonempty(*values):
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if value not in (None, "", [], {}):
            return value
    return None


def _bill_detail_payload(bill):
    path = _bill_api_path(bill)
    if not path:
        return {}
    try:
        return _congress_get(path, params={"format": "json"}).get("bill", {})
    except Exception:
        return {}


def _bill_summaries_payload(bill):
    path = _bill_api_path(bill)
    if not path:
        return []
    try:
        payload = _congress_get(f"{path}/summaries", params={"format": "json", "limit": 5})
    except Exception:
        return []
    return payload.get("summaries") or []


# Full bill text for the AI. Newly-introduced bills usually have NO official
# summary for weeks, which used to make the model punt with "the material is too
# thin" filler. The published text always exists, so feed it (capped) instead.
BILL_TEXT_MAX_CHARS = 9000
BILL_TEXT_TTL_SECONDS = 3 * 24 * 60 * 60


def _bill_text_excerpt(bill):
    """Plain-text excerpt of the bill's most recent published text version, capped
    at BILL_TEXT_MAX_CHARS. Returns '' when no text is published yet. Cached."""
    path = _bill_api_path(bill)
    if not path:
        return ""

    cache_key = _build_cache_key("bill-text-v1", {"path": path})

    def fetch_json():
        try:
            payload = _congress_get(f"{path}/text", params={"format": "json", "limit": 3})
        except Exception:  # noqa: BLE001 - text is best-effort enrichment
            return {"text": ""}
        url = None
        for version in payload.get("textVersions") or []:
            for fmt in version.get("formats") or []:
                if "formatted text" in str(fmt.get("type") or "").lower():
                    url = fmt.get("url")
                    break
            if url:
                break
        if not url:
            return {"text": ""}
        try:
            response = requests.get(
                url, headers={"User-Agent": WIKI_USER_AGENT}, timeout=REQUEST_TIMEOUT_SECONDS
            )
            response.raise_for_status()
        except requests.RequestException:
            return {"text": ""}
        text = _strip_markup(response.text)
        return {"text": text[:BILL_TEXT_MAX_CHARS]}

    try:
        return (
            _cached_json(cache_key, f"bill-text:{path}", fetch_json, ttl_seconds=BILL_TEXT_TTL_SECONDS)
            or {}
        ).get("text", "")
    except Exception:  # noqa: BLE001
        return ""


def _bill_committee_names(detail):
    committees = detail.get("committees") or []
    if isinstance(committees, dict):
        committees = committees.get("items") or committees.get("committees") or []
    names = []
    for committee in committees:
        if not isinstance(committee, dict):
            continue
        name = committee.get("name") or committee.get("systemCode")
        if name:
            names.append(str(name))
    return _dedupe_strings(names)


def _bill_member_items(bill, detail, cosponsor_preview=None):
    """Sponsor(s) + a short cosponsor preview for the digest tile. Cosponsors are
    NOT inline in the /bill payload (only a {count,url} reference), so callers pass
    a preview fetched from the /cosponsors sub-resource."""
    people = list(_bill_sponsor_items(bill, detail))
    people.extend(cosponsor_preview or [])

    if not people:
        people.append(
            {
                "role": "Live detail",
                "name": "Sponsor and cosponsor names load from Congress.gov when available",
            }
        )

    return people[:8]


def _bill_description(bill, detail, summaries):
    for summary in summaries:
        if not isinstance(summary, dict):
            continue
        text = _strip_markup(summary.get("text") or summary.get("summary"))
        if text:
            return {
                "text": text,
                "source": "Congress.gov bill summary",
                "updated_at": summary.get("updateDate"),
            }

    text = _strip_markup(
        _first_nonempty(
            detail.get("summary"),
            detail.get("title"),
            bill.get("title"),
            (bill.get("latestAction") or {}).get("text"),
        )
    )
    if text:
        return {
            "text": text,
            "source": "Congress.gov bill detail",
            "updated_at": detail.get("updateDate") or bill.get("updateDate"),
        }

    return {
        "text": "Congress.gov has not published a bill summary for this item yet.",
        "source": "YGN fallback",
        "updated_at": bill.get("updateDate"),
    }


def _bill_detail_path(bill):
    congress = _bill_congress(bill)
    bill_type = _bill_type_code(bill)
    number = _bill_number(bill)
    if not congress or not bill_type or not number:
        return None
    return f"{congress}/{bill_type}/{number}"


def _bill_digest_item(bill):
    detail = _bill_detail_payload(bill)
    summaries = _bill_summaries_payload(bill)
    latest_action = bill.get("latestAction") or detail.get("latestAction") or {}
    policy_area = detail.get("policyArea")
    if isinstance(policy_area, dict):
        policy_area = policy_area.get("name")

    api_url = bill.get("url") or (
        f"{BASE_URL}{_bill_api_path(bill)}?format=json" if _bill_api_path(bill) else None
    )
    web_url = _bill_web_url(bill)
    committees = _bill_committee_names(detail)
    sponsors = _bill_sponsor_items(bill, detail)
    # The cosponsor COUNT is already in the detail payload; the full cosponsor
    # list requires a separate /cosponsors call, so we defer that to the bill
    # detail page and keep the digest tile to sponsors + count (fast).
    cosponsor_count = _bill_cosponsor_count(bill, detail) or 0

    return {
        "identifier": _bill_identifier(bill),
        "title": _first_nonempty(detail.get("title"), bill.get("title"), "Untitled bill"),
        "congress": bill.get("congress") or detail.get("congress"),
        "type": bill.get("type") or detail.get("type"),
        "number": bill.get("number") or detail.get("number"),
        "originChamber": bill.get("originChamber") or detail.get("originChamber"),
        "description": _bill_description(bill, detail, summaries),
        # A committed short AI description (bill-ai.json) when available -- the
        # digest prefers it over the long official summary so tiles don't clip.
        "aiDescription": _cached_bill_ai_entry(
            bill, "description", queue_if_missing=True
        ),
        "members": _bill_member_items(bill, detail),
        "sponsors": sponsors,
        "cosponsorCount": cosponsor_count,
        "detailPath": _bill_detail_path(bill),
        "impact": {
            "status": "Pending AI impact analysis",
            "summary": (
                "AI impact analysis for this bill is queued and will appear after the next "
                "content refresh. The official Congress.gov record is linked below."
            ),
            # Just the human-readable bill page; the raw API-record link added
            # clutter without helping readers.
            "sources": [{"label": "Congress.gov bill page", "url": web_url}] if web_url else [],
        },
        "latestAction": {
            "date": latest_action.get("actionDate"),
            "text": latest_action.get("text"),
        },
        "policyArea": policy_area,
        "committees": committees[:4],
        "updatedAt": detail.get("updateDate") or bill.get("updateDate"),
        "url": web_url,
        "apiUrl": api_url,
    }


def _recent_bill_list(payload):
    if not isinstance(payload, dict):
        return []
    if isinstance(payload.get("bills"), list):
        return payload.get("bills") or []
    data = payload.get("data")
    if isinstance(data, dict) and isinstance(data.get("bills"), list):
        return data.get("bills") or []
    return []


# =========================================================================
# Cosponsors + roll-call votes (bill detail page)
#
# The /bill detail payload returns cosponsors as a {count, url} REFERENCE, not
# an inline list -- which is why the digest showed "no cosponsors". The real
# list lives at the /cosponsors sub-resource. Recorded (roll-call) votes are
# referenced from a bill's actions and published as XML by the House Clerk and
# the Senate (no API key needed); we fetch + parse those into a member-by-member
# yea/nay/present/not-voting breakdown for the bill detail page.
# =========================================================================

RECORDED_VOTE_TTL_SECONDS = 30 * 24 * 60 * 60  # roll-call results never change
BILL_DETAIL_TTL_SECONDS = 6 * 60 * 60
VOTE_USER_AGENT = "YGN/1.0 (+https://yourgovtnow.dev) civic-education"


def _person_item(person, role):
    if not isinstance(person, dict):
        return None
    name = _first_nonempty(
        person.get("fullName"),
        person.get("directOrderName"),
        person.get("name"),
    )
    if not name:
        return None
    return {
        "role": role,
        "name": name,
        "state": person.get("state"),
        "party": person.get("party"),
        "bioguideId": person.get("bioguideId"),
        "district": person.get("district"),
        "sponsorshipDate": person.get("sponsorshipDate"),
        "isOriginalCosponsor": person.get("isOriginalCosponsor"),
    }


def _bill_sponsor_items(bill, detail):
    sponsors = detail.get("sponsors") or bill.get("sponsors") or []
    if isinstance(sponsors, dict):
        sponsors = sponsors.get("items") or []
    items = [_person_item(person, "Sponsor") for person in sponsors]
    return [item for item in items if item]


def _bill_cosponsor_items(bill, limit=250):
    """Fetch the actual cosponsor list from the /cosponsors sub-resource."""
    path = _bill_api_path(bill)
    if not path:
        return []
    try:
        payload = _congress_get(
            f"{path}/cosponsors",
            params={"format": "json", "limit": max(1, min(int(limit), 250))},
        )
    except Exception:  # noqa: BLE001 - cosponsors are best-effort enrichment
        return []
    people = payload.get("cosponsors") or []
    if isinstance(people, dict):
        people = people.get("items") or []
    items = [_person_item(person, "Cosponsor") for person in people]
    return [item for item in items if item]


def _bill_cosponsor_count(bill, detail):
    cosponsors = detail.get("cosponsors")
    if isinstance(cosponsors, dict):
        count = cosponsors.get("count")
        if count is not None:
            try:
                return int(count)
            except (TypeError, ValueError):
                return None
    return None


def _normalize_vote_position(raw):
    text = str(raw or "").strip()
    lowered = text.lower()
    if lowered in {"yea", "yes", "aye", "guilty"}:
        return "Yea"
    if lowered in {"nay", "no", "not guilty"}:
        return "Nay"
    if lowered.startswith("present"):
        return "Present"
    if lowered in {"not voting", "not_voting", "absent", ""}:
        return "Not Voting"
    return text or "Not Voting"


def _tally_positions(positions):
    tally = {"Yea": 0, "Nay": 0, "Present": 0, "Not Voting": 0}
    for entry in positions:
        bucket = entry.get("vote")
        tally[bucket] = tally.get(bucket, 0) + 1
    return tally


def _parse_house_vote_xml(content):
    root = ET.fromstring(content)
    meta = root.find(".//vote-metadata")
    question = result = description = date = None
    if meta is not None:
        question = (meta.findtext("vote-question") or "").strip() or None
        result = (meta.findtext("vote-result") or "").strip() or None
        description = (meta.findtext("vote-desc") or "").strip() or None
        action_date = (meta.findtext("action-date") or "").strip()
        action_time = (meta.findtext("action-time") or "").strip()
        date = " ".join(part for part in (action_date, action_time) if part) or None

    positions = []
    for rv in root.findall(".//recorded-vote"):
        legislator = rv.find("legislator")
        vote_el = rv.find("vote")
        if legislator is None or vote_el is None:
            continue
        name = (
            legislator.get("unaccented-name")
            or legislator.get("sort-field")
            or (legislator.text or "").strip()
        )
        positions.append(
            {
                "name": name,
                "party": legislator.get("party"),
                "state": legislator.get("state"),
                "bioguideId": legislator.get("name-id") or None,
                "vote": _normalize_vote_position(vote_el.text),
            }
        )
    return question, result, description, date, positions


def _parse_senate_vote_xml(content):
    root = ET.fromstring(content)
    question = (root.findtext("vote_question_text") or root.findtext("question") or "").strip() or None
    result = (root.findtext("vote_result") or "").strip() or None
    description = (root.findtext("vote_title") or root.findtext("vote_document_text") or "").strip() or None
    date = (root.findtext("vote_date") or "").strip() or None

    positions = []
    for member in root.findall(".//member"):
        name = (member.findtext("member_full") or "").strip()
        if not name:
            first = (member.findtext("first_name") or "").strip()
            last = (member.findtext("last_name") or "").strip()
            name = " ".join(part for part in (first, last) if part)
        positions.append(
            {
                "name": name,
                "party": (member.findtext("party") or "").strip() or None,
                "state": (member.findtext("state") or "").strip() or None,
                "bioguideId": None,  # Senate XML exposes lis_member_id, not bioguide
                "vote": _normalize_vote_position(member.findtext("vote_cast")),
            }
        )
    return question, result, description, date, positions


def _fetch_recorded_vote(recorded_vote):
    """Fetch + parse one recorded vote (House Clerk or Senate XML) into a
    normalized member-by-member breakdown. Cached long-term (results are final)."""
    url = recorded_vote.get("url")
    chamber = str(recorded_vote.get("chamber") or "").strip()
    if not url:
        return None
    if url.startswith("http://"):
        url = "https://" + url[len("http://") :]

    cache_key = _build_cache_key("recorded-vote-v1", {"url": url})

    def fetch_json():
        try:
            response = requests.get(
                url,
                headers={"User-Agent": VOTE_USER_AGENT},
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException:
            raise UpstreamDataError(f"Recorded-vote fetch failed for {url}.") from None

        try:
            if chamber.lower().startswith("s"):
                question, result, description, date, positions = _parse_senate_vote_xml(response.content)
            else:
                question, result, description, date, positions = _parse_house_vote_xml(response.content)
        except ET.ParseError:
            raise UpstreamDataError(f"Recorded-vote XML was unparseable for {url}.") from None

        return {
            "chamber": chamber or None,
            "rollNumber": recorded_vote.get("rollNumber"),
            "congress": recorded_vote.get("congress"),
            "sessionNumber": recorded_vote.get("sessionNumber"),
            "date": recorded_vote.get("date") or date,
            "question": question,
            "result": result,
            "description": description,
            "url": url,
            "totals": _tally_positions(positions),
            "positions": positions,
        }

    try:
        return _cached_json(
            cache_key,
            f"recorded-vote:{url}",
            fetch_json,
            ttl_seconds=RECORDED_VOTE_TTL_SECONDS,
        )
    except UpstreamDataError:
        return None


def _bill_recorded_votes(bill, max_votes=4):
    """Collect recorded votes referenced in a bill's actions, most recent first."""
    path = _bill_api_path(bill)
    if not path:
        return []
    try:
        payload = _congress_get(f"{path}/actions", params={"format": "json", "limit": 250})
    except Exception:  # noqa: BLE001
        return []

    seen = set()
    recorded = []
    for action in payload.get("actions") or []:
        for rv in action.get("recordedVotes") or []:
            key = (rv.get("chamber"), rv.get("rollNumber"), rv.get("congress"), rv.get("sessionNumber"))
            if key in seen:
                continue
            seen.add(key)
            recorded.append(rv)

    def _rv_date(rv):
        return rv.get("date") or ""

    recorded.sort(key=_rv_date, reverse=True)

    votes = []
    for rv in recorded[:max_votes]:
        parsed = _fetch_recorded_vote(rv)
        if parsed:
            votes.append(parsed)
    return votes


def _bill_ai_seed(bill_ref, detail, summaries, sponsors, cosponsors, *, include_text=False):
    policy_area = detail.get("policyArea")
    if isinstance(policy_area, dict):
        policy_area = policy_area.get("name")
    latest_action = detail.get("latestAction") or {}
    cosponsor_parties = {}
    for person in cosponsors:
        party = (person.get("party") or "?").strip() or "?"
        cosponsor_parties[party] = cosponsor_parties.get(party, 0) + 1
    return {
        "identifier": _bill_identifier(bill_ref),
        "title": _first_nonempty(detail.get("title"), "Untitled bill"),
        "description": _bill_description(bill_ref, detail, summaries),
        "policyArea": policy_area,
        "originChamber": detail.get("originChamber"),
        "sponsors": sponsors,
        "cosponsorCount": _bill_cosponsor_count(bill_ref, detail) or len(cosponsors),
        "cosponsorParties": cosponsor_parties,
        "committees": _bill_committee_names(detail),
        "latestAction": {
            "date": latest_action.get("actionDate"),
            "text": latest_action.get("text"),
        },
        "updatedAt": detail.get("updateDate") or bill_ref.get("updateDate"),
        # Bill text is expensive (Congress metadata + a second HTML download).
        # Request paths leave it lazy; explicit AI refresh/generation resolves it
        # inside `_bill_ai_context` only when a model call is actually needed.
        "textExcerpt": _bill_text_excerpt(bill_ref) if include_text else None,
        "congress": bill_ref.get("congress"),
        "type": bill_ref.get("type"),
        "number": bill_ref.get("number"),
    }


def get_bill_detail(congress, bill_type, number, include_votes=True, include_ai=False):
    """Bill detail for the clickable page: sponsor, full cosponsor list, official
    description, committees, latest action, and roll-call vote breakdowns.

    AI description/impact are NOT generated inline by default -- a cold model call
    (gpt-5-mini reasoning + cosponsor/vote fetches) can blow Heroku's 30s request
    limit. Committed AI content (bill-ai.json) is applied instantly; anything not
    committed is fetched lazily by the client via `get_bill_ai`. Set include_ai=True
    (build-time snapshot only) to also generate missing AI content inline."""
    bill_type = str(bill_type or "").lower()
    congress = str(congress or "").strip()
    number = str(number or "").strip()
    cache_key = _build_cache_key(
        "bill-detail-v2",
        {"congress": congress, "type": bill_type, "number": number,
         "votes": bool(include_votes), "ai": bool(include_ai)},
    )

    def fetch_json():
        bill_ref = {"congress": congress, "type": bill_type, "number": number}
        detail = _bill_detail_payload(bill_ref)
        if not detail:
            raise UpstreamDataError(
                f"No Congress.gov record for {bill_type.upper()} {number} ({congress})."
            )

        summaries = _bill_summaries_payload(bill_ref)
        sponsors = _bill_sponsor_items(bill_ref, detail)
        cosponsors = _bill_cosponsor_items(bill_ref)
        seed = _bill_ai_seed(bill_ref, detail, summaries, sponsors, cosponsors)

        item = {
            "identifier": seed["identifier"],
            "title": seed["title"],
            "congress": detail.get("congress") or congress,
            "type": detail.get("type") or bill_type.upper(),
            "number": detail.get("number") or number,
            "originChamber": detail.get("originChamber"),
            "introducedDate": detail.get("introducedDate"),
            "policyArea": seed["policyArea"],
            "description": seed["description"],
            "sponsors": sponsors,
            "cosponsors": cosponsors,
            "cosponsorCount": seed["cosponsorCount"],
            "committees": seed["committees"],
            "latestAction": seed["latestAction"],
            "updatedAt": detail.get("updateDate"),
            "url": _bill_web_url(bill_ref),
            "detailPath": f"{congress}/{bill_type}/{number}",
        }

        # Committed/refresh-cache AI is instant. Missing content is queued for a
        # refresh worker; this request never invokes the model.
        cached_desc = _cached_bill_ai_entry(
            seed, "description", queue_if_missing=not include_ai
        )
        if cached_desc:
            item["aiDescription"] = cached_desc
        cached_impact = _cached_bill_ai_entry(
            seed, "impact", queue_if_missing=not include_ai
        )
        if cached_impact:
            item["impact"] = {"status": "AI impact analysis", **cached_impact}

        if include_ai:
            # This flag is reserved for trusted build/refresh callers. The public
            # route never passes it, and the generation scope guards future code
            # from accidentally turning a read path into a paid model call.
            with _allow_ai_generation():
                if "aiDescription" not in item:
                    try:
                        ai_desc = generate_bill_description(seed)
                        if ai_desc and ai_desc.get("summary"):
                            item["aiDescription"] = ai_desc
                    except Exception as exc:  # noqa: BLE001
                        LOGGER.warning("Bill AI description failed: %s", exc)
                if "impact" not in item:
                    try:
                        impact = generate_bill_impact(seed)
                        if impact and impact.get("summary"):
                            item["impact"] = impact
                    except Exception as exc:  # noqa: BLE001
                        LOGGER.warning("Bill AI impact failed: %s", exc)

        item["votes"] = _bill_recorded_votes(bill_ref) if include_votes else []
        item["aiPending"] = "aiDescription" not in item or "impact" not in item

        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "congress_api",
            "ai_enabled": ai_insights_available(),
            "ai_mode": "cache_refresh_only",
            "bill": item,
        }

    return _cached_json(
        cache_key,
        f"bill-detail:{congress}:{bill_type}:{number}",
        fetch_json,
        ttl_seconds=BILL_DETAIL_TTL_SECONDS,
    )


def _load_bill_ai_seed(congress, bill_type, number):
    bill_type = str(bill_type or "").lower()
    congress = str(congress or "").strip()
    number = str(number or "").strip()
    bill_ref = {"congress": congress, "type": bill_type, "number": number}
    detail = _bill_detail_payload(bill_ref)
    if not detail:
        raise UpstreamDataError(
            f"No Congress.gov record for {bill_type.upper()} {number} ({congress})."
        )
    summaries = _bill_summaries_payload(bill_ref)
    sponsors = _bill_sponsor_items(bill_ref, detail)
    cosponsors = _bill_cosponsor_items(bill_ref)
    return _bill_ai_seed(bill_ref, detail, summaries, sponsors, cosponsors)


def _bill_ai_pending_fallback(seed):
    return {
        "description": seed.get("description"),
        "impact": {
            "status": "Queued for content refresh",
            "summary": (
                "A generated impact analysis is not cached yet. YGN will process this bill "
                "during the next content refresh; the linked Congress.gov summary and text "
                "remain the source of record."
            ),
        },
    }


def get_bill_ai(congress, bill_type, number):
    """Serve committed/refresh-cached bill AI and queue misses.

    This function is safe on a public HTTP request: it never invokes the model.
    """
    seed = _load_bill_ai_seed(congress, bill_type, number)
    result = {}
    cached_desc = _cached_bill_ai_entry(seed, "description", queue_if_missing=True)
    cached_impact = _cached_bill_ai_entry(seed, "impact", queue_if_missing=True)
    if cached_desc:
        result["aiDescription"] = cached_desc
    if cached_impact:
        result["impact"] = {"status": "AI impact analysis", **cached_impact}

    missing = [
        label
        for label, key in (("description", "aiDescription"), ("impact", "impact"))
        if key not in result
    ]

    return {
        "available": bool(result),
        "pending": bool(missing),
        "queued": bool(missing),
        "missing": missing,
        "ai_enabled": ai_insights_available(),
        "ai_mode": "cache_refresh_only",
        "identifier": _bill_ai_identifier(seed),
        "display_identifier": seed["identifier"],
        "fallback": _bill_ai_pending_fallback(seed) if missing else None,
        **result,
    }


def refresh_bill_ai(congress, bill_type, number, *, force=False):
    """Explicit model-writing path used only by refresh workers and CI."""
    seed = _load_bill_ai_seed(congress, bill_type, number)
    if not ai_insights_available():
        return {
            "available": False,
            "identifier": _bill_ai_identifier(seed),
            "reason": "No AI provider is configured.",
        }

    jobs = {
        "aiDescription": lambda: generate_bill_description(seed, force=force),
        "impact": lambda: generate_bill_impact(seed, force=force),
    }
    result = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {
            pool.submit(_run_in_ai_generation_scope, fn): key
            for key, fn in jobs.items()
        }
        for future in as_completed(futures):
            key = futures[future]
            try:
                value = future.result()
                if value and value.get("summary"):
                    result[key] = value
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("Bill AI refresh (%s) failed: %s", key, exc)

    return {
        "available": bool(result),
        "identifier": _bill_ai_identifier(seed),
        "display_identifier": seed["identifier"],
        "source_updated_at": seed.get("updatedAt"),
        **result,
    }


# =========================================================================
# AI insights (optional): plain-language "impact" analysis for bills.
#
# Provider-agnostic and OFF by default. Configure ONE of:
#   - Azure OpenAI: AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY
#       (optional AZURE_OPENAI_DEPLOYMENT [default gpt-4o-mini],
#        AZURE_OPENAI_API_VERSION [default 2024-08-01-preview])
#   - Any OpenAI-compatible API: OPENAI_API_KEY
#       (optional OPENAI_BASE_URL, OPENAI_MODEL)
# Called with `requests` (no extra dependency). Without config, bill impact
# degrades to its existing "pending" placeholder. Each impact is cached for
# 30 days (bill text is static once published), so live/API usage is tiny.
# =========================================================================

AI_IMPACT_TTL_SECONDS = 30 * 24 * 60 * 60
AI_DESCRIPTION_TTL_SECONDS = 30 * 24 * 60 * 60
AI_PENDING_JOB_TTL_SECONDS = 7 * 24 * 60 * 60
AI_BILL_CONTENT_VERSION = "bill-ai-v6"
AI_REFRESH_QUEUE_SOURCE = "ai-refresh-queue"
# Model calls get a longer HTTP timeout than ordinary API fetches: reasoning
# models chew on the full bill text for well over the global 20s.
AI_REQUEST_TIMEOUT_SECONDS = 60
DEFAULT_AI_MODEL = "gpt-4o-mini"
BILL_IMPACT_SYSTEM_PROMPT = (
    "You are a nonpartisan legislative analyst for a U.S. civic-information site. Your job "
    "is to explain, in plain language a curious 9th-grader could follow, WHO and WHAT a bill "
    "would affect if it became law. You are given the bill's FULL TEXT when it is published "
    "-- read it and work from what it actually says. Rules: (1) Be concrete and specific to "
    "THIS bill -- name the actual groups, agencies, industries, states, or programs involved; "
    "never write generic filler like 'this bill could affect various stakeholders.' "
    "(2) Combine the bill text with your background knowledge of the relevant law, agencies, "
    "programs, and public reporting on this subject to explain real-world effects. "
    "(3) NEVER say the material is too thin, that you cannot assess, or that no summary is "
    "available -- every response must extract concrete substance from the text, title, and "
    "your knowledge. Do not invent specific dollar amounts or provisions that are not "
    "supported. (4) Strictly nonpartisan: no praise, no criticism, no predicting passage. "
    "(5) Active voice, everyday words, zero meta-commentary about your sources or limits."
)
BILL_DESCRIPTION_SYSTEM_PROMPT = (
    "You are a nonpartisan civic explainer for a U.S. government-information site. In plain "
    "language a general audience can follow, describe what a bill IS: its subject, the concrete "
    "change it proposes, and its scope (who/what it covers). You are given the bill's FULL TEXT "
    "when it is published -- read it and describe what it actually does. Rules: (1) Lead with "
    "the single clearest sentence a reader needs -- what the bill does -- then add scope. "
    "(2) Be specific to this bill; combine its text with your background knowledge of the "
    "relevant law and agencies. Never generic boilerplate. (3) NEVER say the material is too "
    "thin or that no summary exists -- extract the substance from the text and title; just do "
    "not invent provisions or numbers that are not supported. (4) Strictly neutral: no partisan "
    "framing, no passage prediction. (5) No meta-commentary (do not mention summaries, "
    "sources, or what you were given); get straight to substance."
)


@contextmanager
def _allow_ai_generation():
    """Temporarily authorize model access for a trusted refresh operation."""
    previous = getattr(_ai_generation_scope, "allowed", False)
    _ai_generation_scope.allowed = True
    try:
        yield
    finally:
        _ai_generation_scope.allowed = previous


def _run_in_ai_generation_scope(callable_):
    # Thread-local state does not flow into ThreadPoolExecutor workers, so each
    # refresh field establishes its own narrow generation scope.
    with _allow_ai_generation():
        return callable_()


def _ai_result_cache_key(kind, cache_id):
    return _build_cache_key("ai-result-v1", {"kind": kind, "id": cache_id})


def _ai_job_cache_key(kind, cache_id):
    return _build_cache_key("ai-refresh-job-v1", {"kind": kind, "id": cache_id})


def _write_ai_result(kind, cache_id, result, ttl_seconds):
    if not isinstance(result, dict) or not result:
        return
    _write_cache(
        _ai_result_cache_key(kind, cache_id),
        result,
        f"ai-result:{kind}:{cache_id}",
        ttl_seconds=ttl_seconds,
    )


def _read_ai_result(kind, cache_id, *, queue_payload=None):
    """Serve a generated result without ever calling the model on this path.

    Fresh results are returned immediately. An expired result remains usable while
    a refresh job is queued, so a provider outage never erases previously generated
    public content.
    """
    cache_key = _ai_result_cache_key(kind, cache_id)
    fresh = _read_cache(cache_key)
    if fresh is not None:
        return fresh
    stale = _read_cache(cache_key, allow_stale=True)
    if queue_payload is not None:
        _queue_ai_refresh_job(kind, cache_id, queue_payload)
    return stale


def _queue_ai_refresh_job(kind, cache_id, payload):
    """Queue a missing/stale AI artifact for the next cache refresh.

    The queue lives in SQLite alongside the API cache. INSERT-if-missing semantics
    make repeated page views free and prevent a public request from multiplying
    provider work.
    """
    job_key = _ai_job_cache_key(kind, cache_id)
    if _read_cache(job_key, allow_stale=True) is not None:
        return False
    job = {
        "kind": kind,
        "cache_id": cache_id,
        "payload": payload,
        "queued_at": datetime.now(timezone.utc).isoformat(),
        "attempts": 0,
    }
    _write_cache(
        job_key,
        job,
        AI_REFRESH_QUEUE_SOURCE,
        ttl_seconds=AI_PENDING_JOB_TTL_SECONDS,
    )
    return True


def _pending_ai_refresh_jobs(limit):
    limit = max(0, int(limit))
    if not limit:
        return []
    with _cache_connection() as conn:
        rows = conn.execute(
            """
            SELECT cache_key, response_json
            FROM api_cache
            WHERE source = ? AND expires_at > ?
            ORDER BY created_at ASC
            LIMIT ?
            """,
            (AI_REFRESH_QUEUE_SOURCE, _now_seconds(), limit),
        ).fetchall()
    jobs = []
    for row in rows:
        try:
            job = json.loads(row["response_json"])
        except (TypeError, ValueError):
            job = {}
        jobs.append((row["cache_key"], job))
    return jobs


def _delete_cache_entry(cache_key):
    with _cache_lock:
        with _cache_connection() as conn:
            conn.execute("DELETE FROM api_cache WHERE cache_key = ?", (cache_key,))
            conn.commit()


def _record_ai_job_failure(job_key, job, error):
    failed = dict(job or {})
    failed["attempts"] = int(failed.get("attempts") or 0) + 1
    failed["last_error"] = str(error)[:500]
    failed["last_attempt_at"] = datetime.now(timezone.utc).isoformat()
    _write_cache(
        job_key,
        failed,
        AI_REFRESH_QUEUE_SOURCE,
        ttl_seconds=AI_PENDING_JOB_TTL_SECONDS,
    )


def _ai_provider_config():
    _load_local_env()
    endpoint = (os.getenv("AZURE_OPENAI_ENDPOINT") or "").strip().rstrip("/")
    azure_key = (os.getenv("AZURE_OPENAI_API_KEY") or "").strip()
    if endpoint and azure_key:
        deployment = (os.getenv("AZURE_OPENAI_DEPLOYMENT") or DEFAULT_AI_MODEL).strip()
        return {
            "kind": "azure",
            "url": f"{endpoint}/openai/deployments/{deployment}/chat/completions",
            "api_version": (os.getenv("AZURE_OPENAI_API_VERSION") or "2024-08-01-preview").strip(),
            "key": azure_key,
            "model": deployment,
        }
    openai_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if openai_key:
        base = (os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1").strip().rstrip("/")
        return {
            "kind": "openai",
            "url": f"{base}/chat/completions",
            "key": openai_key,
            "model": (os.getenv("OPENAI_MODEL") or DEFAULT_AI_MODEL).strip(),
        }
    return None


def ai_insights_available():
    return _ai_provider_config() is not None


def ai_provider_name():
    config = _ai_provider_config()
    return config["kind"] if config else None


def _is_next_gen_model(model):
    """gpt-5*, o1/o3/o4* reasoning models require `max_completion_tokens` (not
    `max_tokens`) and only accept the default temperature."""
    return bool(re.match(r"(gpt-5|o[1-4])(\b|[-_])", str(model or "").lower()))


def _llm_chat(system_prompt, user_prompt, max_tokens=250, temperature=0.2):
    if not getattr(_ai_generation_scope, "allowed", False):
        raise UpstreamDataError(
            "AI generation is restricted to an explicit cache refresh operation."
        )
    config = _ai_provider_config()
    if not config:
        raise UpstreamDataError("No AI provider is configured.")

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    if config["kind"] == "azure":
        headers = {"api-key": config["key"], "Content-Type": "application/json"}
        params = {"api-version": config["api_version"]}
    else:
        headers = {"Authorization": f"Bearer {config['key']}", "Content-Type": "application/json"}
        params = None

    # Start from a model-name heuristic, then adapt to the two common 400s
    # ("use max_completion_tokens" / "temperature not supported") so this works
    # across gpt-4o-mini AND gpt-5/o-series without per-deployment config.
    state = {"modern": _is_next_gen_model(config.get("model")), "temperature": True}

    def build_body():
        body = {"messages": messages}
        if state["modern"]:
            # Reasoning models spend part of the budget on hidden reasoning, and
            # long inputs (full bill text) can burn 1-2k reasoning tokens before a
            # single output token -- a 1200 cap produced empty completions on big
            # bills. Give real headroom; unused budget costs nothing.
            body["max_completion_tokens"] = max(max_tokens * 4, 4000)
        else:
            body["max_tokens"] = max_tokens
            if state["temperature"]:
                body["temperature"] = temperature
        if config["kind"] != "azure":
            body["model"] = config["model"]
        return body

    last_error = None
    for _ in range(3):
        try:
            # Reasoning models (gpt-5-mini) on a full-bill-text prompt routinely
            # exceed the global 20s API timeout; give model calls their own budget.
            # Even if Heroku cuts the client request at 30s, this handler finishes
            # and caches the result, so the next request serves it instantly.
            response = requests.post(
                config["url"], params=params, headers=headers,
                json=build_body(), timeout=AI_REQUEST_TIMEOUT_SECONDS,
            )
        except requests.RequestException as exc:
            LOGGER.warning("AI provider connection failed: %s", exc)
            raise UpstreamDataError(f"AI provider request failed: {exc}") from None

        if response.status_code < 400:
            choices = response.json().get("choices") or []
            # `content` can be explicitly null (reasoning models that exhaust
            # max_completion_tokens on hidden reasoning), so coalesce before strip.
            content = ((choices[0].get("message") or {}).get("content") or "").strip() if choices else ""
            if content:
                return content
            raise UpstreamDataError("AI provider returned an empty completion.")

        body_text = (response.text or "")
        low = body_text.lower()
        # Adaptive parameter fixes (retry once each).
        if response.status_code == 400 and "max_completion_tokens" in low and not state["modern"]:
            state["modern"] = True
            continue
        if response.status_code == 400 and "temperature" in low and state["temperature"] and not state["modern"]:
            state["temperature"] = False
            continue

        snippet = body_text[:300].replace("\n", " ")
        hint = _ai_error_hint(config, response.status_code)
        LOGGER.warning("AI provider HTTP %s: %s", response.status_code, snippet)
        last_error = UpstreamDataError(
            f"AI provider returned HTTP {response.status_code}. {hint} Detail: {snippet}"
        )
        break

    raise last_error or UpstreamDataError("AI provider request failed after parameter adaptation.")


def _ai_error_hint(config, status_code):
    """Human hint for the most common provider misconfigurations."""
    if status_code in (401, 403):
        return "Check the API key (AZURE_OPENAI_API_KEY / OPENAI_API_KEY)."
    if status_code == 404:
        if config.get("kind") == "azure":
            return (
                "The deployment was not found - set AZURE_OPENAI_DEPLOYMENT to your exact "
                "Azure deployment name and verify AZURE_OPENAI_ENDPOINT."
            )
        return "The model/endpoint was not found - check OPENAI_MODEL / OPENAI_BASE_URL."
    if status_code == 429:
        return "Rate limited or over quota - the Azure deployment may need a quota increase."
    if status_code == 400:
        return (
            "The request was rejected - the deployed model may need a different API version "
            "or reject 'temperature'/'max_tokens'; try AZURE_OPENAI_API_VERSION=2024-08-01-preview."
        )
    return "Verify the provider endpoint, key, deployment/model, and API version."


def ai_key_diagnostic(probe=False):
    """Report provider configuration without spending a model call by default.

    A live probe is reserved for explicit refresh/administrative workflows. The
    public status endpoint only needs to say whether configuration is present.
    """
    config = _ai_provider_config()
    if not config:
        return {
            "available": False,
            "provider": None,
            "reason": "No AI provider configured (set AZURE_OPENAI_* or OPENAI_*).",
        }
    result = {
        "available": True,
        "provider": config["kind"],
        "model": config.get("model"),
        "endpoint_host": None,
        "configured": True,
        "probe_performed": bool(probe),
    }
    try:
        from urllib.parse import urlparse

        result["endpoint_host"] = urlparse(config["url"]).hostname
    except Exception:  # noqa: BLE001
        pass
    if config["kind"] == "azure":
        result["api_version"] = config.get("api_version")
    if not probe:
        return result
    try:
        with _allow_ai_generation():
            reply = _llm_chat(
                "You are a test.", "Reply with the single word OK.", max_tokens=5
            )
        result["ok"] = True
        result["sample"] = (reply or "")[:40]
    except UpstreamDataError as exc:
        result["error"] = str(exc)[:400]
    return result


def _bill_ai_identifier(bill_item):
    """Stable, cross-Congress key for generated bill content.

    Display identifiers such as ``HR 1`` collide every Congress. Prefer the
    canonical ``119/hr/1`` path whenever the structured fields are available.
    """
    detail_path = str(bill_item.get("detailPath") or "").strip().strip("/")
    parts = detail_path.split("/") if detail_path else []
    if len(parts) == 3 and all(parts):
        return f"{parts[0]}/{parts[1].lower()}/{parts[2]}"
    congress = _bill_congress(bill_item)
    bill_type = _bill_type_code(bill_item)
    number = _bill_number(bill_item)
    if congress and bill_type and number:
        return f"{congress}/{str(bill_type).lower()}/{number}"
    return (
        bill_item.get("identifier")
        or bill_item.get("url")
        or bill_item.get("title")
        or "unknown"
    )


def _static_bill_ai_store():
    """Committed {identifier -> {description, impact}} AI content for bills.
    Read once per file mtime; treat as read-only."""
    store = _read_json_file_cached(STATIC_BILL_AI_PATH, {})
    if isinstance(store, dict):
        bills = store.get("bills")
        if isinstance(bills, dict):
            return bills
    return {}


def _static_bill_ai_record(bill_item):
    """Return a committed record plus whether it used the legacy display key.

    The legacy fallback is intentionally limited to the current Congress so an
    old ``HR 1`` record cannot leak into a different Congress with the same
    display identifier. The snapshot job rewrites touched records canonically.
    """
    store = _static_bill_ai_store()
    identifier = (
        _bill_ai_identifier(bill_item)
        if isinstance(bill_item, dict)
        else str(bill_item or "")
    )
    entry = store.get(identifier)
    if isinstance(entry, dict):
        return entry, False
    if isinstance(bill_item, dict):
        congress = _bill_congress(bill_item)
        legacy_identifier = _bill_identifier(bill_item)
        if (
            str(congress or "") == str(_current_congress_number())
            and legacy_identifier
            and isinstance(store.get(legacy_identifier), dict)
        ):
            return store[legacy_identifier], True
    return None, False


def _bill_ai_entry_is_current(entry, bill_item):
    if not isinstance(entry, dict):
        return False
    if entry.get("content_version") != AI_BILL_CONTENT_VERSION:
        return False
    expected_update = bill_item.get("updatedAt") or bill_item.get("updateDate")
    cached_update = entry.get("source_updated_at")
    return not expected_update or cached_update == expected_update


def _static_bill_ai_entry(bill_item, field):
    """A committed AI `field` ('description'|'impact') for this bill, or None."""
    entry, legacy = _static_bill_ai_record(bill_item)
    if isinstance(entry, dict):
        value = entry.get(field)
        if isinstance(value, dict) and value.get("summary"):
            return {
                **value,
                "source": "committed_legacy" if legacy else "committed",
            }
    return None


def _bill_ai_job_payload(bill_item):
    congress = _bill_congress(bill_item)
    bill_type = _bill_type_code(bill_item)
    number = _bill_number(bill_item)
    if not congress or not bill_type or not number:
        return None
    return {
        "congress": str(congress),
        "bill_type": str(bill_type).lower(),
        "number": str(number),
        "source_updated_at": bill_item.get("updatedAt") or bill_item.get("updateDate"),
    }


def _cached_bill_ai_entry(bill_item, field, *, queue_if_missing=False):
    identifier = _bill_ai_identifier(bill_item)
    committed_record, _legacy = _static_bill_ai_record(bill_item)
    committed = _static_bill_ai_entry(bill_item, field)
    if committed:
        if queue_if_missing and not _bill_ai_entry_is_current(
            committed_record, bill_item
        ):
            payload = _bill_ai_job_payload(bill_item)
            if payload:
                _queue_ai_refresh_job("bill", identifier, payload)
        return committed
    cached = _read_ai_result(f"bill-{field}", identifier)
    if cached and cached.get("summary"):
        if queue_if_missing and not _bill_ai_entry_is_current(cached, bill_item):
            payload = _bill_ai_job_payload(bill_item)
            if payload:
                _queue_ai_refresh_job("bill", identifier, payload)
        return {**cached, "source": cached.get("source") or "refresh_cache"}
    if queue_if_missing:
        payload = _bill_ai_job_payload(bill_item)
        if payload:
            _queue_ai_refresh_job("bill", identifier, payload)
    return None


def _bill_ai_context(bill_item):
    """Build the richest available context block for the AI (sponsor party,
    bipartisanship signal, chamber, committees, latest action, official summary)."""
    lines = [f"Bill: {bill_item.get('title') or 'Untitled bill'}"]
    chamber = bill_item.get("originChamber")
    if chamber:
        lines.append(f"Originating chamber: {chamber}")
    policy_area = bill_item.get("policyArea")
    lines.append(f"Policy area: {policy_area or 'Unspecified'}")

    sponsors = bill_item.get("sponsors") or []
    if sponsors and isinstance(sponsors[0], dict):
        s = sponsors[0]
        who = " ".join(part for part in (s.get("name"), s.get("party") and f"[{s.get('party')}-{s.get('state') or '?'}]") if part)
        if who:
            lines.append(f"Lead sponsor: {who}")

    count = bill_item.get("cosponsorCount")
    parties = bill_item.get("cosponsorParties")
    if isinstance(parties, dict) and parties:
        breakdown = ", ".join(f"{n} {p}" for p, n in sorted(parties.items()))
        bipartisan = len([p for p in parties if p in ("D", "R")]) >= 2
        lines.append(
            f"Cosponsors: {count if count is not None else sum(parties.values())} "
            f"({breakdown}){'; bipartisan' if bipartisan else ''}"
        )
    elif count is not None:
        lines.append(f"Cosponsors: {count}")

    committees = ", ".join(bill_item.get("committees") or [])
    if committees:
        lines.append(f"Committees: {committees}")
    latest = (bill_item.get("latestAction") or {}).get("text")
    if latest:
        lines.append(f"Latest action: {latest}")
    official = (bill_item.get("description") or {}).get("text") or ""
    if official:
        lines.append(f"Official summary: {official}")

    # Full bill text: present on AI seeds; digest items carry congress/type/number
    # so it can be fetched lazily. This is what lets the model always say something
    # substantive instead of "the summary is too thin".
    text = bill_item.get("textExcerpt")
    if text is None and _bill_api_path(bill_item):
        text = _bill_text_excerpt(bill_item)
    if text:
        lines.append(f"\nFULL BILL TEXT (excerpt, from congress.gov):\n{text}")
    elif not official:
        lines.append(
            "No official summary or published text yet -- work from the title, sponsor, "
            "committees, and your background knowledge of the subject."
        )
    return "\n".join(lines)


def generate_bill_impact(bill_item, *, force=False):
    """Plain-language AI impact analysis for a bill, cached 30 days. Prefers a
    committed snapshot (docs/data/bill-ai.json) so known bills never regenerate
    and work even with no AI provider. Returns {status, summary, ...} or None."""
    identifier = _bill_ai_identifier(bill_item)
    committed = None if force else _static_bill_ai_entry(bill_item, "impact")
    if committed:
        return {"status": "AI impact analysis", **committed}

    config = _ai_provider_config()
    if not config:
        return None

    context = _bill_ai_context(bill_item)
    input_hash = hashlib.sha256(context.encode("utf-8")).hexdigest()[:24]
    cache_key = _build_cache_key(
        "bill-impact-v5",
        {
            "id": identifier,
            "model": config["model"],
            "content_version": AI_BILL_CONTENT_VERSION,
            "input_hash": input_hash,
            "source_updated_at": bill_item.get("updatedAt") or bill_item.get("updateDate"),
        },
    )

    def fetch_json():
        user_prompt = (
            f"{context}\n\n"
            "In 2 COMPLETE sentences totalling STRICTLY 45 words or fewer (this is a hard "
            "limit -- count them), explain what this bill would do and specifically who or "
            "what it would affect if enacted -- name the actual groups, agencies, industries, "
            "states, or programs, drawing on the bill text above and what you know about this "
            "policy area. Every sentence must carry substance; no meta-commentary about sources "
            "or missing information. Finish every sentence; never end with '...' or a cut-off "
            "clause. If you approach the limit, stop at a complete sentence."
        )
        summary = _llm_chat(BILL_IMPACT_SYSTEM_PROMPT, user_prompt, max_tokens=260)
        return {
            "status": "AI impact analysis",
            "summary": summary,
            "model": config["model"],
            "provider": config["kind"],
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "content_version": AI_BILL_CONTENT_VERSION,
            "input_hash": input_hash,
        }

    result = _cached_json(
        cache_key,
        f"bill-impact:{identifier}",
        fetch_json,
        ttl_seconds=AI_IMPACT_TTL_SECONDS,
    )
    _write_ai_result("bill-impact", identifier, result, AI_IMPACT_TTL_SECONDS)
    return result


def generate_bill_description(bill_item, *, force=False):
    """Plain-language AI description of what a bill IS. Prefers a committed snapshot,
    then the AI provider. Returns {summary, ...} or None."""
    identifier = _bill_ai_identifier(bill_item)
    committed = None if force else _static_bill_ai_entry(bill_item, "description")
    if committed:
        return committed

    config = _ai_provider_config()
    if not config:
        return None

    context = _bill_ai_context(bill_item)
    input_hash = hashlib.sha256(context.encode("utf-8")).hexdigest()[:24]
    cache_key = _build_cache_key(
        "bill-description-v5",
        {
            "id": identifier,
            "model": config["model"],
            "content_version": AI_BILL_CONTENT_VERSION,
            "input_hash": input_hash,
            "source_updated_at": bill_item.get("updatedAt") or bill_item.get("updateDate"),
        },
    )

    def fetch_json():
        user_prompt = (
            f"{context}\n\n"
            "In 2 COMPLETE sentences totalling STRICTLY 50 words or fewer (this is a hard "
            "limit -- count them), describe what this bill is and the concrete change it "
            "proposes, then its scope (who/what it covers), working from the bill text above "
            "and your knowledge of this policy area. Every sentence must carry substance; no "
            "meta-commentary about sources or missing information. Finish every sentence; "
            "never end with '...' or a cut-off clause. If you approach the limit, stop at a "
            "complete sentence."
        )
        summary = _llm_chat(BILL_DESCRIPTION_SYSTEM_PROMPT, user_prompt, max_tokens=240)
        return {
            "summary": summary,
            "model": config["model"],
            "provider": config["kind"],
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "content_version": AI_BILL_CONTENT_VERSION,
            "input_hash": input_hash,
        }

    result = _cached_json(
        cache_key,
        f"bill-description:{identifier}",
        fetch_json,
        ttl_seconds=AI_DESCRIPTION_TTL_SECONDS,
    )
    _write_ai_result("bill-description", identifier, result, AI_DESCRIPTION_TTL_SECONDS)
    return result


# =========================================================================
# AI member overview: a short, nonpartisan "who is this legislator" synthesis
# (role, focus areas, tenure) served from COMMITTED snapshots
# (docs/data/member-ai/{id}.json). Public routes never call the model: misses
# are queued and drained by the same refresh worker as bill AI, and the
# snapshot script commits results so they survive restarts.
# =========================================================================

AI_MEMBER_CONTENT_VERSION = "member-ai-v1"
AI_MEMBER_OVERVIEW_TTL_SECONDS = 45 * 24 * 60 * 60
MEMBER_OVERVIEW_SYSTEM_PROMPT = (
    "You are a nonpartisan congressional biographer for a civic-information site. "
    "Given structured facts about a sitting member of Congress, write a compact overview "
    "a first-time visitor can absorb at a glance. Rules: (1) Work ONLY from the provided "
    "facts plus well-established public knowledge of this specific person; never invent "
    "votes, positions, or biography. (2) Lead with their role (chamber, state, party, "
    "tenure), then what they actually focus on legislatively (committees, bill subjects). "
    "(3) Strictly neutral: no praise, criticism, or electoral prediction. (4) Plain "
    "language, active voice, no honorifics beyond the first mention."
)


def _member_overview_seed(bioguide_id):
    """Cheap, cached facts that feed the overview prompt."""
    member = CongressMembersID(bioguide_id).get("member", {}) or {}
    seed = {
        "bioguideId": bioguide_id,
        "name": _member_display_name(member) or bioguide_id,
        "party": member.get("partyName") or _current_party_name(member),
        "state": member.get("state") or _latest_member_term(member).get("stateName"),
        "chamber": _member_chamber(member),
        "district": _district_label(member),
    }
    try:
        history = get_member_history(bioguide_id) or {}
        seed["yearsOfService"] = history.get("yearsOfService")
        seed["firstElectedYear"] = history.get("firstElectedYear")
    except Exception:  # noqa: BLE001 - each fact is best-effort
        pass
    try:
        committees = get_member_committees(bioguide_id) or {}
        names = [c.get("name") for c in committees.get("committees", []) if c.get("name")]
        seed["committees"] = names[:5]
    except Exception:  # noqa: BLE001
        pass
    try:
        legislation = get_member_legislation(bioguide_id, limit=10) or {}
        seed["sponsoredCount"] = legislation.get("sponsoredCount")
        areas = {}
        for item in legislation.get("sponsored", []) or []:
            area = item.get("policyArea")
            if area:
                areas[area] = areas.get(area, 0) + 1
        seed["topPolicyAreas"] = [a for a, _ in sorted(areas.items(), key=lambda kv: -kv[1])[:3]]
    except Exception:  # noqa: BLE001
        pass
    try:
        wiki = get_wiki_summary(bioguide_id) or {}
        if wiki.get("source") != "congress_fallback":
            seed["wikiTeaser"] = (wiki.get("summary") or "")[:400]
    except Exception:  # noqa: BLE001
        pass
    return seed


def _member_ai_context(seed):
    lines = [f"Member: {seed.get('name')}"]
    role_bits = [seed.get("chamber"), seed.get("party"), seed.get("state"), seed.get("district")]
    lines.append("Role: " + ", ".join(str(b) for b in role_bits if b))
    if seed.get("firstElectedYear"):
        lines.append(f"First elected: {seed['firstElectedYear']}")
    if seed.get("yearsOfService") is not None:
        lines.append(f"Years of service: {seed['yearsOfService']}")
    if seed.get("committees"):
        lines.append("Committees: " + "; ".join(seed["committees"]))
    if seed.get("sponsoredCount") is not None:
        lines.append(f"Bills sponsored: {seed['sponsoredCount']}")
    if seed.get("topPolicyAreas"):
        lines.append("Most-sponsored policy areas: " + ", ".join(seed["topPolicyAreas"]))
    if seed.get("wikiTeaser"):
        lines.append(f"Wikipedia teaser: {seed['wikiTeaser']}")
    return "\n".join(lines)


def _static_member_overview(bioguide_id):
    """Committed member overview snapshot, if present and non-empty."""
    payload = _read_json_file(STATIC_MEMBER_AI_DIR / f"{bioguide_id}.json", None)
    if isinstance(payload, dict) and (payload.get("overview") or {}).get("summary"):
        return {**payload["overview"], "source": "committed"}
    return None


def generate_member_overview(seed, *, force=False):
    """Model path for the member overview. Guarded by the AI generation scope --
    reachable only from refresh_member_ai / the refresh worker, never a request."""
    bioguide_id = seed.get("bioguideId")
    config = _ai_provider_config()
    if not config or not bioguide_id:
        return None

    context = _member_ai_context(seed)
    input_hash = hashlib.sha256(context.encode("utf-8")).hexdigest()[:24]
    cache_key = _build_cache_key(
        "member-overview-v1",
        {
            "id": bioguide_id,
            "model": config["model"],
            "content_version": AI_MEMBER_CONTENT_VERSION,
            "input_hash": input_hash,
        },
    )

    def fetch_json():
        user_prompt = (
            f"{context}\n\n"
            "In 2-3 COMPLETE sentences totalling STRICTLY 55 words or fewer (hard limit -- "
            "count them), write the overview: who this member is (chamber, state, party, "
            "tenure) and what they focus on legislatively. Every sentence must carry "
            "substance; no meta-commentary. Finish every sentence; never end with '...'. "
            "If you approach the limit, stop at a complete sentence."
        )
        summary = _llm_chat(MEMBER_OVERVIEW_SYSTEM_PROMPT, user_prompt, max_tokens=240)
        return {
            "summary": summary,
            "model": config["model"],
            "provider": config["kind"],
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "content_version": AI_MEMBER_CONTENT_VERSION,
            "input_hash": input_hash,
        }

    result = _cached_json(
        cache_key,
        f"member-overview:{bioguide_id}",
        fetch_json,
        ttl_seconds=AI_MEMBER_OVERVIEW_TTL_SECONDS,
    )
    _write_ai_result("member-overview", bioguide_id, result, AI_MEMBER_OVERVIEW_TTL_SECONDS)
    return result


def refresh_member_ai(bioguide_id, *, force=False):
    """Explicit model-writing path for member overviews (refresh worker / CI only)."""
    if not ai_insights_available():
        return {"available": False, "bioguideId": bioguide_id, "reason": "No AI provider is configured."}
    seed = _member_overview_seed(bioguide_id)
    try:
        overview = _run_in_ai_generation_scope(lambda: generate_member_overview(seed, force=force))
    except UpstreamDataError as exc:
        return {"available": False, "bioguideId": bioguide_id, "reason": str(exc)[:300]}
    return {
        "available": bool(overview and overview.get("summary")),
        "bioguideId": bioguide_id,
        "overview": overview,
        "seedName": seed.get("name"),
    }


def get_member_overview(bioguide_id):
    """Public read-only member overview: committed snapshot, then refresh cache,
    with a queued job on miss. NEVER calls the model."""
    committed = _static_member_overview(bioguide_id)
    if committed:
        return {"available": True, "pending": False, "overview": committed}
    cached = _read_ai_result(
        "member-overview", bioguide_id, queue_payload={"bioguide_id": bioguide_id}
    )
    if cached and cached.get("summary"):
        return {
            "available": True,
            "pending": False,
            "overview": {**cached, "source": cached.get("source") or "refresh_cache"},
        }
    return {"available": False, "pending": ai_insights_available(), "overview": None}


def get_event_confidence(topic, context=None):
    """Return an honest no-poll response instead of inventing a percentage."""
    topic = (topic or "").strip()
    if not topic:
        raise UpstreamDataError("A topic is required for event confidence.")
    return {
        "available": False,
        "source": "deterministic",
        "subject": topic,
        "reason": "No sourced polling estimate is available for this subject.",
        "note": (
            "YGN does not generate public-opinion percentages without a named pollster, "
            "field dates, sample, and methodology."
        ),
    }


def get_candidate_confidence(bioguide_id):
    """Return an honest no-poll response for a member of Congress."""
    bioguide_id = (bioguide_id or "").strip()
    if not bioguide_id:
        raise UpstreamDataError("A bioguideId is required for candidate confidence.")
    return {
        "available": False,
        "source": "deterministic",
        "bioguideId": bioguide_id,
        "reason": "No sourced approval or favorability poll is available for this member.",
        "note": (
            "YGN will not substitute an AI estimate for a scientific poll with published "
            "field dates, sample, and methodology."
        ),
    }


def _ai_refresh_limit():
    try:
        return max(0, min(40, int(os.getenv("YGN_AI_REFRESH_LIMIT", "12"))))
    except ValueError:
        return 12


def _enqueue_committed_digest_ai_jobs():
    """Queue bill-AI generation for every bill in the committed recent-bills
    digest whose committed AI is missing or stale.

    The live digest only warms the top few bills each cycle, so bills deeper in
    the 40-bill feed never reached the model on their own — CI can't generate
    them (no AI key there) and page views only queued whatever was on screen.
    This reads the committed snapshot (no upstream calls) and enqueues the gaps
    so the background drain fills the whole digest, which the CI harvest then
    commits. Idempotent: _queue_ai_refresh_job is insert-if-missing and bills
    that already have complete, current committed AI are skipped.
    """
    digest = _read_json_file_cached(STATIC_RECENT_DIGEST_PATH, {})
    bills = digest.get("bills") if isinstance(digest, dict) else None
    if not isinstance(bills, list):
        return {"scanned": 0, "queued": 0}
    scanned = 0
    queued = 0
    for bill in bills:
        if not isinstance(bill, dict):
            continue
        scanned += 1
        record, _legacy = _static_bill_ai_record(bill)
        record = record if isinstance(record, dict) else {}
        has_desc = bool((record.get("description") or {}).get("summary"))
        has_impact = bool((record.get("impact") or {}).get("summary"))
        if has_desc and has_impact and _bill_ai_entry_is_current(record, bill):
            continue
        payload = _bill_ai_job_payload(bill)
        if payload and _queue_ai_refresh_job(
            "bill", _bill_ai_identifier(bill), payload
        ):
            queued += 1
    return {"scanned": scanned, "queued": queued}


def refresh_ai_generation_cache(limit=None):
    """Drain bounded bill-AI jobs during an explicit/background cache refresh.

    Public read routes only enqueue canonical bills. This is the sole runtime
    path that is allowed to turn those misses into provider calls.
    """
    requested_limit = _ai_refresh_limit() if limit is None else max(0, min(40, int(limit)))
    report = {
        "enabled": ai_insights_available(),
        "limit": requested_limit,
        "processed": 0,
        "completed": 0,
        "partial": 0,
        "errors": [],
    }
    if not report["enabled"] or requested_limit == 0:
        return report
    if not _ai_refresh_lock.acquire(blocking=False):
        report["already_running"] = True
        return report

    try:
        for job_key, job in _pending_ai_refresh_jobs(requested_limit):
            report["processed"] += 1
            try:
                kind = job.get("kind")
                payload = job.get("payload") or {}
                if kind == "bill":
                    result = refresh_bill_ai(
                        payload.get("congress"),
                        payload.get("bill_type"),
                        payload.get("number"),
                        force=True,
                    )
                    fields = [key for key in ("aiDescription", "impact") if result.get(key)]
                    if len(fields) == 2:
                        _delete_cache_entry(job_key)
                        report["completed"] += 1
                    elif fields:
                        report["partial"] += 1
                        _record_ai_job_failure(
                            job_key, job, "Only one bill AI field completed; retrying the missing field."
                        )
                    else:
                        raise UpstreamDataError("No bill AI fields were generated.")
                elif kind in ("member", "member-overview"):
                    result = refresh_member_ai(
                        payload.get("bioguide_id") or job.get("cache_id"), force=True
                    )
                    if result.get("available"):
                        _delete_cache_entry(job_key)
                        report["completed"] += 1
                    else:
                        raise UpstreamDataError(
                            result.get("reason") or "Member overview was not generated."
                        )
                elif kind == "foreign-brief":
                    # refresh_foreign_brief self-limits to one model call per
                    # FOREIGN_BRIEF_TTL_SECONDS (12h), so draining this job often
                    # is cheap; it only regenerates once the window has elapsed.
                    result = refresh_foreign_brief()
                    if _foreign_brief_is_fresh(result):
                        _delete_cache_entry(job_key)
                        report["completed"] += 1
                    else:
                        raise UpstreamDataError("Foreign brief was not generated.")
                else:
                    raise ValueError("Unsupported AI refresh job kind.")
            except Exception as exc:  # noqa: BLE001 - preserve queue for retry
                _record_ai_job_failure(job_key, job, exc)
                report["errors"].append(
                    {
                        "kind": job.get("kind"),
                        "cache_id": job.get("cache_id"),
                        "error": str(exc)[:300],
                    }
                )
    finally:
        _ai_refresh_lock.release()
    return report


# --- Foreign-affairs AI brief (regenerated at most once every 12 hours) --------

AI_FOREIGN_CONTENT_VERSION = "foreign-ai-v1"
# The foreign page asks for a refresh "once every 12 hours". This is the single
# source of truth for that cadence: the background loop runs far more often, but
# refresh_foreign_brief() is a no-op until the committed/cached brief is older
# than this, so the model is called at most twice a day.
FOREIGN_BRIEF_TTL_SECONDS = 12 * 60 * 60
FOREIGN_BRIEF_MAX_TOKENS = 4000

FOREIGN_BRIEF_SYSTEM_PROMPT = (
    "You are a nonpartisan foreign-affairs desk editor writing for an American civic "
    "dashboard. You explain what is happening in the world and what leverage Congress "
    "and the executive branch actually have.\n"
    "Rules:\n"
    "- Reply with STRICT JSON only. No prose, no markdown, no code fences.\n"
    "- Be factual and neutral. Never invent statistics, poll numbers, casualty figures, "
    "vote counts, or dates. If you do not know a number, describe the situation in words.\n"
    "- Ground every item in the supplied source material and well-established public "
    "knowledge. Do not speculate about future events as if they had happened.\n"
    "- Write complete sentences. No ellipses, no trailing fragments.\n"
)

FOREIGN_BRIEF_SCHEMA_HINT = (
    '{"conflicts":[{"title":"short name of the conflict or flashpoint",'
    '"region":"Europe|Middle East|Africa|Asia|Americas|Global",'
    '"status":"2-3 word status label, e.g. Active war",'
    '"tone":"danger|caution|steady",'
    '"summary":"2-3 sentences on what is happening and why it matters to the US",'
    '"usLever":"the concrete US levers, <=12 words",'
    '"publicRead":"one sentence on where American opinion sits, qualitative only"}],'
    '"diplomacy":[{"title":"short headline","detail":"1-2 sentences","tone":"steady|caution"}],'
    '"outlook":"3-4 sentences on what to watch next"}'
)


def _parse_iso_datetime(value):
    """Parse an ISO-8601 timestamp into an aware UTC datetime, or None.

    Accepts the trailing "Z" form that the committed snapshots use.
    """
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _static_foreign_brief():
    """The committed AI foreign brief, or None."""
    payload = _read_json_file_cached(STATIC_FOREIGN_BRIEF_PATH, None)
    return payload if isinstance(payload, dict) else None


def _civic_snapshot(name):
    payload = _read_json_file_cached(STATIC_CIVIC_DIR / name, None)
    return payload if isinstance(payload, dict) else {}


def _parse_ai_json(reply):
    """Parse a model reply that should be JSON, tolerating code fences/prose."""
    text = str(reply or "").strip()
    if not text:
        return None
    if text.startswith("```"):
        # drop the opening fence (optionally ```json) and any trailing fence
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


FOREIGN_KEYWORD_RE = re.compile(
    r"\b(nato|ukraine|russia|china|taiwan|israel|gaza|iran|treaty|sanction|foreign|"
    r"defense|military|diplomat|embassy|refugee|war|troops|weapons|arms|tariff|export)\b",
    re.I,
)
FOREIGN_POLICY_AREA_NAMES = {
    "International Affairs",
    "Armed Forces and National Security",
    "Foreign Trade and International Finance",
    "Immigration",
    "Intelligence and National Security",
}


def _foreign_brief_material():
    """Real, sourced material for the model: committed civic snapshots + the
    foreign-policy slice of the recent-bills digest. No upstream calls."""
    lines = []

    treaties = (_civic_snapshot("treaties.json").get("treaties") or [])[:8]
    if treaties:
        lines.append("Senate treaty queue (Congress.gov):")
        for item in treaties:
            lines.append(
                f"- {item.get('topic') or 'Treaty'}"
                + (f" (Treaty {item.get('number')})" if item.get("number") else "")
                + (f", countries: {item.get('countriesText')}" if item.get("countriesText") else "")
            )

    orders = (_civic_snapshot("executive-orders.json").get("orders") or [])[:8]
    if orders:
        lines.append("\nRecent executive orders (Federal Register):")
        for item in orders:
            lines.append(f"- EO {item.get('number') or '?'}: {item.get('title') or 'Untitled'}")

    nominations = (_civic_snapshot("nominations.json").get("nominations") or [])[:6]
    if nominations:
        lines.append("\nPending nominations:")
        for item in nominations:
            lines.append(
                f"- {item.get('description') or item.get('organization') or 'Nomination'}"
            )

    digest = _read_json_file_cached(STATIC_RECENT_DIGEST_PATH, {})
    bills = digest.get("bills") if isinstance(digest, dict) else None
    foreign_bills = []
    for bill in bills or []:
        if not isinstance(bill, dict):
            continue
        title = str(bill.get("title") or "")
        if (
            bill.get("policyArea") in FOREIGN_POLICY_AREA_NAMES
            or FOREIGN_KEYWORD_RE.search(title)
        ):
            foreign_bills.append(bill)
    if foreign_bills:
        lines.append("\nForeign-policy bills moving in Congress:")
        for bill in foreign_bills[:12]:
            action = (bill.get("latestAction") or {}).get("text") or ""
            lines.append(
                f"- {bill.get('identifier')}: {str(bill.get('title'))[:160]}"
                + (f" | latest action: {action[:110]}" if action else "")
            )

    return "\n".join(lines).strip()


def _foreign_brief_age_seconds(payload):
    if not isinstance(payload, dict):
        return None
    stamp = payload.get("generated_at")
    parsed = _parse_iso_datetime(stamp) if stamp else None
    if parsed is None:
        return None
    return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds())


def _foreign_brief_is_fresh(payload):
    """True when a brief exists, matches the current content version, and is
    younger than the 12-hour refresh window."""
    if not isinstance(payload, dict) or not payload.get("conflicts"):
        return False
    if payload.get("content_version") != AI_FOREIGN_CONTENT_VERSION:
        return False
    age = _foreign_brief_age_seconds(payload)
    return age is not None and age < FOREIGN_BRIEF_TTL_SECONDS


def _normalize_foreign_brief(parsed, material):
    """Coerce the model's JSON into the exact shape the frontend renders."""
    tones = {"danger", "caution", "steady"}

    def clean(value, limit):
        return _strip_markup(value)[:limit] if value else ""

    conflicts = []
    for item in (parsed.get("conflicts") or [])[:8]:
        if not isinstance(item, dict):
            continue
        title = clean(item.get("title"), 80)
        summary = clean(item.get("summary"), 420)
        if not title or not summary:
            continue
        tone = str(item.get("tone") or "").lower()
        conflicts.append(
            {
                "title": title,
                "region": clean(item.get("region"), 40) or "Global",
                "status": clean(item.get("status"), 40) or "Watch",
                "tone": tone if tone in tones else "caution",
                "summary": summary,
                "usLever": clean(item.get("usLever"), 120),
                "publicRead": clean(item.get("publicRead"), 200),
            }
        )

    diplomacy = []
    for item in (parsed.get("diplomacy") or [])[:6]:
        if not isinstance(item, dict):
            continue
        title = clean(item.get("title"), 90)
        detail = clean(item.get("detail"), 320)
        if not title or not detail:
            continue
        tone = str(item.get("tone") or "").lower()
        diplomacy.append(
            {
                "title": title,
                "detail": detail,
                "tone": tone if tone in tones else "steady",
            }
        )

    if not conflicts:
        return None
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "content_version": AI_FOREIGN_CONTENT_VERSION,
        "source": "ai",
        "model": (_ai_provider_config() or {}).get("model"),
        "refresh_interval_seconds": FOREIGN_BRIEF_TTL_SECONDS,
        "input_hash": hashlib.sha256(
            f"{AI_FOREIGN_CONTENT_VERSION}|{material}".encode("utf-8")
        ).hexdigest()[:24],
        "conflicts": conflicts,
        "diplomacy": diplomacy,
        "outlook": clean(parsed.get("outlook"), 700),
    }


def refresh_foreign_brief(force=False):
    """The ONLY path allowed to generate the foreign brief with the model.

    Honors the 12-hour window: if a committed or cached brief is still fresh this
    returns it untouched without spending a model call, so the every-15-minute
    background refresh cannot turn into 96 generations a day.
    """
    cache_key = _build_cache_key("foreign-brief-v1", {"v": AI_FOREIGN_CONTENT_VERSION})

    cached = _read_cache(cache_key, allow_stale=True)
    committed = _static_foreign_brief()
    # Prefer whichever existing brief is newer.
    existing = cached
    if committed and (
        not existing
        or (_foreign_brief_age_seconds(committed) or 1e9)
        < (_foreign_brief_age_seconds(existing) or 1e9)
    ):
        existing = committed

    if not force and _foreign_brief_is_fresh(existing):
        return existing

    if not ai_insights_available():
        return existing

    material = _foreign_brief_material()
    if not material:
        return existing

    user_prompt = (
        "Source material from official U.S. government feeds:\n\n"
        f"{material}\n\n"
        "Using this material plus well-established public knowledge, write the current "
        "foreign-affairs brief. Cover the 4-6 most consequential conflicts or flashpoints "
        "for the United States right now, then 3-4 diplomacy items, then the outlook.\n"
        "Reply with JSON matching exactly this shape:\n"
        f"{FOREIGN_BRIEF_SCHEMA_HINT}"
    )

    try:
        with _allow_ai_generation():
            reply = _llm_chat(
                FOREIGN_BRIEF_SYSTEM_PROMPT,
                user_prompt,
                max_tokens=FOREIGN_BRIEF_MAX_TOKENS,
            )
    except UpstreamDataError:
        LOGGER.warning("Foreign brief generation failed.", exc_info=True)
        return existing

    parsed = _parse_ai_json(reply)
    if not parsed:
        LOGGER.warning("Foreign brief reply was not parseable JSON.")
        return existing

    payload = _normalize_foreign_brief(parsed, material)
    if not payload:
        return existing

    _write_cache(cache_key, payload, "foreign-brief", ttl_seconds=FOREIGN_BRIEF_TTL_SECONDS * 4)
    return payload


def get_foreign_brief():
    """Read-only accessor used by the public route. Never calls the model.

    Serves the freshest of (refresh cache, committed snapshot) and queues a
    regeneration when the brief is missing or older than the 12-hour window.
    """
    cache_key = _build_cache_key("foreign-brief-v1", {"v": AI_FOREIGN_CONTENT_VERSION})
    cached = _read_cache(cache_key, allow_stale=True)
    committed = _static_foreign_brief()

    best = cached
    if committed and (
        not best
        or (_foreign_brief_age_seconds(committed) or 1e9)
        < (_foreign_brief_age_seconds(best) or 1e9)
    ):
        best = committed

    fresh = _foreign_brief_is_fresh(best)
    if not fresh:
        _queue_ai_refresh_job("foreign-brief", AI_FOREIGN_CONTENT_VERSION, {})

    if not best:
        return {
            "available": False,
            "ai_mode": "cache_refresh_only",
            "refresh_interval_seconds": FOREIGN_BRIEF_TTL_SECONDS,
            "reason": (
                "The foreign-affairs brief is queued and will appear after the next "
                "content refresh."
            ),
            "conflicts": [],
            "diplomacy": [],
        }

    age = _foreign_brief_age_seconds(best)
    return {
        **best,
        "available": True,
        "ai_mode": "cache_refresh_only",
        "stale": not fresh,
        "age_seconds": int(age) if age is not None else None,
        "next_refresh_seconds": (
            max(0, int(FOREIGN_BRIEF_TTL_SECONDS - age)) if age is not None else 0
        ),
    }


def getRecentBillDigest(limit=5):
    limit = max(1, min(int(limit), 40))
    cache_key = _build_cache_key(
        "recent-bill-digest-v3",
        {
            "limit": limit,
        },
    )

    def fetch_json():
        bills = _recent_bill_list(getRecentBills())[:limit]
        # Each digest item makes several sequential Congress.gov calls (detail,
        # summaries, cosponsors); build them concurrently so a 12-40 bill digest
        # doesn't serialize into a 30s+ cold load. Order is preserved by index.
        items = [None] * len(bills)
        if bills:
            workers = min(8, len(bills))
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = {pool.submit(_bill_digest_item, bill): idx for idx, bill in enumerate(bills)}
                for future in as_completed(futures):
                    idx = futures[future]
                    try:
                        items[idx] = future.result()
                    except Exception as exc:  # noqa: BLE001
                        LOGGER.warning("Bill digest item failed: %s", exc)
            items = [item for item in items if item]
        # Apply committed/refresh-cached content for free. Missing artifacts are
        # queued, but this public read path never calls the model.
        cached_applied = 0
        queued = 0
        for item in items:
            cached = _cached_bill_ai_entry(item, "impact", queue_if_missing=True)
            if cached:
                item["impact"] = {
                    **item["impact"], "status": "AI impact analysis",
                    "summary": cached["summary"],
                    "generated_at": cached.get("generated_at"),
                }
                cached_applied += 1
            else:
                queued += 1
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "congress_api",
            "cache_ttl_seconds": _cache_ttl_seconds(),
            "impact_status": "cached" if cached_applied else "queued_for_refresh",
            "ai_mode": "cache_refresh_only",
            "ai_cached": cached_applied,
            "ai_queued": queued,
            "bills": items,
        }

    return _cached_json(
        cache_key,
        f"congress:recent-bill-digest:{limit}",
        fetch_json,
        ttl_seconds=_cache_ttl_seconds(),
    )


def allCongressMembers():
    return listCongressMembers(limit=20, offset=0)


def CongressMembersID(bioGuideID):
    data = _congress_get(
        f"/member/{bioGuideID}",
        params={
            "limit": 20,
            "bioguideId": bioGuideID,
            "format": "json",
        },
    )
    return _apply_member_enrichment_to_payload(data)


def _member_terms(member):
    terms = member.get("terms", {}).get("item", [])
    if isinstance(terms, dict):
        return [terms]
    return terms or []


def _optional_float(value):
    if value in (None, ""):
        return None
    return float(value)


def _safe_amount(value):
    if value in (None, ""):
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


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


def _read_json_file(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


_json_file_memo = {}
_json_file_memo_lock = threading.Lock()


def _read_json_file_cached(path, default):
    """Memoized (by mtime) read for small config files that sit on hot paths —
    member enrichment reads the overrides file once per member on every list call.
    Callers must treat the returned value as read-only."""
    path = Path(path)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return default
    key = str(path)
    entry = _json_file_memo.get(key)
    if entry is not None and entry[0] == mtime:
        return entry[1]
    with _json_file_memo_lock:
        entry = _json_file_memo.get(key)
        if entry is not None and entry[0] == mtime:
            return entry[1]
        value = _read_json_file(path, default)
        _json_file_memo[key] = (mtime, value)
        return value


def _static_member_overrides():
    return _read_json_file_cached(STATIC_MEMBER_OVERRIDES_PATH, {})


def _static_member_override(bioguide_id):
    overrides = _static_member_overrides().get("members", {})
    return overrides.get(bioguide_id) or {}


def _static_wiki_override(bioguide_id):
    inline_overrides = _static_member_overrides().get("wiki", {})
    if bioguide_id in inline_overrides:
        return inline_overrides[bioguide_id]

    wiki_path = STATIC_WIKI_DIR / f"{bioguide_id}.json"
    payload = _read_json_file(wiki_path, None)
    if not payload:
        return None

    summary = payload.get("summary") or payload.get("extract")
    if not summary:
        return None

    return payload


def _deep_merge_dict(base, updates):
    merged = dict(base or {})
    for key, value in (updates or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge_dict(merged[key], value)
        else:
            merged[key] = value
    return merged


def _term_items_from_member(member):
    terms = member.get("terms", [])
    if isinstance(terms, dict):
        terms = terms.get("item", [])
    if isinstance(terms, dict):
        return [terms]
    return terms or []


def _member_chamber(member):
    chamber = member.get("chamber")
    if chamber:
        return chamber

    term = _latest_member_term(member)
    return term.get("chamber")


def _member_district(member):
    if member.get("district") not in (None, ""):
        return member.get("district")

    term = _latest_member_term(member)
    return term.get("district")


def _district_label(member):
    chamber = str(_member_chamber(member) or "").lower()
    district = _member_district(member)

    if "senate" in chamber:
        return "Statewide"
    if district in (None, ""):
        return None
    if str(district) == "0":
        return "At-large"
    return f"District {district}"


def _apply_member_enrichment(member):
    if not isinstance(member, dict):
        return member

    bioguide_id = _member_bioguide_id(member)
    enriched = dict(member)
    term = _latest_member_term(enriched)

    if "chamber" not in enriched or not enriched.get("chamber"):
        chamber = term.get("chamber")
        if chamber:
            enriched["chamber"] = chamber

    label = _district_label(enriched)
    if label:
        enriched["districtLabel"] = label

    if bioguide_id:
        override = _static_member_override(bioguide_id)
        if override:
            enriched = _deep_merge_dict(enriched, override)

    return enriched


def _apply_member_enrichment_to_payload(payload):
    if not isinstance(payload, dict):
        return payload

    enriched = dict(payload)
    if isinstance(enriched.get("members"), list):
        enriched["members"] = [_apply_member_enrichment(member) for member in enriched["members"]]
    if isinstance(enriched.get("member"), dict):
        enriched["member"] = _apply_member_enrichment(enriched["member"])
    return enriched


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


def _first_sentences(text, sentence_count=2):
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    if not normalized:
        return normalized

    abbreviations = {
        "mr.",
        "mrs.",
        "ms.",
        "dr.",
        "jr.",
        "sr.",
        "sen.",
        "rep.",
        "gov.",
        "u.s.",
        "d.c.",
    }
    sentences = []
    start = 0
    index = 0
    while index < len(normalized):
        char = normalized[index]
        if char not in ".!?":
            index += 1
            continue

        token_start = normalized.rfind(" ", 0, index) + 1
        token = normalized[token_start : index + 1].lower()
        if token in abbreviations or re.fullmatch(r"(?:[a-z]\.){1,4}", token):
            index += 1
            continue

        next_index = index + 1
        while next_index < len(normalized) and normalized[next_index] in "\"')]}":
            next_index += 1
        if next_index < len(normalized) and not normalized[next_index].isspace():
            index += 1
            continue

        sentence = normalized[start : next_index].strip()
        if sentence:
            sentences.append(sentence)
        if len(sentences) >= sentence_count:
            return " ".join(sentences)

        while next_index < len(normalized) and normalized[next_index].isspace():
            next_index += 1
        start = next_index
        index = next_index

    if not sentences:
        return normalized

    trailing = normalized[start:].strip()
    if trailing and len(sentences) < sentence_count:
        sentences.append(trailing)
    return " ".join(sentences[:sentence_count])


def _build_congress_member_summary(member):
    name = _member_display_name(member)
    term = _latest_member_term(member)
    party = _current_party_name(member)
    state = member.get("state") or term.get("stateName")
    district = _member_district(member)
    district_label = _district_label(member)
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
    if state and district_label == "Statewide":
        location = f" from {state}"
    elif state and district_label == "At-large":
        location = f" from {state}'s at-large district"
    elif state and district not in (None, ""):
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
    raw_value = os.getenv("YGN_WIKI_SEARCH_QUERY_LIMIT", "8")
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
    extract = _first_sentences(data.get("extract"))
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
    state_name = term.get("stateName") or state
    district = _member_district(member)
    member_type = term.get("memberType") or "member of Congress"
    queries = []

    for name in _member_name_candidates(member):
        if state:
            queries.append(f'"{name}" "{state}" politician')
        if state_name and state_name != state:
            queries.append(f'"{name}" "{state_name}" politician')
        if state_name and district not in (None, ""):
            queries.append(f'"{name}" "{state_name}" "{district}"')
        queries.extend(
            [
                f'"{name}" "{member_type}"',
                f'"{name}" "United States Congress"',
                f'"{name}" "U.S. representative"',
                f'"{name}" "United States senator"',
                f'"{name}" politician',
            ]
        )

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
        except requests.RequestException:
            return _build_congress_member_summary(member)

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
        except requests.RequestException:
            return _build_congress_member_summary(member)

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
            except requests.RequestException:
                return _build_congress_member_summary(member)

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


_nominate_index = None
_nominate_index_mtime = None
_nominate_index_lock = threading.Lock()


def _load_nominate_index():
    """Build a {bioguide_id -> latest-congress row} index once, rebuilt on file change.

    The NOMINATE CSV is 6+ MB / 50k+ rows; scanning it per call (once per member
    in static generation and inside every cold dossier) is the single largest
    avoidable cost. Index once and look up O(1).
    """
    global _nominate_index, _nominate_index_mtime
    if not CSV_PATH.exists():
        raise FileNotFoundError(
            f"Missing NOMINATE CSV at {CSV_PATH}. Add HSall_members.csv next to "
            "CongressMembers.py before calling get_nominate_score."
        )

    mtime = CSV_PATH.stat().st_mtime
    if _nominate_index is not None and _nominate_index_mtime == mtime:
        return _nominate_index

    with _nominate_index_lock:
        if _nominate_index is not None and _nominate_index_mtime == mtime:
            return _nominate_index
        index = {}
        with open(CSV_PATH, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                bioguide_id = row.get("bioguide_id")
                if not bioguide_id:
                    continue
                try:
                    congress = int(row["congress"])
                except (TypeError, ValueError, KeyError):
                    continue
                existing = index.get(bioguide_id)
                if existing is None or congress > existing["congress"]:
                    index[bioguide_id] = {
                        "congress": congress,
                        "nominate_dim1": row.get("nominate_dim1"),
                        "nominate_geo_mean_probability": row.get(
                            "nominate_geo_mean_probability"
                        ),
                    }
        _nominate_index = index
        _nominate_index_mtime = mtime
        return index


def get_nominate_score(bioguide_id: str):
    """
    Returns a member's most recent NOMINATE dim1 score and geo mean probability.

    Returns {"dim1": float, "geo_mean": float} or None if not found.
    """
    best_row = _load_nominate_index().get(bioguide_id)
    if best_row is None or not best_row["nominate_dim1"]:
        return None

    return {
        "dim1": float(best_row["nominate_dim1"]),
        "geo_mean": _optional_float(best_row["nominate_geo_mean_probability"]),
    }


def _current_election_cycle(now=None):
    now = now or datetime.now(timezone.utc)
    return now.year if now.year % 2 == 0 else now.year + 1


def _ethics_updated_at():
    return datetime.now(timezone.utc).isoformat()


def _party_abbreviation(member):
    party = (
        member.get("party")
        or member.get("partyName")
        or _current_party_name(member)
        or ""
    )
    party_lower = party.lower()
    if party_lower.startswith("democrat") or party_lower == "d":
        return "DEM"
    if party_lower.startswith("republican") or party_lower == "r":
        return "REP"
    if party_lower.startswith("independent") or party_lower == "i":
        return "IND"
    return party[:3].upper() if party else None


def _member_fec_office(member):
    chamber = str(_member_chamber(member) or "").lower()
    if "senate" in chamber:
        return "S"
    if "house" in chamber or "representative" in chamber:
        return "H"
    return None


def _member_state_code(member):
    """Two-letter USPS state code, converting from a full state name if needed."""
    raw = (
        member.get("stateCode")
        or member.get("state")
        or _latest_member_term(member).get("stateCode")
        or _latest_member_term(member).get("stateName")
        or ""
    )
    raw = str(raw).strip()
    if len(raw) == 2:
        return raw.upper()
    return STATE_NAME_TO_USPS.get(raw.lower())


def _normalize_name_for_match(value):
    value = re.sub(r"[^a-z0-9, ]+", " ", str(value or "").lower())
    if "," in value:
        last, first = value.split(",", 1)
        value = f"{first} {last}"
    return re.sub(r"\s+", " ", value).strip()


def _name_tokens(value):
    suffixes = {"jr", "sr", "ii", "iii", "iv", "v"}
    return {
        token
        for token in _normalize_name_for_match(value).split()
        if len(token) > 1 and token not in suffixes
    }


def _fec_candidate_match_score(candidate, member):
    score = 0
    candidate_name_tokens = _name_tokens(candidate.get("name"))
    member_name_tokens = set()
    for name in _member_name_candidates(member):
        member_name_tokens.update(_name_tokens(name))

    if member_name_tokens and candidate_name_tokens:
        overlap = len(member_name_tokens & candidate_name_tokens)
        score += overlap * 3
        if overlap == len(member_name_tokens):
            score += 4

    if candidate.get("state") == _member_state_code(member):
        score += 4
    if candidate.get("office") == _member_fec_office(member):
        score += 4

    member_district = _member_district(member)
    candidate_district = candidate.get("district")
    if member_district not in (None, "") and candidate_district not in (None, ""):
        if str(member_district).zfill(2) == str(candidate_district).zfill(2):
            score += 3

    party = _party_abbreviation(member)
    if party and candidate.get("party") == party:
        score += 1

    return score


def _fec_search_candidates(member):
    names = _member_name_candidates(member)
    if not names:
        return []

    state = _member_state_code(member)
    office = _member_fec_office(member)

    def run_search(query, require_raised_funds):
        params = {"q": query, "per_page": 20}
        if require_raised_funds:
            params["has_raised_funds"] = "true"
        if state:
            params["state"] = state
        if office:
            params["office"] = office
        # Party is intentionally NOT a hard filter: FEC's party codes don't always
        # match ours (independents, minor parties, caucus mismatches), which would
        # drop a real candidate to zero results. It stays a +1 signal in scoring.
        data = _fec_get(
            "/candidates/search/", params=params, ttl_seconds=FEC_LIVE_CACHE_TTL_SECONDS
        )
        return data.get("results") or []

    # Progressive fallback, widened only when a search comes back empty.
    # Previously this tried names[0] ONCE with has_raised_funds=true, so a member
    # whose FEC record doesn't carry that flag (typical for newly-elected members)
    # or whose primary name form doesn't hit FEC's index was silently ungradeable
    # forever. Attempt 1 is the historical query, so members that already match
    # keep their existing (cached) result and nothing regresses.
    attempts = [(names[0], True), (names[0], False)]
    if len(names) > 1:
        attempts.append((names[1], False))

    for query, require_raised_funds in attempts:
        candidates = run_search(query, require_raised_funds)
        if candidates:
            return sorted(
                candidates,
                key=lambda candidate: _fec_candidate_match_score(candidate, member),
                reverse=True,
            )
    return []


def _fec_best_candidate(member):
    candidates = _fec_search_candidates(member)
    if not candidates:
        return None

    best = candidates[0]
    if _fec_candidate_match_score(best, member) < 7:
        return None
    return best


def _effective_totals_cycle(row):
    """Resolve a usable 2-year cycle for a totals record. Old FEC records can have
    a null `cycle`, so fall back to coverage/report year fields, rounding up to the
    next even (election) year. Returns None only if nothing is derivable."""
    cycle = row.get("cycle")
    try:
        if cycle not in (None, ""):
            return int(cycle)
    except (TypeError, ValueError):
        pass

    for key in ("last_report_year", "candidate_election_year"):
        value = row.get(key)
        try:
            if value not in (None, ""):
                year = int(value)
                return year if year % 2 == 0 else year + 1
        except (TypeError, ValueError):
            continue

    for key in ("coverage_end_date", "coverage_start_date"):
        value = row.get(key)
        if value:
            try:
                year = int(str(value)[:4])
                return year if year % 2 == 0 else year + 1
            except (TypeError, ValueError):
                continue
    return None


def _latest_candidate_total(candidate_id):
    data = _fec_get(
        f"/candidate/{candidate_id}/totals/",
        params={
            "per_page": 20,
            "sort": "-cycle",
        },
        ttl_seconds=FEC_LIVE_CACHE_TTL_SECONDS,
    )
    totals = data.get("results", [])
    if not totals:
        return None

    current_cycle = _current_election_cycle()
    # Attach a resolved cycle to each row (some historical rows have cycle=None),
    # then pick the most RECENT cycle within range that actually has money -- an
    # ancient empty record must not shadow a real recent one.
    annotated = []
    for row in totals:
        eff = _effective_totals_cycle(row)
        if eff is None or eff > current_cycle:
            continue
        annotated.append((eff, _safe_amount(row.get("receipts")), row))

    if not annotated:
        return totals[0]

    funded = [item for item in annotated if item[1] > 0]
    pool = funded or annotated
    eff_cycle, _receipts, best = max(pool, key=lambda item: item[0])
    # Ensure downstream by_size / by_state calls get a valid cycle.
    best = {**best, "cycle": best.get("cycle") or eff_cycle}
    return best


def _fec_candidate_rows(path, candidate_id, cycle):
    if cycle in (None, ""):
        return []
    data = _fec_get(
        path,
        params={
            "candidate_id": candidate_id,
            "cycle": cycle,
            "per_page": 100,
        },
        ttl_seconds=FEC_LIVE_CACHE_TTL_SECONDS,
    )
    return data.get("results", [])


def _ratio(numerator, denominator):
    numerator = _safe_amount(numerator)
    denominator = _safe_amount(denominator)
    if denominator <= 0:
        return None
    return max(0.0, min(1.0, numerator / denominator))


def _component(value, score, weight):
    if value is None or score is None:
        return {
            "value": None,
            "score": None,
            "weight": weight,
        }

    return {
        "value": round(value, 4),
        "score": round(max(0.0, min(100.0, score)), 1),
        "weight": weight,
    }


def _ethics_letter_grade(score):
    if score is None:
        return "N/A"
    if score >= 93:
        return "A"
    if score >= 90:
        return "A-"
    if score >= 87:
        return "B+"
    if score >= 83:
        return "B"
    if score >= 80:
        return "B-"
    if score >= 77:
        return "C+"
    if score >= 73:
        return "C"
    if score >= 70:
        return "C-"
    if score >= 67:
        return "D+"
    if score >= 63:
        return "D"
    if score >= 60:
        return "D-"
    return "F"


def _ethics_bench(value, lo, mid, hi):
    """Map a raw 0-1 campaign-finance ratio onto a 0-100 sub-score against real
    FEC benchmarks: `lo` (poor) -> 45, `mid` (typical member) -> 75, `hi`
    (strong) -> 95, clamped to [25, 100]. This is the calibration the old
    `share * 100` mapping lacked: a typical ~15% small-donor share used to score
    15/100 and crater every grade into the C/D band regardless of merit; now the
    median member lands near B- and grades actually spread across A-F.
    """
    if value is None:
        return None
    value = max(0.0, float(value))
    if value <= lo:
        frac = value / lo if lo > 0 else 0.0
        return round(35 + 23 * max(0.0, min(1.0, frac)), 1)
    if value <= mid:
        return round(58 + 24 * (value - lo) / (mid - lo), 1)
    if value <= hi:
        return round(82 + 14 * (value - mid) / (hi - mid), 1)
    span = max(hi, 1e-9)
    return round(min(100.0, 96 + 4 * (value - hi) / span), 1)


def _score_ethics_from_fec(member, candidate, totals, by_size, by_state):
    """Grade a member's *campaign-finance independence* from FEC totals.

    This is a funding-transparency measure (small-donor reliance, PAC/self/party
    independence, donor diversity, local support) -- not an allegation of personal
    misconduct. Each axis is normalized against real congressional-fundraising
    benchmarks (see `_ethics_bench`) so leadership-tier fundraisers who take large
    and PAC money land mid-pack rather than being unfairly floored.
    """
    individual = _safe_amount(totals.get("individual_contributions"))
    itemized = _safe_amount(totals.get("individual_itemized_contributions"))
    unitemized = _safe_amount(totals.get("individual_unitemized_contributions"))
    contributions = _safe_amount(totals.get("contributions")) or _safe_amount(
        totals.get("net_contributions")
    )
    receipts = _safe_amount(totals.get("receipts")) or contributions
    pac = _safe_amount(totals.get("other_political_committee_contributions"))
    party = _safe_amount(totals.get("political_party_committee_contributions"))
    candidate_funding = (
        _safe_amount(totals.get("candidate_contribution"))
        + _safe_amount(totals.get("loans_made_by_candidate"))
        + _safe_amount(totals.get("loan_repayments_candidate_loans"))
    )

    # Small-donor reliance: unitemized (<=$200) share of individual money.
    small_donor_share = _ratio(unitemized, individual)
    # PAC independence: how little of contributions come from PAC + party money.
    pac_dependence = _ratio(pac + party, contributions)
    pac_independence = None if pac_dependence is None else 1 - pac_dependence
    # Self/party independence: how little comes from the candidate's own wallet
    # and party transfers (a cleaner "not bankrolled" signal than PAC alone).
    self_party_share = _ratio(candidate_funding + party, receipts)
    self_party_independence = None if self_party_share is None else 1 - self_party_share

    # Donor diversity: how little of itemized money comes from $2,000+ (near-max)
    # donors. High concentration -> more beholden to a narrow big-donor base.
    large_donor_total = sum(
        _safe_amount(row.get("total"))
        for row in by_size
        if _safe_amount(row.get("size")) >= 2000
    )
    donor_concentration = _ratio(large_donor_total, itemized or individual)
    donor_diversity = None if donor_concentration is None else 1 - donor_concentration

    state = _member_state_code(member)
    state_total = sum(
        _safe_amount(row.get("total"))
        for row in by_state
        if str(row.get("state") or "").upper() == str(state or "").upper()
    )
    all_state_total = sum(_safe_amount(row.get("total")) for row in by_state)
    in_state_share = _ratio(state_total, all_state_total)

    # Benchmarks (lo=poor, mid=typical incumbent, hi=strong) drawn from the shape
    # of real congressional fundraising: small-donor share is usually 5-20%;
    # incumbents take 30-45% PAC money; near-max donors are a large slice of
    # itemized receipts; out-of-state fundraising is common for leadership.
    components = {
        "small_donor": _component(
            small_donor_share,
            _ethics_bench(small_donor_share, 0.05, 0.18, 0.40),
            0.30,
        ),
        "pac_independence": _component(
            pac_independence,
            _ethics_bench(pac_independence, 0.45, 0.65, 0.90),
            0.25,
        ),
        "donor_diversity": _component(
            donor_diversity,
            _ethics_bench(donor_diversity, 0.35, 0.60, 0.85),
            0.20,
        ),
        "self_party_independence": _component(
            self_party_independence,
            _ethics_bench(self_party_independence, 0.70, 0.90, 0.99),
            0.15,
        ),
        "in_state_support": _component(
            in_state_share,
            _ethics_bench(in_state_share, 0.10, 0.30, 0.60),
            0.10,
        ),
    }

    weighted_total = 0.0
    active_weight = 0.0
    for item in components.values():
        if item["score"] is None:
            continue
        weighted_total += item["score"] * item["weight"]
        active_weight += item["weight"]

    if active_weight == 0:
        raise UpstreamDataError("FEC totals did not include enough data to score ethics.")

    score = round(weighted_total / active_weight, 1)
    return {
        "bioguideId": _member_bioguide_id(member),
        "score": score,
        "grade": _ethics_letter_grade(score),
        "source": "fec_live",
        "method": ETHICS_METHOD_VERSION,
        "updated_at": _ethics_updated_at(),
        "cycle": totals.get("cycle"),
        "candidate": {
            "candidate_id": candidate.get("candidate_id"),
            "name": candidate.get("name"),
            "office": candidate.get("office"),
            "state": candidate.get("state"),
            "district": candidate.get("district"),
            "party": candidate.get("party"),
        },
        "components": components,
        "notes": [
            "This grade measures campaign-finance independence (small-donor reliance, "
            "PAC/self/party independence, donor diversity) from FEC filings. It is not a "
            "finding of personal misconduct or a legal ethics ruling.",
        ],
        "scale": "Higher = more small-donor/grassroots funded and less reliant on big or self/party money.",
    }


def _static_ethics_fallback(bioguide_id, member=None):
    docs_path = Path(__file__).parent.parent / "docs" / "data" / "ethics" / f"{bioguide_id}.json"
    docs_score = _read_json_file(docs_path, None)
    if (
        docs_score
        and docs_score.get("score") is not None
        and docs_score.get("source") == "fec_live"
        and docs_score.get("method") == ETHICS_METHOD_VERSION
    ):
        return docs_score

    return {
        "bioguideId": bioguide_id,
        "available": False,
        "score": None,
        "grade": "N/A",
        "source": "unavailable",
        "method": ETHICS_METHOD_VERSION,
        "updated_at": None,
        "cycle": None,
        "candidate": None,
        "components": {},
        "notes": [
            "No current evidence-backed FEC grade is available for this member.",
            "YGN does not substitute synthetic or randomized values for missing public data.",
        ],
    }


def _member_stock_penalty(member):
    """Conflict-of-interest deduction from a member's ethics grade based on how
    actively their household trades individual stocks, counted from House Periodic
    Transaction Report (PTR) filings. Returns {ptr_count, penalty} or None when it
    can't be measured (Senate has no machine-countable feed without a provider key,
    so those members are simply not penalized on this axis)."""
    chamber = str(_member_chamber(member) or "").lower()
    if "senate" in chamber:
        return None
    try:
        filings = _house_disclosure_filings(
            member.get("lastName"), member.get("firstName"), _member_state_code(member)
        )
    except UpstreamDataError:
        return None
    ptr_count = sum(1 for f in filings if f.get("isStockReport"))
    penalty = STOCK_PENALTY_MAX
    for cap, pen in STOCK_PENALTY_BANDS:
        if ptr_count <= cap:
            penalty = pen
            break
    return {"ptr_count": ptr_count, "penalty": penalty}


def _apply_stock_penalty(result, member):
    """Blend the stock-trading conflict deduction into an FEC ethics result."""
    stock = _member_stock_penalty(member)
    if stock is None:
        result.setdefault("components", {})["stock_conflict"] = {
            "measurable": False,
            "note": "Stock-trade conflict not machine-countable for this member "
            "(Senate filings require a provider key); grade reflects campaign finance only.",
        }
        return result

    penalty = stock["penalty"]
    finance_score = result["score"]
    final = round(max(0.0, min(100.0, finance_score - penalty)), 1)
    result["financeScore"] = finance_score
    result["stockPtrCount"] = stock["ptr_count"]
    result["stockPenalty"] = penalty
    result["components"]["stock_conflict"] = {
        "measurable": True,
        "ptr_filings": stock["ptr_count"],
        "penalty": penalty,
        "note": f"{stock['ptr_count']} individual-stock trade (PTR) disclosure "
        f"filing(s) in ~2 years; -{penalty} conflict-of-interest deduction.",
    }
    result["score"] = final
    result["grade"] = _ethics_letter_grade(final)
    if penalty > 0:
        result["notes"].append(
            "Grade lowered for active individual-stock trading disclosed in House "
            "Periodic Transaction Reports (a conflict-of-interest signal)."
        )
    return result


def _live_ethics_score(member):
    candidate = _fec_best_candidate(member)
    if candidate is None:
        raise UpstreamDataError("No matching FEC candidate was found for ethics scoring.")

    candidate_id = candidate.get("candidate_id")
    totals = _latest_candidate_total(candidate_id)
    if totals is None:
        raise UpstreamDataError("No FEC candidate totals were found for ethics scoring.")

    cycle = totals.get("cycle")
    by_size = _fec_candidate_rows(
        "/schedules/schedule_a/by_size/by_candidate/",
        candidate_id,
        cycle,
    )
    by_state = _fec_candidate_rows(
        "/schedules/schedule_a/by_state/by_candidate/",
        candidate_id,
        cycle,
    )
    result = _score_ethics_from_fec(member, candidate, totals, by_size, by_state)
    result = _apply_stock_penalty(result, member)
    # Persist the funding breakdown built from the same totals so the funding
    # metric can reuse it instead of re-calling FEC (saves rate-limited quota).
    try:
        result["funding"] = _build_funding_from_fec(candidate, totals)
    except Exception:  # noqa: BLE001 - funding detail is optional context
        pass
    return result


def _precomputed_fec_ethics(bioguide_id):
    """A committed build-time live FEC ethics grade (docs/data/ethics/<id>.json),
    if present — served by the live API so it doesn't spend per-request FEC quota."""
    payload = _read_json_file(STATIC_PRECOMPUTED_ETHICS_DIR / f"{bioguide_id}.json", None)
    if (
        payload
        and payload.get("source") == "fec_live"
        and payload.get("grade")
        and payload.get("method") == ETHICS_METHOD_VERSION
    ):
        return payload
    return None


def compute_ethics_score(bioguide_id: str):
    """Compute the ethics score live (FEC) with static fallback, cached. The static
    generator calls this to (re)build the committed snapshot; the public getter
    below prefers that snapshot to avoid per-request FEC quota."""
    cache_key = _build_cache_key(
        "ethics-score-v2",
        {
            "bioguideId": bioguide_id,
        },
    )

    def fetch_json():
        member = None
        try:
            member = CongressMembersID(bioguide_id).get("member", {})
            if not member:
                raise ValueError(f"No member found for bioguideId {bioguide_id}.")
            return _live_ethics_score(member)
        except (MissingCongressApiKey, MissingFecApiKey, UpstreamDataError, requests.RequestException):
            return _static_ethics_fallback(bioguide_id, member)

    return _cached_json_dynamic(
        cache_key,
        f"ethics:score:{bioguide_id}",
        fetch_json,
        lambda result: FEC_LIVE_CACHE_TTL_SECONDS
        if (result or {}).get("source") == "fec_live"
        else _cache_ttl_seconds(),
    )


def ethics_fallback_only(bioguide_id):
    """Static ethics fallback with NO FEC call — used by the generator once its
    per-run FEC budget is spent."""
    member = None
    try:
        member = CongressMembersID(bioguide_id).get("member", {})
    except (MissingCongressApiKey, UpstreamDataError, requests.RequestException):
        member = None
    return _static_ethics_fallback(bioguide_id, member)


def _ethics_live_on_request():
    """Whether the live API may spend FEC quota computing ethics per request.

    Default OFF: with a rate-limited key, per-request scoring would starve the
    build-time generator of quota, so the site serves committed snapshots (or a
    cached no-FEC fallback) and lets the workflow be the sole FEC consumer. Set
    YGN_ETHICS_LIVE_ON_REQUEST=1 if your key has ample headroom (e.g. 1000+/hr).
    """
    _load_local_env()
    return os.getenv("YGN_ETHICS_LIVE_ON_REQUEST", "0") not in {"0", "false", "False", ""}


def _funding_live_on_request():
    """Whether to compute the live FEC funding BREAKDOWN per request. Unlike the
    537-member ethics sweep, funding is only fetched for individually-viewed
    members, so a real (env) FEC key can absorb it. Defaults ON when a real key is
    configured, OFF with only the rate-limited legacy demo key. Override with
    YGN_FUNDING_LIVE=0/1."""
    _load_local_env()
    override = os.getenv("YGN_FUNDING_LIVE")
    if override is not None:
        return override not in {"0", "false", "False", ""}
    return _ethics_live_on_request() or _fec_api_key_source() == "env"


def get_ethics_score(bioguide_id: str):
    precomputed = _precomputed_fec_ethics(bioguide_id)
    if precomputed is not None:
        return precomputed
    if _ethics_live_on_request():
        return compute_ethics_score(bioguide_id)
    # Reserve FEC quota for the build-time generator: serve a cached, no-FEC
    # fallback until the workflow commits a live grade for this member.
    cache_key = _build_cache_key("ethics-score-v2", {"bioguideId": bioguide_id})
    return _cached_json_dynamic(
        cache_key,
        f"ethics:score:{bioguide_id}",
        lambda: ethics_fallback_only(bioguide_id),
        lambda result: _cache_ttl_seconds(),
    )


def _wiki_summary_payload(bioguideId):
    """Resolve and cache the full Wikipedia summary payload (before trimming)."""
    static_summary = _static_wiki_override(bioguideId)
    cache_key = _build_cache_key(
        "wikipedia-summary-v3",
        {
            "bioguideId": bioguideId,
        },
    )

    def fetch_json():
        try:
            member = CongressMembersID(bioguideId).get("member", {})
        except (MissingCongressApiKey, UpstreamDataError):
            if static_summary:
                return static_summary
            raise

        if not _member_name_candidates(member):
            if static_summary:
                return static_summary
            raise ValueError(f"No directOrderName found for bioguideId {bioguideId}.")

        resolved = _resolve_wikipedia_summary(member)
        if (
            resolved.get("source") == "congress_fallback"
            and static_summary
            and static_summary.get("source") != "congress_fallback"
        ):
            return static_summary
        return resolved

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


def get_wiki_summary(bioguideId):
    """Two-sentence Wikipedia teaser (used by member tiles and hover popovers)."""
    wiki_summary = _wiki_summary_payload(bioguideId)

    if wiki_summary.get("summary"):
        summary = _first_sentences(wiki_summary.get("summary"))
        wiki_summary = {**wiki_summary, "summary": summary, "extract": summary}

    return wiki_summary


def get_member_wiki_full(bioguideId):
    """Full, untrimmed Wikipedia summary for the member detail page.

    Shares the same cache and resolution as ``get_wiki_summary`` but returns the
    complete extract (all sentences) plus thumbnail and canonical wiki URL.
    """
    return _wiki_summary_payload(bioguideId)


def get_official_profile(bioguideId, include_wiki=True, include_nominate=True, include_ethics=True):
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

    if include_ethics:
        try:
            profile["ethics_score"] = get_ethics_score(bioguideId)
        except Exception as exc:
            profile["ethics_score"] = None
            profile["errors"].append(
                {
                    "stage": "ethics",
                    "error": str(exc),
                }
            )

    return profile


# =========================================================================
# Member detail dossier
#
# The functions below power a Wikipedia-style member detail page. Each one is
# independently cached and degrades gracefully (missing data returns a well
# formed "unavailable" payload rather than raising), so a single failing
# section never blanks the page. `get_member_dossier` fans out across all of
# them and captures per-section errors, mirroring `get_official_profile`.
# =========================================================================


def _current_year():
    return datetime.now(timezone.utc).year


def _jsonable(value):
    """Coerce YAML/date values into JSON-serializable primitives for the cache."""
    return json.loads(json.dumps(value, default=str))


# --- unitedstates/congress-legislators (free, no key) --------------------


def _unitedstates_dataset(filename, ttl_seconds=UNITEDSTATES_CACHE_TTL_SECONDS):
    cache_key = _build_cache_key("unitedstates", {"file": filename})
    url = f"{UNITEDSTATES_BASE_URL}/{filename}"

    def fetch_json():
        try:
            response = requests.get(
                url,
                headers={"User-Agent": WIKI_USER_AGENT},
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException:
            raise UpstreamDataError(
                f"congress-legislators dataset request failed for {filename}."
            ) from None
        return _jsonable(yaml.safe_load(response.text) or [])

    return _cached_json(
        cache_key, f"unitedstates:{filename}", fetch_json, ttl_seconds=ttl_seconds
    )


_index_memo = {}
_index_memo_lock = threading.Lock()
INDEX_MEMO_TTL_SECONDS = 3600


def _memoized_index(key, builder):
    """In-process memo for built indexes so the ~1 MB unitedstates blobs are
    parsed/indexed once per TTL window instead of on every dossier section."""
    now = time.monotonic()
    entry = _index_memo.get(key)
    if entry is not None and (now - entry[0]) < INDEX_MEMO_TTL_SECONDS:
        return entry[1]
    with _index_memo_lock:
        entry = _index_memo.get(key)
        if entry is not None and (now - entry[0]) < INDEX_MEMO_TTL_SECONDS:
            return entry[1]
        value = builder()
        _index_memo[key] = (time.monotonic(), value)
        return value


def _build_legislators_index():
    index = {}
    for record in _unitedstates_dataset("legislators-current.yaml") or []:
        bioguide_id = (record.get("id") or {}).get("bioguide")
        if bioguide_id:
            index[bioguide_id] = record
    return index


def _legislators_index():
    """bioguide id -> full congress-legislators record for current members."""
    return _memoized_index("legislators", _build_legislators_index)


def _legislator_record(bioguide_id):
    """Single legislator record; {} if the dataset is unavailable (best-effort)."""
    try:
        return _legislators_index().get(bioguide_id, {})
    except UpstreamDataError:
        return {}


def _build_social_media_index():
    index = {}
    for record in _unitedstates_dataset("legislators-social-media.yaml") or []:
        bioguide_id = (record.get("id") or {}).get("bioguide")
        if bioguide_id:
            index[bioguide_id] = record.get("social") or {}
    return index


def _social_media_index():
    """bioguide id -> {twitter, facebook, youtube, instagram, ...}."""
    return _memoized_index("social", _build_social_media_index)


def _social_media_record(bioguide_id):
    """Single member's social handles; {} if the dataset is unavailable."""
    try:
        return _social_media_index().get(bioguide_id, {})
    except UpstreamDataError:
        return {}


def _build_committee_name_lookup():
    full = {}
    sub = {}
    for committee in _unitedstates_dataset("committees-current.yaml") or []:
        thomas_id = committee.get("thomas_id")
        if not thomas_id:
            continue
        full[thomas_id] = {
            "name": committee.get("name"),
            "chamber": committee.get("type"),
            "url": committee.get("url"),
        }
        for subcommittee in committee.get("subcommittees") or []:
            sub_id = subcommittee.get("thomas_id")
            if sub_id:
                sub[thomas_id + sub_id] = subcommittee.get("name")
    return full, sub


def _committee_name_lookup():
    """Return (full_committees, subcommittees) name lookups keyed by thomas id."""
    return _memoized_index("committees", _build_committee_name_lookup)


# --- Committee assignments (extra feature) -------------------------------


def get_member_committees(bioguide_id):
    cache_key = _build_cache_key("member-committees-v1", {"bioguideId": bioguide_id})

    def fetch_json():
        membership = _unitedstates_dataset("committee-membership-current.yaml") or {}
        full, sub = _committee_name_lookup()
        assignments = []
        for code, members in membership.items():
            if not isinstance(members, list):
                continue
            for member in members:
                if member.get("bioguide") != bioguide_id:
                    continue
                is_subcommittee = len(code) > 4
                parent_code = code[:4] if is_subcommittee else code
                committee_info = full.get(parent_code, {})
                assignments.append(
                    {
                        "code": code,
                        "committee": committee_info.get("name"),
                        "chamber": committee_info.get("chamber"),
                        "committeeUrl": committee_info.get("url"),
                        "subcommittee": sub.get(code) if is_subcommittee else None,
                        "isSubcommittee": is_subcommittee,
                        "role": member.get("title"),
                        "rank": member.get("rank"),
                        "party": member.get("party"),
                    }
                )
                break

        # Full committees before their subcommittees; leadership (low rank) first.
        assignments.sort(
            key=lambda a: (a["isSubcommittee"], a.get("rank") or 999)
        )
        leadership = [
            a for a in assignments if (a.get("role") or "").strip()
        ]
        return {
            "bioguideId": bioguide_id,
            "count": len(assignments),
            "leadershipCount": len(leadership),
            "assignments": assignments,
            "source": "unitedstates/congress-legislators",
        }

    return _cached_json(
        cache_key,
        f"committees:{bioguide_id}",
        fetch_json,
        ttl_seconds=UNITEDSTATES_CACHE_TTL_SECONDS,
    )


# --- Contact & official presence (extra feature) -------------------------


def _social_url(platform, handle):
    if not handle:
        return None
    handle = str(handle).lstrip("@")
    templates = {
        "twitter": "https://twitter.com/{}",
        "facebook": "https://facebook.com/{}",
        "instagram": "https://instagram.com/{}",
        "youtube": "https://youtube.com/user/{}",
        "youtube_id": "https://youtube.com/channel/{}",
    }
    template = templates.get(platform)
    return template.format(handle) if template else None


def get_member_contact(bioguide_id):
    cache_key = _build_cache_key("member-contact-v1", {"bioguideId": bioguide_id})

    def fetch_json():
        detail = CongressMembersID(bioguide_id).get("member", {})
        legislator = _legislator_record(bioguide_id)
        social = _social_media_record(bioguide_id)
        ids = legislator.get("id") or {}
        terms = legislator.get("terms") or []
        latest_term = terms[-1] if terms else {}
        address_info = detail.get("addressInformation") or {}

        official = {
            "website": detail.get("officialWebsiteUrl") or latest_term.get("url"),
            "contactForm": latest_term.get("contact_form"),
            "phone": latest_term.get("phone") or address_info.get("phoneNumber"),
            "office": latest_term.get("office") or address_info.get("officeAddress"),
        }

        social_links = {}
        for platform in ("twitter", "facebook", "instagram", "youtube", "youtube_id"):
            handle = social.get(platform)
            if handle:
                key = "youtube" if platform == "youtube_id" else platform
                social_links.setdefault(
                    key, {"handle": handle, "url": _social_url(platform, handle)}
                )

        profiles = {}
        if ids.get("wikipedia"):
            profiles["wikipedia"] = (
                f"https://en.wikipedia.org/wiki/{quote(ids['wikipedia'].replace(' ', '_'))}"
            )
        if ids.get("ballotpedia"):
            profiles["ballotpedia"] = (
                f"https://ballotpedia.org/{quote(ids['ballotpedia'].replace(' ', '_'))}"
            )
        if ids.get("govtrack"):
            profiles["govtrack"] = (
                f"https://www.govtrack.us/congress/members/{ids['govtrack']}"
            )
        if ids.get("opensecrets"):
            profiles["opensecrets"] = (
                "https://www.opensecrets.org/members-of-congress/summary"
                f"?cid={ids['opensecrets']}"
            )
        if ids.get("cspan"):
            profiles["cspan"] = f"https://www.c-span.org/person/?{ids['cspan']}"
        if ids.get("votesmart"):
            profiles["votesmart"] = (
                f"https://justfacts.votesmart.org/candidate/{ids['votesmart']}"
            )

        return {
            "bioguideId": bioguide_id,
            "official": official,
            "social": social_links,
            "profiles": profiles,
            "sources": ["congress.gov", "unitedstates/congress-legislators"],
        }

    return _cached_json(
        cache_key,
        f"contact:{bioguide_id}",
        fetch_json,
        ttl_seconds=UNITEDSTATES_CACHE_TTL_SECONDS,
    )


# --- Career history ------------------------------------------------------


def get_member_history(bioguide_id):
    cache_key = _build_cache_key("member-history-v1", {"bioguideId": bioguide_id})

    def fetch_json():
        detail = CongressMembersID(bioguide_id).get("member", {})
        legislator = _legislator_record(bioguide_id)
        bio = legislator.get("bio") or {}
        terms = _term_items_from_member(detail)

        def start_year(term):
            try:
                return int(term.get("startYear") or 0)
            except (TypeError, ValueError):
                return 0

        timeline = []
        chambers = []
        for term in sorted(terms, key=start_year):
            chamber = term.get("chamber")
            if chamber:
                chambers.append(chamber)
            timeline.append(
                {
                    "congress": term.get("congress"),
                    "chamber": chamber,
                    "startYear": term.get("startYear"),
                    "endYear": term.get("endYear"),
                    "state": term.get("stateName") or term.get("stateCode"),
                    "district": term.get("district"),
                    "party": term.get("partyName"),
                }
            )

        start_years = [start_year(t) for t in terms if start_year(t)]
        first_year = min(start_years) if start_years else None

        return {
            "bioguideId": bioguide_id,
            "fullName": detail.get("directOrderName"),
            "birthYear": detail.get("birthYear"),
            "birthday": bio.get("birthday"),
            "gender": bio.get("gender"),
            "firstElectedYear": first_year,
            "yearsOfService": (_current_year() - first_year) if first_year else None,
            "chambersServed": _dedupe_strings(chambers),
            "termCount": len(terms),
            "partyHistory": detail.get("partyHistory") or [],
            "leadership": detail.get("leadership") or [],
            "terms": timeline,
            "sources": ["congress.gov", "unitedstates/congress-legislators"],
        }

    return _cached_json(
        cache_key,
        f"history:{bioguide_id}",
        fetch_json,
        ttl_seconds=LEGISLATION_CACHE_TTL_SECONDS,
    )


# --- Legislation the member participated on ------------------------------


def _bill_web_url_from_item(item):
    bill_type = str(item.get("type") or "").lower()
    number = item.get("number")
    congress = item.get("congress")
    slug = BILL_TYPE_SLUGS.get(bill_type)
    if slug and congress and number:
        return f"https://www.congress.gov/bill/{congress}th-congress/{slug}/{number}"
    return item.get("url")


def _amendment_legislation_item(item):
    """Amendments appear in the sponsored/cosponsored feeds without a title."""
    latest_action = item.get("latestAction") or {}
    action_text = latest_action.get("text") or ""
    number = item.get("amendmentNumber")
    congress = item.get("congress")
    api_url = str(item.get("url") or "").lower()
    if "samdt" in api_url:
        type_label, slug, chamber = "S.Amdt.", "senate-amendment", "Senate"
    elif "hamdt" in api_url:
        type_label, slug, chamber = "H.Amdt.", "house-amendment", "House"
    else:
        type_label, slug, chamber = "Amdt.", None, ""
    web_url = (
        f"https://www.congress.gov/amendment/{congress}th-congress/{slug}/{number}"
        if slug and congress and number
        else item.get("url")
    )
    return {
        "congress": congress,
        "type": type_label,
        "number": number,
        "title": f"{chamber} Amendment {number}".strip(),
        "introducedDate": item.get("introducedDate"),
        "policyArea": (item.get("policyArea") or {}).get("name"),
        "latestAction": action_text or None,
        "latestActionDate": latest_action.get("actionDate"),
        "becameLaw": False,
        "isAmendment": True,
        "url": web_url,
    }


def _legislation_item(item):
    if item.get("amendmentNumber") and not item.get("number"):
        return _amendment_legislation_item(item)
    latest_action = item.get("latestAction") or {}
    action_text = latest_action.get("text") or ""
    return {
        "congress": item.get("congress"),
        "type": item.get("type"),
        "number": item.get("number"),
        "title": item.get("title"),
        "introducedDate": item.get("introducedDate"),
        "policyArea": (item.get("policyArea") or {}).get("name"),
        "latestAction": action_text or None,
        "latestActionDate": latest_action.get("actionDate"),
        "becameLaw": "became public law" in action_text.lower(),
        "isAmendment": False,
        "url": _bill_web_url_from_item(item),
    }


def get_member_legislation(bioguide_id, limit=15):
    limit = max(1, min(int(limit or 15), 50))
    sponsored = _congress_get(
        f"/member/{bioguide_id}/sponsored-legislation",
        params={"limit": limit},
        ttl_seconds=LEGISLATION_CACHE_TTL_SECONDS,
    )
    cosponsored = _congress_get(
        f"/member/{bioguide_id}/cosponsored-legislation",
        params={"limit": limit},
        ttl_seconds=LEGISLATION_CACHE_TTL_SECONDS,
    )

    sponsored_items = sponsored.get("sponsoredLegislation") or []
    cosponsored_items = cosponsored.get("cosponsoredLegislation") or []
    sponsored_parsed = [_legislation_item(x) for x in sponsored_items if x]

    return {
        "bioguideId": bioguide_id,
        "sponsoredCount": (sponsored.get("pagination") or {}).get("count"),
        "cosponsoredCount": (cosponsored.get("pagination") or {}).get("count"),
        "enactedShown": sum(1 for x in sponsored_parsed if x["becameLaw"]),
        "sponsored": sponsored_parsed,
        "cosponsored": [_legislation_item(x) for x in cosponsored_items if x],
        "source": "congress.gov",
    }


# --- Campaign funding: numbers, breakdown, and grade ---------------------


def _funding_line(label, amount, denominator):
    return {
        "label": label,
        "amount": round(_safe_amount(amount), 2),
        "share": _ratio(amount, denominator),
    }


def _build_funding_from_fec(candidate, totals):
    """Build the campaign-funding breakdown from an FEC candidate + totals record.

    Shared by the ethics sweep (which persists the result into the committed
    ethics snapshot) and the live funding endpoint, so the money data fetched
    once for scoring is reused for the funding metric instead of re-calling FEC.
    """
    candidate = candidate or {}
    totals = totals or {}
    receipts = _safe_amount(totals.get("receipts"))
    contributions = _safe_amount(totals.get("contributions")) or _safe_amount(
        totals.get("net_contributions")
    )
    individual = _safe_amount(totals.get("individual_contributions"))
    itemized = _safe_amount(totals.get("individual_itemized_contributions"))
    unitemized = _safe_amount(totals.get("individual_unitemized_contributions"))
    pac = _safe_amount(totals.get("other_political_committee_contributions"))
    party = _safe_amount(totals.get("political_party_committee_contributions"))
    self_funding = _safe_amount(totals.get("candidate_contribution")) + _safe_amount(
        totals.get("loans_made_by_candidate")
    )
    denominator = contributions or receipts or None
    return {
        "available": True,
        "candidate": {
            "candidateId": candidate.get("candidate_id"),
            "name": candidate.get("name"),
            "office": candidate.get("office"),
            "state": candidate.get("state"),
            "district": candidate.get("district"),
            "party": candidate.get("party"),
        },
        "cycle": totals.get("cycle"),
        "totals": {
            "receipts": round(receipts, 2),
            "disbursements": round(_safe_amount(totals.get("disbursements")), 2),
            "cashOnHand": round(
                _safe_amount(totals.get("last_cash_on_hand_end_period")), 2
            ),
            "debts": round(_safe_amount(totals.get("last_debts_owed_by_committee")), 2),
            "individualContributions": round(individual, 2),
        },
        "breakdown": [
            _funding_line("Small individual (unitemized)", unitemized, denominator),
            _funding_line("Large individual (itemized)", itemized, denominator),
            _funding_line("PAC / other committees", pac, denominator),
            _funding_line("Political party committees", party, denominator),
            _funding_line("Self-funding & candidate loans", self_funding, denominator),
        ],
    }


def get_funding_summary(bioguide_id):
    cache_key = _build_cache_key("member-funding-v1", {"bioguideId": bioguide_id})

    def fetch_json():
        base = {
            "bioguideId": bioguide_id,
            "available": False,
            "source": "fec",
            "note": None,
            "candidate": None,
            "cycle": None,
            "totals": None,
            "breakdown": [],
            "grade": None,
        }

        try:
            grade = get_ethics_score(bioguide_id)
        except Exception:  # noqa: BLE001 - grade is optional context
            grade = None
        base["grade"] = grade

        # Prefer the funding breakdown persisted alongside the ethics snapshot: it
        # was built from the same FEC totals during scoring, so serving it spends
        # no additional (rate-limited) FEC quota.
        saved = grade.get("funding") if isinstance(grade, dict) else None
        if isinstance(saved, dict) and saved.get("available"):
            base.update(saved)
            base["source"] = "fec_committed"
            base["grade"] = grade
            return base

        # No saved breakdown yet: fetch live only when a real key can absorb it,
        # otherwise return grade-only and let the sweep persist the detail.
        if not _funding_live_on_request():
            base["note"] = (
                "Campaign-finance detail is computed at build time; the grade above "
                "reflects the latest snapshot."
            )
            return base

        member = CongressMembersID(bioguide_id).get("member", {})
        try:
            candidate = _fec_best_candidate(member)
            if not candidate:
                base["note"] = (
                    "No matching FEC campaign committee was found for this member."
                )
                return base
            totals = _latest_candidate_total(candidate.get("candidate_id")) or {}
        except (MissingFecApiKey, MissingCongressApiKey, UpstreamDataError, requests.RequestException):
            base["note"] = "FEC campaign-finance data was temporarily unavailable."
            return base

        base.update(_build_funding_from_fec(candidate, totals))
        base["grade"] = grade
        return base

    return _cached_json_dynamic(
        cache_key,
        f"funding:{bioguide_id}",
        fetch_json,
        lambda result: FEC_LIVE_CACHE_TTL_SECONDS
        if (result or {}).get("available")
        else _cache_ttl_seconds(),
    )


# --- Stock trades & financial disclosures --------------------------------


def _stock_api_key():
    _load_local_env()
    return (os.getenv("YGN_STOCK_API_KEY") or os.getenv("FMP_API_KEY") or "").strip() or None


def stock_api_key_available():
    return bool(_stock_api_key())


def _house_disclosure_index(year):
    cache_key = _build_cache_key("house-fd-index", {"year": year})

    def fetch_json():
        url = HOUSE_DISCLOSURE_ZIP_URL.format(year=year)
        try:
            response = requests.get(
                url,
                headers={"User-Agent": WIKI_USER_AGENT},
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException:
            raise UpstreamDataError(
                f"House financial-disclosure index request failed for {year}."
            ) from None

        try:
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                xml_name = next(
                    name for name in archive.namelist() if name.lower().endswith(".xml")
                )
                root = ET.fromstring(archive.read(xml_name))
        except (zipfile.BadZipFile, StopIteration, ET.ParseError) as exc:
            raise UpstreamDataError(
                f"House financial-disclosure index for {year} was not parseable."
            ) from exc

        rows = []
        for member in root.findall(".//Member"):
            rows.append({child.tag: (child.text or "").strip() for child in member})
        return rows

    return _cached_json(
        cache_key,
        f"house-fd:{year}",
        fetch_json,
        ttl_seconds=DISCLOSURE_CACHE_TTL_SECONDS,
    )


def _house_disclosure_filings(last_name, first_name, state_code=None):
    if not last_name:
        return []

    last_name = last_name.strip().lower()
    first_initial = (first_name or "").strip().lower()[:1]
    state_code = (state_code or "").strip().upper() or None
    filings = []
    for year in (_current_year(), _current_year() - 1):
        try:
            rows = _house_disclosure_index(year)
        except UpstreamDataError:
            continue
        for row in rows:
            if (row.get("Last") or "").strip().lower() != last_name:
                continue
            if first_initial and (row.get("First") or "").strip().lower()[:1] != first_initial:
                continue
            # Disambiguate same-name reps in different states (StateDst is e.g. "CA11").
            if state_code and (row.get("StateDst") or "").strip().upper()[:2] != state_code:
                continue
            filing_type = (row.get("FilingType") or "").strip().upper()
            doc_id = (row.get("DocID") or "").strip()
            filing_year = (row.get("Year") or str(year)).strip()
            if filing_type == "P":
                pdf_url = HOUSE_PTR_PDF_URL.format(year=filing_year, doc_id=doc_id)
            else:
                pdf_url = HOUSE_ANNUAL_PDF_URL.format(year=filing_year, doc_id=doc_id)
            filings.append(
                {
                    "year": filing_year,
                    "filingType": filing_type,
                    "label": HOUSE_FILING_TYPE_LABELS.get(filing_type, "Disclosure Filing"),
                    "isStockReport": filing_type == "P",
                    "filingDate": row.get("FilingDate"),
                    "stateDistrict": row.get("StateDst"),
                    "docId": doc_id,
                    "pdfUrl": pdf_url if doc_id else None,
                }
            )

    def sort_key(filing):
        try:
            month, day, yr = (filing.get("filingDate") or "0/0/0").split("/")
            return (int(yr), int(month), int(day))
        except (ValueError, AttributeError):
            return (0, 0, 0)

    filings.sort(key=sort_key, reverse=True)
    return filings


def _external_stock_trades(member):
    """Machine-readable trades from a configured provider (optional).

    Congress stock-trade data with a parsed ``owner`` field (self / spouse /
    dependent child), which is what enables a "family members" breakdown, is
    only available from commercial providers (e.g. Quiver Quantitative, Finnhub,
    Financial Modeling Prep). Set ``YGN_STOCK_API_KEY`` (or ``FMP_API_KEY``) and
    implement the provider call here to populate parsed trades. Without a key we
    fall back to the official House Clerk disclosure filings below.
    """
    if not _stock_api_key():
        return []
    # Extension point: call the configured provider, normalize to
    # {transactionDate, ticker, assetDescription, type, amountRange, owner}.
    return []


def get_member_stock_activity(bioguide_id):
    cache_key = _build_cache_key("member-stocks-v1", {"bioguideId": bioguide_id})

    def fetch_json():
        member = CongressMembersID(bioguide_id).get("member", {})
        chamber = str(_member_chamber(member) or "").lower()
        is_senate = "senate" in chamber

        result = {
            "bioguideId": bioguide_id,
            "available": False,
            "provider": "none",
            "chamber": "senate" if is_senate else "house",
            "trades": [],
            "ownerBreakdown": {},
            "filings": [],
            "senateSearchUrl": SENATE_EFD_SEARCH_URL if is_senate else None,
            "familyMembersNote": (
                "Periodic Transaction Reports label each trade's owner "
                "(self, spouse 'SP', dependent child 'DC', or joint 'JT'). "
                "Parsed owner/family data requires a stock-trade provider API "
                "key (set YGN_STOCK_API_KEY); official PDFs below include it."
            ),
            "note": None,
        }

        provider_trades = _external_stock_trades(member)
        if provider_trades:
            owner_breakdown = {}
            for trade in provider_trades:
                owner = (trade.get("owner") or "self").lower()
                owner_breakdown[owner] = owner_breakdown.get(owner, 0) + 1
            result.update(
                {
                    "available": True,
                    "provider": "external",
                    "trades": provider_trades,
                    "ownerBreakdown": owner_breakdown,
                }
            )
            return result

        # No-key fallback: official House Clerk financial-disclosure filings.
        if not is_senate:
            filings = _house_disclosure_filings(
                member.get("lastName"),
                member.get("firstName"),
                _member_state_code(member),
            )
            result["filings"] = filings
            result["available"] = bool(filings)
            result["provider"] = "house_clerk" if filings else "none"
            if not filings:
                result["note"] = (
                    "No recent House financial-disclosure filings matched this member."
                )
        else:
            result["note"] = (
                "Senate financial disclosures are filed through the Senate eFD "
                "system; use the linked search. Parsed trades require a provider key."
            )

        return result

    return _cached_json(
        cache_key,
        f"stocks:{bioguide_id}",
        fetch_json,
        ttl_seconds=DISCLOSURE_CACHE_TTL_SECONDS,
    )


# --- Aggregated dossier for the detail page ------------------------------


def get_member_dossier(bioguide_id, sections=None):
    """Assemble the full member detail payload.

    Sections are fetched **concurrently** (each does its own upstream request and
    caching), so cold-cache wall-clock time is bounded by the slowest single
    section rather than the sum of all of them. Each section is captured
    independently: a failing section is set to ``None`` and recorded in
    ``errors`` rather than failing the whole request.
    """
    detail = CongressMembersID(bioguide_id)
    dossier = {
        "bioguideId": bioguide_id,
        "member": detail.get("member"),
        "detail": detail,
        "errors": [],
    }

    section_fetchers = {
        "wiki": lambda: get_member_wiki_full(bioguide_id),
        "overview": lambda: get_member_overview(bioguide_id),
        "nominate": lambda: get_nominate_score(bioguide_id),
        "ethics": lambda: get_ethics_score(bioguide_id),
        "funding": lambda: get_funding_summary(bioguide_id),
        "committees": lambda: get_member_committees(bioguide_id),
        "contact": lambda: get_member_contact(bioguide_id),
        "history": lambda: get_member_history(bioguide_id),
        "legislation": lambda: get_member_legislation(bioguide_id),
        "stocks": lambda: get_member_stock_activity(bioguide_id),
    }

    requested = sections or list(section_fetchers.keys())
    valid = [(stage, section_fetchers[stage]) for stage in requested if stage in section_fetchers]
    if not valid:
        return dossier

    with ThreadPoolExecutor(max_workers=min(len(valid), 9)) as executor:
        future_to_stage = {executor.submit(fetcher): stage for stage, fetcher in valid}
        for future in as_completed(future_to_stage):
            stage = future_to_stage[future]
            try:
                dossier[stage] = future.result()
            except Exception as exc:  # noqa: BLE001 - collect, never blank the page
                dossier[stage] = None
                dossier["errors"].append({"stage": stage, "error": str(exc)})

    return dossier


def prewarm_dossier_datasets():
    """Warm the expensive shared, no-key datasets used by the member dossier.

    The unitedstates YAML files (~1.3 MB combined) and the House disclosure ZIP
    are shared across every member and cached for many hours, but the first cold
    fetch is slow. Warming them off the request path (from the background refresh
    loop) keeps the first user's dossier fast. Failures are swallowed so a flaky
    GitHub/House response never breaks the refresh cycle.
    """
    warmers = (
        ("legislators", _legislators_index),
        ("committees", _committee_name_lookup),
        ("committee-membership", lambda: _unitedstates_dataset("committee-membership-current.yaml")),
        ("social-media", _social_media_index),
        ("house-disclosures", lambda: _house_disclosure_index(_current_year())),
    )
    warmed = []
    for label, warmer in warmers:
        try:
            warmer()
            warmed.append(label)
        except Exception:  # noqa: BLE001 - best-effort, off the request path
            LOGGER.warning("Dossier dataset prewarm failed for %s.", label, exc_info=True)
    return warmed


def _background_ethics_refresh_limit():
    raw_value = os.getenv("YGN_BACKGROUND_ETHICS_REFRESH_LIMIT", "25")
    try:
        return max(0, int(raw_value))
    except ValueError:
        return 25


def refresh_government_officials_cache(include_ethics=True, include_ai=False):
    """
    Refresh the core MVP cache entries used by the government officials surface.

    This can be called by a backend route, startup hook, or scheduled task. Each
    function still respects the 15-minute TTL and only calls upstream APIs when
    the cached response is stale or missing.
    """
    members_page = listCongressMembers(
        limit=250,
        offset=0,
        congress=_current_congress_number(),
        current_member=True,
    )
    result = {
        "allCongressMembers": members_page,
        "getRecentBills": getRecentBills(),
        "getRecentBillDigest": getRecentBillDigest(limit=5),
        "dossierDatasetsWarmed": prewarm_dossier_datasets(),
        "ethicsScoresRefreshed": 0,
        "ethicsErrors": [],
    }

    if include_ai:
        # Enqueue any gaps across the whole committed digest first, then drain a
        # bounded batch. This is the only runtime path allowed to call the model.
        result["billAiQueued"] = _enqueue_committed_digest_ai_jobs()
        # Keep the foreign brief in the queue too; refresh_foreign_brief() is a
        # no-op until the 12-hour window elapses, so this stays cheap.
        if not _foreign_brief_is_fresh(_static_foreign_brief()):
            _queue_ai_refresh_job("foreign-brief", AI_FOREIGN_CONTENT_VERSION, {})
        result["aiRefresh"] = refresh_ai_generation_cache()
    else:
        result["aiRefresh"] = {"enabled": ai_insights_available(), "skipped": True}

    if include_ethics and fec_api_key_available():
        refresh_limit = _background_ethics_refresh_limit()
        for member in members_page.get("members", [])[:refresh_limit]:
            bioguide_id = _member_bioguide_id(member)
            if not bioguide_id:
                continue
            try:
                get_ethics_score(bioguide_id)
                result["ethicsScoresRefreshed"] += 1
            except Exception as exc:
                result["ethicsErrors"].append(
                    {
                        "bioguideId": bioguide_id,
                        "stage": "ethics",
                        "error": str(exc),
                    }
                )

    return result


def warm_government_officials_cache(
    include_details=True,
    include_wiki=True,
    include_nominate=True,
    include_ethics=True,
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
        "ethics_scores_cached": 0,
        "recent_bills_cached": False,
        "recent_bill_digest_cached": False,
        "errors": [],
    }

    if include_recent_bills:
        getRecentBills()
        getRecentBillDigest(limit=5)
        report["recent_bills_cached"] = True
        report["recent_bill_digest_cached"] = True

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

            if include_ethics:
                try:
                    get_ethics_score(bioguide_id)
                    report["ethics_scores_cached"] += 1
                except Exception as exc:
                    report["errors"].append(
                        {
                            "bioguideId": bioguide_id,
                            "stage": "ethics",
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
            result = refresh_government_officials_cache(include_ai=True)
            ai = result.get("aiRefresh") or {}
            queued = result.get("billAiQueued") or {}
            if ai.get("processed") or ai.get("errors") or queued.get("queued"):
                LOGGER.info(
                    "AI refresh cycle: queued=%s processed=%s completed=%s "
                    "partial=%s errors=%s",
                    queued.get("queued"),
                    ai.get("processed"),
                    ai.get("completed"),
                    ai.get("partial"),
                    (ai.get("errors") or [])[:3],
                )
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
