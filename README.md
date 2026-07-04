# YGN

Backend cache and API for the YGN government information MVP.

## Local API

For local MVP work, put your Congress.gov key in an ignored `.env` file:

```powershell
CONGRESS_API_KEY=your-key-here
```

Or set it in your shell:

```powershell
$env:CONGRESS_API_KEY = "your-key-here"
```

Install dependencies and start FastAPI:

```powershell
pip install -r requirements.txt
uvicorn app:app --reload
```

Open `http://127.0.0.1:8000/docs` for the interactive API docs.

## Warm the cache

To prefill the cache with member pages, member details, Wikipedia summaries, NOMINATE lookups, and recent bills:

```powershell
$env:CONGRESS_API_KEY = "your-key-here"
.venv\Scripts\python.exe scripts\warm_cache.py --stats
```

For a smaller test run:

```powershell
.venv\Scripts\python.exe scripts\warm_cache.py --max-members 10 --stats
```

The FastAPI server also exposes:

- `POST /cache/warm`: fill the cache explicitly.
- `POST /cache/refresh`: refresh the lightweight top-level cache.
- `GET /cache/stats`: inspect SQLite cache entries.

Useful environment variables:

- `CONGRESS_API_KEY`: required for Congress.gov requests. It can live in `.env` for local MVP work.
- `YGN_CACHE_PATH`: optional SQLite cache path. Defaults to `empty-folder/.cache/ygn_api_cache.sqlite`.
- `YGN_CACHE_TTL_SECONDS`: optional cache TTL. Defaults to `900`.
- `YGN_ENABLE_BACKGROUND_REFRESH`: set to `0` to disable startup background refresh.
- `YGN_CORS_ORIGINS`: comma-separated allowed frontend origins. Defaults to `*` for local MVP work.

## Frontend (YGN Static Site)

The `docs/` folder contains a static frontend that talks to the FastAPI backend.
No build step is required — open `docs/index.html` directly in a browser.

### Running the full stack locally

1. **Start the backend:**
   ```powershell
   $env:CONGRESS_API_KEY = "your-key-here"
   uvicorn app:app --reload
   ```
   The API will be available at `http://127.0.0.1:8000`.

2. **Open the frontend:**
   Open `docs/index.html` in your browser (double-click, or drag into browser).
   
   > **Note:** Because the frontend fetches from `localhost`, you must have the backend running first. The health indicator in the header will show "Connected" when the backend is reachable.

### Changing the API base URL

Edit `docs/config.js` and update the `API_BASE_URL` constant:

```js
const API_BASE_URL = 'https://your-deployed-backend.example.com';
```

This is the only file you need to edit — all fetch calls in `app.js` use this constant.

### Deploying to GitHub Pages

1. Push the repository to GitHub.
2. Go to **Settings → Pages**.
3. Under **Source**, select **Deploy from a branch**.
4. Choose branch `main` (or your default branch) and folder **`/docs`**.
5. Click **Save**. GitHub Pages will serve `docs/index.html` at your Pages URL.
6. Update `API_BASE_URL` in `docs/config.js` to point to your deployed backend before pushing.
