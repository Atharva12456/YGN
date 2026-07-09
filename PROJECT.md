# Project: YGN Member Detail Page
# Scope: All Requirements (R1-R5)

## Architecture
- `docs/member.html`: New HTML page containing the layout, headers, and grid containers.
- `docs/app.js`: Contains JavaScript for both pages. Needs routing/logic for `member.html`. Includes data fetching and rendering logic for dossier.
- `docs/styles.css`: Styles for the new grid layout, cards, badges, and skeleton loaders.
- Backend: Live FastAPI providing `/officials/<id>/dossier`.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Member Detail Page Implementation | Implement `docs/member.html` with correct header/nav. Update `app.js` navigation (`createMemberTile`) to link to it while preserving `?api=`. Setup `fetchJsonWithStaticFallback` for `/officials/<id>/dossier`. Implement the 8 dossier UI sections, handling empty states and graceful degradation. Add skeleton loaders and fallback UI messages. | none | DONE |

## Interface Contracts
### `docs/members.html` ↔ `docs/member.html`
- Links in `members.html` to `member.html` must pass `?id=<bioguideId>` and preserve `?api=<value>`.
- `createMemberTile` must retain hover popover and ethics badge functionality on `members.html`.

### Frontend ↔ Backend (`/officials/<id>/dossier`)
- Must handle missing fields, null values, or `available: false` gracefully per R5.

## Code Layout
- `docs/`
  - `member.html`
  - `members.html`
  - `app.js`
  - `styles.css`
  - `config.js`
