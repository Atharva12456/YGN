/* ═══════════════════════════════════════════════════════════════════════════
   YGN — UX layer
   Ten self-contained additions built on the "Civic Record" design system.
   Every feature is wrapped in its own guard, so one failure can never take a
   page down, and none of it is injected on the economy page.

     1  Command palette (Ctrl/Cmd-K)      6  Section rail (auto table of contents)
     2  Keyboard shortcut help (?)        7  Copy-link anchors on headings
     3  Saved hub (bills + members)       8  Toast feedback
     4  Density toggle                    9  Reading-comfort text size
     5  Sortable bill table              10  Active-filter summary + reset
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var page = (document.body && document.body.dataset.page) || '';
  if (page === 'economy') return;               // economy page stays untouched

  function guard(label, fn) {
    try { fn(); } catch (e) { if (window.console) console.warn('[ygn/ux] ' + label, e); }
  }
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function store(key, fallback) {
    try { var v = localStorage.getItem(key); return v === null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function save(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
  }

  /* ── 8. Toasts ───────────────────────────────────────────────────────────
     Saving a bill or copying a link used to give no feedback at all. */
  var toastHost = null;
  function toast(message, kind) {
    if (!toastHost) {
      toastHost = el('div', 'ygn-toasts');
      toastHost.setAttribute('role', 'status');
      toastHost.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastHost);
    }
    var t = el('div', 'ygn-toast' + (kind ? ' is-' + kind : ''), message);
    toastHost.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('is-in'); });
    setTimeout(function () {
      t.classList.remove('is-in');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }, 2400);
  }
  window.ygnToast = toast;

  /* ── 1. Command palette ───────────────────────────────────────────────── */
  var PAGES = [
    { label: 'Home', href: 'index.html', hint: 'Overview and live metrics' },
    { label: 'Congressional Members', href: 'members.html', hint: 'All 537 members' },
    { label: 'Recent Bills', href: 'recent-bills.html', hint: 'Congress.gov feed' },
    { label: 'Foreign Affairs', href: 'foreign-affairs.html', hint: 'Conflicts and diplomacy' },
    { label: 'Economy', href: 'economy.html', hint: 'Economic indicators' },
    { label: 'District Map', href: 'map.html', hint: 'Districts and boundaries' },
    { label: 'Ethics Methodology', href: 'ethics-methodology.html', hint: 'How grades are computed' },
    { label: 'Methodology', href: 'methodology.html', hint: 'Sources and standards' }
  ];

  function setupPalette() {
    var overlay = el('div', 'ygn-palette-overlay');
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="ygn-palette" role="dialog" aria-modal="true" aria-label="Command palette">' +
        '<input type="text" class="ygn-palette-input" placeholder="Jump to a page, member, or bill…" ' +
               'aria-label="Command palette search" autocomplete="off">' +
        '<div class="ygn-palette-results" role="listbox"></div>' +
        '<div class="ygn-palette-foot"><kbd>↑</kbd><kbd>↓</kbd> navigate ' +
          '<kbd>↵</kbd> open <kbd>esc</kbd> close</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var input = overlay.querySelector('.ygn-palette-input');
    var results = overlay.querySelector('.ygn-palette-results');
    var rows = [];
    var active = 0;
    var people = [];
    var bills = [];

    function loadData() {
      if (people.length || bills.length) return Promise.resolve();
      return Promise.all([
        fetch('data/officials.json', { cache: 'default' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
        fetch('data/recent-bills-digest.json', { cache: 'default' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      ]).then(function (out) {
        var roster = (out[0] && (out[0].members || out[0].officials)) || [];
        people = roster.map(function (m) {
          var id = m.bioguideId || m.bioguideID || m.bioguide_id;
          var name = m.name || ((m.firstName || '') + ' ' + (m.lastName || '')).trim();
          return id && name ? { label: name, href: 'member.html?id=' + encodeURIComponent(id),
                                hint: [m.partyName || m.party, m.state].filter(Boolean).join(' · '),
                                kind: 'Member' } : null;
        }).filter(Boolean);
        bills = ((out[1] && out[1].bills) || []).map(function (b) {
          return b.detailPath ? { label: (b.identifier || '') + ' — ' + (b.title || ''),
                                  href: 'bill.html?id=' + encodeURIComponent(b.detailPath),
                                  hint: b.policyArea || 'Bill', kind: 'Bill' } : null;
        }).filter(Boolean);
      });
    }

    function score(item, q) {
      var l = item.label.toLowerCase();
      if (l.startsWith(q)) return 0;
      var i = l.indexOf(q);
      return i === -1 ? -1 : 1 + i / 100;
    }

    function render() {
      var q = input.value.trim().toLowerCase();
      var pool = PAGES.map(function (p) { return { label: p.label, href: p.href, hint: p.hint, kind: 'Page' }; })
        .concat(people).concat(bills);
      var matches;
      if (!q) {
        matches = pool.filter(function (x) { return x.kind === 'Page'; });
      } else {
        matches = pool.map(function (x) { var s = score(x, q); return s === -1 ? null : { x: x, s: s }; })
          .filter(Boolean).sort(function (a, b) { return a.s - b.s; })
          .slice(0, 20).map(function (r) { return r.x; });
      }
      rows = matches;
      active = 0;
      if (!matches.length) {
        results.innerHTML = '<p class="ygn-palette-empty">Nothing matches that.</p>';
        return;
      }
      results.innerHTML = matches.map(function (m, i) {
        return '<a class="ygn-palette-row' + (i === 0 ? ' is-active' : '') + '" role="option" href="' + m.href + '">' +
                 '<span class="ygn-palette-kind">' + m.kind + '</span>' +
                 '<span class="ygn-palette-label"></span>' +
                 '<span class="ygn-palette-hint"></span>' +
               '</a>';
      }).join('');
      // Text set via textContent so nothing from the data can inject markup.
      var nodes = results.querySelectorAll('.ygn-palette-row');
      matches.forEach(function (m, i) {
        nodes[i].querySelector('.ygn-palette-label').textContent = m.label;
        nodes[i].querySelector('.ygn-palette-hint').textContent = m.hint || '';
      });
    }

    function move(delta) {
      var nodes = results.querySelectorAll('.ygn-palette-row');
      if (!nodes.length) return;
      nodes[active] && nodes[active].classList.remove('is-active');
      active = (active + delta + nodes.length) % nodes.length;
      nodes[active].classList.add('is-active');
      nodes[active].scrollIntoView({ block: 'nearest' });
    }

    function open() {
      overlay.hidden = false;
      document.body.style.overflow = 'hidden';
      input.value = '';
      render();
      input.focus();
      loadData().then(render);
    }
    function close() {
      overlay.hidden = true;
      document.body.style.overflow = '';
    }
    window.ygnOpenPalette = open;

    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        overlay.hidden ? open() : close();
      } else if (e.key === 'Escape' && !overlay.hidden) {
        close();
      } else if (!typing && e.key === '?' && overlay.hidden) {
        e.preventDefault();
        if (window.ygnOpenShortcuts) window.ygnOpenShortcuts();
      }
    });
    input.addEventListener('input', render);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') {
        var node = results.querySelectorAll('.ygn-palette-row')[active];
        if (node) { e.preventDefault(); window.location.href = node.getAttribute('href'); }
      }
    });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  }

  /* ── 2. Keyboard shortcut help ────────────────────────────────────────── */
  function setupShortcutHelp() {
    var SHORTCUTS = [
      ['Ctrl / ⌘ + K', 'Open the command palette'],
      ['/', 'Focus the search box'],
      ['?', 'Show this list'],
      ['g then h', 'Go home'],
      ['g then m', 'Go to members'],
      ['g then b', 'Go to recent bills'],
      ['g then f', 'Go to foreign affairs'],
      ['Esc', 'Close any overlay']
    ];
    var overlay = el('div', 'ygn-modal-overlay');
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="ygn-modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">' +
        '<div class="ygn-modal-head"><h2>Keyboard shortcuts</h2>' +
        '<button type="button" class="ygn-modal-close" aria-label="Close">×</button></div>' +
        '<dl class="ygn-shortcuts">' +
          SHORTCUTS.map(function (s) {
            return '<div><dt><kbd>' + s[0] + '</kbd></dt><dd>' + s[1] + '</dd></div>';
          }).join('') +
        '</dl>' +
      '</div>';
    document.body.appendChild(overlay);
    function close() { overlay.hidden = true; document.body.style.overflow = ''; }
    window.ygnOpenShortcuts = function () {
      overlay.hidden = false; document.body.style.overflow = 'hidden';
    };
    overlay.querySelector('.ygn-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    // "g then <key>" navigation
    var lastG = 0;
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      if (e.key === 'g') { lastG = Date.now(); return; }
      if (Date.now() - lastG > 900) return;
      var map = { h: 'index.html', m: 'members.html', b: 'recent-bills.html', f: 'foreign-affairs.html' };
      if (map[e.key]) { lastG = 0; window.location.href = map[e.key]; }
    });
  }

  /* ── 3. Saved hub ─────────────────────────────────────────────────────── */
  function setupSavedHub() {
    var header = document.querySelector('.site-header');
    if (!header) return;

    var btn = el('button', 'ygn-hub-btn');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Saved items');
    btn.innerHTML = '<span class="ygn-hub-star">★</span><span class="ygn-hub-count"></span>';
    header.appendChild(btn);

    var panel = el('div', 'ygn-hub-panel');
    panel.hidden = true;
    document.body.appendChild(panel);

    function counts() {
      return { members: readJson('ygn_saved_members_v1'), bills: readJson('ygn_saved_bills_v1') };
    }
    function refreshCount() {
      var c = counts();
      var n = c.members.length + c.bills.length;
      btn.querySelector('.ygn-hub-count').textContent = n ? String(n) : '';
      btn.classList.toggle('has-items', n > 0);
    }
    function render() {
      var c = counts();
      var parts = ['<div class="ygn-hub-head"><h3>Saved</h3>' +
        '<button type="button" class="ygn-hub-close" aria-label="Close">×</button></div>'];
      if (!c.members.length && !c.bills.length) {
        parts.push('<p class="ygn-hub-empty">Nothing saved yet. Use the ☆ on any member or bill ' +
                   'to keep it here.</p>');
      } else {
        if (c.members.length) {
          parts.push('<p class="ygn-hub-label">Members (' + c.members.length + ')</p><ul class="ygn-hub-list">' +
            c.members.map(function (id) {
              return '<li><a href="member.html?id=' + encodeURIComponent(id) + '">' +
                     String(id).replace(/[<>&]/g, '') + '</a></li>';
            }).join('') + '</ul>');
        }
        if (c.bills.length) {
          parts.push('<p class="ygn-hub-label">Bills (' + c.bills.length + ')</p><ul class="ygn-hub-list">' +
            c.bills.map(function (id) {
              return '<li><a href="bill.html?id=' + encodeURIComponent(id) + '">' +
                     String(id).replace(/[<>&]/g, '') + '</a></li>';
            }).join('') + '</ul>');
        }
      }
      panel.innerHTML = parts.join('');
      panel.querySelector('.ygn-hub-close').addEventListener('click', function () { panel.hidden = true; });
    }
    btn.addEventListener('click', function () {
      if (panel.hidden) { render(); panel.hidden = false; } else { panel.hidden = true; }
    });
    document.addEventListener('click', function (e) {
      if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) panel.hidden = true;
    });
    window.addEventListener('storage', refreshCount);
    document.addEventListener('ygn:saved-changed', refreshCount);
    refreshCount();
    setInterval(refreshCount, 2000);   // same-tab saves don't fire 'storage'
  }

  /* ── 4 + 9. Display controls: density and text size ───────────────────── */
  function setupDisplayControls() {
    var density = store('ygn-density', 'comfortable');
    var textSize = store('ygn-textsize', 'normal');
    function apply() {
      document.documentElement.setAttribute('data-density', density);
      document.documentElement.setAttribute('data-textsize', textSize);
    }
    apply();

    var nav = document.querySelector('.main-nav');
    if (!nav) return;
    var wrap = el('div', 'ygn-display-controls');
    wrap.innerHTML =
      '<button type="button" class="ygn-dc-btn" data-act="density" title="Toggle row density">' +
        '<span class="ygn-dc-icon">≡</span><span class="ygn-dc-text"></span></button>' +
      '<button type="button" class="ygn-dc-btn" data-act="text" title="Change text size">' +
        '<span class="ygn-dc-icon">A</span><span class="ygn-dc-text"></span></button>';
    nav.appendChild(wrap);

    function label() {
      wrap.querySelector('[data-act="density"] .ygn-dc-text').textContent =
        density === 'compact' ? 'Compact' : 'Comfortable';
      wrap.querySelector('[data-act="text"] .ygn-dc-text').textContent =
        textSize === 'large' ? 'Large' : textSize === 'small' ? 'Small' : 'Normal';
    }
    label();
    wrap.addEventListener('click', function (e) {
      var b = e.target.closest('.ygn-dc-btn');
      if (!b) return;
      if (b.dataset.act === 'density') {
        density = density === 'compact' ? 'comfortable' : 'compact';
        save('ygn-density', density);
        toast('Density: ' + (density === 'compact' ? 'compact' : 'comfortable'));
      } else {
        textSize = textSize === 'normal' ? 'large' : textSize === 'large' ? 'small' : 'normal';
        save('ygn-textsize', textSize);
        toast('Text size: ' + textSize);
      }
      apply(); label();
    });
  }

  /* ── 5. Sortable bill table ───────────────────────────────────────────── */
  function setupSortableBills() {
    var grid = document.getElementById('recent-bills-grid');
    if (!grid) return;
    var head = grid.querySelector('.bill-row-header, .bill-row--head, .bill-head');
    if (!head) return;
    var state = { col: null, dir: 1 };

    [].slice.call(head.children).forEach(function (cell, index) {
      var text = (cell.textContent || '').trim().toLowerCase();
      if (!/bill|description|latest|other/.test(text)) return;
      if (cell.dataset.sortBound) return;      // idempotent: this runs again later
      cell.dataset.sortBound = '1';
      cell.classList.add('ygn-sortable');
      cell.setAttribute('tabindex', '0');
      cell.setAttribute('role', 'button');
      cell.title = 'Sort by ' + text;
      function sort() {
        var rows = [].slice.call(grid.querySelectorAll('.bill-row')).filter(function (r) { return r !== head; });
        if (!rows.length) return;
        state.dir = state.col === index ? -state.dir : 1;
        state.col = index;
        rows.sort(function (a, b) {
          var av = (a.children[index] && a.children[index].textContent || '').trim().toLowerCase();
          var bv = (b.children[index] && b.children[index].textContent || '').trim().toLowerCase();
          return av < bv ? -state.dir : av > bv ? state.dir : 0;
        });
        rows.forEach(function (r) { grid.appendChild(r); });
        [].slice.call(head.children).forEach(function (c) { c.removeAttribute('data-sort'); });
        cell.setAttribute('data-sort', state.dir === 1 ? 'asc' : 'desc');
        toast('Sorted by ' + text + ' (' + (state.dir === 1 ? 'A–Z' : 'Z–A') + ')');
      }
      cell.addEventListener('click', sort);
      cell.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
    });
  }

  /* ── 6 + 7. Section rail and heading anchors ──────────────────────────── */
  function setupSectionRail() {
    var main = document.getElementById('main-content');
    if (!main) return;
    var heads = [].slice.call(main.querySelectorAll('h2')).filter(function (h) {
      return (h.textContent || '').trim().length > 2 && h.offsetParent !== null;
    });

    // 7. copy-link anchors on every heading
    heads.forEach(function (h, i) {
      if (!h.id) h.id = 'section-' + (i + 1) + '-' + (h.textContent || '').trim()
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      if (h.querySelector('.ygn-anchor')) return;
      var a = el('button', 'ygn-anchor', '§');
      a.type = 'button';
      a.title = 'Copy link to this section';
      a.setAttribute('aria-label', 'Copy link to section: ' + (h.textContent || '').trim());
      a.addEventListener('click', function () {
        var url = location.origin + location.pathname + location.search + '#' + h.id;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(url).then(function () { toast('Section link copied'); },
                                                  function () { toast('Could not copy', 'warn'); });
        }
      });
      h.appendChild(a);
    });

    // 6. the rail itself (only worth it on genuinely long pages)
    if (heads.length < 4) return;
    var existing = document.querySelector('.ygn-rail');
    if (existing) existing.remove();          // rebuilt as sections reveal
    var rail = el('nav', 'ygn-rail');
    rail.setAttribute('aria-label', 'On this page');
    rail.innerHTML = '<p class="ygn-rail-title">On this page</p>' +
      '<ul>' + heads.map(function (h) {
        return '<li><a href="#' + h.id + '"></a></li>';
      }).join('') + '</ul>';
    document.body.appendChild(rail);
    var links = rail.querySelectorAll('a');
    heads.forEach(function (h, i) {
      links[i].textContent = (h.textContent || '').replace('§', '').trim();
    });

    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          var i = heads.indexOf(en.target);
          if (i > -1 && en.isIntersecting) {
            for (var j = 0; j < links.length; j++) links[j].classList.toggle('is-current', j === i);
          }
        });
      }, { rootMargin: '-10% 0px -70% 0px' });
      heads.forEach(function (h) { io.observe(h); });
    }
  }

  /* ── 10. Active-filter summary + reset ────────────────────────────────── */
  function setupFilterSummary() {
    var filters = document.getElementById('bill-filters');
    if (!filters) return;
    var bar = el('div', 'ygn-filter-summary');
    bar.hidden = true;
    filters.parentNode.insertBefore(bar, filters.nextSibling);

    function update() {
      var active = [].slice.call(filters.querySelectorAll('.chip.is-active, .bill-chip.is-active, [aria-pressed="true"]'))
        .map(function (c) { return (c.textContent || '').trim(); })
        .filter(function (t) { return t && !/^all /i.test(t); });
      if (!active.length) { bar.hidden = true; return; }
      bar.innerHTML = '';
      bar.appendChild(el('span', 'ygn-filter-label', 'Filtered by'));
      active.forEach(function (t) { bar.appendChild(el('span', 'ygn-filter-pill', t)); });
      var reset = el('button', 'ygn-filter-reset', 'Clear all');
      reset.type = 'button';
      reset.addEventListener('click', function () {
        var allChip = filters.querySelector('.chip, .bill-chip');
        [].slice.call(filters.querySelectorAll('.chip, .bill-chip')).forEach(function (c) {
          if (/^all /i.test((c.textContent || '').trim())) c.click();
        });
        if (allChip) toast('Filters cleared');
        setTimeout(update, 120);
      });
      bar.appendChild(reset);
      bar.hidden = false;
    }
    filters.addEventListener('click', function () { setTimeout(update, 120); });
    setTimeout(update, 600);
  }

  ready(function () {
    guard('palette', setupPalette);
    guard('shortcuts', setupShortcutHelp);
    guard('saved-hub', setupSavedHub);
    guard('display-controls', setupDisplayControls);
    guard('sortable-bills', setupSortableBills);
    guard('section-rail', setupSectionRail);
    guard('filter-summary', setupFilterSummary);

    // Several sections (bills table, civic panels) are populated asynchronously
    // and start hidden, so a single pass at DOMContentLoaded sees almost nothing.
    // Re-run the DOM-dependent features once the data has landed; both are
    // idempotent — anchors are skipped if present and the rail is rebuilt.
    [1200, 3000].forEach(function (delay) {
      setTimeout(function () {
        guard('sortable-bills:late', setupSortableBills);
        guard('section-rail:late', setupSectionRail);
      }, delay);
    });
  });
})();
