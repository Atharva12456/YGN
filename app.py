import importlib.util
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles


LOGGER = logging.getLogger(__name__)
BACKEND_PATH = Path(__file__).parent / "empty-folder" / "CongressMembers.py"
DOCS_PATH = Path(__file__).parent / "docs"
STATIC_FILE_SUFFIXES = {
    ".css",
    ".html",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".json",
    ".png",
    ".svg",
    ".webmanifest",
}


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

    if not government.congress_api_key_available():
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

# Compress text responses (JS/CSS/JSON/HTML). Heroku does not gzip for us, and
# the JSON snapshots + app bundle are large, so this is the biggest transfer win.
app.add_middleware(GZipMiddleware, minimum_size=500)


# Cache-Control for static assets so repeat visits and internal navigation hit
# the browser cache instead of re-fetching app.js/styles.css/vendor/JSON.
STATIC_CACHE_RULES = (
    ("/vendor/", "public, max-age=604800"),   # third-party libs — effectively immutable
    ("/data/", "public, max-age=900"),         # generated JSON — matches the 15-min cache TTL
    ("/assets/", "public, max-age=86400"),     # icons/images
)


@app.middleware("http")
async def add_static_cache_headers(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if "cache-control" not in (key.lower() for key in response.headers):
        for prefix, value in STATIC_CACHE_RULES:
            if path.startswith(prefix):
                response.headers["Cache-Control"] = value
                break
        else:
            if path == "/config.js":
                response.headers["Cache-Control"] = "public, max-age=60"
            elif path.endswith((".css", ".js")):
                response.headers["Cache-Control"] = "public, max-age=600"
    return response


if DOCS_PATH.exists():
    for mount_name in ("assets", "data", "vendor"):
        mount_path = DOCS_PATH / mount_name
        if mount_path.exists():
            app.mount(
                f"/{mount_name}",
                StaticFiles(directory=mount_path),
                name=f"frontend-{mount_name}",
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
    except government.UpstreamDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except (requests.HTTPError, requests.RequestException) as exc:
        raise HTTPException(status_code=502, detail="Upstream government data request failed.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if result is None and not_found_message:
        raise HTTPException(status_code=404, detail=not_found_message)

    return result


@app.get("/api")
def api_root():
    return {
        "name": "YGN Government API",
        "docs": "/docs",
        "health": "/health",
    }


@app.get("/", include_in_schema=False)
def frontend_index():
    return FileResponse(DOCS_PATH / "index.html")


@app.get("/config.js", include_in_schema=False)
def frontend_config():
    content = """// YGN API configuration served by FastAPI.
const DEFAULT_API_BASE_URL = window.location.origin;
const LOCAL_API_BASE_URL = 'http://127.0.0.1:8000';

function resolveApiBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  const override = (params.get('api') || '').trim();

  if (override === 'local') return LOCAL_API_BASE_URL;
  if (override === 'static') return '';
  if (override === 'origin') return window.location.origin;
  if (/^https?:\\/\\//i.test(override)) {
    // Only allow same-origin or localhost overrides — never an arbitrary host.
    try {
      const u = new URL(override);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.origin === window.location.origin) {
        return override.replace(/\\/+$/, '');
      }
    } catch (e) {}
  }

  return DEFAULT_API_BASE_URL.replace(/\\/+$/, '');
}

const API_BASE_URL = resolveApiBaseUrl();
"""
    return Response(content=content, media_type="application/javascript")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "cache_ttl_seconds": government._cache_ttl_seconds(),
        "background_refresh_enabled": os.getenv("YGN_ENABLE_BACKGROUND_REFRESH", "1")
        not in {"0", "false", "False"},
        "congress_api_key_configured": bool(os.getenv("CONGRESS_API_KEY")),
        "congress_api_key_available": government.congress_api_key_available(),
        "fec_api_key_available": government.fec_api_key_available(),
        "fec_api_key_source": government._fec_api_key_source(),
        "stock_api_key_available": government.stock_api_key_available(),
        "ai_insights_available": government.ai_insights_available(),
        "ai_provider": government.ai_provider_name(),
    }


@app.get("/officials")
def list_officials(
    limit: Annotated[int, Query(ge=1, le=250)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    congress: Annotated[int | None, Query(ge=1)] = None,
    current_member: bool | None = None,
):
    return _backend_response(
        government.listCongressMembers,
        limit=limit,
        offset=offset,
        congress=congress,
        current_member=current_member,
    )


@app.get("/officials/search")
def search_official(
    name: Annotated[str, Query(min_length=1)],
    chamber: Annotated[str | None, Query(pattern="^(house|senate)$")] = None,
    congress: Annotated[int | None, Query(ge=1)] = None,
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
def official_wiki_summary(bioguide_id: str, full: bool = False):
    if full:
        return _backend_response(government.get_member_wiki_full, bioguide_id)
    return _backend_response(government.get_wiki_summary, bioguide_id)


@app.get("/officials/{bioguide_id}/nominate")
def official_nominate_score(bioguide_id: str):
    score = _backend_response(
        government.get_nominate_score,
        bioguide_id,
        not_found_message=f"No NOMINATE score found for {bioguide_id}.",
    )
    return score


@app.get("/officials/{bioguide_id}/ethics")
def official_ethics_score(bioguide_id: str):
    return _backend_response(government.get_ethics_score, bioguide_id)


@app.get("/officials/{bioguide_id}/profile")
def official_profile(
    bioguide_id: str,
    include_wiki: bool = True,
    include_nominate: bool = True,
    include_ethics: bool = True,
):
    return _backend_response(
        government.get_official_profile,
        bioguide_id,
        include_wiki=include_wiki,
        include_nominate=include_nominate,
        include_ethics=include_ethics,
    )


@app.get("/officials/{bioguide_id}/legislation")
def official_legislation(
    bioguide_id: str,
    limit: Annotated[int, Query(ge=1, le=50)] = 15,
):
    return _backend_response(
        government.get_member_legislation, bioguide_id, limit=limit
    )


@app.get("/officials/{bioguide_id}/funding")
def official_funding(bioguide_id: str):
    return _backend_response(government.get_funding_summary, bioguide_id)


@app.get("/officials/{bioguide_id}/committees")
def official_committees(bioguide_id: str):
    return _backend_response(government.get_member_committees, bioguide_id)


@app.get("/officials/{bioguide_id}/contact")
def official_contact(bioguide_id: str):
    return _backend_response(government.get_member_contact, bioguide_id)


@app.get("/officials/{bioguide_id}/history")
def official_history(bioguide_id: str):
    return _backend_response(government.get_member_history, bioguide_id)


@app.get("/officials/{bioguide_id}/stocks")
def official_stocks(bioguide_id: str):
    return _backend_response(government.get_member_stock_activity, bioguide_id)


@app.get("/officials/{bioguide_id}/dossier")
def official_dossier(bioguide_id: str, sections: str | None = None):
    section_list = (
        [s.strip() for s in sections.split(",") if s.strip()] if sections else None
    )
    return _backend_response(
        government.get_member_dossier, bioguide_id, sections=section_list
    )


@app.get("/bills/recent")
def recent_bills():
    return _backend_response(government.getRecentBills)


@app.get("/bills/recent/digest")
def recent_bill_digest(limit: Annotated[int, Query(ge=1, le=40)] = 5):
    return _backend_response(government.getRecentBillDigest, limit=limit)


@app.get("/bills/{congress}/{bill_type}/{number}")
def bill_detail(
    congress: str,
    bill_type: str,
    number: str,
    include_votes: bool = True,
):
    return _backend_response(
        government.get_bill_detail,
        congress,
        bill_type,
        number,
        include_votes=include_votes,
        not_found_message=f"No Congress.gov record for {bill_type.upper()} {number}.",
    )


@app.get("/bills/{congress}/{bill_type}/{number}/ai")
def bill_ai(congress: str, bill_type: str, number: str):
    # Lazily generated AI description + impact; kept out of the main detail
    # response so the page never blocks on a slow model call.
    if not government.ai_insights_available():
        return {"available": False, "ai_enabled": False, "reason": "AI not configured."}
    try:
        return government.get_bill_ai(congress, bill_type, number)
    except government.UpstreamDataError as exc:
        return {"available": False, "ai_enabled": True, "reason": str(exc)}
    except (requests.HTTPError, requests.RequestException):
        return {"available": False, "ai_enabled": True, "reason": "Upstream request failed."}


def _confidence_response(callable_, *args, **kwargs):
    if not government.ai_insights_available():
        return {
            "available": False,
            "reason": "AI insights are not configured on the server.",
            "note": "Set AZURE_OPENAI_* (or OPENAI_*) environment variables to enable estimates.",
        }
    # Degrade gracefully: if the AI provider errors (bad deployment, quota, etc.)
    # return a structured unavailable payload the UI can show, not a 502.
    try:
        result = callable_(*args, **kwargs)
    except government.UpstreamDataError as exc:
        return {"available": False, "reason": str(exc)}
    except (requests.HTTPError, requests.RequestException):
        return {"available": False, "reason": "The AI provider request failed."}
    if result is None:
        return {"available": False, "reason": "No estimate could be generated."}
    return {"available": True, **result}


@app.get("/ai/confidence/event")
def event_confidence(
    topic: Annotated[str, Query(min_length=2, max_length=200)],
    context: Annotated[str | None, Query(max_length=500)] = None,
):
    return _confidence_response(government.generate_event_confidence, topic, context=context)


@app.get("/officials/{bioguide_id}/confidence")
def candidate_confidence(bioguide_id: str):
    return _confidence_response(government.generate_candidate_confidence, bioguide_id)


@app.get("/metrics/debt")
def national_debt_metric():
    return _backend_response(government.get_national_debt_metric)


@app.get("/metrics/economy")
def economy_snapshot():
    return _backend_response(government.get_economy_snapshot)


@app.get("/metrics/fec-status", include_in_schema=False)
def fec_status():
    return _backend_response(government.fec_key_diagnostic)


@app.get("/metrics/ai-status", include_in_schema=False)
def ai_status():
    return _backend_response(government.ai_key_diagnostic)


@app.post("/cache/refresh")
def refresh_cache():
    return _backend_response(government.refresh_government_officials_cache)


@app.post("/cache/warm")
def warm_cache(
    include_details: bool = True,
    include_wiki: bool = True,
    include_nominate: bool = True,
    include_ethics: bool = True,
    include_recent_bills: bool = True,
    max_members: Annotated[int | None, Query(ge=1)] = None,
    limit: Annotated[int, Query(ge=1, le=250)] = 250,
):
    return _backend_response(
        government.warm_government_officials_cache,
        include_details=include_details,
        include_wiki=include_wiki,
        include_nominate=include_nominate,
        include_ethics=include_ethics,
        include_recent_bills=include_recent_bills,
        max_members=max_members,
        limit=limit,
    )


@app.get("/cache/stats")
def cache_stats():
    return _backend_response(government.get_cache_stats)


@app.get("/{filename}", include_in_schema=False)
def frontend_file(filename: str):
    requested = (DOCS_PATH / filename).resolve()
    docs_root = DOCS_PATH.resolve()
    if (
        docs_root not in requested.parents
        or requested.suffix not in STATIC_FILE_SUFFIXES
        or not requested.is_file()
    ):
        raise HTTPException(status_code=404, detail="Static file not found.")

    return FileResponse(requested)
