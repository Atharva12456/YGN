# Integration Risk Analysis — YGN Tile Redesign

**Explorer 3 (Integration Analyst) | 2026-07-05T07:32Z**

**Summary**: 10 integration concerns were analyzed against the current codebase (`app.js` 818 lines, `styles.css` 695 lines, `index.html` 126 lines). Two concerns are **HIGH** risk (initials fallback, CSS conflicts), four are **MEDIUM** risk (popover positioning, skeleton tiles, NOMINATE edge cases, outside click handler), and four are **LOW** risk. Detailed mitigations and a testing checklist are provided.

---

## 1. Observation

### Files Examined
| File | Lines | Key Sections |
|------|-------|-------------|
| `docs/app.js` | 818 | `createMemberTile` (441–531), `applyNominateTint` (540–561), `showPopover` (665–703), `handleSearch` (719–746), outside-click handler (807–816) |
| `docs/styles.css` | 695 | `.member-tile` (335–382), `.tile-photo` (385–392), `.tile-initials` (395–409), `.skeleton-tile` (527–553), `.error-state/.empty-state` (581–610), `.members-grid` (328–332) |
| `docs/index.html` | 126 | `#members-grid` (line 76), popover (118–122) |
| `ORIGINAL_REQUEST.md` | 175 | Full requirements R1–R9, acceptance criteria |

### Current Tile HTML Structure (app.js lines 480–504)
```html
<div class="member-tile" tabindex="0" role="listitem" aria-label="...">
  <img class="tile-photo" src="..." onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
  <div class="tile-initials" style="display:none;">AB</div>
  <div class="tile-name">Name</div>
  <div class="tile-meta">State – District</div>
  <div class="tile-meta">Chamber</div>
  <div class="tile-badge-row">
    <span class="tile-party-badge party-D">D</span>
  </div>
</div>
```

### Proposed New Structure (from requirements R1–R6)
```html
<div class="member-tile" tabindex="0" role="listitem" aria-label="..." style="background-color: #...">
  <div class="portrait-wrapper">  <!-- NEW: position:relative wrapper -->
    <img class="tile-photo" src="..." onerror="...">
    <div class="tile-initials" style="display:none;">AB</div>
    <div class="party-badge">D</div>         <!-- NEW: overlaid bottom-left -->
    <div class="ethics-badge"></div>          <!-- NEW: overlaid bottom-right -->
  </div>
  <div class="tile-name">Name</div>
  <div class="tile-meta">TX – District 22</div>
</div>
```

---

## 2. Logic Chain — Concern-by-Concern Analysis

### Concern 1: Popover Positioning — MEDIUM RISK

**Observation**: `showPopover()` at line 678 uses `anchorEl.getBoundingClientRect()` where `anchorEl` is the `.member-tile` div. The popover is positioned at `rect.right + margin` horizontally and `rect.top` vertically.

**Logic**: The new tiles will be significantly larger (R1 requires 32–44px corner radius, R2 requires 4-per-row instead of current `repeat(auto-fill, minmax(200px, 1fr))`). With only 4 tiles per row, each tile will be ~25% of the grid width minus gaps. The `rect.right + margin` positioning places the popover to the right of the tile. With wider tiles, `rect.right` will be further right, potentially pushing the popover off-screen more often. The existing fallback (line 688: `left = rect.left - popoverWidth - margin`) handles this, but with taller tiles, vertical positioning may also be affected.

**Risk**: MEDIUM — The clamping logic (lines 686–696) handles viewport bounds, but with bigger tiles there will be more frequent fallback to left-side positioning, and on smaller screens the popover may overlap the tile more.

**Mitigation**: No JS changes needed — the existing clamping is sufficient. But consider whether the popover should position below the tile instead of beside it when tiles become wider. The implementer should test with browser DevTools at various viewport widths.

---

### Concern 2: Initials Fallback — HIGH RISK ⚠️

**Observation**: Line 488:
```javascript
onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
```
Currently, `<img>` is immediately followed by `<div class="tile-initials">`, so `this.nextElementSibling` correctly targets the initials div.

**Logic**: In the new structure, both the `<img>` and `<div class="tile-initials">` will be inside a `portrait-wrapper`. If the portrait wrapper places any element between the `<img>` and the initials div (such as the party badge), `this.nextElementSibling` would point to the wrong element. Even if the initials div remains the immediate next sibling of `<img>`, adding the party badge or ethics badge between them would break this.

**Risk**: HIGH — If the worker inserts badge elements between `<img>` and `.tile-initials` inside the wrapper, the onerror handler silently fails. The initials never show; the user sees a broken tile with no visual fallback.

**Mitigation**: 
- **Option A (Recommended)**: Change onerror to use a class-based selector instead of sibling traversal:
  ```javascript
  onerror="this.style.display='none'; this.closest('.portrait-wrapper').querySelector('.tile-initials').style.display='flex';"
  ```
- **Option B**: Ensure `<img>` is always immediately followed by `.tile-initials` in the HTML, with badges placed after initials.

**Structural Requirement**: The `<img>` and `.tile-initials` MUST be adjacent siblings, OR the onerror handler must be updated to use a non-positional selector.

---

### Concern 3: Skeleton Tiles — MEDIUM RISK

**Observation**: `renderSkeletons()` (lines 331–345) creates:
```html
<div class="skeleton-tile">
  <div class="skeleton-circle"></div>       <!-- 80x80 circle -->
  <div class="skeleton-line wide"></div>    <!-- 80% width -->
  <div class="skeleton-line medium"></div>  <!-- 60% width -->
  <div class="skeleton-line narrow"></div>  <!-- 40% width -->
</div>
```
CSS `.skeleton-circle` is 80×80px circular (line 540–553). `.skeleton-tile` uses current card styling: `border-radius: var(--radius-card)` (12px), `padding: 1.25rem`.

**Logic**: The new tiles have:
- Corner radius 32–44px (R1) vs current 12px
- Portrait is a large rounded-rectangle (not a circle) (R3)
- No party badge row (badge is overlaid on portrait)
- Only name + district below portrait (no chamber, no badge row)

If the skeleton structure isn't updated, the loading state will look completely different from the actual tiles, creating a jarring visual transition. The mismatch won't cause functional breakage, but it will look unprofessional.

**Risk**: MEDIUM — Visual mismatch only; no functional impact. But the skeleton-shimmer animation itself will continue working regardless of shape changes.

**Mitigation**: Update the skeleton to match the new card proportions:
```html
<div class="skeleton-tile">
  <div class="skeleton-portrait"></div>  <!-- Rounded-rect, matches new portrait -->
  <div class="skeleton-line wide"></div>  <!-- Name placeholder -->
  <div class="skeleton-line medium"></div>  <!-- District placeholder -->
</div>
```
Update CSS: `.skeleton-portrait` should use `border-radius: 28–40px`, aspect-ratio similar to portrait, and width ~85% of card. Remove the `.skeleton-circle` class or keep for backward compat. The shimmer animation (`skeleton-shimmer`) is defined on `background` properties and will work with any shape.

---

### Concern 4: Focus/Keyboard Navigation — LOW RISK

**Observation**: `createMemberTile()` at line 475 sets `tabindex='0'` on the `.member-tile` div. Focus and blur event listeners are attached at lines 516–523. CSS focus-visible rule exists at lines 353–356.

**Logic**: Since `tabindex` is on the outer `.member-tile` div and that div is preserved in the redesign, keyboard navigation is unaffected by internal structure changes. The `focus` and `blur` events fire on the `.member-tile` element, not on its children. Adding a portrait wrapper and badges inside doesn't change focusability.

**Risk**: LOW — No changes needed unless the implementer accidentally puts `tabindex` on a child element instead.

**Mitigation**: Verify that `tabindex='0'` remains on the `.member-tile` div, not moved to any inner element. The `:focus-visible` outline (line 354) will need its `outline-offset` reviewed since the new card has larger corner radius (32–44px), but this is cosmetic only.

---

### Concern 5: Search/Filter Re-render — LOW RISK

**Observation**: `handleSearch()` (line 719) calls `renderGrid()` (line 419) which calls `createMemberTile()` for each member. `renderGrid()` clears the grid with `innerHTML = ''` (line 420), then appends all new tiles via a DocumentFragment.

**Logic**: Each search keystroke re-creates all matching tiles from scratch. The NOMINATE score is fetched per tile in `createMemberTile()` at line 527 (`fetchNominate(bioguideId, tile)`). However, `fetchNominate` checks `nominateCache` first (line 571), so repeated renders don't trigger network requests — cached scores are applied immediately.

The new tile structure (portrait wrapper, badges, computed background color) is all built inside `createMemberTile()`, so each re-render constructs the full tile correctly. There is no initialization that happens outside of `createMemberTile()` that would be lost on re-render.

**Risk**: LOW — The fire-and-forget pattern with caching is robust. Re-renders apply cached NOMINATE colors instantly.

**Mitigation**: None needed, but the implementer should verify that the new `applyNominateTint()` function (which will set inline `background-color` instead of CSS classes) works correctly when the tile element is brand-new (from re-render) — i.e., no stale styles from a previous tile instance.

---

### Concern 6: NOMINATE Score Edge Cases — MEDIUM RISK

**Observation**: Current `applyNominateTint()` (lines 540–561):
- `dim1 === null || dim1 === undefined` → adds `tint-gray` class
- `dim1 < -0.3` → blue tint with CSS gradient
- `dim1 > 0.3` → red tint with CSS gradient
- `-0.3 ≤ dim1 ≤ 0.3` → neutral (no tint)

The new formula (R7 from ORIGINAL_REQUEST.md, lines 86–100):
```
baseGray = #B0B0B0
blueTarget = #5A82C2
redTarget = #C45C5C
directionColor = nominateScore < 0 ? blueTarget : redTarget
distanceFromCenter = abs(nominateScore)
If nominateScore is exactly 0: background = baseGray
Otherwise: tintStrength = 0.12 + 0.88 * (distanceFromCenter ^ 0.85)
           background = mix(baseGray, directionColor, tintStrength)
```

**Edge cases to handle**:

| Input | Expected Output | Risk |
|-------|----------------|------|
| `dim1 = 0` | Exactly `#B0B0B0` | LOW — explicit check for `=== 0` |
| `dim1 = null` | `#B0B0B0` (neutral gray) | LOW — null check exists |
| `dim1 = undefined` | `#B0B0B0` (neutral gray) | LOW — undefined check exists |
| `dim1 = -1.0` | Fully blue: mix at strength `0.12 + 0.88 * 1.0 = 1.0` → pure `#5A82C2` | LOW |
| `dim1 = +1.0` | Fully red: mix at strength 1.0 → pure `#C45C5C` | LOW |
| `dim1 = -0.1` | Very slight blue tint: `distFromCenter = 0.1`, `0.1^0.85 ≈ 0.1413`, strength = `0.12 + 0.88*0.1413 ≈ 0.2443`, mix 24% toward blue | MEDIUM — must verify not too subtle |
| `dim1 = +0.5` | Moderate red: `0.5^0.85 ≈ 0.5539`, strength = `0.12 + 0.88*0.5539 ≈ 0.6074`, mix ~61% toward red | LOW |
| `dim1 > 1.0` (e.g. 1.5) | Should be clamped to 1.0 | MEDIUM — no clamping in spec formula |
| `dim1 < -1.0` (e.g. -1.5) | Should be clamped to -1.0 | MEDIUM — no clamping in spec formula |
| `dim1 = NaN` | Should be treated as null → gray | MEDIUM — `NaN !== null` and `NaN !== undefined` |
| `dim1 = "string"` | Should be treated as null → gray | LOW — `typeof data.dim1 === 'number'` check at line 589 prevents this |

**Risk**: MEDIUM — The formula itself is simple, but clamping and NaN handling are not in the spec and the worker must add them.

**Mitigation**:
1. Clamp `distanceFromCenter` to `[0, 1]` before computing tint strength: `const dist = Math.min(1, Math.abs(dim1))`
2. Add NaN guard: `if (dim1 === null || dim1 === undefined || Number.isNaN(dim1))` → gray
3. The `clamp()` helper already exists at line 73 — use it
4. Implement `mix()` as channel-by-channel interpolation:
   ```javascript
   function mixColor(color1, color2, t) {
     // color1, color2 are [r, g, b] arrays, t is 0..1
     return color1.map((c, i) => Math.round(c + (color2[i] - c) * t));
   }
   ```

---

### Concern 7: CSS Conflicts — HIGH RISK ⚠️

**Observation**: Current CSS contains these NOMINATE tinting rules (lines 359–382):
```css
.member-tile.tint-blue {
  background: linear-gradient(135deg,
    rgba(59, 130, 246, calc(var(--tint-opacity, 0.18) * 1)),
    var(--color-surface));
}
.member-tile.tint-red {
  background: linear-gradient(135deg,
    rgba(239, 68, 68, calc(var(--tint-opacity, 0.18) * 1)),
    var(--color-surface));
}
.member-tile.tint-neutral { background: var(--color-surface); }
.member-tile.tint-gray { background: var(--color-surface); border-color: ... }
```

Current JS `applyNominateTint()` (line 542) **adds these CSS classes** to tiles:
```javascript
tileEl.classList.add('tint-blue');  // or tint-red, tint-neutral, tint-gray
```

The new approach (R7) sets background color via **inline style**:
```javascript
tileEl.style.backgroundColor = computedColor;
```

**Logic**: CSS specificity conflict — `background` shorthand in `.member-tile.tint-blue` is a class selector (specificity 0,2,0). Inline `style="background-color: ..."` has higher specificity (1,0,0,0). However, there's a critical distinction: `background` (shorthand) and `background-color` (longhand) are different properties. Setting `background-color` inline will NOT override a `background: linear-gradient(...)` set by a CSS class, because `background` shorthand sets `background-image` (the gradient), `background-color`, and other sub-properties simultaneously. The gradient from the class will persist and paint over the inline `background-color`.

**Scenario**: If the worker:
1. Updates `applyNominateTint()` to set inline `background-color` ✅
2. But forgets to remove the old CSS tint classes from JS ❌
3. OR forgets to remove the old CSS rules from the stylesheet ❌

Then tiles with NOMINATE scores will get BOTH the old gradient background (from the CSS class that's still being added) AND the new flat color (from inline style). The gradient wins visually.

**Risk**: HIGH — This is the most likely integration bug. The old `applyNominateTint()` function actively adds classes (`tint-blue`, `tint-red`, etc.) and the old CSS rules define `background` (not just `background-color`). Both must be cleaned up.

**Mitigation** (all three are required):
1. **JS**: Rewrite `applyNominateTint()` to NOT add any tint classes. Remove lines 542, 545, 553, 555, 559.
2. **CSS**: Delete the four `.member-tile.tint-*` rules (lines 359–382), or at minimum the `background` declarations.
3. **CSS**: Delete the CSS custom properties `--color-tint-blue`, `--color-tint-red`, `--color-tint-gray` (lines 21–23) — they're no longer needed.
4. **JS**: Use inline `style.background` (not `style.backgroundColor`) to be safe, since `background` shorthand overrides everything.

---

### Concern 8: Performance — LOW RISK

**Observation**: 535+ tiles, each needing NOMINATE color computation. The formula is:
```
tintStrength = 0.12 + 0.88 * (Math.abs(dim1) ** 0.85)
R = Math.round(baseR + (targetR - baseR) * tintStrength)
G = Math.round(baseG + (targetG - baseG) * tintStrength)
B = Math.round(baseB + (targetB - baseB) * tintStrength)
```

**Logic**: This is 3 multiplications, 3 additions, 3 rounds, 1 power operation per tile. For 535 tiles: ~535 × ~10 ops = ~5,350 operations. Modern JS engines execute billions of operations per second. Even on mobile, this completes in well under 1ms.

The NOMINATE fetch (`fetchNominate`) is fire-and-forget (line 527). Each fetch independently applies its result to the tile. With 535 concurrent fetches, browser limits (typically 6 connections per hostname) throttle network, not CPU. Cached re-renders (from search) skip network entirely.

**Risk**: LOW — No jank concern whatsoever.

**Mitigation**: None needed. The `Math.pow()` call with `0.85` is the most expensive operation but is negligible at this scale.

---

### Concern 9: Outside Click Handler — MEDIUM RISK

**Observation**: Lines 807–816:
```javascript
document.addEventListener('click', (e) => {
  if (
    popoverEl.classList.contains('visible') &&
    !popoverEl.contains(e.target) &&
    !e.target.closest('.member-tile')
  ) {
    hidePopover();
  }
});
```

**Logic**: `e.target.closest('.member-tile')` traverses up the DOM from the click target to find a `.member-tile` ancestor. This works correctly regardless of internal tile structure — clicking on a portrait wrapper, badge, image, or name div will all bubble up to the `.member-tile` div.

However, there's a subtle issue: if the new badges (party badge, ethics circle) use `position: absolute` and `overflow: visible` on the portrait wrapper, clicking on a badge that visually extends outside the portrait but is still within the `.member-tile` bounds is fine. But if any badge element is positioned OUTSIDE the `.member-tile` bounding box via negative margins or transforms, `.closest('.member-tile')` still works since it checks DOM ancestry, not visual position.

**Risk**: MEDIUM — Low probability of actual breakage, but worth verifying.

**Mitigation**: Ensure all badge elements are DOM children of `.member-tile` (not siblings or portaled). The worker should NOT use `pointer-events: none` on the portrait wrapper, as that would prevent click events from reaching `.member-tile` via bubbling. If badges need their own click handlers in the future, ensure `stopPropagation()` is not used.

---

### Concern 10: Error/Empty States — LOW RISK

**Observation**: Lines 581–591:
```css
.error-state,
.empty-state {
  ...
  grid-column: 1 / -1;
}
```
Current grid: `grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))` (line 330).

**Logic**: The `grid-column: 1 / -1` rule spans all columns regardless of how many there are. Changing from `auto-fill` with `minmax(200px, 1fr)` to a fixed `repeat(4, 1fr)` (or `repeat(auto-fill, minmax(~280px, 1fr))` for 4-col) doesn't affect `1 / -1` — it always spans the full row.

**Risk**: LOW — `grid-column: 1 / -1` is column-count-agnostic by design.

**Mitigation**: None needed. Just verify that the error/empty state divs are still direct children of `#members-grid`, not wrapped in any intermediate container.

---

## 3. Caveats

- **Ethics score API**: The requirements mention an ethics score circle (R5), but no API endpoint provides ethics data. The score-to-color function must be implemented and ready but will always show gray placeholder for now. This wasn't in the original codebase at all — entirely new code.
- **Responsive behavior**: The requirement says "natural responsive wrapping" but doesn't specify exact breakpoints for 3-col, 2-col, 1-col transitions. The current 600px breakpoint forces 1-col. The worker will need to decide intermediate breakpoints.
- **Portrait aspect ratio**: R3 says "vertical aspect ratio (like an official headshot)" but the bioguide photos vary. Some are landscape, some are very old. `object-fit: cover` handles this, but cropping may be aggressive on some photos.
- **Not analyzed**: config.js contents, data/ static fallback files, GitHub push integration. These are outside scope.

---

## 4. Conclusion

### Risk Summary Table

| # | Concern | Risk | Action Required |
|---|---------|------|----------------|
| 1 | Popover positioning | MEDIUM | Test at various viewports; existing clamping is likely sufficient |
| 2 | Initials fallback (`nextElementSibling`) | **HIGH** | Change onerror to use `.closest().querySelector()` OR keep img+initials adjacent |
| 3 | Skeleton tiles | MEDIUM | Update skeleton HTML and CSS to match new card proportions |
| 4 | Focus/keyboard navigation | LOW | No changes needed; verify `tabindex` stays on `.member-tile` |
| 5 | Search/filter re-render | LOW | No changes needed; caching handles re-renders |
| 6 | NOMINATE edge cases | MEDIUM | Add clamping, NaN guard, implement mix() correctly |
| 7 | CSS conflicts (old tint classes) | **HIGH** | Remove ALL old tint CSS classes from JS AND old CSS rules from stylesheet |
| 8 | Performance | LOW | No concern |
| 9 | Outside click handler | MEDIUM | Ensure all elements are DOM children of `.member-tile` |
| 10 | Error/empty states | LOW | No changes needed |

### Critical Requirements for the Worker

1. **MUST** either keep `<img>` and `.tile-initials` as adjacent siblings inside the portrait wrapper, OR update the `onerror` handler to use a non-positional selector.
2. **MUST** remove old CSS tint classes (`tint-blue`, `tint-red`, `tint-neutral`, `tint-gray`) from `applyNominateTint()` JS function.
3. **MUST** remove old `.member-tile.tint-*` CSS rules from `styles.css`.
4. **MUST** use inline `style.background` (not `style.backgroundColor`) to ensure full override.
5. **MUST** clamp NOMINATE score to [-1, 1] before computing color.
6. **MUST** handle `NaN` dim1 values (treat as null → gray).
7. **SHOULD** update skeleton tiles to match new card proportions.
8. **SHOULD** implement `getEthicsColor(score)` function even though no data exists yet.

### New HTML Structure Recommendation

```html
<div class="member-tile" tabindex="0" role="listitem" aria-label="Name"
     style="background: #computed;">
  <div class="portrait-wrapper">
    <img class="tile-photo" src="..." alt="Name" loading="lazy"
         onerror="this.style.display='none'; this.closest('.portrait-wrapper').querySelector('.tile-initials').style.display='flex';">
    <div class="tile-initials" style="display:none;" aria-hidden="true">AB</div>
    <div class="party-badge party-D" aria-label="Democrat">D</div>
    <div class="ethics-badge" aria-label="Ethics score unavailable"></div>
  </div>
  <div class="tile-name">Representative Name</div>
  <div class="tile-district">TX – District 22</div>
</div>
```

Key structural rules:
- `.portrait-wrapper` must have `position: relative` for absolute badge positioning
- `.party-badge` positioned `bottom: -8px; left: 8px` (approximate)
- `.ethics-badge` positioned `bottom: -8px; right: 8px` (approximate)
- `<img>` and `.tile-initials` should be the first two children of `.portrait-wrapper`
- All elements must be DOM children of `.member-tile` for click bubbling

---

## 5. Verification Method

### Testing Checklist for the Reviewer

#### HIGH-priority checks
- [ ] **Initials fallback**: Set network to offline or use a non-existent bioguide ID. Verify the initials div shows instead of a broken image icon.
- [ ] **CSS conflicts**: Open DevTools → Elements panel → select a tile with a NOMINATE score. Verify:
  - No `tint-blue`, `tint-red`, `tint-neutral`, or `tint-gray` CSS classes on the element
  - The `background` is set via inline style
  - No computed `background-image: linear-gradient(...)` from old CSS rules
- [ ] **Old CSS rules removed**: Search `styles.css` for `.tint-blue`, `.tint-red`, `.tint-neutral`, `.tint-gray` — should not exist

#### MEDIUM-priority checks
- [ ] **NOMINATE edge cases**: Use DevTools console to test:
  ```javascript
  // Test with the new applyNominateTint or computeNominateColor function:
  computeNominateColor(0)      // Should return exactly #B0B0B0
  computeNominateColor(null)   // Should return #B0B0B0
  computeNominateColor(NaN)    // Should return #B0B0B0
  computeNominateColor(-1.0)   // Should return #5A82C2
  computeNominateColor(1.0)    // Should return #C45C5C
  computeNominateColor(-0.1)   // Should be slight blue tint, not pure gray
  computeNominateColor(1.5)    // Should clamp to 1.0, return #C45C5C
  ```
- [ ] **Popover positioning**: Hover over tiles in all 4 columns. Verify popover doesn't overflow viewport. Test at 1024px, 1280px, and 1920px viewport widths.
- [ ] **Skeleton tiles**: Navigate to Members tab — skeletons should visually approximate the new tile proportions (rounded-rect portrait area, not a circle).
- [ ] **Outside click**: Click on the portrait image, the party badge, the ethics circle, and the name text. Popover should NOT close (all are inside `.member-tile`). Click outside any tile. Popover SHOULD close.

#### LOW-priority checks
- [ ] **Keyboard navigation**: Tab through tiles, verify focus ring is visible with the new border-radius. Press Escape, verify popover closes.
- [ ] **Search re-render**: Type in search, verify tiles re-render with correct NOMINATE colors (from cache, no flash of gray).
- [ ] **Error/empty states**: Disconnect backend, navigate to Members. Error state should span full grid width. Search for nonexistent name. Empty state should span full grid width.
- [ ] **Performance**: Scroll through 535+ tiles. No jank, no layout shifts after NOMINATE colors apply.
- [ ] **No console errors**: Open DevTools Console, navigate between sections, search, hover tiles. Zero JS errors.

### Invalidation Conditions
- If the worker uses a different tile structure than recommended (e.g., no portrait wrapper), re-evaluate concerns #2 and #9
- If the worker keeps the CSS class-based tinting instead of inline styles, concern #7 is N/A but the implementation doesn't match R7
- If the ethics badge gets real data before release, concern about placeholder handling needs re-testing
