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
    economy: null
  };
  var refreshTimer = null;

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
    var min = Math.min.apply(null, all), max = Math.max.apply(null, all);
    if (min === max) { min -= 1; max += 1; }
    var pad = (max - min) * 0.08;
    min -= pad; max += pad;
    var count = shaped[0].pts.length;

    function x(i) { return padL + (count === 1 ? innerW / 2 : (i / (count - 1)) * innerW); }
    function y(v) { return padT + innerH - ((v - min) / (max - min)) * innerH; }

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

    // gridlines + y labels
    for (var g = 0; g <= 4; g++) {
      var gv = min + (max - min) * (g / 4);
      var gy = y(gv);
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

  var INDEX_COLORS = { sp500: '#2f7d66', dow: '#1d63d1', nasdaq: '#b4530a' };

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
        renderMainChart();
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
      return { key: k, label: m.indices[k].label, color: INDEX_COLORS[k] || '#1d63d1', points: m.indices[k].points };
    });
    if (titleEl) {
      titleEl.textContent = state.compare
        ? 'All indices, ' + (state.mode === 'percent' ? 'percent change' : 'index level')
        : series[0].label;
    }
    renderChart(host, series, {
      ariaLabel: (state.compare ? 'All indices' : series[0].label) + ', ' + state.range + ' history',
      height: 300
    });
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
    var dates = Object.keys(byDate).sort().reverse().slice(0, 30);
    var prevOf = {};
    keys.forEach(function (k) {
      var pts = m.indices[k].points;
      pts.forEach(function (p, i) { if (i) prevOf[k + '|' + p.date] = pts[i - 1].value; });
    });
    host.innerHTML =
      '<table class="econ-table"><caption>Daily closes, most recent first</caption><thead><tr><th scope="col">Date</th>' +
      keys.map(function (k) { return '<th scope="col">' + esc(m.indices[k].label) + '</th>'; }).join('') +
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
      }).join('') + '</tbody></table>';
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

  /* ── FEATURE 8: debt counter that ticks from a real growth rate ────────── */
  function startDebtTicker() {
    var node = document.getElementById('econ-debt-live');
    if (!node || !state.economy) return;
    var debt = state.economy.metrics && state.economy.metrics.debt;
    var trend = state.economy.metrics && state.economy.metrics.debt_trend;
    if (!debt) { node.closest('.econ-debtclock') && (node.closest('.econ-debtclock').hidden = true); return; }
    var amount = Number(debt.amount);
    var perSecond = 0;
    // Derive the rate from two real observations. No invented growth constant.
    var pts = trend && (trend.points || trend.series || trend.history);
    if (Array.isArray(pts) && pts.length > 1) {
      var a = pts[0], b = pts[pts.length - 1];
      var av = Number(a.amount != null ? a.amount : a.value), bv = Number(b.amount != null ? b.amount : b.value);
      var ad = new Date(a.date || a.record_date), bd = new Date(b.date || b.record_date);
      var secs = (bd - ad) / 1000;
      if (isFinite(av) && isFinite(bv) && secs > 0) perSecond = (bv - av) / secs;
    }
    var base = Date.now();
    var start = amount;
    function tick() {
      var v = start + perSecond * ((Date.now() - base) / 1000);
      node.textContent = compact(v);
    }
    tick();
    if (perSecond) setInterval(tick, 1000);
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
      '<input type="search" class="econ-search" placeholder="Filter indicators…" aria-label="Filter indicators">' +
      '<button type="button" class="econ-btn" data-econ-auto aria-pressed="false">Auto-refresh</button>' +
      '<button type="button" class="econ-btn" data-econ-csv>Export CSV</button>' +
      '<button type="button" class="econ-btn" data-econ-share>Copy link</button>' +
      '<button type="button" class="econ-btn" data-econ-print>Print</button>';

    bar.addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.range) {
        state.range = t.dataset.range;
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

    window.addEventListener('popstate', function () { readUrlState(); load(true); });
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
  async function load(quiet) {
    if (!quiet) setStatus('Loading economic data…');
    var results = await Promise.all([loadMarkets(), loadEconomy()]);
    state.markets = results[0];
    state.economy = results[1];
    setStatus('');
    renderIndexCards();
    renderMainChart();
    renderDayTable();
    renderMetrics();
    renderSources();
    startDebtTicker();
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
  }
  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
