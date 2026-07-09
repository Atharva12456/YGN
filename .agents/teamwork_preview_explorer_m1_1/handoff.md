# Milestone 1: Foundation & Fetching — Handoff Report

## Observation
1. **Layout & Shared UI**: `docs/members.html` defines the site header (`<header class="site-header">`) and main navigation (`<nav class="main-nav">`), which must be exactly duplicated in `member.html`. 
2. **Member Tiles**: In `docs/app.js`, `createMemberTile()` (line 926) builds the tiles as `div` elements with `tabindex="0"`. It includes a nested `.ethics-badge` (an `<a>` tag) which already calls `stopPropagation()` on click (line 1004). Popovers trigger on `mouseenter` and `focus`.
3. **Data Fetching**: The `fetchJsonWithStaticFallback` helper in `docs/app.js` (line 294) prefixes the static path with `data/` and returns `{ notFound: true, source: 'static' }` when the static JSON file 404s.
4. **Initialization**: `docs/app.js` sets up event listeners in a `DOMContentLoaded` block (line 1836). The active navigation state is handled by `initNavLinks()` which relies on `<body data-page="...">`.
5. **Styles**: Existing `.skeleton-tile`, `.skeleton-circle`, `.skeleton-line`, and `.error-state` classes in `docs/styles.css` can be reused to satisfy the skeleton loader and fallback message requirements.

## Logic Chain
1. **`docs/member.html` Creation (R1)**: Duplicate `members.html`, set `<body data-page="member">`, and replace the `<main>` block with a `#dossier-container` and a back link `<a id="back-link" href="members.html">← Back to Members</a>`.
2. **Tile Navigation (R2)**: Add `click` and `keydown` (Enter) event listeners to `createMemberTile` in `app.js`. Because `.ethics-badge` stops event propagation, clicking the badge will safely bypass the tile's click handler, preserving existing badge functionality. The navigation should use `window.location.href = withApiParam('member.html?id=' + encodeURIComponent(bioguideId))`.
3. **Initialization & Routing**: Inside the `DOMContentLoaded` block in `app.js`, detect the member page (e.g., `document.body.dataset.page === 'member'`) and trigger a new initialization function (e.g., `initMemberDetail()`). 
4. **Data Fetching & UI States (R3, R5)**: `initMemberDetail()` must:
   - Extract the `id` from the URL search params.
   - Run `backLink.href = withApiParam('members.html')` to preserve the `?api=` parameter when navigating back.
   - Render a skeleton loader inside `#dossier-container` using existing skeleton classes (e.g., `<div class="skeleton-tile">...</div>`).
   - Call `fetchJsonWithStaticFallback('/officials/' + id + '/dossier', 'dossier/' + id + '.json')`.
   - If `notFound: true` is returned, update `#dossier-container` with `<div class="error-state">Detail unavailable in static mode — view on the live site.</div>`.
   - If fetch fails completely, show an error state with a link back to members.
   - *Note: Rendering the actual successful dossier UI is deferred to Milestone 2.*

## Caveats
- No need to update `PAGE_URLS` in `app.js` since `initNavLinks` checks against the data-page attribute directly and the member detail page isn't in the global site header nav.
- The success state of the fetch in Milestone 1 does not need to render the 8 dossier cards. A simple placeholder indicating success is sufficient, as Milestone 2 fully builds the UI elements.
- The `fetchJsonWithStaticFallback` expects paths relative to `data/`, so pass `'dossier/' + id + '.json'` (without `data/`).

## Conclusion
The implementer is ready to begin work on Milestone 1. 
- Create `docs/member.html` mirroring `members.html` with a back link and a container.
- Update `createMemberTile` in `docs/app.js` with click/Enter navigation logic via `withApiParam`.
- Add `initMemberDetail()` in `docs/app.js` to parse the ID, render the skeleton, fetch the dossier data, and handle the static fallback / error UI states. 
- Ensure `initMemberDetail()` is called inside `DOMContentLoaded`.

## Verification Method
1. Open `members.html` locally and verify clicking on a member tile navigates to `member.html?id=...` and preserves `?api=` (e.g. `?api=local`).
2. Verify that clicking the tile's ethics badge or hovering the tile still shows the ethics page / popover correctly without navigating to `member.html`.
3. Open `member.html?id=A000360` without a local API (`?api=static`). Verify the skeleton loader flashes momentarily, followed by the specific fallback message: "Detail unavailable in static mode — view on the live site."
4. Verify the back link returns to `members.html` while preserving `?api=`.
