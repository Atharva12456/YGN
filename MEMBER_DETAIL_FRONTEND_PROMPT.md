# Frontend Task Prompt — YGN Member Detail Page ("Wikipedia-style" profile)

> Hand this whole file to the frontend bot. The **backend is already built, tested, and
> running** — your job is purely the frontend. Do **not** modify any Python
> (`app.py`, `empty-folder/*.py`, `scripts/*.py`) or any backend behavior.

---

## 1. Project context you need

**YGN** (yourgovtnow.dev) is a civic government-info site. It runs two ways from the
same `docs/` folder:

- **Live backend (production, Heroku):** a FastAPI app serves the frontend *and* a JSON
  API on the same origin. `config.js` resolves `API_BASE_URL` to the current origin, so
  `fetch(API_BASE_URL + '/officials/...')` hits the live API.
- **Static (GitHub Pages):** `API_BASE_URL` is blank; the frontend reads pre-generated
  JSON from `docs/data/**`.

The frontend is **vanilla HTML/CSS/JS, no build step, no framework.** Pages are separate
`.html` files (`index.html`, `members.html`, `map.html`, …) that all load `config.js`
then `app.js`, and share `styles.css`. Navigation is plain links so browser Back/Forward
works. `?api=local`, `?api=static`, or `?api=<url>` overrides the data source and is
preserved across links via the existing `withApiParam(url)` helper.

**The one fetch helper you must reuse** (already in `app.js`):

```js
// Tries the live API first (if API_BASE_URL is set), else falls back to docs/data/<staticPath>.
// Returns { data, source } | { notFound: true, source }. Throws only if both fail.
async function fetchJsonWithStaticFallback(apiPath, staticPath, options = {}) { ... }
```

Theme colors live in CSS custom properties in `styles.css`. Fonts: **Playfair Display**
(headings/brand) and **Inter** (body), already loaded from Google Fonts. Aesthetic:
clean, civic, data-focused, dark header/nav, card tiles, subtle shadows — **not** a
marketing splash. Everything must be keyboard-accessible with visible focus rings and
work on mobile + desktop.

---

## 2. What to build

A **member detail page** reachable by clicking any member tile — a rich, Wikipedia-style
profile for one member of Congress. Two pieces of work:

1. **New page `docs/member.html`** (+ its JS logic in `app.js`, styles in `styles.css`).
   It reads the member id from the query string: `member.html?id=<bioguideId>` (preserve
   `?api=` too, e.g. `member.html?id=P000197&api=local`).
2. **Make tiles link to it.** In `createMemberTile(member)` in `app.js` (around line 926),
   the tile already has the member's `bioguideId`. Add a click/Enter handler (or wrap the
   photo/name in an `<a href>`) that navigates to `withApiParam('member.html?id=' + bioguideId)`.
   **Keep the existing hover popover and ethics badge working** — clicking the tile body
   opens the detail page; the ethics badge link and popover must still behave as they do now.

The page must have the **same header + nav markup** as `members.html` (copy it verbatim so
the health indicator and nav render), a back link to `members.html`, and the profile below.

---

## 3. The data: one endpoint gives you everything

There is a single aggregator endpoint. **Use it as your primary fetch** — it returns every
section in one request and never fails as a whole (each section degrades independently):

```js
const { data: dossier } = await fetchJsonWithStaticFallback(
  `/officials/${id}/dossier`,
  `dossier/${id}.json`,        // static path (see §7 about static mode)
);
```

There are also per-section endpoints if you ever want to lazy-load one section
(`/officials/{id}/wiki?full=true`, `/history`, `/funding`, `/committees`, `/contact`,
`/legislation?limit=15`, `/stocks`). Prefer the dossier for the initial render.

### Dossier response shape (verified against the live API)

```jsonc
{
  "bioguideId": "P000197",
  "member": { /* Congress.gov member object: directOrderName, state, partyName,
                 terms, depiction:{imageUrl}, birthYear, honorificName, ... */ },
  "detail": { "member": { /* raw Congress.gov detail, same as above nested */ } },
  "errors": [ { "stage": "funding", "error": "..." } ],   // sections that failed; usually []

  "wiki": {                       // full, untrimmed Wikipedia summary — or null
    "title": "Nancy Pelosi",
    "extract": "…full lead paragraph(s)…",
    "summary": "…same text…",
    "thumbnail": "https://…jpg",  // may be absent
    "wiki_url": "https://en.wikipedia.org/wiki/Nancy_Pelosi",
    "source": "wikipedia"         // or "congress_fallback" when Wikipedia had no page
  },

  "nominate": { "dim1": -0.42, "geo_mean": 0.97 } | null,   // ideology (-1 left … +1 right)

  "ethics": {                     // campaign-finance transparency grade — or null
    "score": 78.7, "grade": "C+", "source": "fec_live", "components": { … }
  },

  "funding": {                    // ALWAYS present; check `available`
    "available": true,
    "source": "fec",
    "note": null,                 // set when available:false (why it's missing)
    "candidate": { "candidateId": "S4VT00033", "name": "SANDERS, BERNARD",
                   "office": "S", "state": "VT", "district": null, "party": "IND" },
    "cycle": null,                // often null = FEC aggregate across the committee's history
    "totals": {
      "receipts": 36301484.01, "disbursements": 34550000.0,
      "cashOnHand": 10740760.66, "debts": 0.0, "individualContributions": 33100000.0
    },
    "breakdown": [               // contribution mix; `share` is 0–1 or null
      { "label": "Small individual (unitemized)", "amount": 22732498.43, "share": 0.684 },
      { "label": "Large individual (itemized)",   "amount": 10403076.38, "share": 0.313 },
      { "label": "PAC / other committees",        "amount": 94133.06,    "share": 0.003 },
      { "label": "Political party committees",     "amount": 0.0,         "share": 0.0 },
      { "label": "Self-funding & candidate loans", "amount": 0.0,        "share": 0.0 }
    ],
    "grade": { "score": 83.6, "grade": "B", "components": { … } }  // same object as `ethics`
  },

  "committees": {                 // assignments — or null if the source was unreachable
    "count": 14, "leadershipCount": 5,
    "assignments": [
      { "code": "SSHR", "committee": "Senate Committee on Health, Education, Labor, and Pensions",
        "chamber": "senate", "committeeUrl": "https://…", "subcommittee": null,
        "isSubcommittee": false, "role": "Chairman", "rank": 1, "party": "majority" },
      { "code": "SSHR12", "committee": "Senate Committee on …", "subcommittee": "Subcommittee on …",
        "isSubcommittee": true, "role": null, "rank": 3, "party": "majority" }
    ],
    "source": "unitedstates/congress-legislators"
  },

  "contact": {
    "official": { "website": "https://pelosi.house.gov/", "contactForm": null,
                  "phone": "202-225-4965", "office": "1236 Longworth House Office Building" },
    "social":   { "twitter": { "handle": "SpeakerPelosi", "url": "https://twitter.com/SpeakerPelosi" },
                  "facebook": { … }, "youtube": { … }, "instagram": { … } },  // any subset, may be {}
    "profiles": { "wikipedia": "https://…", "ballotpedia": "https://…", "govtrack": "https://…",
                  "opensecrets": "https://…", "cspan": "https://…", "votesmart": "https://…" }
  },

  "history": {
    "fullName": "Nancy Pelosi", "birthYear": "1940", "birthday": "1940-03-26", "gender": "F",
    "firstElectedYear": 1987, "yearsOfService": 39, "termCount": 20,
    "chambersServed": ["House of Representatives"],
    "partyHistory": [ { "partyName": "Democratic", "startYear": 1987 } ],
    "leadership": [ /* Congress.gov leadership roles, may be [] */ ],
    "terms": [ { "congress": 100, "chamber": "House of Representatives",
                 "startYear": "1987", "endYear": "1989", "state": "California",
                 "district": 5, "party": "Democratic" }, … ]   // chronological
  },

  "legislation": {
    "sponsoredCount": 199, "cosponsoredCount": 5083, "enactedShown": 0,
    "sponsored":   [ { "congress": 118, "type": "HRES", "number": "742",
                       "title": "…", "introducedDate": "2023-09-29", "policyArea": "Congress",
                       "latestAction": "…", "latestActionDate": "2023-09-29",
                       "becameLaw": false, "url": "https://www.congress.gov/bill/…" }, … ],
    "cosponsored": [ /* same item shape */ ],
    "source": "congress.gov"
  },

  "stocks": {
    "available": true, "provider": "house_clerk",   // "house_clerk" | "external" | "none"
    "chamber": "house",
    "trades": [],                 // populated only when a provider key is configured (see §8)
    "ownerBreakdown": {},         // e.g. { "self": 12, "spouse": 3 } when trades are parsed
    "filings": [                  // official House disclosure filings (no-key path)
      { "year": "2026", "filingType": "P",
        "label": "Periodic Transaction Report (stock/asset trade)",
        "isStockReport": true, "filingDate": "6/23/2026", "stateDistrict": "CA11",
        "docId": "20034836",
        "pdfUrl": "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034836.pdf" }
    ],
    "senateSearchUrl": null,      // set for senators → link out to eFD search
    "familyMembersNote": "PTRs label each trade's owner (self, spouse 'SP', dependent child 'DC', joint 'JT')…",
    "note": null                  // set when nothing was found / senate-only
  }
}
```

---

## 4. Section-by-section UI spec

Render the page as a header block + a responsive grid/stack of cards. Suggested order:

1. **Identity header** — big photo (`member.depiction.imageUrl`, or the Congress.gov CDN
   pattern `https://bioguide.congress.gov/bioguide/photo/<FIRST_LETTER>/<bioguideId>.jpg`,
   with graceful initials fallback like the tiles do), full name in Playfair Display,
   party/state/chamber/district chips, and the ideology tint from `nominate.dim1`
   (blue < −0.3, red > 0.3, neutral near 0, gray if null) — reuse the tile's tinting logic.
   Show the ethics `grade` badge (reuse tile colors/`getEthicsColor`).

2. **About (Wikipedia)** — `wiki.extract` as prose, `wiki.thumbnail` if present, and a
   "Read more on Wikipedia" link to `wiki.wiki_url`. If `wiki.source === "congress_fallback"`,
   add a small note that the bio is a generated summary (no Wikipedia page resolved).
   If `wiki` is null, hide the card or show "Biography unavailable."

3. **Career history** — headline stats: first elected `firstElectedYear`, `yearsOfService`,
   `termCount`, chambers served, birthday/age. Then a compact **timeline** from
   `history.terms` (congress #, chamber, years, district/state, party) — a vertical list or
   horizontal rail. Show `partyHistory` if the member changed parties.

4. **Campaign funding** — this is a headline feature. If `funding.available`:
   - Big numbers from `funding.totals` (receipts, cash on hand, disbursements, debts) —
     format as compact currency (reuse `formatCurrencyCompact`).
   - The **grade** (`funding.grade.grade` + `.score`) as a badge; link to
     `ethics-methodology.html` (existing page) for the methodology.
   - A **breakdown bar/legend** from `funding.breakdown` (stacked bar of the five `share`s,
     with a legend showing `label` + formatted `amount` + percent). This visually answers
     "small-donor vs PAC vs self-funded."
   - If `!funding.available`, show `funding.note` in a muted state (e.g. "No matching FEC
     campaign committee was found").
   - Caption: cycle is often the FEC aggregate across the committee's history (show "all
     available cycles" when `cycle` is null). Source: FEC.

5. **Financial disclosures / stock trades** — from `stocks`:
   - If `stocks.trades.length` (provider configured): render a table of trades
     (date, ticker/asset, buy/sell, amount range, `owner`) and an **owner/family breakdown**
     from `ownerBreakdown` (self vs spouse vs dependent child).
   - Else if `stocks.filings.length`: render the official House filings as a list — each
     row shows `label`, `filingDate`, and a link to `pdfUrl` ("View official PDF"). Badge
     the ones with `isStockReport` as stock-trade reports.
   - If `stocks.senateSearchUrl` (senators): show a "Search this senator's disclosures on
     the Senate eFD system" link to that URL.
   - Show `stocks.familyMembersNote` as small print explaining the owner codes.
   - If nothing: show `stocks.note`.

6. **Legislation** — two tabs/columns: **Sponsored** (`legislation.sponsored`) and
   **Cosponsored** (`legislation.cosponsored`). Show the totals `sponsoredCount` /
   `cosponsoredCount` as headline numbers ("199 bills sponsored"). Each item links to
   `item.url` (congress.gov), shows `title`, `type`+`number`, `introducedDate`,
   `policyArea`, and `latestAction`. Badge items where `becameLaw` is true ("Enacted").

7. **Committees** — group `committees.assignments` by full committee (`isSubcommittee:false`)
   with their subcommittees nested underneath. Show `role` as a badge when present
   ("Chair", "Ranking Member"). Link the committee name to `committeeUrl` when present.

8. **Contact & links** — `contact.official` (website, phone, office), `contact.social`
   (icon links — twitter/facebook/youtube/instagram, each `{handle, url}`), and
   `contact.profiles` (external reference links: Wikipedia, Ballotpedia, GovTrack,
   OpenSecrets, C-SPAN, VoteSmart). Render only the keys that are present.

---

## 5. Graceful degradation — REQUIRED

Every section can be `null` (fetch failed) or carry `available:false` / empty arrays.
**No section may throw or blank the whole page.** For each card: if its data is missing,
either hide the card or show a quiet "unavailable" message. Always render identity + any
sections that did load. Check `dossier.errors` only for optional debug logging — do not
surface raw errors to users. Never assume a field exists; optional-chain everything.

---

## 6. States & accessibility

- **Loading**: skeleton/spinner while the dossier fetch is in flight.
- **Error**: if the dossier fetch itself throws (both live and static failed) or `id` is
  missing/invalid, show a friendly error with a link back to `members.html`.
- **Keyboard**: the page and all links/tabs must be Tab-navigable with visible focus rings.
  Tabs (sponsored/cosponsored) need proper `role="tab"`/`aria-selected`. Back link focusable.
- **Console**: no JS errors during normal use.
- Reuse existing CSS variables and component styles; match the visual language of the tiles
  and existing pages. Add new classes to `styles.css`; don't inline large style blocks.

---

## 7. Static mode (GitHub Pages) — important

The static snapshot generator (`scripts/generate_static_data.py`) does **not** yet emit
`docs/data/dossier/<id>.json`, so on **GitHub Pages the dossier fetch will 404 today**.
That's fine for now: **production is the live Heroku backend**, where the dossier endpoint
works. Build the page against the live API (`fetchJsonWithStaticFallback` will use it
automatically when `API_BASE_URL` is set, e.g. locally with `?api=local` or on Heroku).

Still wire the static path (`dossier/${id}.json`) in your fetch call so the page "just
works" once a future backend task adds dossier snapshots. When `fetchJsonWithStaticFallback`
returns `{ notFound: true }` (static 404), show the "detail unavailable in static mode —
view on the live site" message rather than an error.

To develop locally against the live backend:
```
uvicorn app:app --reload            # terminal 1 (needs CONGRESS_API_KEY, FEC_API_KEY in .env)
# open http://127.0.0.1:8000/members.html  → click a tile
# or open docs/ statically and append ?api=local to force the local API
```

---

## 8. Caveats / honesty notes to reflect in the UI

- **Funding `cycle` is usually `null`** — it's the FEC's aggregate for the member's
  principal campaign committee, not a single election cycle. Label accordingly; don't claim
  a specific year unless `cycle` is non-null.
- **Stock "family members"**: parsed per-trade owner data (self/spouse/child) requires a
  commercial provider API key (`YGN_STOCK_API_KEY`). Without it, `stocks.trades` is empty
  and you get official House **filing PDFs** instead (which contain the owner info inside
  the document). Senate members link out to the eFD search. Present this honestly — don't
  imply we have parsed trade data when `trades` is empty.
- **Committees/contact** come from the community `unitedstates/congress-legislators`
  dataset; if it's briefly unreachable those sections may be `null`. The backend already
  caches for 24h and serves stale on failure, so this is rare.

---

## 9. Acceptance checklist

- [ ] `docs/member.html` exists, loads `config.js` + `app.js` + `styles.css`, has shared header/nav.
- [ ] Clicking a member tile (and Enter on a focused tile) opens `member.html?id=<bioguideId>`, preserving `?api=`.
- [ ] Existing tile popover + ethics badge still work.
- [ ] Page fetches `/officials/<id>/dossier` via `fetchJsonWithStaticFallback` and renders all eight sections.
- [ ] Identity header shows photo (with initials fallback), name in Playfair, party/state/chamber, ideology tint, ethics grade.
- [ ] Funding renders totals + grade + a stacked breakdown bar; shows the note when unavailable.
- [ ] Stocks renders provider trades OR House filing PDF links OR the Senate eFD link, with the family-owner note.
- [ ] Sponsored/cosponsored legislation lists with counts and congress.gov links; "Enacted" badge when `becameLaw`.
- [ ] Committees grouped with subcommittees and role badges; contact + social + external profile links render only when present.
- [ ] Every section degrades gracefully (null/empty/`available:false`); no console errors; fully keyboard-accessible.
- [ ] Works locally against the live backend (`?api=local`); shows a clean "unavailable in static mode" message on GitHub Pages until dossier snapshots exist.
