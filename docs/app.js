/* ═══════════════════════════════════════════════════════════════════════════
   YGN — Civic Government Portal — app.js
   Vanilla JS, no framework, no build step.
   API_BASE_URL is declared in config.js, which is loaded before this script.
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Client-side caches ──────────────────────────────────────────────────────
const wikiCache = new Map();      // bioguideId → { summary, title } | null
const nominateCache = new Map();  // bioguideId → { dim1 } | null
const ethicsCache = new Map();    // bioguideId -> { score, grade } | null
let memberScoreIndex = null;
let scoreObserver = null;

// ─── Application state ───────────────────────────────────────────────────────
let allMembers = [];          // full sorted member array after first load
let membersLoaded = false;    // flag to avoid re-fetching
let stateData = [];
let stateDataByFips = new Map();
let stateDataByAbbr = new Map();
let selectedMapState = null;
let lockedMapState = null;
let mapInitialized = false;
let congressionalDistricts = null;
let congressionalDistrictsByFips = new Map();
let congressionalDistrictPromisesByFips = new Map();
let memberDataLoadPromise = null;
let populationTicker = null;

const STATE_ABBR_TO_NAME = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming'
};

const DISTRICTS_FEATURE_QUERY_URL = 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Congressional_Districts/FeatureServer/0/query';
const STATES_TOPOJSON_URL = 'data/states-10m.json';
const PAGE_URLS = {
  home: 'index.html',
  members: 'members.html',
  map: 'index.html#district-map',
  methodology: 'methodology.html',
  ethics: 'ethics-methodology.html',
  bills: 'recent-bills.html',
  foreign: 'foreign-affairs.html',
  economy: 'economy.html'
};

const DAILY_QUOTES = [
  {
    text: 'The advancement and diffusion of knowledge is the only guardian of true liberty.',
    author: 'James Madison'
  },
  {
    text: 'The ballot is stronger than the bullet.',
    author: 'Abraham Lincoln'
  },
  {
    text: 'Let us never forget that government is ourselves and not an alien power over us.',
    author: 'Franklin D. Roosevelt'
  },
  {
    text: 'If there is no struggle, there is no progress.',
    author: 'Frederick Douglass'
  },
  {
    text: 'Democracy is not a state. It is an act.',
    author: 'John Lewis'
  },
  {
    text: 'The greatness of a community is most accurately measured by the compassionate actions of its members.',
    author: 'Coretta Scott King'
  },
  {
    text: 'Public service must be more than doing a job efficiently and honestly. It must be a complete dedication to the people.',
    author: 'Margaret Chase Smith'
  }
];

// ─── Popover state ───────────────────────────────────────────────────────────
let popoverHideTimer = null;
let currentAnchor = null;

// ─── DOM references ──────────────────────────────────────────────────────────
// Resolved after DOMContentLoaded
let healthIndicator;
let membersGrid;
let membersSearch;
let homeStats;
let dailyQuoteEl;
let dailyQuoteAuthorEl;
let popoverEl;
let popoverName;
let popoverSummary;
let popoverClose;
let mapSvg;
let mapStatus;
let mapTooltip;
let statePanel;
let stateNameEl;
let stateSummaryEl;
let statePopulationEl;
let stateLeanEl;
let gerryScoreEl;
let gerryMeterFill;
let gerryNoteEl;
let districtStatusEl;
let districtListEl;
let viewStateMembersBtn;
let mapResetBtn;
let methodologyOpenBtn;
let methodologyBackBtn;
let gerryInfoBtn;
let recentBillsGrid;
let recentBillsStatus;
let civicPulseGrid;

// ─── Utility helpers ─────────────────────────────────────────────────────────

/**
 * Safely get a string field from a member object, trying multiple key names.
 * Returns '' if none found.
 */
function getMemberField(member, ...keys) {
  for (const key of keys) {
    if (member[key] != null && member[key] !== '') return String(member[key]);
  }
  return '';
}

function getLatestTerm(member) {
  const rawTerms = member.terms && Array.isArray(member.terms.item)
    ? member.terms.item
    : Array.isArray(member.terms)
      ? member.terms
      : member.terms && typeof member.terms === 'object'
        ? [member.terms]
        : [];

  if (rawTerms.length === 0) return {};
  return rawTerms.slice().sort((a, b) => Number(b.startYear || 0) - Number(a.startYear || 0))[0] || {};
}

function getMemberChamber(member) {
  return getMemberField(member, 'chamber') || getMemberField(getLatestTerm(member), 'chamber');
}

function getMemberDistrict(member) {
  if (member.district !== null && member.district !== undefined && member.district !== '') {
    return String(member.district);
  }

  const term = getLatestTerm(member);
  if (term.district !== null && term.district !== undefined && term.district !== '') {
    return String(term.district);
  }

  return '';
}

function formatDistrictLabel(member) {
  const explicitLabel = getMemberField(member, 'districtLabel');
  if (explicitLabel) return explicitLabel;

  const chamber = getMemberChamber(member).toLowerCase();
  const district = getMemberDistrict(member);
  if (chamber.includes('senate')) return 'Statewide';
  if (!district) return '';
  if (district === '0') return 'At-large';
  return `District ${district}`;
}

function getMemberPhotoUrl(member, bioguideId) {
  const depiction = member.depiction && typeof member.depiction === 'object' ? member.depiction : {};
  return (
    depiction.imageUrl ||
    member.photoUrl ||
    member.thumbnail ||
    (bioguideId ? `https://bioguide.congress.gov/bioguide/photo/${bioguideId[0]}/${bioguideId}.jpg` : '')
  );
}

function normalizeFips(value) {
  if (value === null || value === undefined) return '';
  return String(value).padStart(2, '0');
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return number.toLocaleString('en-US');
}

function formatCurrencyCompact(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  if (Math.abs(number) >= 1_000_000_000_000) return `$${(number / 1_000_000_000_000).toFixed(2)}T`;
  if (Math.abs(number) >= 1_000_000_000) return `$${(number / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(number) >= 1_000_000) return `$${(number / 1_000_000).toFixed(1)}M`;
  return `$${formatNumber(number)}`;
}

function formatCompact(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  if (Math.abs(number) >= 1_000_000) {
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(number);
  }
  return formatNumber(number);
}

function getStateNameFromAbbr(abbr) {
  const key = String(abbr || '').toUpperCase();
  return (stateDataByAbbr.get(key) && stateDataByAbbr.get(key).name) || STATE_ABBR_TO_NAME[key] || '';
}

function stateSearchMatches(member, query) {
  const stateAbbr = getMemberField(member, 'state').toUpperCase();
  const stateName = getStateNameFromAbbr(stateAbbr).toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  return (
    stateAbbr.toLowerCase().includes(normalizedQuery) ||
    stateName.includes(normalizedQuery)
  );
}

/**
 * Extract the last word (surname) from a full name string.
 * Handles "FirstName LastName" and "LastName, FirstName" formats.
 * Falls back to the full string.
 */
function extractSortKey(name) {
  if (!name) return '';
  // Inverted order "Smith, John" — sort by "Smith"
  const commaIdx = name.indexOf(',');
  if (commaIdx > 0) return name.slice(0, commaIdx).trim().toLowerCase();
  // Direct order "John Smith" — sort by last word
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

/**
 * Build initials from a name — first letter of each word, max 2 letters.
 */
function buildInitials(name) {
  if (!name) return '?';
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0][0].toUpperCase();
  // Use first letter of first word and first letter of last word
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Clamp a number between min and max.
 */
function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

/**
 * Get ethics color based on score (R2/R4)
 */
function getEthicsColor(score) {
  if (score === null || score === undefined || score === '') return '#94a3b8';
  const s = Number(score);
  if (!Number.isFinite(s)) return '#94a3b8';
  if (s <= 50) {
    const ratio = s / 50;
    const r = Math.round(220 + (245 - 220) * ratio);
    const g = Math.round(38 + (158 - 38) * ratio);
    const b = Math.round(38 + (11 - 38) * ratio);
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    const ratio = (s - 50) / 50;
    const r = Math.round(245 + (21 - 245) * ratio);
    const g = Math.round(158 + (128 - 158) * ratio);
    const b = Math.round(11 + (61 - 11) * ratio);
    return `rgb(${r}, ${g}, ${b})`;
  }
}

async function fetchJsonWithStaticFallback(apiPath, staticPath, options = {}) {
  const apiBaseUrl = typeof API_BASE_URL === 'string' ? API_BASE_URL : '';

  if (apiBaseUrl) {
    try {
      const res = await fetch(apiBaseUrl + apiPath, { cache: options.cache || 'default' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { data: await res.json(), source: 'api' };
    } catch (apiError) {
      if (!staticPath) throw apiError;
    }
  }

  if (!staticPath) {
    throw new Error(`No static fallback configured for ${apiPath}`);
  }

  try {
    const res = await fetch(`data/${staticPath}`, { cache: options.staticCache || 'default' });
    if (res.status === 404) return { notFound: true, source: 'static' };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: await res.json(), source: 'static' };
  } catch (staticError) {
    throw staticError;
  }
}

// ─── Navigation (SPA routing) ────────────────────────────────────────────────

function apiQuerySuffix() {
  const params = new URLSearchParams(window.location.search);
  const api = params.get('api');
  return api ? `?api=${encodeURIComponent(api)}` : '';
}

function withApiParam(url) {
  const suffix = apiQuerySuffix();
  if (!suffix || url.includes('api=')) return url;
  const hashIndex = url.indexOf('#');
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  return base.includes('?') ? `${base}&${suffix.slice(1)}${hash}` : `${base}${suffix}${hash}`;
}

function showSection(sectionId) {
  const url = PAGE_URLS[sectionId] || PAGE_URLS.home;
  window.location.href = withApiParam(url);
}

function initNavLinks() {
  const activePage = document.body.dataset.page || 'home';
  const brandHome = document.getElementById('brand-home');
  if (brandHome) {
    brandHome.setAttribute('href', withApiParam(brandHome.getAttribute('href') || PAGE_URLS.home));
  }

  document.querySelectorAll('.main-nav a').forEach(link => {
    if (link.dataset.page === activePage) {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    } else {
      link.classList.remove('active');
      link.removeAttribute('aria-current');
    }

    const href = link.getAttribute('href');
    if (href && !href.startsWith('http')) {
      link.setAttribute('href', withApiParam(href));
    }
  });
}

// ─── Health check ────────────────────────────────────────────────────────────

/**
 * Fetch /health and update the #health-indicator pill.
 */
async function checkHealth() {
  if (!healthIndicator) return;

  healthIndicator.className = 'checking';
  healthIndicator.textContent = 'Checking';

  try {
    const result = await fetchJsonWithStaticFallback('/health', 'health.json', { cache: 'no-store' });
    if (result.data) {
      healthIndicator.className = 'connected';
      healthIndicator.textContent = result.source === 'static' ? 'Static data' : 'Connected';
      updateStatCard(
        'stat-backend',
        'Backend Status',
        result.source === 'static' ? 'Static data OK' : 'Connected OK',
        result.source === 'static' ? 'Static fallback health' : 'Live API health'
      );
    } else {
      throw new Error('non-ok status');
    }
  } catch {
    healthIndicator.className = 'disconnected';
    healthIndicator.textContent = 'Disconnected';
    updateStatCard('stat-backend', 'Backend Status', 'Disconnected', 'YGN API health');
  }
}

// ─── Home stats ──────────────────────────────────────────────────────────────

/**
 * Ensure a stat card with the given id exists in #home-stats.
 * If it doesn't, create it. Then update value + label.
 */
function updateStatCard(id, label, value, source = '') {
  if (!homeStats) return;

  let card = homeStats.querySelector('#' + id);
  if (!card) {
    card = document.createElement('div');
    card.className = 'stat-card';
    card.id = id;
    card.innerHTML = `<div class="stat-label"></div><div class="stat-value"></div><div class="stat-source"></div>`;
    homeStats.appendChild(card);
  } else if (!card.querySelector('.stat-source')) {
    const sourceEl = document.createElement('div');
    sourceEl.className = 'stat-source';
    card.appendChild(sourceEl);
  }

  card.querySelector('.stat-label').textContent = label;
  card.querySelector('.stat-value').textContent = value;
  card.querySelector('.stat-source').textContent = source;
}

/**
 * Initialize home stat cards with placeholder data.
 */
function initHomeStats() {
  updateStatCard('stat-debt', 'National Debt', '-', 'Treasury Fiscal Data');
  updateStatCard('stat-population', 'U.S. Population', '-', 'World Bank estimate');
  updateStatCard('stat-register', 'Federal Register', '-', 'Last 7 days');
  updateStatCard('stat-agencies', 'Reporting Agencies', '-', 'USAspending.gov');
  updateStatCard('stat-members', 'Members Tracked', '-', 'YGN static/API data');
  updateStatCard('stat-backend', 'Backend Status', 'Checking', 'YGN API health');
}

function initDailyQuote() {
  if (!dailyQuoteEl || !dailyQuoteAuthorEl) return;
  const dayIndex = Math.floor(Date.now() / 86_400_000);
  const quote = DAILY_QUOTES[dayIndex % DAILY_QUOTES.length];
  dailyQuoteEl.textContent = quote.text;
  dailyQuoteAuthorEl.textContent = quote.author;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 8_000;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: options.cache || 'default',
      signal: controller.signal,
      method: options.method || 'GET',
      headers: options.headers || undefined,
      body: options.body || undefined
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

function dateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function loadDebtMetric() {
  try {
    const result = await fetchJsonWithStaticFallback(
      '/metrics/debt',
      'metrics/debt.json',
      { cache: 'no-store', staticCache: 'no-store' }
    );
    const metric = result.data || {};
    const amount = Number(metric.amount);
    const sourceLabel = result.source === 'api' ? 'Treasury' : 'Static debt snapshot';
    updateStatCard('stat-debt', 'National Debt', formatCurrencyCompact(amount), metric.record_date ? `${sourceLabel}, ${metric.record_date}` : sourceLabel);
  } catch {
    updateStatCard('stat-debt', 'National Debt', '$39.38T', 'Static fallback');
  }
}

function estimatePopulationNow(latestValue, annualChange, baselineDate) {
  const yearMs = 365.2425 * 24 * 60 * 60 * 1000;
  const elapsedYears = Math.max(0, (Date.now() - baselineDate.getTime()) / yearMs);
  return Math.round(latestValue + annualChange * elapsedYears);
}

function startPopulationTicker(latestValue, annualChange, baselineDate, sourceText) {
  if (populationTicker) window.clearInterval(populationTicker);
  const render = () => {
    updateStatCard(
      'stat-population',
      'U.S. Population',
      formatNumber(estimatePopulationNow(latestValue, annualChange, baselineDate)),
      sourceText
    );
  };
  render();
  populationTicker = window.setInterval(render, 1_000);
}

async function loadPopulationMetric() {
  try {
    const payload = await fetchJson(
      'https://api.worldbank.org/v2/country/USA/indicator/SP.POP.TOTL?format=json&per_page=2&MRV=2',
      { cache: 'no-store' }
    );
    const rows = Array.isArray(payload && payload[1]) ? payload[1] : [];
    const latest = rows[0] || {};
    const previous = rows[1] || {};
    const latestValue = Number(latest.value);
    const previousValue = Number(previous.value);
    const baselineYear = Number(latest.date) + 1;
    // A 200-OK-but-empty response would yield NaN and freeze the ticker on '-'.
    if (!Number.isFinite(latestValue) || !Number.isFinite(baselineYear)) {
      throw new Error('World Bank returned no usable population figure');
    }
    const annualChange = Number.isFinite(previousValue) ? latestValue - previousValue : 1_600_000;
    const baselineDate = new Date(Date.UTC(baselineYear, 0, 1));
    startPopulationTicker(latestValue, annualChange, baselineDate, `World Bank ${latest.date}, live est.`);
  } catch {
    startPopulationTicker(341_784_857, 1_650_000, new Date(Date.UTC(2026, 0, 1)), 'Static live estimate');
  }
}

async function loadFederalRegisterMetric() {
  const since = dateOffset(-7);
  try {
    const payload = await fetchJson(
      `https://www.federalregister.gov/api/v1/documents.json?per_page=1&conditions[publication_date][gte]=${since}`,
      { cache: 'no-store' }
    );
    updateStatCard('stat-register', 'Federal Register', formatNumber(payload.count), 'Documents, last 7 days');
  } catch {
    updateStatCard('stat-register', 'Federal Register', '-', 'Live feed unavailable');
  }
}

async function loadAgencyMetric() {
  try {
    const payload = await fetchJson(
      'https://api.usaspending.gov/api/v2/references/toptier_agencies/',
      { cache: 'no-store' }
    );
    const agencies = Array.isArray(payload.results) ? payload.results : [];
    updateStatCard('stat-agencies', 'Reporting Agencies', formatNumber(agencies.length), 'USAspending.gov');
  } catch {
    updateStatCard('stat-agencies', 'Reporting Agencies', '-', 'Live feed unavailable');
  }
}

async function loadMemberCount() {
  // The member count lives in the 0.5 KB manifest — no need to pull the ~390 KB
  // officials.json (+157 KB scores) on the home page just to render a number.
  try {
    const res = await fetch('data/manifest.json', { cache: 'force-cache' });
    if (res.ok) {
      const manifest = await res.json();
      if (manifest && manifest.members) {
        updateStatCard('stat-members', 'Members Tracked', String(manifest.members), 'YGN generated data');
        return;
      }
    }
  } catch (_) { /* fall through to the full load */ }
  loadMemberDataOnly().catch(() => {
    updateStatCard('stat-members', 'Members Tracked', '-', 'Static data unavailable');
  });
}

async function refreshHomeMetrics() {
  if (!homeStats) return;
  loadDebtMetric();
  loadPopulationMetric();
  loadFederalRegisterMetric();
  loadAgencyMetric();
  loadMemberCount();
}

// Recent bills

function normalizeBillDigest(payload) {
  if (!payload || typeof payload !== 'object') return { bills: [] };
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  return {
    ...data,
    bills: Array.isArray(data.bills) ? data.bills : []
  };
}

function formatShortDate(value) {
  if (!value) return '';
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

function appendText(parent, className, text, tagName = 'p') {
  const el = document.createElement(tagName);
  if (className) el.className = className;
  el.textContent = text || '-';
  parent.appendChild(el);
  return el;
}

function appendLink(parent, label, href) {
  if (!href) return null;
  const link = document.createElement('a');
  link.href = safeUrl(href);
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = label;
  parent.appendChild(link);
  return link;
}

function billMemberLabel(member) {
  const partyState = [member.party, member.state].filter(Boolean).join('-');
  return [member.name, partyState].filter(Boolean).join(' ');
}

function renderCivicPulse(bills, digest) {
  if (!civicPulseGrid) return;
  civicPulseGrid.innerHTML = '';

  const chamberCounts = bills.reduce((acc, bill) => {
    const chamber = bill.originChamber || 'Unknown';
    acc[chamber] = (acc[chamber] || 0) + 1;
    return acc;
  }, {});
  const topChamber = Object.entries(chamberCounts).sort((a, b) => b[1] - a[1])[0];
  const newestDate = bills
    .map(bill => bill.updatedAt || (bill.latestAction && bill.latestAction.date))
    .filter(Boolean)
    .sort()
    .pop();

  const cards = [
    ['Bills Tracked', String(bills.length), digest.source === 'congress_api' ? 'Congress.gov digest' : 'Static fallback'],
    ['Newest Update', formatShortDate(newestDate) || '-', 'From top recent bills'],
    ['Top Chamber', topChamber ? `${topChamber[0]} (${topChamber[1]})` : '-', 'Within this digest'],
    ['Impact Status', 'Queued', 'Awaiting ChatGPT API key']
  ];

  cards.forEach(([label, value, source]) => {
    const card = document.createElement('div');
    card.className = 'pulse-card';
    appendText(card, 'stat-label', label, 'div');
    appendText(card, 'stat-value', value, 'div');
    appendText(card, 'stat-source', source, 'div');
    civicPulseGrid.appendChild(card);
  });
}

function renderRecentBills(digest, source) {
  if (!recentBillsGrid) return;
  const bills = digest.bills.slice(0, Number(recentBillsGrid.dataset.limit || 5));
  recentBillsGrid.innerHTML = '';

  if (recentBillsStatus) {
    const generatedAt = digest.generated_at ? ` Updated ${formatShortDate(digest.generated_at)}.` : '';
    recentBillsStatus.textContent = `${source === 'api' ? 'Live Congress.gov data' : 'Static fallback data'}.${generatedAt}`;
  }

  renderCivicPulse(bills, digest);

  if (bills.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bill-empty-state';
    empty.textContent = 'No recent bills are available right now.';
    recentBillsGrid.appendChild(empty);
    return;
  }

  const header = document.createElement('div');
  header.className = 'bill-row bill-row-header';
  ['Bill', 'Description', 'Members', 'Impacts', 'Other Info'].forEach(label => {
    appendText(header, '', label, 'div');
  });
  recentBillsGrid.appendChild(header);

  bills.forEach(bill => {
    const row = document.createElement('article');
    row.className = 'bill-row';

    const titleCell = document.createElement('div');
    appendText(titleCell, 'bill-kicker', bill.identifier || `${bill.type || ''} ${bill.number || ''}`.trim(), 'div');
    appendText(titleCell, 'bill-title', bill.title || 'Untitled bill', 'h3');
    appendText(titleCell, 'bill-meta', [bill.congress ? `${bill.congress}th Congress` : '', bill.originChamber].filter(Boolean).join(' - '), 'p');
    if (bill.url) appendLink(titleCell, 'Open bill record', bill.url);

    const descriptionCell = document.createElement('div');
    const description = bill.description || {};
    appendText(descriptionCell, 'bill-description', description.text || 'Congress.gov has not published a summary for this bill yet.');
    appendText(descriptionCell, 'bill-meta', [description.source, formatShortDate(description.updated_at)].filter(Boolean).join(' - '), 'p');

    const membersCell = document.createElement('div');
    const members = Array.isArray(bill.members) ? bill.members : [];
    members.slice(0, 6).forEach(member => {
      const item = document.createElement('div');
      item.className = 'bill-member-pill';
      appendText(item, 'bill-member-role', member.role || 'Member', 'span');
      appendText(item, '', billMemberLabel(member), 'strong');
      membersCell.appendChild(item);
    });

    const impactCell = document.createElement('div');
    const impact = bill.impact || {};
    appendText(impactCell, 'bill-impact-status', impact.status || 'Pending AI impact analysis', 'strong');
    appendText(impactCell, 'bill-description', impact.summary || 'Impact analysis will be generated after a ChatGPT API key is configured.');
    const sources = document.createElement('div');
    sources.className = 'bill-source-links';
    (impact.sources || []).forEach(sourceItem => {
      appendLink(sources, sourceItem.label || 'Source', sourceItem.url);
    });
    impactCell.appendChild(sources);

    const infoCell = document.createElement('div');
    const latestAction = bill.latestAction || {};
    appendText(infoCell, 'bill-kicker', 'Latest Action', 'div');
    appendText(infoCell, 'bill-description', latestAction.text || 'No latest action text available.');
    appendText(infoCell, 'bill-meta', [formatShortDate(latestAction.date), bill.policyArea].filter(Boolean).join(' - '), 'p');
    if (Array.isArray(bill.committees) && bill.committees.length) {
      appendText(infoCell, 'bill-kicker', 'Committees', 'div');
      appendText(infoCell, 'bill-meta', bill.committees.join(', '), 'p');
    }

    [titleCell, descriptionCell, membersCell, impactCell, infoCell].forEach(cell => {
      cell.className = cell.className ? `${cell.className} bill-cell` : 'bill-cell';
      row.appendChild(cell);
    });
    recentBillsGrid.appendChild(row);
  });
}

async function initRecentBills() {
  if (!recentBillsGrid) return;
  const limit = Number(recentBillsGrid.dataset.limit || 5);
  recentBillsGrid.innerHTML = '<div class="bill-empty-state">Loading recent bills</div>';

  try {
    const result = await fetchJsonWithStaticFallback(
      `/bills/recent/digest?limit=${encodeURIComponent(limit)}`,
      'recent-bills-digest.json',
      { cache: 'no-store', staticCache: 'no-store' }
    );
    renderRecentBills(normalizeBillDigest(result.data), result.source);
  } catch {
    if (recentBillsStatus) recentBillsStatus.textContent = 'Recent bills unavailable.';
    recentBillsGrid.innerHTML = '<div class="bill-empty-state">Recent bill data could not be loaded.</div>';
  }
}

// ─── Congressional Members ───────────────────────────────────────────────────

/**
 * Show n skeleton tiles in the members grid.
 */
function renderSkeletons(n) {
  membersGrid.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const tile = document.createElement('div');
    tile.className = 'skeleton-tile';
    tile.setAttribute('aria-hidden', 'true');
    tile.innerHTML = `
      <div class="skeleton-circle"></div>
      <div class="skeleton-line wide"></div>
      <div class="skeleton-line medium"></div>
      <div class="skeleton-line narrow"></div>
    `;
    membersGrid.appendChild(tile);
  }
}

/**
 * Show an error state in the grid.
 */
function showError(msg) {
  membersGrid.innerHTML = `
    <div class="error-state">
      <span class="state-icon" aria-hidden="true">!</span>
      <p>${msg}</p>
    </div>
  `;
}

/**
 * Show an empty state in the grid.
 */
function showEmpty() {
  membersGrid.innerHTML = `
    <div class="empty-state">
      <span class="state-icon" aria-hidden="true">?</span>
      <p>No members match your search.</p>
    </div>
  `;
}

async function loadMemberScoreIndex() {
  if (memberScoreIndex !== null) return memberScoreIndex;

  try {
    const res = await fetch('data/member-scores.json', { cache: 'default' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    memberScoreIndex = await res.json();
  } catch {
    memberScoreIndex = {};
  }

  return memberScoreIndex;
}

function hydrateMemberScores(members, scoreIndex) {
  const nominateScores = (scoreIndex && scoreIndex.nominate) || {};
  const ethicsScores = (scoreIndex && scoreIndex.ethics) || {};

  return members.map(member => {
    const bioguideId = getMemberField(member, 'bioguideId', 'bioguide_id');
    if (!bioguideId) return member;

    const enriched = { ...member };
    if (!enriched.nominate_score && nominateScores[bioguideId]) {
      enriched.nominate_score = nominateScores[bioguideId];
    }
    if (!enriched.ethics_score && ethicsScores[bioguideId]) {
      enriched.ethics_score = ethicsScores[bioguideId];
    }
    return enriched;
  });
}

/**
 * Load congressional member data without rendering tiles.
 */
async function loadRoster() {
  // The complete current roster (all ~537 members) lives in the static snapshot.
  // The live API is paginated at 250 and is NOT current-member filtered (it draws
  // from the ~2,700 all-time member pool), so using it would hide hundreds of
  // current members and mix in historical ones. Use the snapshot for the grid;
  // detail pages still hit the live API.
  try {
    const res = await fetch('data/officials.json', { cache: 'force-cache' });
    if (res.ok) {
      return { data: await res.json(), source: 'static' };
    }
  } catch (_) { /* fall through to the API */ }
  return fetchJsonWithStaticFallback('/officials?limit=250&offset=0&current_member=true', 'officials.json');
}

async function loadMemberDataOnly() {
  if (membersLoaded) return allMembers;
  if (memberDataLoadPromise) return memberDataLoadPromise;

  memberDataLoadPromise = (async () => {
    const [result, scoreIndex] = await Promise.all([
      loadRoster(),
      loadMemberScoreIndex()
    ]);
    const data = result.data;

    // Handle both array responses and { items: [...] } object responses
    let items;
    if (Array.isArray(data)) {
      items = data;
    } else if (data && Array.isArray(data.items)) {
      items = data.items;
    } else if (data && Array.isArray(data.members)) {
      items = data.members;
    } else {
      items = [];
    }

    const hydratedItems = hydrateMemberScores(items, scoreIndex);

    // Sort alphabetically by last name
    hydratedItems.sort((a, b) => {
      const nameA = getMemberField(a, 'name', 'directOrderName', 'invertedOrderName');
      const nameB = getMemberField(b, 'name', 'directOrderName', 'invertedOrderName');
      const keyA = extractSortKey(nameA);
      const keyB = extractSortKey(nameB);
      return keyA.localeCompare(keyB);
    });

    allMembers = hydratedItems;
    membersLoaded = true;
    memberDataLoadPromise = null;

    updateStatCard('stat-members', 'Members Tracked', allMembers.length.toString(), 'YGN static/API data');
    return allMembers;
  })();

  try {
    return await memberDataLoadPromise;
  } catch (err) {
    memberDataLoadPromise = null;
    throw err;
  }
}

/**
 * Load the congressional members list from the API.
 * Shows skeletons while loading. On success, sorts and renders.
 * On failure, shows error state.
 */
async function loadMembers() {
  if (membersGrid && !membersLoaded) renderSkeletons(12);

  try {
    const members = await loadMemberDataOnly();
    if (!membersGrid) return members;

    if (members.length === 0) {
      showEmpty();
      return members;
    }

    renderGrid(members);
    return members;

  } catch (err) {
    if (!membersGrid) return [];
    showError('Could not load congressional members. Make sure the backend is running.');
    return [];
  }
}

/**
 * Render an array of member objects as tiles in the grid.
 * @param {Array} members
 */
function renderGrid(members) {
  membersGrid.innerHTML = '';

  if (members.length === 0) {
    showEmpty();
    return;
  }

  const fragment = document.createDocumentFragment();
  members.forEach(member => {
    const tile = createMemberTile(member);
    fragment.appendChild(tile);
  });
  membersGrid.appendChild(fragment);
}

/**
 * Build and return a member tile DOM element.
 * Fires off background NOMINATE fetch (no await).
 * @param {object} member
 * @returns {HTMLElement}
 */
function createMemberTile(member) {
  const bioguideId = getMemberField(member, 'bioguideId', 'bioguide_id');
  const name = getMemberField(member, 'name', 'directOrderName', 'invertedOrderName') || 'Unknown';
  const state = getMemberField(member, 'state');
  const party = getMemberField(member, 'party', 'partyName');
  const chamber = getMemberChamber(member);
  const districtLabel = formatDistrictLabel(member);

  // Build display strings
  const locationStr = [state, districtLabel].filter(Boolean).join(' - ');
  const chamberStr = chamber ? chamber : '';

  // Party class mapping
  let partyClass = 'party-I';
  const partyLower = party.toLowerCase();
  if (partyLower.includes('democrat') || partyLower === 'd') partyClass = 'party-D';
  else if (partyLower.includes('republican') || partyLower === 'r') partyClass = 'party-R';

  // Short party label
  let partyLabel = party || 'I';
  if (partyLower.includes('democrat')) partyLabel = 'D';
  else if (partyLower.includes('republican')) partyLabel = 'R';
  else if (partyLabel.length > 3) partyLabel = partyLabel.slice(0, 1);

  // Photo URL
  const photoUrl = getMemberPhotoUrl(member, bioguideId);

  const initials = buildInitials(name);
  const ethicsScore = member.ethicsScore ?? member.ethics_score?.score ?? null;
  const ethicsGrade = member.ethicsGrade || member.ethics_score?.grade || 'Ethics';
  const ethicsColor = getEthicsColor(ethicsScore);

  // Build the tile element
  const tile = document.createElement('div');
  tile.className = 'member-tile';
  tile.setAttribute('tabindex', '0');
  tile.setAttribute('role', 'listitem');
  tile.setAttribute('aria-label', name);

  // Photo or initials. All values below are API-derived, so escape them before
  // interpolating into innerHTML (prevents stored/reflected XSS via member data).
  const safeName = esc(name);
  const safeInitials = esc(initials);
  const safePhotoUrl = /^https?:\/\//i.test(photoUrl || '') ? esc(photoUrl) : '';
  let photoInner = '';
  if (safePhotoUrl) {
    photoInner = `
      <img
        class="tile-photo"
        src="${safePhotoUrl}"
        alt="${safeName}"
        loading="lazy"
        decoding="async"
        onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
      >
      <div class="tile-initials" style="display:none;" aria-hidden="true">${safeInitials}</div>
    `;
  } else {
    photoInner = `<div class="tile-initials" aria-hidden="true">${safeInitials}</div>`;
  }

  const partyBadgeHtml = `<div class="party-badge ${partyClass}">${esc(partyLabel)}</div>`;
  const ethicsBadgeHtml = `<a class="ethics-badge" href="${withApiParam('ethics-methodology.html')}" title="Open ethics score methodology" aria-label="Open ethics score methodology for ${safeName}" style="background-color: ${ethicsColor};">${esc(ethicsGrade)}</a>`;

  const photoHtml = `
    <div class="tile-photo-wrapper">
      ${photoInner}
      ${partyBadgeHtml}
      ${ethicsBadgeHtml}
    </div>
  `;

  tile.innerHTML = `
    ${photoHtml}
    <div class="tile-name">${safeName}</div>
    ${locationStr ? `<div class="tile-meta">${esc(locationStr)}</div>` : ''}
    ${chamberStr ? `<div class="tile-meta">${esc(chamberStr)}</div>` : ''}
  `;

  const ethicsBadge = tile.querySelector('.ethics-badge');
  if (ethicsBadge) {
    ethicsBadge.addEventListener('click', event => {
      event.stopPropagation();
    });
    ethicsBadge.addEventListener('mouseenter', event => {
      event.stopPropagation();
    });
  }

  // Popover events: mouseenter/focus show; mouseleave/blur schedule hide
  tile.addEventListener('mouseenter', () => {
    cancelPopoverHide();
    if (bioguideId) triggerPopover(member, tile);
  });

  tile.addEventListener('mouseleave', () => {
    schedulePopoverHide();
  });

  tile.addEventListener('focus', () => {
    cancelPopoverHide();
    if (bioguideId) triggerPopover(member, tile);
  });

  tile.addEventListener('blur', () => {
    schedulePopoverHide();
  });

  const goToDetail = () => {
    if (!bioguideId) return;
    // Hand the detail page everything we already know so its header paints instantly.
    try {
      const nom = nominateCache.get(bioguideId);
      const eth = ethicsCache.get(bioguideId);
      sessionStorage.setItem('ygn_handoff_' + bioguideId, JSON.stringify({
        bioguideId, name, party, state, chamber, districtLabel, photoUrl,
        dim1: nom && typeof nom.dim1 === 'number' ? nom.dim1 : null,
        ethicsScore: eth && typeof eth.score === 'number' ? eth.score : null,
        ethicsGrade: eth && eth.grade ? eth.grade : null,
      }));
    } catch (_) { /* sessionStorage unavailable — non-fatal */ }
    window.location.href = withApiParam('member.html?id=' + bioguideId);
  };

  tile.addEventListener('click', goToDetail);

  tile.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && bioguideId) goToDetail();
  });

  if (bioguideId) {
    const nominateScore = member.nominate_score || member.nominateScore || null;
    const ethicsScoreData = member.ethics_score || member.ethicsScore || null;

    if (nominateScore && typeof nominateScore.dim1 === 'number') {
      nominateCache.set(bioguideId, { dim1: nominateScore.dim1 });
      applyNominateTint(tile, nominateScore.dim1);
    } else if (nominateCache.has(bioguideId)) {
      // Re-render (e.g. after a search): reapply the previously fetched tint so
      // the tile doesn't revert to un-tinted default.
      const cached = nominateCache.get(bioguideId);
      if (cached && typeof cached.dim1 === 'number') applyNominateTint(tile, cached.dim1);
    }

    if (ethicsScoreData && typeof ethicsScoreData.score === 'number') {
      ethicsCache.set(bioguideId, ethicsScoreData);
      applyEthicsGrade(tile, ethicsScoreData);
    } else if (ethicsCache.has(bioguideId)) {
      const cached = ethicsCache.get(bioguideId);
      if (cached) applyEthicsGrade(tile, cached);
    }

    if (!nominateCache.has(bioguideId) || !ethicsCache.has(bioguideId)) {
      scheduleScoreFetch(bioguideId, tile);
    }
  }

  return tile;
}

// ─── NOMINATE Score Tinting ──────────────────────────────────────────────────

/**
 * Apply a proportional NOMINATE tint to a member tile based on dim1 score.
 * @param {HTMLElement} tileEl
 * @param {number|null} dim1  — roughly -1.0 (liberal) to +1.0 (conservative)
 */
function applyNominateTint(tileEl, dim1) {
  if (dim1 === null || dim1 === undefined) {
    tileEl.style.backgroundColor = '#f4f6f9';
    tileEl.style.borderColor = 'rgba(148, 163, 184, 0.4)';
    return;
  }

  const baseGray = [176, 176, 176];
  const targetColor = dim1 < 0 ? [90, 130, 194] : [196, 92, 92];
  const distance = Math.abs(dim1);

  if (distance === 0) {
    tileEl.style.backgroundColor = '#B0B0B0';
  } else {
    const tintStrength = 0.12 + 0.88 * Math.pow(distance, 0.85);
    const r = Math.round(baseGray[0] + (targetColor[0] - baseGray[0]) * tintStrength);
    const g = Math.round(baseGray[1] + (targetColor[1] - baseGray[1]) * tintStrength);
    const b = Math.round(baseGray[2] + (targetColor[2] - baseGray[2]) * tintStrength);
    tileEl.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
  }
  
  tileEl.style.borderColor = 'transparent';
}

/**
 * Fetch NOMINATE scores for a member from the API, cache, and apply tint.
 * On 404 or error, stores null and applies gray tint.
 * @param {string} bioguideId
 * @param {HTMLElement} tileEl
 */
async function fetchNominate(bioguideId, tileEl) {
  // If already cached, apply immediately
  if (nominateCache.has(bioguideId)) {
    const cached = nominateCache.get(bioguideId);
    applyNominateTint(tileEl, cached ? cached.dim1 : null);
    return;
  }

  try {
    const result = await fetchJsonWithStaticFallback(
      `/officials/${bioguideId}/nominate`,
      `nominate/${bioguideId}.json`
    );
    if (result.notFound) {
      nominateCache.set(bioguideId, null);
      applyNominateTint(tileEl, null);
      return;
    }

    const data = result.data;
    const dim1 = typeof data.dim1 === 'number' ? data.dim1 : null;
    nominateCache.set(bioguideId, { dim1 });
    applyNominateTint(tileEl, dim1);
  } catch {
    // Store null to prevent repeat fetches; apply gray (unknown) tint
    nominateCache.set(bioguideId, null);
    applyNominateTint(tileEl, null);
  }
}


function applyEthicsGrade(tileEl, ethics) {
  const badge = tileEl.querySelector('.ethics-badge');
  if (!badge) return;

  const score = ethics && typeof ethics.score === 'number' ? ethics.score : null;
  const grade = ethics && ethics.grade ? ethics.grade : 'N/A';
  badge.textContent = grade;
  badge.style.backgroundColor = getEthicsColor(score);
  badge.title = score === null
    ? 'Ethics grade unavailable. Open methodology.'
    : `Ethics grade ${grade} (${score}). Open methodology.`;
}

async function fetchEthics(bioguideId, tileEl) {
  if (ethicsCache.has(bioguideId)) {
    applyEthicsGrade(tileEl, ethicsCache.get(bioguideId));
    return;
  }

  try {
    const result = await fetchJsonWithStaticFallback(
      `/officials/${bioguideId}/ethics`,
      `ethics/${bioguideId}.json`
    );
    if (result.notFound) {
      ethicsCache.set(bioguideId, null);
      applyEthicsGrade(tileEl, null);
      return;
    }

    ethicsCache.set(bioguideId, result.data);
    applyEthicsGrade(tileEl, result.data);
  } catch {
    ethicsCache.set(bioguideId, null);
    applyEthicsGrade(tileEl, null);
  }
}

// ─── Wiki Popover ────────────────────────────────────────────────────────────

/**
 * Cancel any pending hide-popover timer.
 */
function fetchMissingScores(bioguideId, tileEl) {
  if (!nominateCache.has(bioguideId)) {
    fetchNominate(bioguideId, tileEl);
  }
  if (!ethicsCache.has(bioguideId)) {
    fetchEthics(bioguideId, tileEl);
  }
}

function scheduleScoreFetch(bioguideId, tileEl) {
  if (!('IntersectionObserver' in window)) {
    window.setTimeout(() => fetchMissingScores(bioguideId, tileEl), 0);
    return;
  }

  if (!scoreObserver) {
    scoreObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        scoreObserver.unobserve(entry.target);
        fetchMissingScores(entry.target.dataset.bioguideId, entry.target);
      });
    }, { rootMargin: '240px 0px' });
  }

  tileEl.dataset.bioguideId = bioguideId;
  scoreObserver.observe(tileEl);
}

function cancelPopoverHide() {
  if (popoverHideTimer !== null) {
    clearTimeout(popoverHideTimer);
    popoverHideTimer = null;
  }
}

/**
 * Schedule the popover to hide after a short delay (allows hovering into popover).
 */
function schedulePopoverHide(delay = 200) {
  cancelPopoverHide();
  popoverHideTimer = setTimeout(() => {
    hidePopover();
    popoverHideTimer = null;
  }, delay);
}

/**
 * Trigger wiki popover for a member. Uses cache; fetches if not cached.
 * @param {object} member
 * @param {HTMLElement} tileEl  — anchor element for positioning
 */
async function triggerPopover(member, tileEl) {
  const bioguideId = getMemberField(member, 'bioguideId', 'bioguide_id');

  // Show immediately with cached data or loading state
  if (wikiCache.has(bioguideId)) {
    showPopover(member, wikiCache.get(bioguideId), tileEl);
    return;
  }

  // Show a loading state while we fetch
  showPopover(member, { summary: 'Loading biography', title: null }, tileEl);

  try {
    const result = await fetchJsonWithStaticFallback(
      `/officials/${bioguideId}/wiki`,
      `wiki/${bioguideId}.json`
    );
    if (result.notFound) {
      wikiCache.set(bioguideId, null);
      showPopover(member, null, tileEl);
      return;
    }

    const data = result.data;
    wikiCache.set(bioguideId, data);
    showPopover(member, data, tileEl);
  } catch {
    wikiCache.set(bioguideId, null);
    showPopover(member, null, tileEl);
  }
}

/**
 * Render the popover content and position it near the anchor element.
 * @param {object} member
 * @param {object|null} wikiData  — { summary, title } or null
 * @param {HTMLElement} anchorEl
 */
function showPopover(member, wikiData, anchorEl) {
  const name = getMemberField(member, 'name', 'directOrderName', 'invertedOrderName') || 'Unknown';

  popoverName.textContent = name;

  if (wikiData && wikiData.summary) {
    popoverSummary.textContent = wikiData.summary;
  } else {
    popoverSummary.textContent = 'No biographical summary available.';
  }

  // Position near anchor, clamped to viewport
  const rect = anchorEl.getBoundingClientRect();
  const popoverWidth = 320;
  const popoverHeight = 180; // estimated
  const margin = 8;

  let left = rect.right + margin;
  let top = rect.top;

  // Clamp horizontally
  if (left + popoverWidth > window.innerWidth - margin) {
    left = rect.left - popoverWidth - margin;
  }
  if (left < margin) left = margin;

  // Clamp vertically
  if (top + popoverHeight > window.innerHeight - margin) {
    top = window.innerHeight - popoverHeight - margin;
  }
  if (top < margin) top = margin;

  popoverEl.style.left = left + 'px';
  popoverEl.style.top = top + 'px';
  popoverEl.classList.add('visible');

  currentAnchor = anchorEl;
}

/**
 * Hide the popover.
 */
function hidePopover() {
  if (!popoverEl) return;
  popoverEl.classList.remove('visible');
  currentAnchor = null;
}

function setMapStatus(message, tone = '') {
  if (!mapStatus) return;
  mapStatus.textContent = message;
  mapStatus.className = tone ? `map-status ${tone}` : 'map-status';
}

async function loadStateData() {
  if (stateData.length > 0) return stateData;

  const response = await fetch('data/states.json', { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Could not load state data (${response.status})`);

  const payload = await response.json();
  stateData = Array.isArray(payload.states) ? payload.states : [];
  stateDataByFips = new Map(stateData.map(state => [normalizeFips(state.fips), state]));
  stateDataByAbbr = new Map(stateData.map(state => [String(state.abbreviation).toUpperCase(), state]));
  return stateData;
}

function getMembersForState(stateInfoOrAbbreviation) {
  const stateAbbr = typeof stateInfoOrAbbreviation === 'object'
    ? String(stateInfoOrAbbreviation.abbreviation || '').toUpperCase()
    : String(stateInfoOrAbbreviation || '').toUpperCase();
  const stateName = typeof stateInfoOrAbbreviation === 'object'
    ? String(stateInfoOrAbbreviation.name || '').toLowerCase()
    : String(getStateNameFromAbbr(stateAbbr) || '').toLowerCase();

  return allMembers.filter(member => {
    const memberStateRaw = getMemberField(member, 'state');
    const memberState = memberStateRaw.toUpperCase();
    const memberStateName = getStateNameFromAbbr(memberState) || memberStateRaw;
    if (memberState === stateAbbr) return true;
    if (memberState.toLowerCase() === stateName) return true;
    return memberStateName.toLowerCase() === stateName;
  });
}

function memberPartyLabel(member) {
  const party = getMemberField(member, 'party', 'partyName').toLowerCase();
  if (party.includes('democrat') || party === 'd') return 'D';
  if (party.includes('republican') || party === 'r') return 'R';
  if (party.includes('independent') || party === 'i') return 'I';
  return getMemberField(member, 'party', 'partyName') || '';
}

function formatMemberDisplayName(member) {
  const directName = getMemberField(member, 'directOrderName');
  if (directName) return directName;

  const name = getMemberField(member, 'name', 'invertedOrderName');
  const commaIndex = name.indexOf(',');
  if (commaIndex > 0) {
    const last = name.slice(0, commaIndex).trim();
    const first = name.slice(commaIndex + 1).trim();
    if (first && last) return `${first} ${last}`;
  }
  return name;
}

function memberSortForState(member) {
  const chamber = getMemberChamber(member).toLowerCase();
  if (chamber.includes('senate')) {
    const key = extractSortKey(getMemberField(member, 'name', 'directOrderName', 'invertedOrderName'));
    return 10_000 + (key ? key.charCodeAt(0) : 0);
  }
  const district = getMemberDistrict(member);
  return Number.isFinite(Number(district)) ? Number(district) : 9_000;
}

function getStateFill(stateInfo) {
  const lean = String(stateInfo && stateInfo.leanCategory || '').toLowerCase();
  if (lean.includes('democratic')) return '#8fb3e7';
  if (lean.includes('republican')) return '#eaa09a';
  if (lean.includes('competitive')) return '#d7c78f';
  return '#a8c7b1';
}

function topGerrymanderComponent(components) {
  if (!components || typeof components !== 'object') return 'mixed signals';
  const entries = Object.entries(components)
    .filter(([, value]) => Number.isFinite(Number(value)))
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  if (entries.length === 0) return 'mixed signals';
  if (Number(entries[0][1]) <= 0) return 'no district-line signal';

  const labels = {
    shape: 'district shape',
    voting: 'seat-vote mismatch',
    control: 'redistricting control',
    events: 'recent political events',
    social: 'social sorting',
    donations: 'donation patterns'
  };
  return labels[entries[0][0]] || entries[0][0];
}

function updateStatePanel(stateInfo, mode = 'select') {
  if (!stateInfo || !statePanel) return;

  const previousFips = selectedMapState && normalizeFips(selectedMapState.fips);
  selectedMapState = stateInfo;
  const nextFips = normalizeFips(stateInfo.fips);
  const score = Number(stateInfo.gerrymanderingIndex && stateInfo.gerrymanderingIndex.score);
  const safeScore = Number.isFinite(score) ? clamp(score, 0, 100) : 0;
  const summaryText = Array.isArray(stateInfo.summary)
    ? stateInfo.summary.join(' ')
    : String(stateInfo.summary || '');

  stateNameEl.textContent = `${stateInfo.name} (${stateInfo.abbreviation})`;
  stateSummaryEl.textContent = summaryText || 'No state summary is available yet.';
  statePopulationEl.textContent = formatNumber(stateInfo.population);
  stateLeanEl.textContent = stateInfo.historicalLean || stateInfo.leanCategory || '-';
  gerryScoreEl.textContent = Number.isFinite(score) ? `${safeScore}/100` : '-';
  gerryMeterFill.style.width = `${safeScore}%`;
  gerryMeterFill.style.background = safeScore >= 70 ? '#d95f5f' : safeScore >= 45 ? '#d5a642' : '#3b8f6d';
  gerryNoteEl.textContent = `${stateInfo.gerrymanderingIndex && stateInfo.gerrymanderingIndex.label || 'Risk'} - strongest signal: ${topGerrymanderComponent(stateInfo.gerrymanderingIndex && stateInfo.gerrymanderingIndex.components)}.`;
  districtStatusEl.textContent = mode === 'click'
    ? `Locked on ${stateInfo.name}. Reset View clears the selection. District outlines are loading or cached.`
    : `Selected ${stateInfo.name}. Click the state again to load district outlines.`;
  viewStateMembersBtn.disabled = false;

  if (mode === 'click' || previousFips !== nextFips) {
    statePanel.classList.remove('panel-animate');
    void statePanel.offsetWidth;
    statePanel.classList.add('panel-animate');
  }
}

function renderMemberListForState(stateInfo) {
  if (!districtListEl || !stateInfo) return;

  if (!membersLoaded) {
    districtListEl.innerHTML = `
      <div class="district-row">
        <span>${stateInfo.abbreviation}</span>
        <strong>Loading delegation</strong>
      </div>
    `;
    loadMemberDataOnly()
      .then(() => {
        if (selectedMapState && normalizeFips(selectedMapState.fips) === normalizeFips(stateInfo.fips)) {
          renderMemberListForState(stateInfo);
        }
      })
      .catch(() => {
        if (selectedMapState && normalizeFips(selectedMapState.fips) === normalizeFips(stateInfo.fips)) {
          districtListEl.innerHTML = `
            <div class="district-row">
              <span>${stateInfo.abbreviation}</span>
              <strong>Delegation data unavailable</strong>
            </div>
          `;
        }
      });
    return;
  }

  const members = getMembersForState(stateInfo)
    .slice()
    .sort((a, b) => {
      const rankA = memberSortForState(a);
      const rankB = memberSortForState(b);
      if (rankA !== rankB) return rankA - rankB;
      const nameA = getMemberField(a, 'name', 'directOrderName', 'invertedOrderName');
      const nameB = getMemberField(b, 'name', 'directOrderName', 'invertedOrderName');
      return nameA.localeCompare(nameB);
    });

  if (members.length === 0) {
    districtListEl.innerHTML = `
      <div class="district-row">
        <span>${stateInfo.abbreviation}</span>
        <strong>No delegation data loaded</strong>
      </div>
    `;
    return;
  }

  const visibleMembers = members.slice(0, 9);
  const rows = visibleMembers.map(member => {
    const name = esc(formatMemberDisplayName(member) || 'Unknown member');
    const label = esc(formatDistrictLabel(member) || getMemberChamber(member) || stateInfo.abbreviation);
    const party = esc(memberPartyLabel(member));
    return `
      <div class="district-row">
        <span>${label}${party ? ` - ${party}` : ''}</span>
        <strong>${name}</strong>
      </div>
    `;
  });

  if (members.length > visibleMembers.length) {
    rows.push(`
      <div class="district-row district-row-more">
        <span>${stateInfo.abbreviation}</span>
        <strong>${members.length - visibleMembers.length} more members in search</strong>
      </div>
    `);
  }

  districtListEl.innerHTML = rows.join('');
}

function showMapTooltip(html, event) {
  if (!mapTooltip) return;
  mapTooltip.innerHTML = html;
  mapTooltip.classList.add('visible');

  const stageRect = mapTooltip.parentElement.getBoundingClientRect();
  const left = clamp(event.clientX - stageRect.left + 14, 8, stageRect.width - 220);
  const top = clamp(event.clientY - stageRect.top + 14, 8, stageRect.height - 110);
  mapTooltip.style.left = `${left}px`;
  mapTooltip.style.top = `${top}px`;
}

function hideMapTooltip() {
  if (mapTooltip) mapTooltip.classList.remove('visible');
}

async function initMap() {
  if (mapInitialized) return;
  mapInitialized = true;

  if (!mapSvg) return;
  if (!window.d3 || !window.topojson) {
    setMapStatus('Map libraries did not load. Check the network connection and refresh.', 'error');
    return;
  }

  try {
    setMapStatus('Loading map data');
    await loadStateData();

    const response = await fetch(STATES_TOPOJSON_URL, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Could not load state shapes (${response.status})`);
    const us = await response.json();

    drawStateMap(us);
    setMapStatus('Hover for state names. Select a state to open its snapshot and districts.');
    // Member/delegation data is loaded lazily when a state is actually selected
    // (see updateStatePanel), so the home page no longer eagerly downloads the
    // ~390 KB officials.json + scores on initial render.

  } catch (error) {
    setMapStatus('Could not load the interactive map. Static pages are still available.', 'error');
  }
}

function drawStateMap(us) {
  const width = 960;
  const height = 600;
  const svg = d3.select(mapSvg);
  svg.selectAll('*').remove();

  const projection = d3.geoAlbersUsa().translate([width / 2, height / 2]).scale(1250);
  const path = d3.geoPath(projection);
  const states = topojson.feature(us, us.objects.states).features;

  const root = svg.append('g').attr('class', 'map-root');
  const stateLayer = root.append('g').attr('class', 'state-layer');
  const districtLayer = root.append('g').attr('class', 'district-layer');

  const zoom = d3.zoom()
    .scaleExtent([1, 8])
    .on('zoom', event => {
      root.attr('transform', event.transform);
    });

  svg.call(zoom);

  stateLayer.selectAll('path')
    .data(states)
    .join('path')
    .attr('class', 'state-shape')
    .attr('d', path)
    .attr('fill', feature => {
      const stateInfo = stateDataByFips.get(normalizeFips(feature.id));
      return getStateFill(stateInfo);
    })
    .attr('tabindex', 0)
    .attr('role', 'button')
    .attr('aria-pressed', 'false')
    .attr('aria-label', feature => {
      const stateInfo = stateDataByFips.get(normalizeFips(feature.id));
      return stateInfo ? `${stateInfo.name} state map` : 'State map';
    })
    .on('mouseenter', (event, feature) => {
      const stateInfo = stateDataByFips.get(normalizeFips(feature.id));
      if (!stateInfo) return;
      showMapTooltip(`<strong>${stateInfo.name}</strong><span>${stateInfo.historicalLean}</span>`, event);
    })
    .on('mousemove', (event, feature) => {
      const stateInfo = stateDataByFips.get(normalizeFips(feature.id));
      if (!stateInfo) return;
      showMapTooltip(`<strong>${stateInfo.name}</strong><span>${stateInfo.historicalLean}</span>`, event);
    })
    .on('mouseleave', hideMapTooltip)
    .on('blur', hideMapTooltip)
    .on('click keydown', (event, feature) => {
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const stateInfo = stateDataByFips.get(normalizeFips(feature.id));
      if (!stateInfo) return;
      lockedMapState = stateInfo;
      stateLayer.selectAll('.state-shape')
        .classed('state-shape-selected', stateFeature => normalizeFips(stateFeature.id) === normalizeFips(feature.id))
        .attr('aria-pressed', stateFeature => normalizeFips(stateFeature.id) === normalizeFips(feature.id) ? 'true' : 'false');
      updateStatePanel(stateInfo, 'click');
      renderMemberListForState(stateInfo);
      zoomToFeature(feature);
      renderDistrictsForState(stateInfo);
    });

  mapSvg.__ygnMap = { svg, root, districtLayer, path, zoom, width, height };
}

function resetMapView() {
  if (!mapSvg || !mapSvg.__ygnMap) return;
  const { svg, zoom, districtLayer } = mapSvg.__ygnMap;
  districtLayer.selectAll('*').remove();
  svg.selectAll('.state-shape')
    .classed('state-shape-selected', false)
    .attr('aria-pressed', 'false');
  districtListEl.innerHTML = '';
  selectedMapState = null;
  lockedMapState = null;
  if (stateNameEl) stateNameEl.textContent = 'Select a State';
  if (stateSummaryEl) stateSummaryEl.textContent = 'Select a state to see population, political lean, district notes, and the YGN gerrymandering risk index.';
  if (statePopulationEl) statePopulationEl.textContent = '-';
  if (stateLeanEl) stateLeanEl.textContent = '-';
  if (gerryScoreEl) gerryScoreEl.textContent = '-';
  if (gerryMeterFill) gerryMeterFill.style.width = '0';
  if (gerryNoteEl) gerryNoteEl.textContent = 'Educational risk signal, not a legal finding.';
  districtStatusEl.textContent = 'Select a state to load its delegation and district outlines.';
  if (viewStateMembersBtn) viewStateMembersBtn.disabled = true;
  svg.transition().duration(650).call(zoom.transform, d3.zoomIdentity);
}

function zoomToFeature(feature) {
  if (!mapSvg || !mapSvg.__ygnMap) return;
  const { svg, path, zoom, width, height } = mapSvg.__ygnMap;
  const bounds = path.bounds(feature);
  const dx = bounds[1][0] - bounds[0][0];
  const dy = bounds[1][1] - bounds[0][1];
  const x = (bounds[0][0] + bounds[1][0]) / 2;
  const y = (bounds[0][1] + bounds[1][1]) / 2;
  const scale = Math.max(1, Math.min(7, 0.82 / Math.max(dx / width, dy / height)));
  const translate = [width / 2 - scale * x, height / 2 - scale * y];

  svg.transition()
    .duration(750)
    .call(zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
}

function districtQueryUrl(fips) {
  const params = new URLSearchParams({
    where: `STATEFP='${normalizeFips(fips)}'`,
    outFields: 'STATEFP,CD119FP,GEOID,NAMELSAD,BIOGUIDE_ID,FIRSTNAME,LASTNAME,PARTY',
    outSR: '4326',
    f: 'geojson'
  });
  return `${DISTRICTS_FEATURE_QUERY_URL}?${params.toString()}`;
}

async function ensureDistrictData(fips) {
  const normalizedFips = normalizeFips(fips);
  if (congressionalDistrictsByFips.has(normalizedFips)) {
    return congressionalDistrictsByFips.get(normalizedFips);
  }
  if (congressionalDistrictPromisesByFips.has(normalizedFips)) {
    return congressionalDistrictPromisesByFips.get(normalizedFips);
  }

  const request = fetch(districtQueryUrl(normalizedFips), { cache: 'force-cache' })
    .then(response => {
      if (!response.ok) throw new Error(`Could not load districts (${response.status})`);
      return response.json();
    })
    .then(geojson => {
      congressionalDistricts = geojson;
      congressionalDistrictsByFips.set(normalizedFips, geojson);
      congressionalDistrictPromisesByFips.delete(normalizedFips);
      return geojson;
    })
    .catch(error => {
      congressionalDistrictPromisesByFips.delete(normalizedFips);
      throw error;
    });

  congressionalDistrictPromisesByFips.set(normalizedFips, request);
  return request;
}

function districtDisplayName(feature) {
  const props = feature.properties || {};
  const district = String(props.CD119FP || '').replace(/^0+/, '') || props.NAMELSAD || 'At-large';
  const districtLabel = props.NAMELSAD || (district === '98' ? 'At-large' : `District ${district}`);
  const first = props.FIRSTNAME || '';
  const last = props.LASTNAME || '';
  const memberName = `${first} ${last}`.trim() || 'Member TBD';
  const party = props.PARTY ? ` (${props.PARTY})` : '';
  // Values come from a third-party ArcGIS feature service and are injected into
  // innerHTML (tooltip + district list), so escape them here at the source.
  return {
    districtLabel: esc(districtLabel),
    memberName: esc(memberName),
    party: esc(party),
  };
}

async function renderDistrictsForState(stateInfo) {
  if (!mapSvg || !mapSvg.__ygnMap || !stateInfo) return;
  const { districtLayer, path } = mapSvg.__ygnMap;

  districtStatusEl.textContent = `Loading ${stateInfo.name} districts`;

  try {
    const geojson = await ensureDistrictData(stateInfo.fips);
    const features = (geojson.features || [])
      .filter(feature => normalizeFips(feature.properties && feature.properties.STATEFP) === normalizeFips(stateInfo.fips))
      .sort((a, b) => String(a.properties && a.properties.CD119FP).localeCompare(String(b.properties && b.properties.CD119FP)));

    districtLayer.selectAll('*').remove();
    districtLayer.selectAll('path')
      .data(features)
      .join('path')
      .attr('class', 'district-shape')
      .attr('d', path)
      .on('mouseenter', (event, feature) => {
        const info = districtDisplayName(feature);
        showMapTooltip(`<strong>${info.districtLabel}</strong><span>${info.memberName}${info.party}</span>`, event);
      })
      .on('mousemove', (event, feature) => {
        const info = districtDisplayName(feature);
        showMapTooltip(`<strong>${info.districtLabel}</strong><span>${info.memberName}${info.party}</span>`, event);
      })
      .on('mouseleave', hideMapTooltip);

    renderDistrictList(stateInfo, features);
    districtStatusEl.textContent = features.length
      ? `${features.length} district outline${features.length === 1 ? '' : 's'} loaded for ${stateInfo.name}.`
      : `No 119th district outlines are available for ${stateInfo.name}.`;
  } catch {
    districtStatusEl.textContent = 'District outlines could not be loaded from the public feature layer.';
  }
}

function renderDistrictList(stateInfo, features) {
  if (!districtListEl) return;
  if (!features || features.length === 0) {
    districtListEl.innerHTML = `<div class="district-row"><span>${stateInfo.name}</span><strong>No districts loaded</strong></div>`;
    return;
  }

  districtListEl.innerHTML = features.map(feature => {
    const info = districtDisplayName(feature);
    return `
      <div class="district-row">
        <span>${info.districtLabel}</span>
        <strong>${info.memberName}${info.party}</strong>
      </div>
    `;
  }).join('');
}

async function openStateMembersSearch() {
  if (!selectedMapState) return;
  const params = new URLSearchParams();
  params.set('q', selectedMapState.name);
  const api = new URLSearchParams(window.location.search).get('api');
  if (api) params.set('api', api);
  window.location.href = `members.html?${params.toString()}`;
}

function openMethodology() {
  window.location.href = withApiParam('methodology.html');
}

function scrollToHashTarget() {
  const hash = window.location.hash;
  if (!hash) return;
  const target = document.querySelector(hash);
  if (!target) return;
  window.setTimeout(() => {
    target.scrollIntoView({ block: 'start' });
  }, 180);
}

// ─── Search / Filter ─────────────────────────────────────────────────────────

/**
 * Filter allMembers by query string (name, state, party, chamber).
 * Called on every input event on #members-search.
 */
function handleSearch() {
  const query = membersSearch.value.trim().toLowerCase();

  if (!query) {
    renderGrid(allMembers);
    return;
  }

  const filtered = allMembers.filter(member => {
    const name = getMemberField(member, 'name', 'directOrderName', 'invertedOrderName').toLowerCase();
    const state = getMemberField(member, 'state').toLowerCase();
    const party = getMemberField(member, 'party', 'partyName').toLowerCase();
    const chamber = getMemberChamber(member).toLowerCase();
    const district = formatDistrictLabel(member).toLowerCase();

    return (
      name.includes(query) ||
      state.includes(query) ||
      stateSearchMatches(member, query) ||
      party.includes(query) ||
      chamber.includes(query) ||
      district.includes(query)
    );
  });

  if (filtered.length === 0) {
    showEmpty();
  } else {
    renderGrid(filtered);
  }
}

function applyInitialMemberQuery() {
  if (!membersSearch) return;
  const params = new URLSearchParams(window.location.search);
  const query = params.get('q') || params.get('state') || '';
  if (!query) return;

  membersSearch.value = query;
  handleSearch();
}

// ─── Member Detail Page ──────────────────────────────────────────────────────

const DOSSIER_FAST_SECTIONS = 'wiki,nominate,history,committees,contact,legislation,stocks';
const DOSSIER_SLOW_SECTIONS = 'ethics,funding';

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Neutralize dangerous URL schemes (javascript:, data:, vbscript:) from any
// API-derived href. Allows http(s), mailto, and scheme-less (relative) URLs.
function safeUrl(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return '#';
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (proto !== 'http' && proto !== 'https' && proto !== 'mailto') return '#';
  }
  return s;
}

function sessionGet(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function sessionSet(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    /* storage full or unavailable — non-fatal */
  }
}

function computeAge(birthday) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(birthday || ''));
  if (!match) return null;
  const now = new Date();
  let age = now.getFullYear() - Number(match[1]);
  const m = now.getMonth() + 1 - Number(match[2]);
  if (m < 0 || (m === 0 && now.getDate() < Number(match[3]))) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

window.switchLegislationTab = function (tabId) {
  document.querySelectorAll('.dossier-tab').forEach(t => t.setAttribute('aria-selected', 'false'));
  document.querySelectorAll('.dossier-tab-content').forEach(c => c.classList.remove('active'));
  const btn = document.querySelector(`[data-tab="${tabId}"]`);
  const panel = document.getElementById(`tab-${tabId}`);
  if (btn) btn.setAttribute('aria-selected', 'true');
  if (panel) panel.classList.add('active');
};

// ── Hero ──────────────────────────────────────────────────────────────────────

function partyChipClass(party) {
  const p = String(party || '').toLowerCase();
  if (p.includes('democrat')) return 'chip chip--dem';
  if (p.includes('republican')) return 'chip chip--rep';
  if (p.includes('independent')) return 'chip chip--ind';
  return 'chip';
}

function ideologyBlock(dim1) {
  if (dim1 === null || dim1 === undefined || typeof dim1 !== 'number') return '';
  const pct = Math.max(2, Math.min(98, ((dim1 + 1) / 2) * 100));
  const lean = dim1 < -0.15 ? 'Leans liberal' : dim1 > 0.15 ? 'Leans conservative' : 'Centrist';
  return `
    <div class="ideology-meter" role="img" aria-label="Ideology score ${dim1.toFixed(2)}, ${lean}">
      <div class="ideology-labels"><span>Liberal</span><span>Moderate</span><span>Conservative</span></div>
      <div class="ideology-track"><span class="ideology-marker" style="left:${pct}%"></span></div>
      <div class="ideology-caption">DW-NOMINATE: ${dim1.toFixed(2)} · ${lean}</div>
    </div>`;
}

function heroGradeHtml(ethics) {
  if (ethics === undefined) {
    return `<span class="grade-badge" id="hero-grade" style="--grade-color:#cbd5e1" title="Loading ethics grade">…<span>Ethics</span></span>`;
  }
  const grade = ethics && ethics.grade ? ethics.grade : 'N/A';
  const score = ethics ? ethics.score : null;
  return `<a class="grade-badge" id="hero-grade" href="${withApiParam('ethics-methodology.html')}" style="--grade-color:${getEthicsColor(score)}" title="Campaign-finance transparency grade — click for methodology">${esc(grade)}<span>Ethics</span></a>`;
}

function normalizeHero(data, handoff, id) {
  if (data && data.member) {
    const m = data.member;
    return {
      id,
      name: formatMemberDisplayName(m) || (handoff && handoff.name) || 'Member',
      party: getMemberField(m, 'party', 'partyName') || (handoff && handoff.party) || '',
      state: getMemberField(m, 'state') || (handoff && handoff.state) || '',
      chamber: getMemberChamber(m) || (handoff && handoff.chamber) || '',
      districtLabel: formatDistrictLabel(m) || '',
      photoUrl: getMemberPhotoUrl(m, id) || (handoff && handoff.photoUrl) || '',
      dim1: (data.nominate && typeof data.nominate.dim1 === 'number')
        ? data.nominate.dim1
        : (handoff && typeof handoff.dim1 === 'number' ? handoff.dim1 : null),
      ethics: data.ethics !== undefined
        ? data.ethics
        : (handoff && handoff.ethicsGrade ? { grade: handoff.ethicsGrade, score: handoff.ethicsScore } : undefined),
    };
  }
  const h = handoff || {};
  return {
    id,
    name: h.name || 'Loading…',
    party: h.party || '',
    state: h.state || '',
    chamber: h.chamber || '',
    districtLabel: h.districtLabel || '',
    photoUrl: h.photoUrl || '',
    dim1: typeof h.dim1 === 'number' ? h.dim1 : null,
    ethics: h.ethicsGrade ? { grade: h.ethicsGrade, score: h.ethicsScore } : undefined,
  };
}

function heroHtml(hero) {
  const initials = buildInitials(hero.name);
  const photoInner = hero.photoUrl
    ? `<img class="dossier-hero-photo" src="${esc(hero.photoUrl)}" alt="${esc(hero.name)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"><div class="dossier-hero-initials" style="display:none;" aria-hidden="true">${esc(initials)}</div>`
    : `<div class="dossier-hero-initials" aria-hidden="true">${esc(initials)}</div>`;

  const isSenate = String(hero.chamber || '').toLowerCase().includes('senate');
  const chips = [
    hero.party ? `<span class="${partyChipClass(hero.party)}">${esc(hero.party)}</span>` : '',
    hero.state ? `<span class="chip">${esc(hero.state)}</span>` : '',
    hero.chamber ? `<span class="chip">${esc(hero.chamber)}</span>` : '',
    (hero.districtLabel && !isSenate) ? `<span class="chip">${esc(hero.districtLabel)}</span>` : '',
  ].filter(Boolean).join('');

  let tint = 'var(--color-surface)';
  if (typeof hero.dim1 === 'number') {
    tint = hero.dim1 < 0 ? 'rgba(59,111,212,0.10)' : 'rgba(209,67,47,0.10)';
  }

  return `
    <div class="dossier-hero" style="--dossier-tint:${tint}">
      <div class="dossier-hero-photo-wrap">${photoInner}</div>
      <div class="dossier-hero-body">
        <div class="dossier-hero-eyebrow">Member of Congress</div>
        <h1 class="dossier-hero-name">${esc(hero.name)}</h1>
        <div class="dossier-chips">${chips}</div>
        ${ideologyBlock(hero.dim1)}
      </div>
      <div class="dossier-hero-side">
        ${heroGradeHtml(hero.ethics)}
        <button class="ghost-btn" id="dossier-share" type="button" title="Copy link to this profile">🔗 Share</button>
      </div>
    </div>`;
}

// ── Stat row + section nav ──────────────────────────────────────────────────────

function statRowHtml(data) {
  const cell = (v, l) => `<div class="dossier-stat"><span class="dossier-stat-value">${v == null ? '—' : formatNumber(v)}</span><span class="dossier-stat-label">${l}</span></div>`;
  return `<div class="dossier-statrow">
    ${cell(data && data.history ? data.history.yearsOfService : null, 'Years in office')}
    ${cell(data && data.legislation ? data.legislation.sponsoredCount : null, 'Bills sponsored')}
    ${cell(data && data.legislation ? data.legislation.cosponsoredCount : null, 'Bills cosponsored')}
    ${cell(data && data.committees ? data.committees.count : null, 'Committees')}
  </div>`;
}

function sectionNavHtml(data) {
  const items = [
    ['about', 'About', !!(data && data.wiki)],
    ['career', 'Career', !!(data && data.history)],
    ['funding', 'Funding', true],
    ['disclosures', 'Disclosures', !!(data && data.stocks)],
    ['committees', 'Committees', !!(data && data.committees)],
    ['legislation', 'Legislation', !!(data && data.legislation)],
    ['contact', 'Contact', !!(data && data.contact)],
  ].filter(x => x[2]);
  if (!items.length) return '';
  return `<nav class="dossier-nav" aria-label="Jump to section">${items.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')}</nav>`;
}

// ── Section cards ────────────────────────────────────────────────────────────

function aboutHtml(wiki) {
  if (!wiki) return '';
  const thumb = wiki.thumbnail && wiki.thumbnail.source
    ? `<img class="wiki-thumb" src="${esc(wiki.thumbnail.source)}" alt="" loading="lazy">` : '';
  const note = wiki.source === 'congress_fallback'
    ? `<p class="muted-text" style="margin-top:.75rem;clear:both;">Generated summary — no Wikipedia article resolved.</p>` : '';
  const text = esc(wiki.extract || wiki.summary || 'No biography available.');
  const more = wiki.wiki_url
    ? `<a class="wiki-more" href="${esc(safeUrl(wiki.wiki_url))}" target="_blank" rel="noopener">Read more on Wikipedia →</a>` : '';
  return `<section class="dossier-card" id="about">
    <h3><span><span class="card-icon">📖</span>About</span></h3>
    ${thumb}<div class="wiki-body">${text}</div>${more}${note}
  </section>`;
}

function careerHtml(history) {
  if (!history) return '';
  const terms = Array.isArray(history.terms) ? history.terms.slice().reverse() : [];
  const timeline = terms.map(t => `
    <li class="timeline-item">
      <strong>${esc(t.congress)}th Congress · ${esc(t.startYear || '?')}–${esc(t.endYear || 'present')}</strong>
      <span>${esc(t.chamber || '')}${t.state ? ` · ${esc(t.state)}` : ''}${t.district ? ` · District ${esc(t.district)}` : ''}${t.party ? ` · ${esc(t.party)}` : ''}</span>
    </li>`).join('');
  const age = computeAge(history.birthday);
  const born = history.birthday
    ? `${esc(history.birthday)}${age ? ` (age ${age})` : ''}`
    : (history.birthYear ? esc(history.birthYear) : '—');
  return `<section class="dossier-card" id="career">
    <h3><span><span class="card-icon">🏛️</span>Career History</span></h3>
    <div class="funding-totals" style="margin-bottom:1.25rem;">
      <div class="funding-stat"><span class="funding-stat-label">First elected</span><span class="funding-stat-value">${esc(history.firstElectedYear || '—')}</span></div>
      <div class="funding-stat"><span class="funding-stat-label">Years served</span><span class="funding-stat-value">${esc(history.yearsOfService || '—')}</span></div>
      <div class="funding-stat"><span class="funding-stat-label">Terms</span><span class="funding-stat-value">${esc(history.termCount || '—')}</span></div>
      <div class="funding-stat"><span class="funding-stat-label">Born</span><span class="funding-stat-value" style="font-size:1rem;">${born}</span></div>
    </div>
    ${timeline ? `<ul class="timeline">${timeline}</ul>` : ''}
  </section>`;
}

const FUNDING_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

function fundingInnerHtml(funding, pending) {
  if (pending) {
    return `<h3><span><span class="card-icon">💵</span>Campaign Funding</span></h3>
      <div class="card-loading"><span class="card-spinner"></span>Loading campaign finance…</div>`;
  }
  let gradeChip = '';
  if (funding && funding.grade && funding.grade.grade) {
    gradeChip = `<span class="grade-badge" style="--grade-color:${getEthicsColor(funding.grade.score)};min-width:auto;padding:.25rem .6rem;font-size:1rem;flex-direction:row;gap:.35rem;">${esc(funding.grade.grade)}<span>Grade</span></span>`;
  }
  let body;
  if (funding && funding.available && funding.totals) {
    const t = funding.totals;
    const breakdown = Array.isArray(funding.breakdown) ? funding.breakdown : [];
    let bar = '';
    let legend = '';
    breakdown.forEach((item, i) => {
      const share = item.share || 0;
      const color = FUNDING_COLORS[i % FUNDING_COLORS.length];
      if (share > 0) bar += `<div class="funding-bar-segment" style="width:${(share * 100).toFixed(1)}%;background:${color};" title="${esc(item.label)}: ${(share * 100).toFixed(1)}%"></div>`;
      legend += `<div class="funding-legend-item"><span class="funding-legend-label"><span class="funding-legend-color" style="background:${color};"></span>${esc(item.label)}</span><strong>${formatCurrencyCompact(item.amount)} · ${(share * 100).toFixed(1)}%</strong></div>`;
    });
    body = `
      <div class="funding-totals">
        <div class="funding-stat"><span class="funding-stat-label">Receipts</span><span class="funding-stat-value">${formatCurrencyCompact(t.receipts)}</span></div>
        <div class="funding-stat"><span class="funding-stat-label">Disbursements</span><span class="funding-stat-value">${formatCurrencyCompact(t.disbursements)}</span></div>
        <div class="funding-stat"><span class="funding-stat-label">Cash on hand</span><span class="funding-stat-value">${formatCurrencyCompact(t.cashOnHand)}</span></div>
        <div class="funding-stat"><span class="funding-stat-label">Debts</span><span class="funding-stat-value">${formatCurrencyCompact(t.debts)}</span></div>
      </div>
      ${breakdown.length ? `<div class="funding-subhead">Where the money comes from</div><div class="funding-bar-container">${bar}</div><div class="funding-legend">${legend}</div>` : ''}
      <p class="dossier-source">Source: FEC · ${funding.cycle ? `Cycle ${esc(funding.cycle)}` : 'Aggregate across available cycles'}</p>`;
  } else {
    body = `<p class="muted-text">${esc((funding && funding.note) || 'No matching FEC campaign committee was found.')}</p>`;
  }
  return `<h3><span><span class="card-icon">💵</span>Campaign Funding</span>${gradeChip}</h3>${body}`;
}

function fundingSectionHtml(funding, pending) {
  return `<section class="dossier-card" id="funding">${fundingInnerHtml(funding, pending)}</section>`;
}

function stocksHtml(stocks) {
  if (!stocks) return '';
  let content;
  if (stocks.trades && stocks.trades.length) {
    const rows = stocks.trades.map(t => `
      <tr>
        <td>${esc(t.transactionDate || '-')}</td>
        <td><strong>${esc(t.ticker || '-')}</strong></td>
        <td class="stock-asset" title="${esc(t.assetDescription || '')}">${esc(t.assetDescription || '-')}</td>
        <td>${esc(t.type || '-')}</td>
        <td>${esc(t.amountRange || '-')}</td>
        <td>${esc(t.owner || '-')}</td>
      </tr>`).join('');
    const ob = stocks.ownerBreakdown || {};
    const self = ob.self || 0;
    const spouse = ob.spouse || 0;
    const child = ob.dependent || ob.child || 0;
    content = `<div style="overflow-x:auto;">
      <table class="stock-table"><thead><tr><th>Date</th><th>Ticker</th><th>Asset</th><th>Type</th><th>Amount</th><th>Owner</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
      <p class="muted-text" style="margin-top:.75rem;">Trades by owner — self: ${self}, spouse: ${spouse}, child: ${child}.</p>`;
  } else if (stocks.filings && stocks.filings.length) {
    const items = stocks.filings.map(f => `
      <li class="dossier-list-item">
        <div class="dossier-list-item-title">${esc(f.label || 'Filing')} ${f.isStockReport ? '<span class="badge badge--report">Stock report</span>' : ''}</div>
        <div class="dossier-list-item-meta">${esc(f.filingDate || '')} ${f.pdfUrl ? `· <a href="${esc(safeUrl(f.pdfUrl))}" target="_blank" rel="noopener">View official PDF →</a>` : ''}</div>
      </li>`).join('');
    content = `<ul class="dossier-list">${items}</ul>`;
  } else if (stocks.senateSearchUrl) {
    content = `<p><a class="contact-link" href="${esc(safeUrl(stocks.senateSearchUrl))}" target="_blank" rel="noopener">Search this senator's disclosures on the Senate eFD system →</a></p>`;
  } else {
    content = `<p class="muted-text">${esc(stocks.note || 'No financial disclosures found.')}</p>`;
  }
  const familyNote = stocks.familyMembersNote
    ? `<p class="muted-text" style="margin-top:1rem;font-size:.78rem;">${esc(stocks.familyMembersNote)}</p>` : '';
  return `<section class="dossier-card" id="disclosures">
    <h3><span><span class="card-icon">📈</span>Financial Disclosures</span></h3>
    ${content}${familyNote}
  </section>`;
}

function committeesHtml(committees) {
  if (!committees) return '';
  const assignments = Array.isArray(committees.assignments) ? committees.assignments : [];
  const grouped = {};
  assignments.forEach(a => {
    if (a && !a.isSubcommittee) {
      const code = a.code || 'UNKNOWN';
      if (!grouped[code]) grouped[code] = Object.assign({}, a, { subcommittees: [] });
    }
  });
  assignments.forEach(a => {
    if (a && a.isSubcommittee) {
      const parent = Object.keys(grouped).find(k => k !== 'UNKNOWN' && a.code && a.code.startsWith(k));
      if (parent) grouped[parent].subcommittees.push(a);
      else {
        if (!grouped.MISC) grouped.MISC = { committee: 'Other subcommittees', subcommittees: [], isSubcommittee: false };
        grouped.MISC.subcommittees.push(a);
      }
    }
  });
  const list = Object.values(grouped).map(c => {
    const title = c.committeeUrl
      ? `<a href="${esc(c.committeeUrl)}" target="_blank" rel="noopener">${esc(c.committee)}</a>`
      : esc(c.committee);
    const role = c.role ? `<span class="badge badge--role">${esc(c.role)}</span>` : '';
    const subs = (c.subcommittees && c.subcommittees.length)
      ? `<ul class="committee-sub">${c.subcommittees.map(s => `<li>${esc(s.subcommittee || s.committee)}${s.role ? ` <span class="badge badge--role">${esc(s.role)}</span>` : ''}</li>`).join('')}</ul>`
      : '';
    return `<li class="dossier-list-item"><div class="dossier-list-item-title">${title}${role}</div>${subs}</li>`;
  }).join('');
  return `<section class="dossier-card" id="committees">
    <h3><span><span class="card-icon">👥</span>Committees</span></h3>
    ${list ? `<ul class="dossier-list">${list}</ul>` : '<p class="muted-text">No committee assignments found.</p>'}
  </section>`;
}

function contactHtml(contact) {
  if (!contact) return '';
  const off = contact.official || {};
  const soc = contact.social || {};
  const prof = contact.profiles || {};
  const offLines = [];
  if (off.website) offLines.push(`<div class="contact-line">🌐 <a href="${esc(safeUrl(off.website))}" target="_blank" rel="noopener">Official website</a></div>`);
  if (off.phone) offLines.push(`<div class="contact-line">📞 ${esc(off.phone)}</div>`);
  if (off.office) offLines.push(`<div class="contact-line">🏢 ${esc(off.office)}</div>`);
  const socLinks = Object.entries(soc).filter(([, d]) => d && d.url).map(([net, d]) =>
    `<a class="contact-link" href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">${esc(net.charAt(0).toUpperCase() + net.slice(1))}</a>`).join('');
  const profLinks = Object.entries(prof).filter(([, url]) => url).map(([site, url]) =>
    `<a class="contact-link" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${esc(site.charAt(0).toUpperCase() + site.slice(1))}</a>`).join('');
  const groups = [
    offLines.length ? `<div><div class="contact-group-title">Official</div>${offLines.join('')}</div>` : '',
    socLinks ? `<div><div class="contact-group-title">Social media</div><div class="contact-links">${socLinks}</div></div>` : '',
    profLinks ? `<div><div class="contact-group-title">External profiles</div><div class="contact-links">${profLinks}</div></div>` : '',
  ].filter(Boolean).join('');
  if (!groups) return '';
  return `<section class="dossier-card" id="contact">
    <h3><span><span class="card-icon">✉️</span>Contact &amp; Links</span></h3>
    <div class="contact-cols">${groups}</div>
  </section>`;
}

function policyTagsHtml(bills) {
  const counts = {};
  (bills || []).forEach(b => { if (b.policyArea) counts[b.policyArea] = (counts[b.policyArea] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!top.length) return '';
  return `<div class="policy-tags">${top.map(([area, n]) => `<span class="policy-tag">${esc(area)}<span>${n}</span></span>`).join('')}</div>`;
}

function billListHtml(bills) {
  if (!bills || !bills.length) return '<p class="muted-text">None found.</p>';
  return `<ul class="dossier-list">${bills.map(b => `
    <li class="dossier-list-item">
      <div class="dossier-list-item-title">
        <a href="${esc(safeUrl(b.url))}" target="_blank" rel="noopener">${esc(b.type)}${esc(b.number)}</a>
        ${b.becameLaw ? '<span class="badge badge--enacted">Enacted</span>' : ''}
      </div>
      <div style="font-size:.95rem;margin:.25rem 0 .4rem;">${esc(b.title)}</div>
      <div class="dossier-list-item-meta">${esc(b.introducedDate || '')}${b.policyArea ? ` · ${esc(b.policyArea)}` : ''}${b.latestAction ? `<br>Latest: ${esc(b.latestAction)}` : ''}</div>
    </li>`).join('')}</ul>`;
}

function legislationHtml(legislation) {
  if (!legislation) return '';
  const sp = Array.isArray(legislation.sponsored) ? legislation.sponsored : [];
  const co = Array.isArray(legislation.cosponsored) ? legislation.cosponsored : [];
  return `<section class="dossier-card dossier-card--wide" id="legislation">
    <h3><span><span class="card-icon">📜</span>Legislation</span></h3>
    ${policyTagsHtml(sp.length ? sp : co)}
    <div class="dossier-tabs" role="tablist" style="margin-top:.75rem;">
      <button class="dossier-tab" role="tab" aria-selected="true" data-tab="sponsored" onclick="window.switchLegislationTab('sponsored')">Sponsored (${formatNumber(legislation.sponsoredCount || 0)})</button>
      <button class="dossier-tab" role="tab" aria-selected="false" data-tab="cosponsored" onclick="window.switchLegislationTab('cosponsored')">Cosponsored (${formatNumber(legislation.cosponsoredCount || 0)})</button>
    </div>
    <div class="dossier-tab-content active" id="tab-sponsored" role="tabpanel">${billListHtml(sp)}</div>
    <div class="dossier-tab-content" id="tab-cosponsored" role="tabpanel">${billListHtml(co)}</div>
  </section>`;
}

// ── Assembly + progressive rendering ────────────────────────────────────────────

function renderDossier(container, data, opts) {
  opts = opts || {};
  const hero = normalizeHero(data, opts.handoff, opts.id);
  container.innerHTML = `
    <div class="dossier">
      ${heroHtml(hero)}
      ${statRowHtml(data)}
      ${sectionNavHtml(data)}
      <div class="dossier-grid">
        ${aboutHtml(data && data.wiki)}
        ${careerHtml(data && data.history)}
        ${fundingSectionHtml(data && data.funding, !!opts.fundingPending)}
        ${stocksHtml(data && data.stocks)}
        ${committeesHtml(data && data.committees)}
        ${contactHtml(data && data.contact)}
        ${legislationHtml(data && data.legislation)}
      </div>
    </div>`;
  attachDossierInteractions(container);
}

function attachDossierInteractions(container) {
  const share = container.querySelector('#dossier-share');
  if (share) {
    share.addEventListener('click', async () => {
      const url = window.location.href;
      try {
        await navigator.clipboard.writeText(url);
        share.textContent = '✓ Copied';
        setTimeout(() => { share.innerHTML = '🔗 Share'; }, 1600);
      } catch (_) {
        window.prompt('Copy this link:', url);
      }
    });
  }
}

function patchFunding(container, funding) {
  const card = container.querySelector('#funding');
  if (card) card.innerHTML = fundingInnerHtml(funding, false);
}

function patchGrade(container, ethics) {
  const el = container.querySelector('#hero-grade');
  if (el) el.outerHTML = heroGradeHtml(ethics === undefined ? null : ethics);
}

async function initMemberPage() {
  const backLink = document.querySelector('.back-link');
  if (backLink) backLink.href = withApiParam('members.html');

  const container = document.getElementById('dossier-container');
  if (!container) return;

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');

  if (!id) {
    container.innerHTML = `<div class="error-state"><span class="state-icon" aria-hidden="true">!</span><p>No member ID provided. <a href="${withApiParam('members.html')}">Return to Members</a></p></div>`;
    return;
  }

  // Instant path: a full dossier cached this session (e.g. from Back navigation).
  const cachedFull = sessionGet('ygn_dossier_' + id);
  if (cachedFull) {
    renderDossier(container, cachedFull, { id });
    return;
  }

  // Instant identity from the tile the user clicked, then stream the rest in.
  const handoff = sessionGet('ygn_handoff_' + id);
  renderDossier(container, null, { id, handoff, fundingPending: true });

  const fastPromise = fetchJsonWithStaticFallback(`/officials/${id}/dossier?sections=${DOSSIER_FAST_SECTIONS}`, `dossier/${id}.json`);
  // Pre-attach a catch so an early return (e.g. static notFound) below never
  // leaves this as an unhandled promise rejection.
  const slowPromise = fetchJsonWithStaticFallback(`/officials/${id}/dossier?sections=${DOSSIER_SLOW_SECTIONS}`, `dossier/${id}.json`).catch(() => null);

  let merged = null;
  try {
    const fast = await fastPromise;
    if (fast.notFound) {
      container.innerHTML = `<div class="error-state"><span class="state-icon" aria-hidden="true">?</span><p>Detail unavailable in static mode — view on the live site.</p><p><a href="${withApiParam('members.html')}">Return to Members</a></p></div>`;
      return;
    }
    merged = fast.data || {};
    const fundingPending = merged.funding === undefined;
    renderDossier(container, merged, { id, handoff, fundingPending });
  } catch (_) {
    container.innerHTML = `<div class="error-state"><span class="state-icon" aria-hidden="true">!</span><p>Could not load member data. <a href="${withApiParam('members.html')}">Return to Members</a></p></div>`;
    return;
  }

  try {
    const slow = await slowPromise;
    if (slow && !slow.notFound && slow.data) {
      merged.funding = slow.data.funding;
      merged.ethics = slow.data.ethics;
      patchFunding(container, merged.funding);
      patchGrade(container, merged.ethics);
    } else {
      patchFunding(container, merged.funding || null);
      patchGrade(container, merged.ethics || null);
    }
  } catch (_) {
    patchFunding(container, null);
    patchGrade(container, null);
  }

  if (merged && !(merged.errors && merged.errors.length)) {
    sessionSet('ygn_dossier_' + id, merged);
  }
}

// ─── Initialisation ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Resolve DOM references
  healthIndicator = document.getElementById('health-indicator');
  membersGrid     = document.getElementById('members-grid');
  membersSearch   = document.getElementById('members-search');
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
  if (homeStats) {
    initHomeStats();
    initDailyQuote();
    refreshHomeMetrics();
    setInterval(refreshHomeMetrics, 900_000);
  }
  initRecentBills();

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
  if (mapSvg) {
    initMap();
  }
  scrollToHashTarget();

  // ── Health check: immediate + every 30 seconds
  checkHealth();
  setInterval(checkHealth, 30_000);

  // ── Search
  if (membersSearch) {
    // Debounce: filtering rebuilds the whole grid, so run it once the user
    // pauses typing rather than on every keystroke.
    let searchTimer = null;
    membersSearch.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(handleSearch, 150);
    });
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
