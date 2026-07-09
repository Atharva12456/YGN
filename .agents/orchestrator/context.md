# Context Scratchpad

The goal is to modify the existing `docs/app.js` and `docs/styles.css` to build a responsive grid of political profile tiles.
Requirements:
1. **Responsive Grid:** 4 columns wide screen, wrap on narrower. Even spacing (24px-32px).
2. **Tile Styling:** Vertical rounded-rectangle (32-44px radius), portrait image (cover, 28-40px radius), party badge bottom-left, ethics score bottom-right, name and district Playfair Display.
3. **Dynamic Background:** Calculated based on NOMINATE score (-1 to +1).
   - Gray: #B0B0B0, Blue: #5A82C2, Red: #C45C5C
   - Direction: <0 Blue, >0 Red
   - Dist = abs(nominate)
   - Tint = 0.12 + 0.88 * (dist ^ 0.85)
   - BG = mix(Gray, Direction, Tint)
4. **Data Integration:** Fetch from FastAPI backend, fallback to static mock data if offline.

Need to figure out the existing code structure in `docs/app.js` and `docs/styles.css`.
I will dispatch an explorer to understand what is there, then we can do an iteration loop for the single milestone.
Or maybe the changes are small enough to be one milestone: "Update Frontend Grid".
Since it's limited to `app.js` and `styles.css` and involves a fallback logic for a FastAPI backend.
