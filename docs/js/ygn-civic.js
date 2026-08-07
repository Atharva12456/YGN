/* ═══════════════════════════════════════════════════════════════════════════
   YGN — civic record features
   ───────────────────────────────────────────────────────────────────────────
   Ten features over the committed civic snapshots. The site already rendered
   most of these files as lists — recent laws, hearings, executive orders,
   nominations, treaties. What it did not do was put them on one clock, or say
   anything about their shape: how fast laws are actually passing, which
   agencies the nominations are for, how close the recorded votes were.

   The glossary feature is the odd one out and the most useful: 26 terms were
   sitting in a JSON file that nothing on the site consumed, while the prose
   used those exact words untranslated.

    30  One civic timeline        35  Hearing load by committee
    31  Laws pace                 36  Glossary definitions in place
    32  Executive order cadence   37  On-this-day almanac
    33  Nominations by agency     38  Vote margins
    34  Treaty topics             39  Broadest support
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var D = window.ygnData;
  if (!D) return;
  var page = D.page();

  var el = D.el, card = D.card, fmt = D.fmt, S = D.stats;
  var statRow = D.statRow, chip = D.chip;
  var isHome = page === 'home' && D.file().indexOf('index') === 0;

  function extLink(text, href) {
    var a = el('a', 'ygn-mlink', text);
    a.href = href; a.target = '_blank'; a.rel = 'noopener';
    return a;
  }
  function monthsBetween(a, b) {
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  }

  /* ── 30. One civic timeline ────────────────────────────────────────────────
     Laws, executive orders, hearings, nominations and treaties are five files
     that each carry a date. Merged and sorted, they read as one record of what
     the federal government actually did, which no single page showed. */
  function civicTimeline(sets) {
    var c = card('The federal record', 'Laws, orders, hearings, nominations and treaties on one clock');
    var events = [];
    (sets.laws || []).forEach(function (l) {
      events.push({ date: l.actionDate, kind: 'Law', tone: 'good',
                    text: l.title || l.identifier, meta: 'Public Law ' + (l.lawNumber || ''),
                    href: l.detailPath ? 'bill.html?id=' + encodeURIComponent(l.detailPath) : l.url });
    });
    (sets.orders || []).forEach(function (o) {
      events.push({ date: o.signedDate, kind: 'Order', tone: 'accent',
                    text: o.title, meta: 'EO ' + (o.number || ''), href: o.url, external: true });
    });
    (sets.hearings || []).forEach(function (h) {
      events.push({ date: h.date, kind: 'Hearing', tone: 'mid',
                    text: h.title || 'Committee hearing',
                    meta: [h.chamber, h.committee].filter(Boolean).join(' · ') });
    });
    (sets.nominations || []).forEach(function (n) {
      events.push({ date: n.actionDate || n.receivedDate, kind: 'Nomination', tone: 'mid',
                    text: n.description || 'Nomination', meta: n.organization || '' });
    });
    (sets.treaties || []).forEach(function (t) {
      events.push({ date: t.transmittedDate, kind: 'Treaty', tone: 'ind',
                    text: t.topic || 'Treaty', meta: 'Treaty Doc ' + (t.number || '') });
    });
    events = events.filter(function (e) { return e.date; })
                   .sort(function (a, b) { return D.parseDate(b.date) - D.parseDate(a.date); });
    if (!events.length) { c.body.appendChild(D.note('No dated civic records available.')); return c; }

    var kinds = ['Law', 'Order', 'Hearing', 'Nomination', 'Treaty'];
    var active = {};
    kinds.forEach(function (k) { active[k] = true; });
    var filterRow = el('div', 'ygn-chiprow');
    kinds.forEach(function (k) {
      var n = events.filter(function (e) { return e.kind === k; }).length;
      if (!n) return;
      var b = el('button', 'ygn-chip is-toggle is-on', k + ' ' + n);
      b.type = 'button';
      b.addEventListener('click', function () {
        active[k] = !active[k];
        b.classList.toggle('is-on', active[k]);
        render();
      });
      filterRow.appendChild(b);
    });
    c.body.appendChild(filterRow);

    var list = el('ol', 'ygn-timeline');
    c.body.appendChild(list);
    var shown = 12;
    function render() {
      var visible = events.filter(function (e) { return active[e.kind]; });
      list.innerHTML = '';
      visible.slice(0, shown).forEach(function (e) {
        var li = el('li', 'ygn-tl-item');
        li.appendChild(el('span', 'ygn-tl-date', fmt.date(e.date)));
        var body = el('div', 'ygn-tl-body');
        body.appendChild(chip(e.kind, e.tone));
        if (e.href) {
          var a = e.external ? extLink(e.text, e.href) : el('a', 'ygn-mlink', e.text);
          if (!e.external) a.href = e.href;
          body.appendChild(a);
        } else body.appendChild(el('span', 'ygn-tl-text', e.text));
        if (e.meta) body.appendChild(el('span', 'ygn-tl-meta', e.meta));
        li.appendChild(body);
        list.appendChild(li);
      });
      more.hidden = visible.length <= shown;
      more.textContent = 'Show more (' + (visible.length - shown) + ' left)';
    }
    var more = el('button', 'ygn-fbtn is-quiet', 'Show more');
    more.type = 'button';
    more.addEventListener('click', function () { shown += 12; render(); });
    c.body.appendChild(more);
    render();
    return c;
  }

  /* ── 31. How fast laws are actually being enacted ──────────────────────── */
  function lawsPace(recentLaws) {
    var laws = (recentLaws && recentLaws.laws) || [];
    var c = card('Pace of lawmaking', 'Public laws in the current Congress');
    if (!laws.length) { c.body.appendChild(D.note('No laws recorded.')); return c; }
    var total = recentLaws.totalLawsThisCongress;
    if (typeof total === 'number') {
      c.body.appendChild(statRow('Laws this Congress', fmt.num(total)));
    }
    var byMonth = {};
    laws.forEach(function (l) {
      if (!l.actionDate) return;
      var k = String(l.actionDate).slice(0, 7);
      byMonth[k] = (byMonth[k] || 0) + 1;
    });
    var keys = Object.keys(byMonth).sort();
    if (keys.length > 1) {
      c.body.appendChild(el('p', 'ygn-fsublabel', 'Enacted per month, in this snapshot'));
      c.body.appendChild(D.barChart(keys.map(function (k) {
        return { label: k, value: byMonth[k], tone: 'good', title: byMonth[k] + ' laws enacted in ' + k };
      }), { labelWidth: 64, label: 'Laws enacted per month' }));
    }
    var dates = laws.map(function (l) { return l.actionDate; }).filter(Boolean).sort();
    if (dates.length > 1) {
      var span = monthsBetween(D.parseDate(dates[0]), D.parseDate(dates[dates.length - 1])) || 1;
      c.body.appendChild(statRow('Average in this window',
        (laws.length / Math.max(1, span)).toFixed(1) + ' a month',
        'across ' + laws.length + ' laws in the snapshot'));
    }
    var newest = laws[0];
    if (newest) {
      c.body.appendChild(statRow('Most recent', newest.identifier || '—', fmt.ago(newest.actionDate)));
    }
    c.body.appendChild(D.note('The snapshot carries the most recent laws, not every law of the Congress.'));
    return c;
  }

  /* ── 32. Executive order cadence ───────────────────────────────────────── */
  function orderCadence(eo) {
    var orders = (eo && eo.orders) || [];
    var c = card('Executive orders', 'Signing cadence in the current snapshot');
    if (!orders.length) { c.body.appendChild(D.note('No orders recorded.')); return c; }
    var dated = orders.filter(function (o) { return o.signedDate; })
      .sort(function (a, b) { return D.parseDate(a.signedDate) - D.parseDate(b.signedDate); });
    c.body.appendChild(statRow('Orders in snapshot', String(orders.length)));
    if (dated.length > 1) {
      var gaps = [];
      for (var i = 1; i < dated.length; i++) {
        gaps.push((D.parseDate(dated[i].signedDate) - D.parseDate(dated[i - 1].signedDate)) / 86400000);
      }
      c.body.appendChild(statRow('Median gap between orders',
        fmt.num(S.median(gaps), 1) + ' days'));
      c.body.appendChild(statRow('Range',
        fmt.date(dated[0].signedDate) + ' – ' + fmt.date(dated[dated.length - 1].signedDate)));
    }
    var newest = dated[dated.length - 1];
    if (newest) {
      var row = el('div', 'ygn-statrow');
      row.appendChild(el('span', 'ygn-statrow-label', 'Most recent'));
      row.appendChild(extLink(newest.title || ('EO ' + newest.number), newest.url));
      row.appendChild(el('span', 'ygn-statrow-hint', fmt.ago(newest.signedDate)));
      c.body.appendChild(row);
    }
    // Lag between signature and publication in the Federal Register.
    var lags = orders.filter(function (o) { return o.signedDate && o.publicationDate; })
      .map(function (o) { return (D.parseDate(o.publicationDate) - D.parseDate(o.signedDate)) / 86400000; });
    if (lags.length) {
      c.body.appendChild(statRow('Signature to publication',
        fmt.num(S.median(lags), 1) + ' days', 'median delay reaching the Federal Register'));
    }
    return c;
  }

  /* ── 33. Which parts of government the nominations are for ─────────────── */
  function nominationsByAgency(nom) {
    var items = (nom && nom.nominations) || [];
    var c = card('Nominations', 'Pending civilian and military nominations by organisation');
    if (!items.length) { c.body.appendChild(D.note('No nominations recorded.')); return c; }
    var civil = items.filter(function (n) { return !n.isMilitary; });
    var mil = items.filter(function (n) { return n.isMilitary; });
    c.body.appendChild(statRow('In snapshot', String(items.length),
      civil.length + ' civilian · ' + mil.length + ' military'));
    var by = S.groupBy(civil, function (n) { return n.organization; });
    var rows = Object.keys(by).map(function (k) {
      return { label: k.replace(/^Department of /, '').slice(0, 22), value: by[k].length,
               tone: 'accent', title: k + ': ' + by[k].length };
    }).sort(function (a, b) { return b.value - a.value; }).slice(0, 8);
    if (rows.length) {
      c.body.appendChild(D.barChart(rows, { labelWidth: 128, label: 'Nominations per organisation' }));
    }
    var newest = items.slice().sort(function (a, b) {
      return D.parseDate(b.actionDate || b.receivedDate) - D.parseDate(a.actionDate || a.receivedDate);
    })[0];
    if (newest && newest.actionText) {
      c.body.appendChild(statRow('Latest action', newest.actionText,
        fmt.ago(newest.actionDate || newest.receivedDate)));
    }
    return c;
  }

  /* ── 34. Treaty subjects ───────────────────────────────────────────────── */
  function treatyTopics(tr) {
    var items = (tr && tr.treaties) || [];
    var c = card('Treaties before the Senate', 'By subject');
    if (!items.length) { c.body.appendChild(D.note('No treaties recorded.')); return c; }
    var by = S.groupBy(items, function (t) { return t.topic; });
    var rows = Object.keys(by).map(function (k) {
      return { label: k.slice(0, 24), value: by[k].length, tone: 'ind', title: k + ': ' + by[k].length };
    }).sort(function (a, b) { return b.value - a.value; });
    c.body.appendChild(D.barChart(rows, { labelWidth: 140, label: 'Treaties per topic' }));
    var dated = items.filter(function (t) { return t.transmittedDate; })
      .sort(function (a, b) { return D.parseDate(a.transmittedDate) - D.parseDate(b.transmittedDate); });
    if (dated.length) {
      c.body.appendChild(statRow('Oldest still pending', fmt.date(dated[0].transmittedDate),
        fmt.ago(dated[0].transmittedDate) + ' · ' + (dated[0].topic || '')));
    }
    c.body.appendChild(D.note('A treaty stays on the Senate calendar until it is ratified or returned, ' +
                              'so old transmission dates are normal.'));
    return c;
  }

  /* ── 35. Which committees are carrying the hearing load ────────────────── */
  function hearingLoad(hr) {
    var items = (hr && hr.hearings) || [];
    var c = card('Hearing schedule', 'Committee activity in the snapshot');
    if (!items.length) { c.body.appendChild(D.note('No hearings recorded.')); return c; }
    var byChamber = S.groupBy(items, function (h) { return h.chamber; });
    var row = el('div', 'ygn-chiprow');
    Object.keys(byChamber).forEach(function (k) {
      row.appendChild(chip(k + ' · ' + byChamber[k].length, k === 'House' ? 'accent' : 'mid'));
    });
    c.body.appendChild(row);
    var by = S.groupBy(items, function (h) { return h.committee; });
    var rows = Object.keys(by).map(function (k) {
      return { label: k.replace(/^(House|Senate) /, '').slice(0, 22), value: by[k].length,
               tone: 'mid', title: k + ': ' + by[k].length + ' hearings' };
    }).sort(function (a, b) { return b.value - a.value; }).slice(0, 8);
    if (rows.length) c.body.appendChild(D.barChart(rows, { labelWidth: 128, label: 'Hearings per committee' }));
    // A hearing today is still upcoming, so compare whole days, not instants.
    var upcoming = items.filter(function (h) { return h.date && D.daysAgo(h.date) <= 0; })
      .sort(function (a, b) { return D.parseDate(a.date) - D.parseDate(b.date); });
    c.body.appendChild(statRow('Still upcoming', String(upcoming.length), 'of ' + items.length + ' listed'));
    return c;
  }

  /* ── 36. Glossary definitions, in place ───────────────────────────────────
     26 terms were sitting unused in civic/glossary.json while the site's prose
     used them untranslated. This marks the first occurrence of each term in
     body copy and attaches its definition.

     Only text nodes inside prose are touched, and each term is marked once per
     page, so this cannot turn an article into a field of underlines. Anything
     already inside a link, heading, button or existing tooltip is skipped. */
  var glossaryUsed = {};      // module-level so repeat passes never double-mark
  var glossaryTipReady = false;
  function glossary(terms) {
    if (!terms || !terms.length) return;
    var used = glossaryUsed;
    /* Several entries are written for a reader, not a matcher:
         "Continuing resolution (CR)"      → "continuing resolution", "CR"
         "PTR (Periodic Transaction Report)" → "PTR", "Periodic Transaction Report"
         "Sponsor / cosponsor"             → "sponsor", "cosponsor"
       Matching the label verbatim would find none of these in real prose, so
       each entry contributes its aliases instead. Two-letter aliases stay
       case-sensitive; lowercased, "CR" would fire inside ordinary words. */
    // features.js repairs UTF-8-as-Windows-1252 mojibake that the build has
    // produced in this file before; reuse it so a tooltip can never show
    // mangled text the term decoder shows cleanly.
    var fix = window.ygnDecodeGlossary || function (s) { return String(s || ''); };
    var byTerm = {}, exact = {};
    terms.forEach(function (t) {
      if (!t.term) return;
      t = { term: fix(t.term), definition: fix(t.definition) };
      var aliases = [];
      var paren = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(t.term);
      if (paren) { aliases.push(paren[1], paren[2]); }
      else if (t.term.indexOf('/') > -1) {
        t.term.split('/').forEach(function (p) { aliases.push(p.trim()); });
      } else aliases.push(t.term);
      aliases.forEach(function (a) {
        a = a.trim();
        if (a.length < 2) return;
        if (a.length <= 3 && a === a.toUpperCase()) { exact[a] = t.definition; return; }
        byTerm[a.toLowerCase()] = t.definition;
      });
    });
    var names = Object.keys(byTerm).sort(function (a, b) { return b.length - a.length; });
    var exactNames = Object.keys(exact).sort(function (a, b) { return b.length - a.length; });
    if (!names.length && !exactNames.length) return;

    var main = document.getElementById('main-content');
    if (!main) return;
    var SKIP = /^(A|BUTTON|H1|H2|H3|H4|CODE|PRE|KBD|SCRIPT|STYLE|INPUT|TEXTAREA|SELECT|LABEL|ABBR)$/;

    // Collect candidate text nodes first: mutating while walking invalidates
    // the walker.
    var nodes = [];
    var walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || n.nodeValue.length < 4) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        while (p && p !== main) {
          // Feature cards are fair game — the status decoder in particular uses
          // this exact vocabulary. Only interactive and heading text is skipped.
          if (SKIP.test(p.tagName) || p.classList.contains('ygn-term') ||
              p.classList.contains('ygn-analysis-head')) {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = walker.nextNode())) nodes.push(n);

    function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    var candidates = names.map(function (t) {
      return { key: t, def: byTerm[t], re: new RegExp('\\b(' + esc(t) + ')\\b', 'i') };
    }).concat(exactNames.map(function (t) {
      return { key: t, def: exact[t], re: new RegExp('\\b(' + esc(t) + ')\\b') };
    }));

    var marked = 0;
    nodes.forEach(function (node) {
      for (var i = 0; i < candidates.length; i++) {
        var cand = candidates[i];
        if (used[cand.key]) continue;
        var m = cand.re.exec(node.nodeValue);
        if (!m) continue;
        used[cand.key] = 1;
        marked++;
        var after = node.splitText(m.index);
        after.nodeValue = after.nodeValue.slice(m[0].length);
        var mark = el('span', 'ygn-term', m[0]);
        mark.setAttribute('tabindex', '0');
        mark.setAttribute('role', 'button');
        mark.setAttribute('aria-label', m[0] + ': ' + cand.def);
        mark.setAttribute('data-def', cand.def);
        node.parentNode.insertBefore(mark, after);
        break;                                  // one term per text node
      }
    });

    if (!marked || glossaryTipReady) return;
    glossaryTipReady = true;
    // A single shared tooltip, positioned on demand.
    var tip = el('div', 'ygn-termtip');
    tip.hidden = true;
    document.body.appendChild(tip);
    function show(target) {
      tip.textContent = target.getAttribute('data-def');
      tip.hidden = false;
      var r = target.getBoundingClientRect();
      var top = r.bottom + window.pageYOffset + 6;
      tip.style.top = top + 'px';
      var left = Math.min(r.left + window.pageXOffset, window.innerWidth - tip.offsetWidth - 12);
      tip.style.left = Math.max(8, left) + 'px';
    }
    function hide() { tip.hidden = true; }
    main.addEventListener('mouseover', function (e) {
      if (e.target.classList && e.target.classList.contains('ygn-term')) show(e.target);
    });
    main.addEventListener('mouseout', function (e) {
      if (e.target.classList && e.target.classList.contains('ygn-term')) hide();
    });
    main.addEventListener('focusin', function (e) {
      if (e.target.classList && e.target.classList.contains('ygn-term')) show(e.target);
    });
    main.addEventListener('focusout', hide);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    window.addEventListener('scroll', hide, { passive: true });
  }

  /* ── 37. The full on-this-day almanac ─────────────────────────────────────
     The home page showed one entry for today. The file holds 41 dates, which
     is a browsable almanac rather than a single line. */
  function almanac(otd) {
    var events = (otd && otd.events) || {};
    var keys = Object.keys(events).sort();
    var c = card('Congressional almanac', keys.length + ' dates in the record');
    if (!keys.length) { c.body.appendChild(D.note('No entries.')); return c; }
    var MONTHS = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
    var today = new Date();
    var todayKey = String(today.getMonth() + 1).padStart(2, '0') + '-' +
                   String(today.getDate()).padStart(2, '0');
    var search = el('input', 'ygn-finput');
    search.type = 'search';
    search.placeholder = 'Filter the almanac…';
    search.setAttribute('aria-label', 'Filter almanac entries');
    c.body.appendChild(search);
    var list = el('ol', 'ygn-timeline');
    c.body.appendChild(list);

    function render() {
      var q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      var shown = keys.filter(function (k) {
        var e = events[k];
        return !q || (e.text || '').toLowerCase().indexOf(q) > -1 || String(e.year).indexOf(q) > -1;
      });
      if (!shown.length) { list.appendChild(el('li', 'ygn-fnote', 'Nothing matches that.')); return; }
      shown.forEach(function (k) {
        var e = events[k];
        var li = el('li', 'ygn-tl-item' + (k === todayKey ? ' is-today' : ''));
        var parts = k.split('-');
        li.appendChild(el('span', 'ygn-tl-date', MONTHS[+parts[0] - 1].slice(0, 3) + ' ' + (+parts[1])));
        var body = el('div', 'ygn-tl-body');
        body.appendChild(chip(String(e.year), 'mid'));
        body.appendChild(el('span', 'ygn-tl-text', e.text));
        if (k === todayKey) body.appendChild(chip('today', 'good'));
        li.appendChild(body);
        list.appendChild(li);
      });
    }
    search.addEventListener('input', render);
    render();
    if (otd.note) c.body.appendChild(D.note(otd.note));
    return c;
  }

  /* ═══ Boot ═══════════════════════════════════════════════════════════════ */
  function mount(anchor, cards, opts) {
    opts = opts || {};
    D.panelFor({
      after: anchor,
      className: opts.className || 'ygn-civicpanel',
      storeKey: opts.storeKey || 'ygn-civicpanel-open',
      title: opts.title || 'The record, in context',
      summary: opts.summary || 'Pace and shape of what the federal government has been doing.',
      cards: cards
    });
  }

  D.ready(function () {
    // The glossary runs everywhere, after other modules have written their prose.
    // Two passes: most prose is present early, but the feature cards and the
    // async civic sections land later and use this vocabulary heavily.
    D.civic('glossary').then(function (g) {
      [1600, 4200].forEach(function (delay) {
        setTimeout(function () {
          D.guard('cv:36', function () { glossary(g && g.terms); });
        }, delay);
      });
    });

    if (isHome) {
      Promise.all(['recent-laws', 'executive-orders', 'hearings', 'nominations', 'treaties',
                   'on-this-day'].map(D.civic)).then(function (r) {
        var host = document.getElementById('home-recent-bills') || document.getElementById('district-map');
        mount(host, [
          D.guard('cv:30', function () {
            return civicTimeline({ laws: (r[0] || {}).laws, orders: (r[1] || {}).orders,
                                   hearings: (r[2] || {}).hearings, nominations: (r[3] || {}).nominations,
                                   treaties: (r[4] || {}).treaties });
          }),
          D.guard('cv:37', function () { return almanac(r[5]); })
        ], { title: 'The federal record', summary: 'Every dated law, order, hearing, nomination and treaty on one clock.' });
      });
    } else if (page === 'bills') {
      Promise.all(['recent-laws', 'hearings'].map(D.civic)).then(function (r) {
        // Same bar as the bills panel — whichever of the two lands first
        // builds it and the other appends.
        var host = document.getElementById('bill-filters') || document.getElementById('recent-bills-grid');
        mount(host, [
          D.guard('cv:31', function () { return lawsPace(r[0]); }),
          D.guard('cv:35', function () { return hearingLoad(r[1]); })
        ], { className: 'ygn-billpanel', storeKey: 'ygn-billpanel-open',
             title: 'Bills in context',
             summary: 'Policy mix, how stale the feed is, who sponsors, lawmaking pace and hearings.' });
      });
    } else if (page === 'foreign') {
      Promise.all(['executive-orders', 'nominations', 'treaties'].map(D.civic)).then(function (r) {
        var host = document.getElementById('treaty-tracker') || document.getElementById('nominations-live');
        mount(host, [
          D.guard('cv:32', function () { return orderCadence(r[0]); }),
          D.guard('cv:33', function () { return nominationsByAgency(r[1]); }),
          D.guard('cv:34', function () { return treatyTopics(r[2]); })
        ]);
      });
    }
  });
})();
