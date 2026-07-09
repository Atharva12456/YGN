# Handoff: Member Detail Page Implementation (R1-R5)

## 1. Observation
- `docs/member.html`: Contains `<a href="members.html" class="back-link">← Back to Members</a>` (line 38) which is static and loses the `?api=` parameter.
- `docs/app.js`: In `initMemberPage` (lines 1846-1896):
  - Error states at line 1857 and 1892 hardcode `<a href="members.html">Return to Members</a>`, losing `?api=`.
  - The successful fetch condition (line 1887) renders a facade: `container.innerHTML = '<p style="text-align:center;">Dossier fetched successfully (Milestone 1).</p>';` instead of rendering the 8 UI sections described in `MEMBER_DETAIL_FRONTEND_PROMPT.md` and `ORIGINAL_REQUEST.md`.
- `MEMBER_DETAIL_FRONTEND_PROMPT.md` specifies the exact JSON schema returned by `/officials/<id>/dossier` and strict graceful degradation requirements for all 8 sections (Identity, About, Career history, Campaign funding, Financial disclosures, Legislation, Committees, Contact & Links).

## 2. Logic Chain
- To preserve the `?api=` parameter, all references to `members.html` must be wrapped in `withApiParam()`. This applies to the static `.back-link` in the DOM and the dynamically rendered error links.
- The facade in `initMemberPage` needs to be replaced with a robust DOM rendering function that accepts `result.data` (the dossier JSON).
- Based on `MEMBER_DETAIL_FRONTEND_PROMPT.md`, the rendering logic must destructure the 8 domains: `const { member, wiki, nominate, ethics, funding, stocks, legislation, committees, contact, history } = result.data;`
- **Graceful Degradation**: Each section must be rendered independently (e.g., using separate template literal functions) and gracefully handle `null` or missing data with a quiet "unavailable" message or by hiding the card.
- **Section 1 (Identity)**: Must map `member.depiction.imageUrl` (with initials fallback), apply `nominate.dim1` tinting, and render the `ethics` grade badge.
- **Section 2 (About)**: Must check `wiki` and `wiki.source === "congress_fallback"`.
- **Section 3 (Career)**: Must render stats from `history` and a timeline from `history.terms`.
- **Section 4 (Funding)**: Must handle `funding.available`, render totals, ethics grade, and stacked breakdown bar from `funding.breakdown`. If false, show `funding.note`.
- **Section 5 (Financials)**: Must cascade: if `stocks.trades.length` exists render table, else if `stocks.filings.length` render House PDFs list, else if `stocks.senateSearchUrl` render link.
- **Section 6 (Legislation)**: Render tabs for `legislation.sponsored` and `legislation.cosponsored`.
- **Section 7 (Committees)**: Must group `committees.assignments` where `isSubcommittee` is false and nest the subcommittees.
- **Section 8 (Contact)**: Map `contact.official`, `contact.social`, and `contact.profiles` only if keys exist.

## 3. Caveats
- I did not test the DOM rendering logic live since I am in a read-only investigation mode.
- I assume `MEMBER_DETAIL_FRONTEND_PROMPT.md` is fully accurate regarding the API response structure. The implementer must rely heavily on optional chaining (`?.`) to avoid breaking the page.

## 4. Conclusion
The implementer must update `initMemberPage` in `docs/app.js` to:
1. Dynamically update the `.back-link` element's `href` using `withApiParam('members.html')`.
2. Update the error state `<a href="members.html">` templates to `<a href="${withApiParam('members.html')}">`.
3. Replace the Milestone 1 facade at line 1887 with a robust rendering implementation for the 8 dossier sections, pulling from `result.data`.
4. Ensure every rendered card implements graceful degradation as specified, using optional chaining and fallback text to avoid any unhandled exceptions.

## 5. Verification Method
1. Start the local backend using `uvicorn app:app --reload`.
2. Open `docs/members.html?api=local` in the browser.
3. Click a member tile to navigate to `docs/member.html?id=<bioguideId>&api=local`.
4. Verify the `← Back to Members` link correctly points to `members.html?api=local`.
5. Verify the 8 dossier sections render correctly with the member's data.
6. Verify graceful degradation by forcing a section's data to `null` (e.g. `result.data.wiki = null`) and ensuring the page doesn't break.
