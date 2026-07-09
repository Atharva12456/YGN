# Handoff Report — JavaScript Changes for YGN Tile Redesign

**Explorer 2 (JavaScript Logic Analyst)**  
**Date:** 2026-07-05T02:31Z

**Summary:** Six functions/sections in `docs/app.js` need modification. Two new helper functions must be added. The `createMemberTile()` function (lines 441–531) needs a restructured HTML template, and `applyNominateTint()` (lines 540–561) must be completely rewritten to use computed RGB colors. All other functions remain untouched.

---

## 1. Observation — Current Code Structure

### File: `docs/app.js` (818 lines)

| Line Range | Function/Section | Purpose |
|---|---|---|
| 1–6 | Header comment | Metadata |
| 7–17 | Cache & state declarations | `wikiCache`, `nominateCache`, `allMembers`, `membersLoaded`, popover state |
| 19–29 | DOM references | Declared, resolved at DOMContentLoaded |
| 31–106 | Utility helpers | `getMemberField`, `extractSortKey`, `buildInitials`, `clamp`, `firstSentences`, `currentCongressNumber` |
| 108–161 | API URL config | `getConfiguredApiBaseUrl()` and friends |
| 162–231 | Data fetching | `fetchStaticJson`, `fetchJsonWithStaticFallback`, `fetchOfficialsCollection` |
| 233–263 | Navigation | `showSection()` |
| 265–324 | Health & stats | `checkHealth()`, `updateStatCard()`, `initHomeStats()` |
| 326–345 | Skeletons | `renderSkeletons()` |
| 347–369 | Error/empty states | `showError()`, `showEmpty()` |
| 371–413 | Load members | `loadMembers()` |
| 415–433 | Render grid | `renderGrid()` |
| **441–531** | **`createMemberTile()`** | **MODIFY — HTML template restructure** |
| **533–561** | **`applyNominateTint()`** | **REWRITE — computed RGB colors** |
| 563–597 | `fetchNominate()` | Fetches & caches NOMINATE scores — **keep as-is** |
| 599–711 | Wiki popover | `cancelPopoverHide`, `schedulePopoverHide`, `triggerPopover`, `showPopover`, `hidePopover` — **keep as-is** |
| 713–746 | Search | `handleSearch()` — **keep as-is** |
| 748–818 | Initialization | DOMContentLoaded handler — **keep as-is** |

---

## 2. Logic Chain — Required Changes

### Change 1: NEW HELPER — `mixColor(base, target, t)` (add before `applyNominateTint`)

**Purpose:** Channel-by-channel linear interpolation between two RGB colors.

**Insert location:** After line 531 (after `createMemberTile` closes), before the NOMINATE section comment (line 533).

```javascript
/**
 * Linearly interpolate between two RGB color arrays channel-by-channel.
 * @param {number[]} base   — [r, g, b] base color
 * @param {number[]} target — [r, g, b] target color
 * @param {number} t        — interpolation factor 0..1
 * @returns {number[]} — [r, g, b] result
 */
function mixColor(base, target, t) {
  return [
    Math.round(base[0] * (1 - t) + target[0] * t),
    Math.round(base[1] * (1 - t) + target[1] * t),
    Math.round(base[2] * (1 - t) + target[2] * t),
  ];
}
```

### Change 2: NEW HELPER — `getEthicsColor(score)` (add near `mixColor`)

**Purpose:** Maps a 0–100 ethics score to red→yellow→green color string.

```javascript
/**
 * Map an ethics score (0–100) to a CSS color string.
 * 0 = red, ~50 = yellow/orange, 100 = dark green.
 * null/undefined = gray placeholder.
 * @param {number|null|undefined} score
 * @returns {string} CSS color string
 */
function getEthicsColor(score) {
  if (score == null || score === undefined) return '#9ca3af'; // gray placeholder

  const s = clamp(score, 0, 100);

  // 0 → red (#dc2626), 50 → yellow/orange (#f59e0b), 100 → green (#16a34a)
  if (s <= 50) {
    // red to yellow: interpolate 0..50 mapped to 0..1
    const t = s / 50;
    const r = Math.round(220 * (1 - t) + 245 * t);
    const g = Math.round(38  * (1 - t) + 158 * t);
    const b = Math.round(38  * (1 - t) + 11  * t);
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    // yellow to green: interpolate 50..100 mapped to 0..1
    const t = (s - 50) / 50;
    const r = Math.round(245 * (1 - t) + 22  * t);
    const g = Math.round(158 * (1 - t) + 163 * t);
    const b = Math.round(11  * (1 - t) + 74  * t);
    return `rgb(${r}, ${g}, ${b})`;
  }
}
```

**Color breakpoints used:**
- `#dc2626` → `rgb(220, 38, 38)` — red
- `#f59e0b` → `rgb(245, 158, 11)` — yellow/orange
- `#16a34a` → `rgb(22, 163, 74)` — dark green
- `#9ca3af` → gray placeholder for null

### Change 3: REWRITE `applyNominateTint()` (lines 540–561)

**Current code (REMOVE):**
```javascript
function applyNominateTint(tileEl, dim1) {
  // Remove any existing tint classes
  tileEl.classList.remove('tint-blue', 'tint-red', 'tint-neutral', 'tint-gray');

  if (dim1 === null || dim1 === undefined) {
    tileEl.classList.add('tint-gray');
    return;
  }

  const intensity = Math.min(1, Math.abs(dim1) / 1.0);

  if (dim1 < -0.3) {
    tileEl.style.setProperty('--tint-opacity', intensity.toFixed(3));
    tileEl.classList.add('tint-blue');
  } else if (dim1 > 0.3) {
    tileEl.style.setProperty('--tint-opacity', intensity.toFixed(3));
    tileEl.classList.add('tint-red');
  } else {
    // Near zero — neutral, no tint
    tileEl.classList.add('tint-neutral');
  }
}
```

**New code (REPLACE lines 540–561):**
```javascript
/**
 * Apply a computed NOMINATE background color to a member tile.
 * Uses channel-by-channel linear interpolation from a neutral gray
 * toward blue (liberal) or red (conservative) based on dim1 score.
 *
 * @param {HTMLElement} tileEl
 * @param {number|null} dim1  — roughly -1.0 (liberal) to +1.0 (conservative)
 */
function applyNominateTint(tileEl, dim1) {
  const BASE_GRAY   = [176, 176, 176]; // #B0B0B0
  const BLUE_TARGET = [90, 130, 194];  // #5A82C2
  const RED_TARGET  = [196, 92, 92];   // #C45C5C

  if (dim1 === null || dim1 === undefined) {
    tileEl.style.backgroundColor = `rgb(${BASE_GRAY.join(', ')})`;
    return;
  }

  if (dim1 === 0) {
    tileEl.style.backgroundColor = `rgb(${BASE_GRAY.join(', ')})`;
    return;
  }

  const directionColor = dim1 < 0 ? BLUE_TARGET : RED_TARGET;
  const distanceFromCenter = Math.abs(dim1);

  const tintStrength = 0.12 + 0.88 * Math.pow(distanceFromCenter, 0.85);
  const rgb = mixColor(BASE_GRAY, directionColor, tintStrength);

  tileEl.style.backgroundColor = `rgb(${rgb.join(', ')})`;
}
```

**Key differences from current code:**
1. No more CSS classes (`tint-blue`, `tint-red`, `tint-neutral`, `tint-gray`) — uses direct inline `backgroundColor`
2. No more `--tint-opacity` CSS custom property
3. No arbitrary ±0.3 dead zone — even scores very close to 0 show a slight tint (the `0.12` minimum ensures this)
4. Uses the exact formula from requirements: `tintStrength = 0.12 + 0.88 * (|score| ^ 0.85)`
5. The `mixColor()` helper does channel-by-channel interpolation

**Impact on CSS:** The CSS rules for `.tint-blue`, `.tint-red`, `.tint-neutral`, `.tint-gray` on `.member-tile` become **dead code** and should be removed by the CSS changes. The JS no longer references them.

### Change 4: RESTRUCTURE `createMemberTile()` HTML template (lines 441–531)

#### 4a. District format change (line 450)

**Current:**
```javascript
const locationStr = [state, district].filter(Boolean).join(' – ');
```

**New:**
```javascript
let districtStr = '';
if (state && district) {
  districtStr = `${state} - District ${district}`;
} else if (state) {
  districtStr = state;
} else if (district) {
  districtStr = `District ${district}`;
}
```

**Rationale:** The requirement says format should be "XX - District N". The current format just joins state and district with " – ". The district data from the API is a number (e.g., `22`), so we prepend "District".

#### 4b. Remove `chamberStr` variable (line 451)

**Current:**
```javascript
const chamberStr = chamber ? chamber : '';
```

**Action:** Remove this line entirely. The chamber line is not in the new design requirements.

#### 4c. Party badge color determination — add inline color logic (after line 463)

The party badge needs explicit colors for the overlay badge. Add after current party logic:

```javascript
// Party badge color
let partyBadgeColor = '#7c3aed'; // purple for Independent
if (partyClass === 'party-D') partyBadgeColor = '#2563eb'; // blue
else if (partyClass === 'party-R') partyBadgeColor = '#dc2626'; // red
```

#### 4d. Ethics score color (after party badge color)

```javascript
// Ethics score — use member.ethicsScore if available, else null
const ethicsScore = (member.ethicsScore != null) ? member.ethicsScore : null;
const ethicsColor = getEthicsColor(ethicsScore);
```

#### 4e. Restructure photo HTML (lines 480–494)

**Current:**
```javascript
let photoHtml = '';
if (photoUrl) {
  photoHtml = `
    <img
      class="tile-photo"
      src="${photoUrl}"
      alt="${name}"
      loading="lazy"
      onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
    >
    <div class="tile-initials" style="display:none;" aria-hidden="true">${initials}</div>
  `;
} else {
  photoHtml = `<div class="tile-initials" aria-hidden="true">${initials}</div>`;
}
```

**New:**
```javascript
let portraitInner = '';
if (photoUrl) {
  portraitInner = `
    <img
      class="tile-photo"
      src="${photoUrl}"
      alt="${name}"
      loading="lazy"
      onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
    >
    <div class="tile-initials" style="display:none;" aria-hidden="true">${initials}</div>
  `;
} else {
  portraitInner = `<div class="tile-initials" aria-hidden="true">${initials}</div>`;
}
```

**Note on `onerror` handler:** The `this.nextElementSibling` still works because `<img>` is immediately followed by `<div class="tile-initials">` inside the wrapper. The wrapper restructuring does NOT break this relationship.

#### 4f. Restructure tile innerHTML (lines 496–504)

**Current:**
```javascript
tile.innerHTML = `
  ${photoHtml}
  <div class="tile-name">${name}</div>
  ${locationStr ? `<div class="tile-meta">${locationStr}</div>` : ''}
  ${chamberStr ? `<div class="tile-meta">${chamberStr}</div>` : ''}
  <div class="tile-badge-row">
    ${party ? `<span class="tile-party-badge ${partyClass}">${partyLabel}</span>` : ''}
  </div>
`;
```

**New:**
```javascript
tile.innerHTML = `
  <div class="tile-portrait-wrapper">
    ${portraitInner}
    ${party ? `<span class="tile-party-badge" style="background-color: ${partyBadgeColor};">${partyLabel}</span>` : ''}
    <span class="tile-ethics-circle" style="background-color: ${ethicsColor};"></span>
  </div>
  <div class="tile-name">${name}</div>
  ${districtStr ? `<div class="tile-district">${districtStr}</div>` : ''}
`;
```

**Key differences:**
1. New `<div class="tile-portrait-wrapper">` wraps photo/initials + badges
2. Party badge moved inside wrapper, uses inline `background-color` instead of CSS class
3. New `<span class="tile-ethics-circle">` with computed color from `getEthicsColor()`
4. `.tile-meta` replaced by `.tile-district` (single line, new format)
5. Chamber line removed entirely
6. `.tile-badge-row` removed entirely
7. `partyClass` CSS class no longer applied to badge (inline color instead)

### Change 5: `fetchNominate()` — NO CHANGES NEEDED (lines 569–597)

This function calls `applyNominateTint(tileEl, dim1)` which has the same signature. No changes needed — the rewritten `applyNominateTint()` accepts the same arguments.

Verified at:
- Line 573: `applyNominateTint(tileEl, cached ? cached.dim1 : null);` ✅
- Line 584: `applyNominateTint(tileEl, null);` ✅
- Line 591: `applyNominateTint(tileEl, dim1);` ✅
- Line 595: `applyNominateTint(tileEl, null);` ✅

---

## 3. Consolidated Line-by-Line Change Plan

| Step | Lines | Action | Description |
|------|-------|--------|-------------|
| 1 | 450 | **Replace** | `locationStr = [state, district]...` → `districtStr` with new format logic |
| 2 | 451 | **Delete** | Remove `const chamberStr = chamber ? chamber : '';` |
| 3 | after 463 | **Insert** | Add `partyBadgeColor` variable (3 lines) |
| 4 | after partyBadgeColor | **Insert** | Add `ethicsScore` + `ethicsColor` variables (2 lines) |
| 5 | 480–494 | **Modify** | Rename `photoHtml` to `portraitInner` (same structure, only variable name) |
| 6 | 496–504 | **Replace** | New tile innerHTML with wrapper, overlay badges, district format |
| 7 | after 531 | **Insert** | `mixColor(base, target, t)` function (12 lines) |
| 8 | after mixColor | **Insert** | `getEthicsColor(score)` function (22 lines) |
| 9 | 540–561 | **Replace** | Rewrite `applyNominateTint()` with computed RGB formula (24 lines) |

**Total: ~9 distinct edit operations in `app.js`**

---

## 4. New Functions Summary

### `mixColor(base, target, t)` — Pure utility
- **Input:** Two `[r, g, b]` arrays and a float `t` (0–1)
- **Output:** `[r, g, b]` array with each channel interpolated
- **Formula:** `result[i] = round(base[i] * (1-t) + target[i] * t)`
- **No side effects, no DOM access**

### `getEthicsColor(score)` — Pure utility
- **Input:** Number 0–100 or null/undefined
- **Output:** CSS color string like `rgb(r, g, b)` or hex `#9ca3af`
- **Uses `clamp()` (already exists at line 73)**
- **No side effects, no DOM access**

### `applyNominateTint(tileEl, dim1)` — Rewritten (same signature)
- **Input:** DOM element and a NOMINATE dim1 score (number or null)
- **Output:** Sets `tileEl.style.backgroundColor` directly
- **Calls `mixColor()`**
- **Constants defined inline:** `BASE_GRAY`, `BLUE_TARGET`, `RED_TARGET`
- **No CSS class manipulation for tinting**

---

## 5. CSS Classes Obsoleted by JS Changes

These CSS classes/selectors are **no longer used** after the JS changes:

| CSS Class | Was Used By | Replacement |
|---|---|---|
| `.tint-blue` | `applyNominateTint` | Inline `backgroundColor` |
| `.tint-red` | `applyNominateTint` | Inline `backgroundColor` |
| `.tint-neutral` | `applyNominateTint` | Inline `backgroundColor` |
| `.tint-gray` | `applyNominateTint` | Inline `backgroundColor` |
| `--tint-opacity` | `applyNominateTint` | No longer needed |
| `.tile-badge-row` | `createMemberTile` innerHTML | Removed from template |
| `.party-D`, `.party-R`, `.party-I` | Badge `<span>` class | Inline `background-color` style |
| `.tile-meta` | `createMemberTile` innerHTML | Replaced by `.tile-district` |

**New CSS classes needed by JS:**

| CSS Class | Used In | Purpose |
|---|---|---|
| `.tile-portrait-wrapper` | Tile innerHTML | `position: relative` container for photo + overlay badges |
| `.tile-party-badge` | Tile innerHTML (still used, but without party-D/R/I sub-class) | Overlay badge, positioned `absolute` bottom-left |
| `.tile-ethics-circle` | Tile innerHTML | Overlay circle, positioned `absolute` bottom-right |
| `.tile-district` | Tile innerHTML | District text below name (Playfair Display) |

---

## 6. Preserved Functionality Verification

| Feature | Mechanism | Impact | Status |
|---|---|---|---|
| `wikiCache` / `nominateCache` Maps | Lines 8–9, used in `fetchNominate`, `triggerPopover` | No changes | ✅ Preserved |
| `fetchNominate()` | Lines 569–597, calls `applyNominateTint` | Same function signature | ✅ Preserved |
| Popover events (mouseenter, mouseleave, focus, blur) | Lines 507–523 in `createMemberTile` | No changes to event listeners | ✅ Preserved |
| `handleSearch()` | Lines 719–746 | No changes | ✅ Preserved |
| `loadMembers()` | Lines 376–413 | No changes | ✅ Preserved |
| `renderGrid()` | Lines 419–433 | No changes | ✅ Preserved |
| `renderSkeletons()` | Lines 331–345 | No changes | ✅ Preserved |
| `showSection()` | Lines 239–263 | No changes | ✅ Preserved |
| `checkHealth()` | Lines 270–294 | No changes | ✅ Preserved |
| `initHomeStats()` | Lines 321–324 | No changes | ✅ Preserved |
| tabindex, role, aria-label | Lines 475–477 | No changes | ✅ Preserved |
| Escape key handler | Lines 801–805 | No changes | ✅ Preserved |
| Outside click handler | Lines 808–816 | Uses `.member-tile` selector (unchanged) | ✅ Preserved |
| Photo onerror fallback | Line 488 | `this.nextElementSibling` still valid inside wrapper | ✅ Preserved |
| Initials when no photo | Line 493 | Wrapped inside `tile-portrait-wrapper` but still renders | ✅ Preserved |

---

## 7. Caveats

1. **Ethics score data source:** The `member` object from the API currently does NOT have an `ethicsScore` field. The code reads `member.ethicsScore` and defaults to `null`, which renders a gray circle. This is explicitly stated in the requirements ("for now", R5).

2. **District number format assumption:** The code assumes `district` from the API is a number or short string (e.g., `"22"` or `"At-Large"`). If the API returns `"22nd Congressional District"` instead of just `"22"`, the format "TX - District 22nd Congressional District" would look odd. Based on typical Congress API responses, the `district` field is typically just a number.

3. **Party badge styling:** The party badge now uses inline `background-color` instead of CSS class-based coloring. The `.tile-party-badge` CSS class still needs to define shape, size, positioning, font, and text color (white). The party-specific sub-classes (`.party-D`, `.party-R`, `.party-I`) become dead code.

4. **CSS must add positioning rules:** The JS changes produce correct HTML structure, but the visual overlay effect requires CSS to set:
   - `.tile-portrait-wrapper { position: relative; }`
   - `.tile-party-badge { position: absolute; bottom: ...; left: ...; }` 
   - `.tile-ethics-circle { position: absolute; bottom: ...; right: ...; }`

5. **`clamp()` dependency:** `getEthicsColor()` calls `clamp()` which already exists at line 73. Verified.

---

## 8. Conclusion

The JavaScript changes are well-scoped and surgical:

- **2 new pure functions** (`mixColor`, `getEthicsColor`) — no side effects, no DOM, easily testable
- **1 rewritten function** (`applyNominateTint`) — same signature, different implementation (inline styles instead of CSS classes)
- **1 modified function** (`createMemberTile`) — new HTML template with portrait wrapper, overlay badges, and new district format
- **0 changes** to all other functions (navigation, search, popover, fetching, caching, initialization)

The redesign is backward-compatible at the data layer: `fetchNominate()` and `wikiCache` work unchanged. The `applyNominateTint()` rewrite is a drop-in replacement since the function signature `(tileEl, dim1)` is identical.

---

## 9. Verification Method

1. **Syntax check:** After implementing, open browser console — should see 0 JS errors
2. **NOMINATE color test:** Navigate to Members tab, inspect a tile's `style.backgroundColor`:
   - A known Democrat (e.g., dim1 ≈ -0.5) should show a blue-ish RGB background
   - A known Republican (e.g., dim1 ≈ +0.5) should show a red-ish RGB background
   - Member with no NOMINATE data should show `rgb(176, 176, 176)` (#B0B0B0)
3. **Formula spot-check:** For dim1 = -0.8:
   - `distanceFromCenter = 0.8`
   - `tintStrength = 0.12 + 0.88 * (0.8^0.85) = 0.12 + 0.88 * 0.827 ≈ 0.848`
   - `r = round(176*(1-0.848) + 90*0.848) = round(26.75 + 76.32) = 103`
   - `g = round(176*(1-0.848) + 130*0.848) = round(26.75 + 110.24) = 137`
   - `b = round(176*(1-0.848) + 194*0.848) = round(26.75 + 164.51) = 191`
   - Expected: `rgb(103, 137, 191)` — clearly blue-tinted ✅
4. **HTML structure:** Inspect a rendered tile — should have `.tile-portrait-wrapper` containing `img`, `.tile-initials`, `.tile-party-badge`, `.tile-ethics-circle`
5. **Search test:** Type a name in search box — tiles filter correctly
6. **Popover test:** Hover a tile — wiki popover appears with summary
7. **Ethics circle:** All circles should be gray (#9ca3af) since no data exists yet
8. **Initials fallback:** Find a member with no photo — initials should appear in the wrapper
