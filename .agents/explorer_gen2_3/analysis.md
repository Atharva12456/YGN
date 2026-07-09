# Analysis of `fetchJsonWithStaticFallback` Failure

## 1. Observation
- In `docs/app.js` (lines 97-111), the `fetchJsonWithStaticFallback` function makes an initial `fetch` to the API.
- On line 100, there is an explicit early return: `if (res.status === 404) return { notFound: true, source: 'api' };`.
- This causes any 404 response from the backend (or the static web server, if the backend is absent) to return `{ notFound: true, source: 'api' }` without throwing an error.
- The `loadMembers` function (which fetches `/officials`) expects `result.data`. When the API returns a 404 (because it's not running), `loadMembers` gets `{ notFound: true }` without any `data`, resulting in an empty grid.

## 2. Logic Chain
- The goal of `fetchJsonWithStaticFallback` is to fall back to a local static JSON file in `docs/data/` if the primary API request fails.
- When the UI is hosted statically without a backend, the fetch to the API endpoint `/officials` naturally returns an HTTP 404.
- Because `app.js` intercepts this 404 and returns early, the `catch` block (which contains the static fallback logic) is never executed.
- By removing the `if (res.status === 404)` check for the API fetch, a 404 will trigger the next line: `if (!res.ok) throw new Error(...)`.
- This exception will be caught in the `catch` block, initiating the fetch to the static data path.
- The `catch` block itself already contains `if (res.status === 404) return { notFound: true, source: 'static' };`, preserving the intended `notFound: true` behavior for callers like `fetchNominate` and `triggerPopover` when the data is genuinely missing from both the API and the static files.

## 3. Caveats
- If the backend is online but genuinely returns a 404 for a specific resource (e.g., a member's missing wiki data), this change will result in a secondary network request to the static JSON before returning `notFound: true`. This slight network overhead is acceptable and necessary to ensure the static fallback works universally when the API is entirely offline.

## 4. Conclusion
- The `fetchJsonWithStaticFallback` function in `docs/app.js` needs to be updated.
- Remove the line: `if (res.status === 404) return { notFound: true, source: 'api' };` from the `try` block.
- This single change will allow HTTP 404 errors to properly throw exceptions, seamlessly triggering the static fallback logic without breaking any existing functionality.

## 5. Verification Method
- Host the `docs` directory on a static HTTP server (e.g., using `python -m http.server -d docs`) without the FastAPI backend running.
- Open the application in the browser.
- Verify that the grid populates successfully with members using the static `data/officials.json` file.
- Verify that the "Backend Status" indicator on the home page correctly reports "Static data".
