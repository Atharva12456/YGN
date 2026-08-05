/* ═══════════════════════════════════════════════════════════════════════════
   YGN — Settings menu
   ───────────────────────────────────────────────────────────────────────────
   Preferences had accumulated in three unrelated places: the theme toggle in
   the header, the density and text-size cycle buttons in the nav, and nothing
   at all for motion, page chrome, or the data the site keeps in the browser.
   This is the one place that owns all of it.

   Everything is stored per-browser in localStorage and applied as attributes on
   <html>, so the CSS does the work and a failure here can never leave the page
   half-styled. Preferences are applied at parse time (this is a deferred
   script, so that is still before first paint) — the same trick enhancements.js
   uses for the theme, now extended to text size and density, which previously
   flashed at their defaults until DOMContentLoaded.

   injected chrome, so this module exits before touching it.

   Storage contract: a preference left at its default is stored as the ABSENCE
   of its key. For the theme that is load-bearing — "no ygn-theme" is what
   enhancements.js already reads as "follow the OS", so System mode needs no
   change there. For the rest it just keeps localStorage clean and lets a
   default change take effect for people who never touched the setting.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var docEl = document.documentElement;
  var page = (document.body && document.body.dataset.page) || '';

  function guard(label, fn) {
    try { return fn(); } catch (e) { if (window.console) console.warn('[ygn/settings] ' + label, e); }
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
  function readKey(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function writeKey(key, value) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
    catch (e) { /* private mode / quota — the session still works, it just won't persist */ }
  }
  function mq(query) { return window.matchMedia ? window.matchMedia(query) : null; }
  function toast(msg, kind) { if (window.ygnToast) window.ygnToast(msg, kind); }

  var mqDark = mq('(prefers-color-scheme: dark)');
  var mqMotion = mq('(prefers-reduced-motion: reduce)');

  /* ── Preference model ────────────────────────────────────────────────────
     Each preference names its storage key, its default, and its legal values.
     Anything unrecognised in storage falls back to the default, so a stale or
     hand-edited value can't put the page into an undefined state. */
  var PREFS = {
    theme:    { key: 'ygn-theme',     def: 'system',      values: ['system', 'light', 'dark'] },
    textsize: { key: 'ygn-textsize',  def: 'normal',      values: ['small', 'normal', 'large'] },
    density:  { key: 'ygn-density',   def: 'comfortable', values: ['comfortable', 'compact'] },
    motion:   { key: 'ygn-motion',    def: 'system',      values: ['system', 'full', 'reduced'] },
    progress: { key: 'ygn-progress',  def: 'on',          values: ['on', 'off'] },
    rail:     { key: 'ygn-rail',      def: 'on',          values: ['on', 'off'] },
    totop:    { key: 'ygn-backtotop', def: 'on',          values: ['on', 'off'] }
  };

  function get(name) {
    var p = PREFS[name];
    var v = readKey(p.key);
    return p.values.indexOf(v) === -1 ? p.def : v;
  }
  function put(name, value) {
    var p = PREFS[name];
    if (!p || p.values.indexOf(value) === -1) return;
    writeKey(p.key, value === p.def ? null : value);
  }
  function snapshot() {
    var out = {};
    for (var name in PREFS) if (PREFS.hasOwnProperty(name)) out[name] = get(name);
    return out;
  }

  // "system" resolves against the OS at apply time so the page can follow a
  // live change (macOS auto dark, Windows night mode) without a reload.
  function effectiveTheme() {
    var t = get('theme');
    return t === 'system' ? ((mqDark && mqDark.matches) ? 'dark' : 'light') : t;
  }
  function effectiveMotion() {
    var m = get('motion');
    return m === 'system' ? ((mqMotion && mqMotion.matches) ? 'reduced' : 'full') : m;
  }

  /* ── Applying ────────────────────────────────────────────────────────────
     One attribute per preference on <html>. data-theme keeps its existing
     shape (present only for dark) because the whole dark palette hangs off
     :root[data-theme="dark"]. */
  var lastTheme = null;

  function apply() {
    var theme = effectiveTheme();
    if (theme === 'dark') docEl.setAttribute('data-theme', 'dark');
    else docEl.removeAttribute('data-theme');
    docEl.setAttribute('data-textsize', get('textsize'));
    docEl.setAttribute('data-density', get('density'));
    docEl.setAttribute('data-motion', effectiveMotion());
    docEl.setAttribute('data-progress', get('progress'));
    docEl.setAttribute('data-rail', get('rail'));
    docEl.setAttribute('data-totop', get('totop'));

    // Inline-styled visuals (NOMINATE tile tints) can't follow CSS variables,
    // so they listen for this and recompute. Only fire on a real change.
    if (lastTheme !== null && theme !== lastTheme) {
      try { document.dispatchEvent(new CustomEvent('ygn:themechange', { detail: { theme: theme } })); }
      catch (e) {}
    }
    lastTheme = theme;
    return theme;
  }

  function commit(name, value) {
    put(name, value);
    apply();
    try {
      document.dispatchEvent(new CustomEvent('ygn:prefschange', {
        detail: { changed: name, prefs: snapshot() }
      }));
    } catch (e) {}
  }

  // Pre-paint pass. Nothing below this runs until the DOM is ready.
  guard('apply', apply);
  lastTheme = effectiveTheme();

  if (mqDark && mqDark.addEventListener) {
    mqDark.addEventListener('change', function () { if (get('theme') === 'system') guard('os-theme', apply); });
  }
  if (mqMotion && mqMotion.addEventListener) {
    mqMotion.addEventListener('change', function () { if (get('motion') === 'system') guard('os-motion', apply); });
  }

  // The header theme toggle writes ygn-theme directly; mirror it so the panel
  // and the OS-follow state never drift from what the button just did.
  document.addEventListener('ygn:themechange', function () {
    lastTheme = effectiveTheme();
    if (!overlay || overlay.hidden) return;
    syncControls();
  });

  /* ── Panel definition ────────────────────────────────────────────────────
     Declarative so the markup stays in one shape and every row is wired the
     same way. "segment" is a radiogroup; "switch" is an on/off pair. */
  var GROUPS = [
    {
      title: 'Appearance',
      rows: [
        { type: 'segment', pref: 'theme', label: 'Theme',
          help: 'System follows your device’s light or dark setting.',
          options: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] },
        { type: 'segment', pref: 'textsize', label: 'Text size',
          help: 'Scales the whole page, not just body copy.',
          options: [['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']] },
        { type: 'segment', pref: 'density', label: 'Density',
          help: 'Compact tightens rows, cards and member tiles.',
          options: [['comfortable', 'Comfortable'], ['compact', 'Compact']] }
      ]
    },
    {
      title: 'Motion and page chrome',
      rows: [
        { type: 'segment', pref: 'motion', label: 'Animations',
          help: 'Reduced turns off reveals, count-ups and transitions.',
          options: [['system', 'System'], ['full', 'Full'], ['reduced', 'Reduced']] },
        { type: 'switch', pref: 'progress', label: 'Reading progress bar',
          help: 'The thin accent line across the top of the page.' },
        { type: 'switch', pref: 'rail', label: '“On this page” rail',
          help: 'Section list docked to the right on wide screens.' },
        { type: 'switch', pref: 'totop', label: 'Back-to-top button' }
      ]
    }
  ];

  /* ── Locally stored data ─────────────────────────────────────────────────
     Nothing here ever leaves the browser, but people should still be able to
     see what is being kept and clear it. */
  function listLen(key) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(v) ? v.length : 0;
    } catch (e) { return 0; }
  }
  function cacheKeys() {
    var keys = [];
    try {
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && /^ygn_(dossier|fast|handoff)_/.test(k)) keys.push(k);
      }
    } catch (e) {}
    return keys;
  }

  var DATA_ROWS = [
    {
      id: 'saved',
      label: 'Saved members and bills',
      help: 'The ☆ shortlist behind the star in the header.',
      count: function () { return listLen('ygn_saved_members_v1') + listLen('ygn_saved_bills_v1'); },
      clear: function () {
        writeKey('ygn_saved_members_v1', null);
        writeKey('ygn_saved_bills_v1', null);
        try { document.dispatchEvent(new CustomEvent('ygn:saved-changed')); } catch (e) {}
      }
    },
    {
      id: 'recent',
      label: 'Recently viewed',
      help: 'Members and bills listed on the home page.',
      count: function () { return listLen('ygn-recent'); },
      clear: function () { writeKey('ygn-recent', null); }
    },
    {
      id: 'watch',
      label: 'Watched conflicts',
      help: 'Regions you follow on the Foreign Affairs page.',
      count: function () { return listLen('ygn-foreign-watch'); },
      clear: function () { writeKey('ygn-foreign-watch', null); }
    },
    {
      id: 'cache',
      label: 'Cached member dossiers',
      help: 'Speeds up revisits. Cleared when the tab closes anyway.',
      count: function () { return cacheKeys().length; },
      clear: function () {
        cacheKeys().forEach(function (k) { try { sessionStorage.removeItem(k); } catch (e) {} });
      }
    }
  ];

  /* ── The panel ───────────────────────────────────────────────────────── */
  var overlay = null, dialog = null, openerBtn = null, lastFocus = null;

  function buildSegment(row) {
    var group = el('div', 'ygn-seg');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', row.label);
    row.options.forEach(function (opt) {
      var b = el('button', 'ygn-seg-btn', opt[1]);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.pref = row.pref;
      b.dataset.value = opt[0];
      b.addEventListener('click', function () {
        commit(row.pref, opt[0]);
        syncControls();
        toast(row.label + ': ' + opt[1].toLowerCase());
      });
      group.appendChild(b);
    });
    return group;
  }

  function buildSwitch(row) {
    var b = el('button', 'ygn-switch');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-label', row.label);
    b.dataset.pref = row.pref;
    b.appendChild(el('span', 'ygn-switch-thumb'));
    b.addEventListener('click', function () {
      var next = get(row.pref) === 'on' ? 'off' : 'on';
      commit(row.pref, next);
      syncControls();
      toast(row.label + ': ' + (next === 'on' ? 'on' : 'off'));
    });
    return b;
  }

  function buildRow(row) {
    var wrap = el('div', 'ygn-set-row');
    var text = el('div', 'ygn-set-text');
    text.appendChild(el('span', 'ygn-set-label', row.label));
    if (row.help) text.appendChild(el('span', 'ygn-set-help', row.help));
    wrap.appendChild(text);
    wrap.appendChild(row.type === 'segment' ? buildSegment(row) : buildSwitch(row));
    return wrap;
  }

  function buildDataRow(row) {
    var wrap = el('div', 'ygn-set-row');
    var text = el('div', 'ygn-set-text');
    var label = el('span', 'ygn-set-label', row.label);
    var badge = el('span', 'ygn-set-count');
    badge.dataset.count = row.id;
    label.appendChild(badge);
    text.appendChild(label);
    if (row.help) text.appendChild(el('span', 'ygn-set-help', row.help));
    wrap.appendChild(text);

    var btn = el('button', 'ygn-set-clear', 'Clear');
    btn.type = 'button';
    btn.dataset.clear = row.id;
    btn.addEventListener('click', function () {
      if (!row.count()) return;
      row.clear();
      syncCounts();
      toast(row.label + ' cleared');
    });
    wrap.appendChild(btn);
    return wrap;
  }

  function build() {
    overlay = el('div', 'ygn-settings-overlay');
    overlay.hidden = true;

    dialog = el('div', 'ygn-settings');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'ygn-settings-title');

    var head = el('div', 'ygn-settings-head');
    var title = el('h2', null, 'Settings');
    title.id = 'ygn-settings-title';
    head.appendChild(title);
    var close = el('button', 'ygn-settings-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close settings');
    close.addEventListener('click', function () { closePanel(); });
    head.appendChild(close);
    dialog.appendChild(head);

    var body = el('div', 'ygn-settings-body');
    GROUPS.forEach(function (g) {
      body.appendChild(el('p', 'ygn-set-group', g.title));
      g.rows.forEach(function (r) { body.appendChild(buildRow(r)); });
    });

    body.appendChild(el('p', 'ygn-set-group', 'Stored on this device'));
    DATA_ROWS.forEach(function (r) { body.appendChild(buildDataRow(r)); });
    body.appendChild(el('p', 'ygn-set-note',
      'YGN keeps these in your browser only — no account, no server, nothing sent anywhere. ' +
      'Clearing your browser data removes them too.'));
    dialog.appendChild(body);

    var foot = el('div', 'ygn-settings-foot');
    var shortcuts = el('button', 'ygn-set-link', 'Keyboard shortcuts');
    shortcuts.type = 'button';
    shortcuts.addEventListener('click', function () {
      closePanel();
      if (window.ygnOpenShortcuts) window.ygnOpenShortcuts();
    });
    foot.appendChild(shortcuts);
    var reset = el('button', 'ygn-set-reset', 'Reset to defaults');
    reset.type = 'button';
    reset.addEventListener('click', function () {
      for (var name in PREFS) if (PREFS.hasOwnProperty(name)) writeKey(PREFS[name].key, null);
      apply();
      try {
        document.dispatchEvent(new CustomEvent('ygn:prefschange', {
          detail: { changed: 'reset', prefs: snapshot() }
        }));
      } catch (e) {}
      syncControls();
      toast('Settings reset to defaults');
    });
    foot.appendChild(reset);
    dialog.appendChild(foot);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closePanel(); });
    dialog.addEventListener('keydown', onDialogKey);
  }

  function syncControls() {
    if (!dialog) return;
    [].slice.call(dialog.querySelectorAll('.ygn-seg-btn')).forEach(function (b) {
      b.setAttribute('aria-checked', get(b.dataset.pref) === b.dataset.value ? 'true' : 'false');
      // Only the selected radio is tab-reachable; arrows move within the group.
      b.tabIndex = get(b.dataset.pref) === b.dataset.value ? 0 : -1;
    });
    [].slice.call(dialog.querySelectorAll('.ygn-switch')).forEach(function (b) {
      b.setAttribute('aria-checked', get(b.dataset.pref) === 'on' ? 'true' : 'false');
    });
    syncCounts();
  }

  function syncCounts() {
    if (!dialog) return;
    DATA_ROWS.forEach(function (row) {
      var n = row.count();
      var badge = dialog.querySelector('[data-count="' + row.id + '"]');
      var btn = dialog.querySelector('[data-clear="' + row.id + '"]');
      if (badge) badge.textContent = n ? String(n) : 'none';
      if (badge) badge.classList.toggle('is-empty', !n);
      if (btn) btn.disabled = !n;
    });
  }

  function focusables() {
    return [].slice.call(dialog.querySelectorAll('button:not([disabled])'))
      .filter(function (b) { return b.tabIndex !== -1; });
  }

  function onDialogKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closePanel(); return; }

    // Arrow keys inside a segmented control, per the radiogroup pattern.
    var seg = e.target && e.target.closest && e.target.closest('.ygn-seg');
    if (seg && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      var btns = [].slice.call(seg.querySelectorAll('.ygn-seg-btn'));
      var i = btns.indexOf(e.target);
      if (i === -1) return;
      var next = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
      next.click();
      next.focus();
      return;
    }

    if (e.key !== 'Tab') return;
    var list = focusables();
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function openPanel() {
    if (!overlay) return;
    lastFocus = document.activeElement;
    syncControls();
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    if (openerBtn) openerBtn.setAttribute('aria-expanded', 'true');
    // Land on the first actual setting rather than the close button.
    var first = dialog.querySelector('.ygn-settings-body .ygn-seg-btn[tabindex="0"], .ygn-settings-body button:not([disabled])')
             || focusables()[0];
    if (first) first.focus();
  }

  function closePanel() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.body.style.overflow = '';
    if (openerBtn) openerBtn.setAttribute('aria-expanded', 'false');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  window.ygnOpenSettings = openPanel;
  window.ygnSettingsOpen = function () { return !!overlay && !overlay.hidden; };

  ready(function () {
    guard('build', build);

    guard('button', function () {
      var header = document.querySelector('.site-header');
      if (!header || document.querySelector('.ygn-settings-btn')) return;
      openerBtn = el('button', 'ygn-settings-btn', '⚙');
      openerBtn.type = 'button';
      openerBtn.setAttribute('aria-label', 'Settings');
      openerBtn.setAttribute('aria-haspopup', 'dialog');
      openerBtn.setAttribute('aria-expanded', 'false');
      openerBtn.title = 'Settings (Ctrl/⌘ + ,)';
      openerBtn.addEventListener('click', function () {
        if (overlay && overlay.hidden) openPanel(); else closePanel();
      });
      header.appendChild(openerBtn);
    });

    guard('shortcut', function () {
      document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === ',') {
          e.preventDefault();
          if (overlay && overlay.hidden) openPanel(); else closePanel();
        } else if (e.key === 'Escape' && overlay && !overlay.hidden) {
          // The dialog's own handler covers the trapped case; this catches a
          // stray focus (e.g. after a backdrop click) so Esc always works.
          closePanel();
        }
      });
    });
  });
})();
