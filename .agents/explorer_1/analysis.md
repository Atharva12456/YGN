# YGN Grid and Styling Analysis Report

## Summary
The current implementation of the YGN grid uses a responsive CSS grid with dynamic tile generation in JavaScript. Data is fetched from a FastAPI backend with a static fallback. To meet requirements R1-R4, `app.js` and `styles.css` require structural changes to typography, grid constraints, exact color blending logic, and tile layout, though the existing data fetching mechanism (R4) is already compliant.

## 1. Observation
- **Grid Layout (`styles.css:328`)**: The grid currently uses `.members-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }`, resulting in a fluid layout based on 200px columns.
- **Tile Styling (`styles.css:335`, `app.js:361`)**: Tiles have `12px` border-radius (`var(--radius-card)`). Portraits are `80x80` circles (`border-radius: 50%`). Badges are placed inside `.tile-badge-row` below the text. Typography uses the `Inter` font.
- **Dynamic Background (`app.js:405`)**: Uses predefined CSS classes (`tint-blue`, `tint-red`) with CSS custom property `--tint-opacity` proportional to the absolute NOMINATE score, overlaid on a white surface using a linear gradient (`styles.css:359`).
- **Data Integration (`app.js:76`, `app.js:238`)**: `fetchJsonWithStaticFallback` attempts to hit the API, falling back to local `data/officials.json`. The `/health` endpoint logic (`app.js:126`) and fallback is fully implemented.
- **Backend API (`app.py:128`)**: Exposes `/officials` and `/officials/{bioguide_id}/nominate`, but does not provide ethics scores.

## 2. Logic Chain
- **Requirement R1 (Responsive Grid)**: Since R1 requires exactly 4 tiles per row on normal screens with 24px-32px gaps, the `.members-grid` CSS needs an update to explicitly use `grid-template-columns: repeat(4, 1fr)` on large screens, utilizing media queries for smaller breakpoints. The gap needs to be increased to `1.5rem` or `2rem`.
- **Requirement R2 (Tile Design)**: The tile layout in `app.js` needs a DOM restructure. Specifically, the portrait needs a new wrapper with `position: relative` to allow the party badge (`position: absolute; bottom: 0; left: 0`) and ethics badge (`position: absolute; bottom: 0; right: 0`) to overlap. CSS border radii must be increased to `32px-44px` for tiles and `28px-40px` for portraits (`object-fit: cover` is already applied but needs to be maintained for the new dimensions).
- **Requirement R3 (Color Math)**: The current linear gradient approach is incorrect. `app.js` needs to calculate the precise hex/rgb background color dynamically using the provided formula (`mix(Base Gray, Direction Color, 0.12 + 0.88 * distance^0.85)`) and assign it via `tileEl.style.backgroundColor`.
- **Requirement R4 (Data & Fallback)**: The existing implementation already correctly attempts API fetching and falls back to static JSON. Because the ethics score is not in the backend or current mock data, the missing ethics score placeholder logic ("neutral placeholder color") will just apply by default during rendering.

## 3. Caveats
- The backend (`app.py`) does not contain an endpoint or data field for "ethics score". The UI will thus rely on the "neutral placeholder color" fallback as specified in the acceptance criteria unless new data sources are provided.
- The term "normal desktop screens" isn't assigned an exact pixel value, but typical media queries (e.g., `>= 1024px`) can be safely assumed for the 4-column constraint.

## 4. Conclusion
The implementation can be achieved in **one single milestone**. 
The changes are tightly coupled across `app.js` (DOM structure, color math) and `styles.css` (layout, visual styling) and form a single cohesive feature.

### Recommended Implementation Steps:
1. **CSS Grid (`styles.css`)**: Update `.members-grid` to `grid-template-columns: repeat(4, 1fr)` and `gap: 24px`. Add media queries (`@media`) to reduce column count gracefully on narrower screens.
2. **Typography & Styling (`styles.css`)**: Update tile variables to use `border-radius: 36px` (tile) and `32px` (image). Apply `font-family: var(--font-display)` to the name and district.
3. **DOM Layout (`app.js`)**: Wrap the image inside a container and position the party and ethics badges as absolute children overlapping the bottom corners of the image. Add a neutral placeholder badge for ethics if no score is found.
4. **Color Calculation (`app.js`)**: Rewrite `applyNominateTint` to implement the exact color mixing math: calculate the target color and tint strength, interpolate the RGB values, and apply it directly to `tileEl.style.backgroundColor`.

## 5. Verification Method
- **Static Assets**: Start the local live server on the `docs` folder. Verify grid visually displays 4 columns with proper spacing and text in Playfair Display.
- **Dynamic Logic**: Check the background color of specific tiles with known non-zero NOMINATE scores to ensure the mathematical blend matches the required formula. Inspect a tile missing an ethics score to confirm the neutral placeholder displays.
- **Fallback Functionality**: Turn off the backend server, reload the page, and observe if the grid successfully renders mock data.
