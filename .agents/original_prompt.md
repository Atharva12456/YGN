# Original User Request

## 2026-07-05T07:45:28Z

# Teamwork Project Prompt — Draft

> Status: Ready for launch
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Build a responsive grid of political profile tiles with ideology-based dynamic coloring and party/ethics badges to replace the current implementation. This will be a production replacement in the main app that integrates with the existing backend, with a fallback to static data.

Working directory: c:\Users\athar\OneDrive\Documents\YGN
Integrity mode: development

## Requirements

### R1. Responsive Grid Layout
Implement a responsive grid in `docs/app.js` and `docs/styles.css` that displays 4 tiles per row on normal desktop screens, wrapping gracefully on narrower screens while preserving tile proportions. Maintain even spacing (24px-32px) between tiles.

### R2. Tile Styling & Design
Each tile must be a vertical rounded-rectangle card (32px-44px border radius) containing:
- A large portrait image (object-fit: cover, 28px-40px border radius) near the top center.
- A solid circular party badge (Red R, Blue D, Purple/Gray I) overlapping the bottom-left of the portrait.
- A circular ethics score indicator overlapping the bottom-right of the portrait (Red=0, Yellow/Orange=50, Dark Green=100).
- The representative's name and district (e.g. "TX - District 22") centered below the portrait using the Playfair Display font.

### R3. Dynamic Background Color
The background color of each tile must be dynamically calculated based on the representative's NOMINATE score (-1 to +1) using this exact logic:
- Base Gray: `#B0B0B0`
- Blue Target: `#5A82C2`
- Red Target: `#C45C5C`
- Direction Color: nominateScore < 0 ? Blue Target : Red Target
- Distance from Center: abs(nominateScore)
- If exactly 0: use Base Gray
- Otherwise: `tintStrength = 0.12 + 0.88 * (distanceFromCenter ^ 0.85)` and `background = mix(Base Gray, Direction Color, tintStrength)`

### R4. Data Integration & Fallback
The frontend must fetch data from the FastAPI backend to populate the grid. If the backend is unreachable or the request fails, it must fall back to using available static data.

## Acceptance Criteria

### Visual Accuracy
- [ ] Grid displays 4 columns on wide screens and responds correctly to smaller widths.
- [ ] Party badge text is a single centered letter (R, D, I) and contrasts well with the circle.
- [ ] Background color math is implemented correctly and visually tints the card without destroying text readability.
- [ ] Playfair Display is used for the name and district text.

### Data Handling
- [ ] App attempts to fetch from the backend API first.
- [ ] App successfully populates the UI using static mock data if the backend is offline.
- [ ] If a representative's ethics score is missing, a neutral placeholder color is used for the ethics circle.

## 2026-07-05T15:42:07-05:00

# Teamwork Project Prompt — Draft

> Status: Launched
> Goal: Update political profile tiles grid density and aspect ratio

Update the existing political profile tiles to be thinner and taller, matching the aspect ratio of the provided concept, and increase the grid density to 6 tiles per row on standard desktop screens.

Working directory: c:\Users\athar\OneDrive\Documents\YGN
Integrity mode: development

## Requirements

### R1. Grid Layout Update
Update the grid layout in `docs/styles.css` (`.members-grid`) to display 6 tiles per row on wide desktop screens, down from the current 4. Adjust responsive breakpoints appropriately for 5, 4, 3, 2, and 1 columns as screen width decreases.

### R2. Tile Proportions
Modify the tile styling in `docs/styles.css` (`.member-tile` and `.tile-photo`) so that the cards are thinner and longer. The portrait image should also be adjusted to a taller aspect ratio that matches the user's provided concept image. The badges should remain correctly positioned at the bottom corners of the portrait.

## Acceptance Criteria

### Visual Accuracy
- [ ] The grid displays 6 tiles per row on standard desktop screens (>1200px).
- [ ] The tiles and portraits have a noticeably taller, narrower aspect ratio matching the concept.
- [ ] The R/D/I party badge and ethics badge remain perfectly aligned to the bottom-left and bottom-right corners of the narrower portrait.
- [ ] All other existing styling (fonts, dynamic background color) remains intact.
