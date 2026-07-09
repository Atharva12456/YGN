# Observation
- `docs/members.html` header/nav structure found at lines 21-35.
- `docs/app.js` line 926 has `createMemberTile(member)` which builds the tile DOM. The tile currently lacks a click/enter navigation handler to go to `member.html`.
- `docs/app.js` line 329 has `withApiParam(url)` which appends `?api=...` to any URL, handling existing query parameters safely.
- `fetchJsonWithStaticFallback` in `app.js` at line 294 returns `{ notFound: true, source: 'static' }` when the static JSON is missing (returns 404).
- `docs/styles.css` has skeleton loader animations (`.skeleton-circle`, `.skeleton-line.wide`, `.skeleton-line.medium`) that can be reused for the dossier skeleton.

# Logic Chain
- To meet R1, we create `docs/member.html` copying the `<head>`, `<header>`, and `<nav>` exactly from `members.html`. The body should be `<body data-page="member">`. Inside `<main>`, we add a back link to `members.html` and a `<div id="dossier-container">` to hold the content.
- To meet R2, we modify `createMemberTile` in `app.js` to add `click` and `keydown` event listeners to the `.member-tile`. We will use `window.location.href = withApiParam('member.html?id=' + bioguideId)` to preserve the API parameter while adding the ID parameter. Using click handlers preserves the existing popover events that run on `mouseenter`, `focus`, etc., without breaking the existing DOM layout or hover behaviors.
- To meet R3, we add a new initialization function in `app.js` (e.g., `initMemberDetail()`) that checks if `document.body.dataset.page === 'member'`. It reads `id` from `window.location.search`, shows a skeleton loader using existing CSS skeleton classes inside `#dossier-container`, fetches the dossier data via `fetchJsonWithStaticFallback('/officials/' + id + '/dossier', 'dossier/' + id + '.json')`, and checks for `result.notFound` to display the "detail unavailable in static mode &mdash; view on the live site" message.
- To handle the back link preserving parameters, `initNavLinks` in `app.js` already applies `withApiParam` to `.main-nav a`, but we need to ensure our back link (e.g. `<a class="back-link" href="members.html">`) is updated, either by running `withApiParam` on it manually during `DOMContentLoaded` or embedding the query parameter directly if generated dynamically.

# Caveats
- I did not define the complete UI card structures for the 8 sections (that is Milestone 2). The skeleton and fallback logic only prepares the container for Milestone 2 implementation.
- Assuming the skeleton loader can just be an HTML string inserted via `innerHTML` into the `#dossier-container` before fetching data.

# Conclusion
The implementation requires:
1. Create `docs/member.html` based on `members.html`'s header and add a `<main>` with a `<div id="dossier-container">` and `<a id="back-link" href="members.html">← Back to Members</a>`.
2. Edit `app.js` -> `createMemberTile` to attach `click` and `keydown` (Enter) event listeners that navigate to `withApiParam('member.html?id=' + bioguideId)`. Ensure `tabindex="0"` is preserved so the element remains focusable.
3. Edit `app.js` -> add `initMemberDetail()` which:
   - Reads `id` from URL.
   - Populates `#dossier-container` with skeleton DOM elements (`.skeleton-circle`, `.skeleton-line`).
   - Calls `fetchJsonWithStaticFallback('/officials/' + id + '/dossier', 'dossier/' + id + '.json')`.
   - On `result.notFound === true`, sets `#dossier-container` content to the required fallback message.
4. Hook `initMemberDetail()` into the `DOMContentLoaded` event block in `app.js` when `document.body.dataset.page === 'member'`. Also process the `#back-link` with `withApiParam` to preserve `?api=`.

# Verification Method
- **Test Command**: Serve the `docs/` folder locally (e.g. using `python -m http.server 8080 -d docs`).
- **Inspection**:
  - Open `members.html`, hover over tiles to confirm popover and ethics badge still work.
  - Click on any member tile. Verify the page navigates to `member.html?id=<bioguideId>`.
  - Verify the health indicator, header, and nav match `members.html` exactly.
  - Verify the page displays a skeleton loader initially.
  - Verify that if the static fallback is hit and fails (returns 404), the "detail unavailable in static mode — view on the live site" message appears.
  - Verify `?api=...` is preserved in the URL during all navigations (including the back link).
