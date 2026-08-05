/* ═══════════════════════════════════════════════════════════════════════════
   YGN — Economy dashboard
   Charts are hand-rolled SVG: no charting library, no build step, nothing to
   load from a CDN. Every number rendered here comes from an upstream response;
   when a source fails the card says so rather than showing a placeholder.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (!document.body || document.body.dataset.page !== 'economy') return;

  var API = (typeof API_BASE_URL === 'string' ? API_BASE_URL : '');
  var state = {
    range: '1y',
    mode: 'value',          // 'value' | 'percent'
    compare: false,
    autoRefresh: false,
    pinned: readJson('ygn-econ-pinned', []),
    query: '',
    markets: null,
    economy: null,
    // FEATURE 21/22/23: chart scale, overlays and drag-zoom
    logScale: false,
    ma: readJson('ygn-econ-ma', []),   // subset of [50, 200]
    zoom: null,                        // {from, to} indices into the full series
    // FEATURE 39: day-table paging and sort
    tableRows: 30,
    tableSort: { col: 'date', dir: -1 }
  };
  var refreshTimer = null;
  var debtTimer = null;

  /* ── small helpers ─────────────────────────────────────────────────────── */
  function readJson(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v, digits) {
    if (v == null || !isFinite(v)) return '—';
    return Number(v).toLocaleString('en-US', {
      minimumFractionDigits: digits == null ? 2 : digits,
      maximumFractionDigits: digits == null ? 2 : digits
    });
  }
  function compact(v) {
    if (v == null || !isFinite(v)) return '—';
    var abs = Math.abs(v);
    if (abs >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    return '$' + num(v, 0);
  }
  function pct(v) { return v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function shortDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
    return isNaN(d) ? String(iso) : d.toLocaleDateString('en-US',
      { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function toast(msg) {
    var host = document.querySelector('.econ-toasts');
    if (!host) { host = el('div', 'econ-toasts'); document.body.appendChild(host); }
    var t = el('div', 'econ-toast', msg);
    host.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('is-in'); });
    setTimeout(function () {
      t.classList.remove('is-in');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
    }, 2200);
  }

  /* ── FEATURE 12: URL state, so a view can be linked ────────────────────── */
  function readUrlState() {
    var p = new URLSearchParams(location.search);
    if (p.get('range')) state.range = p.get('range');
    if (p.get('mode') === 'percent') state.mode = 'percent';
    if (p.get('compare') === '1') state.compare = true;
  }
  function writeUrlState(push) {
    var p = new URLSearchParams(location.search);
    p.set('range', state.range);
    if (state.mode === 'percent') p.set('mode', 'percent'); else p.delete('mode');
    if (state.compare) p.set('compare', '1'); else p.delete('compare');
    var url = location.pathname + '?' + p.toString();
    if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
  }

  /* ── data ──────────────────────────────────────────────────────────────── */
  async function fetchJson(path, staticFallback) {
    if (API) {
      try {
        var r = await fetch(API + path, { cache: 'no-store' });
        if (r.ok) return await r.json();
      } catch (e) { /* fall through */ }
    }
    if (staticFallback) {
      try {
        var r2 = await fetch(staticFallback, { cache: 'default' });
        if (r2.ok) return await r2.json();
      } catch (e) { /* fall through */ }
    }
    return null;
  }
  function loadMarkets() {
    return fetchJson('/metrics/markets?range=' + encodeURIComponent(state.range));
  }
  function loadEconomy() {
    return fetchJson('/metrics/economy', 'data/metrics/economy.json');
  }

  /* ── FEATURE 1: the chart itself ────────────────────────────────────────
     One SVG renderer used by every chart on the page. Draws an area+line,
     a hover crosshair, period high/low markers, and exposes each point for
     keyboard traversal. `series` is [{key,label,color,points:[{date,value}]}]. */
  function renderChart(host, series, opts) {
    opts = opts || {};
    // Let a previous render release its window-level brush listeners first.
    if (typeof host.__ygnTeardown === 'function') { host.__ygnTeardown(); host.__ygnTeardown = null; }
    host.innerHTML = '';
    var live = series.filter(function (s) { return s.points && s.points.length > 1; });
    if (!live.length) {
      host.appendChild(el('p', 'econ-chart-empty',
        'No data available for this range from the upstream source.'));
      return;
    }

    var W = 900, H = opts.height || 280;
    var padL = 62, padR = 16, padT = 16, padB = 30;
    var innerW = W - padL - padR, innerH = H - padT - padB;

    // In percent mode every series is rebased to its own first value, which is
    // what makes indices of very different magnitudes comparable.
    var shaped = live.map(function (s) {
      var base = s.points[0].value || 1;
      return {
        key: s.key, label: s.label, color: s.color,
        pts: s.points.map(function (p) {
          return { date: p.date, raw: p.value,
                   v: state.mode === 'percent' ? (p.value - base) / base * 100 : p.value };
        })
      };
    });

    var all = shaped.reduce(function (a, s) { return a.concat(s.pts.map(function (p) { return p.v; })); }, []);

    // FEATURE 21: log scale. Only meaningful on positive index levels, so it is
    // ignored in percent mode (which crosses zero) and if any value is <= 0.
    var useLog = !!opts.log && state.mode === 'value' && Math.min.apply(null, all) > 0;
    function tv(v) { return useLog ? Math.log(v) : v; }
    function untv(t) { return useLog ? Math.exp(t) : t; }

    var tAll = all.map(tv);
    var min = Math.min.apply(null, tAll), max = Math.max.apply(null, tAll);
    if (min === max) { min -= 1; max += 1; }
    var pad = (max - min) * 0.08;
    min -= pad; max += pad;
    var count = shaped[0].pts.length;

    function x(i) { return padL + (count === 1 ? innerW / 2 : (i / (count - 1)) * innerW); }
    function y(v) { return padT + innerH - ((tv(v) - min) / (max - min)) * innerH; }

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'econ-chart-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', opts.ariaLabel || 'Line chart');
    svg.setAttribute('preserveAspectRatio', 'none');

    function add(tag, attrs, parent) {
      var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      (parent || svg).appendChild(n);
      return n;
    }

    // gridlines + y labels. Positions are computed in the (possibly log)
    // transformed space and the label is mapped back for display.
    for (var g = 0; g <= 4; g++) {
      var frac = g / 4;
      var gy = padT + innerH - frac * innerH;
      var gv = untv(min + (max - min) * frac);
      add('line', { x1: padL, x2: W - padR, y1: gy, y2: gy, class: 'econ-grid' });
      var lbl = add('text', { x: padL - 8, y: gy + 4, class: 'econ-axis', 'text-anchor': 'end' });
      lbl.textContent = state.mode === 'percent'
        ? gv.toFixed(1) + '%'
        : (Math.abs(gv) >= 1000 ? Math.round(gv).toLocaleString('en-US') : gv.toFixed(2));
    }

    // x labels (first, middle, last)
    [0, Math.floor((count - 1) / 2), count - 1].forEach(function (i) {
      var t = add('text', { x: x(i), y: H - 8, class: 'econ-axis', 'text-anchor': i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle' });
      t.textContent = shortDate(shaped[0].pts[i].date);
    });

    shaped.forEach(function (s, si) {
      var line = s.pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i) + ' ' + y(p.v); }).join(' ');
      if (shaped.length === 1) {
        add('path', { d: line + ' L' + x(count - 1) + ' ' + (padT + innerH) + ' L' + x(0) + ' ' + (padT + innerH) + ' Z',
                      class: 'econ-area', style: 'fill:' + s.color });
      }
      add('path', { d: line, class: 'econ-line', style: 'stroke:' + s.color });

      // FEATURE 20: period high/low markers, single-series only to avoid clutter
      if (shaped.length === 1 && opts.markExtremes !== false) {
        var hi = 0, lo = 0;
        s.pts.forEach(function (p, i) { if (p.v > s.pts[hi].v) hi = i; if (p.v < s.pts[lo].v) lo = i; });
        [[hi, 'high'], [lo, 'low']].forEach(function (pair) {
          add('circle', { cx: x(pair[0]), cy: y(s.pts[pair[0]].v), r: 4,
                          class: 'econ-extreme econ-extreme--' + pair[1] });
        });
      }

      // FEATURE 22: moving-average overlays. Drawn only for a single series --
      // three indices plus their averages is unreadable. A window longer than
      // the visible range yields no points, which is the honest result: it is
      // simply not drawn rather than being faked from a shorter window.
      if (shaped.length === 1 && opts.ma && opts.ma.length) {
        opts.ma.forEach(function (win) {
          var avg = movingAverage(s.pts.map(function (p) { return p.v; }), win);
          var seg = [], d = '';
          avg.forEach(function (v, i) {
            if (v == null) { seg = []; return; }
            d += (seg.length ? 'L' : 'M') + x(i) + ' ' + y(v) + ' ';
            seg.push(i);
          });
          if (!d) return;
          add('path', { d: d.trim(), class: 'econ-ma econ-ma--' + win,
                        style: 'stroke:' + s.color, 'stroke-dasharray': win >= 200 ? '2 4' : '6 3' });
        });
      }
    });

    var crossX = add('line', { x1: 0, x2: 0, y1: padT, y2: padT + innerH, class: 'econ-cross', opacity: 0 });
    var dots = shaped.map(function (s) {
      return add('circle', { r: 4, class: 'econ-dot', opacity: 0, style: 'fill:' + s.color });
    });

    host.appendChild(svg);
    var tip = el('div', 'econ-tip');
    tip.hidden = true;
    host.appendChild(tip);

    var activeIndex = -1;
    function showAt(i) {
      if (i < 0 || i >= count) return;
      activeIndex = i;
      var px = x(i);
      crossX.setAttribute('x1', px); crossX.setAttribute('x2', px);
      crossX.setAttribute('opacity', 1);
      var rows = shaped.map(function (s, si) {
        var p = s.pts[i];
        dots[si].setAttribute('cx', px);
        dots[si].setAttribute('cy', y(p.v));
        dots[si].setAttribute('opacity', 1);
        var shown = state.mode === 'percent' ? pct(p.v) : num(p.raw, p.raw >= 1000 ? 0 : 2);
        return '<span class="econ-tip-row"><span class="econ-tip-swatch" style="background:' + s.color + '"></span>' +
               esc(s.label) + '<strong>' + esc(shown) + '</strong></span>';
      }).join('');
      tip.innerHTML = '<span class="econ-tip-date">' + esc(shortDate(shaped[0].pts[i].date)) + '</span>' + rows;
      tip.hidden = false;
      var frac = px / W;
      tip.style.left = Math.min(Math.max(frac * host.clientWidth - 70, 4), Math.max(host.clientWidth - 150, 4)) + 'px';
    }
    function hide() {
      crossX.setAttribute('opacity', 0);
      dots.forEach(function (d) { d.setAttribute('opacity', 0); });
      tip.hidden = true;
      activeIndex = -1;
    }

    function indexFromEvent(ev) {
      var rect = svg.getBoundingClientRect();
      var cx = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left) / rect.width * W;
      return Math.max(0, Math.min(count - 1, Math.round((cx - padL) / innerW * (count - 1))));
    }
    // FEATURE 23: drag across the plot to zoom into a date window. A drag under
    // ~10px is treated as a click (so hovering and tapping still work), and a
    // selection narrower than 3 points is rejected -- zooming to two days
    // produces a chart that says nothing.
    var brushRect = null, brushStart = null;
    if (opts.onBrush) {
      svg.addEventListener('mousedown', function (ev) {
        if (ev.button !== 0) return;
        brushStart = { i: indexFromEvent(ev), px: ev.clientX };
        brushRect = add('rect', { y: padT, height: innerH, width: 0, x: x(brushStart.i), class: 'econ-brush' });
        ev.preventDefault();
      });
      window.addEventListener('mousemove', onBrushMove);
      window.addEventListener('mouseup', onBrushUp);
      // The chart is re-rendered on every control change; drop these listeners
      // with it so repeated renders don't stack handlers on window.
      host.__ygnTeardown = function () {
        window.removeEventListener('mousemove', onBrushMove);
        window.removeEventListener('mouseup', onBrushUp);
      };
    }
    function onBrushMove(ev) {
      if (!brushStart || !brushRect) return;
      var i = indexFromEvent(ev);
      var a = Math.min(x(brushStart.i), x(i)), b = Math.max(x(brushStart.i), x(i));
      brushRect.setAttribute('x', a);
      brushRect.setAttribute('width', Math.max(0, b - a));
    }
    function onBrushUp(ev) {
      if (!brushStart) return;
      var moved = Math.abs(ev.clientX - brushStart.px);
      var i = indexFromEvent(ev);
      var from = Math.min(brushStart.i, i), to = Math.max(brushStart.i, i);
      if (brushRect && brushRect.parentNode) brushRect.parentNode.removeChild(brushRect);
      brushRect = null; brushStart = null;
      if (moved > 10 && to - from >= 3) opts.onBrush(from, to);
    }

    svg.addEventListener('mousemove', function (ev) { showAt(indexFromEvent(ev)); });
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('touchstart', function (ev) { showAt(indexFromEvent(ev)); }, { passive: true });
    svg.addEventListener('touchmove', function (ev) { showAt(indexFromEvent(ev)); }, { passive: true });

    // FEATURE 13: keyboard traversal of the series
    svg.setAttribute('tabindex', '0');
    svg.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight') { ev.preventDefault(); showAt(activeIndex < 0 ? 0 : activeIndex + 1); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); showAt(activeIndex < 0 ? count - 1 : activeIndex - 1); }
      else if (ev.key === 'Home') { ev.preventDefault(); showAt(0); }
      else if (ev.key === 'End') { ev.preventDefault(); showAt(count - 1); }
      else if (ev.key === 'Escape') { hide(); }
    });
    svg.addEventListener('blur', hide);
  }

  /* ═══ analytics ═════════════════════════════════════════════════════════
     Every statistic below is computed from the closes already on the page --
     nothing is fetched, estimated or annotated by hand. Where a window is too
     short to support a figure the function returns null and the UI omits the
     row rather than printing a number it cannot stand behind.
     ═══════════════════════════════════════════════════════════════════════ */
  function movingAverage(vals, win) {
    var out = [], sum = 0;
    for (var i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= win) sum -= vals[i - win];
      out.push(i >= win - 1 ? sum / win : null);
    }
    return out;
  }
  function dailyReturns(points) {
    var out = [];
    for (var i = 1; i < points.length; i++) {
      var prev = points[i - 1].value;
      if (prev) out.push({ date: points[i].date, r: (points[i].value - prev) / prev * 100 });
    }
    return out;
  }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function stdev(a) {
    if (a.length < 2) return null;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1));
  }
  function correlation(a, b) {
    var n = Math.min(a.length, b.length);
    if (n < 3) return null;
    a = a.slice(-n); b = b.slice(-n);
    var ma = mean(a), mb = mean(b), num = 0, da = 0, db = 0;
    for (var i = 0; i < n; i++) {
      var xa = a[i] - ma, xb = b[i] - mb;
      num += xa * xb; da += xa * xa; db += xb * xb;
    }
    return (da && db) ? num / Math.sqrt(da * db) : null;
  }
  // Largest peak-to-trough fall inside the window, and how far below the
  // window's running peak the latest close sits.
  function drawdown(points) {
    if (!points || points.length < 2) return null;
    var peak = points[0].value, worst = 0, peakDate = points[0].date, worstAt = null;
    points.forEach(function (p) {
      if (p.value > peak) { peak = p.value; peakDate = p.date; }
      var dd = (p.value - peak) / peak * 100;
      if (dd < worst) { worst = dd; worstAt = { from: peakDate, to: p.date }; }
    });
    var last = points[points.length - 1].value;
    var runningPeak = Math.max.apply(null, points.map(function (p) { return p.value; }));
    return { max: worst, at: worstAt, current: (last - runningPeak) / runningPeak * 100, peak: runningPeak };
  }
  function yearFraction(points) {
    var a = new Date(points[0].date + 'T00:00:00Z');
    var b = new Date(points[points.length - 1].date + 'T00:00:00Z');
    var days = (b - a) / 86400000;
    return days > 0 ? days / 365.25 : null;
  }
  // Longest and current run of consecutive up or down closes.
  function streaks(points) {
    var rets = dailyReturns(points);
    if (!rets.length) return null;
    var cur = 0, curDir = 0, bestUp = 0, bestDown = 0;
    rets.forEach(function (x) {
      var dir = x.r > 0 ? 1 : x.r < 0 ? -1 : 0;
      if (dir === 0) { cur = 0; curDir = 0; return; }
      if (dir === curDir) cur++; else { curDir = dir; cur = 1; }
      if (dir > 0) bestUp = Math.max(bestUp, cur); else bestDown = Math.max(bestDown, cur);
    });
    var up = rets.filter(function (x) { return x.r > 0; }).length;
    return { current: cur, dir: curDir, bestUp: bestUp, bestDown: bestDown,
             up: up, down: rets.length - up, total: rets.length };
  }
  // Calendar-month returns, first close to last close within each month.
  function monthlyReturns(points) {
    var byMonth = {};
    points.forEach(function (p) {
      var k = p.date.slice(0, 7);
      if (!byMonth[k]) byMonth[k] = { first: p.value, last: p.value };
      else byMonth[k].last = p.value;
    });
    return Object.keys(byMonth).sort().map(function (k) {
      var m = byMonth[k];
      return { month: k, r: m.first ? (m.last - m.first) / m.first * 100 : null };
    });
  }
  function focusedIndex() {
    var m = state.markets;
    if (!m) return null;
    var keys = Object.keys(m.indices).filter(function (k) { return m.indices[k].available; });
    if (!keys.length) return null;
    var k = keys.indexOf(state.focus) > -1 ? state.focus : keys[0];
    return { key: k, ix: m.indices[k] };
  }
  // The window the user is actually looking at, honouring drag-zoom.
  function visiblePoints(ix) {
    var pts = ix.points || [];
    if (state.zoom) return pts.slice(state.zoom.from, state.zoom.to + 1);
    return pts;
  }

  /* ── FEATURE 4: sparkline for a metric card ────────────────────────────── */
  function sparkline(points, color) {
    if (!points || points.length < 2) return '';
    var vals = points.map(function (p) { return p.value; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (min === max) { min -= 1; max += 1; }
    var d = points.map(function (p, i) {
      var x = (i / (points.length - 1)) * 100;
      var y = 24 - ((p.value - min) / (max - min)) * 22 - 1;
      return (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
    }).join(' ');
    return '<svg class="econ-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">' +
           '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.6"/></svg>';
  }

  // Series colours live in CSS so they can differ per theme. They are applied as
  // inline SVG attributes, which CSS variables cannot reach once drawn, so the
  // values are read at render time and every chart is redrawn on a theme change
  // (same pattern as the NOMINATE tile tint in core.js).
  function indexColor(key) {
    var v = getComputedStyle(document.documentElement)
      .getPropertyValue('--econ-series-' + key).trim();
    return v || '#1d63d1';
  }
  var INDEX_COLORS = {
    get sp500() { return indexColor('sp500'); },
    get dow() { return indexColor('dow'); },
    get nasdaq() { return indexColor('nasdaq'); }
  };

  /* ── index cards (FEATURES 3, 4, 20) ───────────────────────────────────── */
  function renderIndexCards() {
    var host = document.getElementById('econ-indices');
    if (!host) return;
    var m = state.markets;
    if (!m) {
      host.innerHTML = '<div class="econ-card econ-card--empty">Market data could not be loaded.</div>';
      return;
    }
    host.innerHTML = Object.keys(m.indices).map(function (key) {
      var ix = m.indices[key];
      if (!ix.available) {
        return '<article class="econ-card econ-card--empty"><h3>' + esc(ix.label) + '</h3>' +
               '<p class="econ-card-note">' + esc(ix.reason || 'Unavailable.') + '</p></article>';
      }
      var dir = ix.change_percent > 0 ? 'up' : ix.change_percent < 0 ? 'down' : 'flat';
      return '<article class="econ-card econ-card--index is-' + dir + '" data-index="' + esc(key) + '" tabindex="0">' +
        '<div class="econ-card-top"><h3>' + esc(ix.label) + '</h3>' +
        '<span class="econ-sym">' + esc(ix.symbol) + '</span></div>' +
        '<p class="econ-value">' + esc(num(ix.latest, 2)) + '</p>' +
        '<p class="econ-delta">' + esc((ix.change >= 0 ? '+' : '') + num(ix.change, 2)) +
        ' <span>(' + esc(pct(ix.change_percent)) + ')</span> <em>on ' + esc(shortDate(ix.latest_date)) + '</em></p>' +
        sparkline(ix.points.slice(-60), INDEX_COLORS[key] || '#1d63d1') +
        '<dl class="econ-mini"><div><dt>Range</dt><dd>' + esc(pct(ix.range_change_percent)) + '</dd></div>' +
        '<div><dt>High</dt><dd>' + esc(num(ix.period_high, 0)) + '</dd></div>' +
        '<div><dt>Low</dt><dd>' + esc(num(ix.period_low, 0)) + '</dd></div></dl>' +
        '<p class="econ-provider">via ' + esc(ix.provider === 'fred' ? 'FRED (St. Louis Fed)' : 'market data provider') + '</p>' +
        '</article>';
    }).join('');

    // FEATURE 9: selecting a card focuses that index in the main chart
    host.querySelectorAll('.econ-card--index').forEach(function (card) {
      function pick() {
        state.compare = false;
        state.focus = card.dataset.index;
        writeUrlState(false);
        // Every statistic below the chart is index-specific, so redraw them all.
        renderAll();
        toast(m.indices[card.dataset.index].label + ' shown');
      }
      card.addEventListener('click', pick);
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
  }

  /* ── main chart + controls (FEATURES 2, 5, 6) ──────────────────────────── */
  function renderMainChart() {
    var host = document.getElementById('econ-chart');
    var titleEl = document.getElementById('econ-chart-title');
    if (!host || !state.markets) return;
    var m = state.markets;
    var keys = Object.keys(m.indices).filter(function (k) { return m.indices[k].available; });
    if (!keys.length) {
      host.innerHTML = '<p class="econ-chart-empty">No index data available right now.</p>';
      return;
    }
    var chosen = state.compare ? keys : [keys.indexOf(state.focus) > -1 ? state.focus : keys[0]];
    var series = chosen.map(function (k) {
      return { key: k, label: m.indices[k].label, color: INDEX_COLORS[k] || '#1d63d1',
               points: visiblePoints(m.indices[k]) };
    });
    if (titleEl) {
      titleEl.textContent = state.compare
        ? 'All indices, ' + (state.mode === 'percent' ? 'percent change' : 'index level')
        : series[0].label;
    }
    renderChart(host, series, {
      ariaLabel: (state.compare ? 'All indices' : series[0].label) + ', ' + state.range + ' history',
      height: 300,
      log: state.logScale,
      ma: state.ma,
      // FEATURE 23: a drag maps back to absolute indices in the full series, so
      // zooms compose instead of resetting the window each time.
      onBrush: function (from, to) {
        var base = state.zoom ? state.zoom.from : 0;
        state.zoom = { from: base + from, to: base + to };
        renderAll();
        toast('Zoomed to ' + (to - from + 1) + ' trading days');
      }
    });
    var zoomBtn = document.querySelector('[data-econ-zoomreset]');
    if (zoomBtn) zoomBtn.hidden = !state.zoom;
    // comparison only makes sense rebased; nudge the mode toggle to match
    var modeBtn = document.querySelector('[data-econ-mode]');
    if (modeBtn) modeBtn.textContent = state.mode === 'percent' ? '% change' : 'Index level';
  }

  /* ── FEATURE 7: day-by-day table ───────────────────────────────────────── */
  function renderDayTable() {
    var host = document.getElementById('econ-daily');
    if (!host || !state.markets) return;
    var m = state.markets;
    var keys = Object.keys(m.indices).filter(function (k) { return m.indices[k].available; });
    if (!keys.length) { host.innerHTML = ''; return; }
    var byDate = {};
    keys.forEach(function (k) {
      m.indices[k].points.forEach(function (p) {
        (byDate[p.date] = byDate[p.date] || {})[k] = p.value;
      });
    });
    var prevOf = {};
    keys.forEach(function (k) {
      var pts = m.indices[k].points;
      pts.forEach(function (p, i) { if (i) prevOf[k + '|' + p.date] = pts[i - 1].value; });
    });

    // FEATURE 39: sort by any column, and show 30 / 90 / every row in the range.
    var all = Object.keys(byDate);
    var sort = state.tableSort;
    all.sort(function (a, b) {
      if (sort.col === 'date') return a < b ? -sort.dir : a > b ? sort.dir : 0;
      var va = byDate[a][sort.col], vb = byDate[b][sort.col];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * sort.dir;
    });
    var total = all.length;
    var shown = state.tableRows === 'all' ? total : Math.min(state.tableRows, total);
    var dates = all.slice(0, shown);

    function th(col, label) {
      var on = sort.col === col;
      return '<th scope="col" class="econ-th-sort' + (on ? ' is-sorted' : '') + '">' +
        '<button type="button" data-sort="' + esc(col) + '" aria-label="Sort by ' + esc(label) + '">' +
        esc(label) + '<span class="econ-caret" aria-hidden="true">' +
        (on ? (sort.dir > 0 ? '▲' : '▼') : '↕') + '</span></button></th>';
    }
    host.innerHTML =
      '<div class="econ-table-scroll"><table class="econ-table econ-table--sticky">' +
      '<caption>Daily closes &mdash; ' + shown + ' of ' + total + ' trading days in this range</caption>' +
      '<thead><tr>' + th('date', 'Date') +
      keys.map(function (k) { return th(k, m.indices[k].label); }).join('') +
      '</tr></thead><tbody>' +
      dates.map(function (d) {
        return '<tr><th scope="row">' + esc(shortDate(d)) + '</th>' + keys.map(function (k) {
          var v = byDate[d][k];
          if (v == null) return '<td>—</td>';
          var prev = prevOf[k + '|' + d];
          var ch = prev == null ? null : (v - prev) / prev * 100;
          var cls = ch == null ? '' : ch > 0 ? ' class="is-up"' : ch < 0 ? ' class="is-down"' : '';
          return '<td' + cls + '>' + esc(num(v, 2)) +
                 (ch == null ? '' : ' <span class="econ-cell-delta">' + esc(pct(ch)) + '</span>') + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>' +
      (total > 30 ? '<div class="econ-table-more">' +
        [30, 90, 'all'].map(function (n) {
          return '<button type="button" class="econ-btn econ-btn--sm' +
            (state.tableRows === n ? ' is-on' : '') + '" data-rows="' + n + '">' +
            (n === 'all' ? 'All ' + total : 'Show ' + n) + '</button>';
        }).join('') + '</div>' : '');

    host.querySelectorAll('[data-sort]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var col = btn.dataset.sort;
        if (state.tableSort.col === col) state.tableSort.dir *= -1;
        else state.tableSort = { col: col, dir: col === 'date' ? -1 : 1 };
        renderDayTable();
      });
    });
    host.querySelectorAll('[data-rows]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.dataset.rows;
        state.tableRows = v === 'all' ? 'all' : parseInt(v, 10);
        renderDayTable();
      });
    });
  }

  /* ── macro metric cards (FEATURES 16, 17) ──────────────────────────────── */
  var METRIC_LABELS = {
    debt: 'National debt', gdp: 'GDP', population: 'Population',
    unemployment: 'Unemployment rate', inflation: 'Inflation (CPI, yr/yr)',
    debt_to_gdp: 'Debt as % of GDP', debt_per_capita: 'Debt per person'
  };
  function metricValue(key, m) {
    if (!m) return '—';
    if (key === 'debt') return compact(Number(m.amount));
    if (key === 'gdp') return compact(m.value);
    if (key === 'population') return num(m.value, 0);
    if (key === 'unemployment' || key === 'inflation' || key === 'debt_to_gdp')
      return num(m.value, 1) + '%';
    if (key === 'debt_per_capita') return compact(m.value);
    return m.value != null ? num(m.value, 2) : '—';
  }
  function renderMetrics() {
    var host = document.getElementById('econ-metrics');
    if (!host) return;
    var snap = state.economy;
    if (!snap || !snap.metrics) {
      host.innerHTML = '<div class="econ-card econ-card--empty">Economic indicators could not be loaded.</div>';
      return;
    }
    var q = state.query.trim().toLowerCase();
    var keys = Object.keys(METRIC_LABELS).filter(function (k) {
      if (!snap.metrics[k]) return false;
      return !q || METRIC_LABELS[k].toLowerCase().indexOf(q) > -1;
    });
    // pinned first
    keys.sort(function (a, b) {
      var pa = state.pinned.indexOf(a) > -1, pb = state.pinned.indexOf(b) > -1;
      return pa === pb ? 0 : pa ? -1 : 1;
    });
    if (!keys.length) {
      host.innerHTML = '<p class="econ-card-note">No indicator matches “' + esc(state.query) + '”.</p>';
      return;
    }
    host.innerHTML = keys.map(function (k) {
      var m = snap.metrics[k];
      var pinned = state.pinned.indexOf(k) > -1;
      var asOf = m && (m.date || m.record_date || m.period);
      return '<article class="econ-card econ-card--metric' + (pinned ? ' is-pinned' : '') + '">' +
        '<div class="econ-card-top"><h3>' + esc(METRIC_LABELS[k]) + '</h3>' +
        '<button type="button" class="econ-pin" data-pin="' + esc(k) + '" aria-pressed="' + pinned + '" ' +
        'aria-label="' + (pinned ? 'Unpin' : 'Pin') + ' ' + esc(METRIC_LABELS[k]) + '">' + (pinned ? '★' : '☆') + '</button></div>' +
        '<p class="econ-value">' + esc(metricValue(k, m)) + '</p>' +
        (asOf ? '<p class="econ-asof">as of ' + esc(shortDate(asOf)) + '</p>' : '') +
        '</article>';
    }).join('');

    host.querySelectorAll('[data-pin]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var k = btn.dataset.pin, at = state.pinned.indexOf(k);
        if (at > -1) state.pinned.splice(at, 1); else state.pinned.push(k);
        writeJson('ygn-econ-pinned', state.pinned);
        renderMetrics();
        toast(at > -1 ? 'Unpinned' : 'Pinned to top');
      });
    });
  }

  /* ── FEATURES 26-29, 33: the at-a-glance statistics strip ──────────────── */
  function renderStats() {
    var host = document.getElementById('econ-stats');
    if (!host) return;
    var f = focusedIndex();
    if (!f) { host.innerHTML = ''; return; }
    var pts = visiblePoints(f.ix);
    if (pts.length < 2) { host.innerHTML = ''; return; }

    var rets = dailyReturns(pts).map(function (x) { return x.r; });
    var first = pts[0].value, last = pts[pts.length - 1].value;
    var total = (last - first) / first * 100;
    var yrs = yearFraction(pts);
    // CAGR is only honest over a span long enough to annualise; under ~3 months
    // it explodes into a meaningless number, so it is withheld.
    var cagr = (yrs && yrs >= 0.25 && first > 0) ? (Math.pow(last / first, 1 / yrs) - 1) * 100 : null;
    var sd = stdev(rets);
    var vol = sd == null ? null : sd * Math.sqrt(252);   // trading days per year
    var dd = drawdown(pts);
    var st = streaks(pts);
    var lo = Math.min.apply(null, pts.map(function (p) { return p.value; }));
    var hi = Math.max.apply(null, pts.map(function (p) { return p.value; }));
    var posPct = hi > lo ? (last - lo) / (hi - lo) * 100 : 50;

    function stat(label, value, cls, note) {
      return '<div class="econ-stat' + (cls ? ' ' + cls : '') + '">' +
             '<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>' +
             (note ? '<p class="econ-stat-note">' + esc(note) + '</p>' : '') + '</div>';
    }
    var dirCls = total > 0 ? 'is-up' : total < 0 ? 'is-down' : '';
    var html = '<dl class="econ-stats">' +
      stat('Total return', pct(total), dirCls, shortDate(pts[0].date) + ' to ' + shortDate(pts[pts.length - 1].date)) +
      (cagr == null ? '' : stat('Annualised', pct(cagr), cagr > 0 ? 'is-up' : 'is-down', 'compound rate over ' + yrs.toFixed(1) + ' years')) +
      (vol == null ? '' : stat('Volatility', vol.toFixed(1) + '%', '', 'annualised, from ' + rets.length + ' daily moves')) +
      (dd == null ? '' : stat('Deepest fall', pct(dd.max), 'is-down',
        dd.at ? shortDate(dd.at.from) + ' to ' + shortDate(dd.at.to) : 'peak to trough in window')) +
      // At a window high, "below peak +0.00%" reads as a contradiction; say it plainly.
      (dd == null ? '' : (dd.current > -0.005
        ? stat('Versus peak', 'At the high', 'is-up', 'the latest close is the highest in this window')
        : stat('Below peak', pct(dd.current), 'is-down', 'versus the highest close in this window'))) +
      (st == null ? '' : stat('Up days', st.up + ' of ' + st.total, '',
        Math.round(st.up / st.total * 100) + '% closed higher')) +
      (st == null || !st.current ? '' : stat('Current streak', st.current + (st.dir > 0 ? ' up' : ' down'),
        st.dir > 0 ? 'is-up' : 'is-down', 'longest here: ' + st.bestUp + ' up, ' + st.bestDown + ' down')) +
      '</dl>' +
      // FEATURE 33: where the latest close sits between the window's low and high
      '<div class="econ-gauge"><div class="econ-gauge-bar"><span class="econ-gauge-fill" style="width:' +
      posPct.toFixed(1) + '%"></span><span class="econ-gauge-pin" style="left:' + posPct.toFixed(1) + '%"></span></div>' +
      '<div class="econ-gauge-ends"><span>' + esc(num(lo, 0)) + '</span>' +
      '<strong>' + esc(num(last, 2)) + ' &middot; ' + posPct.toFixed(0) + '% of range</strong>' +
      '<span>' + esc(num(hi, 0)) + '</span></div></div>';
    host.innerHTML = html;
  }

  /* ── FEATURE 25: the biggest single-day moves in the window ────────────── */
  function renderBiggestMoves() {
    var host = document.getElementById('econ-moves');
    if (!host) return;
    var f = focusedIndex();
    if (!f) { host.innerHTML = ''; return; }
    var rets = dailyReturns(visiblePoints(f.ix));
    if (rets.length < 4) { host.innerHTML = ''; return; }
    var sorted = rets.slice().sort(function (a, b) { return b.r - a.r; });
    var top = sorted.slice(0, 5);
    var bottom = sorted.slice(-5).reverse();
    function list(rows, cls) {
      return '<ol class="econ-move-list">' + rows.map(function (x) {
        return '<li><span class="econ-move-date">' + esc(shortDate(x.date)) + '</span>' +
               '<span class="econ-move-val ' + cls + '">' + esc(pct(x.r)) + '</span></li>';
      }).join('') + '</ol>';
    }
    host.innerHTML =
      '<div class="econ-moves-grid">' +
      '<div><h3 class="econ-sub">Best days</h3>' + list(top, 'is-up') + '</div>' +
      '<div><h3 class="econ-sub">Worst days</h3>' + list(bottom, 'is-down') + '</div>' +
      '</div><p class="econ-note">' + esc(f.ix.label) + ', largest one-day closes in the selected window.</p>';
  }

  /* ── FEATURE 30: how closely the indices move together ─────────────────── */
  function renderCorrelation() {
    var host = document.getElementById('econ-corr');
    if (!host) return;
    var m = state.markets;
    if (!m) { host.innerHTML = ''; return; }
    var keys = Object.keys(m.indices).filter(function (k) { return m.indices[k].available; });
    if (keys.length < 2) { host.innerHTML = ''; return; }
    var series = {};
    keys.forEach(function (k) {
      series[k] = dailyReturns(visiblePoints(m.indices[k])).map(function (x) { return x.r; });
    });
    var rows = keys.map(function (a) {
      return '<tr><th scope="row">' + esc(m.indices[a].label) + '</th>' + keys.map(function (b) {
        if (a === b) return '<td class="econ-corr-self">1.00</td>';
        var c = correlation(series[a], series[b]);
        if (c == null) return '<td>—</td>';
        var bucket = c >= 0.9 ? 4 : c >= 0.75 ? 3 : c >= 0.5 ? 2 : c >= 0.25 ? 1 : 0;
        return '<td class="econ-corr-c' + bucket + '">' + c.toFixed(2) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    host.innerHTML =
      '<table class="econ-table econ-corr-table"><caption>Correlation of daily moves in this window</caption>' +
      '<thead><tr><td></td>' + keys.map(function (k) {
        return '<th scope="col">' + esc(m.indices[k].label) + '</th>';
      }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="econ-note">1.00 means the two moved in lockstep day to day; 0 means no linear relationship. ' +
      'Broad U.S. indices overlap heavily in their holdings, so high values are expected.</p>';
  }

  /* ── FEATURE 31: month-by-month returns ────────────────────────────────── */
  function renderMonthlyGrid() {
    var host = document.getElementById('econ-monthly');
    if (!host) return;
    var f = focusedIndex();
    if (!f) { host.innerHTML = ''; return; }
    var rows = monthlyReturns(visiblePoints(f.ix));
    if (rows.length < 2) { host.innerHTML = ''; return; }
    var byYear = {};
    rows.forEach(function (r) {
      var y = r.month.slice(0, 4), mo = parseInt(r.month.slice(5, 7), 10);
      (byYear[y] = byYear[y] || {})[mo] = r.r;
    });
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function bucket(v) {
      if (v == null) return '';
      var a = Math.abs(v);
      var n = a >= 6 ? 4 : a >= 3 ? 3 : a >= 1.5 ? 2 : a >= 0.4 ? 1 : 0;
      if (!n) return ' class="econ-m0"';
      return ' class="econ-m' + (v > 0 ? 'u' : 'd') + n + '"';
    }
    host.innerHTML =
      '<table class="econ-table econ-month-table"><caption>' + esc(f.ix.label) +
      ' &mdash; return within each calendar month</caption><thead><tr><th scope="col">Year</th>' +
      MON.map(function (m) { return '<th scope="col">' + m + '</th>'; }).join('') +
      '<th scope="col">Year</th></tr></thead><tbody>' +
      Object.keys(byYear).sort().reverse().map(function (y) {
        var vals = [];
        var cells = MON.map(function (_, i) {
          var v = byYear[y][i + 1];
          if (v == null) return '<td class="econ-mna">·</td>';
          vals.push(v);
          return '<td' + bucket(v) + '>' + (v >= 0 ? '+' : '') + v.toFixed(1) + '</td>';
        }).join('');
        // Compounded, not summed -- monthly returns chain multiplicatively.
        var yr = vals.length ? (vals.reduce(function (acc, v) { return acc * (1 + v / 100); }, 1) - 1) * 100 : null;
        return '<tr><th scope="row">' + y + '</th>' + cells +
               '<td class="econ-myear' + (yr > 0 ? ' is-up' : yr < 0 ? ' is-down' : '') + '">' +
               (yr == null ? '—' : (yr >= 0 ? '+' : '') + yr.toFixed(1)) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="econ-note">Percent change from the first to the last close in each month. ' +
      'Partial months at the edges of the window are shown as measured, not annualised.</p>';
  }

  /* ── FEATURE 32: distribution of daily moves ───────────────────────────── */
  function renderHistogram() {
    var host = document.getElementById('econ-hist');
    if (!host) return;
    var f = focusedIndex();
    if (!f) { host.innerHTML = ''; return; }
    var rets = dailyReturns(visiblePoints(f.ix)).map(function (x) { return x.r; });
    if (rets.length < 20) { host.innerHTML = ''; return; }
    var edges = [-Infinity, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, Infinity];
    var labels = ['< -3', '-3 to -2', '-2 to -1', '-1 to -0.5', '-0.5 to 0',
                  '0 to 0.5', '0.5 to 1', '1 to 2', '2 to 3', '> 3'];
    var counts = labels.map(function () { return 0; });
    rets.forEach(function (r) {
      for (var i = 0; i < counts.length; i++) {
        if (r > edges[i] && r <= edges[i + 1]) { counts[i]++; return; }
      }
    });
    var maxC = Math.max.apply(null, counts) || 1;
    var W = 900, H = 190, padL = 34, padB = 46, padT = 10;
    var innerW = W - padL - 12, innerH = H - padT - padB;
    var bw = innerW / counts.length;
    var bars = counts.map(function (c, i) {
      var h = (c / maxC) * innerH;
      var bx = padL + i * bw + 3, by = padT + innerH - h;
      var cls = i < 5 ? 'is-down' : 'is-up';
      return '<rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + (bw - 6).toFixed(1) +
             '" height="' + Math.max(h, c ? 1 : 0).toFixed(1) + '" class="econ-bar ' + cls + '"></rect>' +
             (c ? '<text x="' + (bx + (bw - 6) / 2).toFixed(1) + '" y="' + (by - 3).toFixed(1) +
                  '" class="econ-axis" text-anchor="middle">' + c + '</text>' : '') +
             '<text x="' + (bx + (bw - 6) / 2).toFixed(1) + '" y="' + (H - padB + 16) +
             '" class="econ-axis econ-bar-label" text-anchor="middle">' + esc(labels[i]) + '</text>';
    }).join('');
    var avg = mean(rets), sd = stdev(rets);
    host.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" class="econ-hist-svg" role="img" aria-label="Distribution of daily percent moves">' +
      '<line x1="' + padL + '" x2="' + (W - 12) + '" y1="' + (padT + innerH) + '" y2="' + (padT + innerH) + '" class="econ-grid"></line>' +
      bars + '</svg>' +
      '<p class="econ-note">' + esc(f.ix.label) + ': how ' + rets.length +
      ' daily moves were distributed, in percent. Average ' + esc(pct(avg)) +
      (sd == null ? '' : ', typical swing ' + esc(sd.toFixed(2) + '%')) + '.</p>';
  }

  /* ── FEATURE 34: the index across administrations ──────────────────────────
     Term boundaries are a matter of public record. Attribution is not: markets
     respond to far more than who holds the office, so this is presented as
     "what the index did during" and explicitly not as a presidential scorecard. */
  var TERMS = [
    { name: 'Obama, 2nd term', start: '2013-01-20', end: '2017-01-20' },
    { name: 'Trump, 1st term', start: '2017-01-20', end: '2021-01-20' },
    { name: 'Biden', start: '2021-01-20', end: '2025-01-20' },
    { name: 'Trump, 2nd term', start: '2025-01-20', end: null }
  ];
  function renderTerms() {
    var host = document.getElementById('econ-terms');
    if (!host) return;
    var f = focusedIndex();
    if (!f) { host.innerHTML = ''; return; }
    var pts = f.ix.points || [];
    if (pts.length < 2) { host.innerHTML = ''; return; }
    var dataStart = pts[0].date, dataEnd = pts[pts.length - 1].date;
    var rows = TERMS.map(function (t) {
      var end = t.end || dataEnd;
      var within = pts.filter(function (p) { return p.date >= t.start && p.date <= end; });
      if (within.length < 2) return null;
      var a = within[0], b = within[within.length - 1];
      var partial = a.date > t.start || (t.end && b.date < t.end && dataEnd < t.end);
      var covered = t.start < dataStart;
      return {
        name: t.name, r: (b.value - a.value) / a.value * 100,
        from: a.date, to: b.date, partial: partial || covered, ongoing: !t.end
      };
    }).filter(Boolean);
    if (!rows.length) { host.innerHTML = ''; return; }
    host.innerHTML =
      '<table class="econ-table"><caption>' + esc(f.ix.label) +
      ' during each administration, over the data this page holds</caption>' +
      '<thead><tr><th scope="col">Administration</th><th scope="col">Change</th>' +
      '<th scope="col">Measured between</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><th scope="row">' + esc(r.name) + (r.ongoing ? ' <em>(in progress)</em>' : '') + '</th>' +
          '<td class="' + (r.r > 0 ? 'is-up' : r.r < 0 ? 'is-down' : '') + '">' + esc(pct(r.r)) + '</td>' +
          '<td>' + esc(shortDate(r.from)) + ' &ndash; ' + esc(shortDate(r.to)) +
          (r.partial ? ' <span class="econ-flag">partial</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="econ-note"><strong>This is not a scorecard.</strong> Index levels respond to interest rates, ' +
      'company earnings, global events and much else that no single office controls. Rows marked ' +
      '<span class="econ-flag">partial</span> begin or end where this page&rsquo;s data does, not where the term did &mdash; ' +
      'switch to the 5Y range for the fullest span available.</p>';
  }

  /* ── FEATURES 35, 37: fiscal context around the debt figure ────────────── */
  function renderFiscal() {
    var host = document.getElementById('econ-fiscal');
    if (!host) return;
    var snap = state.economy;
    if (!snap || !snap.metrics || !snap.metrics.debt) { host.innerHTML = ''; return; }
    var debt = Number(snap.metrics.debt.amount);
    var perDay = debtPerSecond() * 86400;
    var cards = [];

    // FEATURE 35: next round-trillion crossing, projected from the measured rate
    if (perDay > 0 && isFinite(debt)) {
      var next = (Math.floor(debt / 1e12) + 1) * 1e12;
      var days = (next - debt) / perDay;
      var when = new Date(Date.now() + days * 86400000);
      cards.push({
        label: 'Next trillion',
        value: '$' + (next / 1e12).toFixed(0) + 'T',
        note: 'on this trend, around ' + when.toLocaleDateString('en-US',
          { month: 'long', year: 'numeric' }) + ' (~' + Math.round(days) + ' days)'
      });
    }

    // FEATURE 37: how far through the federal fiscal year we are (Oct 1 - Sep 30)
    var now = new Date();
    var fyStartYear = now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    var fyStart = Date.UTC(fyStartYear, 9, 1), fyEnd = Date.UTC(fyStartYear + 1, 8, 30);
    var through = Math.max(0, Math.min(1, (now.getTime() - fyStart) / (fyEnd - fyStart)));
    cards.push({
      label: 'Fiscal year ' + (fyStartYear + 1),
      value: Math.round(through * 100) + '% elapsed',
      note: 'runs 1 Oct ' + fyStartYear + ' to 30 Sep ' + (fyStartYear + 1),
      bar: through
    });

    if (snap.metrics.debt_per_capita) {
      cards.push({
        label: 'Debt per person',
        value: compact(snap.metrics.debt_per_capita.value),
        note: 'total debt divided by the population figure below'
      });
    }
    if (perDay > 0) {
      cards.push({
        label: 'Added per day',
        value: compact(perDay),
        note: 'measured from Treasury’s own daily series, not assumed'
      });
    }

    host.innerHTML = cards.map(function (c) {
      return '<article class="econ-card econ-card--fiscal"><h3>' + esc(c.label) + '</h3>' +
        '<p class="econ-value">' + esc(c.value) + '</p>' +
        (c.bar != null ? '<div class="econ-progress"><span style="width:' + (c.bar * 100).toFixed(1) + '%"></span></div>' : '') +
        '<p class="econ-card-note">' + esc(c.note) + '</p></article>';
    }).join('');
  }

  /* ── FEATURE 36: the debt itself, drawn ────────────────────────────────── */
  function renderDebtChart() {
    var host = document.getElementById('econ-debt-chart');
    if (!host) return;
    var trend = state.economy && state.economy.metrics && state.economy.metrics.debt_trend;
    var pts = trend && (trend.points || trend.series || trend.history);
    if (!Array.isArray(pts) || pts.length < 3) {
      host.innerHTML = '';
      var block = document.getElementById('econ-debt-chart-block');
      if (block) block.hidden = true;
      return;
    }
    var series = [{
      key: 'debt', label: 'Total public debt', color: indexColor('debt'),
      points: pts.map(function (p) {
        return { date: (p.date || p.record_date || '').slice(0, 10),
                 value: Number(p.amount != null ? p.amount : p.value) };
      }).filter(function (p) { return p.date && isFinite(p.value); })
    }];
    if (series[0].points.length < 3) { host.innerHTML = ''; return; }
    var prevMode = state.mode;
    state.mode = 'value';                 // the debt chart is always a level
    renderChart(host, series, { ariaLabel: 'Total public debt over time', height: 220, markExtremes: false });
    state.mode = prevMode;
  }

  /* ── FEATURE 38: what the window did to a fixed starting amount ────────── */
  function renderGrowth() {
    var host = document.getElementById('econ-growth');
    if (!host) return;
    var f = focusedIndex();
    if (!f) { host.innerHTML = ''; return; }
    var pts = visiblePoints(f.ix);
    if (pts.length < 2) { host.innerHTML = ''; return; }
    var first = pts[0].value, last = pts[pts.length - 1].value;
    if (!first) { host.innerHTML = ''; return; }
    var start = 10000;
    var end = start * (last / first);
    var diff = end - start;
    host.innerHTML =
      '<p class="econ-growth-line">If the ' + esc(f.ix.label) +
      ' had been tracked exactly, <strong>$' + num(start, 0) + '</strong> on ' +
      esc(shortDate(pts[0].date)) + ' would read <strong class="' +
      (diff >= 0 ? 'is-up' : 'is-down') + '">$' + esc(num(end, 0)) + '</strong> on ' +
      esc(shortDate(pts[pts.length - 1].date)) + ' &mdash; a change of ' +
      '<span class="' + (diff >= 0 ? 'is-up' : 'is-down') + '">' +
      (diff >= 0 ? '+' : '−') + '$' + esc(num(Math.abs(diff), 0)) + '</span>.</p>' +
      '<p class="econ-note">Arithmetic on the closes shown above, nothing more. It excludes dividends, ' +
      'fees and taxes, no index can be bought directly, and past movement does not indicate future ' +
      'movement. This is context, not advice.</p>';
  }

  // Shared by the debt clock and the fiscal cards so both quote one rate.
  function debtPerSecond() {
    var snap = state.economy;
    var trend = snap && snap.metrics && snap.metrics.debt_trend;
    var pts = trend && (trend.points || trend.series || trend.history);
    if (!Array.isArray(pts) || pts.length < 2) return 0;
    var a = pts[0], b = pts[pts.length - 1];
    var av = Number(a.amount != null ? a.amount : a.value);
    var bv = Number(b.amount != null ? b.amount : b.value);
    var ad = new Date(a.date || a.record_date), bd = new Date(b.date || b.record_date);
    var secs = (bd - ad) / 1000;
    return (isFinite(av) && isFinite(bv) && secs > 0) ? (bv - av) / secs : 0;
  }

  /* ── FEATURE 8: debt counter that ticks from a real growth rate ────────── */
  function startDebtTicker() {
    var node = document.getElementById('econ-debt-live');
    if (!node || !state.economy) return;
    var debt = state.economy.metrics && state.economy.metrics.debt;
    if (!debt) { node.closest('.econ-debtclock') && (node.closest('.econ-debtclock').hidden = true); return; }
    var amount = Number(debt.amount);
    // Derive the rate from two real observations. No invented growth constant.
    var perSecond = debtPerSecond();
    if (debtTimer) { clearInterval(debtTimer); debtTimer = null; }
    var base = Date.now();
    var start = amount;
    function tick() {
      var v = start + perSecond * ((Date.now() - base) / 1000);
      node.textContent = compact(v);
    }
    tick();
    // Guarded against stacking: auto-refresh re-runs this every 5 minutes.
    if (perSecond) debtTimer = setInterval(tick, 1000);
    var rateEl = document.getElementById('econ-debt-rate');
    if (rateEl) {
      rateEl.textContent = perSecond
        ? 'rising about ' + compact(perSecond * 86400) + ' per day, measured from Treasury’s own daily series'
        : 'Treasury reported figure; no rate derived from the available history';
    }
  }

  /* ── FEATURES 10, 11, 18: export, share, print ─────────────────────────── */
  function currentCsv() {
    var m = state.markets;
    if (!m) return '';
    var keys = Object.keys(m.indices).filter(function (k) { return m.indices[k].available; });
    var byDate = {};
    keys.forEach(function (k) {
      m.indices[k].points.forEach(function (p) { (byDate[p.date] = byDate[p.date] || {})[k] = p.value; });
    });
    var head = ['date'].concat(keys.map(function (k) { return m.indices[k].label.replace(/,/g, ''); }));
    var rows = Object.keys(byDate).sort().map(function (d) {
      return [d].concat(keys.map(function (k) { return byDate[d][k] == null ? '' : byDate[d][k]; })).join(',');
    });
    return head.join(',') + '\n' + rows.join('\n');
  }

  /* ── FEATURE 15: auto refresh ──────────────────────────────────────────── */
  function setAutoRefresh(on) {
    state.autoRefresh = on;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (on) refreshTimer = setInterval(function () { load(true); }, 5 * 60 * 1000);
    var b = document.querySelector('[data-econ-auto]');
    if (b) { b.setAttribute('aria-pressed', String(on)); b.classList.toggle('is-on', on); }
  }

  /* ── controls ──────────────────────────────────────────────────────────── */
  function wireControls() {
    var bar = document.getElementById('econ-controls');
    if (!bar) return;
    bar.innerHTML =
      '<div class="econ-ranges" role="group" aria-label="Time range">' +
      ['1m', '3m', '6m', '1y', '5y'].map(function (r) {
        return '<button type="button" class="econ-range' + (r === state.range ? ' is-on' : '') +
               '" data-range="' + r + '">' + r.toUpperCase() + '</button>';
      }).join('') + '</div>' +
      '<button type="button" class="econ-btn" data-econ-mode>Index level</button>' +
      '<button type="button" class="econ-btn" data-econ-compare aria-pressed="' + state.compare + '">Compare all</button>' +
      // FEATURE 21
      '<button type="button" class="econ-btn' + (state.logScale ? ' is-on' : '') +
        '" data-econ-log aria-pressed="' + state.logScale + '">Log scale</button>' +
      // FEATURE 22
      '<span class="econ-ma-group" role="group" aria-label="Moving averages">' +
        [50, 200].map(function (w) {
          var on = state.ma.indexOf(w) > -1;
          return '<button type="button" class="econ-btn econ-btn--sm' + (on ? ' is-on' : '') +
                 '" data-econ-ma="' + w + '" aria-pressed="' + on + '">' + w + 'd avg</button>';
        }).join('') + '</span>' +
      // FEATURE 23
      '<button type="button" class="econ-btn" data-econ-zoomreset hidden>Reset zoom</button>' +
      '<input type="search" class="econ-search" placeholder="Filter indicators…" aria-label="Filter indicators">' +
      '<button type="button" class="econ-btn" data-econ-auto aria-pressed="false">Auto-refresh</button>' +
      '<button type="button" class="econ-btn" data-econ-csv>Export CSV</button>' +
      // FEATURE 24
      '<button type="button" class="econ-btn" data-econ-svg>Save chart</button>' +
      '<button type="button" class="econ-btn" data-econ-share>Copy link</button>' +
      '<button type="button" class="econ-btn" data-econ-print>Print</button>' +
      // FEATURE 40
      '<button type="button" class="econ-btn" data-econ-keys aria-label="Keyboard shortcuts">?</button>';

    bar.addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.range) {
        state.range = t.dataset.range;
        state.zoom = null;              // a new range invalidates any drag-zoom
        bar.querySelectorAll('.econ-range').forEach(function (b) { b.classList.toggle('is-on', b === t); });
        writeUrlState(true);
        load(true);
      } else if (t.hasAttribute('data-econ-mode')) {
        state.mode = state.mode === 'value' ? 'percent' : 'value';
        writeUrlState(false); renderMainChart();
      } else if (t.hasAttribute('data-econ-compare')) {
        state.compare = !state.compare;
        if (state.compare && state.mode === 'value') state.mode = 'percent';  // rebase to compare fairly
        t.setAttribute('aria-pressed', String(state.compare));
        t.classList.toggle('is-on', state.compare);
        writeUrlState(false); renderMainChart();
      } else if (t.hasAttribute('data-econ-log')) {
        state.logScale = !state.logScale;
        t.setAttribute('aria-pressed', String(state.logScale));
        t.classList.toggle('is-on', state.logScale);
        if (state.logScale && state.mode === 'percent') {
          state.mode = 'value';         // a log axis cannot show a series crossing zero
          toast('Log scale shows index levels');
        }
        renderMainChart();
      } else if (t.dataset.econMa) {
        var win = parseInt(t.dataset.econMa, 10);
        var at = state.ma.indexOf(win);
        if (at > -1) state.ma.splice(at, 1); else state.ma.push(win);
        writeJson('ygn-econ-ma', state.ma);
        t.setAttribute('aria-pressed', String(at === -1));
        t.classList.toggle('is-on', at === -1);
        if (state.compare) toast('Averages are drawn on a single index — turn off Compare all');
        renderMainChart();
      } else if (t.hasAttribute('data-econ-zoomreset')) {
        state.zoom = null;
        renderAll();
        toast('Showing the full ' + state.range.toUpperCase() + ' range');
      } else if (t.hasAttribute('data-econ-svg')) {
        saveChartSvg();
      } else if (t.hasAttribute('data-econ-keys')) {
        toggleShortcutHelp();
      } else if (t.hasAttribute('data-econ-auto')) {
        setAutoRefresh(!state.autoRefresh);
        toast(state.autoRefresh ? 'Auto-refresh every 5 minutes' : 'Auto-refresh off');
      } else if (t.hasAttribute('data-econ-csv')) {
        var csv = currentCsv();
        if (!csv) { toast('Nothing to export yet'); return; }
        var blob = new Blob([csv], { type: 'text/csv' });
        var a = el('a'); a.href = URL.createObjectURL(blob);
        a.download = 'ygn-indices-' + state.range + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
        toast('CSV downloaded');
      } else if (t.hasAttribute('data-econ-share')) {
        writeUrlState(false);
        if (navigator.clipboard) {
          navigator.clipboard.writeText(location.href).then(
            function () { toast('Link copied'); }, function () { toast('Could not copy'); });
        }
      } else if (t.hasAttribute('data-econ-print')) {
        window.print();
      }
    });

    var search = bar.querySelector('.econ-search');
    var deb;
    search.addEventListener('input', function () {
      clearTimeout(deb);
      deb = setTimeout(function () { state.query = search.value; renderMetrics(); }, 80);
    });

    window.addEventListener('popstate', function () { readUrlState(); state.zoom = null; load(true); });
    wireShortcuts();
  }

  /* ── FEATURE 24: save the chart exactly as drawn ───────────────────────────
     The SVG carries no styles of its own (they live in the stylesheet), so the
     handful of rules it needs are inlined into the exported copy. Without this
     the downloaded file opens as unstyled black lines on white. */
  function saveChartSvg() {
    var svg = document.querySelector('#econ-chart .econ-chart-svg');
    if (!svg) { toast('No chart to save yet'); return; }
    var clone = svg.cloneNode(true);
    var cs = getComputedStyle(document.documentElement);
    function v(name, fallback) { return (cs.getPropertyValue(name) || '').trim() || fallback; }
    var style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent =
      '.econ-grid{stroke:' + v('--color-border', '#d8dde5') + ';stroke-width:1}' +
      '.econ-axis{fill:' + v('--color-text-muted', '#5b6472') + ';font:11px Inter,system-ui,sans-serif}' +
      '.econ-line{fill:none;stroke-width:2}.econ-area{opacity:.14}' +
      '.econ-ma{fill:none;stroke-width:1.4;opacity:.75}' +
      '.econ-extreme{stroke:' + v('--color-surface', '#fff') + ';stroke-width:2}' +
      '.econ-extreme--high{fill:' + v('--econ-up', '#1a7f5a') + '}' +
      '.econ-extreme--low{fill:' + v('--econ-down', '#b3261e') + '}' +
      '.econ-cross,.econ-dot,.econ-brush{display:none}';
    clone.insertBefore(style, clone.firstChild);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    var bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%');
    bg.setAttribute('fill', v('--color-surface', '#ffffff'));
    clone.insertBefore(bg, clone.firstChild.nextSibling);

    var f = focusedIndex();
    var blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
    var a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ygn-' + (f ? f.key : 'chart') + '-' + state.range + '.svg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast('Chart saved as SVG');
  }

  /* ── FEATURE 40: keyboard shortcuts ────────────────────────────────────── */
  var SHORTCUTS = [
    ['1 / 3 / 6', 'One, three or six months'],
    ['y', 'One year'],
    ['5', 'Five years'],
    ['c', 'Compare all indices'],
    ['%', 'Switch level / percent change'],
    ['l', 'Log scale'],
    ['m', 'Cycle moving averages'],
    ['[', 'Previous index'],
    [']', 'Next index'],
    ['r', 'Reset zoom'],
    ['s', 'Save chart as SVG'],
    ['e', 'Export CSV'],
    ['?', 'This list']
  ];
  function toggleShortcutHelp() {
    var open = document.querySelector('.econ-keys');
    if (open) { open.remove(); return; }
    var box = el('div', 'econ-keys');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Keyboard shortcuts');
    box.innerHTML = '<h2>Keyboard shortcuts</h2><dl>' +
      SHORTCUTS.map(function (s) {
        return '<div><dt><kbd>' + esc(s[0]) + '</kbd></dt><dd>' + esc(s[1]) + '</dd></div>';
      }).join('') + '</dl><button type="button" class="econ-btn econ-btn--sm">Close</button>';
    box.querySelector('button').addEventListener('click', function () { box.remove(); });
    document.body.appendChild(box);
    box.querySelector('button').focus();
  }
  function cycleIndex(step) {
    var m = state.markets;
    if (!m) return;
    var keys = Object.keys(m.indices).filter(function (k) { return m.indices[k].available; });
    if (keys.length < 2) return;
    var cur = keys.indexOf(state.focus);
    if (cur < 0) cur = 0;
    var next = (cur + step + keys.length) % keys.length;
    state.focus = keys[next];
    state.compare = false;
    renderAll();
    toast(m.indices[state.focus].label + ' shown');
  }
  function wireShortcuts() {
    document.addEventListener('keydown', function (e) {
      var t = e.target, tag = (t && t.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var ranges = { '1': '1m', '3': '3m', '6': '6m', 'y': '1y', '5': '5y' };
      var k = e.key;
      if (ranges[k]) {
        e.preventDefault();
        state.range = ranges[k]; state.zoom = null;
        var btn = document.querySelector('.econ-range[data-range="' + ranges[k] + '"]');
        if (btn) {
          document.querySelectorAll('.econ-range').forEach(function (b) { b.classList.toggle('is-on', b === btn); });
        }
        writeUrlState(true); load(true);
      } else if (k === 'c') {
        e.preventDefault();
        var cb = document.querySelector('[data-econ-compare]'); if (cb) cb.click();
      } else if (k === '%') {   // shift+5 reports as '%', so it never hits the range map
        e.preventDefault();
        var mb = document.querySelector('[data-econ-mode]'); if (mb) mb.click();
      } else if (k === 'l') {
        e.preventDefault();
        var lb = document.querySelector('[data-econ-log]'); if (lb) lb.click();
      } else if (k === 'm') {
        e.preventDefault();
        // none -> 50 -> 50+200 -> none
        if (!state.ma.length) state.ma = [50];
        else if (state.ma.length === 1) state.ma = [50, 200];
        else state.ma = [];
        writeJson('ygn-econ-ma', state.ma);
        document.querySelectorAll('[data-econ-ma]').forEach(function (b) {
          var on = state.ma.indexOf(parseInt(b.dataset.econMa, 10)) > -1;
          b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on));
        });
        renderMainChart();
        toast(state.ma.length ? state.ma.join('d and ') + 'd averages' : 'Averages off');
      } else if (k === '[') { e.preventDefault(); cycleIndex(-1); }
      else if (k === ']') { e.preventDefault(); cycleIndex(1); }
      else if (k === 'r') {
        if (!state.zoom) return;
        e.preventDefault(); state.zoom = null; renderAll(); toast('Zoom reset');
      } else if (k === 's') { e.preventDefault(); saveChartSvg(); }
      else if (k === 'e') {
        e.preventDefault();
        var eb = document.querySelector('[data-econ-csv]'); if (eb) eb.click();
      } else if (k === '?') { e.preventDefault(); toggleShortcutHelp(); }
      else if (k === 'Escape') {
        var box = document.querySelector('.econ-keys'); if (box) box.remove();
      }
    });
  }

  /* ── FEATURE 19: every source, named ───────────────────────────────────── */
  function renderSources() {
    var host = document.getElementById('econ-sources');
    if (!host) return;
    var provider = null;
    if (state.markets) {
      Object.keys(state.markets.indices).some(function (k) {
        if (state.markets.indices[k].provider) { provider = state.markets.indices[k].provider; return true; }
        return false;
      });
    }
    host.innerHTML =
      '<h2>Where these numbers come from</h2><ul class="econ-source-list">' +
      '<li><strong>National debt</strong> &mdash; U.S. Treasury Fiscal Data, &ldquo;Debt to the Penny&rdquo;, updated every business day. ' +
      '<a href="https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/" target="_blank" rel="noopener">Dataset</a></li>' +
      '<li><strong>Unemployment and CPI</strong> — U.S. Bureau of Labor Statistics public API. ' +
      '<a href="https://www.bls.gov/developers/" target="_blank" rel="noopener">API</a></li>' +
      '<li><strong>GDP and population</strong> — World Bank open data. ' +
      '<a href="https://data.worldbank.org/country/US" target="_blank" rel="noopener">Source</a></li>' +
      '<li><strong>Index levels</strong> — ' +
      (provider === 'fred'
        ? 'Federal Reserve Bank of St. Louis (FRED). <a href="https://fred.stlouisfed.org/" target="_blank" rel="noopener">FRED</a>'
        : 'a public market-data endpoint. This is a fallback: set <code>FRED_API_KEY</code> to source index levels from FRED, which is the official series and is what this page prefers.') +
      '</li></ul>' +
      '<p class="econ-note">Index values are end-of-day closes, not live quotes, and are shown for context only — ' +
      'nothing here is investment advice. Where a source fails, the card says so rather than showing an estimate.</p>';
  }

  /* ── load + render ─────────────────────────────────────────────────────── */
  function setStatus(msg) {
    var s = document.getElementById('econ-status');
    if (s) { s.textContent = msg || ''; s.hidden = !msg; }
  }
  // Every panel that depends on the selected index or the zoom window. Kept in
  // one place so a zoom, an index switch and a reload all leave the page
  // internally consistent -- an early version redrew the chart alone and the
  // statistics underneath it silently described a different window.
  function renderAll() {
    guard('index cards', renderIndexCards);
    guard('chart', renderMainChart);
    guard('stats', renderStats);
    guard('biggest moves', renderBiggestMoves);
    guard('growth', renderGrowth);
    guard('correlation', renderCorrelation);
    guard('monthly grid', renderMonthlyGrid);
    guard('histogram', renderHistogram);
    guard('administrations', renderTerms);
    guard('day table', renderDayTable);
  }
  // One panel failing on unexpected upstream data must not blank the page.
  function guard(label, fn) {
    try { fn(); }
    catch (e) { if (window.console) console.warn('[ygn economy] ' + label + ' failed', e); }
  }

  async function load(quiet) {
    if (!quiet) setStatus('Loading economic data…');
    var results = await Promise.all([loadMarkets(), loadEconomy()]);
    state.markets = results[0];
    state.economy = results[1];
    setStatus('');
    renderAll();
    guard('metrics', renderMetrics);
    guard('fiscal', renderFiscal);
    guard('debt chart', renderDebtChart);
    guard('sources', renderSources);
    guard('debt ticker', startDebtTicker);
    var stamp = document.getElementById('econ-updated');
    if (stamp) {
      var when = (state.markets && state.markets.generated_at) || (state.economy && state.economy.generated_at);
      stamp.textContent = when ? 'Updated ' + new Date(when).toLocaleString('en-US') : '';
    }
  }

  function boot() {
    readUrlState();
    wireControls();
    load(false);
    // Inline SVG attributes don't follow CSS variables; redraw with the new
    // palette whenever the theme flips.
    document.addEventListener('ygn:themechange', function () {
      if (!state.markets) return;
      renderAll();
      guard('debt chart', renderDebtChart);
    });
  }
  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
