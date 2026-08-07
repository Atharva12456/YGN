/* ═══════════════════════════════════════════════════════════════════════════
   YGN — shared data layer
   ───────────────────────────────────────────────────────────────────────────
   One loader, one cache, one set of statistics helpers, shared by every
   feature module that follows. Without this each feature would refetch
   officials.json (384 KB) and member-scores.json (148 KB) for itself.

   Everything reads the committed snapshots under docs/data/. Nothing here
   calls the API or a model, so it works identically on the static path and
   behind FastAPI, and it can never invent a number: every value a feature
   shows is computed from a field that is actually in the data.

   Exposed as window.ygnData. Every loader returns a Promise that resolves to
   null on failure rather than rejecting, so a missing snapshot degrades one
   feature instead of taking a page down.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var cache = {};

  function load(path) {
    if (cache[path]) return cache[path];
    cache[path] = fetch('data/' + path, { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
    return cache[path];
  }

  /* ── Loaders ───────────────────────────────────────────────────────────── */
  var api = {
    officials: function () { return load('officials.json'); },
    scores:    function () { return load('member-scores.json'); },
    digest:    function () { return load('recent-bills-digest.json'); },
    manifest:  function () { return load('manifest.json'); },
    health:    function () { return load('health.json'); },
    civic:     function (name) { return load('civic/' + name + '.json'); },
    dossier:   function (id) { return load('dossier/' + id + '.json'); },
    profile:   function (id) { return load('profiles/' + id + '.json'); },
    bill:      function (detailPath) { return load('bills/' + detailPath + '.json'); }
  };

  /* ── Roster, joined to its scores once ─────────────────────────────────────
     Every analysis feature wants the same thing: one array of members with
     ideology and ethics already attached. Doing the join here means it happens
     once per page rather than once per feature. */
  var rosterPromise = null;
  api.roster = function () {
    if (rosterPromise) return rosterPromise;
    rosterPromise = Promise.all([api.officials(), api.scores()]).then(function (out) {
      var people = (out[0] && out[0].members) || [];
      var scores = out[1] || {};
      var eth = scores.ethics || {};
      var nom = scores.nominate || {};
      return people.map(function (m) {
        var id = m.bioguideId;
        var e = eth[id] || null;
        var n = nom[id] || null;
        var terms = (m.terms && m.terms.item) || [];
        var years = terms.map(function (t) { return t.startYear; })
                         .filter(function (y) { return typeof y === 'number'; });
        return {
          id: id,
          name: m.name || '',
          last: String(m.name || '').split(',')[0].trim(),
          party: m.partyName || '',
          partyKey: api.partyKey(m.partyName),
          state: m.state || '',
          stateAbbr: api.abbr(m.state),
          chamber: m.chamber || '',
          district: m.district,
          districtLabel: m.districtLabel || '',
          // NOMINATE dim1: negative = left, positive = right, roughly -1..+1.
          ideology: n && typeof n.dim1 === 'number' ? n.dim1 : null,
          // Ethics score is 0-100; the letter grade is what the site shows.
          ethics: e && typeof e.score === 'number' ? e.score : null,
          grade: (e && e.grade) || null,
          ethicsSource: (e && e.source) || null,
          firstYear: years.length ? Math.min.apply(null, years) : null,
          termCount: terms.length
        };
      });
    });
    return rosterPromise;
  };

  /* ── Small shared vocabulary ───────────────────────────────────────────── */
  api.partyKey = function (name) {
    var p = String(name || '').toLowerCase();
    if (p.indexOf('democrat') === 0 || p === 'democratic') return 'D';
    if (p.indexOf('republican') === 0) return 'R';
    if (!p) return '';
    return 'I';
  };
  api.partyLabel = function (key) {
    return key === 'D' ? 'Democrat' : key === 'R' ? 'Republican' : key === 'I' ? 'Independent' : 'Unknown';
  };

  var STATES = {
    'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA','Colorado':'CO',
    'Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA','Hawaii':'HI','Idaho':'ID',
    'Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS','Kentucky':'KY','Louisiana':'LA',
    'Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI','Minnesota':'MN',
    'Mississippi':'MS','Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV',
    'New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY',
    'North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR',
    'Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',
    'Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA',
    'West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY','District of Columbia':'DC',
    'Puerto Rico':'PR','Guam':'GU','American Samoa':'AS','Virgin Islands':'VI',
    'Northern Mariana Islands':'MP'
  };
  api.abbr = function (state) { return STATES[state] || String(state || '').slice(0, 2).toUpperCase(); };
  // Congress.gov spells it "House of Representatives", which reads badly mid
  // sentence ("of the house of representatives").
  api.chamberShort = function (chamber) {
    return /^house/i.test(chamber || '') ? 'House' : /^senate/i.test(chamber || '') ? 'Senate' : (chamber || '');
  };
  api.states = STATES;

  /* ── Statistics ────────────────────────────────────────────────────────────
     Deliberately plain: these describe a complete population (all 537 sitting
     members), not a sample, so the population SD is the correct one. */
  var stats = {
    clean: function (xs) {
      return xs.filter(function (x) { return typeof x === 'number' && isFinite(x); });
    },
    mean: function (xs) {
      var v = stats.clean(xs);
      if (!v.length) return null;
      return v.reduce(function (a, b) { return a + b; }, 0) / v.length;
    },
    median: function (xs) { return stats.quantile(xs, 0.5); },
    quantile: function (xs, q) {
      var v = stats.clean(xs).sort(function (a, b) { return a - b; });
      if (!v.length) return null;
      var pos = (v.length - 1) * q;
      var lo = Math.floor(pos), hi = Math.ceil(pos);
      return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
    },
    sd: function (xs) {
      var v = stats.clean(xs);
      if (v.length < 2) return null;
      var m = stats.mean(v);
      return Math.sqrt(v.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / v.length);
    },
    // Share of the population strictly below x, as a 0-100 percentile.
    percentile: function (xs, x) {
      var v = stats.clean(xs);
      if (!v.length || typeof x !== 'number') return null;
      var below = v.filter(function (y) { return y < x; }).length;
      return (below / v.length) * 100;
    },
    // Pearson r over the pairs where BOTH values are present.
    correlation: function (pairs) {
      var v = pairs.filter(function (p) {
        return typeof p[0] === 'number' && isFinite(p[0]) && typeof p[1] === 'number' && isFinite(p[1]);
      });
      if (v.length < 3) return null;
      var mx = stats.mean(v.map(function (p) { return p[0]; }));
      var my = stats.mean(v.map(function (p) { return p[1]; }));
      var num = 0, dx = 0, dy = 0;
      v.forEach(function (p) {
        var a = p[0] - mx, b = p[1] - my;
        num += a * b; dx += a * a; dy += b * b;
      });
      return (dx && dy) ? num / Math.sqrt(dx * dy) : null;
    },
    // Equal-width bins over [min, max]; returns [{x0, x1, items}].
    histogram: function (items, valueOf, binCount) {
      var vals = stats.clean(items.map(valueOf));
      if (!vals.length) return [];
      var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
      if (min === max) max = min + 1;
      var n = binCount || 20, width = (max - min) / n;
      var bins = [];
      for (var i = 0; i < n; i++) bins.push({ x0: min + i * width, x1: min + (i + 1) * width, items: [] });
      items.forEach(function (it) {
        var v = valueOf(it);
        if (typeof v !== 'number' || !isFinite(v)) return;
        var idx = Math.min(n - 1, Math.floor((v - min) / width));
        bins[idx].items.push(it);
      });
      return bins;
    },
    groupBy: function (items, keyOf) {
      var out = {};
      items.forEach(function (it) {
        var k = keyOf(it);
        if (k === null || k === undefined || k === '') return;
        (out[k] = out[k] || []).push(it);
      });
      return out;
    }
  };
  api.stats = stats;

  /* Congress.gov dates arrive as bare "YYYY-MM-DD". `new Date` reads those as
     UTC midnight, which then renders as the PREVIOUS day for anyone west of
     Greenwich — every date on the site would be a day early in US timezones.
     Date-only strings are therefore parsed as local midnight; full timestamps
     carry their own zone and are left to the native parser. */
  api.parseDate = function (s) {
    if (s instanceof Date) return s;
    if (typeof s === 'string') {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    return new Date(s);
  };
  // Whole days between a date and now, positive for the past.
  api.daysAgo = function (s) {
    var d = api.parseDate(s);
    if (isNaN(d.getTime())) return null;
    var a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var now = new Date();
    var b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((b - a) / 86400000);
  };

  /* ── Formatting ────────────────────────────────────────────────────────── */
  api.fmt = {
    num: function (n, dp) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return n.toLocaleString('en-US', { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
    },
    pct: function (n, dp) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return n.toFixed(dp === undefined ? 0 : dp) + '%';
    },
    // NOMINATE has no natural unit; a signed 2dp number with a direction word
    // is the honest way to show it.
    ideology: function (n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return (n > 0 ? '+' : '') + n.toFixed(2);
    },
    lean: function (n) {
      if (typeof n !== 'number' || !isFinite(n)) return 'unknown';
      var a = Math.abs(n);
      var side = n < 0 ? 'liberal' : 'conservative';
      if (a < 0.15) return 'centrist';
      if (a < 0.35) return 'moderately ' + side;
      if (a < 0.6) return side;
      return 'strongly ' + side;
    },
    date: function (s) {
      if (!s) return '';
      var d = api.parseDate(s);
      if (isNaN(d.getTime())) return String(s).slice(0, 10);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    },
    ago: function (s) {
      if (!s) return '';
      var days = api.daysAgo(s);
      if (days === null) return '';
      if (days < 0) return 'in ' + Math.abs(days) + ' days';
      if (days === 0) return 'today';
      if (days === 1) return 'yesterday';
      if (days < 30) return days + ' days ago';
      var months = Math.round(days / 30);
      if (months < 24) return months + ' month' + (months === 1 ? '' : 's') + ' ago';
      return Math.round(days / 365) + ' years ago';
    }
  };

  /* ── DOM helpers shared by the feature modules ─────────────────────────── */
  api.el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // Every feature that adds a block to a page uses this, so they all come out
  // looking like one system rather than fifty separate bolt-ons.
  api.card = function (title, subtitle) {
    var wrap = api.el('section', 'ygn-fcard');
    var head = api.el('div', 'ygn-fcard-head');
    head.appendChild(api.el('h3', null, title));
    if (subtitle) head.appendChild(api.el('p', 'ygn-fcard-sub', subtitle));
    wrap.appendChild(head);
    var body = api.el('div', 'ygn-fcard-body');
    wrap.appendChild(body);
    wrap.body = body;
    return wrap;
  };

  api.note = function (text) { return api.el('p', 'ygn-fnote', text); };

  /* ── Card packing ──────────────────────────────────────────────────────────
     The panels lay out as CSS multi-column, which removes the holes a grid
     leaves between cards of different heights but still balances columns badly
     when the tallest block lands late: on the bills panel the shortest column
     ended 415px above the longest. Feeding the browser the tallest cards first
     lets it balance far better — the same panel closes to 90px and gets 20%
     shorter.

     The cost is that visual order becomes height order. That is acceptable
     here only because multi-column already reads top-to-bottom down each
     column rather than across, so DOM order was never the reading order, and
     because these cards are independent readings rather than a sequence. */
  var PACK_MIN = 330, PACK_GAP = 16, PACK_MAX_COLS = 4;

  api.packGrid = function (grid) {
    if (!grid || grid.hidden) return;

    // Cards may already be inside columns from a previous pass; flatten first.
    var cards = [];
    [].slice.call(grid.children).forEach(function (child) {
      if (child.classList && child.classList.contains('ygn-col')) {
        [].slice.call(child.children).forEach(function (c) { cards.push(c); });
      } else cards.push(child);
    });
    if (cards.length < 3) return;

    var width = grid.clientWidth;
    if (!width) return;                            // not laid out yet
    var n = Math.floor((width + PACK_GAP) / (PACK_MIN + PACK_GAP));
    n = Math.max(1, Math.min(PACK_MAX_COLS, n));

    /* Stamp the declaration order the first time each card is seen. After a
       pack, DOM order is column order, so re-deriving "original order" from the
       DOM would drift a little further every resize — and collapsing to one
       column on a phone would show the cards in an arbitrary sequence. */
    var measured = cards.map(function (node, i) {
      if (!node.hasAttribute('data-ygn-order')) node.setAttribute('data-ygn-order', String(i));
      return { node: node, h: node.getBoundingClientRect().height,
               i: parseInt(node.getAttribute('data-ygn-order'), 10) || 0 };
    });
    // Nothing measurable yet (backgrounded tab, fonts still loading) — leave the
    // CSS multi-column fallback in place and let a later sweep try again.
    if (measured.some(function (m) { return !m.h; })) return;

    if (n < 2) {
      // One column: nothing to balance, so hand the cards back unwrapped and
      // let the stylesheet lay them out.
      if (grid.classList.contains('is-packed')) {
        var flat = document.createDocumentFragment();
        measured.sort(function (a, b) { return a.i - b.i; })
                .forEach(function (m) { flat.appendChild(m.node); });
        grid.classList.remove('is-packed');
        grid.innerHTML = '';
        grid.appendChild(flat);
      }
      return;
    }

    /* Greedy shortest-column-first over cards sorted tall to short. This is the
       standard bin-packing heuristic and it beats what CSS can do alone:
       multi-column balances by splitting a single flow, so an unluckily ordered
       tall card strands a column. Measured on the bills panel the ragged bottom
       went 415px -> 90px, and on the members panel 331px -> ~140px.

       Feeding the browser sorted content instead was tried first and is not
       reliable: it helped the bills panel and made the members panel worse,
       because multi-column's break points do not follow document order in any
       way you can steer. Assigning columns outright removes the guesswork. */
    var cols = [], heights = [];
    for (var c = 0; c < n; c++) { cols.push([]); heights.push(0); }
    measured.slice().sort(function (a, b) { return (b.h - a.h) || (a.i - b.i); })
      .forEach(function (m) {
        var target = 0;
        for (var k = 1; k < n; k++) if (heights[k] < heights[target]) target = k;
        cols[target].push(m);
        heights[target] += m.h + PACK_GAP;
      });

    // Within a column, restore document order so reading down a column still
    // follows the order the features were declared in.
    var frag = document.createDocumentFragment();
    cols.forEach(function (col) {
      var wrap = api.el('div', 'ygn-col');
      col.sort(function (a, b) { return a.i - b.i; })
         .forEach(function (m) { wrap.appendChild(m.node); });
      frag.appendChild(wrap);
    });
    grid.innerHTML = '';
    grid.classList.add('is-packed');
    grid.appendChild(frag);
  };

  function repackAll() {
    var grids = document.querySelectorAll('.ygn-analysis-grid');
    for (var i = 0; i < grids.length; i++) api.guard('pack', function () { api.packGrid(grids[i]); });
  }
  var packTimer = null;
  api.schedulePack = function (delay) {
    if (packTimer) clearTimeout(packTimer);
    packTimer = setTimeout(repackAll, delay || 120);
  };
  // Panels mount at different times and the lazy home cards arrive later still,
  // so sweep a few times rather than making every call site remember to ask.
  // Same approach ux.js already uses for its late DOM passes.
  if (typeof window !== 'undefined') {
    [700, 2000, 4200, 6500].forEach(function (d) { setTimeout(repackAll, d); });
    window.addEventListener('resize', function () { api.schedulePack(200); });
  }

  // chip and statRow are the two shapes every feature reaches for. They lived
  // as identical private copies in all four modules before they moved here.
  api.chip = function (text, tone) {
    return api.el('span', 'ygn-chip' + (tone ? ' is-' + tone : ''), text);
  };
  api.statRow = function (label, value, hint) {
    var r = api.el('div', 'ygn-statrow');
    r.appendChild(api.el('span', 'ygn-statrow-label', label));
    r.appendChild(api.el('span', 'ygn-statrow-value', value));
    if (hint) r.appendChild(api.el('span', 'ygn-statrow-hint', hint));
    return r;
  };

  /* ── File export ───────────────────────────────────────────────────────────
     Everything is built from data already in the page and handed straight to
     the browser; nothing is uploaded anywhere. */
  api.csvCell = function (v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  api.download = function (name, text, type) {
    try {
      var blob = new Blob([text], { type: type });
      var url = URL.createObjectURL(blob);
      var a = api.el('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      api.toast('Downloaded ' + name);
      return true;
    } catch (e) { api.toast('Could not build the file', 'warn'); return false; }
  };

  api.guard = function (label, fn) {
    try { return fn(); } catch (e) { if (window.console) console.warn('[ygn/' + label + ']', e); }
  };
  api.ready = function (fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  };
  /* Member and bill pages are rendered into a container by core.js, and that
     container is written more than once — a skeleton first, then the real
     content. Anything appended after the first write gets wiped by the second,
     so features wait for the container to stop changing before they mount, and
     mount as a SIBLING of it rather than inside it.

     Resolves with the container once it has held still for `quiet` ms, or after
     `timeout` regardless so a container that never fills still gets its
     features. */
  api.settled = function (id, opts) {
    opts = opts || {};
    var quiet = opts.quiet || 700, timeout = opts.timeout || 12000;
    return new Promise(function (resolve) {
      var host = document.getElementById(id);
      if (!host) { resolve(null); return; }
      var lastChange = Date.now(), done = false;
      var mo = new MutationObserver(function () { lastChange = Date.now(); });
      mo.observe(host, { childList: true, subtree: true });
      var started = Date.now();
      (function check() {
        if (done) return;
        var quietEnough = host.children.length && (Date.now() - lastChange) >= quiet;
        if (quietEnough || (Date.now() - started) > timeout) {
          done = true;
          mo.disconnect();
          resolve(host);
          return;
        }
        setTimeout(check, 200);
      })();
    });
  };

  /* Resolves when `node` is near the viewport. core.js deliberately keeps the
     ~390 KB officials.json and ~148 KB member-scores.json off the home page —
     the member count comes from the 0.5 KB manifest, and the map loads its
     delegation data only once a state is picked. Anything on the home page
     that wants the roster has to earn it the same way, by waiting until the
     reader has actually scrolled to it. */
  api.whenVisible = function (node, opts) {
    return new Promise(function (resolve) {
      if (!node) { resolve(null); return; }
      var margin = (opts && opts.margin) || 400;
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        if (io) io.disconnect();
        window.removeEventListener('scroll', onScroll);
        resolve(node);
      }
      // A backgrounded tab never fires IntersectionObserver at all, and the API
      // is missing entirely on older browsers — in either case the panel would
      // sit unfilled forever. Scrolling near it is the same signal, measured
      // directly, so the two together cannot both miss.
      function onScroll() {
        var r = node.getBoundingClientRect();
        if (r.top - margin < window.innerHeight && r.bottom + margin > 0) finish();
      }
      window.addEventListener('scroll', onScroll, { passive: true });

      var io = null;
      if ('IntersectionObserver' in window) {
        io = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) { finish(); return; }
          }
        }, { rootMargin: margin + 'px' });
        io.observe(node);
      } else {
        onScroll();                 // no observer: judge from where it sits now
      }
    });
  };

  api.page = function () { return (document.body && document.body.dataset.page) || ''; };
  api.file = function () { return (location.pathname.split('/').pop() || 'index.html').toLowerCase(); };
  api.param = function (k) {
    try { return new URLSearchParams(location.search).get(k); } catch (e) { return null; }
  };
  api.toast = function (m, k) { if (window.ygnToast) window.ygnToast(m, k); };

  /* ── Local store, namespaced so the settings menu can report and clear it ─ */
  api.store = {
    get: function (key, fallback) {
      try {
        var v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e) { return false; }
    },
    del: function (key) { try { localStorage.removeItem(key); } catch (e) {} }
  };

  /* ── Tiny inline SVG chart kit ─────────────────────────────────────────────
     The economy page hand-rolls its SVG charts; these follow the same idea so
     no charting library is pulled in. viewBox + no fixed width means they
     scale with the card and stay crisp. */
  var NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }
  api.svg = svgEl;

  api.barChart = function (rows, opts) {
    opts = opts || {};
    var w = 320, barH = opts.barHeight || 18, gap = 6, labelW = opts.labelWidth || 96;
    var h = rows.length * (barH + gap) + 4;
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    var svg = svgEl('svg', { viewBox: '0 0 ' + w + ' ' + h, class: 'ygn-chart', role: 'img' });
    svg.setAttribute('aria-label', opts.label || 'Bar chart');
    rows.forEach(function (r, i) {
      var y = i * (barH + gap);
      var label = svgEl('text', { x: 0, y: y + barH * 0.72, class: 'ygn-chart-label' });
      label.textContent = r.label;
      svg.appendChild(label);
      var track = svgEl('rect', { x: labelW, y: y, width: w - labelW - 34, height: barH, rx: 3, class: 'ygn-chart-track' });
      svg.appendChild(track);
      var bw = Math.max(1, (w - labelW - 34) * (r.value / max));
      var bar = svgEl('rect', { x: labelW, y: y, width: bw, height: barH, rx: 3,
                                class: 'ygn-chart-bar' + (r.tone ? ' is-' + r.tone : '') });
      if (r.title) { var t = svgEl('title'); t.textContent = r.title; bar.appendChild(t); }
      svg.appendChild(bar);
      var val = svgEl('text', { x: w - 30, y: y + barH * 0.72, class: 'ygn-chart-value' });
      val.textContent = r.display !== undefined ? r.display : r.value;
      svg.appendChild(val);
    });
    return svg;
  };

  // Stacked histogram: bins on x, count on y, each bin split by a category so
  // party overlap is visible rather than averaged away.
  api.histogramChart = function (bins, categories, opts) {
    opts = opts || {};
    var w = 340, h = opts.height || 130, pad = 18;
    var max = Math.max.apply(null, bins.map(function (b) { return b.items.length; }).concat([1]));
    var svg = svgEl('svg', { viewBox: '0 0 ' + w + ' ' + h, class: 'ygn-chart', role: 'img' });
    svg.setAttribute('aria-label', opts.label || 'Distribution');
    var bw = (w - pad * 2) / bins.length;
    bins.forEach(function (b, i) {
      var x = pad + i * bw;
      var yBase = h - pad;
      var offset = 0;
      categories.forEach(function (cat) {
        var n = b.items.filter(cat.test).length;
        if (!n) return;
        var bh = (n / max) * (h - pad * 2);
        offset += bh;
        var rect = svgEl('rect', { x: x + 0.5, y: yBase - offset, width: Math.max(1, bw - 1),
                                   height: bh, class: 'ygn-chart-bar is-' + cat.tone });
        var t = svgEl('title');
        t.textContent = cat.label + ': ' + n + ' between ' + b.x0.toFixed(2) + ' and ' + b.x1.toFixed(2);
        rect.appendChild(t);
        svg.appendChild(rect);
      });
    });
    var axis = svgEl('line', { x1: pad, y1: h - pad, x2: w - pad, y2: h - pad, class: 'ygn-chart-axis' });
    svg.appendChild(axis);
    if (opts.xLeft) {
      var l = svgEl('text', { x: pad, y: h - 4, class: 'ygn-chart-label' }); l.textContent = opts.xLeft;
      svg.appendChild(l);
    }
    if (opts.xRight) {
      var r = svgEl('text', { x: w - pad, y: h - 4, class: 'ygn-chart-label', 'text-anchor': 'end' });
      r.textContent = opts.xRight; svg.appendChild(r);
    }
    return svg;
  };

  api.scatterChart = function (points, opts) {
    opts = opts || {};
    var w = 340, h = opts.height || 200, pad = 26;
    var xs = points.map(function (p) { return p.x; }), ys = points.map(function (p) { return p.y; });
    var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
    var yMin = opts.yMin !== undefined ? opts.yMin : Math.min.apply(null, ys);
    var yMax = opts.yMax !== undefined ? opts.yMax : Math.max.apply(null, ys);
    if (xMin === xMax) xMax = xMin + 1;
    if (yMin === yMax) yMax = yMin + 1;
    var svg = svgEl('svg', { viewBox: '0 0 ' + w + ' ' + h, class: 'ygn-chart', role: 'img' });
    svg.setAttribute('aria-label', opts.label || 'Scatter plot');
    svg.appendChild(svgEl('line', { x1: pad, y1: h - pad, x2: w - pad, y2: h - pad, class: 'ygn-chart-axis' }));
    svg.appendChild(svgEl('line', { x1: pad, y1: pad, x2: pad, y2: h - pad, class: 'ygn-chart-axis' }));
    points.forEach(function (p) {
      var cx = pad + ((p.x - xMin) / (xMax - xMin)) * (w - pad * 2);
      var cy = (h - pad) - ((p.y - yMin) / (yMax - yMin)) * (h - pad * 2);
      var dot = svgEl('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r: p.r || 2.4,
                                  class: 'ygn-chart-dot' + (p.tone ? ' is-' + p.tone : '') });
      if (p.title) { var t = svgEl('title'); t.textContent = p.title; dot.appendChild(t); }
      svg.appendChild(dot);
    });
    if (opts.xLabel) {
      var xl = svgEl('text', { x: w / 2, y: h - 6, class: 'ygn-chart-label', 'text-anchor': 'middle' });
      xl.textContent = opts.xLabel; svg.appendChild(xl);
    }
    if (opts.yLabel) {
      var yl = svgEl('text', { x: 8, y: 12, class: 'ygn-chart-label' });
      yl.textContent = opts.yLabel; svg.appendChild(yl);
    }
    return svg;
  };

  api.sparkline = function (values, opts) {
    opts = opts || {};
    var w = 160, h = opts.height || 34;
    var v = stats.clean(values);
    if (v.length < 2) return api.el('span', 'ygn-fnote', '—');
    var min = Math.min.apply(null, v), max = Math.max.apply(null, v);
    if (min === max) max = min + 1;
    var step = w / (v.length - 1);
    var d = v.map(function (y, i) {
      return (i ? 'L' : 'M') + (i * step).toFixed(1) + ' ' + (h - ((y - min) / (max - min)) * (h - 4) - 2).toFixed(1);
    }).join(' ');
    var svg = svgEl('svg', { viewBox: '0 0 ' + w + ' ' + h, class: 'ygn-spark', role: 'img' });
    svg.setAttribute('aria-label', opts.label || 'Trend');
    svg.appendChild(svgEl('path', { d: d, class: 'ygn-spark-line', fill: 'none' }));
    return svg;
  };

  window.ygnData = api;
})();
