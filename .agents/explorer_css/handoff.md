# CSS Redesign Analysis — Handoff Report

**Type:** Hard handoff (investigation complete)
**Agent:** Explorer 1 (CSS Redesign Analyst)
**Date:** 2026-07-05T07:32Z

---

## Summary

The redesign requires modifying ~14 existing CSS rules, removing 6 rules (tint/party badge classes), and adding ~8 new CSS rules (portrait wrapper, party badge overlay, ethics circle overlay, new skeleton proportions). The HTML tile structure in `app.js` must also change to wrap the portrait image + overlays in a `.portrait-wrapper` container. Total CSS diff is moderate (~120 lines changed/added, ~45 lines removed).

---

## 1. Observation

### 1.1 Current CSS Custom Properties (styles.css lines 6–35)

| Variable | Current Value | Redesign Impact |
|---|---|---|
| `--color-tint-blue` | `rgba(59,130,246,0.18)` | **REMOVE** — no longer used |
| `--color-tint-red` | `rgba(239,68,68,0.18)` | **REMOVE** — no longer used |
| `--color-tint-gray` | `rgba(148,163,184,0.15)` | **REMOVE** — no longer used |
| `--radius-card` | `12px` | **Do NOT change** (used by stat-card, popover too) |
| `--shadow-card` | `0 2px 8px ...` | Keep for other cards, NOT for member tiles |
| `--font-display` | `'Playfair Display', Georgia, serif` | Already correct |
| `--font-body` | `'Inter', system-ui, sans-serif` | Already correct |

### 1.2 Current Grid Layout (styles.css lines 328–332)

```css
.members-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;    /* = 16px */
}
```

### 1.3 Current Member Tile (styles.css lines 335–356)

```css
.member-tile {
  background: var(--color-surface);     /* #ffffff */
  border-radius: var(--radius-card);    /* 12px */
  padding: 1.25rem;                     /* 20px */
  box-shadow: var(--shadow-card);       /* has shadow */
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: transform ..., box-shadow ...;
  border: 1px solid var(--color-border); /* has border */
}
```

Hover state (lines 347–351):
```css
.member-tile:hover, .member-tile:focus-within {
  transform: translateY(-3px);
  box-shadow: 0 6px 20px rgba(26, 31, 46, 0.15);
}
```

### 1.4 Current NOMINATE Tint Classes (styles.css lines 358–382)

Four CSS rules to be **entirely removed**:
- `.member-tile.tint-blue` (lines 359–365): gradient background
- `.member-tile.tint-red` (lines 367–373): gradient background
- `.member-tile.tint-neutral` (lines 375–377): white background
- `.member-tile.tint-gray` (lines 379–382): white background + gray border

### 1.5 Current Photo (styles.css lines 385–392)

```css
.tile-photo {
  width: 80px;
  height: 80px;
  border-radius: 50%;       /* circle */
  object-fit: cover;
  display: block;
  margin: 0 auto 0.75rem;
}
```

### 1.6 Current Initials Fallback (styles.css lines 395–409)

```css
.tile-initials {
  width: 80px;
  height: 80px;
  border-radius: 50%;      /* circle */
  ...
  margin: 0 auto 0.75rem;
}
```

### 1.7 Current Name/Meta (styles.css lines 411–424)

```css
.tile-name {
  font-weight: 600;
  text-align: center;
  font-size: 0.9rem;
  margin-bottom: 0.25rem;
  line-height: 1.3;
}
.tile-meta {
  text-align: center;
  font-size: 0.78rem;
  color: var(--color-text-muted);   /* gray, NOT black */
  margin-bottom: 0.5rem;
}
```

### 1.8 Current Party Badge (styles.css lines 426–455)

Text pill badge in a flex row:
```css
.tile-party-badge { display: inline-block; padding: 2px 8px; border-radius: 20px; ... }
.party-D { background: rgba(59,130,246,0.15); color: #2563eb; }
.party-R { background: rgba(239,68,68,0.15); color: #dc2626; }
.party-I { background: rgba(148,163,184,0.15); color: #64748b; }
.tile-badge-row { display: flex; justify-content: center; ... }
```

### 1.9 Current Skeleton Tiles (styles.css lines 527–578)

```css
.skeleton-tile { border-radius: var(--radius-card); padding: 1.25rem; box-shadow; border; ... }
.skeleton-circle { width: 80px; height: 80px; border-radius: 50%; ... }
```

### 1.10 Current Responsive (styles.css lines 640–680)

```css
@media (max-width: 600px) {
  .members-grid { grid-template-columns: 1fr; }
  ...
}
```

### 1.11 JS Tile HTML Structure (app.js lines 472–504)

Current HTML output per tile:
```html
<div class="member-tile" tabindex="0" role="listitem" aria-label="Name">
  <img class="tile-photo" src="..." alt="..." loading="lazy" onerror="...">
  <div class="tile-initials" style="display:none;">AB</div>
  <div class="tile-name">Full Name</div>
  <div class="tile-meta">TX – 22</div>
  <div class="tile-meta">House</div>
  <div class="tile-badge-row">
    <span class="tile-party-badge party-D">D</span>
  </div>
</div>
```

### 1.12 JS NOMINATE Tint Application (app.js lines 540–561)

`applyNominateTint()` uses `classList.add('tint-blue')` etc. and `--tint-opacity` CSS variable. This function must be **rewritten** to compute inline `background-color` using the R7 formula.

---

## 2. Logic Chain

### Step 1: Custom Properties

- **`--radius-card`** is used by `.member-tile`, `.skeleton-tile`, `.stat-card`, and `.popover`. If we change it to `36px`, stat-cards and popovers get huge radii (undesirable). **Decision: Do NOT change `--radius-card`. Instead, use a new variable `--radius-tile: 36px` on `.member-tile` and `.skeleton-tile` only.**
- The three `--color-tint-*` variables are only used by the tint classes being removed. They can be deleted.

### Step 2: Grid Layout (R2)

Current: `repeat(auto-fill, minmax(200px, 1fr))`, `gap: 1rem`.
Target: exactly 4 columns on desktop, 28px gap (midpoint of 24–32px), responsive wrapping.

**Recommended approach:** Use `repeat(auto-fill, minmax(240px, 1fr))` with `gap: 28px`. This naturally gives 4 columns on typical desktop widths (~1200px content area) and wraps to fewer columns as viewport shrinks.

### Step 3: Member Tile (R1)

Changes needed on `.member-tile`:
- `border-radius: 36px` → via `var(--radius-tile)`
- `padding: 1.5rem 1.25rem 1.25rem` (generous padding)
- Remove `box-shadow` (set `none`)
- Remove `border` (set `none`)
- Change `overflow: hidden` → `visible` (badges need to slightly extend)
- Background: fallback `#B0B0B0` (JS sets inline)
- Keep `position: relative` (needed for overlays)
- Remove `box-shadow` from transition

### Step 4: Portrait Image (R3)

`.tile-photo` complete restyle:
- `width: 100%` (fills card width within padding)
- `height: auto` + `aspect-ratio: 3/4` (vertical headshot)
- `border-radius: 32px` via `var(--radius-portrait)`
- `margin: 0` (wrapper handles spacing)

`.tile-initials` matching changes:
- Same dimensions and radius as photo
- `font-size: 2.5rem` (larger for bigger space)

### Step 5: Portrait Wrapper (NEW — required for badge overlays)

Party badge and ethics circle are **positioned absolutely over the portrait**. Requires a wrapper:

```html
<div class="portrait-wrapper">
  <img class="tile-photo" ...>
  <div class="tile-initials" style="display:none;">AB</div>
  <span class="party-badge party-D">D</span>
  <span class="ethics-circle"></span>
</div>
```

### Step 6: Party Badge & Ethics Circle (R4, R5)

Old text-pill badge classes removed. New overlay circles positioned absolutely within `.portrait-wrapper`.

### Step 7: Name & District Text (R6)

Both `.tile-name` and `.tile-meta` get `font-family: var(--font-display)` and `color: #000000`.

### Step 8: NOMINATE (R7)

All four `.tint-*` CSS rules removed. Background set via inline style from JS.

---

## 3. Complete Change Specification

### 3.1 CSS Custom Properties to REMOVE (lines 21–23)

```
--color-tint-blue
--color-tint-red
--color-tint-gray
```

### 3.2 CSS Custom Properties to ADD (inside `:root`, after line 30)

```css
--radius-tile: 36px;
--radius-portrait: 32px;
```

### 3.3 CSS Rules to MODIFY

| Selector | Property | Current | New |
|---|---|---|---|
| `.members-grid` (L328) | `grid-template-columns` | `repeat(auto-fill, minmax(200px, 1fr))` | `repeat(auto-fill, minmax(240px, 1fr))` |
| `.members-grid` (L328) | `gap` | `1rem` | `28px` |
| `.member-tile` (L335) | `background` | `var(--color-surface)` | `#B0B0B0` |
| `.member-tile` (L335) | `border-radius` | `var(--radius-card)` | `var(--radius-tile)` |
| `.member-tile` (L335) | `padding` | `1.25rem` | `1.5rem 1.25rem 1.25rem` |
| `.member-tile` (L335) | `box-shadow` | `var(--shadow-card)` | `none` |
| `.member-tile` (L335) | `border` | `1px solid var(--color-border)` | `none` |
| `.member-tile` (L335) | `overflow` | `hidden` | `visible` |
| `.member-tile` (L335) | `transition` | `transform ..., box-shadow ...` | `transform var(--transition-fast)` |
| `.member-tile:hover` (L347) | `box-shadow` | `0 6px 20px ...` | **REMOVE** |
| `.member-tile:hover` (L347) | `transform` | `translateY(-3px)` | `translateY(-2px)` |
| `.tile-photo` (L385) | `width` | `80px` | `100%` |
| `.tile-photo` (L385) | `height` | `80px` | `auto` |
| `.tile-photo` (L385) | `border-radius` | `50%` | `var(--radius-portrait)` |
| `.tile-photo` (L385) | `margin` | `0 auto 0.75rem` | `0` |
| `.tile-photo` (L385) | **ADD** | — | `aspect-ratio: 3/4` |
| `.tile-initials` (L395) | `width` | `80px` | `100%` |
| `.tile-initials` (L395) | `height` | `80px` | `auto` |
| `.tile-initials` (L395) | `border-radius` | `50%` | `var(--radius-portrait)` |
| `.tile-initials` (L395) | `font-size` | `1.5rem` | `2.5rem` |
| `.tile-initials` (L395) | `margin` | `0 auto 0.75rem` | `0` |
| `.tile-initials` (L395) | **ADD** | — | `aspect-ratio: 3/4` |
| `.tile-name` (L411) | **ADD** | — | `font-family: var(--font-display)` |
| `.tile-name` (L411) | `font-weight` | `600` | `700` |
| `.tile-name` (L411) | `font-size` | `0.9rem` | `1.05rem` |
| `.tile-name` (L411) | **ADD** | — | `color: #000000` |
| `.tile-meta` (L419) | **ADD** | — | `font-family: var(--font-display)` |
| `.tile-meta` (L419) | `font-size` | `0.78rem` | `0.82rem` |
| `.tile-meta` (L419) | `color` | `var(--color-text-muted)` | `#000000` |
| `.tile-meta` (L419) | `margin-bottom` | `0.5rem` | `0.15rem` |
| `.skeleton-tile` (L527) | `border-radius` | `var(--radius-card)` | `var(--radius-tile)` |
| `.skeleton-tile` (L527) | `padding` | `1.25rem` | `1.5rem 1.25rem 1.25rem` |
| `.skeleton-tile` (L527) | `box-shadow` | `var(--shadow-card)` | `none` |
| `.skeleton-tile` (L527) | `border` | `1px solid var(--color-border)` | `none` |
| `.skeleton-tile` (L527) | **ADD** | — | `background: #B0B0B0` |
| `.skeleton-circle` (L540) | `width` | `80px` | `100%` |
| `.skeleton-circle` (L540) | `height` | `80px` | `auto` |
| `.skeleton-circle` (L540) | `border-radius` | `50%` | `var(--radius-portrait)` |
| `.skeleton-circle` (L540) | **ADD** | — | `aspect-ratio: 3/4` |
| `.skeleton-circle` (L540) | `margin-bottom` | `0.25rem` | `0.5rem` |

### 3.4 CSS Rules to REMOVE Entirely

| Rule | Lines | Reason |
|---|---|---|
| `.member-tile.tint-blue` | 359–365 | R7: replaced by inline JS |
| `.member-tile.tint-red` | 367–373 | R7: replaced by inline JS |
| `.member-tile.tint-neutral` | 375–377 | R7: no longer used |
| `.member-tile.tint-gray` | 379–382 | R7: no longer used |
| `.tile-party-badge` | 426–433 | R4: replaced by overlay circle |
| `.party-D` | 435–438 | R4: replaced |
| `.party-R` | 440–443 | R4: replaced |
| `.party-I` | 445–448 | R4: replaced |
| `.tile-badge-row` | 450–455 | R4: no longer used |

### 3.5 NEW CSS Rules to Add

```css
/* ── Portrait Wrapper (overlay container) ─────────────────────────────── */
.portrait-wrapper {
  position: relative;
  width: 100%;
  margin-bottom: 0.75rem;
}

/* ── Party Badge Overlay ──────────────────────────────────────────────── */
.party-badge {
  position: absolute;
  bottom: -6px;
  left: 8px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-size: 0.85rem;
  font-weight: 700;
  color: #ffffff;
  border: 2px solid #ffffff;
  z-index: 2;
  line-height: 1;
}

.party-badge.party-D {
  background: #2563eb;
}

.party-badge.party-R {
  background: #dc2626;
}

.party-badge.party-I {
  background: #7c3aed;
}

/* ── Ethics Score Circle Overlay ──────────────────────────────────────── */
.ethics-circle {
  position: absolute;
  bottom: -6px;
  right: 8px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #9ca3af;
  border: 2px solid #ffffff;
  z-index: 2;
}
```

### 3.6 Responsive Adjustments

Keep existing `@media (max-width: 600px)` rule for `.members-grid` but update gap:

```css
@media (max-width: 600px) {
  .members-grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }
}
```

---

## 4. Required HTML/JS Structural Changes

### 4.1 New Tile HTML Structure (app.js `createMemberTile()`, lines 472–504)

**Before:**
```html
<div class="member-tile">
  <img class="tile-photo" ...>
  <div class="tile-initials" style="display:none;">AB</div>
  <div class="tile-name">Full Name</div>
  <div class="tile-meta">TX – 22</div>
  <div class="tile-meta">House</div>
  <div class="tile-badge-row">
    <span class="tile-party-badge party-D">D</span>
  </div>
</div>
```

**After:**
```html
<div class="member-tile">
  <div class="portrait-wrapper">
    <img class="tile-photo" ...>
    <div class="tile-initials" style="display:none;">AB</div>
    <span class="party-badge party-D">D</span>
    <span class="ethics-circle"></span>
  </div>
  <div class="tile-name">Full Name</div>
  <div class="tile-meta">TX - District 22</div>
</div>
```

Key changes:
1. **Wrap** photo + initials + badges in `<div class="portrait-wrapper">`
2. **Replace** `tile-party-badge` → `party-badge` (inside portrait-wrapper)
3. **Add** `<span class="ethics-circle"></span>` inside portrait-wrapper
4. **Remove** `<div class="tile-badge-row">` wrapper
5. **Format** district text as `"TX - District 22"` per R6

### 4.2 NOMINATE Function Rewrite (app.js `applyNominateTint()`, lines 540–561)

Must be rewritten to:
1. NOT use `classList.add('tint-*')`
2. NOT use `--tint-opacity` CSS variable
3. Compute inline `background-color` using R7 formula
4. Set via `tileEl.style.backgroundColor = computedColor`

### 4.3 Ethics Score JS Function (NEW)

```js
function ethicsScoreColor(score) {
  // 0 = red (#dc2626), 50 = yellow (#eab308), 100 = dark green (#16a34a)
  // null/undefined → '#9ca3af' (gray)
}
```

### 4.4 `onerror` Handler Compatibility

The current `onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"` still works because `.tile-initials` remains the next sibling of `.tile-photo` inside the wrapper.

---

## 5. Caveats

1. **`--radius-card` shared usage:** Do NOT change `--radius-card` (12px). It's used by `.stat-card` (L277), `.popover` (L463). Use new `--radius-tile` instead.

2. **`overflow: visible`:** Changing from `hidden` to `visible` lets badges extend past card edge at `bottom: -6px`. If badges must stay fully inside the card, use `bottom: 6px` instead.

3. **`aspect-ratio` browser support:** Requires Chrome 88+, Firefox 89+, Safari 15+. All modern browsers. If legacy needed, use padding-top hack.

4. **No ethics data exists yet:** Circle shows gray placeholder by default (R5).

5. **Skeleton class name:** Restyling `.skeleton-circle` in-place (to rounded rectangle) avoids any JS change for skeletons. The class name becomes slightly misleading but functional.

---

## 6. Conclusion

The CSS changes are well-scoped: ~14 rules modified, ~9 rules removed, ~8 rules added. The critical coordination point is the HTML structure change (portrait-wrapper) which must happen in JS simultaneously with the CSS changes.

**Priority order for implementation:**
1. Add new CSS custom properties and new rules (additive, non-breaking)
2. Modify `.member-tile`, `.tile-photo`, `.tile-initials`, `.tile-name`, `.tile-meta` (visual changes)
3. Remove old tint/badge CSS rules AND update JS simultaneously
4. Update skeleton styles
5. Update responsive breakpoint gap

---

## 7. Verification Method

1. **Visual:** Open `docs/index.html` → Members tab → verify 4-column grid, large rounded portraits, overlay badges, Playfair Display text, NOMINATE-colored backgrounds
2. **Responsive:** Resize to 600px → 1 column
3. **Functionality:** Search, popover, keyboard nav, broken-image fallback all still work
4. **Invalidation:** If `createMemberTile()` HTML structure differs from section 4.1, badge positioning breaks
