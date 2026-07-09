# Handoff Report: Milestone 1 - Foundation & Fetching

## Observation
- `docs/members.html` contains the shared site structure: `<header class="site-header">` and `<nav class="main-nav">`. Its body tag is `<body data-page="members">`.
- In `docs/app.js`, `createMemberTile` (line 926) generates each member as a `div.member-tile` with `tabindex="0"`. Popover events (`mouseenter`/`mouseleave`/`focus`/`blur`) are attached to this tile. The internal ethics badge is an `<a>` tag and already prevents event propagation (`event.stopPropagation()` at line 1004).
- The `fetchJsonWithStaticFallback` utility in `app.js` (line 294) catches 404s on the static fallback and returns `{ notFound: true, source: 'static' }`.
- Application initialisation logic in `app.js` resides inside a `document.addEventListener('DOMContentLoaded', ...)` block starting at line 1836.
- `docs/styles.css` already contains skeleton loader classes (`.skeleton-line`, `.wide`, `.medium`, `.narrow`) and keyframes for the `skeleton-shimmer` animation (lines 740+).

## Logic Chain
1. **`member.html` Creation**: Create `docs/member.html` by mirroring the `<head>`, `<header>`, and `<nav>` elements from `members.html`. Set its body attribute to `data-page="member"`. Replace the `<main>` content with a back link (e.g., `<a href="members.html" class="back-link">← Back to Members</a>`) and an empty container (`#dossier-container`) for the dossier UI.
2. **Tile Navigation**: In `app.js`, `createMemberTile` must route users to the new page. Since the tile is a `div` and contains another `<a>` tag (ethics badge), we cannot simply wrap it in an `<a>` without creating invalid HTML. Instead, attach `click` and `keydown` (`Enter` key) listeners directly to the `div.member-tile` element. The listeners should execute `window.location.href = withApiParam('member.html?id=' + bioguideId);`. Since the ethics badge already stops propagation, it will not trigger this navigation, preserving its independent functionality.
3. **Fetching & States**: Create a new function `initMemberPage()` in `app.js`. This function should:
   - Extract the `id` parameter from the URL.
   - Inject a skeleton loader into `#dossier-container` (reusing `.skeleton-line` CSS classes).
   - Await `fetchJsonWithStaticFallback('/officials/' + id + '/dossier', 'dossier/' + id + '.json')`.
   - If the fetch returns `result.notFound`, display a friendly fallback message ("Detail unavailable in static mode — view on the live site").
   - If the fetch fails entirely, catch the error and show a standard error message.
4. **Bootstrapping**: Update the `DOMContentLoaded` event listener in `app.js` to check `if (document.body.dataset.page === 'member')` and call `initMemberPage()`.
5. **Styling**: Add any required basic styles to `docs/styles.css` for the `.back-link` and the dossier's skeleton/fallback states.

## Caveats
- The instructions only ask to set up the container, skeleton, and fetching/fallback logic for M1. The actual 8 dossier sections will be implemented in Milestone 2.
- Relying on a click/keydown handler on a `div` requires careful testing to ensure focus outline and keyboard accessibility remain functional (which they should, given `tabindex="0"` is already present).

## Conclusion
The implementer should proceed by:
1. Creating `docs/member.html` with the shared nav and a `#dossier-container`.
2. Adding click/keydown JS navigation to `div.member-tile` in `docs/app.js` using `withApiParam()`.
3. Adding `initMemberPage()` to handle URL parsing, the skeleton loader, the `fetchJsonWithStaticFallback` call, and the `notFound` static fallback logic.
4. Calling `initMemberPage()` in the `DOMContentLoaded` block.
5. Supplying basic styles for the new states in `styles.css`.

## Verification Method
1. Launch the local dev server and navigate to `members.html`.
2. Click on a member tile and press `Enter` on a focused member tile. Verify that both actions redirect to `member.html?id=<bioguideId>`.
3. Verify that the URL retains `?api=local` or any other API parameter if it was present.
4. Verify that hovering over the tile still shows the popover, and clicking the ethics badge still routes to the methodology page without triggering the tile's main navigation.
5. On `member.html`, observe the skeleton loader appearing immediately.
6. With no backend running, verify the fetch correctly falls back to static, hits a 404 for the dossier JSON, and replaces the skeleton with the "detail unavailable in static mode" message.
