/* ═══════════════════════════════════════════════════════════════════════════
   YGN — Civic Government Portal — app.js
   Vanilla JS, no framework, no build step.
   API_BASE_URL is declared in config.js, which is loaded before this script.
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Client-side caches ──────────────────────────────────────────────────────
const wikiCache = new Map();      // bioguideId → { summary, title } | null
const nominateCache = new Map();  // bioguideId → { dim1 } | null

// ─── Application state ───────────────────────────────────────────────────────
let allMembers = [];          // full sorted member array after first load
let membersLoaded = false;    // flag to avoid re-fetching

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

async function fetchJsonWithStaticFallback(apiPath, staticPath, options = {}) {
  try {
    const res = await fetch(API_BASE_URL + apiPath, { cache: options.cache || 'default' });
    if (res.status === 404) return { notFound: true, source: 'api' };
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

  // Activate target section (remove 'hidden' so it doesn't override 'active')
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
}

// ─── Health check ────────────────────────────────────────────────────────────

/**
 * Fetch /health and update the #health-indicator pill.
 */
async function checkHealth() {
  if (!healthIndicator) return;

  healthIndicator.className = 'checking';
  healthIndicator.textContent = 'Checking…';

  try {
    const result = await fetchJsonWithStaticFallback('/health', 'health.json', { cache: 'no-store' });
    if (result.data) {
      healthIndicator.className = 'connected';
      healthIndicator.textContent = result.source === 'static' ? 'Static data' : 'Connected';
      updateStatCard(
        'stat-backend',
        'Backend Status',
        result.source === 'static' ? 'Static data ✓' : 'Connected ✓'
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
  updateStatCard('stat-members', 'Members Loaded', '—');
  updateStatCard('stat-backend', 'Backend Status', 'Checking…');
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
      <span class="state-icon" aria-hidden="true">⚠️</span>
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
      <span class="state-icon" aria-hidden="true">🔍</span>
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
  const district = getMemberField(member, 'district');
  const party = getMemberField(member, 'party', 'partyName');
  const chamber = getMemberField(member, 'chamber');

  // Build display strings
  const locationStr = [state, district].filter(Boolean).join(' – ');
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
  const photoUrl = bioguideId
    ? `https://bioguide.congress.gov/bioguide/photo/${bioguideId[0]}/${bioguideId}.jpg`
    : null;

  const initials = buildInitials(name);

  // Build the tile element
  const tile = document.createElement('div');
  tile.className = 'member-tile';
  tile.setAttribute('tabindex', '0');
  tile.setAttribute('role', 'listitem');
  tile.setAttribute('aria-label', name);

  // Photo or initials
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

  tile.innerHTML = `
    ${photoHtml}
    <div class="tile-name">${name}</div>
    ${locationStr ? `<div class="tile-meta">${locationStr}</div>` : ''}
    ${chamberStr ? `<div class="tile-meta">${chamberStr}</div>` : ''}
    <div class="tile-badge-row">
      ${party ? `<span class="tile-party-badge ${partyClass}">${partyLabel}</span>` : ''}
    </div>
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
  showPopover(member, { summary: 'Loading…', title: null }, tileEl);

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
      ? wikiData.summary.slice(0, maxLen).trimEnd() + '…'
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
    const chamber = getMemberField(member, 'chamber').toLowerCase();

    return (
      name.includes(query) ||
      state.includes(query) ||
      party.includes(query) ||
      chamber.includes(query)
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
