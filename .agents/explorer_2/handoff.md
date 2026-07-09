# Handoff Report: YGN Grid UI Update

## 1. Observation
*   **`docs/styles.css`**: Currently uses `gap: 1rem` and `grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))` for `.members-grid`, yielding variable columns rather than exactly 4 on desktop. `.member-tile` has `border-radius: var(--radius-card)` (12px). `.tile-photo` uses `border-radius: 50%` (circular) instead of rounded-rectangle.
*   **`docs/app.js`**: `createMemberTile` places badges in a `.tile-badge-row` below the text. `applyNominateTint` sets CSS opacity variables and classes (`tint-blue`, `tint-red`) based on a linear `dim1` intensity rather than the specified non-linear curve.
*   **Data Integration**: `fetchJsonWithStaticFallback` is implemented and used for fetching `officials.json` and `nominate` scores. Ethics score data is missing from current objects but graceful degradation can be handled in code.

## 2. Logic Chain
1.  Because `.members-grid` doesn't enforce 4 columns, we need to apply `grid-template-columns: repeat(4, 1fr)` for large screens, plus CSS media queries for smaller breakpoints, and change `gap` to `24px` or `32px`.
2.  Because `.member-tile` needs 32-44px rounded corners and `.tile-photo` needs 28-40px corners, we must update those values in CSS.
3.  Because badges must overlap the portrait, the portrait needs a `position: relative` wrapper `.tile-photo-wrapper`, and badges must be `position: absolute` attached to the bottom corners.
4.  Because the background color tint logic strictly requires a power of `0.85`, it must be computed in JavaScript (`applyNominateTint`), and the result injected as an inline `style.backgroundColor` overriding CSS.
5.  Because ethics scores might not be present in the backend immediately, the frontend logic must explicitly check for the `ethicsScore` property and use a neutral color if absent.

## 3. Caveats
*   I have assumed ethics score is directly available as a property like `member.ethicsScore` on the parsed official object. If it is located in a sub-object, the path will need to be adjusted.
*   The API payload does not appear to contain ethics scores currently, so all tiles will likely default to the neutral gray ethics badge color.
*   The color mix logic strictly uses `#B0B0B0`, `#5A82C2`, and `#C45C5C`.

## 4. Conclusion
The implementation strategy should involve updating `docs/styles.css` for grid and badge positioning, and `docs/app.js` to modify HTML structure inside `createMemberTile` and replace `applyNominateTint` with JS-based color blending. The fallback logic is already present and fully functional.

## 5. Verification Method
1.  **Grid Layout**: Resize browser window. Check that the grid goes from 4 columns to 3 to 2 to 1 and gaps stay 24-32px.
2.  **Badges**: Visually verify that circular badges overlap the bottom corners of the rounded-rectangle portrait.
3.  **Dynamic Coloring**: Run the UI, inspect the background color of a strongly partisan tile (e.g. `dim1 = 0.9` or `-0.9`) to confirm the computed rgb code matches the math formula rather than a CSS opacity gradient.
4.  **Static Fallback**: Kill the FastAPI server and reload the page; check if data populates correctly from `docs/data/`.
