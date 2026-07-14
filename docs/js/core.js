/* ═══════════════════════════════════════════════════════════════════════════
   YGN — Civic Government Portal — core runtime
   Vanilla JS, no framework, no build step.
   API_BASE_URL is declared in config.js, which is loaded before this script.
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Client-side caches ──────────────────────────────────────────────────────
const wikiCache = new Map();      // bioguideId → { summary, title } | null
const nominateCache = new Map();  // bioguideId → { dim1 } | null
const ethicsCache = new Map();    // bioguideId -> { score, grade } | null
let memberScoreIndex = null;
let scoreObserver = null;
const SAVED_MEMBERS_STORAGE_KEY = 'ygn_saved_members_v1';
let savedMemberIdsCache = null;

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
let showSavedMembersOnly = false;

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
let membersPartyFilter;
let membersChamberFilter;
let membersStateFilter;
let membersSort;
let membersCount;
let membersSavedToggle;
let membersSavedCount;
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

async function fetchResponseWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function evidenceBackedEthics(ethics) {
  return !!(
    ethics &&
    ethics.source === 'fec_live' &&
    ethics.method === 'campaign_finance_stock_v4' &&
    typeof ethics.score === 'number' &&
    ethics.grade && ethics.grade !== 'N/A'
  );
}

async function fetchJsonWithStaticFallback(apiPath, staticPath, options = {}) {
  const apiBaseUrl = typeof API_BASE_URL === 'string' ? API_BASE_URL : '';

  if (apiBaseUrl) {
    try {
      const res = await fetchResponseWithTimeout(
        apiBaseUrl + apiPath,
        { cache: options.cache || 'default' },
        options.timeoutMs || 10_000
      );
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
    const res = await fetchResponseWithTimeout(
      `data/${staticPath}`,
      { cache: options.staticCache || 'default' },
      options.staticTimeoutMs || 10_000
    );
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

  // Preserve the ?api= override across in-content internal links too (e.g. the
  // "Open Bills Page" / "Back to Homepage View" buttons that live outside .main-nav).
  if (apiQuerySuffix()) {
    document.querySelectorAll('main a[href$=".html"], main a[href*=".html#"]').forEach(link => {
      const href = link.getAttribute('href');
      if (href && !href.startsWith('http') && !href.includes('api=')) {
        link.setAttribute('href', withApiParam(href));
      }
    });
  }
}

// ─── Health check ────────────────────────────────────────────────────────────

/**
 * Fetch /health and update the #health-indicator pill.
 */
async function checkHealth() {
  if (!healthIndicator) return null;

  healthIndicator.className = 'checking';
  healthIndicator.textContent = 'Checking';

  try {
    const result = await fetchJsonWithStaticFallback('/health', 'health.json', { cache: 'no-store' });
    if (result.data) {
      healthIndicator.className = 'connected';
      healthIndicator.textContent = result.source === 'static' ? 'Static data' : 'Connected';
      return result.source;
    } else {
      throw new Error('non-ok status');
    }
  } catch {
    healthIndicator.className = 'disconnected';
    healthIndicator.textContent = 'Disconnected';
    return null;
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
  updateStatCard('stat-election', 'Days to Election', '-', 'Federal general election');
  updateStatCard('stat-members', 'Members Tracked', '-', 'YGN static/API data');
  updateStatCard('stat-laws', 'Laws Enacted', '-', 'This Congress');
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

// Federal general elections: the Tuesday after the first Monday of November in
// even years (2 U.S.C. §7). Deterministic, so this card never has a blank state.
function nextFederalElectionDate(from = new Date()) {
  // Compare at local midnight so Election Day itself still counts as "today"
  // instead of rolling two years forward at 00:01.
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let year = today.getFullYear(); year <= today.getFullYear() + 2; year++) {
    if (year % 2 !== 0) continue;
    const firstOfNov = new Date(year, 10, 1);
    const firstMonday = 1 + ((8 - firstOfNov.getDay()) % 7);
    const electionDay = new Date(year, 10, firstMonday + 1);
    if (electionDay >= today) return electionDay;
  }
  return null;
}

function loadElectionCountdown() {
  const election = nextFederalElectionDate();
  if (!election) return;
  const days = Math.ceil((election - new Date()) / 86400000);
  const label = election.getFullYear() % 4 === 0 ? 'Presidential election' : 'Midterm election';
  updateStatCard(
    'stat-election',
    days === 0 ? 'Election Day!' : 'Days to Election',
    days === 0 ? 'Today' : formatNumber(days),
    `${label} · Nov ${election.getDate()}, ${election.getFullYear()}`
  );
}

async function loadMemberCount() {
  // The member count lives in the 0.5 KB manifest — no need to pull the ~390 KB
  // officials.json (+157 KB scores) on the home page just to render a number.
  try {
    const res = await fetch('data/manifest.json', { cache: 'no-cache' });
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
  loadElectionCountdown();
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
    ['Top Chamber', topChamber ? `${topChamber[0]} (${topChamber[1]})` : '-', 'Within this digest']
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

// Foreign Affairs: live feed of foreign-policy bills, filtered from the recent
// bill digest by policy area + keyword — turns the static page into a live tool.
const FOREIGN_POLICY_AREAS = new Set([
  'International Affairs', 'Armed Forces and National Security', 'Foreign Trade and International Finance',
  'Immigration', 'Intelligence and National Security'
]);
const FOREIGN_KEYWORDS = /\b(nato|ukraine|russia|china|taiwan|israel|gaza|iran|treaty|sanction|foreign|defense|military|diplomat|embassy|refugee|war|troops|weapons|arms|tariff|export control)\b/i;

async function initForeignBills() {
  const host = document.getElementById('foreign-bills-list');
  if (!host) return;
  try {
    const res = await fetchJsonWithStaticFallback(
      '/bills/recent/digest?limit=40', 'recent-bills-digest.json',
      { cache: 'no-store', staticCache: 'no-store' }
    );
    const list = normalizeBillDigest(res.data).bills;
    const matches = list.filter(b =>
      FOREIGN_POLICY_AREAS.has(b.policyArea) || FOREIGN_KEYWORDS.test(String(b.title || ''))
    ).slice(0, 12);

    if (matches.length === 0) {
      host.innerHTML = '<p class="bill-empty-state">No foreign-policy bills in the current feed. Check the full Recent Bills page.</p>';
      return;
    }
    host.innerHTML = matches.map(b => {
      const href = b.detailPath ? withApiParam(`bill.html?id=${encodeURIComponent(b.detailPath)}`) : null;
      const title = esc(b.title || 'Untitled bill');
      const meta = [b.identifier, b.policyArea, (b.latestAction && formatShortDate(b.latestAction.date))].filter(Boolean).map(esc).join(' · ');
      return `<article class="foreign-bill-card">
        <div class="foreign-bill-kicker">${esc(b.identifier || '')}</div>
        ${href ? `<h3><a href="${href}">${title}</a></h3>` : `<h3>${title}</h3>`}
        <p class="foreign-bill-meta">${meta}</p>
        ${href ? `<a class="bill-detail-link" href="${href}">Cosponsors, votes & analysis →</a>` : ''}
      </article>`;
    }).join('');
  } catch (_) {
    host.innerHTML = '<p class="bill-empty-state">Foreign-policy bill feed is unavailable right now.</p>';
  }
}

// Home: party balance (House + Senate seat split), aggregated from the roster —
// the single most-asked "who controls Congress" fact, no new backend needed.
async function initCongressBalance() {
  const host = document.getElementById('home-congress-balance');
  if (!host) return;
  let congress = 119;
  let tally = null;
  try {
    const response = await fetchResponseWithTimeout('data/manifest.json', { cache: 'no-cache' });
    const manifest = response.ok ? await response.json() : {};
    congress = manifest.congress || congress;
    const compact = manifest.roster_summary && manifest.roster_summary.voting_by_chamber_party;
    if (compact && compact.House && compact.Senate) {
      const partySeats = (chamber, shortCode, longCode) =>
        Number(chamber[shortCode] ?? chamber[longCode] ?? 0) || 0;
      tally = {
        House: {
          D: partySeats(compact.House, 'D', 'DEM'),
          R: partySeats(compact.House, 'R', 'REP'),
          I: partySeats(compact.House, 'I', 'IND'),
        },
        Senate: {
          D: partySeats(compact.Senate, 'D', 'DEM'),
          R: partySeats(compact.Senate, 'R', 'REP'),
          I: partySeats(compact.Senate, 'I', 'IND'),
        },
      };
    }
  } catch (_) { /* older manifests fall back to the roster below */ }

  if (!tally) {
    let members = [];
    try {
      const res = await loadRoster();
      members = (res.data && res.data.members) || [];
    } catch (_) { return; }
    if (!members.length) return;
    const NONVOTING = new Set(['DC', 'PR', 'GU', 'VI', 'AS', 'MP',
      'District of Columbia', 'Puerto Rico', 'Guam', 'Virgin Islands',
      'American Samoa', 'Northern Mariana Islands']);
    tally = { House: { D: 0, R: 0, I: 0 }, Senate: { D: 0, R: 0, I: 0 } };
    members.forEach(m => {
      const chamber = String(getMemberChamber(m) || '').toLowerCase();
      const bucket = chamber.includes('senate') ? 'Senate' : chamber.includes('house') ? 'House' : null;
      if (!bucket || (bucket === 'House' && NONVOTING.has(getMemberField(m, 'state')))) return;
      tally[bucket][memberPartyCode(m)]++;
    });
  }

  const chamberBar = (name, t) => {
    const total = t.D + t.R + t.I || 1;
    const seg = (n, cls, label) => n > 0
      ? `<span class="cb-seg ${cls}" style="width:${(n / total) * 100}%" title="${label}: ${n}">${n}</span>` : '';
    // Independents in the modern Senate caucus with Democrats; fold them in so
    // the "who controls" label reflects governing control, not just raw D vs R.
    const dCaucus = name === 'Senate' ? t.D + t.I : t.D;
    const majority = dCaucus > t.R ? 'Democratic' : t.R > dCaucus ? 'Republican' : 'Evenly split';
    return `<div class="cb-chamber">
      <div class="cb-head"><strong>${esc(name)}</strong><span class="cb-majority">${esc(majority)} majority</span></div>
      <div class="cb-bar">${seg(t.D, 'party-d', 'Democrats')}${seg(t.I, 'party-i', 'Independents')}${seg(t.R, 'party-r', 'Republicans')}</div>
      <div class="cb-nums">${t.D} Democrats · ${t.R} Republicans${t.I ? ` · ${t.I} Independent` : ''}</div>
    </div>`;
  };

  host.innerHTML = `
    <div class="cb-title">Who runs the ${esc(congress)}th Congress</div>
    <div class="cb-chambers">
      ${chamberBar('House', tally.House)}
      ${chamberBar('Senate', tally.Senate)}
    </div>
    <a class="cb-link" href="${withApiParam('members.html')}">Browse all members →</a>`;
  host.hidden = false;
}

let currentBillsDigest = null;
const billFilterState = { policyArea: null, chamber: null };

function billMatchesFilter(bill) {
  if (showSavedBillsOnly && !isBillSaved(bill.detailPath)) return false;
  if (billFilterState.policyArea && bill.policyArea !== billFilterState.policyArea) return false;
  if (billFilterState.chamber) {
    const ch = String(bill.originChamber || '').toLowerCase();
    if (!ch.startsWith(billFilterState.chamber)) return false;
  }
  return true;
}

// Keep the bills-page URL shareable: ?topic=&chamber=&saved=1 mirror the active
// filters, and arriving with those params pre-applies them.
function syncBillFiltersToUrl() {
  if (document.body.dataset.page !== 'bills') return;
  const params = new URLSearchParams(window.location.search);
  ['topic', 'chamber', 'saved'].forEach(k => params.delete(k));
  if (billFilterState.policyArea) params.set('topic', billFilterState.policyArea);
  if (billFilterState.chamber) params.set('chamber', billFilterState.chamber);
  if (showSavedBillsOnly) params.set('saved', '1');
  const qs = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
}

function applyBillFiltersFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const topic = (params.get('topic') || '').trim();
  const chamber = (params.get('chamber') || '').trim().toLowerCase();
  if (topic) billFilterState.policyArea = topic;
  if (chamber === 'house' || chamber === 'senate') billFilterState.chamber = chamber;
  showSavedBillsOnly = params.get('saved') === '1';
}

// Topic + chamber filter chips (standalone Recent Bills page only, gated on the
// presence of #bill-filters). Filters the already-loaded digest in memory.
function renderBillFilterChips() {
  const host = document.getElementById('bill-filters');
  if (!host || !currentBillsDigest) return;
  const bills = currentBillsDigest.bills || [];
  const areas = {};
  bills.forEach(b => { if (b.policyArea) areas[b.policyArea] = (areas[b.policyArea] || 0) + 1; });
  const topAreas = Object.entries(areas).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const chip = (label, active, group, value) =>
    `<button type="button" class="bill-chip${active ? ' active' : ''}" data-group="${group}" data-value="${esc(value == null ? '' : value)}">${esc(label)}</button>`;

  const savedCount = savedBillPaths().length;
  const savedChip = savedCount || showSavedBillsOnly
    ? `<button type="button" class="bill-chip bill-chip--saved${showSavedBillsOnly ? ' active' : ''}" data-group="saved">★ Tracked (${savedCount})</button>`
    : '';
  const anyFilter = billFilterState.chamber || billFilterState.policyArea || showSavedBillsOnly;
  const clearChip = anyFilter
    ? `<button type="button" class="bill-chip bill-chip--clear" data-group="clear">✕ Clear filters</button>`
    : '';

  const chamberChips = [
    chip('All chambers', !billFilterState.chamber, 'chamber', ''),
    chip('House', billFilterState.chamber === 'house', 'chamber', 'house'),
    chip('Senate', billFilterState.chamber === 'senate', 'chamber', 'senate'),
  ].join('');
  const areaChips = [chip('All topics', !billFilterState.policyArea, 'policyArea', '')]
    .concat(topAreas.map(([a, n]) => chip(`${a} (${n})`, billFilterState.policyArea === a, 'policyArea', a)))
    .join('');

  host.innerHTML = `<div class="bill-chip-row">${chamberChips}${savedChip}${clearChip}</div><div class="bill-chip-row">${areaChips}</div>`;
  host.querySelectorAll('.bill-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.group;
      if (group === 'saved') {
        showSavedBillsOnly = !showSavedBillsOnly;
      } else if (group === 'clear') {
        billFilterState.chamber = null;
        billFilterState.policyArea = null;
        showSavedBillsOnly = false;
      } else {
        const value = btn.dataset.value || null;
        billFilterState[group] = billFilterState[group] === value ? null : value;
      }
      syncBillFiltersToUrl();
      renderBillFilterChips();
      renderBillRows();
    });
  });
}

function renderRecentBills(digest, source) {
  if (!recentBillsGrid) return;
  currentBillsDigest = digest;
  if (source !== undefined) recentBillsGrid.dataset.source = source;
  renderBillFilterChips();
  renderBillRows();
}

function renderBillRows() {
  if (!recentBillsGrid || !currentBillsDigest) return;
  const digest = currentBillsDigest;
  const source = recentBillsGrid.dataset.source;
  // Tracked view searches the WHOLE digest (not just the visible slice) so a
  // bill tracked from page 3 or a detail page still shows up; other filters
  // apply to the slice the user has loaded.
  const limited = showSavedBillsOnly
    ? (digest.bills || [])
    : (digest.bills || []).slice(0, Number(recentBillsGrid.dataset.limit || 5));
  const bills = limited.filter(billMatchesFilter);
  recentBillsGrid.innerHTML = '';

  // Tracked bills that aren't in the digest at all (starred on a detail page,
  // spotlight, or aged out of the feed) still get a stub row from storage.
  const digestPaths = new Set((digest.bills || []).map(b => b.detailPath).filter(Boolean));
  const orphanSaved = showSavedBillsOnly
    ? savedBillEntries().filter(e => !digestPaths.has(e.path))
    : [];

  if (recentBillsStatus) {
    const generatedAt = digest.generated_at ? ` Updated ${formatShortDate(digest.generated_at)}.` : '';
    recentBillsStatus.textContent = `${source === 'api' ? 'Live Congress.gov data' : 'Static fallback data'}.${generatedAt}`;
  }

  // Pulse reflects the active filter (falls back to the full slice when unfiltered).
  renderCivicPulse(bills.length ? bills : limited, digest);

  if (bills.length === 0 && orphanSaved.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bill-empty-state';
    empty.textContent = showSavedBillsOnly
      ? 'No tracked bills yet — tap the ☆ on any bill to track it.'
      : (billFilterState.policyArea || billFilterState.chamber)
        ? 'No bills match the selected filters.'
        : 'No recent bills are available right now.';
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

    const detailHref = bill.detailPath ? withApiParam(`bill.html?id=${encodeURIComponent(bill.detailPath)}`) : null;

    const titleCell = document.createElement('div');
    const kicker = document.createElement('div');
    kicker.className = 'bill-kicker';
    kicker.textContent = bill.identifier || `${bill.type || ''} ${bill.number || ''}`.trim();
    if (bill.detailPath) {
      const starWrap = document.createElement('span');
      starWrap.innerHTML = billSaveButtonHtml(bill.detailPath, true, bill);
      kicker.appendChild(starWrap.firstElementChild);
    }
    titleCell.appendChild(kicker);
    if (detailHref) {
      const titleLink = document.createElement('a');
      titleLink.className = 'bill-title bill-title-link';
      titleLink.href = detailHref;
      titleLink.textContent = bill.title || 'Untitled bill';
      const titleWrap = document.createElement('h3');
      titleWrap.appendChild(titleLink);
      titleCell.appendChild(titleWrap);
    } else {
      appendText(titleCell, 'bill-title', bill.title || 'Untitled bill', 'h3');
    }
    appendText(titleCell, 'bill-meta', [bill.congress ? `${bill.congress}th Congress` : '', bill.originChamber].filter(Boolean).join(' - '), 'p');
    const stageWrap = document.createElement('div');
    stageWrap.innerHTML = billStageChipHtml(bill);
    titleCell.appendChild(stageWrap.firstElementChild);
    if (detailHref) {
      const detailLink = document.createElement('a');
      detailLink.className = 'bill-detail-link';
      detailLink.href = detailHref;
      detailLink.textContent = 'Full detail, cosponsors & votes →';
      titleCell.appendChild(detailLink);
    }
    if (bill.url) appendLink(titleCell, 'Open bill record', bill.url);

    const descriptionCell = document.createElement('div');
    const description = bill.description || {};
    // Prefer the short, complete AI description (fits without ellipsis) over the
    // long official summary; fall back to the official text when there's no AI one.
    const aiDesc = bill.aiDescription && bill.aiDescription.summary;
    if (aiDesc) {
      appendText(descriptionCell, 'bill-description bill-description--ai', aiDesc);
      appendText(descriptionCell, 'bill-meta', 'Plain-language summary · AI', 'p');
    } else {
      appendText(descriptionCell, 'bill-description', description.text || 'Congress.gov has not published a summary for this bill yet.');
      appendText(descriptionCell, 'bill-meta', [description.source, formatShortDate(description.updated_at)].filter(Boolean).join(' - '), 'p');
    }

    const membersCell = document.createElement('div');
    const members = Array.isArray(bill.members) ? bill.members : [];
    members.slice(0, 6).forEach(member => {
      const item = document.createElement('div');
      item.className = 'bill-member-pill';
      appendText(item, 'bill-member-role', member.role || 'Member', 'span');
      appendText(item, '', billMemberLabel(member), 'strong');
      membersCell.appendChild(item);
    });
    if (typeof bill.cosponsorCount === 'number' && bill.cosponsorCount > 0) {
      const coLine = document.createElement('div');
      coLine.className = 'bill-cosponsor-count';
      coLine.textContent = `${bill.cosponsorCount} cosponsor${bill.cosponsorCount === 1 ? '' : 's'}`;
      if (detailHref) {
        const seeAll = document.createElement('a');
        seeAll.href = detailHref;
        seeAll.textContent = ' — see all';
        coLine.appendChild(seeAll);
      }
      membersCell.appendChild(coLine);
    } else if (members.length === 0) {
      appendText(membersCell, 'bill-meta', 'Sponsor data loads from Congress.gov.', 'p');
    }

    const impactCell = document.createElement('div');
    const impact = bill.impact || {};
    appendText(impactCell, 'bill-impact-status', impact.status || 'Pending AI impact analysis', 'strong');
    // Word-limited AI impact, shown in full (bill-description--ai does not clamp),
    // so it never ends in an ellipsis. The redundant Congress.gov link is dropped
    // to give the analysis the whole cell.
    appendText(impactCell, 'bill-description bill-description--ai', impact.summary || 'AI impact analysis is queued and will appear after the next content refresh.');

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

  orphanSaved.forEach(entry => {
    const row = document.createElement('article');
    row.className = 'bill-row bill-row--orphan';
    const cell = document.createElement('div');
    cell.className = 'bill-cell bill-cell--orphan';
    const href = withApiParam(`bill.html?id=${encodeURIComponent(entry.path)}`);
    cell.innerHTML = `
      <div class="bill-kicker">${esc(entry.identifier || entry.path)}${billSaveButtonHtml(entry.path, true, entry)}</div>
      <h3><a class="bill-title bill-title-link" href="${href}">${esc(entry.title || 'Tracked bill')}</a></h3>
      <p class="bill-meta">Tracked bill outside the current recent-activity feed — open it for full detail.</p>`;
    row.appendChild(cell);
    recentBillsGrid.appendChild(row);
  });

  wireBillSaveButtons(recentBillsGrid);
}

// ─── Bill detail page (clickable bill w/ cosponsors + roll-call votes) ────────

const VOTE_ORDER = ['Yea', 'Nay', 'Present', 'Not Voting'];
const VOTE_CLASS = { 'Yea': 'yea', 'Nay': 'nay', 'Present': 'present', 'Not Voting': 'notvoting' };

function partyClass(party) {
  const p = String(party || '').trim().toUpperCase();
  if (p.startsWith('D')) return 'party-d';
  if (p.startsWith('R')) return 'party-r';
  return 'party-i';
}

function personLinkHtml(person, roleLabel) {
  const partyState = [person.party, person.state, person.district]
    .filter(v => v !== null && v !== undefined && v !== '')
    .join('-');
  const label = esc(person.name || 'Unknown');
  const meta = partyState ? ` <span class="bill-person-meta">(${esc(partyState)})</span>` : '';
  const role = roleLabel ? `<span class="bill-person-role">${esc(roleLabel)}</span>` : '';
  const inner = `${role}<span class="bill-person-name">${label}</span>${meta}`;
  if (person.bioguideId) {
    const href = withApiParam(`member.html?id=${encodeURIComponent(person.bioguideId)}`);
    return `<a class="bill-person ${partyClass(person.party)}" href="${href}">${inner}</a>`;
  }
  return `<span class="bill-person ${partyClass(person.party)}">${inner}</span>`;
}

function billVoteHtml(vote, index) {
  const totals = vote.totals || {};
  const counted = VOTE_ORDER.reduce((sum, k) => sum + (Number(totals[k]) || 0), 0) || 1;
  const positions = Array.isArray(vote.positions) ? vote.positions : [];

  const bar = VOTE_ORDER.map(k => {
    const n = Number(totals[k]) || 0;
    if (n === 0) return '';
    const pct = (n / counted) * 100;
    return `<span class="vote-bar-seg vote-${VOTE_CLASS[k]}" style="width:${pct}%" title="${esc(k)}: ${n}"></span>`;
  }).join('');

  const legend = VOTE_ORDER.map(k => {
    const n = Number(totals[k]) || 0;
    return `<span class="vote-legend-item"><span class="vote-dot vote-${VOTE_CLASS[k]}"></span>${esc(k)} <strong>${n}</strong></span>`;
  }).join('');

  const groups = VOTE_ORDER.map(k => {
    const members = positions
      .filter(p => p.vote === k)
      .sort((a, b) => {
        const pa = partyClass(a.party), pb = partyClass(b.party);
        if (pa !== pb) return pa.localeCompare(pb);
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
    if (members.length === 0) return '';
    const chips = members.map(m => personLinkHtml(m)).join('');
    return `<details class="vote-group">
      <summary><span class="vote-dot vote-${VOTE_CLASS[k]}"></span>${esc(k)} <strong>${members.length}</strong></summary>
      <div class="vote-group-members">${chips}</div>
    </details>`;
  }).join('');

  const meta = [
    vote.chamber,
    vote.rollNumber != null ? `Roll ${esc(String(vote.rollNumber))}` : '',
    vote.result ? esc(vote.result) : '',
    vote.date ? formatShortDate(vote.date) : ''
  ].filter(Boolean).join(' · ');

  return `<div class="bill-vote-card">
    <div class="bill-vote-head">
      <h4>${esc(vote.question || vote.description || 'Recorded vote')}</h4>
      <p class="bill-vote-meta">${meta}</p>
    </div>
    <div class="vote-bar">${bar}</div>
    <div class="vote-legend">${legend}</div>
    ${votePartyAnalysisHtml(positions)}
    <div class="vote-groups">${groups}</div>
    ${vote.url ? `<a class="bill-vote-source" href="${esc(safeUrl(vote.url))}" target="_blank" rel="noopener">Official roll-call record →</a>` : ''}
  </div>`;
}

// Party-split analysis: for D and R, how each side voted yea/nay, plus a derived
// "Party-line vote / Bipartisan / cross-party defections" label — the single most
// instructive fact about a roll-call for a civic-education audience.
function votePartyAnalysisHtml(positions) {
  const tally = { D: { Yea: 0, Nay: 0 }, R: { Yea: 0, Nay: 0 } };
  positions.forEach(p => {
    const cls = partyClass(p.party);
    const key = cls === 'party-d' ? 'D' : cls === 'party-r' ? 'R' : null;
    if (key && (p.vote === 'Yea' || p.vote === 'Nay')) tally[key][p.vote]++;
  });
  const dTot = tally.D.Yea + tally.D.Nay;
  const rTot = tally.R.Yea + tally.R.Nay;
  if (dTot < 2 || rTot < 2) return '';

  const dYeaPct = tally.D.Yea / dTot, rYeaPct = tally.R.Yea / rTot;
  // Each party's majority side; "party-line" when the two parties' majorities oppose
  // and each is lopsided (>=85%).
  const dMajYea = dYeaPct >= 0.5, rMajYea = rYeaPct >= 0.5;
  const dLopsided = Math.max(dYeaPct, 1 - dYeaPct) >= 0.85;
  const rLopsided = Math.max(rYeaPct, 1 - rYeaPct) >= 0.85;
  let label, cls;
  if (dMajYea !== rMajYea && dLopsided && rLopsided) {
    label = 'Party-line vote'; cls = 'vote-tag--partyline';
  } else if (dMajYea === rMajYea) {
    label = 'Bipartisan'; cls = 'vote-tag--bipartisan';
  } else {
    const crossed = dMajYea ? tally.D.Nay + tally.R.Yea : tally.D.Yea + tally.R.Nay;
    label = `Mostly along party lines · ${crossed} cross-party`; cls = 'vote-tag--mixed';
  }

  const row = (party, t, tot) => `
    <div class="vote-party-row">
      <span class="vote-party-label ${party === 'D' ? 'party-d' : 'party-r'}">${party === 'D' ? 'Democrats' : 'Republicans'}</span>
      <span class="vote-party-bar">
        <span class="vote-yea" style="width:${(t.Yea / tot) * 100}%"></span>
        <span class="vote-nay" style="width:${(t.Nay / tot) * 100}%"></span>
      </span>
      <span class="vote-party-nums">${t.Yea}–${t.Nay}</span>
    </div>`;

  return `<div class="vote-party-analysis">
    <div class="vote-party-tag ${cls}">${esc(label)}</div>
    ${row('D', tally.D, dTot)}
    ${row('R', tally.R, rTot)}
  </div>`;
}

function billPeopleListHtml(people, roleLabel) {
  if (!Array.isArray(people) || people.length === 0) return '';
  return `<div class="bill-people">${people.map(p => personLinkHtml(p, roleLabel)).join('')}</div>`;
}

// Cosponsor party split + a bipartisan/single-party label.
function cosponsorSplitHtml(cosponsors) {
  if (!Array.isArray(cosponsors) || cosponsors.length < 2) return '';
  const counts = { D: 0, R: 0, I: 0 };
  cosponsors.forEach(c => {
    const cls = partyClass(c.party);
    counts[cls === 'party-d' ? 'D' : cls === 'party-r' ? 'R' : 'I']++;
  });
  const total = counts.D + counts.R + counts.I || 1;
  const parties = [counts.D > 0, counts.R > 0].filter(Boolean).length;
  const tag = parties >= 2
    ? '<span class="cosponsor-tag bipartisan">Bipartisan cosponsors</span>'
    : '<span class="cosponsor-tag single">Single-party cosponsors</span>';
  const seg = (n, cls) => n > 0 ? `<span class="${cls}" style="width:${(n / total) * 100}%" title="${n}"></span>` : '';
  return `<div class="cosponsor-split">
    ${tag}
    <div class="cosponsor-split-bar">
      ${seg(counts.D, 'party-d')}${seg(counts.R, 'party-r')}${seg(counts.I, 'party-i')}
    </div>
    <div class="cosponsor-split-nums">${counts.D} D · ${counts.R} R${counts.I ? ` · ${counts.I} I` : ''}</div>
  </div>`;
}

// Generated content is read-only on page requests. Missing content is queued and
// filled by the next trusted cache/static refresh.
function aiBlockHtml(id, label, summary, pending) {
  if (summary) {
    return `<div class="bill-ai-block" id="${id}">
      <div class="bill-ai-label">${esc(label)} <span class="ai-badge">AI</span></div>
      <p>${esc(summary)}</p>
    </div>`;
  }
  if (pending) {
    return `<div class="bill-ai-block bill-ai-block--pending" id="${id}">
      <div class="bill-ai-label">${esc(label)} <span class="ai-badge">Queued</span></div>
      <p>This analysis will appear after the next content refresh. Page requests never call the model directly.</p>
    </div>`;
  }
  return `<div class="bill-ai-block bill-ai-block--pending" id="${id}">
    <div class="bill-ai-label">${esc(label)}</div>
    <p>No cached analysis is available. The official Congress.gov summary remains the source of record.</p>
  </div>`;
}

// ─── Bill status stepper (Congress.gov "Status of Legislation" stages) ───────
// Heuristic from the latest action text; the canonical labels are Introduced →
// Passed House → Passed Senate → To President → Became Law, chamber order
// following the origin chamber. Committee referral shows as a sub-state of
// Introduced, matching congress.gov's tracker.

function billStage(bill) {
  const action = String((bill.latestAction || {}).text || '').toLowerCase();
  const origin = String(bill.originChamber || '').toLowerCase();
  const type = String(bill.type || '').toLowerCase().replace(/\./g, '');
  const first = origin.includes('senate') || type.startsWith('s') ? 'Senate' : 'House';
  const second = first === 'Senate' ? 'House' : 'Senate';

  // Simple resolutions (HRES/SRES) live and die in one chamber; concurrent
  // (HCONRES/SCONRES) need both but never reach the President; bills and joint
  // resolutions follow the full congress.gov tracker.
  const isSimpleRes = type === 'hres' || type === 'sres';
  const isConcurrentRes = type === 'hconres' || type === 'sconres';
  const stages = isSimpleRes
    ? ['Introduced', `Agreed to in ${first}`]
    : isConcurrentRes
      ? ['Introduced', `Agreed to ${first}`, `Agreed to ${second}`]
      : ['Introduced', `Passed ${first}`, `Passed ${second}`, 'To President', 'Became Law'];

  const passedRe = chamber => new RegExp(`(passed|agreed to)( in| by)?( the)? ${chamber.toLowerCase()}`);
  // "Received in the {second chamber}" / "Held at the desk" are the standard
  // resting states AFTER the first chamber passes — they must not read as
  // "Introduced" (congress.gov shows "Passed {first}" for these).
  const receivedInSecond = new RegExp(`received in( the)? ${second.toLowerCase()}`);
  const secondAgreedLoose = new RegExp(`received in( the)? ${second.toLowerCase()}[^.]*agreed to`);

  let index = 0;
  let sub = null;
  if (!isSimpleRes && !isConcurrentRes && /became public law|public law no|signed by president/.test(action)) index = 4;
  else if (!isSimpleRes && !isConcurrentRes && /presented to (the )?president/.test(action)) index = 3;
  else if (!isSimpleRes && (passedRe(second).test(action) || secondAgreedLoose.test(action))) index = 2;
  else if (
    passedRe(first).test(action)
    || /passed\/agreed to in/.test(action)
    || /submitted in the senate.*agreed to/.test(action)
    // House phrasing omits the chamber: "On agreeing to the resolution ... Agreed to".
    || /on agreeing to the resolution[^.]*agreed to/.test(action)
    || receivedInSecond.test(action)
    || /held at the desk/.test(action)
  ) {
    index = 1;
    if (receivedInSecond.test(action) || /held at the desk/.test(action)) sub = `In ${second}`;
  }
  else if (/referred to|committee/.test(action)) { index = 0; sub = 'In committee'; }

  index = Math.min(index, stages.length - 1);
  return { stages, index, sub };
}

function billStepperHtml(bill) {
  const { stages, index, sub } = billStage(bill);
  const nodes = stages.map((label, i) => {
    const cls = i < index ? 'done' : i === index ? 'current' : 'todo';
    const subHtml = (i === index && sub) ? `<small>${esc(sub)}</small>` : '';
    return `<li class="stage-${cls}"><span class="stage-dot"></span><span class="stage-label">${esc(label)}${subHtml}</span></li>`;
  }).join('');
  return `<ol class="bill-stepper" aria-label="Bill status">${nodes}</ol>`;
}

function billStageChipHtml(bill) {
  const { stages, index, sub } = billStage(bill);
  const label = sub || stages[index];
  const pct = ((index + 1) / stages.length) * 100;
  return `<span class="stage-chip" title="Status: ${esc(label)} (step ${index + 1} of ${stages.length})">
    <span class="stage-chip-bar"><span style="width:${pct}%"></span></span>${esc(label)}</span>`;
}

function renderBillDetail(container, data) {
  const bill = (data && data.bill) || {};
  const desc = bill.description || {};
  const votes = Array.isArray(bill.votes) ? bill.votes : [];
  const cosponsors = Array.isArray(bill.cosponsors) ? bill.cosponsors : [];
  const cosponsorCount = typeof bill.cosponsorCount === 'number' ? bill.cosponsorCount : cosponsors.length;

  const congressLabel = bill.congress ? `${bill.congress}th Congress` : '';
  const chamberLabel = bill.originChamber || '';
  const headMeta = [congressLabel, chamberLabel, bill.policyArea].filter(Boolean).map(esc).join(' · ');

  // AI blocks render committed/refresh-cached content immediately; misses show
  // an honest queued state without a request-time model call.
  const pending = !!bill.aiPending;
  const aiDesc = aiBlockHtml(
    'ai-desc-block', 'Plain-language description',
    bill.aiDescription && bill.aiDescription.summary,
    pending && !(bill.aiDescription && bill.aiDescription.summary)
  );
  const impact = aiBlockHtml(
    'ai-impact-block', 'Who this affects — impact analysis',
    bill.impact && bill.impact.summary,
    pending && !(bill.impact && bill.impact.summary)
  );

  const votesHtml = votes.length
    ? votes.map((v, i) => billVoteHtml(v, i)).join('')
    : `<p class="bill-empty-note">No recorded roll-call votes are associated with this bill yet. Most bills are referred to committee without a floor vote.</p>`;

  const sponsorsHtml = billPeopleListHtml(bill.sponsors, 'Sponsor')
    || '<p class="bill-empty-note">Sponsor information is unavailable.</p>';

  const cosponsorsHtml = cosponsors.length
    ? billPeopleListHtml(cosponsors)
    : `<p class="bill-empty-note">${cosponsorCount > 0 ? 'Cosponsor names are loading from Congress.gov.' : 'This bill has no cosponsors.'}</p>`;

  const latest = bill.latestAction || {};

  container.innerHTML = `
    <article class="bill-detail">
      <header class="bill-detail-head">
        <div class="bill-detail-kicker">${esc(bill.identifier || '')} ${billSaveButtonHtml(bill.detailPath, false, bill)}</div>
        <h1>${esc(bill.title || 'Untitled bill')}</h1>
        <p class="bill-detail-meta">${headMeta}</p>
        ${billStepperHtml(bill)}
        ${whatHappensNextHtml(bill)}
        <div class="bill-detail-links">
          ${bill.url ? `<a class="secondary-button" href="${esc(safeUrl(bill.url))}" target="_blank" rel="noopener">Open on Congress.gov</a>` : ''}
        </div>
      </header>

      <section class="bill-detail-card">
        <h2>Summary</h2>
        <p class="bill-detail-summary">${esc(desc.text || 'Congress.gov has not published a summary for this bill yet.')}</p>
        ${desc.source ? `<p class="bill-meta">${esc(desc.source)}${desc.updated_at ? ` · ${esc(formatShortDate(desc.updated_at))}` : ''}</p>` : ''}
        ${aiDesc}
        ${impact}
      </section>

      <div class="bill-detail-grid">
        <section class="bill-detail-card">
          <h2>Sponsor</h2>
          ${sponsorsHtml}
        </section>
        <section class="bill-detail-card">
          <h2>Cosponsors <span class="bill-count-badge">${cosponsorCount}</span></h2>
          ${cosponsorSplitHtml(cosponsors)}
          ${cosponsorsHtml}
        </section>
      </div>

      <section class="bill-detail-card">
        <h2>Roll-call votes</h2>
        <p class="bill-detail-subnote">Who voted yea, nay, present, or did not vote. Click a category to see the members.</p>
        ${votesHtml}
      </section>

      <section class="bill-detail-card">
        <h2>Latest action</h2>
        <p>${esc(latest.text || 'No latest action recorded.')}</p>
        <p class="bill-meta">${latest.date ? esc(formatShortDate(latest.date)) : ''}</p>
        ${Array.isArray(bill.committees) && bill.committees.length ? `<h3 class="bill-subhead">Committees</h3><p class="bill-meta">${esc(bill.committees.join(', '))}</p>` : ''}
      </section>
    </article>`;
}

async function initBillPage() {
  const backLink = document.querySelector('.back-link');
  if (backLink) backLink.href = withApiParam('recent-bills.html');

  const container = document.getElementById('bill-container');
  if (!container) return;

  const params = new URLSearchParams(window.location.search);
  const id = (params.get('id') || '').trim();
  const parts = id.split('/').filter(Boolean);

  if (parts.length !== 3) {
    container.innerHTML = `<div class="error-state"><span class="state-icon" aria-hidden="true">!</span><p>No bill was specified. <a href="${withApiParam('recent-bills.html')}">Return to Recent Bills</a></p></div>`;
    return;
  }

  const [congress, billType, number] = parts;
  container.innerHTML = '<div class="bill-empty-state">Loading bill detail…</div>';

  try {
    const result = await fetchJsonWithStaticFallback(
      `/bills/${encodeURIComponent(congress)}/${encodeURIComponent(billType)}/${encodeURIComponent(number)}`,
      `bills/${congress}-${billType}-${number}.json`
    );
    if (result.notFound || !result.data) {
      container.innerHTML = `<div class="error-state"><span class="state-icon" aria-hidden="true">?</span><p>Bill detail is only available on the live site. <a href="${withApiParam('recent-bills.html')}">Return to Recent Bills</a></p></div>`;
      return;
    }
    renderBillDetail(container, result.data);
    wireBillSaveButtons(container);
    injectRelatedBills(container, (result.data && result.data.bill) || null);

  } catch (_) {
    container.innerHTML = `<div class="error-state"><span class="state-icon" aria-hidden="true">!</span><p>Could not load this bill. <a href="${withApiParam('recent-bills.html')}">Return to Recent Bills</a></p></div>`;
  }
}

// ─── Economy dashboard ───────────────────────────────────────────────────────

function econCard(label, value, context, feature) {
  return `<div class="econ-card${feature ? ' econ-card--feature' : ''}">
    <div class="econ-card-label">${esc(label)}</div>
    <div class="econ-card-value">${esc(value)}</div>
    <div class="econ-card-context">${esc(context)}</div>
  </div>`;
}

function econSparkline(points, label) {
  if (!points || points.length < 2) return '';
  const w = 640, h = 120, pad = 10;
  const vals = points.map(p => p.amount);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = (max - min) || 1;
  const x = i => pad + (i / (points.length - 1)) * (w - 2 * pad);
  const y = v => h - pad - ((v - min) / range) * (h - 2 * pad);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.amount).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
  return `<svg viewBox="0 0 ${w} ${h}" class="econ-spark" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
    <path d="${area}" fill="rgba(79,142,247,0.12)"></path>
    <path d="${line}" fill="none" stroke="var(--color-accent)" stroke-width="2.5" vector-effect="non-scaling-stroke"></path>
  </svg>`;
}

function econTrendCard(trend) {
  if (!trend || !Array.isArray(trend.points) || trend.points.length < 2) return '';
  const pts = trend.points;
  const first = pts[0], last = pts[pts.length - 1];
  const change = first.amount ? ((last.amount - first.amount) / first.amount) * 100 : 0;
  const label = `National debt over the last ${pts.length} months`;
  return `<div class="econ-card econ-card--wide">
    <div class="econ-card-label">National Debt — last ${pts.length} months</div>
    ${econSparkline(pts, label)}
    <div class="econ-card-context">${formatCurrencyCompact(first.amount)} (${esc(first.date.slice(0, 7))}) → ${formatCurrencyCompact(last.amount)} (${esc(last.date.slice(0, 7))}) · ${change >= 0 ? '+' : ''}${change.toFixed(1)}%</div>
  </div>`;
}

function renderEconomy(grid, sourcesEl, data) {
  const m = (data && data.metrics) || {};
  const debt = m.debt;
  const infl = m.inflation;
  const cards = [
    econCard('National Debt',
      debt ? formatCurrencyCompact(Number(debt.amount)) : '—',
      debt ? `U.S. Treasury · ${formatShortDate(debt.record_date)}` : 'Unavailable', true),
    econCard('Debt-to-GDP',
      m.debt_to_gdp ? `${m.debt_to_gdp.value}%` : '—', 'Total debt ÷ annual GDP'),
    econCard('Debt per Person',
      m.debt_per_capita ? `$${formatNumber(m.debt_per_capita.value)}` : '—', "Each resident's share"),
    econCard('GDP',
      m.gdp ? formatCurrencyCompact(m.gdp.value) : '—',
      m.gdp ? `World Bank · ${esc(m.gdp.date)}` : 'Unavailable'),
    econCard('Unemployment',
      m.unemployment ? `${m.unemployment.value}%` : '—',
      m.unemployment ? `BLS · ${m.unemployment.period} ${m.unemployment.year}` : 'Unavailable'),
    econCard('Inflation (CPI, yr/yr)',
      (infl && infl.value != null) ? `${infl.value}%` : '—',
      infl ? `BLS CPI-U · ${infl.period} ${infl.year}` : 'Unavailable'),
    econCard('U.S. Population',
      m.population ? formatCompact(m.population.value) : '—',
      m.population ? `World Bank · ${esc(m.population.date)}` : 'Unavailable'),
  ];
  grid.innerHTML = cards.join('') + econTrendCard(m.debt_trend);
  if (sourcesEl) {
    sourcesEl.textContent = 'Sources: U.S. Treasury Fiscal Data, U.S. Bureau of Labor Statistics, World Bank. Figures update as each agency publishes.';
  }
}

async function initEconomy() {
  const grid = document.getElementById('econ-grid');
  if (!grid) return;
  const sourcesEl = document.getElementById('econ-sources');
  grid.innerHTML = Array.from({ length: 7 }, () =>
    '<div class="econ-card"><div class="skeleton-line medium"></div><div class="skeleton-line wide" style="height:1.5rem;"></div><div class="skeleton-line narrow"></div></div>').join('');
  try {
    const result = await fetchJsonWithStaticFallback('/metrics/economy', 'economy.json', { cache: 'no-store' });
    if (result.notFound) {
      grid.innerHTML = '<p class="muted-text">Live economic data is available on the hosted site.</p>';
      return;
    }
    renderEconomy(grid, sourcesEl, result.data);
  } catch (_) {
    grid.innerHTML = '<div class="error-state"><span class="state-icon" aria-hidden="true">!</span><p>Could not load economic data right now.</p></div>';
  }
}

async function loadRecentBills(limit) {
  if (!recentBillsGrid) return;
  const loadMoreBtn = document.getElementById('load-more-bills');
  try {
    const result = await fetchJsonWithStaticFallback(
      `/bills/recent/digest?limit=${encodeURIComponent(limit)}`,
      'recent-bills-digest.json',
      { cache: 'no-store', staticCache: 'no-store' }
    );
    const digest = normalizeBillDigest(result.data);
    // Show up to `limit` bills (static fallback may hold fewer than requested).
    recentBillsGrid.dataset.limit = String(limit);
    renderRecentBills(digest, result.source);
    renderTrendingTopics(digest);
    if (loadMoreBtn) {
      const available = Array.isArray(digest.bills) ? digest.bills.length : 0;
      const max = Number(recentBillsGrid.dataset.max || 40);
      // Hide "load more" once we've reached the max or the feed has no more to give.
      const exhausted = limit >= max || available < limit;
      loadMoreBtn.hidden = exhausted;
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load more bills';
    }
  } catch {
    if (recentBillsStatus) recentBillsStatus.textContent = 'Recent bills unavailable.';
    if (!recentBillsGrid.querySelector('.bill-row')) {
      recentBillsGrid.innerHTML = '<div class="bill-empty-state">Recent bill data could not be loaded.</div>';
    }
    if (loadMoreBtn) { loadMoreBtn.disabled = false; loadMoreBtn.textContent = 'Load more bills'; }
  }
}

async function initRecentBills() {
  if (!recentBillsGrid) return;
  applyBillFiltersFromUrl();
  const initialLimit = Number(recentBillsGrid.dataset.limit || 5);
  recentBillsGrid.innerHTML = '<div class="bill-empty-state">Loading recent bills</div>';

  const loadMoreBtn = document.getElementById('load-more-bills');
  if (loadMoreBtn) {
    const step = Number(recentBillsGrid.dataset.step || 10);
    const max = Number(recentBillsGrid.dataset.max || 40);
    loadMoreBtn.addEventListener('click', () => {
      const current = Number(recentBillsGrid.dataset.limit || initialLimit);
      const next = Math.min(current + step, max);
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = 'Loading…';
      loadRecentBills(next);
    });
  }

  await loadRecentBills(initialLimit);
}

// Saved members are intentionally browser-local: profiles can be bookmarked
// without an account, and a storage failure never blocks the roster or dossier.
function normalizeSavedMemberId(value) {
  return String(value == null ? '' : value).trim();
}

function readSavedMemberIds() {
  try {
    const raw = window.localStorage.getItem(SAVED_MEMBERS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    const values = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.ids) ? parsed.ids : []);
    return new Set(values.map(normalizeSavedMemberId).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

function getSavedMemberIds() {
  if (savedMemberIdsCache === null) savedMemberIdsCache = readSavedMemberIds();
  return savedMemberIdsCache;
}

function isMemberSaved(bioguideId) {
  const id = normalizeSavedMemberId(bioguideId);
  return !!id && getSavedMemberIds().has(id);
}

function persistSavedMemberIds(ids) {
  try {
    window.localStorage.setItem(SAVED_MEMBERS_STORAGE_KEY, JSON.stringify(Array.from(ids).sort()));
  } catch (_) { /* In-memory state still works for this page view. */ }
}

function savedMemberButtonHtml(bioguideId, memberName, variant) {
  const id = normalizeSavedMemberId(bioguideId);
  if (!id) return '';
  const name = memberName || 'this member';
  const saved = isMemberSaved(id);
  const isDetail = variant === 'detail';
  const visibleLabel = saved ? 'Saved' : 'Save';
  const ariaLabel = saved ? `Remove ${name} from saved members` : `Save ${name}`;
  return `
    <button
      class="member-save-button member-save-button--${isDetail ? 'detail' : 'tile'}${saved ? ' is-saved' : ''}"
      type="button"
      data-save-member-id="${esc(id)}"
      data-save-member-name="${esc(name)}"
      data-save-variant="${isDetail ? 'detail' : 'tile'}"
      aria-pressed="${saved ? 'true' : 'false'}"
      aria-label="${esc(ariaLabel)}"
      title="${esc(ariaLabel)}"
    >
      <svg class="member-save-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6.75 4.75A1.75 1.75 0 0 1 8.5 3h7a1.75 1.75 0 0 1 1.75 1.75v15.1L12 16.6l-5.25 3.25V4.75Z"></path>
      </svg>
      <span class="${isDetail ? 'member-save-label' : 'visually-hidden'}" data-save-label>${visibleLabel}</span>
    </button>`;
}

function syncMemberSaveButton(button) {
  if (!button) return;
  const id = normalizeSavedMemberId(button.dataset.saveMemberId);
  const name = button.dataset.saveMemberName || 'this member';
  const saved = isMemberSaved(id);
  const label = button.dataset.saveVariant === 'detail'
    ? (saved ? 'Saved' : 'Save')
    : (saved ? `Remove ${name} from saved members` : `Save ${name}`);
  const ariaLabel = saved ? `Remove ${name} from saved members` : `Save ${name}`;

  button.classList.toggle('is-saved', saved);
  button.setAttribute('aria-pressed', saved ? 'true' : 'false');
  button.setAttribute('aria-label', ariaLabel);
  button.setAttribute('title', ariaLabel);
  const text = button.querySelector('[data-save-label]');
  if (text) text.textContent = label;
}

function currentRosterSavedCount() {
  if (!membersLoaded) return getSavedMemberIds().size;
  return allMembers.reduce((count, member) => {
    const id = getMemberField(member, 'bioguideId', 'bioguide_id');
    return count + (isMemberSaved(id) ? 1 : 0);
  }, 0);
}

function syncSavedMembersUi() {
  document.querySelectorAll('.member-save-button').forEach(syncMemberSaveButton);
  const savedCount = currentRosterSavedCount();
  if (membersSavedCount) {
    membersSavedCount.textContent = String(savedCount);
    membersSavedCount.setAttribute('aria-label', `${savedCount} saved member${savedCount === 1 ? '' : 's'}`);
  }
  if (membersSavedToggle) {
    membersSavedToggle.classList.toggle('is-active', showSavedMembersOnly);
    membersSavedToggle.setAttribute('aria-pressed', showSavedMembersOnly ? 'true' : 'false');
    membersSavedToggle.title = showSavedMembersOnly ? 'Show all members' : 'Show saved members only';
  }
}

function setMemberSaved(bioguideId, shouldSave) {
  const id = normalizeSavedMemberId(bioguideId);
  if (!id) return false;
  const ids = new Set(getSavedMemberIds());
  if (shouldSave) ids.add(id);
  else ids.delete(id);
  savedMemberIdsCache = ids;
  persistSavedMemberIds(ids);
  syncSavedMembersUi();
  return shouldSave;
}

function wireMemberSaveButton(button) {
  if (!button || button.dataset.saveBound) return;
  button.dataset.saveBound = 'true';

  // The tile itself is clickable and hoverable; keep every save interaction
  // isolated from its navigation, keyboard, prefetch, and popover handlers.
  ['pointerdown', 'mousedown', 'touchstart', 'keydown'].forEach(type => {
    button.addEventListener(type, event => event.stopPropagation());
  });
  button.addEventListener('mouseenter', () => hidePopover());
  button.addEventListener('focus', () => hidePopover());
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    hidePopover();
    const id = button.dataset.saveMemberId;
    setMemberSaved(id, !isMemberSaved(id));
    if (showSavedMembersOnly && membersGrid) applyFilters();
  });
}

function setSavedMembersOnly(active) {
  showSavedMembersOnly = !!active;
  syncSavedMembersUi();
  applyFilters();
}

function handleSavedMemberStorage(event) {
  if (event.key !== null && event.key !== SAVED_MEMBERS_STORAGE_KEY) return;
  savedMemberIdsCache = readSavedMemberIds();
  syncSavedMembersUi();
  if (membersGrid && membersLoaded) applyFilters();
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
function showEmpty(options) {
  options = options || {};
  if (options.savedOnly) {
    const hasSavedRosterMembers = Number(options.savedRosterCount || 0) > 0;
    membersGrid.innerHTML = `
      <div class="empty-state saved-members-empty">
        <span class="state-icon" aria-hidden="true">&#9734;</span>
        <p>${hasSavedRosterMembers
          ? 'No saved members match your current search and filters.'
          : 'You have not saved any current members yet. Use the bookmark button on a member card to build your list.'}</p>
        <button class="secondary-button" id="saved-members-empty-action" type="button">
          ${hasSavedRosterMembers ? 'Clear search and filters' : 'Show all members'}
        </button>
      </div>
    `;
    const action = membersGrid.querySelector('#saved-members-empty-action');
    if (action) {
      action.addEventListener('click', () => {
        if (hasSavedRosterMembers) clearMemberSearchFilters();
        else setSavedMembersOnly(false);
      });
    }
    return;
  }

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
    if (!evidenceBackedEthics(enriched.ethics_score)) {
      delete enriched.ethics_score;
    }
    if (!enriched.ethics_score && evidenceBackedEthics(ethicsScores[bioguideId])) {
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
    const res = await fetch('data/officials.json', { cache: 'no-cache' });
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
    syncSavedMembersUi();

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

    populateStateFilter();
    applyFilters();
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
  const partyLower = String(party || '').toLowerCase();
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
  const ethicsData = evidenceBackedEthics(member.ethics_score) ? member.ethics_score : null;
  const ethicsScore = ethicsData ? ethicsData.score : null;
  const ethicsGrade = ethicsData ? ethicsData.grade : 'N/A';
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
  const ethicsTitle = ethicsData ? 'Open evidence-backed funding methodology' : 'Evidence-backed grade unavailable';
  const ethicsBadgeHtml = `<a class="ethics-badge" href="${withApiParam('ethics-methodology.html')}" title="${ethicsTitle}" aria-label="Open funding transparency methodology for ${safeName}" style="background-color: ${ethicsColor};">${esc(ethicsGrade)}</a>`;

  const photoHtml = `
    <div class="tile-photo-wrapper">
      ${photoInner}
      ${savedMemberButtonHtml(bioguideId, name, 'tile')}
      ${partyBadgeHtml}
      ${ethicsBadgeHtml}
    </div>
  `;

  tile.innerHTML = `
    ${photoHtml}
    <div class="tile-name">${safeName}</div>
    ${locationStr ? `<div class="tile-meta">${esc(locationStr)}</div>` : ''}
    ${chamberStr ? `<div class="tile-meta">${esc(chamberStr)}</div>` : ''}
    <button type="button" class="member-compare-button${compareSelection.includes(bioguideId) ? ' is-selected' : ''}"
      data-compare-id="${esc(bioguideId)}" aria-pressed="${compareSelection.includes(bioguideId) ? 'true' : 'false'}"
      title="Select for side-by-side comparison">⚖ Compare</button>
  `;

  const compareBtn = tile.querySelector('.member-compare-button');
  if (compareBtn) {
    compareBtn.addEventListener('click', event => {
      event.stopPropagation();
      compareToggle(bioguideId);
    });
  }

  const ethicsBadge = tile.querySelector('.ethics-badge');
  if (ethicsBadge) {
    ethicsBadge.addEventListener('click', event => {
      event.stopPropagation();
    });
    ethicsBadge.addEventListener('mouseenter', event => {
      event.stopPropagation();
    });
  }

  wireMemberSaveButton(tile.querySelector('.member-save-button'));

  // Popover events: mouseenter/focus show; mouseleave/blur schedule hide.
  // A deliberate hover dwell prefetches only lightweight dossier sections so the detail page
  // paints instantly on click.
  let prefetchTimer = null;
  tile.addEventListener('mouseenter', () => {
    cancelPopoverHide();
    if (bioguideId) {
      triggerPopover(member, tile);
      prefetchTimer = setTimeout(() => prefetchDossier(bioguideId), 700);
    }
  });

  tile.addEventListener('mouseleave', () => {
    schedulePopoverHide();
    clearTimeout(prefetchTimer);
  });

  tile.addEventListener('focus', () => {
    cancelPopoverHide();
    if (bioguideId) {
      triggerPopover(member, tile);
    }
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
    if (event.target === tile && event.key === 'Enter' && bioguideId) goToDetail();
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

    if (evidenceBackedEthics(ethicsScoreData)) {
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

  const verified = evidenceBackedEthics(ethics) ? ethics : null;
  const score = verified ? verified.score : null;
  const grade = verified ? verified.grade : 'N/A';
  badge.textContent = grade;
  badge.style.backgroundColor = getEthicsColor(score);
  badge.title = score === null
    ? 'Campaign-finance grade unavailable. Open methodology.'
    : `Campaign-finance grade ${grade} (${score}). Open methodology.`;
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

    const verified = evidenceBackedEthics(result.data) ? result.data : null;
    ethicsCache.set(bioguideId, verified);
    applyEthicsGrade(tileEl, verified);
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
      if (currentAnchor === tileEl) showPopover(member, null, tileEl);
      return;
    }

    const data = result.data;
    wikiCache.set(bioguideId, data);
    if (currentAnchor === tileEl) showPopover(member, data, tileEl);
  } catch {
    wikiCache.set(bioguideId, null);
    if (currentAnchor === tileEl) showPopover(member, null, tileEl);
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

let mapColorMode = 'lean'; // 'lean' | 'gerry'

function getStateFill(stateInfo) {
  if (mapColorMode === 'gerry') return getGerryFill(stateInfo);
  const lean = String(stateInfo && stateInfo.leanCategory || '').toLowerCase();
  if (lean.includes('democratic')) return '#8fb3e7';
  if (lean.includes('republican')) return '#eaa09a';
  if (lean.includes('competitive')) return '#d7c78f';
  return '#a8c7b1';
}

// Sequential green→amber→red scale for gerrymandering risk (0-100).
function getGerryFill(stateInfo) {
  const score = Number(stateInfo && stateInfo.gerrymanderingIndex && stateInfo.gerrymanderingIndex.score);
  if (!Number.isFinite(score)) return '#d8dee9';
  if (score >= 70) return '#c0392b';
  if (score >= 50) return '#e07b39';
  if (score >= 30) return '#e8c25a';
  if (score >= 15) return '#7fb98a';
  return '#3b8f6d';
}

// Recolor every drawn state when the "color by" mode changes.
function recolorStates() {
  if (!mapSvg || !mapSvg.__ygnMap) return;
  mapSvg.__ygnMap.svg.selectAll('.state-shape')
    .attr('fill', feature => getStateFill(stateDataByFips.get(normalizeFips(feature.id))));
}

function setMapColorMode(mode) {
  mapColorMode = mode === 'gerry' ? 'gerry' : 'lean';
  document.querySelectorAll('.map-colorby-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mapColorMode);
  });
  const legend = document.getElementById('map-legend');
  if (legend) legend.innerHTML = mapLegendHtml();
  recolorStates();
}

function mapLegendHtml() {
  if (mapColorMode === 'gerry') {
    return ['#3b8f6d Minimal', '#7fb98a Lower', '#e8c25a Moderate', '#e07b39 Elevated', '#c0392b High']
      .map(s => { const [c, l] = s.split(' '); return `<span class="map-legend-item"><span class="map-legend-dot" style="background:${c}"></span>${l}</span>`; }).join('');
  }
  return [['#8fb3e7', 'Democratic'], ['#eaa09a', 'Republican'], ['#d7c78f', 'Competitive']]
    .map(([c, l]) => `<span class="map-legend-item"><span class="map-legend-dot" style="background:${c}"></span>${l}</span>`).join('');
}

// Break the composite gerrymandering score into its weighted components so users
// see WHAT drives it (process / partisan skew / district shape), not just a number.
function renderGerryComponents(components) {
  const host = document.getElementById('gerry-components');
  if (!host) return;
  if (!components || typeof components !== 'object') { host.innerHTML = ''; return; }
  const labels = {
    process: 'Redistricting control', partisan_skew: 'Partisan skew', shape: 'District shape',
    voting: 'Seat-vote mismatch', control: 'Redistricting control', events: 'Political events',
    social: 'Social sorting', donations: 'Donation patterns'
  };
  const rows = Object.entries(components)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([k, v]) => {
      const val = clamp(Number(v), 0, 100);
      const color = val >= 70 ? '#c0392b' : val >= 50 ? '#e07b39' : val >= 30 ? '#e8c25a' : '#3b8f6d';
      return `<div class="gerry-comp-row">
        <span class="gerry-comp-label">${esc(labels[k] || k)}</span>
        <span class="gerry-comp-track"><span style="width:${val}%;background:${color}"></span></span>
        <span class="gerry-comp-val">${Math.round(val)}</span>
      </div>`;
    }).join('');
  host.innerHTML = rows;
}

function topGerrymanderComponent(components) {
  if (!components || typeof components !== 'object') return 'mixed signals';
  const entries = Object.entries(components)
    .filter(([, value]) => Number.isFinite(Number(value)))
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  if (entries.length === 0) return 'mixed signals';
  if (Number(entries[0][1]) <= 0) return 'no district-line signal';

  const labels = {
    process: 'redistricting control',
    partisan_skew: 'partisan skew (seat-vote gap)',
    shape: 'district shape',
    // legacy keys (older snapshots)
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
  const gi = stateInfo.gerrymanderingIndex || {};
  const control = gi.inputs && gi.inputs.redistricting_control;
  const signal = topGerrymanderComponent(gi.components);
  gerryNoteEl.textContent = control
    ? `${gi.label || 'Risk'} - ${control}; strongest signal: ${signal}.`
    : `${gi.label || 'Risk'} - strongest signal: ${signal}.`;
  renderGerryComponents(gi.components);
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

  // Delegation party split at a glance before the member rows.
  const split = { D: 0, R: 0, I: 0 };
  members.forEach(m => {
    const p = memberPartyLabel(m);
    if (split[p] !== undefined) split[p] += 1;
  });
  const splitTotal = split.D + split.R + split.I || 1;
  const splitSeg = (n, cls) => n > 0
    ? `<span class="delegation-seg ${cls}" style="width:${(n / splitTotal) * 100}%">${n}</span>` : '';
  const splitHtml = `
    <div class="delegation-split" aria-label="Delegation party split">
      <div class="delegation-bar">${splitSeg(split.D, 'party-d')}${splitSeg(split.I, 'party-i')}${splitSeg(split.R, 'party-r')}</div>
      <span class="delegation-nums">${split.D}D · ${split.R}R${split.I ? ` · ${split.I}I` : ''} in this delegation</span>
    </div>`;

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
  rows.unshift(splitHtml);

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

// Load the map libraries on demand. index.html omits the d3/topojson script
// tags (they're ~290KB), so inject them the first time the map is needed.
function ensureMapLibs(callback) {
  if (window.d3 && window.topojson) { callback(); return; }
  let loaded = 0;
  const done = () => { if (++loaded === 2 && window.d3 && window.topojson) callback(); };
  const add = (src) => {
    let el = document.querySelector(`script[src="${src}"]`);
    if (el) { el.addEventListener('load', done); if (el.dataset.loaded) done(); return; }
    el = document.createElement('script');
    el.src = src;
    el.addEventListener('load', () => { el.dataset.loaded = '1'; done(); });
    document.head.appendChild(el);
  };
  add('vendor/d3.min.js');
  add('vendor/topojson-client.min.js');
}

function initMapWhenReady() {
  // Dedicated map page loads the libs eagerly — start immediately.
  if (window.d3 && window.topojson) { initMap(); return; }
  // Home page: defer until the map scrolls near the viewport.
  const target = document.getElementById('district-map') || mapSvg;
  if (!('IntersectionObserver' in window) || !target) {
    ensureMapLibs(initMap);
    return;
  }
  const observer = new IntersectionObserver((entries, obs) => {
    if (entries.some(e => e.isIntersecting)) {
      obs.disconnect();
      ensureMapLibs(initMap);
    }
  }, { rootMargin: '300px' });
  observer.observe(target);
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

  // Gaussian smoothing filter: a small blur softens the jagged boundary lines of
  // the topojson state shapes, then a contrast pass keeps them crisp so the map
  // reads as smooth outlines rather than a fuzzy image.
  const defs = svg.append('defs');
  const smooth = defs.append('filter')
    .attr('id', 'ygn-map-smooth')
    .attr('x', '-5%').attr('y', '-5%')
    .attr('width', '110%').attr('height', '110%')
    .attr('color-interpolation-filters', 'sRGB');
  smooth.append('feGaussianBlur')
    .attr('in', 'SourceGraphic')
    .attr('stdDeviation', 0.6)
    .attr('result', 'blur');
  // Re-sharpen the alpha edge so fills stay solid while corners are rounded off.
  const transfer = smooth.append('feComponentTransfer').attr('in', 'blur');
  transfer.append('feFuncA')
    .attr('type', 'linear')
    .attr('slope', 1.6)
    .attr('intercept', -0.3);

  const root = svg.append('g').attr('class', 'map-root');
  const stateLayer = root.append('g')
    .attr('class', 'state-layer')
    .attr('filter', 'url(#ygn-map-smooth)');
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
      showMapTooltip(`<strong>${esc(stateInfo.name)}</strong><span>${esc(stateInfo.historicalLean)}</span>`, event);
    })
    .on('mousemove', (event, feature) => {
      const stateInfo = stateDataByFips.get(normalizeFips(feature.id));
      if (!stateInfo) return;
      showMapTooltip(`<strong>${esc(stateInfo.name)}</strong><span>${esc(stateInfo.historicalLean)}</span>`, event);
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
function memberPartyCode(member) {
  const p = getMemberField(member, 'party', 'partyName').toLowerCase();
  if (p.includes('democrat')) return 'D';
  if (p.includes('republican')) return 'R';
  return 'I';
}

function memberDim1(member) {
  const n = member.nominate_score || member.nominateScore;
  return n && typeof n.dim1 === 'number' ? n.dim1 : null;
}

function memberEthicsScore(member) {
  const e = member.ethics_score || member.ethicsScore;
  return evidenceBackedEthics(e) ? e.score : null;
}

function memberFirstYear(member) {
  const terms = (member.terms && (member.terms.item || member.terms)) || [];
  const years = (Array.isArray(terms) ? terms : [terms])
    .map(t => parseInt(t && t.startYear, 10))
    .filter(y => Number.isFinite(y));
  return years.length ? Math.min(...years) : null;
}

function sortMembers(list, sortBy) {
  const arr = list.slice();
  if (sortBy === 'ideology' || sortBy === 'ethics') {
    const value = sortBy === 'ideology' ? memberDim1 : memberEthicsScore;
    // ethics: high score first (desc); ideology: liberal (low) first (asc). Unknowns last.
    const dir = sortBy === 'ethics' ? -1 : 1;
    arr.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * dir;
    });
  } else if (sortBy === 'seniority') {
    // Longest-serving first (earliest first year). Unknowns last.
    arr.sort((a, b) => {
      const va = memberFirstYear(a);
      const vb = memberFirstYear(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return va - vb;
    });
  }
  // 'name' keeps allMembers' existing alphabetical order.
  return arr;
}

// Populate the State filter <select> from the loaded roster (distinct states).
function populateStateFilter() {
  if (!membersStateFilter || membersStateFilter.dataset.filled) return;
  const states = Array.from(new Set(
    allMembers.map(m => getMemberField(m, 'state')).filter(Boolean)
  )).sort();
  const frag = document.createDocumentFragment();
  states.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    frag.appendChild(opt);
  });
  membersStateFilter.appendChild(frag);
  membersStateFilter.dataset.filled = '1';
}

function clearMemberSearchFilters() {
  if (membersSearch) membersSearch.value = '';
  if (membersPartyFilter) membersPartyFilter.value = '';
  if (membersChamberFilter) membersChamberFilter.value = '';
  if (membersStateFilter) membersStateFilter.value = '';
  applyFilters();
}

function applyFilters() {
  if (!membersGrid) return;
  const query = (membersSearch ? membersSearch.value : '').trim().toLowerCase();
  const partyFilter = membersPartyFilter ? membersPartyFilter.value : '';
  const chamberFilter = membersChamberFilter ? membersChamberFilter.value : '';
  const stateFilter = membersStateFilter ? membersStateFilter.value : '';
  const sortBy = membersSort ? membersSort.value : 'name';
  const savedRosterCount = showSavedMembersOnly ? currentRosterSavedCount() : 0;

  let list = allMembers.filter(member => {
    const memberId = getMemberField(member, 'bioguideId', 'bioguide_id');
    if (showSavedMembersOnly && !isMemberSaved(memberId)) return false;
    if (partyFilter && memberPartyCode(member) !== partyFilter) return false;
    if (chamberFilter && !getMemberChamber(member).toLowerCase().includes(chamberFilter)) return false;
    if (stateFilter && getMemberField(member, 'state') !== stateFilter) return false;
    if (query) {
      const name = getMemberField(member, 'name', 'directOrderName', 'invertedOrderName').toLowerCase();
      const state = getMemberField(member, 'state').toLowerCase();
      const party = getMemberField(member, 'party', 'partyName').toLowerCase();
      const chamber = getMemberChamber(member).toLowerCase();
      const district = formatDistrictLabel(member).toLowerCase();
      const matched =
        name.includes(query) ||
        state.includes(query) ||
        stateSearchMatches(member, query) ||
        party.includes(query) ||
        chamber.includes(query) ||
        district.includes(query);
      if (!matched) return false;
    }
    return true;
  });

  list = sortMembers(list, sortBy);
  updateMembersCount(list.length, savedRosterCount);
  renderIdeologyStrip(list);

  if (list.length === 0) {
    showEmpty({ savedOnly: showSavedMembersOnly, savedRosterCount });
  } else {
    renderGrid(list);
  }
}

function updateMembersCount(shown, savedRosterCount) {
  if (!membersCount) return;
  if (showSavedMembersOnly) {
    const savedTotal = Number(savedRosterCount || 0);
    membersCount.textContent = shown === savedTotal
      ? `${savedTotal} saved member${savedTotal === 1 ? '' : 's'}`
      : `${shown} of ${savedTotal} saved members`;
    return;
  }
  const total = allMembers.length;
  membersCount.textContent = shown === total
    ? `${total} members`
    : `${shown} of ${total} members`;
}

// Back-compat alias: the search input listener calls handleSearch.
function handleSearch() {
  applyFilters();
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

const DOSSIER_FAST_SECTIONS = 'wiki,overview,nominate,history,committees,contact,legislation,stocks';
const DOSSIER_SLOW_SECTIONS = 'ethics,funding';
const DOSSIER_PREFETCH_SECTIONS = 'wiki,nominate,history,committees,contact';

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

// Warm a member's dossier on hover/focus so clicking into them is instant.
// Only the fast (non-FEC) sections are prefetched, so this never adds load to
// the rate-limited FEC key; funding/ethics still load on the detail page itself.
const _prefetchedMembers = new Set();
function prefetchDossier(bioguideId) {
  if (!bioguideId || _prefetchedMembers.has(bioguideId)) return;
  if (sessionGet('ygn_dossier_' + bioguideId) || sessionGet('ygn_fast_' + bioguideId)) {
    _prefetchedMembers.add(bioguideId);
    return;
  }
  _prefetchedMembers.add(bioguideId);
  fetchJsonWithStaticFallback(
    `/officials/${bioguideId}/dossier?sections=${DOSSIER_PREFETCH_SECTIONS}`,
    `dossier/${bioguideId}.json`
  )
    .then(res => {
      if (res && res.data && !res.notFound) {
        sessionSet('ygn_fast_' + bioguideId, res.data);
      }
    })
    .catch(() => { _prefetchedMembers.delete(bioguideId); });
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
    return `<span class="grade-badge" id="hero-grade" style="--grade-color:#cbd5e1" title="Loading campaign-finance grade">…<span>Funding</span></span>`;
  }
  const verified = evidenceBackedEthics(ethics) ? ethics : null;
  const grade = verified ? verified.grade : 'N/A';
  const score = verified ? verified.score : null;
  const title = verified
    ? 'Evidence-backed campaign-finance transparency grade — click for methodology'
    : 'No current evidence-backed grade is available';
  return `<a class="grade-badge" id="hero-grade" href="${withApiParam('ethics-methodology.html')}" style="--grade-color:${getEthicsColor(score)}" title="${title}">${esc(grade)}<span>Funding</span></a>`;
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
  const photoInner = hero.photoUrl && /^https?:\/\//i.test(hero.photoUrl)
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
        ${savedMemberButtonHtml(hero.id, hero.name, 'detail')}
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

function aboutHtml(wiki, overviewPayload) {
  // The committed AI overview (member-ai snapshot / refresh cache) leads the
  // About card; the Wikipedia extract follows. Either alone still renders the
  // card; both absent renders nothing (no empty box).
  const overview = overviewPayload && overviewPayload.overview && overviewPayload.overview.summary;
  if (!wiki && !overview) return '';
  const overviewHtml = overview
    ? `<div class="member-overview">
         <div class="bill-ai-label">At a glance <span class="ai-badge">AI</span></div>
         <p>${esc(overview)}</p>
       </div>` : '';
  if (!wiki) {
    return `<section class="dossier-card" id="about">
      <h3><span><span class="card-icon">📖</span>About</span></h3>
      ${overviewHtml}
    </section>`;
  }
  const thumbnailUrl = typeof wiki.thumbnail === 'string'
    ? wiki.thumbnail
    : (wiki.thumbnail && wiki.thumbnail.source);
  const thumb = thumbnailUrl && /^https?:\/\//i.test(thumbnailUrl)
    ? `<img class="wiki-thumb" src="${esc(thumbnailUrl)}" alt="" loading="lazy">` : '';
  const note = wiki.source === 'congress_fallback'
    ? `<p class="muted-text" style="margin-top:.75rem;clear:both;">Generated summary — no Wikipedia article resolved.</p>` : '';
  const text = esc(wiki.extract || wiki.summary || 'No biography available.');
  const more = wiki.wiki_url
    ? `<a class="wiki-more" href="${esc(safeUrl(wiki.wiki_url))}" target="_blank" rel="noopener">Read more on Wikipedia →</a>` : '';
  return `<section class="dossier-card" id="about">
    <h3><span><span class="card-icon">📖</span>About</span></h3>
    ${overviewHtml}
    ${thumb}<div class="wiki-body">${text}</div>${more}${note}
  </section>`;
}

function chamberLabel(chamber) {
  const c = String(chamber || '').toLowerCase();
  if (c.includes('senate')) return 'U.S. Senate';
  if (c.includes('house') || c.includes('representative')) return 'U.S. House';
  return chamber || 'Congress';
}

// Collapse a member's per-Congress terms into compact tenure blocks so that a
// 30-year veteran doesn't bury the rest of the page under 18 rows.
function summarizeTenure(terms) {
  const groups = [];
  terms.forEach(t => {
    const chamber = chamberLabel(t.chamber);
    const state = t.state || '';
    const last = groups[groups.length - 1];
    if (last && last.chamber === chamber && last.state === state) {
      last.endYear = t.endYear || 'present';
      last.count += 1;
    } else {
      groups.push({ chamber, state, startYear: t.startYear || '?', endYear: t.endYear || 'present', count: 1 });
    }
  });
  return groups.reverse(); // most recent first
}

function careerHtml(history) {
  if (!history) return '';
  const chrono = Array.isArray(history.terms) ? history.terms : [];
  const termCount = history.termCount || chrono.length;

  const tenureHtml = summarizeTenure(chrono).map(g => `
    <li class="tenure-item">
      <strong>${esc(g.chamber)}</strong>
      <span>${g.state ? `${esc(g.state)} · ` : ''}${esc(g.startYear)}–${esc(g.endYear)} · ${g.count} term${g.count === 1 ? '' : 's'}</span>
    </li>`).join('');

  const timeline = chrono.slice().reverse().map(t => `
    <li class="timeline-item">
      <strong>${esc(t.congress)}th Congress · ${esc(t.startYear || '?')}–${esc(t.endYear || 'present')}</strong>
      <span>${esc(t.chamber || '')}${t.state ? ` · ${esc(t.state)}` : ''}${t.district ? ` · District ${esc(t.district)}` : ''}${t.party ? ` · ${esc(t.party)}` : ''}</span>
    </li>`).join('');

  const age = computeAge(history.birthday);
  const born = history.birthday
    ? `${esc(history.birthday)}${age ? ` (age ${age})` : ''}`
    : (history.birthYear ? esc(history.birthYear) : '—');

  // Next election: a senator's current term runs to its endYear (elections are
  // held the November before the term expires); a House seat is up at every
  // federal general election. Former members (last term already ended) get none.
  const current = chrono[chrono.length - 1] || {};
  const isSenate = String(current.chamber || '').toLowerCase().includes('senate');
  const nowYear = new Date().getFullYear();
  const lastEnd = parseInt(current.endYear, 10);
  const stillServing = !Number.isFinite(lastEnd) || lastEnd >= nowYear;
  let nextElection = null;
  if (chrono.length && stillServing) {
    if (isSenate) {
      // Current terms often have endYear=null; a Senate term is 6 years.
      const end = Number.isFinite(lastEnd) ? lastEnd : parseInt(current.startYear, 10) + 6;
      if (Number.isFinite(end)) nextElection = end % 2 === 0 ? end : end - 1;
    } else {
      const election = nextFederalElectionDate();
      if (election) nextElection = election.getFullYear();
    }
    if (nextElection && nextElection < nowYear) nextElection = null;
  }

  return `<section class="dossier-card" id="career">
    <h3><span><span class="card-icon">🏛️</span>Career History</span></h3>
    <div class="funding-totals" style="margin-bottom:1.25rem;">
      <div class="funding-stat"><span class="funding-stat-label">First elected</span><span class="funding-stat-value">${esc(history.firstElectedYear || '—')}</span></div>
      <div class="funding-stat"><span class="funding-stat-label">Years served</span><span class="funding-stat-value">${esc(history.yearsOfService || '—')}</span></div>
      <div class="funding-stat"><span class="funding-stat-label">Terms</span><span class="funding-stat-value">${esc(termCount)}</span></div>
      <div class="funding-stat"><span class="funding-stat-label">Next election</span><span class="funding-stat-value">${nextElection ? esc(nextElection) : '—'}</span></div>
      <div class="funding-stat"><span class="funding-stat-label">Born</span><span class="funding-stat-value" style="font-size:1rem;">${born}</span></div>
    </div>
    ${tenureHtml ? `<ul class="tenure-list">${tenureHtml}</ul>` : ''}
    ${timeline ? `<details class="timeline-details"><summary>Show all ${esc(termCount)} terms by Congress</summary><ul class="timeline">${timeline}</ul></details>` : ''}
  </section>`;
}

const FUNDING_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

function fundingInnerHtml(funding, pending) {
  if (pending) {
    return `<h3><span><span class="card-icon">💵</span>Campaign Funding</span></h3>
      <div class="card-loading"><span class="card-spinner"></span>Loading campaign finance…</div>`;
  }
  let gradeChip = '';
  if (funding && evidenceBackedEthics(funding.grade)) {
    gradeChip = `<span class="grade-badge" style="--grade-color:${getEthicsColor(funding.grade.score)};min-width:auto;padding:.25rem .6rem;font-size:1rem;flex-direction:row;gap:.35rem;">${esc(funding.grade.grade)}<span>Grade</span></span>`;
  }
  const gradeExplainer = gradeExplainerHtml(funding && funding.grade);
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
  return `<h3><span><span class="card-icon">💵</span>Campaign Funding</span>${gradeChip}</h3>${gradeExplainer}${body}`;
}

// Explain the ethics/funding grade: campaign-finance base minus a stock-trading
// conflict deduction (from House PTR filings), so the letter grade isn't a black box.
function gradeExplainerHtml(grade) {
  if (!grade || grade.grade == null) return '';
  const sc = grade.components && grade.components.stock_conflict;
  const finance = Number.isFinite(Number(grade.financeScore)) ? Number(grade.financeScore) : null;
  const penalty = Number(grade.stockPenalty) || 0;
  if (finance === null && !(sc && sc.measurable)) return '';
  const ptr = grade.stockPtrCount != null ? grade.stockPtrCount : (sc && sc.ptr_filings);
  const rows = [];
  if (finance !== null) rows.push(`<span>Campaign-finance score</span><strong>${finance.toFixed(0)}/100</strong>`);
  if (penalty > 0) rows.push(`<span>Stock-trading deduction<br><small>${ptr} PTR disclosure filing${ptr === 1 ? '' : 's'} in ~2&nbsp;yrs</small></span><strong class="grade-deduction">−${penalty}</strong>`);
  else if (sc && sc.measurable) rows.push(`<span>Stock-trading conflict</span><strong>None disclosed</strong>`);
  if (Number.isFinite(Number(grade.score))) rows.push(`<span>Final grade score</span><strong>${Number(grade.score).toFixed(0)}/100 (${esc(grade.grade)})</strong>`);
  if (!rows.length) return '';
  return `<div class="grade-explainer">${rows.map(r => `<div class="grade-explainer-row">${r}</div>`).join('')}</div>`;
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
      ? `<a href="${esc(safeUrl(c.committeeUrl))}" target="_blank" rel="noopener">${esc(c.committee)}</a>`
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
  return `<ul class="dossier-list bill-list">${bills.map(b => {
    const label = `${esc(b.type)}${esc(b.number)}`;
    const link = `<a href="${esc(safeUrl(b.url))}" target="_blank" rel="noopener">${label}</a>`;
    // Amendments carry no title/action — render them as a compact single line so
    // they don't bury the actual bills.
    if (b.isAmendment) {
      return `<li class="dossier-list-item bill-item bill-item--amendment">
        <div class="dossier-list-item-title">${link} <span class="badge">Amendment</span></div>
        <div class="dossier-list-item-meta">${esc(b.introducedDate || '')}</div>
      </li>`;
    }
    return `<li class="dossier-list-item bill-item">
      <div class="dossier-list-item-title">${link}${b.becameLaw ? ' <span class="badge badge--enacted">Enacted</span>' : ''}</div>
      <div class="bill-title-text">${esc(b.title)}</div>
      <div class="dossier-list-item-meta">${esc(b.introducedDate || '')}${b.policyArea ? ` · ${esc(b.policyArea)}` : ''}${b.latestAction ? `<br>Latest: ${esc(b.latestAction)}` : ''}</div>
    </li>`;
  }).join('')}</ul>`;
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

function confidenceSectionHtml(id) {
  if (!id) return '';
  return `<section class="dossier-card" id="confidence">
    <h2 class="dossier-card-title">Public Polling</h2>
    <p class="dossier-card-note">No sourced approval or favorability poll is available here. YGN does not substitute an AI-generated percentage for a poll with a named pollster, field dates, sample, and published methodology.</p>
  </section>`;
}

function renderDossier(container, data, opts) {
  opts = opts || {};
  const hero = normalizeHero(data, opts.handoff, opts.id);
  container.innerHTML = `
    <div class="dossier">
      ${heroHtml(hero)}
      ${statRowHtml(data)}
      ${sectionNavHtml(data)}
      <div class="dossier-grid">
        ${aboutHtml(data && data.wiki, data && data.overview)}
        ${careerHtml(data && data.history)}
        ${fundingSectionHtml(data && data.funding, !!opts.fundingPending)}
        ${stocksHtml(data && data.stocks)}
        ${committeesHtml(data && data.committees)}
        ${contactHtml(data && data.contact)}
        ${confidenceSectionHtml(opts.id)}
        ${legislationHtml(data && data.legislation)}
      </div>
    </div>`;
  attachDossierInteractions(container);
  injectMemberExtras(container, opts.id, data);
}

// Post-render, data-dependent dossier extras. Sections are appended ONLY when
// their data resolves, so a miss never leaves an empty card in the grid.
async function injectMemberExtras(container, bioguideId, data) {
  if (!bioguideId) return;
  const grid = container.querySelector('.dossier-grid');
  if (!grid) return;

  // Committed AI overview fallback: if the dossier payload lacked it (static
  // mode or older cache), read the per-member snapshot directly.
  if (!(data && data.overview && data.overview.overview) && !grid.querySelector('.member-overview')) {
    try {
      const res = await fetch(`data/member-ai/${encodeURIComponent(bioguideId)}.json`, { cache: 'default' });
      if (res.ok) {
        const snap = await res.json();
        const summary = snap && snap.overview && snap.overview.summary;
        const about = grid.querySelector('#about');
        if (summary && about && !grid.querySelector('.member-overview')) {
          const block = document.createElement('div');
          block.className = 'member-overview';
          block.innerHTML = `<div class="bill-ai-label">At a glance <span class="ai-badge">AI</span></div><p>${esc(summary)}</p>`;
          const heading = about.querySelector('h3');
          if (heading) heading.insertAdjacentElement('afterend', block);
        }
      }
    } catch (_) { /* snapshot absent — nothing to show */ }
  }

  renderIdeologyNeighbors(grid, bioguideId);
}

// Ideological neighbors: the 3 same-chamber members closest on DW-NOMINATE
// dim1. Pure client-side math over committed snapshots.
async function renderIdeologyNeighbors(grid, bioguideId) {
  try {
    const [scores] = await Promise.all([loadMemberScoreIndex(), loadMemberDataOnly()]);
    const nominate = (scores && scores.nominate) || {};
    const me = nominate[bioguideId];
    if (!me || !Number.isFinite(Number(me.dim1)) || !allMembers.length) return;

    const my = allMembers.find(m => getMemberField(m, 'bioguideId', 'bioguide_id') === bioguideId);
    const myChamber = my ? getMemberChamber(my).toLowerCase() : '';
    const candidates = [];
    allMembers.forEach(m => {
      const id = getMemberField(m, 'bioguideId', 'bioguide_id');
      if (!id || id === bioguideId) return;
      if (myChamber && !getMemberChamber(m).toLowerCase().includes(myChamber.includes('senate') ? 'senate' : 'house')) return;
      const score = nominate[id];
      if (!score || !Number.isFinite(Number(score.dim1))) return;
      candidates.push({ member: m, id, dist: Math.abs(Number(score.dim1) - Number(me.dim1)), dim1: Number(score.dim1) });
    });
    if (candidates.length < 3) return;
    candidates.sort((a, b) => a.dist - b.dist);
    const nearest = candidates.slice(0, 3);

    const rows = nearest.map(n => {
      const name = esc(formatMemberDisplayName(n.member) || 'Unknown');
      const party = esc(memberPartyLabel(n.member));
      const state = esc(getMemberField(n.member, 'state'));
      const href = withApiParam(`member.html?id=${encodeURIComponent(n.id)}`);
      return `<a class="neighbor-row" href="${href}">
        <span class="neighbor-name">${name}</span>
        <span class="neighbor-meta">${party}${state ? ` · ${state}` : ''} · scores ${n.dim1.toFixed(2)}</span>
      </a>`;
    }).join('');

    const section = document.createElement('section');
    section.className = 'dossier-card';
    section.id = 'neighbors';
    section.innerHTML = `
      <h3><span><span class="card-icon">🧭</span>Ideological Neighbors</span></h3>
      <p class="dossier-card-note">Closest current ${myChamber.includes('senate') ? 'senators' : 'House members'} on the DW-NOMINATE ideology scale (−1 left … +1 right). This member scores ${Number(me.dim1).toFixed(2)}.</p>
      <div class="neighbor-list">${rows}</div>`;
    const legislation = grid.querySelector('#legislation');
    if (legislation) grid.insertBefore(section, legislation);
    else grid.appendChild(section);
  } catch (_) { /* neighbors are enrichment only */ }
}

function attachDossierInteractions(container) {
  wireMemberSaveButton(container.querySelector('.member-save-button--detail'));

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

  // Instant identity from the tile the user clicked; and if we prefetched this
  // member's fast sections on hover, paint them immediately (no network wait).
  const handoff = sessionGet('ygn_handoff_' + id);
  const prefetchedFast = sessionGet('ygn_fast_' + id);
  renderDossier(container, prefetchedFast || null, {
    id,
    handoff,
    fundingPending: !prefetchedFast || prefetchedFast.funding === undefined,
  });

  // Reuse the hover prefetch when present; otherwise fetch the fast sections now.
  const fastPromise = prefetchedFast
    ? Promise.resolve({ data: prefetchedFast, source: 'prefetch' })
    : fetchJsonWithStaticFallback(`/officials/${id}/dossier?sections=${DOSSIER_FAST_SECTIONS}`, `dossier/${id}.json`);
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

// ═══ Civic data features ══════════════════════════════════════════════════════
// All of these read COMMITTED snapshots (docs/data/civic/*.json) written by the
// scheduled build — no upstream or model calls at request time. Sections hide
// themselves when their snapshot is missing.

async function fetchCivic(name) {
  try {
    const res = await fetch(`data/civic/${name}`, { cache: 'default' });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}
