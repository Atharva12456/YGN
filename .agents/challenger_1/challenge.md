## Challenge Summary

**Overall risk assessment**: HIGH

The responsive grid and dynamic background math have been correctly implemented, but a critical flaw in the data fetching logic prevents the application from fulfilling the data fallback requirement (R4).

## Challenges

### [High] Challenge 1: Data Fallback Fails on HTTP 404

- **Assumption challenged**: The worker assumed that any API unavailability would trigger an exception that the `catch` block in `fetchJsonWithStaticFallback` would handle to load static data.
- **Attack scenario**: In a static deployment context (such as GitHub Pages or a simple local HTTP server with `API_BASE_URL` = `''`), requests to the non-existent API endpoints (e.g. `/officials?limit=250&offset=0`) will return an HTTP 404.
- **Blast radius**: The `fetchJsonWithStaticFallback` function explicitly intercepts the 404 status (`if (res.status === 404) return { notFound: true, source: 'api' };`) and returns it without throwing an error. This completely skips the `catch` block that was supposed to fetch the static fallback data. As a result, the application receives no data and fails to render the grid (falling back to an empty state).
- **Mitigation**: Update `fetchJsonWithStaticFallback` to only return `notFound: true` for specific 404s (e.g. missing NOMINATE or Wiki data) or remove the early 404 return and let it throw so it falls back to static JSON, which can then safely return `notFound: true` if the *static* file is genuinely missing.

## Stress Test Results

- **Scenario**: Simulate API downtime by returning a 404 response to the initial `/officials` API fetch.
- **Expected behavior**: Application catches the error and successfully falls back to loading `data/officials.json`.
- **Actual behavior**: Function returns `{ notFound: true, source: 'api' }` without throwing, `loadMembers` interprets data as empty, and renders "No members match your search" with no grid.
- **Result**: FAIL

## Unchallenged Areas

- Edge cases around corrupted static JSON data were not stress-tested because the primary fallback mechanism itself was immediately broken.
