# YGN — working agreement

## Token budget (important)
Usage is tight. Default to the cheapest approach that still gets it right.

- **Never use the Workflow tool or spawn subagents unless I explicitly ask.**
  Multi-agent audits have cost ~700k–1.1M tokens each here. One-off greps and
  targeted reads do the same job for a fraction.
- **No "ultracode"-style exhaustive passes unless I ask for one.**
- Keep replies short: lead with the answer, then only the details that change a
  decision. No recaps of what I just said, no restating the plan before doing it.
- Skip verbose commit messages — a subject line plus 1–3 bullets is enough.
- Read only the lines needed (`offset`/`limit`), not whole 5k-line files.
- Batch verification into one command instead of many round-trips.
- Don't re-verify things already confirmed earlier in the session.

## Project facts
- Live on Heroku at yourgovtnow.dev; FastAPI (`app.py`) serves the frontend and API.
  `empty-folder/CongressMembers.py` is the backend module (loaded as `government`).
- Frontend: vanilla JS, no build step. `docs/js/{core,features,enhancements,ux,settings,economy}.js`,
  `docs/css/*` aggregated by `docs/styles.css` via `@import`.
- The economy page is a normal page now: it themes, gets the shared chrome, and is
  edited like any other. (It used to be pinned to the light palette and excluded —
  that rule is gone.) Its charts are hand-rolled SVG in `docs/js/economy.js`.
- Data is committed snapshots under `docs/data/**`; AI content is generated only on
  refresh paths, never on public request paths.
- Verify with: `python -m unittest discover -s tests -q` and `npm run check`.

## Current blocker
GitHub Actions is blocked by a billing issue ("payments have failed or your spending
limit needs to be increased") — jobs fail in ~2s with zero steps. Not a code problem.
The site itself keeps updating via Heroku.
