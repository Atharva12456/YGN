## 2026-07-08T23:32:44Z
Your working directory is c:\Users\athar\OneDrive\Documents\YGN\.agents\teamwork_preview_worker_m1.
Read the project scope in c:\Users\athar\OneDrive\Documents\YGN\PROJECT.md and the user request in c:\Users\athar\OneDrive\Documents\YGN\ORIGINAL_REQUEST.md.
Implement Milestone 1: "Foundation & Fetching".

Follow this action plan from the Explorer:
1. **`member.html` Creation**: Create `docs/member.html` by mirroring the `<head>`, `<header>`, and `<nav>` elements from `docs/members.html`. Set its body attribute to `data-page="member"`. Replace the `<main>` content with a back link (e.g., `<a href="members.html" class="back-link">← Back to Members</a>`) and an empty container (`#dossier-container`) for the dossier UI.
2. **Tile Navigation**: In `docs/app.js`, `createMemberTile` must route users to the new page. Since the tile is a `div` and contains another `<a>` tag (ethics badge), attach `click` and `keydown` (`Enter` key) listeners directly to the `div.member-tile` element. The listeners should execute `window.location.href = withApiParam('member.html?id=' + bioguideId);`. (The ethics badge already stops propagation, so it will not trigger this navigation). Ensure the tile has cursor: pointer in CSS if not already.
3. **Fetching & States**: Create a new function `initMemberPage()` in `docs/app.js`. This function should:
   - Extract the `id` parameter from the URL using `URLSearchParams`.
   - Inject a skeleton loader into `#dossier-container` (reusing `.skeleton-line` CSS classes from `styles.css`).
   - Await `fetchJsonWithStaticFallback('/officials/' + id + '/dossier', 'dossier/' + id + '.json')`.
   - If the fetch returns an object with `notFound: true`, display a friendly fallback message ("Detail unavailable in static mode — view on the live site") and hide the skeleton.
   - If the fetch fails entirely, catch the error and show a standard error message with a link back to `members.html`.
4. **Bootstrapping**: Update the `DOMContentLoaded` event listener in `docs/app.js` to check `if (document.body.dataset.page === 'member')` and call `initMemberPage()`. (Ensure you keep the existing logic for `document.body.dataset.page === 'members'` intact).
5. **Styling**: Add any required basic styles to `docs/styles.css` for the `.back-link` and the dossier's skeleton/fallback states.

Do NOT implement the 8 dossier UI sections yet (that is Milestone 2). Just the fetching, states, and navigation.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

After implementing, test your changes using `uvicorn app:app --reload` if needed, or static tests. Write your completion report to `handoff.md` and message me when done.
