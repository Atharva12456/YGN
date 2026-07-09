# Synthesis Report: YGN Grid UI Update

## Consensus
All explorers agree that requirements R1-R4 can be met with tightly coupled modifications to `docs/app.js` and `docs/styles.css`. The existing data fetching architecture (R4) natively supports the required fallback and does not need architectural changes, though we must handle missing ethics scores during tile generation.

## 1. CSS Modifications (`docs/styles.css`)
- **Grid Layout (R1):** Change `.members-grid` to enforce 4 columns:
  ```css
  .members-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 24px; /* or 32px */
  }
  ```
  Include `@media` queries to gracefully downgrade to 3, 2, and 1 columns for narrower viewports.
- **Tile Styling (R2):**
  - Update `.member-tile` to have `border-radius: 36px` (within 32-44px spec).
  - Update `.tile-photo` to a larger rounded rectangle `border-radius: 32px` (within 28-40px spec) and e.g., `width: 140px; height: 160px`.
  - Add a new `.tile-photo-wrapper` class (`position: relative; display: flex; justify-content: center;`) to wrap the image.
  - Style new `.party-badge` and `.ethics-badge` elements (`position: absolute; width: 32px; height: 32px; border-radius: 50%;`). Position party badge `bottom: -10px; left: 0;` and ethics badge `bottom: -10px; right: 0;`.
  - Apply `font-family: var(--font-display)` to `.tile-name` and the district string.

## 2. JavaScript Modifications (`docs/app.js`)
- **DOM Structure (R2):** In `createMemberTile(member)`, wrap the `<img class="tile-photo">` inside `<div class="tile-photo-wrapper">`. Add the party badge and ethics badge HTML inside this wrapper so they can absolutely position over the image corners. Remove the old `.tile-badge-row`.
- **Ethics Badge Logic (R2/R4):** If `ethicsScore` is missing, use a neutral fallback color (e.g., `#94a3b8` or `#808080`). If present, interpolate or assign Red (0), Yellow/Orange (50), Green (100).
- **Dynamic Background Math (R3):** In `applyNominateTint(tileEl, dim1)`:
  - Remove existing CSS class-based toggling (`tint-blue`, `tint-red`).
  - Calculate `distance = Math.abs(dim1)`.
  - If exactly 0, `backgroundColor = '#B0B0B0'`.
  - Otherwise, `tintStrength = 0.12 + 0.88 * Math.pow(distance, 0.85)`.
  - Mix `[176, 176, 176]` with either `[90, 130, 194]` (Blue) or `[196, 92, 92]` (Red) using `tintStrength`.
  - Apply directly via `tileEl.style.backgroundColor = 'rgb(r, g, b)'`.
