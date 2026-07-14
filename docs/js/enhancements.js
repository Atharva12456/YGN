/* ========================================================================
   Site enhancements: theme, scroll-reveal, count-up, back-to-top, reading
   progress, "/" search shortcut, recently-viewed. Self-contained and guarded
   so a single failure never breaks the page. Injected chrome and animations
   are skipped on the economy page; global helpers (skip link, focus, print)
   are harmless everywhere.
   ======================================================================== */
(function () {
  'use strict';
  var docEl = document.documentElement;
  var page = (document.body && document.body.dataset.page) || '';
  var isEconomy = page === 'economy';

  function applyTheme(t) {
    if (t === 'dark') docEl.setAttribute('data-theme', 'dark');
    else docEl.removeAttribute('data-theme');
  }
  // Apply the theme immediately (deferred script runs pre-paint) to avoid a flash.
  if (!isEconomy) {
    var stored = null;
    try { stored = localStorage.getItem('ygn-theme'); } catch (e) {}
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(stored || (prefersDark ? 'dark' : 'light'));
  }

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  function guard(label, fn) {
    try { fn(); } catch (e) { if (window.console) console.warn('[ygn] ' + label + ' failed', e); }
  }

  ready(function () {
    guard('skip-link', function () {
      var main = document.getElementById('main-content');
      if (!main || document.querySelector('.skip-link')) return;
      if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
      var a = document.createElement('a');
      a.className = 'skip-link'; a.href = '#main-content'; a.textContent = 'Skip to content';
      document.body.insertBefore(a, document.body.firstChild);
    });

    guard('theme-toggle', function () {
      if (isEconomy) return;
      var header = document.querySelector('.site-header');
      if (!header || document.querySelector('.theme-toggle')) return;
      var sun = '☀', moon = '☾';
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'theme-toggle';
      btn.setAttribute('aria-label', 'Toggle dark mode');
      btn.textContent = (docEl.getAttribute('data-theme') === 'dark') ? sun : moon;
      btn.addEventListener('click', function () {
        var next = docEl.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        try { localStorage.setItem('ygn-theme', next); } catch (e) {}
        btn.textContent = next === 'dark' ? sun : moon;
      });
      header.appendChild(btn);
    });

    if (!isEconomy) {
      guard('reveal', setupReveal);
      guard('countup', setupCountUp);
      guard('backtotop', setupBackToTop);
      guard('progress', setupProgress);
    }
    guard('search-shortcut', setupSearchShortcut);
    guard('recently-viewed', setupRecentlyViewed);
  });

  function setupReveal() {
    if (!('IntersectionObserver' in window)) return;
    var sel = '.civic-section,.recent-bills-section,.term-decoder,.section-heading,'
      + '.home-stats,.ai-confidence-panel,.foreign-section,.eo-grid,.law-list';
    var targets = [].slice.call(document.querySelectorAll(sel));
    if (!targets.length) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('is-visible'); io.unobserve(en.target); }
      });
    }, { threshold: 0.06, rootMargin: '0px 0px -30px 0px' });
    targets.forEach(function (t) { t.classList.add('reveal'); io.observe(t); });
    setTimeout(function () { targets.forEach(function (t) { t.classList.add('is-visible'); }); }, 2500);
  }

  function setupCountUp() {
    if (!('IntersectionObserver' in window)) return;
    var els = [].slice.call(document.querySelectorAll('.stat-value'));
    if (!els.length) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { io.unobserve(en.target); tryCount(en.target, 0); }
      });
    }, { threshold: 0.5 });
    els.forEach(function (el) { io.observe(el); });
  }
  function tryCount(el, attempt) {
    if (el.getAttribute('data-counted')) return;
    var raw = (el.textContent || '').trim();
    var m = raw.match(/^([^0-9-]*)(-?[\d,]+(?:\.\d+)?)(.*)$/);
    if (!m) { if (attempt < 6) setTimeout(function () { tryCount(el, attempt + 1); }, 450); return; }
    var prefix = m[1], numStr = m[2], suffix = m[3];
    // Only animate genuine metrics (optional $ prefix, short unit suffix). Skip
    // dates ("Mar 17, 2026") and labels ("House (9)").
    if (/\d/.test(suffix) || suffix.length > 2 || /[a-z]/i.test(prefix)) return;
    var target = parseFloat(numStr.replace(/,/g, ''));
    if (!isFinite(target) || Math.abs(target) > 1e15) return;
    el.setAttribute('data-counted', '1');
    el.classList.add('counting');
    var hasComma = numStr.indexOf(',') !== -1;
    var decimals = (numStr.split('.')[1] || '').length;
    var dur = 850, start = null;
    function fmt(v) {
      var s = decimals ? v.toFixed(decimals) : String(Math.round(v));
      if (hasComma) s = Number(s).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      return prefix + s + suffix;
    }
    function stepFn(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(target * eased);
      if (p < 1) requestAnimationFrame(stepFn);
      else el.textContent = prefix + numStr + suffix;
    }
    requestAnimationFrame(stepFn);
  }

  function setupBackToTop() {
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'back-to-top';
    btn.setAttribute('aria-label', 'Back to top'); btn.textContent = '↑';
    btn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    document.body.appendChild(btn);
    var ticking = false;
    function update() { btn.classList.toggle('is-visible', (window.pageYOffset || 0) > 420); ticking = false; }
    window.addEventListener('scroll', function () { if (!ticking) { requestAnimationFrame(update); ticking = true; } }, { passive: true });
    update();
  }

  function setupProgress() {
    var bar = document.createElement('div');
    bar.className = 'read-progress'; bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
    var ticking = false;
    function update() {
      var h = document.documentElement;
      var max = h.scrollHeight - h.clientHeight;
      var p = max > 0 ? (window.pageYOffset || h.scrollTop) / max : 0;
      bar.style.width = (Math.max(0, Math.min(1, p)) * 100).toFixed(1) + '%';
      ticking = false;
    }
    window.addEventListener('scroll', function () { if (!ticking) { requestAnimationFrame(update); ticking = true; } }, { passive: true });
    window.addEventListener('resize', update); update();
  }

  function setupSearchShortcut() {
    function box() {
      return document.querySelector('input[aria-label="Search members and bills"], .global-search input, #global-search');
    }
    document.addEventListener('keydown', function (e) {
      var t = e.target, tag = (t && t.tagName) || '';
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        var el = box(); if (el) { e.preventDefault(); el.focus(); }
      } else if (e.key === 'Escape' && tag === 'INPUT' && t.type === 'search') {
        t.blur();
      }
    });
  }

  function setupRecentlyViewed() {
    var KEY = 'ygn-recent';
    function read() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
    function write(list) { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 6))); } catch (e) {} }
    if (page === 'bill' || page === 'member') {
      setTimeout(function () {
        var main = document.getElementById('main-content');
        var h = main && main.querySelector('h1, h2');
        var title = ((h && h.textContent) || document.title.replace(/\s*[-|].*$/, '')).trim();
        if (!title || title.length < 2) return;
        var url = location.pathname + location.search;
        var list = read().filter(function (x) { return x && x.url !== url; });
        list.unshift({ title: title.slice(0, 80), url: url });
        write(list);
      }, 1400);
    }
    if (page === 'home') {
      var list = read();
      if (!list.length) return;
      var anchor = document.querySelector('.home-stats') || document.querySelector('.home-dashboard');
      if (!anchor || !anchor.parentNode) return;
      var wrap = document.createElement('div');
      wrap.className = 'recently-viewed';
      var lab = document.createElement('span');
      lab.className = 'rv-label'; lab.textContent = 'Recently viewed';
      wrap.appendChild(lab);
      list.forEach(function (x) {
        if (!x || !x.url) return;
        var a = document.createElement('a');
        a.href = x.url; a.textContent = x.title || x.url; a.title = x.title || '';
        wrap.appendChild(a);
      });
      anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    }
  }
})();
