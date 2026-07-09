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
    const annualChange = Number.isFinite(previousValue) ? latestValue - previousValue : 1_600_000;
    const baselineYear = Number(latest.date) + 1;
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

async function refreshHomeMetrics() {
  if (!homeStats) return;
  loadDebtMetric();
  loadPopulationMetric();
  loadFederalRegisterMetric();
  loadAgencyMetric();
  loadMemberDataOnly().catch(() => {
    updateStatCard('stat-members', 'Members Tracked', '-', 'Static data unavailable');
  });
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
  link.href = href;
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
async function loadMemberDataOnly() {
  if (membersLoaded) return allMembers;
  if (memberDataLoadPromise) return memberDataLoadPromise;

  memberDataLoadPromise = (async () => {
    const [result, scoreIndex] = await Promise.all([
      fetchJsonWithStaticFallback('/officials?limit=250&offset=0', 'officials.json'),
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

  // Photo or initials
  let photoInner = '';
  if (photoUrl) {
    photoInner = `
      <img
        class="tile-photo"
        src="${photoUrl}"
        alt="${name}"
        loading="lazy"
        decoding="async"
        onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
      >
      <div class="tile-initials" style="display:none;" aria-hidden="true">${initials}</div>
    `;
  } else {
    photoInner = `<div class="tile-initials" aria-hidden="true">${initials}</div>`;
  }

  const partyBadgeHtml = `<div class="party-badge ${partyClass}">${partyLabel}</div>`;
  const ethicsBadgeHtml = `<a class="ethics-badge" href="${withApiParam('ethics-methodology.html')}" title="Open ethics score methodology" aria-label="Open ethics score methodology for ${name}" style="background-color: ${ethicsColor};">${ethicsGrade}</a>`;

  const photoHtml = `
    <div class="tile-photo-wrapper">
      ${photoInner}
      ${partyBadgeHtml}
      ${ethicsBadgeHtml}
    </div>
  `;

  tile.innerHTML = `
    ${photoHtml}
    <div class="tile-name">${name}</div>
    ${locationStr ? `<div class="tile-meta">${locationStr}</div>` : ''}
    ${chamberStr ? `<div class="tile-meta">${chamberStr}</div>` : ''}
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

  tile.addEventListener('click', () => {
    if (bioguideId) window.location.href = withApiParam('member.html?id=' + bioguideId);
  });

  tile.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && bioguideId) {
      window.location.href = withApiParam('member.html?id=' + bioguideId);
    }
  });

  if (bioguideId) {
    const nominateScore = member.nominate_score || member.nominateScore || null;
    const ethicsScoreData = member.ethics_score || member.ethicsScore || null;

    if (nominateScore && typeof nominateScore.dim1 === 'number') {
      nominateCache.set(bioguideId, { dim1: nominateScore.dim1 });
      applyNominateTint(tile, nominateScore.dim1);
    }

    if (ethicsScoreData && typeof ethicsScoreData.score === 'number') {
      ethicsCache.set(bioguideId, ethicsScoreData);
      applyEthicsGrade(tile, ethicsScoreData);
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

  const response = await fetch('data/states.json', { cache: 'no-store' });
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
    const name = formatMemberDisplayName(member) || 'Unknown member';
    const label = formatDistrictLabel(member) || getMemberChamber(member) || stateInfo.abbreviation;
    const party = memberPartyLabel(member);
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
    loadMemberDataOnly()
      .then(() => {
        if (selectedMapState) renderMemberListForState(selectedMapState);
      })
      .catch(() => {});

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
  return { districtLabel, memberName, party };
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

window.switchLegislationTab = function(tabId) {
  document.querySelectorAll('.dossier-tab').forEach(t => t.setAttribute('aria-selected', 'false'));
  document.querySelectorAll('.dossier-tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`[data-tab="${tabId}"]`).setAttribute('aria-selected', 'true');
  document.getElementById(`tab-${tabId}`).classList.add('active');
};

function renderDossierUI(container, dossier) {
  if (!dossier || !dossier.member) {
    container.innerHTML = '<div class="error-state"><p>Dossier data is incomplete.</p></div>';
    return;
  }

  const { member, bioguideId, wiki, history, funding, stocks, legislation, committees, contact, nominate, ethics } = dossier;

  const name = formatMemberDisplayName(member) || 'Unknown Member';
  const party = getMemberField(member, 'party', 'partyName') || '';
  const state = getMemberField(member, 'state') || '';
  const chamber = getMemberChamber(member) || '';
  const districtLabel = formatDistrictLabel(member) || '';
  
  const initials = buildInitials(name);
  const photoUrl = getMemberPhotoUrl(member, bioguideId);
  const dim1 = nominate?.dim1 ?? null;
  const ethicsScore = ethics?.score ?? null;
  const ethicsGrade = ethics?.grade ?? 'N/A';

  let photoInner = photoUrl
    ? `<img class="dossier-photo" src="${photoUrl}" alt="${name}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"><div class="dossier-initials" style="display:none;" aria-hidden="true">${initials}</div>`
    : `<div class="dossier-initials" aria-hidden="true">${initials}</div>`;

  // 1. Identity
  const identityHtml = `
    <div class="dossier-header" id="dossier-identity">
      <div class="dossier-photo-wrapper">
        ${photoInner}
      </div>
      <div class="dossier-info">
        <h1 class="dossier-name">${name}</h1>
        <div class="dossier-chips">
          ${party ? `<span class="dossier-chip">${party}</span>` : ''}
          ${state ? `<span class="dossier-chip">${state}</span>` : ''}
          ${chamber ? `<span class="dossier-chip">${chamber}</span>` : ''}
          ${districtLabel && !chamber.toLowerCase().includes('senate') ? `<span class="dossier-chip">${districtLabel}</span>` : ''}
        </div>
        <div style="display: flex; gap: 1rem; margin-top: 0.5rem;">
          <a class="ethics-badge" href="${withApiParam('ethics-methodology.html')}" style="background-color: ${getEthicsColor(ethicsScore)}; padding: 0.25rem 0.5rem; border-radius: 4px; color: white; text-decoration: none; font-weight: 700; font-size: 0.875rem;">Ethics Grade: ${ethicsGrade}</a>
        </div>
      </div>
    </div>
  `;

  // 2. About
  let aboutHtml = '';
  if (wiki) {
    let thumbHtml = (wiki.thumbnail && wiki.thumbnail.source) 
      ? `<img src="${wiki.thumbnail.source}" alt="${name}" style="float: right; margin-left: 1rem; margin-bottom: 0.5rem; max-width: 100px; border-radius: 4px; object-fit: cover;">` 
      : '';
    let fallbackNote = wiki.source === "congress_fallback" ? '<p class="muted-text" style="margin-top: 1rem; clear: both;">Note: This biography is a generated summary (no Wikipedia page resolved).</p>' : '';
    aboutHtml = `
      <div class="dossier-card" style="overflow: hidden;">
        <h3>About</h3>
        ${thumbHtml}
        <p>${wiki.extract || wiki.summary || 'No biography available.'}</p>
        ${wiki.wiki_url ? `<div style="clear: both; padding-top: 0.5rem;"><a href="${wiki.wiki_url}" target="_blank" rel="noopener" style="color: var(--color-accent); font-weight: 600;">Read more on Wikipedia</a></div>` : ''}
        ${fallbackNote}
      </div>
    `;
  }

  // 3. Career
  let careerHtml = '';
  if (history) {
    const terms = Array.isArray(history.terms) ? history.terms : [];
    const timelineHtml = terms.map(t => `
      <li class="timeline-item">
        <strong>${t.congress}th Congress (${t.startYear || '?'} - ${t.endYear || 'Present'})</strong>
        <span>${t.chamber}, ${t.state} ${t.district ? `District ${t.district}` : ''} ${t.party ? `(${t.party})` : ''}</span>
      </li>
    `).join('');

    careerHtml = `
      <div class="dossier-card">
        <h3>Career History</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
          <div><span class="muted-text">First Elected:</span><br><strong>${history.firstElectedYear || '-'}</strong></div>
          <div><span class="muted-text">Years Served:</span><br><strong>${history.yearsOfService || '-'}</strong></div>
          <div><span class="muted-text">Terms:</span><br><strong>${history.termCount || '-'}</strong></div>
          <div><span class="muted-text">Born:</span><br><strong>${history.birthYear || '-'}</strong></div>
        </div>
        ${timelineHtml ? `<ul class="timeline">${timelineHtml}</ul>` : ''}
      </div>
    `;
  }

  // 4. Funding
  let fundingHtml = '';
  if (funding) {
    if (funding.available && funding.totals) {
      const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
      const breakdown = Array.isArray(funding.breakdown) ? funding.breakdown : [];
      let barSegments = '';
      let legendItems = '';
      
      breakdown.forEach((item, i) => {
        const share = item.share || 0;
        if (share > 0) {
          barSegments += `<div class="funding-bar-segment" style="width: ${share * 100}%; background-color: ${colors[i % colors.length]};" title="${item.label}: ${(share * 100).toFixed(1)}%"></div>`;
        }
        legendItems += `
          <div class="funding-legend-item">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <div class="funding-legend-color" style="background-color: ${colors[i % colors.length]};"></div>
              <span>${item.label}</span>
            </div>
            <strong>${formatCurrencyCompact(item.amount)} (${(share * 100).toFixed(1)}%)</strong>
          </div>
        `;
      });

      let fundingGradeHtml = '';
      if (funding.grade && funding.grade.grade) {
        fundingGradeHtml = `<span style="background-color: ${getEthicsColor(funding.grade.score)}; padding: 0.2rem 0.5rem; border-radius: 4px; color: white; font-weight: bold; font-size: 0.8rem; vertical-align: middle; margin-left: 0.5rem;">Ethics Grade: ${funding.grade.grade}</span>`;
      }

      fundingHtml = `
        <div class="dossier-card">
          <h3 style="display: flex; align-items: center; justify-content: space-between;">
            Campaign Funding
            ${fundingGradeHtml}
          </h3>
          <div class="funding-totals">
            <div class="funding-stat">
              <span class="funding-stat-label">Receipts</span>
              <span class="funding-stat-value">${formatCurrencyCompact(funding.totals.receipts)}</span>
            </div>
            <div class="funding-stat">
              <span class="funding-stat-label">Disbursements</span>
              <span class="funding-stat-value">${formatCurrencyCompact(funding.totals.disbursements)}</span>
            </div>
            <div class="funding-stat">
              <span class="funding-stat-label">Cash on Hand</span>
              <span class="funding-stat-value">${formatCurrencyCompact(funding.totals.cashOnHand)}</span>
            </div>
            <div class="funding-stat">
              <span class="funding-stat-label">Debts</span>
              <span class="funding-stat-value">${formatCurrencyCompact(funding.totals.debts)}</span>
            </div>
          </div>
          ${breakdown.length ? `
            <div style="margin-bottom: 0.5rem; font-weight: 600;">Receipts Breakdown</div>
            <div class="funding-bar-container">${barSegments}</div>
            <div class="funding-legend">${legendItems}</div>
          ` : ''}
          <p class="muted-text" style="margin-top: 1rem;">Source: FEC. ${funding.cycle ? `Cycle: ${funding.cycle}` : 'Cycle: All available cycles.'}</p>
        </div>
      `;
    } else {
      fundingHtml = `
        <div class="dossier-card">
          <h3>Campaign Funding</h3>
          <p class="muted-text">${funding.note || 'No matching FEC campaign committee was found.'}</p>
        </div>
      `;
    }
  }

  // 5. Stocks
  let stocksHtml = '';
  if (stocks) {
    let stocksContent = '';
    if (stocks.trades && stocks.trades.length > 0) {
      stocksContent = `
        <div style="overflow-x: auto; margin-bottom: 1rem;">
          <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem;">
            <thead>
              <tr style="border-bottom: 1px solid var(--color-border);">
                <th style="padding: 0.5rem;">Date</th>
                <th style="padding: 0.5rem;">Ticker</th>
                <th style="padding: 0.5rem;">Asset</th>
                <th style="padding: 0.5rem;">Type</th>
                <th style="padding: 0.5rem;">Amount</th>
                <th style="padding: 0.5rem;">Owner</th>
              </tr>
            </thead>
            <tbody>
              ${stocks.trades.map(t => `
                <tr style="border-bottom: 1px solid var(--color-border-light);">
                  <td style="padding: 0.5rem;">${t.transactionDate || '-'}</td>
                  <td style="padding: 0.5rem;"><strong>${t.ticker || '-'}</strong></td>
                  <td style="padding: 0.5rem; max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${t.assetDescription || ''}">${t.assetDescription || '-'}</td>
                  <td style="padding: 0.5rem;">${t.type || '-'}</td>
                  <td style="padding: 0.5rem;">${t.amountRange || '-'}</td>
                  <td style="padding: 0.5rem;">${t.owner || '-'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
      const self = stocks.ownerBreakdown?.self || 0;
      const spouse = stocks.ownerBreakdown?.spouse || 0;
      const child = stocks.ownerBreakdown?.dependent || stocks.ownerBreakdown?.child || 0;
      stocksContent += `<p class="muted-text">Trades by owner: Self (${self}), Spouse (${spouse}), Child (${child}).</p>`;
    } else if (stocks.filings && stocks.filings.length > 0) {
      stocksContent = '<ul class="dossier-list">';
      stocks.filings.forEach(f => {
        stocksContent += `
          <li class="dossier-list-item">
            <div class="dossier-list-item-title">${f.label || 'Filing'} ${f.isStockReport ? '<span class="enacted-badge">Stock Report</span>' : ''}</div>
            <div class="dossier-list-item-meta">${f.filingDate || ''} • <a href="${f.pdfUrl}" target="_blank" style="color: var(--color-accent);">View official PDF</a></div>
          </li>
        `;
      });
      stocksContent += '</ul>';
    } else if (stocks.senateSearchUrl) {
      stocksContent = `<p><a href="${stocks.senateSearchUrl}" target="_blank" style="color: var(--color-accent); font-weight: 600;">Search this senator's disclosures on the Senate eFD system</a></p>`;
    } else {
      stocksContent = `<p class="muted-text">${stocks.note || 'No financial disclosures found.'}</p>`;
    }

    stocksHtml = `
      <div class="dossier-card">
        <h3>Financial Disclosures</h3>
        ${stocksContent}
        ${stocks.familyMembersNote ? `<p class="muted-text" style="margin-top: 1rem; font-size: 0.8rem;">${stocks.familyMembersNote}</p>` : ''}
      </div>
    `;
  }

  // 6. Legislation
  let legislationHtml = '';
  if (legislation) {
    const sp = Array.isArray(legislation.sponsored) ? legislation.sponsored : [];
    const co = Array.isArray(legislation.cosponsored) ? legislation.cosponsored : [];
    
    const renderBillList = (bills) => bills.length ? '<ul class="dossier-list">' + bills.map(b => `
      <li class="dossier-list-item">
        <div class="dossier-list-item-title" style="margin-bottom: 0.5rem;">
          <a href="${b.url}" target="_blank" style="color: var(--color-accent); text-decoration: none;">${b.type}${b.number}</a>
          ${b.becameLaw ? '<span class="enacted-badge">Enacted</span>' : ''}
        </div>
        <div style="font-size: 0.95rem; margin-bottom: 0.5rem;">${b.title}</div>
        <div class="dossier-list-item-meta">
          ${b.introducedDate} • ${b.policyArea || 'Unknown Policy Area'}<br>
          <span style="display:inline-block; margin-top:0.25rem;">Latest: ${b.latestAction}</span>
        </div>
      </li>
    `).join('') + '</ul>' : '<p class="muted-text">None found.</p>';

    legislationHtml = `
      <div class="dossier-card full-width">
        <h3>Legislation</h3>
        <div class="dossier-tabs">
          <button class="dossier-tab" aria-selected="true" data-tab="sponsored" onclick="window.switchLegislationTab('sponsored')">Sponsored (${legislation.sponsoredCount || 0})</button>
          <button class="dossier-tab" aria-selected="false" data-tab="cosponsored" onclick="window.switchLegislationTab('cosponsored')">Cosponsored (${legislation.cosponsoredCount || 0})</button>
        </div>
        <div class="dossier-tab-content active" id="tab-sponsored">
          ${renderBillList(sp)}
        </div>
        <div class="dossier-tab-content" id="tab-cosponsored">
          ${renderBillList(co)}
        </div>
      </div>
    `;
  }

  // 7. Committees
  let committeesHtml = '';
  if (committees) {
    const assignments = Array.isArray(committees.assignments) ? committees.assignments : [];
    const grouped = {};
    assignments.forEach(a => {
      if (!a?.isSubcommittee) {
        const code = a?.code || 'UNKNOWN';
        if (!grouped[code]) grouped[code] = { ...a, subcommittees: [] };
      }
    });
    assignments.forEach(a => {
      if (a?.isSubcommittee) {
        const parentCode = Object.keys(grouped).find(k => k !== 'UNKNOWN' && a?.code?.startsWith(k));
        if (parentCode) grouped[parentCode].subcommittees.push(a);
        else {
          if (!grouped['MISC']) grouped['MISC'] = { committee: 'Other Subcommittees', subcommittees: [], isSubcommittee: false };
          grouped['MISC'].subcommittees.push(a);
        }
      }
    });

    const commListHtml = Object.values(grouped).map(c => `
      <li class="dossier-list-item">
        <div class="dossier-list-item-title">
          ${c.committeeUrl ? `<a href="${c.committeeUrl}" target="_blank" style="color: var(--color-accent);">${c.committee}</a>` : c.committee}
          ${c.role ? `<span class="enacted-badge" style="background:#e0e7ff; color:#3730a3;">${c.role}</span>` : ''}
        </div>
        ${c.subcommittees && c.subcommittees.length ? `
          <ul style="margin-top: 0.5rem; padding-left: 1.5rem; font-size: 0.9rem; color: var(--color-text-muted);">
            ${c.subcommittees.map(sub => `<li>${sub.subcommittee || sub.committee} ${sub.role ? `(<strong>${sub.role}</strong>)` : ''}</li>`).join('')}
          </ul>
        ` : ''}
      </li>
    `).join('');

    committeesHtml = `
      <div class="dossier-card">
        <h3>Committees</h3>
        ${commListHtml ? `<ul class="dossier-list">${commListHtml}</ul>` : '<p class="muted-text">No committee assignments found.</p>'}
      </div>
    `;
  }

  // 8. Contact & Links
  let contactHtml = '';
  if (contact) {
    const off = contact?.official || {};
    const soc = contact?.social || {};
    const prof = contact?.profiles || {};
    
    let offLines = [];
    if (off.website) offLines.push(`<div><a href="${off.website}" target="_blank" style="color: var(--color-accent);">Official Website</a></div>`);
    if (off.phone) offLines.push(`<div>📞 ${off.phone}</div>`);
    if (off.office) offLines.push(`<div>🏢 ${off.office}</div>`);

    let socLines = Object.entries(soc).map(([net, data]) => {
      if (!data) return '';
      return `<div><a href="${data.url}" target="_blank" style="color: var(--color-accent);">${net.charAt(0).toUpperCase() + net.slice(1)} (@${data.handle})</a></div>`;
    }).filter(Boolean);
    let profLines = Object.entries(prof).map(([site, url]) => `<div><a href="${url}" target="_blank" style="color: var(--color-accent);">${site.charAt(0).toUpperCase() + site.slice(1)}</a></div>`);

    contactHtml = `
      <div class="dossier-card">
        <h3>Contact & Links</h3>
        <div style="display:flex; flex-direction:column; gap:1.5rem;">
          ${offLines.length ? `<div><div style="font-weight:600; margin-bottom:0.25rem;">Official</div>${offLines.join('')}</div>` : ''}
          ${socLines.length ? `<div><div style="font-weight:600; margin-bottom:0.25rem;">Social Media</div>${socLines.join('')}</div>` : ''}
          ${profLines.length ? `<div><div style="font-weight:600; margin-bottom:0.25rem;">External Profiles</div>${profLines.join('')}</div>` : ''}
        </div>
      </div>
    `;
  }

  let bgStyle = '';
  if (dim1 !== null) {
    const baseGray = [255, 255, 255]; 
    const targetColor = dim1 < 0 ? [235, 240, 250] : [250, 235, 235];
    const distance = Math.abs(dim1);
    const tintStrength = 0.5 + 0.5 * Math.pow(distance, 0.85);
    const r = Math.round(baseGray[0] + (targetColor[0] - baseGray[0]) * tintStrength);
    const g = Math.round(baseGray[1] + (targetColor[1] - baseGray[1]) * tintStrength);
    const b = Math.round(baseGray[2] + (targetColor[2] - baseGray[2]) * tintStrength);
    bgStyle = `background: rgb(${r}, ${g}, ${b}); border: 1px solid rgba(0,0,0,0.05);`;
  } else {
    bgStyle = 'background: var(--color-surface); border: 1px solid var(--color-border);';
  }

  container.innerHTML = `
    <div class="dossier-layout">
      <div style="${bgStyle} border-radius: 12px; margin-bottom: 1rem;">
        ${identityHtml}
      </div>
      <div class="dossier-grid">
        ${aboutHtml}
        ${careerHtml}
        ${fundingHtml}
        ${stocksHtml}
        ${committeesHtml}
        ${contactHtml}
        ${legislationHtml}
      </div>
    </div>
  `;
}

async function initMemberPage() {
  const backLink = document.querySelector('.back-link');
  if (backLink) backLink.href = withApiParam('members.html');

  const container = document.getElementById('dossier-container');
  if (!container) return;

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');

  if (!id) {
    container.innerHTML = `
      <div class="error-state">
        <span class="state-icon" aria-hidden="true">!</span>
        <p>No member ID provided. <a href="${withApiParam('members.html')}">Return to Members</a></p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="skeleton-tile" style="max-width: 800px; margin: 0 auto; min-height: 400px; padding: 2rem;">
      <div class="skeleton-circle" style="width: 120px; height: 120px; margin-bottom: 2rem;"></div>
      <div class="skeleton-line wide"></div>
      <div class="skeleton-line medium"></div>
      <div class="skeleton-line narrow"></div>
      <div class="skeleton-line wide" style="margin-top: 2rem;"></div>
      <div class="skeleton-line wide"></div>
    </div>
  `;

  try {
    const result = await fetchJsonWithStaticFallback('/officials/' + id + '/dossier', 'dossier/' + id + '.json');
    if (result.notFound) {
      container.innerHTML = `
        <div class="error-state">
          <span class="state-icon" aria-hidden="true">?</span>
          <p>Detail unavailable in static mode — view on the live site</p>
          <p><a href="${withApiParam('members.html')}">Return to Members</a></p>
        </div>
      `;
      return;
    }
    
    renderDossierUI(container, result.data);

  } catch (err) {
    container.innerHTML = `
      <div class="error-state">
        <span class="state-icon" aria-hidden="true">!</span>
        <p>Could not load dossier data. <a href="${withApiParam('members.html')}">Return to Members</a></p>
      </div>
    `;
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
  if (membersSearch) membersSearch.addEventListener('input', handleSearch);

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
