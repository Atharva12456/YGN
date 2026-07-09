# Analysis Report: Static Data Fallback Issue

## 1. Observation
- In `docs/app.js`, lines 97-111 define `fetchJsonWithStaticFallback`.
- At line 100, the code reads: `if (res.status === 404) return { notFound: true, source: 'api' };`
- The `loadMembers` function in `docs/app.js` (line 259) calls `fetchJsonWithStaticFallback('/officials?limit=250&offset=0', 'officials.json')`.
- According to `c:\Users\athar\OneDrive\Documents\YGN\.agents\orchestrator\failure_feedback.md`, when the backend is not running, the API fetch for `/officials` returns a 404. This triggers the early return at line 100, returning `{ notFound: true, source: 'api' }`, and entirely bypasses the `catch` block that was supposed to fetch the static fallback data.

## 2. Logic Chain
- The purpose of `fetchJsonWithStaticFallback` is to attempt an API fetch and, if it fails (including if the backend is down and returns 404), fall back to the static `docs/data/` JSON files.
- By intercepting the 404 response in the `try` block and returning a custom object (`{ notFound: true, source: 'api' }`), the code prevents an error from being thrown.
- Because no error is thrown, the execution never enters the `catch (apiError)` block, meaning the fallback `fetch(\`data/\${staticPath}\`)` is never executed.
- The `loadMembers` function expects an array or an object with `items` or `members`, but receives undefined (`data` is missing from the result), leading it to evaluate `items = []` and call `showEmpty()`.
- To fix this, a 404 response from the API must be treated as an error (or at least, must trigger the fallback). Since `!res.ok` already throws an error for non-2xx responses, removing the early return for 404s will allow `!res.ok` to catch it and throw the error.
- The static fetch inside the `catch` block already has a handler for 404: `if (res.status === 404) return { notFound: true, source: 'static' };`. This is correct because if the static file doesn't exist, we truly have a "not found" scenario (which functions like `fetchNominate` expect).

## 3. Caveats
- Functions like `fetchNominate` and `triggerPopover` rely on receiving a `{ notFound: true }` result when data genuinely doesn't exist.
- With the proposed change, if the API is running but returns 404 for a specific member's wiki or nominate data, it will fall back to checking the static data. If the static data also doesn't exist (returning 404), it will correctly return `{ notFound: true, source: 'static' }`. This behavior preserves the intended functionality.
- I have not run a local static server to manually verify the HTTP response codes, but this behavior matches standard browser `fetch` semantics and the explicit failure feedback.

## 4. Conclusion
The failure is caused by line 100 in `docs/app.js`:
`if (res.status === 404) return { notFound: true, source: 'api' };`

**Recommended Fix Strategy:**
Remove line 100 from `docs/app.js`. 
The updated `try` block should look like this:
```javascript
  try {
    const res = await fetch(API_BASE_URL + apiPath, { cache: options.cache || 'default' });
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    return { data: await res.json(), source: 'api' };
  } catch (apiError) {
```
This change will cause a 404 response to throw an error, transferring control to the `catch` block where the static data fallback will be executed.

## 5. Verification Method
- Modify `docs/app.js` with the recommended fix.
- Ensure the FastAPI backend is NOT running.
- Serve the `docs/` directory using a static file server (e.g., `python -m http.server 8000 -d docs`).
- Navigate to the frontend in a browser. The grid should successfully populate with tiles using the static `officials.json` data, and the health indicator should read "Static data ✓".
- Test the popover and coloring functionalities to ensure they still correctly handle missing data (since they will now rely on the static 404 handler returning `{ notFound: true }`).
