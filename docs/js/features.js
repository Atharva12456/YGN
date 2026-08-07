// -- Laws-enacted home stat (from the committed civic snapshot) -----------------

async function initLawsStat() {
  const card = document.getElementById('stat-laws');
  if (!card) return;
  const valueEl = card.querySelector('.stat-value');
  const data = await fetchCivic('recent-laws.json');
  const total = data && Number(data.totalLawsThisCongress);
  if (valueEl && Number.isFinite(total)) valueEl.textContent = formatNumber(total);
  else if (valueEl) valueEl.textContent = '—';
}

// -- This week in Congress (AI brief, regenerated only on digest change) --------

async function initWeeklyBrief() {
  const host = document.getElementById('weekly-brief');
  if (!host) return;
  const data = await fetchCivic('weekly-brief.json');
  if (!data || !data.summary) { host.hidden = true; return; }
  host.innerHTML = `
    <div class="cb-title">This week in Congress <span class="ai-badge">AI</span></div>
    <p class="weekly-brief-text">${esc(data.summary)}</p>
    <p class="civic-meta">Generated ${esc(formatShortDate(data.generated_at))} from the ${Number(data.billCount) || 'latest'} most recently active bills · regenerates only when activity changes</p>`;
  host.hidden = false;
}

// -- Vote spotlight (home) ------------------------------------------------------

async function initVoteSpotlight() {
  const host = document.getElementById('vote-spotlight');
  if (!host) return;
  const data = await fetchCivic('vote-spotlight.json');
  const votes = (data && data.votes) || [];
  if (!votes.length) { host.hidden = true; return; }
  const rows = votes.map(v => {
    v = { ...v, yea: Number(v.yea) || 0, nay: Number(v.nay) || 0 };
    const total = (v.yea + v.nay) || 1;
    const yeaPct = (v.yea / total) * 100;
    const href = v.detailPath ? withApiParam(`bill.html?id=${encodeURIComponent(v.detailPath)}`) : null;
    const title = esc(v.billTitle || v.identifier || 'Bill');
    const head = href ? `<a href="${href}">${title}</a>` : title;
    return `<div class="spotlight-row">
      <div class="spotlight-head">${head}<span class="spotlight-meta">${esc(v.chamber || '')} · ${esc(v.question || 'Vote')} · ${esc(formatShortDate(v.date))}</span></div>
      <div class="spotlight-bar" title="Yea ${v.yea} — Nay ${v.nay}"><span class="yea" style="width:${yeaPct}%"></span></div>
      <div class="spotlight-nums"><strong class="yea-n">${v.yea} yea</strong> · <strong class="nay-n">${v.nay} nay</strong> · ${esc(v.result || '')}</div>
    </div>`;
  }).join('');
  host.innerHTML = `<div class="cb-title">Vote spotlight — recent roll calls</div>${rows}
    <p class="civic-meta">Closest, fullest recent recorded votes. Click through for the member-by-member breakdown.</p>`;
  host.hidden = false;
}

// -- On this day (home, light) ---------------------------------------------------

async function initOnThisDay() {
  const host = document.getElementById('on-this-day');
  if (!host) return;
  const data = await fetchCivic('on-this-day.json');
  const events = (data && data.events) || {};
  const now = new Date();
  const key = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let entry = events[key];
  let label = 'On this day';
  if (!entry) {
    // Fall back to the most recent entry on or before today, then wrap to the
    // latest entry of the year. The old fallback only looked within the SAME
    // month, so any month whose first entry falls after the 1st left the card
    // blank until then -- 68 days a year with this dataset, including 25 days
    // every October and 16 every September, and it is what broke CI on Aug 1-5.
    const keys = Object.keys(events).sort();
    const earlier = keys.filter(k => k <= key);
    const alt = earlier.length ? earlier[earlier.length - 1] : keys[keys.length - 1];
    if (alt) {
      entry = events[alt];
      label = alt.slice(0, 2) === key.slice(0, 2) ? 'This month in history' : 'Recently in history';
    }
  }
  if (!entry) { host.hidden = true; return; }
  host.innerHTML = `<span class="otd-label">${esc(label)}${entry.year ? ` · ${esc(String(entry.year))}` : ''}</span> <span class="otd-text">${esc(entry.text)}</span>`;
  host.hidden = false;
}

// -- Recently became law (bills page) --------------------------------------------

async function initRecentLaws() {
  const host = document.getElementById('recent-laws');
  if (!host) return;
  const data = await fetchCivic('recent-laws.json');
  const laws = (data && data.laws) || [];
  if (!laws.length) { host.hidden = true; return; }
  const rows = laws.slice(0, 8).map(l => {
    const href = l.detailPath ? withApiParam(`bill.html?id=${encodeURIComponent(l.detailPath)}`) : null;
    const title = esc(l.title || l.identifier || 'Untitled');
    return `<li class="law-item">
      <span class="law-no">${esc(l.lawNumber || l.identifier || '')}</span>
      <span class="law-title">${href ? `<a href="${href}">${title}</a>` : title}</span>
      <span class="law-date">${esc(formatShortDate(l.actionDate))}</span>
    </li>`;
  }).join('');
  const total = data.totalLawsThisCongress;
  host.innerHTML = `
    <div class="section-heading"><div><p class="eyebrow">Outcomes, not just process</p><h2>Recently became law</h2></div>
    ${total ? `<span class="law-total">${esc(String(total))} laws enacted this Congress</span>` : ''}</div>
    <ul class="law-list">${rows}</ul>`;
  host.hidden = false;
}

// -- Upcoming hearings (bills page) ----------------------------------------------

async function initHearings() {
  const host = document.getElementById('upcoming-hearings');
  if (!host) return;
  const data = await fetchCivic('hearings.json');
  const hearings = (data && data.hearings) || [];
  if (!hearings.length) { host.hidden = true; return; }
  const rows = hearings.slice(0, 6).map(h => `
    <li class="hearing-item">
      <span class="hearing-date">${esc(formatShortDate(h.date))}</span>
      <span class="hearing-body"><strong>${esc(h.title || 'Committee meeting')}</strong>
      <span class="hearing-meta">${esc([h.chamber, h.committee].filter(Boolean).join(' · '))}</span></span>
    </li>`).join('');
  host.innerHTML = `
    <div class="section-heading"><div><p class="eyebrow">What's scheduled</p><h2>Upcoming committee hearings</h2></div></div>
    <ul class="hearing-list">${rows}</ul>`;
  host.hidden = false;
}

// -- Glossary (bills page, expandable; research says inline > standalone) --------

function decodeGlossaryText(value) {
  // Repair UTF-8-as-Windows-1252 mojibake in committed glossary text. Uses
  // fromCharCode on numeric code points so this source stays pure ASCII and
  // no editor/encoding round-trip can corrupt the mappings.
  var C = String.fromCharCode;
  var lead = C(0x00e2) + C(0x20ac);
  var map = [
    [lead + C(0x201d), C(0x2014)], // em dash
    [lead + C(0x201c), C(0x2013)], // en dash
    [lead + C(0x2122), C(0x2019)], // right single quote / apostrophe
    [lead + C(0x02dc), C(0x2018)], // left single quote
    [lead + C(0x0153), C(0x201c)], // left double quote
    [lead + C(0x009d), C(0x201d)], // right double quote
    [lead + C(0x00a6), C(0x2026)]  // ellipsis
  ];
  var out = String(value || '');
  for (var i = 0; i < map.length; i++) { out = out.split(map[i][0]).join(map[i][1]); }
  return out;
}
// The inline glossary tooltips (js/ygn-civic.js) render the same committed
// strings, so they need the same repair rather than a second copy of the map.
window.ygnDecodeGlossary = decodeGlossaryText;

function highlightMatch(text, query) {
  const safe = esc(text);
  const q = (query || '').trim();
  if (q.length < 2) return safe;
  const rx = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  return safe.replace(rx, '<mark>$1</mark>');
}

// Searchable + selectable decoder for congressional jargon (bills page).
async function initTermDecoder() {
  const host = document.getElementById('term-decoder');
  if (!host) return;
  const data = await fetchCivic('glossary.json');
  const terms = ((data && data.terms) || [])
    .map(t => ({ term: decodeGlossaryText(t.term), definition: decodeGlossaryText(t.definition) }))
    .filter(t => t.term && t.definition)
    .sort((a, b) => a.term.localeCompare(b.term));
  if (!terms.length) { host.hidden = true; return; }

  const options = ['<option value="">Jump to a term…</option>']
    .concat(terms.map((t, i) => `<option value="${i}">${esc(t.term)}</option>`))
    .join('');

  host.innerHTML = `
    <div class="decoder-head">
      <div>
        <p class="eyebrow">Plain English</p>
        <h3>Term decoder</h3>
      </div>
      <span class="decoder-count">${terms.length} terms</span>
    </div>
    <div class="decoder-controls">
      <div class="decoder-search-wrap">
        <svg class="decoder-search-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <input type="search" class="decoder-search" placeholder="Search jargon — cloture, markup, PTR…" aria-label="Search congressional terms" autocomplete="off">
      </div>
      <select class="decoder-select" aria-label="Jump to a term">${options}</select>
    </div>
    <div class="decoder-results" aria-live="polite" hidden></div>`;
  host.hidden = false;

  const searchEl = host.querySelector('.decoder-search');
  const selectEl = host.querySelector('.decoder-select');
  const resultsEl = host.querySelector('.decoder-results');

  function render(query, focusIndex) {
    const q = (query || '').trim().toLowerCase();
    // Idle state is the search box alone. Listing all 26 definitions by default
    // put a wall of glossary between the reader and the bills they came for;
    // the terms are also linked inline in the prose now, so the full list is
    // reference material rather than something to scroll past.
    if (!q && focusIndex == null) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
      return;
    }
    resultsEl.hidden = false;
    let matches = terms.map((t, i) => ({ term: t.term, definition: t.definition, i }));
    if (q) {
      matches = matches.filter(t =>
        t.term.toLowerCase().includes(q) || t.definition.toLowerCase().includes(q));
    } else if (focusIndex != null) {
      matches = matches.filter(t => t.i === focusIndex);
    }
    if (!matches.length) {
      resultsEl.innerHTML = `<p class="decoder-empty">No term matches “${esc(query)}”. Try “filibuster”, “quorum”, or “reconciliation”.</p>`;
      return;
    }
    resultsEl.innerHTML = matches.map(t => `
      <div class="decoder-term${t.i === focusIndex ? ' is-focus' : ''}">
        <dt>${highlightMatch(t.term, q)}</dt>
        <dd>${highlightMatch(t.definition, q)}</dd>
      </div>`).join('');
    if (focusIndex != null) {
      const el = resultsEl.querySelector('.is-focus');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }

  let debounce;
  searchEl.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { selectEl.value = ''; render(searchEl.value); }, 60);
  });
  selectEl.addEventListener('change', () => {
    const idx = selectEl.value === '' ? null : Number(selectEl.value);
    searchEl.value = '';
    render('', idx);
  });

  render('');
}

// -- Foreign affairs: executive orders + live treaty actions ----------------------

async function initForeignCivic() {
  const eoHost = document.getElementById('executive-orders');
  if (eoHost) {
    const data = await fetchCivic('executive-orders.json');
    const orders = (data && data.orders) || [];
    if (orders.length) {
      const rows = orders.slice(0, 6).map(o => `
        <article class="eo-card">
          <span class="eo-number">EO ${esc(String(o.number || '—'))}</span>
          <h3>${o.url ? `<a href="${esc(safeUrl(o.url))}" target="_blank" rel="noopener">${esc(o.title || 'Untitled order')}</a>` : esc(o.title || 'Untitled order')}</h3>
          <p class="eo-meta">Signed ${esc(formatShortDate(o.signedDate || o.publicationDate))}</p>
        </article>`).join('');
      eoHost.innerHTML = `
        <div class="foreign-section-heading"><div><p class="eyebrow">White House actions</p><h2>Recent executive orders</h2></div>
        <a class="secondary-button" href="https://www.federalregister.gov/presidential-documents/executive-orders" target="_blank" rel="noopener">Federal Register</a></div>
        <div class="eo-grid">${rows}</div>
        <p class="civic-meta">Source: Federal Register API · refreshed with each data build</p>`;
      eoHost.hidden = false;
    } else { eoHost.hidden = true; }
  }

  const trHost = document.getElementById('treaties-live');
  if (trHost) {
    const data = await fetchCivic('treaties.json');
    const treaties = (data && data.treaties) || [];
    if (treaties.length) {
      const rows = treaties.slice(0, 6).map(t => `
        <li class="treaty-item">
          <span class="treaty-topic">${esc(t.topic || 'Treaty')}</span>
          <span class="treaty-meta">Treaty ${esc(String(t.number || ''))}${t.congress ? ` · received ${esc(String(t.congress))}th Congress` : ''}${t.countriesText ? ` · ${esc(t.countriesText)}` : ''} · updated ${esc(formatShortDate(t.updateDate))}</span>
        </li>`).join('');
      trHost.innerHTML = `
        <div class="foreign-section-heading"><div><p class="eyebrow">Senate treaty queue — live</p><h2>Latest treaty actions</h2></div>
        <a class="secondary-button" href="https://www.congress.gov/search?q=%7B%22source%22%3A%22treaties%22%7D" target="_blank" rel="noopener">All treaties</a></div>
        <ul class="treaty-live-list">${rows}</ul>
        <p class="civic-meta">Source: Congress.gov treaty records · refreshed with each data build</p>`;
      trHost.hidden = false;
    } else { trHost.hidden = true; }
  }
}

// -- Presidential nominations (foreign affairs) ---------------------------------

async function initNominations() {
  const host = document.getElementById('nominations-live');
  if (!host) return;
  const data = await fetchCivic('nominations.json');
  const noms = (data && data.nominations) || [];
  if (!noms.length) { host.hidden = true; return; }
  const rows = noms.slice(0, 6).map(n => `
    <li class="nomination-item">
      <span class="nomination-date">${esc(formatShortDate(n.actionDate || n.receivedDate))}</span>
      <span class="nomination-body">
        <strong>${esc(n.description || `Nomination ${n.number || ''}`)}</strong>
        <span class="nomination-meta">${esc([n.organization, n.actionText].filter(Boolean).join(' · '))}</span>
      </span>
    </li>`).join('');
  host.innerHTML = `
    <div class="foreign-section-heading"><div><p class="eyebrow">Executive business in the Senate</p><h2>Nominations Tracker</h2></div>
    <a class="secondary-button" href="https://www.congress.gov/nominations" target="_blank" rel="noopener">All nominations</a></div>
    <p class="foreign-bills-note">Civilian nominations the Senate is (or was most recently) acting on — ambassadors, agency heads, and judges shape foreign and domestic policy long after a Congress ends.</p>
    <ul class="nomination-list">${rows}</ul>
    <p class="civic-meta">Source: Congress.gov nominations · refreshed with each data build</p>`;
  host.hidden = false;
}

// -- Support spotlight: most-cosponsored recent bills (bills page) ---------------

async function initSupportSpotlight() {
  const host = document.getElementById('support-spotlight');
  if (!host) return;
  const data = await fetchCivic('support-spotlight.json');
  const bills = (data && data.bills) || [];
  if (!bills.length) { host.hidden = true; return; }
  const rows = bills.map(b => {
    const href = b.detailPath ? withApiParam(`bill.html?id=${encodeURIComponent(b.detailPath)}`) : null;
    const title = esc(b.title || b.identifier || 'Untitled bill');
    const splitTitle = (b.democrats != null && b.republicans != null)
      ? `${Number(b.democrats) || 0} Democratic, ${Number(b.republicans) || 0} Republican cosponsors`
      : `${esc(String(b.cosponsorCount))} cosponsors`;
    return `<li class="support-item">
      <span class="support-count" title="${splitTitle}">${esc(String(b.cosponsorCount))}</span>
      <span class="support-body">
        ${href ? `<a href="${href}">${title}</a>` : title}
        <span class="support-meta">${esc(b.identifier || '')}${b.policyArea ? ` · ${esc(b.policyArea)}` : ''}${b.bipartisan ? ' · <strong class="bipartisan-tag">Bipartisan</strong>' : ''}</span>
      </span>
    </li>`;
  }).join('');
  host.innerHTML = `
    <div class="section-heading"><div><p class="eyebrow">Where support is building</p><h2>Most-backed recent bills</h2></div></div>
    <ul class="support-list">${rows}</ul>
    <p class="civic-meta">Ranked by cosponsor count across the tracked recent bills. Cosponsoring is the clearest public signal a member puts their name behind a bill.</p>`;
  host.hidden = false;
}

// -- Gerrymandering scoreboard (home, under the map) -----------------------------

async function initGerryScoreboard() {
  const host = document.getElementById('gerry-scoreboard');
  if (!host) return;
  try {
    const res = await fetch('data/states.json', { cache: 'default' });
    if (!res.ok) throw new Error('states unavailable');
    const payload = await res.json();
    const states = (payload.states || []).filter(s => s.gerrymanderingIndex && Number.isFinite(Number(s.gerrymanderingIndex.score)));
    if (states.length < 6) { host.hidden = true; return; }
    const sorted = states.slice().sort((a, b) => Number(b.gerrymanderingIndex.score) - Number(a.gerrymanderingIndex.score));
    const multi = sorted.filter(s => !/single|at-large/i.test(s.gerrymanderingIndex.label || ''));
    const highest = sorted.slice(0, 3);
    const lowest = multi.slice(-3).reverse();
    const chip = s => `<button type="button" class="gerry-chip" data-fips="${esc(s.fips)}" title="${esc(s.gerrymanderingIndex.label || '')}">
      ${esc(s.abbreviation)} <strong>${esc(String(s.gerrymanderingIndex.score))}</strong></button>`;
    host.innerHTML = `
      <span class="gerry-scoreboard-label">Highest gerrymandering risk:</span> ${highest.map(chip).join('')}
      <span class="gerry-scoreboard-label gerry-scoreboard-label--low">Fairest multi-district maps:</span> ${lowest.map(chip).join('')}`;
    host.hidden = false;
    host.querySelectorAll('.gerry-chip').forEach(btn => {
      btn.addEventListener('click', async () => {
        // The map lazy-loads; make sure its state index exists before selecting.
        if (!stateDataByFips.size) { try { await loadStateData(); } catch (_) { return; } }
        const info = stateDataByFips.get(normalizeFips(btn.dataset.fips));
        if (!info) return;
        updateStatePanel(info, 'click');
        renderMemberListForState(info);
        const panel = document.getElementById('state-panel');
        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  } catch (_) { host.hidden = true; }
}

// -- Trending topics (home): what Congress is legislating about right now --------

function renderTrendingTopics(digest) {
  const host = document.getElementById('trending-topics');
  if (!host || !digest) return;
  const counts = {};
  (digest.bills || []).forEach(b => { if (b.policyArea) counts[b.policyArea] = (counts[b.policyArea] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (top.length < 2) { host.hidden = true; return; }
  host.innerHTML = `<span class="trending-label">Trending in Congress:</span>` + top.map(([area, n]) =>
    `<a class="trending-chip" href="${withApiParam(`recent-bills.html?topic=${encodeURIComponent(area)}`)}">${esc(area)} <strong>${n}</strong></a>`
  ).join('');
  host.hidden = false;
}

// -- Saved bills (mirrors saved members): star bills, filter to your list --------

const SAVED_BILLS_STORAGE_KEY = 'ygn_saved_bills_v1';
let showSavedBillsOnly = false;

// Entries are {path, identifier, title} so bills tracked from anywhere (detail
// pages, spotlight) can be listed even when they aren't in the digest slice.
// Legacy plain-string entries (path only) are still accepted.
function savedBillEntries() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_BILLS_STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .map(x => (typeof x === 'string' ? { path: x } : x))
      .filter(x => x && typeof x.path === 'string' && x.path);
  } catch (_) { return []; }
}

function savedBillPaths() {
  return savedBillEntries().map(e => e.path);
}

function isBillSaved(detailPath) {
  return !!detailPath && savedBillPaths().includes(detailPath);
}

function toggleSavedBill(detailPath, meta) {
  if (!detailPath) return false;
  const entries = savedBillEntries();
  const idx = entries.findIndex(e => e.path === detailPath);
  if (idx >= 0) entries.splice(idx, 1);
  else entries.push({ path: detailPath, identifier: (meta && meta.identifier) || null, title: (meta && meta.title) || null });
  try { localStorage.setItem(SAVED_BILLS_STORAGE_KEY, JSON.stringify(entries)); } catch (_) { /* private mode */ }
  return idx < 0;
}

function billSaveButtonHtml(detailPath, compact, meta) {
  if (!detailPath) return '';
  const saved = isBillSaved(detailPath);
  return `<button type="button" class="bill-save-button${compact ? ' bill-save-button--compact' : ''}${saved ? ' is-saved' : ''}"
    data-bill-path="${esc(detailPath)}" data-bill-identifier="${esc((meta && meta.identifier) || '')}"
    data-bill-title="${esc(((meta && meta.title) || '').slice(0, 120))}"
    aria-pressed="${saved ? 'true' : 'false'}"
    title="${saved ? 'Remove from tracked bills' : 'Track this bill'}">${saved ? '★' : '☆'}</button>`;
}

function wireBillSaveButtons(scope) {
  (scope || document).querySelectorAll('.bill-save-button').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const saved = toggleSavedBill(btn.dataset.billPath, {
        identifier: btn.dataset.billIdentifier || null,
        title: btn.dataset.billTitle || null,
      });
      btn.classList.toggle('is-saved', saved);
      btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
      btn.textContent = saved ? '★' : '☆';
      btn.title = saved ? 'Remove from tracked bills' : 'Track this bill';
      // Keep the chip row's count fresh; drop rows immediately in saved-only view.
      renderBillFilterChips();
      if (showSavedBillsOnly) renderBillRows();
    });
  });
}

// -- Global quick search (all pages): members + recent bills ----------------------

// Shared reader for the committed digest (124 KB): the bill detail page's
// related-bills block and the global quick search both want it. A failure is not
// memoized, mirroring the rule ensureQuickSearchData documents below.
let staticBillsDigestPromise = null;
function loadStaticBillsDigest() {
  if (!staticBillsDigestPromise) {
    staticBillsDigestPromise = fetch('data/recent-bills-digest.json', { cache: 'default' })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(value => {
        if (!value) staticBillsDigestPromise = null;
        return value;
      });
  }
  return staticBillsDigestPromise;
}

let quickSearchData = null;

async function ensureQuickSearchData() {
  if (quickSearchData) return quickSearchData;
  const [membersLoadedOk, digestRes] = await Promise.all([
    loadMemberDataOnly().then(() => true).catch(() => false),
    loadStaticBillsDigest(),
  ]);
  const bills = (digestRes && digestRes.bills) || (currentBillsDigest && currentBillsDigest.bills) || [];
  const data = {
    members: membersLoadedOk ? allMembers : [],
    bills,
  };
  // Don't memoize a total failure — a transient network blip on first focus
  // shouldn't leave search permanently empty for the session.
  if (data.members.length || data.bills.length) quickSearchData = data;
  return data;
}

function quickSearchMatches(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2 || !quickSearchData) return [];
  const results = [];
  for (const m of quickSearchData.members) {
    const name = getMemberField(m, 'name', 'directOrderName', 'invertedOrderName');
    const state = getMemberField(m, 'state');
    if (name.toLowerCase().includes(q) || state.toLowerCase() === q) {
      const id = getMemberField(m, 'bioguideId', 'bioguide_id');
      results.push({
        kind: 'Member',
        label: formatMemberDisplayName(m) || name,
        meta: [memberPartyLabel(m), state, getMemberChamber(m)].filter(Boolean).join(' · '),
        href: withApiParam(`member.html?id=${encodeURIComponent(id)}`),
      });
      if (results.length >= 5) break;
    }
  }
  const memberCount = results.length;
  for (const b of quickSearchData.bills) {
    const title = String(b.title || '');
    const ident = String(b.identifier || '');
    if (title.toLowerCase().includes(q) || ident.toLowerCase().replace(/\s+/g, '').includes(q.replace(/\s+/g, ''))) {
      results.push({
        kind: 'Bill',
        label: `${ident} — ${title.slice(0, 70)}${title.length > 70 ? '…' : ''}`,
        meta: b.policyArea || b.originChamber || '',
        href: b.detailPath ? withApiParam(`bill.html?id=${encodeURIComponent(b.detailPath)}`) : null,
      });
      if (results.length >= memberCount + 5) break;
    }
  }
  return results.filter(r => r.href);
}

function initGlobalSearch() {
  const nav = document.querySelector('.main-nav');
  if (!nav || document.getElementById('global-search')) return;

  const wrap = document.createElement('div');
  wrap.className = 'global-search';
  wrap.innerHTML = `
    <input id="global-search" type="search" placeholder="Search members & bills…"
      autocomplete="off" aria-label="Search members and bills" role="combobox" aria-expanded="false">
    <div id="global-search-results" class="global-search-results" role="listbox" hidden></div>`;
  nav.appendChild(wrap);

  const input = wrap.querySelector('#global-search');
  const resultsEl = wrap.querySelector('#global-search-results');
  let active = -1;

  function close() { resultsEl.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; }

  // The nav uses overflow-x:auto for mobile scrolling, which clips an absolutely
  // positioned dropdown. Anchor the (position:fixed) results to the input rect so
  // it escapes the clip entirely.
  function positionResults() {
    const r = input.getBoundingClientRect();
    resultsEl.style.top = `${r.bottom + 4}px`;
    const width = Math.min(Math.max(r.width, 300), window.innerWidth - 16);
    resultsEl.style.width = `${width}px`;
    resultsEl.style.left = `${Math.min(r.left, window.innerWidth - width - 8)}px`;
  }

  function render(matches) {
    positionResults();
    if (!matches.length) {
      resultsEl.innerHTML = `<div class="global-search-empty">No members or recent bills match.</div>`;
      resultsEl.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      return;
    }
    resultsEl.innerHTML = matches.map((m, i) => `
      <a class="global-search-item" role="option" data-index="${i}" href="${m.href}">
        <span class="gs-kind gs-kind--${m.kind.toLowerCase()}">${m.kind}</span>
        <span class="gs-body"><span class="gs-label">${esc(m.label)}</span>${m.meta ? `<span class="gs-meta">${esc(m.meta)}</span>` : ''}</span>
      </a>`).join('');
    resultsEl.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  }

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value;
    if (q.trim().length < 2) { close(); return; }
    timer = setTimeout(async () => {
      await ensureQuickSearchData();
      render(quickSearchMatches(q));
    }, 160);
  });
  input.addEventListener('focus', () => { ensureQuickSearchData(); });
  input.addEventListener('keydown', event => {
    const items = [...resultsEl.querySelectorAll('.global-search-item')];
    if (event.key === 'Escape') { close(); input.blur(); return; }
    if (!items.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active = event.key === 'ArrowDown'
        ? (active + 1) % items.length
        : (active - 1 + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('is-active', i === active));
      items[active].scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      window.location.href = items[active].href;
    }
  });
  document.addEventListener('click', event => {
    if (!wrap.contains(event.target)) close();
  });
  // Keep the fixed dropdown aligned with the input as the page scrolls/resizes.
  const realign = () => { if (!resultsEl.hidden) positionResults(); };
  window.addEventListener('scroll', realign, { passive: true });
  window.addEventListener('resize', realign);
}

// -- Compare two members (members page) -------------------------------------------

let compareSelection = [];

function compareToggle(bioguideId) {
  const idx = compareSelection.indexOf(bioguideId);
  if (idx >= 0) compareSelection.splice(idx, 1);
  else {
    if (compareSelection.length >= 2) compareSelection.shift();
    compareSelection = [...compareSelection, bioguideId];
  }
  document.querySelectorAll('.member-compare-button').forEach(btn => {
    const on = compareSelection.includes(btn.dataset.compareId);
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  renderCompareBar();
}

function renderCompareBar() {
  let bar = document.getElementById('compare-bar');
  if (!compareSelection.length) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'compare-bar';
    bar.className = 'compare-bar';
    document.body.appendChild(bar);
  }
  const names = compareSelection.map(id => {
    const m = allMembers.find(x => getMemberField(x, 'bioguideId', 'bioguide_id') === id);
    return m ? esc(formatMemberDisplayName(m)) : esc(id);
  });
  bar.innerHTML = `
    <span class="compare-bar-label">Compare:</span> ${names.join(' <span class="compare-vs">vs</span> ')}
    ${compareSelection.length === 2
      ? `<button type="button" class="primary-button compare-go">Compare</button>`
      : `<span class="compare-hint">pick one more member</span>`}
    <button type="button" class="compare-clear" aria-label="Clear comparison">✕</button>`;
  const go = bar.querySelector('.compare-go');
  if (go) go.addEventListener('click', openCompareModal);
  bar.querySelector('.compare-clear').addEventListener('click', () => {
    compareSelection = [];
    document.querySelectorAll('.member-compare-button').forEach(btn => {
      btn.classList.remove('is-selected');
      btn.setAttribute('aria-pressed', 'false');
    });
    renderCompareBar();
  });
}

async function openCompareModal() {
  if (compareSelection.length !== 2) return;
  const scores = await loadMemberScoreIndex();
  const nominate = (scores && scores.nominate) || {};
  const ethics = (scores && scores.ethics) || {};
  const cols = compareSelection.map(id => {
    const m = allMembers.find(x => getMemberField(x, 'bioguideId', 'bioguide_id') === id) || {};
    const nom = nominate[id];
    const eth = ethics[id];
    return {
      id,
      name: formatMemberDisplayName(m) || id,
      party: memberPartyLabel(m) || '—',
      state: getMemberField(m, 'state') || '—',
      chamber: getMemberChamber(m) || '—',
      seat: formatDistrictLabel(m) || 'Statewide',
      ideology: nom && Number.isFinite(Number(nom.dim1)) ? Number(nom.dim1).toFixed(2) : '—',
      grade: eth && eth.grade && eth.grade !== 'N/A' ? eth.grade : '—',
    };
  });
  const row = (label, key) => `<tr><th scope="row">${esc(label)}</th>${cols.map(c => `<td>${esc(String(c[key]))}</td>`).join('')}</tr>`;
  const overlay = document.createElement('div');
  overlay.className = 'compare-overlay';
  overlay.innerHTML = `
    <div class="compare-modal" role="dialog" aria-modal="true" aria-label="Compare members">
      <button type="button" class="compare-close" aria-label="Close comparison">✕</button>
      <h2>Side by side</h2>
      <table class="compare-table">
        <thead><tr><th></th>${cols.map(c => `<th><a href="${withApiParam(`member.html?id=${encodeURIComponent(c.id)}`)}">${esc(c.name)}</a></th>`).join('')}</tr></thead>
        <tbody>
          ${row('Party', 'party')}
          ${row('State', 'state')}
          ${row('Chamber', 'chamber')}
          ${row('Seat', 'seat')}
          ${row('Ideology (DW-NOMINATE)', 'ideology')}
          ${row('Ethics grade', 'grade')}
        </tbody>
      </table>
      <p class="civic-meta">Ideology: −1 most liberal … +1 most conservative (voting record). Ethics grade is YGN's campaign-finance + stock-trading measure; "—" means no evidence-backed grade yet.</p>
    </div>`;
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('.compare-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

// -- Ideology distribution strip (members page) -----------------------------------

async function renderIdeologyStrip(list) {
  const host = document.getElementById('ideology-strip');
  if (!host) return;
  const scores = await loadMemberScoreIndex();
  const nominate = (scores && scores.nominate) || {};
  const values = [];
  (list || []).forEach(m => {
    const id = getMemberField(m, 'bioguideId', 'bioguide_id');
    const s = nominate[id];
    if (s && Number.isFinite(Number(s.dim1))) values.push({ v: Number(s.dim1), party: memberPartyCode(m) });
  });
  if (values.length < 8) { host.hidden = true; host.innerHTML = ''; return; }

  const BUCKETS = 22;
  const counts = Array.from({ length: BUCKETS }, () => ({ D: 0, R: 0, I: 0 }));
  values.forEach(({ v, party }) => {
    const idx = Math.max(0, Math.min(BUCKETS - 1, Math.floor(((v + 1) / 2) * BUCKETS)));
    counts[idx][party in counts[idx] ? party : 'I'] += 1;
  });
  const max = Math.max(...counts.map(c => c.D + c.R + c.I), 1);
  const bars = counts.map(c => {
    const total = c.D + c.R + c.I;
    const height = total ? Math.max(8, (total / max) * 100) : 0;
    const dominant = c.D >= c.R && c.D >= c.I ? 'd' : c.R >= c.I ? 'r' : 'i';
    return `<span class="ideo-bar ideo-bar--${dominant}" style="height:${height}%" title="${total} member${total === 1 ? '' : 's'}"></span>`;
  }).join('');
  host.innerHTML = `
    <div class="ideo-head"><span>Ideology of the ${values.length} member${values.length === 1 ? '' : 's'} shown</span>
    <span class="ideo-scale"><span>← more liberal</span><span>more conservative →</span></span></div>
    <div class="ideo-bars">${bars}</div>`;
  host.hidden = false;
}

// -- Bill detail extras: what happens next + related bills --------------------------

function whatHappensNextHtml(bill) {
  const { stages, index } = billStage(bill);
  // Stage shapes: simple resolution = [Introduced, Agreed]; concurrent =
  // [Introduced, Agreed 1st, Agreed 2nd]; full bill/joint resolution =
  // [Introduced, Passed 1st, Passed 2nd, To President, Became Law].
  const isSimpleRes = stages.length === 2;
  const isConcurrentRes = stages.length === 3;
  const isFullBill = stages.length === 5;
  let text;
  if (isFullBill && index === 4) {
    text = 'This bill is law. Agencies now implement it, and Congress can oversee, fund, or amend how it works in practice.';
  } else if (isFullBill && index === 3) {
    text = 'The President has 10 days to sign it into law or veto it. A veto goes back to Congress, which can override with two-thirds of both chambers.';
  } else if (isFullBill && index === 2) {
    text = 'Both chambers have passed it. Once any differences between their versions are resolved, it is enrolled and presented to the President.';
  } else if ((isSimpleRes && index === 1) || (isConcurrentRes && index === 2)) {
    text = 'This resolution has been agreed to — resolutions express the chamber\'s position or set its rules and do not go to the President.';
  } else if (isConcurrentRes && index === 1) {
    // stages[2] is "Agreed to {second chamber}" — name that chamber.
    const other = /senate/i.test(stages[2] || '') ? 'Senate' : 'House';
    text = `One chamber has agreed to it. The ${other} must agree to the same text for it to take effect — concurrent resolutions bind Congress, not the public, and never go to the President.`;
  } else if (isFullBill && index === 1) {
    const other = /senate/i.test(stages[2] || '') ? 'Senate' : 'House';
    text = `One chamber has passed it. The ${other} must pass the same text next — most bills stall here; if versions differ, the chambers must reconcile them.`;
  } else {
    text = 'It sits with committee, which can hold hearings, amend ("mark up"), approve, or simply never act — the fate of roughly 9 in 10 bills. A floor vote only comes if leadership schedules one.';
  }
  return `<p class="what-next"><strong>What happens next:</strong> ${esc(text)}</p>`;
}

async function injectRelatedBills(container, bill) {
  if (!bill || !bill.policyArea || !bill.detailPath) return;
  try {
    const digest = await loadStaticBillsDigest();
    if (!digest) return;
    const related = (digest.bills || []).filter(b =>
      b.policyArea === bill.policyArea && b.detailPath && b.detailPath !== bill.detailPath
    ).slice(0, 3);
    if (!related.length) return;
    const rows = related.map(b => `
      <a class="related-bill" href="${withApiParam(`bill.html?id=${encodeURIComponent(b.detailPath)}`)}">
        <span class="related-ident">${esc(b.identifier || '')}</span>
        <span class="related-title">${esc((b.title || '').slice(0, 90))}</span>
      </a>`).join('');
    const section = document.createElement('section');
    section.className = 'bill-detail-card';
    section.innerHTML = `
      <h2>More ${esc(bill.policyArea)} bills</h2>
      <div class="related-bills">${rows}</div>
      <p class="civic-meta"><a href="${withApiParam(`recent-bills.html?topic=${encodeURIComponent(bill.policyArea)}`)}">See all recent ${esc(bill.policyArea)} bills →</a></p>`;
    const article = container.querySelector('.bill-detail');
    if (article) article.appendChild(section);
  } catch (_) { /* enrichment only */ }
}

function initCivicFeatures() {
  initLawsStat();
  initWeeklyBrief();
  initVoteSpotlight();
  initOnThisDay();
  initRecentLaws();
  initHearings();
  initTermDecoder();
  initForeignCivic();
  initForeignBrief();
  initForeignSignalBoard();
  initNominations();
  initSupportSpotlight();
  initGerryScoreboard();
  initGlobalSearch();
}

// ─── Initialisation ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Resolve DOM references
  healthIndicator = document.getElementById('health-indicator');
  membersGrid     = document.getElementById('members-grid');
  membersSearch   = document.getElementById('members-search');
  membersPartyFilter   = document.getElementById('members-party');
  membersChamberFilter = document.getElementById('members-chamber');
  membersStateFilter   = document.getElementById('members-state');
  membersSort          = document.getElementById('members-sort');
  membersCount         = document.getElementById('members-count');
  membersSavedToggle   = document.getElementById('members-saved-toggle');
  membersSavedCount    = document.getElementById('members-saved-count');
  homeStats       = document.getElementById('home-stats');
  dailyQuoteEl    = document.getElementById('daily-quote');
  dailyQuoteAuthorEl = document.getElementById('daily-quote-author');
  popoverEl       = document.getElementById('popover');
  popoverName     = popoverEl ? popoverEl.querySelector('.popover-name') : null;
  popoverSummary  = popoverEl ? popoverEl.querySelector('.popover-summary') : null;
  popoverClose    = document.getElementById('popover-close');
  mapSvg           = document.getElementById('us-map');
  mapStatus        = document.getElementById('map-status');
  mapTooltip       = document.getElementById('map-tooltip');
  statePanel       = document.getElementById('state-panel');
  stateNameEl      = document.getElementById('state-name');
  stateSummaryEl   = document.getElementById('state-summary');
  statePopulationEl = document.getElementById('state-population');
  stateLeanEl      = document.getElementById('state-lean');
  gerryScoreEl     = document.getElementById('gerry-score');
  gerryMeterFill   = document.getElementById('gerry-meter-fill');
  gerryNoteEl      = document.getElementById('gerry-note');
  districtStatusEl = document.getElementById('district-status');
  districtListEl   = document.getElementById('district-list');
  viewStateMembersBtn = document.getElementById('view-state-members');
  mapResetBtn      = document.getElementById('map-reset');
  methodologyOpenBtn = document.getElementById('methodology-open');
  methodologyBackBtn = document.getElementById('methodology-back');
  gerryInfoBtn     = document.getElementById('gerry-info');
  recentBillsGrid  = document.getElementById('recent-bills-grid');
  recentBillsStatus = document.getElementById('recent-bills-status');
  civicPulseGrid   = document.getElementById('civic-pulse-grid');

  // ── Home stats placeholder
  initNavLinks();
  if (document.body.dataset.page === 'members' || document.body.dataset.page === 'member') {
    syncSavedMembersUi();
    window.addEventListener('storage', handleSavedMemberStorage);
  }
  if (homeStats) {
    initHomeStats();
    initDailyQuote();
    refreshHomeMetrics();
    setInterval(refreshHomeMetrics, 900_000);
    initCongressBalance();
  }
  initRecentBills();
  initCivicFeatures();

  // ── Navigation
  document.querySelectorAll('.main-nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.dataset.section;
      showSection(section);

      // Lazy-load members when navigating to that section
      if (section === 'members' && !membersLoaded) {
        loadMembers();
      }
    });
  });

  // ── Default section
  if (document.body.dataset.page === 'members' && membersGrid && membersSearch && !membersLoaded) {
    loadMembers().then(applyInitialMemberQuery);
  }
  if (document.body.dataset.page === 'member') {
    initMemberPage();
  }
  if (document.body.dataset.page === 'bill') {
    initBillPage();
  }
  if (document.body.dataset.page === 'economy') {
    initEconomy();
  }
  if (document.body.dataset.page === 'foreign') {
    initForeignBills();
  }
  if (mapSvg) {
    initMapWhenReady();
    const legend = document.getElementById('map-legend');
    if (legend) legend.innerHTML = mapLegendHtml();
    document.querySelectorAll('.map-colorby-btn').forEach(btn => {
      btn.addEventListener('click', () => setMapColorMode(btn.dataset.mode));
    });
  }
  scrollToHashTarget();

  // ── Health check: immediate + every 30 seconds
  checkHealth().then(source => {
    if (source !== 'api') return;
    setInterval(() => {
      if (!document.hidden) checkHealth();
    }, 120_000);
  });

  // ── Search
  if (membersSearch) {
    // Debounce: filtering rebuilds the whole grid, so run it once the user
    // pauses typing rather than on every keystroke.
    let searchTimer = null;
    membersSearch.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilters, 150);
    });
  }
  [membersPartyFilter, membersChamberFilter, membersStateFilter, membersSort].forEach(control => {
    if (control) control.addEventListener('change', applyFilters);
  });
  if (membersSavedToggle) {
    membersSavedToggle.addEventListener('click', () => setSavedMembersOnly(!showSavedMembersOnly));
  }

  if (viewStateMembersBtn) viewStateMembersBtn.addEventListener('click', openStateMembersSearch);
  if (mapResetBtn) mapResetBtn.addEventListener('click', resetMapView);
  if (methodologyOpenBtn) methodologyOpenBtn.addEventListener('click', event => {
    event.preventDefault();
    openMethodology();
  });
  if (gerryInfoBtn) gerryInfoBtn.addEventListener('click', event => {
    event.preventDefault();
    openMethodology();
  });
  if (methodologyBackBtn) methodologyBackBtn.addEventListener('click', event => {
    event.preventDefault();
    showSection('map');
  });

  // ── Popover: cancel hide when mouse enters popover
  if (popoverEl) {
    popoverEl.addEventListener('mouseenter', cancelPopoverHide);
    popoverEl.addEventListener('mouseleave', schedulePopoverHide);
  }

  // ── Popover: close button
  if (popoverClose) popoverClose.addEventListener('click', hidePopover);

  // ── Popover: Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popoverEl && popoverEl.classList.contains('visible')) {
      hidePopover();
    }
  });

  // ── Popover: outside click
  document.addEventListener('click', (e) => {
    if (
      popoverEl &&
      popoverEl.classList.contains('visible') &&
      !popoverEl.contains(e.target) &&
      !e.target.closest('.member-tile')
    ) {
      hidePopover();
    }
  });
});



// -- Foreign affairs: AI brief (Azure, regenerated at most every 12h) -----------
// The page ships with hand-written fallback cards so it is never blank. When the
// brief is available we replace the Conflict Watch grid with live AI content and
// reveal the diplomacy/outlook section. Everything is guarded: any failure leaves
// the static fallback exactly as it was.

const FOREIGN_WATCH_KEY = 'ygn-foreign-watch';

function foreignWatchRead() {
  try { return JSON.parse(localStorage.getItem(FOREIGN_WATCH_KEY) || '[]'); }
  catch (_) { return []; }
}
function foreignWatchWrite(list) {
  try { localStorage.setItem(FOREIGN_WATCH_KEY, JSON.stringify(list.slice(0, 40))); }
  catch (_) { /* private mode */ }
}

function formatRelativeAge(seconds) {
  if (seconds == null || !isFinite(seconds)) return '';
  const hours = Math.floor(seconds / 3600);
  if (hours < 1) return 'just now';
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function formatCountdown(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return 'due now';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  if (hours >= 1) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

async function initForeignBrief() {
  const grid = document.getElementById('conflict-grid');
  const toolbar = document.getElementById('foreign-brief-toolbar');
  const outlookHost = document.getElementById('foreign-outlook');
  if (!grid) return;

  let data = null;
  try {
    const result = await fetchJsonWithStaticFallback(
      '/foreign/brief', 'civic/foreign-brief.json', { cache: 'no-store' }
    );
    data = result && result.data;
  } catch (_) {
    return; // keep the static fallback cards
  }

  const conflicts = (data && data.conflicts) || [];
  if (!conflicts.length) return; // nothing generated yet -> keep fallback

  const diplomacy = (data && data.diplomacy) || [];
  const state = { region: null, query: '', watchedOnly: false };

  function cardKey(conflict) {
    return String(conflict.title || '').toLowerCase().slice(0, 60);
  }

  function visibleConflicts() {
    const watch = foreignWatchRead();
    const query = state.query.trim().toLowerCase();
    return conflicts.filter(conflict => {
      if (state.region && conflict.region !== state.region) return false;
      if (state.watchedOnly && watch.indexOf(cardKey(conflict)) === -1) return false;
      if (query) {
        const hay = [conflict.title, conflict.region, conflict.status, conflict.summary,
          conflict.usLever, conflict.congressWatch].join(' ').toLowerCase();
        if (hay.indexOf(query) === -1) return false;
      }
      return true;
    });
  }

  function renderGrid() {
    const watch = foreignWatchRead();
    const rows = visibleConflicts();
    if (!rows.length) {
      grid.innerHTML = '<p class="foreign-empty">No conflicts match this view. '
        + 'Clear the filters to see the full brief.</p>';
      return;
    }
    grid.innerHTML = rows.map(conflict => {
      const key = cardKey(conflict);
      const starred = watch.indexOf(key) !== -1;
      const tone = ['danger', 'caution', 'steady'].indexOf(conflict.tone) !== -1
        ? conflict.tone : 'caution';
      return `
        <article class="conflict-card conflict-card--ai tone-${esc(tone)}" data-key="${esc(key)}">
          <div class="conflict-card-top">
            <span class="status-pill ${esc(tone)}">${esc(conflict.status || 'Watch')}</span>
            <span class="conflict-region">${esc(conflict.region || 'Global')}</span>
          </div>
          <h3>${esc(conflict.title || '')}</h3>
          <p>${esc(conflict.summary || '')}</p>
          <dl>
            ${conflict.usLever ? `<div><dt>U.S. lever</dt><dd>${esc(conflict.usLever)}</dd></div>` : ''}
            ${conflict.congressWatch ? `<div><dt>In Congress</dt><dd>${esc(conflict.congressWatch)}</dd></div>` : ''}
          </dl>
          <button type="button" class="conflict-watch-btn${starred ? ' is-on' : ''}"
                  data-key="${esc(key)}"
                  aria-pressed="${starred ? 'true' : 'false'}"
                  aria-label="${starred ? 'Remove from' : 'Add to'} watchlist">
            ${starred ? '★' : '☆'} <span>${starred ? 'Watching' : 'Watch'}</span>
          </button>
        </article>`;
    }).join('');

    grid.querySelectorAll('.conflict-watch-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const list = foreignWatchRead();
        const at = list.indexOf(key);
        if (at === -1) list.push(key); else list.splice(at, 1);
        foreignWatchWrite(list);
        renderGrid();
        renderToolbarCounts();
      });
    });
  }

  function renderToolbarCounts() {
    const label = toolbar && toolbar.querySelector('.foreign-count');
    if (label) {
      const shown = visibleConflicts().length;
      label.textContent = shown === conflicts.length
        ? `${conflicts.length} tracked`
        : `${shown} of ${conflicts.length}`;
    }
    const watchBtn = toolbar && toolbar.querySelector('.foreign-watch-toggle');
    if (watchBtn) {
      const n = foreignWatchRead().length;
      watchBtn.textContent = n ? `★ Watchlist (${n})` : '☆ Watchlist';
      watchBtn.classList.toggle('is-on', state.watchedOnly);
      watchBtn.setAttribute('aria-pressed', state.watchedOnly ? 'true' : 'false');
    }
  }

  // ---- toolbar: freshness, search, region filter, watchlist, copy ----
  if (toolbar) {
    const regions = [];
    conflicts.forEach(c => {
      if (c.region && regions.indexOf(c.region) === -1) regions.push(c.region);
    });
    const age = formatRelativeAge(data.age_seconds);
    const next = formatCountdown(data.next_refresh_seconds);
    toolbar.innerHTML = `
      <div class="foreign-brief-meta">
        <span class="foreign-ai-badge">AI brief</span>
        <span class="foreign-count">${conflicts.length} tracked</span>
        <span class="foreign-freshness" title="This brief regenerates at most once every 12 hours">
          Updated ${esc(age)} &middot; next refresh ${esc(next)}
        </span>
      </div>
      <div class="foreign-brief-controls">
        <input type="search" class="foreign-search" placeholder="Search conflicts, levers, regions..."
               aria-label="Search the foreign-affairs brief" autocomplete="off">
        <div class="foreign-region-chips" role="group" aria-label="Filter by region">
          <button type="button" class="foreign-chip is-on" data-region="">All regions</button>
          ${regions.map(r => `<button type="button" class="foreign-chip" data-region="${esc(r)}">${esc(r)}</button>`).join('')}
        </div>
        <button type="button" class="foreign-watch-toggle">☆ Watchlist</button>
        <button type="button" class="foreign-copy">Copy brief</button>
      </div>`;
    toolbar.hidden = false;

    const search = toolbar.querySelector('.foreign-search');
    let debounce;
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.query = search.value; renderGrid(); renderToolbarCounts(); }, 70);
    });

    toolbar.querySelectorAll('.foreign-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        state.region = chip.dataset.region || null;
        toolbar.querySelectorAll('.foreign-chip').forEach(c => c.classList.toggle('is-on', c === chip));
        renderGrid(); renderToolbarCounts();
      });
    });

    toolbar.querySelector('.foreign-watch-toggle').addEventListener('click', () => {
      state.watchedOnly = !state.watchedOnly;
      renderGrid(); renderToolbarCounts();
    });

    toolbar.querySelector('.foreign-copy').addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      const text = [
        'YGN foreign-affairs brief',
        `Updated ${age}`,
        '',
        ...conflicts.map(c => `- ${c.title} (${c.region}, ${c.status}): ${c.summary}`),
        '',
        ...(data.outlook ? ['Outlook: ' + data.outlook] : []),
      ].join('\n');
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
      } catch (_) {
        btn.textContent = 'Copy failed';
      }
      setTimeout(() => { btn.textContent = 'Copy brief'; }, 1600);
    });
  }

  renderGrid();
  renderToolbarCounts();

  // The hero board is built by initForeignSignalBoard(), which runs before this
  // fetch resolves and therefore counts the static fallback cards. Correct it now
  // that the real brief has rendered. Deliberately `conflicts.length` and not the
  // filtered count: the board reports what is tracked, not what is on screen.
  const conflictTile = document.getElementById('sig-conflicts');
  if (conflictTile) conflictTile.textContent = String(conflicts.length);

  // ---- diplomacy read + outlook ----
  if (outlookHost && (diplomacy.length || data.outlook)) {
    outlookHost.innerHTML = `
      <div class="foreign-section-heading">
        <div>
          <p class="eyebrow">Diplomacy read</p>
          <h2>What Washington is working on</h2>
        </div>
        <span class="foreign-ai-badge">AI brief</span>
      </div>
      ${diplomacy.length ? `<div class="diplomacy-grid">${diplomacy.map(item => `
        <article class="diplomacy-card tone-${esc(['danger','caution','steady'].indexOf(item.tone) !== -1 ? item.tone : 'steady')}">
          <h3>${esc(item.title || '')}</h3>
          <p>${esc(item.detail || '')}</p>
        </article>`).join('')}</div>` : ''}
      ${data.outlook ? `<div class="foreign-outlook-note"><h3>What to watch next</h3><p>${esc(data.outlook)}</p></div>` : ''}
      <p class="civic-meta">Written by an AI model from Congress.gov, Federal Register and Senate
        treaty records, and regenerated at most once every 12 hours. It summarizes government
        activity only &mdash; it does not report public opinion, and any specific figure should be
        checked against the linked primary source.</p>`;
    outlookHost.hidden = false;
  }
}

// The hero signal board used to be four hand-typed numbers presented as live
// counters -- and one of them ("Active conflict lanes: 4") disagreed with the five
// conflict cards rendered directly below it. Count the things actually on the page
// instead, and leave a tile as an em dash when its source has not loaded rather
// than showing a number nobody can check.
async function initForeignSignalBoard() {
  const board = document.querySelector('.foreign-signal-board');
  if (!board) return;

  function set(id, value) {
    const node = document.getElementById(id);
    if (node && Number.isFinite(value)) node.textContent = String(value);
  }

  // Conflicts: whatever the brief actually rendered (AI cards, else the fallback).
  const conflicts = document.querySelectorAll('.conflict-card--ai').length
    || document.querySelectorAll('.conflict-card').length;
  set('sig-conflicts', conflicts);

  const [treaties, nominations, hearings] = await Promise.all([
    fetchCivic('treaties.json').catch(() => null),
    fetchCivic('nominations.json').catch(() => null),
    fetchCivic('hearings.json').catch(() => null)
  ]);
  if (treaties && Array.isArray(treaties.treaties)) set('sig-treaties', treaties.treaties.length);
  if (nominations && Array.isArray(nominations.nominations)) set('sig-nominations', nominations.nominations.length);
  if (hearings && Array.isArray(hearings.hearings)) set('sig-meetings', hearings.hearings.length);
}
