# Original User Request

## Initial Request — 2026-07-08T23:29:55Z

# Teamwork Project Prompt — Draft

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Build a Wikipedia-style member detail page (`docs/member.html`) for the YGN civic government-info site, integrating with an existing vanilla HTML/JS/CSS frontend and live FastAPI backend.

Working directory: c:/Users/athar/OneDrive/Documents/YGN
Integrity mode: development

## Requirements

### R1. Page Foundation & Shared UI
- Create `docs/member.html`, and add its logic in `app.js` and styles in `styles.css`.
- The page must read the member id from the query string (`member.html?id=<bioguideId>`) and preserve the `?api=` parameter.
- Use the exact same header + nav markup as `members.html` (including health indicator and nav) and add a back link to `members.html`.
- Must be fully keyboard-accessible with visible focus rings and work on both mobile and desktop.

### R2. Navigation from Member Tiles
- In `app.js` (`createMemberTile`), make tiles link to the new detail page (e.g., wrap in `<a href>` or add click/Enter handler to `withApiParam('member.html?id=' + bioguideId)`).
- **Critical constraint:** Keep the existing hover popover and ethics badge functional and behaving exactly as they do now.

### R3. Data Fetching
- Fetch data from `/officials/<id>/dossier` using the existing `fetchJsonWithStaticFallback(apiPath, staticPath)` helper.
- Do not use the per-section endpoints for the initial render.
- While the static fallback (`docs/data/dossier/<id>.json`) will 404 currently, wire it up anyway. If static mode returns `{ not found: true }`, show a friendly "detail unavailable in static mode — view on the live site" message.

### R4. UI Sections (The Dossier)
Implement a grid/stack of cards for the following sections based on the dossier response shape:
1. **Identity header:** Photo (or initials fallback), full name (Playfair font), party/state/chamber/district chips, ideology tint (`nominate.dim1`), and ethics grade.
2. **About (Wikipedia):** Extract, thumbnail, and "Read more" link. Show a note if `source === "congress_fallback"`.
3. **Career history:** Headline stats (years, terms, age) and a compact timeline of terms.
4. **Campaign funding:** Headline numbers, ethics grade badge, and stacked breakdown bar of funding sources.
5. **Financial disclosures:** Table of trades and owner breakdown (if trades exist), or list of official House PDF filings, or a Senate search link.
6. **Legislation:** Two tabs for Sponsored and Cosponsored bills, with headline counts and enacted badges.
7. **Committees:** Grouped by full committee with subcommittees nested, showing role badges.
8. **Contact & Links:** Official contact info, social links, and external profile links.

### R5. Graceful Degradation
- No missing section may throw or blank the whole page. Every card must gracefully handle missing data (`null`, `available: false`, or empty arrays) by either hiding the card or showing a quiet "unavailable" message.
- Show a skeleton/spinner while loading. Show a friendly error with a link back to `members.html` if the fetch fails completely.

## Verification Resources
*Agent-as-judge: The implementing agent will run the local backend (`uvicorn app:app --reload`) and verify the page rendering against the checklist below. Note: if you have an automated test suite or programmatic way to verify the DOM, let us know and we can add it here.*

## Acceptance Criteria

### Core Integration
- [ ] `docs/member.html` exists, loads `config.js` + `app.js` + `styles.css`, has shared header/nav.
- [ ] Clicking a member tile (and Enter on a focused tile) opens `member.html?id=<bioguideId>`, preserving `?api=`.
- [ ] Existing tile popover + ethics badge still work.
- [ ] Page fetches `/officials/<id>/dossier` via `fetchJsonWithStaticFallback` and renders all eight sections.

### Content Rendering
- [ ] Identity header shows photo (with initials fallback), name in Playfair, party/state/chamber, ideology tint, ethics grade.
- [ ] Funding renders totals + grade + a stacked breakdown bar; shows the note when unavailable.
- [ ] Stocks renders provider trades OR House filing PDF links OR the Senate eFD link, with the family-owner note.
- [ ] Sponsored/cosponsored legislation lists with counts and congress.gov links; "Enacted" badge when `becameLaw`.
- [ ] Committees grouped with subcommittees and role badges; contact + social + external profile links render only when present.

### Robustness & State
- [ ] Every section degrades gracefully (null/empty/`available:false`); no console errors; fully keyboard-accessible.
- [ ] Works locally against the live backend (`?api=local`); shows a clean "unavailable in static mode" message on GitHub Pages until dossier snapshots exist.
