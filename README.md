# YGN

Backend cache and API for the YGN government information MVP.

## Local API

Set the Congress.gov API key in your shell:

```powershell
$env:CONGRESS_API_KEY = "your-key-here"
```

Install dependencies and start FastAPI:

```powershell
pip install -r requirements.txt
uvicorn app:app --reload
```

Open `http://127.0.0.1:8000/docs` for the interactive API docs.

Useful environment variables:

- `CONGRESS_API_KEY`: required for Congress.gov requests.
- `YGN_CACHE_PATH`: optional SQLite cache path. Defaults to `empty-folder/.cache/ygn_api_cache.sqlite`.
- `YGN_CACHE_TTL_SECONDS`: optional cache TTL. Defaults to `900`.
- `YGN_ENABLE_BACKGROUND_REFRESH`: set to `0` to disable startup background refresh.
- `YGN_CORS_ORIGINS`: comma-separated allowed frontend origins. Defaults to `*` for local MVP work.
