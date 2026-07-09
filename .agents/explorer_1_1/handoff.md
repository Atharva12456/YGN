# Handoff: Grid and Aspect Ratio Update

## 1. Observation
- `docs/styles.css` lines 301-305 currently define `.members-grid` with `grid-template-columns: repeat(4, 1fr);`.
- The `.tile-photo-wrapper` (lines 334-340) and `.tile-photo` (lines 342-348) both have a fixed width of `140px`, with the photo having a height of `160px`.
- Badges (`.party-badge` and `.ethics-badge`, lines 384-407) are positioned absolutely with `left: 0` and `right: 0` inside `.tile-photo-wrapper`.
- The current responsive breakpoints for `.members-grid` are at `1024px` (3 cols), `768px` (2 cols), and `600px` (1 col).
- `docs/app.js` generates the HTML structure matching these CSS classes and does not enforce any inline width/height on the photo itself (except via the CSS classes).

## 2. Logic Chain
- To achieve 6 tiles per row on standard desktop (>1200px), `.members-grid` must be updated to `repeat(6, 1fr)`.
- To create a taller and narrower aspect ratio for the cards and portraits while keeping the badges perfectly aligned, we should reduce the width of `.tile-photo-wrapper` and `.tile-photo` and adjust the height. A width of `100px` and height of `150px` gives a 2:3 aspect ratio, which is noticeably narrower and taller than the original 140x160 (7:8 ratio).
- By updating `.tile-photo-wrapper` width to precisely match `.tile-photo` (both `100px`), the absolutely positioned badges (`left: 0`, `right: 0`) will automatically remain perfectly aligned at the bottom-left and bottom-right corners of the new narrower portrait.
- The responsive breakpoints need to be stepped down gracefully: 5 columns at 1200px, 4 at 1024px, 3 at 768px, 2 at 600px, and 1 at 430px.

## 3. Caveats
- At `100px` width, the `32px` badges will cover slightly more relative horizontal space of the portrait, but since there is 36px space between them (100 - 32*2), it will not overlap the center.
- `border-radius: 32px;` remains on the narrower photo, which may appear more pill-shaped, but we are keeping it intact as per instructions.
- No changes to `app.js` are necessary as all layout/sizing is handled purely by CSS.

## 4. Conclusion
We must update `docs/styles.css` exclusively to implement the new grid and aspect ratio.

### Recommended Fix Strategy:
**In `docs/styles.css`:**
1. Update `.members-grid` (line 301) to `grid-template-columns: repeat(6, 1fr);`.
2. Update `.tile-photo-wrapper` (line 334) width to `100px;`.
3. Update `.tile-photo` (line 342) width to `100px;` and height to `150px;`.
4. Replace the breakpoints at lines 604-614 with:
```css
@media (max-width: 1200px) {
  .members-grid {
    grid-template-columns: repeat(5, 1fr);
  }
}
@media (max-width: 1024px) {
  .members-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}
@media (max-width: 768px) {
  .members-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
```
5. Update the `.members-grid` inside the `max-width: 600px` query (line 648) to `grid-template-columns: repeat(2, 1fr);`.
6. Add `.members-grid { grid-template-columns: 1fr; }` inside the existing `max-width: 430px` query (line 657).

## 5. Verification Method
- Make the changes in `docs/styles.css` as outlined.
- Open `docs/index.html` in a browser.
- Verify that on a viewport > 1200px, the grid displays 6 columns.
- Resize the browser to verify the grid steps down to 5, 4, 3, 2, and 1 columns correctly based on the breakpoints.
- Inspect the profile tiles to confirm they use the taller/narrower aspect ratio and the badges sit at the exact bottom corners of the portraits.
