## Challenge Summary

**Overall risk assessment**: HIGH

## Challenges

### [High] Challenge 1: Static Fallback Fails on 404 Responses

- **Assumption challenged**: The assumption that a 404 response means "empty data" rather than a failed API request.
- **Attack scenario**: When the frontend is hosted statically (e.g., on GitHub Pages) without the backend, requests to `/officials` will return a 404 Not Found from the static file server. The `fetchJsonWithStaticFallback` function in `docs/app.js` catches 404s in the `try` block and returns `{ notFound: true, source: 'api' }`. This bypasses the `catch` block entirely. The `loadMembers()` function then receives undefined data, falls back to an empty array, and displays the empty state instead of falling back to the `data/officials.json` static data.
- **Blast radius**: The application will fail to load any congressional members when hosted statically or when the API route is unmounted, directly violating Requirement R4 and the acceptance criteria "App successfully populates the UI using static mock data if the backend is offline."
- **Mitigation**: Remove the 404 short-circuit from the main `try` block in `fetchJsonWithStaticFallback`, or handle the 404 case differently depending on whether it's a collection or an individual entity.

## Stress Test Results

- Static hosting without backend (simulated by Python `http.server` serving static files) → Grid should populate with mock data from `data/officials.json` → Grid displays "No members match your search." → **FAIL**
- Missing `ethicsScore` logic → Should use neutral placeholder color → `getEthicsColor` correctly returns `#94a3b8` → **PASS**
- Dynamic background calculation → Should accurately compute RGB mix for non-linear strength → Validated math matches formula `tintStrength = 0.12 + 0.88 * (distanceFromCenter ^ 0.85)` exactly → **PASS**
- Responsive layout → Should display 4 columns wrapping gracefully → Grid template uses `repeat(4, 1fr)` and correctly scales down at 1024px, 768px, and 600px breakpoints → **PASS**

## Unchallenged Areas

- Backend health indicator logic (though it correctly falls back because 404s on `/health` also return `notFound: true`, which is falsy and causes a disconnected state, bypassing static data for health.json as well).
