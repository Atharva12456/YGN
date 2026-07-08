"""
Generic SQLite-backed caching engine used by CongressMembers.py.

This module is intentionally free of any Congress.gov/Wikipedia-specific
logic so it can be reused or tested independently. Callers pass in a
`fetch_json` callable (and, for background refresh, a `refresh_fn`
callable) rather than this module importing domain code directly.
"""

import json
import logging
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path


LOGGER = logging.getLogger(__name__)

DEFAULT_CACHE_PATH = Path(__file__).parent / ".cache" / "ygn_api_cache.sqlite"
DEFAULT_CACHE_TTL_SECONDS = 15 * 60
DEFAULT_WIKI_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60

_cache_lock = threading.RLock()
_cache_key_locks = {}
_cache_key_locks_guard = threading.Lock()
_background_refresh_thread = None
_background_refresh_stop = threading.Event()


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


def _background_refresh_loop(refresh_fn, interval_seconds, stop_event):
    while not stop_event.is_set():
        try:
            refresh_fn()
        except Exception:
            LOGGER.exception("Background cache refresh failed.")

        stop_event.wait(interval_seconds)


def start_background_cache_refresh(refresh_fn, interval_seconds=None):
    """
    Start a daemon thread that calls `refresh_fn` on a fixed interval.

    The thread starts only when this function is called, so importing this
    module will not spend API quota or require an API key. `refresh_fn` is
    supplied by the caller (e.g. CongressMembers.refresh_government_officials_cache)
    so this module stays free of domain-specific logic.
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
        args=(refresh_fn, interval, _background_refresh_stop),
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
