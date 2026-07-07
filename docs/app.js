/* ═══════════════════════════════════════════════════════════════════════════
   YGN — Civic Government Portal — app.js
   Vanilla JS, no framework, no build step.
   API_BASE_URL is declared in config.js, which is loaded before this script.
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Client-side caches ──────────────────────────────────────────────────────
const wikiCache = new Map();      // bioguideId → { summary, title } | null
const nominateCache = new Map();  // bioguideId → { dim1 } | null
const ethicsCache = new Map();    // bioguideId -> { score, grade } | null

// ─── Application state ───────────────────────────────────────────────────────
let allMembers = [];          // full sorted member array after first load
let membersLoaded = false;    // flag to avoid re-fetching
let stateData = [];
let stateDataByFips = new Map();
let stateDataByAbbr = new Map();
let selectedMapState = null;
let mapInitialized = false;
let congressionalDistricts = null;
let congressionalDistrictsByFips = new Map();

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
const STATES_TOPOJSON_URL = 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json';

// ─── Popover state ───────────────────────────────────────────────────────────
let popoverHideTimer = null;
let currentAnchor = null;

// ─── DOM references ──────────────────────────────────────────────────────────
// Resolved after DOMContentLoaded
let healthIndicator;
let membersGrid;
let membersSearch;
let homeStats;
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
  try {
    const res = await fetch(API_BASE_URL + apiPath, { cache: options.cache || 'default' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: await res.json(), source: 'api' };
  } catch (apiError) {
    if (!staticPath) throw apiError;

    const res = await fetch(`data/${staticPath}`, { cache: 'no-store' });
    if (res.status === 404) return { notFound: true, source: 'static' };
    if (!res.ok) throw apiError;
    return { data: await res.json(), source: 'static' };
  }
}

// ─── Navigation (SPA routing) ────────────────────────────────────────────────

/**
 * Hide all sections, show the target section, and mark the nav button active.
 * @param {string} sectionId  e.g. 'home', 'members', etc.
 */
function showSection(sectionId) {
  // Deactivate all sections
  document.querySelectorAll('#main-content section').forEach(sec => {
    sec.classList.remove('active');
  });

  // Deactivate all nav buttons
  document.querySelectorAll('.main-nav button').forEach(btn => {
    btn.classList.remove('active');
  });

  // Activate target section
  const targetSection = document.getElementById('section-' + sectionId);
  if (targetSection) {
    targetSection.classList.remove('hidden');
    targetSection.classList.add('active');
  }

  // Activate matching nav button
  const targetBtn = document.querySelector(`.main-nav button[data-section="${sectionId}"]`);
  if (targetBtn) targetBtn.classList.add('active');

  // Close popover on navigation
  hidePopover();

  if (sectionId === 'map') {
    initMap();
  }
}

// ─── Health check ────────────────────────────────────────────────────────────

/**
 * Fetch /health and update the #health-indicator pill.
 */
async function checkHealth() {
  if (!healthIndicator) return;

  healthIndicator.className = 'checking';
  healthIndicator.textContent = 'Checking...';

  try {
    const result = await fetchJsonWithStaticFallback('/health', 'health.json', { cache: 'no-store' });
    if (result.data) {
      healthIndicator.className = 'connected';
      healthIndicator.textContent = result.source === 'static' ? 'Static data' : 'Connected';
      updateStatCard(
        'stat-backend',
        'Backend Status',
        result.source === 'static' ? 'Static data OK' : 'Connected OK'
      );
    } else {
      throw new Error('non-ok status');
    }
  } catch {
    healthIndicator.className = 'disconnected';
    healthIndicator.textContent = 'Disconnected';
    updateStatCard('stat-backend', 'Backend Status', 'Disconnected');
  }
}

// ─── Home stats ──────────────────────────────────────────────────────────────

/**
 * Ensure a stat card with the given id exists in #home-stats.
 * If it doesn't, create it. Then update value + label.
 */
function updateStatCard(id, label, value) {
  if (!homeStats) return;

  let card = homeStats.querySelector('#' + id);
  if (!card) {
    card = document.createElement('div');
    card.className = 'stat-card';
    card.id = id;
    card.innerHTML = `<div class="stat-label"></div><div class="stat-value"></div>`;
    homeStats.appendChild(card);
  }

  card.querySelector('.stat-label').textContent = label;
  card.querySelector('.stat-value').textContent = value;
}

/**
 * Initialize home stat cards with placeholder data.
 */
function initHomeStats() {
  updateStatCard('stat-members', 'Members Loaded', '-');
  updateStatCard('stat-backend', 'Backend Status', 'Checking...');
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

/**
 * Load the congressional members list from the API.
 * Shows skeletons while loading. On success, sorts and renders.
 * On failure, shows error state.
 */
async function loadMembers() {
  if (membersLoaded) return;

  renderSkeletons(12);

  try {
    const result = await fetchJsonWithStaticFallback('/officials?limit=250&offset=0', 'officials.json');
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

    if (items.length === 0) {
      showEmpty();
      return;
    }

    // Sort alphabetically by last name
    items.sort((a, b) => {
      const nameA = getMemberField(a, 'name', 'directOrderName', 'invertedOrderName');
      const nameB = getMemberField(b, 'name', 'directOrderName', 'invertedOrderName');
      const keyA = extractSortKey(nameA);
      const keyB = extractSortKey(nameB);
      return keyA.localeCompare(keyB);
    });

    allMembers = items;
    membersLoaded = true;

    renderGrid(allMembers);

    // Update home stat
    updateStatCard('stat-members', 'Members Loaded', allMembers.length.toString());

  } catch (err) {
    showError('Could not load congressional members. Make sure the backend is running.');
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
        onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
      >
      <div class="tile-initials" style="display:none;" aria-hidden="true">${initials}</div>
    `;
  } else {
    photoInner = `<div class="tile-initials" aria-hidden="true">${initials}</div>`;
  }

  const partyBadgeHtml = `<div class="party-badge ${partyClass}">${partyLabel}</div>`;
  const ethicsBadgeHtml = `<div class="ethics-badge" title="Ethics grade" style="background-color: ${ethicsColor};">${ethicsGrade}</div>`;

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

  // Background NOMINATE fetch (fire and forget, no blocking)
  if (bioguideId) {
    fetchNominate(bioguideId, tile);
    fetchEthics(bioguideId, tile);
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
    ? 'Ethics grade unavailable'
    : `Ethics grade ${grade} (${score})`;
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
  showPopover(member, { summary: 'Loading...', title: null }, tileEl);

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
    // Truncate very long summaries
    const maxLen = 280;
    const text = wikiData.summary.length > maxLen
      ? wikiData.summary.slice(0, maxLen).trimEnd() + '...'
      : wikiData.summary;
    popoverSummary.textContent = text;
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

function getMembersForState(abbreviation) {
  const target = String(abbreviation || '').toUpperCase();
  return allMembers.filter(member => getMemberField(member, 'state').toUpperCase() === target);
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

function updateStatePanel(stateInfo, mode = 'hover') {
  if (!stateInfo || !statePanel) return;

  selectedMapState = stateInfo;
  const score = Number(stateInfo.gerrymanderingIndex && stateInfo.gerrymanderingIndex.score);
  const safeScore = Number.isFinite(score) ? clamp(score, 0, 100) : 0;
  const members = getMembersForState(stateInfo.abbreviation);
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
    ? `Zoomed to ${stateInfo.name}. ${members.length || 'Static'} member records are available for search.`
    : `Hovering ${stateInfo.name}. Click the state to zoom into district outlines.`;
  viewStateMembersBtn.disabled = false;

  statePanel.classList.remove('panel-animate');
  void statePanel.offsetWidth;
  statePanel.classList.add('panel-animate');
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
    setMapStatus('Loading map data...');
    await loadStateData();

    const response = await fetch(STATES_TOPOJSON_URL, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Could not load state shapes (${response.status})`);
    const us = await response.json();

    drawStateMap(us);
    setMapStatus('Hover a state for details, or click to zoom into districts.');

    loadMembers().then(() => {
      if (selectedMapState) updateStatePanel(selectedMapState);
    }).catch(() => {
      setMapStatus('Map loaded. Member search data is using static fallback if available.', 'warn');
    });

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
    .attr('aria-label', feature => {
      const stateInfo = stateDataByFips.get(normalizeFips(feature.id));
      return stateInfo ? `${stateInfo.name} state map` : 'State map';
    })
    .on('mouseenter', (event, feature) => {
      const stateInfo = stateDataByFips.get(normalizeFips(feature.id));
      if (!stateInfo) return;
      updateStatePanel(stateInfo);
      showMapTooltip(`<strong>${stateInfo.name}</strong><span>${stateInfo.historicalLean}</span>`, event);
    })
    .on('focus', (event, feature) => {
      const stateInfo = stateDataByFips.get(normalizeFips(feature.id));
      if (stateInfo) updateStatePanel(stateInfo);
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
      updateStatePanel(stateInfo, 'click');
      zoomToFeature(feature);
      renderDistrictsForState(stateInfo);
    });

  mapSvg.__ygnMap = { svg, root, districtLayer, path, zoom, width, height };
}

function resetMapView() {
  if (!mapSvg || !mapSvg.__ygnMap) return;
  const { svg, zoom, districtLayer } = mapSvg.__ygnMap;
  districtLayer.selectAll('*').remove();
  districtListEl.innerHTML = '';
  districtStatusEl.textContent = 'Click a state to zoom into 119th congressional districts.';
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

  const response = await fetch(districtQueryUrl(normalizedFips), { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Could not load districts (${response.status})`);
  congressionalDistricts = await response.json();
  congressionalDistrictsByFips.set(normalizedFips, congressionalDistricts);
  return congressionalDistricts;
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

  districtStatusEl.textContent = `Loading ${stateInfo.name} districts...`;

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
  if (!selectedMapState || !membersSearch) return;
  await loadMembers();
  showSection('members');
  membersSearch.value = selectedMapState.name;
  handleSearch();
  membersSearch.focus();
}

function openMethodology() {
  showSection('methodology');
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

// ─── Initialisation ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Resolve DOM references
  healthIndicator = document.getElementById('health-indicator');
  membersGrid     = document.getElementById('members-grid');
  membersSearch   = document.getElementById('members-search');
  homeStats       = document.getElementById('home-stats');
  popoverEl       = document.getElementById('popover');
  popoverName     = popoverEl.querySelector('.popover-name');
  popoverSummary  = popoverEl.querySelector('.popover-summary');
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

  // ── Home stats placeholder
  initHomeStats();

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
  showSection('home');

  // ── Health check: immediate + every 30 seconds
  checkHealth();
  setInterval(checkHealth, 30_000);

  // ── Search
  membersSearch.addEventListener('input', handleSearch);

  if (viewStateMembersBtn) viewStateMembersBtn.addEventListener('click', openStateMembersSearch);
  if (mapResetBtn) mapResetBtn.addEventListener('click', resetMapView);
  if (methodologyOpenBtn) methodologyOpenBtn.addEventListener('click', openMethodology);
  if (gerryInfoBtn) gerryInfoBtn.addEventListener('click', openMethodology);
  if (methodologyBackBtn) methodologyBackBtn.addEventListener('click', () => showSection('map'));

  // ── Popover: cancel hide when mouse enters popover
  popoverEl.addEventListener('mouseenter', cancelPopoverHide);
  popoverEl.addEventListener('mouseleave', schedulePopoverHide);

  // ── Popover: close button
  popoverClose.addEventListener('click', hidePopover);

  // ── Popover: Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popoverEl.classList.contains('visible')) {
      hidePopover();
    }
  });

  // ── Popover: outside click
  document.addEventListener('click', (e) => {
    if (
      popoverEl.classList.contains('visible') &&
      !popoverEl.contains(e.target) &&
      !e.target.closest('.member-tile')
    ) {
      hidePopover();
    }
  });
});
