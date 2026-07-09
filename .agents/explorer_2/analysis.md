# Analysis of YGN Grid UI Update

## Observation
I have investigated `docs/app.js` and `docs/styles.css` against the requirements in `ORIGINAL_REQUEST.md`.

**R1. Responsive Grid Layout**
*   **Current State:** `.members-grid` uses `grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))` with a `gap: 1rem` (16px).
*   **Missing:** Doesn't enforce exactly 4 columns on desktop, and gap is too small. Needs to be 24px-32px and explicitly handle wrapping.

**R2. Tile Styling & Design**
*   **Current State:**
    *   `.member-tile` has `border-radius: var(--radius-card)` (which is 12px).
    *   `.tile-photo` has `border-radius: 50%` and dimensions `80x80px`.
    *   Badges are just inline blocks inside `.tile-badge-row` below the text.
    *   Font for `.tile-name` is the default sans-serif font.
*   **Missing:**
    *   Tile border-radius needs to be 32px-44px.
    *   Portrait image needs to be larger and a rounded-rectangle (`28px-40px` radius).
    *   Badges (Party and Ethics) need to be circular and positionally overlap the bottom-left and bottom-right of the portrait, requiring a new `position: relative` wrapper for the portrait.
    *   `.tile-name` needs `font-family: var(--font-display)` (Playfair Display).
    *   No ethics badge exists currently. Need to extract `ethicsScore` from data, fallback to neutral color if absent.

**R3. Dynamic Background Color**
*   **Current State:** `applyNominateTint` in `app.js` applies CSS classes (`tint-blue`, `tint-red`) which use linear-gradients and a linear opacity calculation (`intensity = dim1 / 1.0`).
*   **Missing:** Needs to use the exact non-linear math: `tintStrength = 0.12 + 0.88 * (abs(nominateScore) ^ 0.85)` and mix the specified hex colors (`#B0B0B0`, `#5A82C2`, `#C45C5C`). This should be directly applied as `element.style.backgroundColor` via JavaScript since CSS `calc()` doesn't natively support powers (`^ 0.85`) across all browsers without complex math functions.

**R4. Data Integration & Fallback**
*   **Current State:** `fetchJsonWithStaticFallback` is implemented and used for fetching officials, wikis, and nominate scores. It falls back to `docs/data/*.json`.
*   **Status:** This requirement is fundamentally met. The code already gracefully falls back to static JSON files in `docs/data/` if the FastAPI backend is unreachable.

## Recommended Fix Strategy

### 1. Update `docs/styles.css`
*   Modify `.members-grid` to use a 4-column layout on desktop:
    ```css
    .members-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 32px;
    }
    ```
    Add media queries to step down to 3, 2, and 1 column on smaller widths.
*   Update `.member-tile`:
    *   `border-radius: 36px;`
    *   Remove `border` or make it subtler since background colors will be stronger.
*   Update `.tile-photo`:
    *   `width: 140px; height: 160px;`
    *   `border-radius: 32px;`
*   Add `.tile-photo-wrapper`:
    *   `position: relative; display: flex; justify-content: center; margin-bottom: 1rem;`
*   Style `.party-badge` and `.ethics-badge`:
    *   `position: absolute; bottom: -10px; width: 32px; height: 32px; border-radius: 50%;`
    *   Party badge on `left: 0;`, Ethics badge on `right: 0;`.
*   Update `.tile-name`:
    *   Add `font-family: var(--font-display);`
    *   Increase font size slightly for readability.

### 2. Update `docs/app.js`
*   In `createMemberTile(member)`:
    *   Extract `member.ethicsScore`.
    *   Calculate ethics color: if null/undefined -> `#94a3b8` (neutral). If `0` -> `#dc2626` (Red), `50` -> `#f59e0b` (Yellow), `100` -> `#16a34a` (Green). Can interpolate or use thresholds based on exact score.
    *   Modify the generated HTML string to wrap the photo/initials in `<div class="tile-photo-wrapper">`.
    *   Inject the Party badge and Ethics badge into the wrapper.
    *   Remove `.tile-badge-row`.
*   In `applyNominateTint(tileEl, dim1)`:
    *   Remove CSS class toggles (`tint-blue`, etc.).
    *   Implement the color math:
        ```javascript
        if (dim1 === null || dim1 === undefined || dim1 === 0) {
            tileEl.style.backgroundColor = '#B0B0B0';
            return;
        }
        const distance = Math.abs(dim1);
        const tintStrength = 0.12 + 0.88 * Math.pow(distance, 0.85);
        const targetRgb = dim1 < 0 ? [90, 130, 194] : [196, 92, 92]; // Blue or Red
        const baseRgb = [176, 176, 176]; // Base Gray

        const r = Math.round(baseRgb[0] * (1 - tintStrength) + targetRgb[0] * tintStrength);
        const g = Math.round(baseRgb[1] * (1 - tintStrength) + targetRgb[1] * tintStrength);
        const b = Math.round(baseRgb[2] * (1 - tintStrength) + targetRgb[2] * tintStrength);

        tileEl.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
        ```
