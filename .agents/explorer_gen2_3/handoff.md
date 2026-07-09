# Handoff Report - Explorer Gen 2.3

## Observation
In `docs/app.js` line 100, inside the `try` block of `fetchJsonWithStaticFallback`, there is the following code:
```javascript
if (res.status === 404) return { notFound: true, source: 'api' };
```
When statically hosted, the fetch to `/officials` returns an HTTP 404, hitting this line and returning an empty response instead of falling into the `catch` block that triggers the static data fallback.

## Logic Chain
1. The intended fallback mechanism relies on the API fetch throwing an error to enter the `catch` block, where `data/officials.json` is subsequently requested.
2. The manual interception of 404s via the early return bypasses this exception for missing endpoints.
3. If this line is removed, an HTTP 404 will fall through to `if (!res.ok) throw new Error(...)` on the next line.
4. The error will correctly be caught by the `catch` block, allowing the static file to be queried.
5. If the static file *also* returns a 404 (e.g. for genuinely missing nominate data), the `catch` block already gracefully handles this (`if (res.status === 404) return { notFound: true, source: 'static' };`), ensuring identical downstream behavior without breaking features.

## Caveats
- No significant caveats. For genuinely missing individual resources (like a 404 for a specific bioguide wiki), the app will perform an extra network request to the static file before returning `notFound`. This minor overhead is required to enable full functionality when the backend is completely offline.

## Conclusion
The bug is caused by the premature return on a 404 status. The fix is simply deleting line 100 (`if (res.status === 404) return { notFound: true, source: 'api' };`) in `docs/app.js`.

## Verification Method
- Stop the backend API if running.
- Serve the `docs` folder statically via `python -m http.server -d docs`.
- Load the webpage and confirm that the member grid populates successfully with data from `data/officials.json`.
- Confirm the home page "Backend Status" indicator reads "Static data".
