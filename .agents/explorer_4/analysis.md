# YGN Grid UI Update - Analysis Report

## Observation
- **Grid Layout**: Currently, `.members-grid` in `docs/styles.css` uses `grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))` with `gap: 1rem;`. This does not explicitly enforce 4 columns on desktop.
- **Tile Styling**: `docs/styles.css` sets `.member-tile` to have a standard card border radius (`--radius-card` is 12px), and `.tile-photo` is an 80px circle. The name and district use standard body fonts. Party badges sit below the text in a `.tile-badge-row`.
- **Dynamic Background Color**: `docs/app.js` uses `applyNominateTint()` to apply CSS classes (`.tint-blue`, `.tint-red`, etc.) based on the NOMINATE `dim1` score. The current logic uses basic opacity scaling via `--tint-opacity` and a CSS linear-gradient.
- **Data Integration & Fallback**: `fetchJsonWithStaticFallback()` is already implemented in `app.js` and properly falls back to `docs/data/officials.json` if the API fails. However, the static data does not contain an `ethics` score property, requiring a resilient fallback in the UI.

## Logic Chain
1. **Responsive Grid (R1)**: Update `.members-grid` in `docs/styles.css` to use `grid-template-columns: repeat(4, 1fr); gap: 24px;` (or 32px) for desktop screens. Use `@media` queries to step down to 3, 2, and 1 column(s) on smaller viewports.
2. **Tile Redesign (R2)**: 
   - Modify `.member-tile` to have `border-radius: 36px` (within 32-44px spec).
   - Wrap the portrait (`.tile-photo`) in a new relative container element (`.portrait-container`).
   - Make the portrait larger (`width: 100%; aspect-ratio: 1; border-radius: 32px; object-fit: cover`).
   - Move the party badge and create a new ethics badge, setting them to `position: absolute;` within the `.portrait-container`. Place the party badge at `bottom: 0; left: 0;` and the ethics badge at `bottom: 0; right: 0;` using negative margins or translations to overlap.
   - Update `.tile-name` and `.tile-meta` (district) to use `font-family: var(--font-display);` (which points to 'Playfair Display').
3. **Dynamic Coloring (R3)**:
   - Rewrite `applyNominateTint(tileEl, dim1)` in `docs/app.js` to implement the required math:
     - Check if `dim1 === null || dim1 === 0`, set background to `#B0B0B0`.
     - Calculate distance: `distanceFromCenter = Math.abs(dim1)`.
     - Calculate strength: `tintStrength = 0.12 + 0.88 * Math.pow(distanceFromCenter, 0.85)`.
     - Compute the final RGB color by linearly interpolating between `#B0B0B0` (176, 176, 176) and either `#5A82C2` (90, 130, 194) or `#C45C5C` (196, 92, 92).
     - Apply this directly to `tileEl.style.backgroundColor`.
4. **Data Handling (R4)**:
   - In `createMemberTile(member)`, attempt to read `member.ethics` (or `member.ethicsScore`).
   - If present, map to the specified color scale (Red=0, Yellow/Orange=50, Dark Green=100).
   - If missing/null (as it is in `docs/data/officials.json`), assign a neutral fallback color (e.g., Gray). 
   - Build the HTML snippet for the ethics indicator using this color.

## Caveats
- **Ethics Data Location**: The exact JSON path for the ethics score from the FastAPI backend is unknown. We will check `member.ethics` and `member.ethicsScore` as a best effort. The neutral placeholder rule will safely catch missing values.
- **Mix Function**: JavaScript lacks a built-in color `mix` function, so we must write a helper to parse and interpolate the RGB values for the NOMINATE background color.

## Conclusion
The update requires localized structural changes in `createMemberTile` inside `docs/app.js` to reorganize the DOM (introducing `.portrait-container` and badges), a rewrite of `applyNominateTint` to implement the strict mathematical color mixing, and CSS updates in `docs/styles.css` to manage the grid columns, border radii, and absolute positioning of the badges.

## Verification Method
1. Start an HTTP server in the `docs` folder.
2. View `index.html` in a desktop browser. Verify 4 columns exist and gap spacing is between 24-32px.
3. Resize the window to verify the columns collapse logically.
4. Verify tile design matches R2 visually (rounded corners, overlapping circles).
5. Ensure ethics score circles default to gray/neutral (due to missing static data).
6. Verify the tile backgrounds mathematically map to the formulas using browser DevTools by inspecting the injected `style="background-color: rgb(...);"` on `.member-tile`.
