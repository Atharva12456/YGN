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
STATIC_ETHICS_PATH = Path(__file__).parent / "static_ethics_scores.json"
STATIC_MEMBER_OVERRIDES_PATH = Path(__file__).parent / "static_member_overrides.json"
STATIC_WIKI_DIR = Path(__file__).parent.parent / "docs" / "data" / "wiki"
STATIC_OFFICIALS_PATH = Path(__file__).parent.parent / "docs" / "data" / "officials.json"
STATIC_PROFILES_DIR = Path(__file__).parent.parent / "docs" / "data" / "profiles"
DEFAULT_CACHE_TTL_SECONDS = 15 * 60
DEFAULT_WIKI_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
REQUEST_TIMEOUT_SECONDS = 20
WIKI_USER_AGENT = "YGN/1.0 (government-officials-cache)"
ETHICS_METHOD_VERSION = "campaign_finance_v2"

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
_cache_key_locks = {}
_cache_key_locks_guard = threading.Lock()
_background_refresh_thread = None
_background_refresh_stop = threading.Event()


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


def _legacy_fec_api_key():
    legacy_path = Path(__file__).parent / "memberFinances.py"
    if not legacy_path.exists():
        return ""

    try:
        text = legacy_path.read_text(encoding="utf-8")
    except OSError:
        return ""

    match = re.search(r"\bAPI_key\s*=\s*['\"]([^'\"]+)['\"]", text)
    return match.group(1) if match else ""


def fec_api_key_available():
    _load_local_env()
    return bool(
        os.getenv("FEC_API_KEY")
        or os.getenv("ECON_API_KEY")
        or os.getenv("YGN_ECON_API_KEY")
        or _legacy_fec_api_key()
    )


def _congress_api_key():
    _load_local_env()
    api_key = os.getenv("CONGRESS_API_KEY") or API_KEY
    if not api_key:
        raise MissingCongressApiKey(
            "CONGRESS_API_KEY is not set. Add it to the backend environment before "
            "calling Congress.gov."
        )

    return api_key


def _fec_api_key():
    _load_local_env()
    api_key = (
        os.getenv("FEC_API_KEY")
        or os.getenv("ECON_API_KEY")
        or os.getenv("YGN_ECON_API_KEY")
        or _legacy_fec_api_key()
    )
    if not api_key:
        raise MissingFecApiKey(
            "FEC_API_KEY, ECON_API_KEY, or YGN_ECON_API_KEY is not set. Add it to "
            "the backend environment before refreshing live ethics grades."
        )

    return api_key


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
            conn.commit()


def _cache_lock_for_key(cache_key):
    with _cache_key_locks_guard:
        lock = _cache_key_locks.get(cache_key)
        if lock is None:
            # Bound growth: bill/FEC/etc. keys are unbounded over a long-lived
            # server. Clearing is safe — in-flight locks stay alive via the
            # caller's reference; a brand-new key just mints a fresh lock.
            if len(_cache_key_locks) > 10000:
                _cache_key_locks.clear()
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


def _fec_api_key_source():
    """Which FEC key is in play: 'env' (real key), 'legacy_demo' (hardcoded
    fallback, ~60 req/hr), or None. Surfaced in /health for debugging."""
    _load_local_env()
    if (
        os.getenv("FEC_API_KEY")
        or os.getenv("ECON_API_KEY")
        or os.getenv("YGN_ECON_API_KEY")
    ):
        return "env"
    if _legacy_fec_api_key():
        return "legacy_demo"
    return None


def _fec_retry_delay(response, attempt):
    retry_after = (response.headers.get("Retry-After") or "").strip()
    if retry_after.isdigit():
        return min(float(retry_after), 3.0)
    return min(0.5 * (attempt + 1), 3.0)


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
        request_params = dict(cache_params)
        request_params["api_key"] = _fec_api_key()

        attempts = 3
        for attempt in range(attempts):
            try:
                response = requests.get(
                    url,
                    params=request_params,
                    timeout=REQUEST_TIMEOUT_SECONDS,
                )
            except requests.RequestException:
                raise UpstreamDataError(f"FEC request failed for {path}.") from None

            # Rate limited: back off and retry (helps burst limits, e.g. the
            # parallel dossier firing ethics + funding at once).
            if response.status_code == 429 and attempt + 1 < attempts:
                time.sleep(_fec_retry_delay(response, attempt))
                continue

            if response.status_code == 429:
                raise UpstreamDataError(
                    f"FEC rate limit exceeded for {path}. The FEC_API_KEY is "
                    "throttled (the demo key allows only ~60 requests/hour)."
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
    from_dt = (now - timedelta(days=90)).strftime("%Y-%m-%dT00:00:00Z")
    data = _congress_get(
        "/bill",
        params={
            "limit": 40,
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


def _bill_member_items(bill, detail):
    people = []
    for role, collection in (
        ("Sponsor", detail.get("sponsors") or bill.get("sponsors") or []),
        ("Cosponsor", detail.get("cosponsors") or []),
    ):
        if isinstance(collection, dict):
            collection = collection.get("items") or collection.get("cosponsors") or []
        for person in collection:
            if not isinstance(person, dict):
                continue
            name = _first_nonempty(
                person.get("fullName"),
                person.get("directOrderName"),
                person.get("name"),
            )
            if not name:
                continue
            people.append(
                {
                    "role": role,
                    "name": name,
                    "state": person.get("state"),
                    "party": person.get("party"),
                    "bioguideId": person.get("bioguideId"),
                }
            )

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

    return {
        "identifier": _bill_identifier(bill),
        "title": _first_nonempty(detail.get("title"), bill.get("title"), "Untitled bill"),
        "congress": bill.get("congress") or detail.get("congress"),
        "type": bill.get("type") or detail.get("type"),
        "number": bill.get("number") or detail.get("number"),
        "originChamber": bill.get("originChamber") or detail.get("originChamber"),
        "description": _bill_description(bill, detail, summaries),
        "members": _bill_member_items(bill, detail),
        "impact": {
            "status": "Pending AI impact analysis",
            "summary": (
                "Impact analysis will be generated after a ChatGPT API key is configured. "
                "For now, YGN links to the official bill record and Congress.gov data used for the digest."
            ),
            "sources": [
                source
                for source in (
                    {"label": "Congress.gov bill page", "url": web_url} if web_url else None,
                    {"label": "Congress.gov API record", "url": api_url} if api_url else None,
                )
                if source
            ],
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
DEFAULT_AI_MODEL = "gpt-4o-mini"
BILL_IMPACT_SYSTEM_PROMPT = (
    "You are a nonpartisan civic analyst for a U.S. government information site. "
    "Explain federal legislation in plain, neutral language for a general audience. "
    "Be factual and concise. Do not use partisan framing, do not predict whether a "
    "bill will pass, and do not invent details beyond what you are given."
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


def _llm_chat(system_prompt, user_prompt, max_tokens=250, temperature=0.2):
    config = _ai_provider_config()
    if not config:
        raise UpstreamDataError("No AI provider is configured.")

    body = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    params = None
    if config["kind"] == "azure":
        headers = {"api-key": config["key"], "Content-Type": "application/json"}
        params = {"api-version": config["api_version"]}
    else:
        headers = {"Authorization": f"Bearer {config['key']}", "Content-Type": "application/json"}
        body["model"] = config["model"]

    try:
        response = requests.post(
            config["url"],
            params=params,
            headers=headers,
            json=body,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except requests.RequestException:
        raise UpstreamDataError("AI provider request failed.") from None

    choices = response.json().get("choices") or []
    if not choices:
        raise UpstreamDataError("AI provider returned no choices.")
    return (choices[0].get("message") or {}).get("content", "").strip()


def generate_bill_impact(bill_item):
    """Plain-language AI impact analysis for a digest bill item, cached 30 days.

    Returns {status, summary, model, provider, generated_at} or None when no AI
    provider is configured (callers keep the existing placeholder in that case).
    """
    config = _ai_provider_config()
    if not config:
        return None

    identifier = (
        bill_item.get("identifier")
        or bill_item.get("url")
        or bill_item.get("title")
        or "unknown"
    )
    cache_key = _build_cache_key(
        "bill-impact-v1", {"id": identifier, "model": config["model"]}
    )

    def fetch_json():
        title = bill_item.get("title") or "Untitled bill"
        description = (bill_item.get("description") or {}).get("text") or ""
        policy_area = bill_item.get("policyArea") or "Unspecified"
        committees = ", ".join(bill_item.get("committees") or []) or "Not yet referred"
        latest = (bill_item.get("latestAction") or {}).get("text") or "No action recorded"
        user_prompt = (
            f"Bill: {title}\n"
            f"Policy area: {policy_area}\n"
            f"Committees: {committees}\n"
            f"Latest action: {latest}\n"
            f"Official summary: {description or 'No official summary published yet.'}\n\n"
            "In 2-3 sentences, explain in plain language what this bill would do and "
            "who or what it would affect if enacted (which groups, sectors, agencies, "
            "or people). If the available summary is too thin to assess impact, say "
            "that plainly instead of guessing."
        )
        summary = _llm_chat(BILL_IMPACT_SYSTEM_PROMPT, user_prompt, max_tokens=220)
        return {
            "status": "AI impact analysis",
            "summary": summary,
            "model": config["model"],
            "provider": config["kind"],
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    return _cached_json(
        cache_key,
        f"bill-impact:{identifier}",
        fetch_json,
        ttl_seconds=AI_IMPACT_TTL_SECONDS,
    )


def getRecentBillDigest(limit=5):
    limit = max(1, min(int(limit), 20))
    cache_key = _build_cache_key(
        "recent-bill-digest-v1",
        {
            "limit": limit,
        },
    )

    def fetch_json():
        bills = _recent_bill_list(getRecentBills())[:limit]
        items = [_bill_digest_item(bill) for bill in bills]
        ai_on = ai_insights_available()
        if ai_on:
            for item in items:
                try:
                    impact = generate_bill_impact(item)
                    if impact and impact.get("summary"):
                        item["impact"] = {
                            **item["impact"],
                            "status": impact["status"],
                            "summary": impact["summary"],
                            "model": impact.get("model"),
                            "generated_at": impact.get("generated_at"),
                        }
                except Exception as exc:  # noqa: BLE001 - keep the placeholder on failure
                    LOGGER.warning("Bill impact generation failed: %s", exc)
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "congress_api",
            "cache_ttl_seconds": _cache_ttl_seconds(),
            "impact_status": "ai" if ai_on else "placeholder_until_ai_key",
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

    params = {
        "q": names[0],
        "per_page": 20,
        "has_raised_funds": "true",
    }
    state = _member_state_code(member)
    office = _member_fec_office(member)
    if state:
        params["state"] = state
    if office:
        params["office"] = office
    # Party is intentionally NOT a hard filter: FEC's party codes don't always
    # match ours (independents, minor parties, caucus mismatches), which would
    # drop a real candidate to zero results. It stays a +1 signal in scoring.

    data = _fec_get("/candidates/search/", params=params)
    candidates = data.get("results", [])
    return sorted(candidates, key=lambda candidate: _fec_candidate_match_score(candidate, member), reverse=True)


def _fec_best_candidate(member):
    candidates = _fec_search_candidates(member)
    if not candidates:
        return None

    best = candidates[0]
    if _fec_candidate_match_score(best, member) < 7:
        return None
    return best


def _latest_candidate_total(candidate_id):
    data = _fec_get(
        f"/candidate/{candidate_id}/totals/",
        params={
            "per_page": 20,
            "sort": "-cycle",
        },
    )
    totals = data.get("results", [])
    if not totals:
        return None

    current_cycle = _current_election_cycle()
    eligible = [row for row in totals if int(row.get("cycle") or 0) <= current_cycle]
    return (eligible or totals)[0]


def _fec_candidate_rows(path, candidate_id, cycle):
    data = _fec_get(
        path,
        params={
            "candidate_id": candidate_id,
            "cycle": cycle,
            "per_page": 100,
        },
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


def _score_ethics_from_fec(member, candidate, totals, by_size, by_state):
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

    small_donor_share = _ratio(unitemized, individual)
    pac_dependence = _ratio(pac + party, contributions)
    self_party_share = _ratio(candidate_funding + party, receipts)

    large_donor_total = sum(
        _safe_amount(row.get("total"))
        for row in by_size
        if _safe_amount(row.get("size")) >= 2000
    )
    donor_concentration = _ratio(large_donor_total, itemized or individual)

    state = _member_state_code(member)
    state_total = sum(
        _safe_amount(row.get("total"))
        for row in by_state
        if str(row.get("state") or "").upper() == str(state or "").upper()
    )
    all_state_total = sum(_safe_amount(row.get("total")) for row in by_state)
    in_state_share = _ratio(state_total, all_state_total)

    components = {
        "small_donor": _component(small_donor_share, (small_donor_share or 0) * 100, 0.30),
        "pac_independence": _component(
            pac_dependence,
            None if pac_dependence is None else (1 - pac_dependence) * 100,
            0.25,
        ),
        "donor_concentration": _component(
            donor_concentration,
            None if donor_concentration is None else (1 - donor_concentration) * 100,
            0.20,
        ),
        "in_state_support": _component(in_state_share, (in_state_share or 0) * 100, 0.15),
        "self_party_independence": _component(
            self_party_share,
            None if self_party_share is None else (1 - self_party_share) * 100,
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
        "notes": [],
    }


def _static_ethics_scores():
    return _read_json_file_cached(STATIC_ETHICS_PATH, {})


def _stable_fraction(*values):
    seed = "|".join(str(value or "") for value in values)
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return int(digest[:12], 16) / float(0xFFFFFFFFFFFF)


def _bounded_score(score, minimum=0.0, maximum=100.0):
    return max(minimum, min(maximum, score))


def _static_member_snapshot(bioguide_id):
    profile = _read_json_file(STATIC_PROFILES_DIR / f"{bioguide_id}.json", None)
    if isinstance(profile, dict):
        member = (profile.get("data") or {}).get("member")
        if isinstance(member, dict):
            return member

    officials = _read_json_file(STATIC_OFFICIALS_PATH, {})
    for member in officials.get("members", []) or []:
        if _member_bioguide_id(member) == bioguide_id:
            return member

    return {}


def _member_photo_url(member):
    depiction = member.get("depiction") if isinstance(member.get("depiction"), dict) else {}
    return depiction.get("imageUrl") or member.get("photoUrl") or member.get("thumbnail")


def _member_start_year(member):
    term = _latest_member_term(member)
    for value in (term.get("startYear"), member.get("startYear")):
        try:
            if value not in (None, ""):
                return int(value)
        except (TypeError, ValueError):
            continue
    return None


def _static_ethics_component_scores(bioguide_id, member, default_score):
    member = member or {}
    name = _member_display_name(member) if member else bioguide_id
    state = member.get("stateCode") or member.get("state") or _latest_member_term(member).get("stateName")
    chamber = _member_chamber(member) or ""
    party = member.get("party") or member.get("partyName") or _current_party_name(member)
    district = _member_district(member)
    district_label = _district_label(member)
    photo_url = _member_photo_url(member)

    public_fields = [name, state, chamber, party, district_label or district, photo_url]
    completeness = sum(1 for value in public_fields if value not in (None, "")) / len(public_fields)
    data_score = 62 + completeness * 34

    chamber_lower = str(chamber).lower()
    if "senate" in chamber_lower:
        constituency_value = 1.0
        constituency_score = 80 + _stable_fraction("senate", bioguide_id, state) * 10
    elif district not in (None, ""):
        constituency_value = 0.8
        constituency_score = 72 + _stable_fraction("district", state, district, bioguide_id) * 18
    else:
        constituency_value = 0.45
        constituency_score = 66 + _stable_fraction("missing-district", bioguide_id, state) * 12

    record_score = 62 + _stable_fraction("record", bioguide_id, name, state, party) * 34
    disclosure_score = 60 + _stable_fraction("disclosure", bioguide_id, chamber, district) * 36

    start_year = _member_start_year(member)
    if start_year:
        service_years = max(0, datetime.now(timezone.utc).year - start_year)
        tenure_value = min(service_years, 30) / 30
        tenure_score = 74 + min(service_years, 20) * 0.45 - max(0, service_years - 20) * 0.2
        tenure_score += (_stable_fraction("tenure", bioguide_id) - 0.5) * 7
        tenure_score = _bounded_score(tenure_score, 68, 91)
    else:
        tenure_value = None
        tenure_score = 70 + _stable_fraction("tenure-missing", bioguide_id) * 16

    baseline_score = default_score + (_stable_fraction("baseline", bioguide_id, state) - 0.5) * 18

    return {
        "public_record_completeness": _component(completeness, data_score, 0.20),
        "constituency_specificity": _component(constituency_value, constituency_score, 0.18),
        "public_accountability_baseline": _component(
            _stable_fraction("record-value", bioguide_id),
            record_score,
            0.24,
        ),
        "disclosure_baseline": _component(
            _stable_fraction("disclosure-value", bioguide_id),
            disclosure_score,
            0.23,
        ),
        "service_context": _component(tenure_value, tenure_score, 0.10),
        "static_baseline_variation": _component(
            _stable_fraction("baseline-value", bioguide_id),
            baseline_score,
            0.05,
        ),
    }


def _static_ethics_score_from_components(components):
    weighted_total = 0.0
    active_weight = 0.0
    for item in components.values():
        if item["score"] is None:
            continue
        weighted_total += item["score"] * item["weight"]
        active_weight += item["weight"]

    if active_weight == 0:
        return None

    return round(_bounded_score(weighted_total / active_weight, 55, 96), 1)


def _static_ethics_fallback(bioguide_id, member=None):
    docs_path = Path(__file__).parent.parent / "docs" / "data" / "ethics" / f"{bioguide_id}.json"
    docs_score = _read_json_file(docs_path, None)
    if (
        docs_score
        and docs_score.get("score") is not None
        and docs_score.get("method") == ETHICS_METHOD_VERSION
    ):
        return {**docs_score, "source": docs_score.get("source") or "static_fallback"}

    static_scores = _static_ethics_scores()
    member_overrides = static_scores.get("members", {}) or {}
    override = member_overrides.get(bioguide_id)
    default_score = float(static_scores.get("default_score", 76.0))

    components = {}
    if isinstance(override, dict) and override.get("score") is not None:
        score = override.get("score")
        components = override.get("components") or {}
    elif override is not None:
        score = override
    else:
        member = member or _static_member_snapshot(bioguide_id)
        components = _static_ethics_component_scores(bioguide_id, member, default_score)
        score = _static_ethics_score_from_components(components)
        if score is None:
            score = default_score

    score = round(float(score), 1)
    return {
        "bioguideId": bioguide_id,
        "score": score,
        "grade": _ethics_letter_grade(score),
        "source": "static_fallback",
        "method": ETHICS_METHOD_VERSION,
        "updated_at": static_scores.get("generated_at"),
        "cycle": static_scores.get("cycle"),
        "candidate": None,
        "components": components,
        "notes": [
            "Live FEC finance data was unavailable; using a deterministic static fallback grade.",
            "Static fallback grades are educational placeholders and are not legal findings or misconduct allegations.",
        ],
    }


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
    return _score_ethics_from_fec(member, candidate, totals, by_size, by_state)


def get_ethics_score(bioguide_id: str):
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

    return _cached_json(
        cache_key,
        f"ethics:score:{bioguide_id}",
        fetch_json,
        ttl_seconds=_cache_ttl_seconds(),
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

        member = CongressMembersID(bioguide_id).get("member", {})

        try:
            candidate = _fec_best_candidate(member)
            if not candidate:
                base["note"] = (
                    "No matching FEC campaign committee was found for this member."
                )
                return base

            candidate_id = candidate.get("candidate_id")
            totals = _latest_candidate_total(candidate_id) or {}
        except (MissingFecApiKey, MissingCongressApiKey, UpstreamDataError, requests.RequestException):
            base["note"] = "FEC campaign-finance data was temporarily unavailable."
            return base

        cycle = totals.get("cycle")
        receipts = _safe_amount(totals.get("receipts"))
        contributions = _safe_amount(totals.get("contributions")) or _safe_amount(
            totals.get("net_contributions")
        )
        individual = _safe_amount(totals.get("individual_contributions"))
        itemized = _safe_amount(totals.get("individual_itemized_contributions"))
        unitemized = _safe_amount(totals.get("individual_unitemized_contributions"))
        pac = _safe_amount(totals.get("other_political_committee_contributions"))
        party = _safe_amount(totals.get("political_party_committee_contributions"))
        self_funding = (
            _safe_amount(totals.get("candidate_contribution"))
            + _safe_amount(totals.get("loans_made_by_candidate"))
        )

        denominator = contributions or receipts or None
        breakdown = [
            _funding_line("Small individual (unitemized)", unitemized, denominator),
            _funding_line("Large individual (itemized)", itemized, denominator),
            _funding_line("PAC / other committees", pac, denominator),
            _funding_line("Political party committees", party, denominator),
            _funding_line("Self-funding & candidate loans", self_funding, denominator),
        ]

        # Reuse the campaign-finance grade already computed for the ethics score.
        try:
            grade = get_ethics_score(bioguide_id)
        except Exception:  # noqa: BLE001 - grade is optional context
            grade = None

        base.update(
            {
                "available": True,
                "candidate": {
                    "candidateId": candidate_id,
                    "name": candidate.get("name"),
                    "office": candidate.get("office"),
                    "state": candidate.get("state"),
                    "district": candidate.get("district"),
                    "party": candidate.get("party"),
                },
                "cycle": cycle,
                "totals": {
                    "receipts": round(receipts, 2),
                    "disbursements": round(_safe_amount(totals.get("disbursements")), 2),
                    "cashOnHand": round(
                        _safe_amount(totals.get("last_cash_on_hand_end_period")), 2
                    ),
                    "debts": round(_safe_amount(totals.get("last_debts_owed_by_committee")), 2),
                    "individualContributions": round(individual, 2),
                },
                "breakdown": breakdown,
                "grade": grade,
            }
        )
        return base

    return _cached_json(
        cache_key,
        f"funding:{bioguide_id}",
        fetch_json,
        ttl_seconds=_cache_ttl_seconds(),
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


def refresh_government_officials_cache(include_ethics=True):
    """
    Refresh the core MVP cache entries used by the government officials surface.

    This can be called by a backend route, startup hook, or scheduled task. Each
    function still respects the 15-minute TTL and only calls upstream APIs when
    the cached response is stale or missing.
    """
    members_page = listCongressMembers(limit=250, offset=0)
    result = {
        "allCongressMembers": members_page,
        "getRecentBills": getRecentBills(),
        "getRecentBillDigest": getRecentBillDigest(limit=5),
        "dossierDatasetsWarmed": prewarm_dossier_datasets(),
        "ethicsScoresRefreshed": 0,
        "ethicsErrors": [],
    }

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
