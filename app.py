import importlib.util
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware


LOGGER = logging.getLogger(__name__)
BACKEND_PATH = Path(__file__).parent / "empty-folder" / "CongressMembers.py"


def _load_government_backend():
    spec = importlib.util.spec_from_file_location("ygn_government_backend", BACKEND_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load backend module at {BACKEND_PATH}.")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


government = _load_government_backend()


def _cors_origins():
    raw_origins = os.getenv("YGN_CORS_ORIGINS", "*")
    origins = [origin.strip() for origin in raw_origins.split(",") if origin.strip()]
    return origins or ["*"]


def startup_cache_refresh():
    should_refresh = os.getenv("YGN_ENABLE_BACKGROUND_REFRESH", "1") not in {"0", "false", "False"}
    if not should_refresh:
        return

    if not os.getenv("CONGRESS_API_KEY"):
        LOGGER.warning("Skipping background cache refresh because CONGRESS_API_KEY is not set.")
        return

    government.start_background_cache_refresh()


def shutdown_cache_refresh():
    government.stop_background_cache_refresh(timeout=5)


@asynccontextmanager
async def lifespan(_app):
    startup_cache_refresh()
    try:
        yield
    finally:
        shutdown_cache_refresh()


app = FastAPI(
    title="YGN Government API",
    description="Cached government officials and recent bills API for the YGN MVP.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _backend_response(callable_, *args, not_found_message=None, **kwargs):
    try:
        result = callable_(*args, **kwargs)
    except government.MissingCongressApiKey as exc:
        raise HTTPException(
            status_code=500,
            detail="Server is missing CONGRESS_API_KEY.",
        ) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except (requests.HTTPError, requests.RequestException) as exc:
        raise HTTPException(status_code=502, detail="Upstream government data request failed.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if result is None and not_found_message:
        raise HTTPException(status_code=404, detail=not_found_message)

    return result


@app.get("/")
def root():
    return {
        "name": "YGN Government API",
        "docs": "/docs",
        "health": "/health",
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "cache_ttl_seconds": government._cache_ttl_seconds(),
        "background_refresh_enabled": os.getenv("YGN_ENABLE_BACKGROUND_REFRESH", "1")
        not in {"0", "false", "False"},
        "congress_api_key_configured": bool(os.getenv("CONGRESS_API_KEY")),
    }


@app.get("/officials")
def list_officials():
    return _backend_response(government.allCongressMembers)


@app.get("/officials/search")
def search_official(
    name: str = Query(..., min_length=1),
    chamber: str | None = Query(default=None, pattern="^(house|senate)$"),
    congress: int | None = Query(default=None, ge=1),
):
    bioguide_id = _backend_response(
        government.getMemberID,
        name,
        chamber=chamber,
        congress=congress,
        not_found_message=f"No matching official found for {name}.",
    )
    return {"bioguideId": bioguide_id}


@app.get("/officials/{bioguide_id}")
def official_detail(bioguide_id: str):
    return _backend_response(government.CongressMembersID, bioguide_id)


@app.get("/officials/{bioguide_id}/wiki")
def official_wiki_summary(bioguide_id: str):
    return _backend_response(government.get_wiki_summary, bioguide_id)


@app.get("/officials/{bioguide_id}/nominate")
def official_nominate_score(bioguide_id: str):
    score = _backend_response(
        government.get_nominate_score,
        bioguide_id,
        not_found_message=f"No NOMINATE score found for {bioguide_id}.",
    )
    return score


@app.get("/bills/recent")
def recent_bills():
    return _backend_response(government.getRecentBills)


@app.post("/cache/refresh")
def refresh_cache():
    return _backend_response(government.refresh_government_officials_cache)
