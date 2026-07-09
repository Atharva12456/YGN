# Handoff Report: YGN Grid UI Update

## Observation
1. **Grid Layout (R1):** `docs/styles.css` currently uses `grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))` for `.members-grid`, which does not guarantee exactly 4 tiles per row on desktop. Gap is `1rem` (16px), which is smaller than the requested 24px-32px.
2. **Tile Styling (R2):** 
   - Border radius is set via `--radius-card: 12px;` in `styles.css`.
   - `.tile-photo` is `80px` rounded to `50%`.
   - The party badge is an oval (`padding: 2px 8px; border-radius: 20px;`) and placed below the name.
   - The name and location text use the default body font, not `Playfair Display`.
   - Ethics score is missing entirely from `docs/app.js` HTML generation.
3. **Dynamic Coloring (R3):** `applyNominateTint` in `docs/app.js` (lines 405-426) uses discrete CSS classes (`tint-blue`, `tint-red`) and sets an opacity CSS variable. It does not implement the continuous mixing math (`mix(Base Gray, Direction Color, tintStrength)`) required.
4. **Data Integration (R4):** `fetchJsonWithStaticFallback` is implemented in `app.js` and successfully attempts API first then static JSON data fallback, covering R4. However, the static `officials.json` lacks an `ethics` field, meaning the missing-value placeholder logic must be robustly handled in JS.

## Logic Chain
1. To satisfy **R1**, `.members-grid` must be rewritten in `styles.css` using `grid-template-columns: repeat(4, 1fr); gap: 24px;` along with media queries (`@media (max-width: 1024px) { grid-template-columns: repeat(3, 1fr); }`, etc.) to wrap gracefully while ensuring 4 columns on desktop.
2. To satisfy **R2**, we must:
   - Update `:root` in `styles.css` to `--radius-card: 32px;` or `40px`.
   - Update `.tile-photo` to be larger and apply a border radius of ~`32px`.
   - In `app.js`, wrap the portrait `<img>` in a relatively-positioned `<div class="portrait-wrapper">`.
   - Inside `portrait-wrapper`, insert absolute-positioned circular `party-badge` (bottom-left) and `ethics-badge` (bottom-right).
   - Read `ethicsScore` from the member object (e.g. `getMemberField(member, 'ethics', 'ethicsScore')`) and calculate a color gradient or use a neutral fallback if missing.
   - Apply `font-family: var(--font-display);` to `.tile-name` and `.tile-meta`.
3. To satisfy **R3**, `applyNominateTint` must be rewritten entirely in `app.js` to compute the exact RGB value using the provided math (`Math.pow(Math.abs(dim1), 0.85)`), then apply it directly to `tileEl.style.backgroundColor`.
4. To satisfy **R4**, the existing static fallback architecture is sound, but we just need to ensure that the code gracefully degrades to a neutral color (e.g. `#94A3B8`) when the ethics score is missing.

## Caveats
- The exact field name for the ethics score in the real backend data is unknown. I have assumed it could be accessed via `getMemberField(member, 'ethics', 'ethicsScore')`. If the backend uses a different key, the JS will gracefully fall back to the neutral placeholder, but won't show the real score until the key is updated.
- The tint math formula might result in slightly dark backgrounds; ensuring text contrast remains readable is essential, so default text color should probably remain dark.

## Conclusion
The implementation requires targeted modifications to `docs/app.js` (rewriting `applyNominateTint` and `createMemberTile`) and `docs/styles.css` (updating `.members-grid`, `:root` variables, and adding `.portrait-wrapper` / badge positioning). The static data fallback is already functional but requires UI logic to handle missing ethics scores.

## Verification Method
1. Open `docs/index.html` in a browser.
2. Verify exactly 4 tiles per row on a 1920x1080 viewport, scaling down appropriately when resizing the window.
3. Verify cards have large border radii (32px+), and badges overlap the bottom corners of the large portrait image.
4. Check that a neutral-colored ethics badge appears, displaying `?` or missing state.
5. In the dev console, inject a mock NOMINATE score to a tile (e.g. `applyNominateTint(tile, 1)`) and ensure the exact RGB calculations result in the expected tint (`#C45C5C` or equivalent RGB).
6. Verify font is `Playfair Display` for names.
