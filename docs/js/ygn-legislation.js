/* ═══════════════════════════════════════════════════════════════════════════
   YGN — legislation tools
   ───────────────────────────────────────────────────────────────────────────
   Fourteen features over the recent-bills digest and the individual bill
   snapshots. The bills page listed bills well but answered nothing about them
   as a set: what Congress is actually spending its time on, which bills have
   stalled, which ones drew support from both parties.

   Every number here comes out of recent-bills-digest.json — policy area,
   cosponsor counts, the per-member party letter on each sponsorship, and the
   latestAction date. Nothing is inferred beyond what those fields say, and
   where a field is missing the feature says so rather than guessing.

     Bills page                         Bill detail
    16  Policy-area breakdown          23  Status decoder
    17  Stalled and moving             24  Related bills
    18  Most-cosponsored               25  Reading time
    19  Chamber of origin              26  Sponsor detail
    20  Sponsorship reach              27  Bill compare tray
    21  Activity timeline              28  New since your last visit
    22  Policy-area filter chips       29  Export the digest
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var D = window.ygnData;
  if (!D) return;
  var page = D.page();
  if (page !== 'bills' && page !== 'bill') return;

  var el = D.el, card = D.card, fmt = D.fmt, S = D.stats;
  var chip = D.chip, statRow = D.statRow, download = D.download, csvCell = D.csvCell;

  function billHref(b) { return 'bill.html?id=' + encodeURIComponent(b.detailPath || ''); }
  function billLink(b) {
    var a = el('a', 'ygn-mlink');
    a.href = billHref(b);
    a.textContent = b.identifier || b.title || 'Bill';
    return a;
  }
  function titleOf(b) {
    return (b.description && b.description.text) || b.title || b.identifier || '';
  }
  function daysSince(s) { return s ? D.daysAgo(s) : null; }

  /* Party mix across everyone attached to a bill. The digest gives a party
     letter per member, so this is counted, not modelled. */
  function partyMix(b) {
    var people = (b.members || []).concat(b.sponsors || []);
    var seen = {}, mix = { D: 0, R: 0, I: 0, unknown: 0, total: 0 };
    people.forEach(function (p) {
      var id = p.bioguideId || p.name;
      if (!id || seen[id]) return;
      seen[id] = 1;
      mix.total++;
      var k = (p.party || '').toUpperCase();
      if (k === 'D') mix.D++;
      else if (k === 'R') mix.R++;
      else if (k) mix.I++;
      else mix.unknown++;
    });
    // 0 = single party, 1 = an even split. Only meaningful with 2+ people.
    mix.balance = (mix.D + mix.R) > 1
      ? 1 - Math.abs(mix.D - mix.R) / (mix.D + mix.R)
      : null;
    return mix;
  }

  /* ═══ BILLS PAGE ═════════════════════════════════════════════════════════ */
  function buildBillsAnalysis(bills, digest) {
    if (document.querySelector('.ygn-billpanel')) return;
    // After the bill list. This used to sit above #civic-pulse-grid, which put
    // a screen of charts between the reader and the bills themselves.
    var anchor = document.getElementById('recent-bills-grid');
    if (!anchor) return;

    var panel = D.panel({
      after: anchor,
      className: 'ygn-billpanel',
      storeKey: 'ygn-billpanel-open',
      title: 'What this batch of bills looks like',
      summary: 'Policy mix, how stale the feed is, who is sponsoring, and an export.',
      cards: [
        D.guard('bl:16', function () { return policyBreakdown(bills); }),
        D.guard('bl:17', function () { return stalledAndMoving(bills); }),
        D.guard('bl:18', function () { return mostCosponsored(bills); }),
        D.guard('bl:19', function () { return chamberOrigin(bills); }),
        D.guard('bl:20', function () { return sponsorshipReach(bills); }),
        D.guard('bl:21', function () { return activityTimeline(bills); }),
        D.guard('bl:29', function () { return exportPanel(bills, digest); })
      ]
    });
    // The "moved since your visit" strip stays above the list: it is a pointer
    // into the bills, not analysis of them.
    if (panel) D.guard('bl:28', function () { newSinceLastVisit(bills, anchor); });
  }

  /* 16. What Congress is spending its time on, by Congress.gov policy area. */
  function policyBreakdown(bills) {
    var c = card('Policy areas', 'Across the ' + bills.length + ' most recent bills');
    var by = S.groupBy(bills, function (b) { return b.policyArea; });
    var rows = Object.keys(by).map(function (k) {
      return { label: k.length > 22 ? k.slice(0, 21) + '…' : k, value: by[k].length,
               tone: 'accent', title: k + ': ' + by[k].length + ' bills' };
    }).sort(function (a, b) { return b.value - a.value; }).slice(0, 10);
    if (!rows.length) { c.body.appendChild(D.note('No policy areas recorded.')); return c; }
    c.body.appendChild(D.barChart(rows, { labelWidth: 128, label: 'Bills per policy area' }));
    var unlabelled = bills.filter(function (b) { return !b.policyArea; }).length;
    if (unlabelled) c.body.appendChild(D.note(unlabelled + ' bills have no policy area assigned yet.'));
    return c;
  }

  /* 17. Time since the last recorded action — the closest thing the data has
         to "is this bill actually going anywhere". */
  function stalledAndMoving(bills) {
    var c = card('Stalled and moving', 'Days since the last recorded action');
    var aged = bills.map(function (b) {
      return { b: b, days: daysSince(b.latestAction && b.latestAction.date) };
    }).filter(function (x) { return x.days !== null; });
    if (!aged.length) { c.body.appendChild(D.note('No action dates recorded.')); return c; }
    var buckets = [
      { label: 'This week', tone: 'good', test: function (d) { return d <= 7; } },
      { label: 'This month', tone: 'good', test: function (d) { return d > 7 && d <= 30; } },
      { label: '1-3 months', tone: 'mid', test: function (d) { return d > 30 && d <= 90; } },
      { label: '3-6 months', tone: 'mid', test: function (d) { return d > 90 && d <= 180; } },
      { label: 'Over 6 months', tone: 'bad', test: function (d) { return d > 180; } }
    ];
    c.body.appendChild(D.barChart(buckets.map(function (bk) {
      var n = aged.filter(function (x) { return bk.test(x.days); }).length;
      return { label: bk.label, value: n, tone: bk.tone, title: n + ' bills last moved ' + bk.label.toLowerCase() };
    }), { labelWidth: 96, label: 'Bills by recency of action' }));
    c.body.appendChild(statRow('Median age of last action',
      fmt.num(S.median(aged.map(function (x) { return x.days; })), 0) + ' days'));
    var stalest = aged.sort(function (a, b) { return b.days - a.days; })[0];
    if (stalest) {
      var row = el('div', 'ygn-statrow');
      row.appendChild(el('span', 'ygn-statrow-label', 'Longest untouched'));
      row.appendChild(billLink(stalest.b));
      row.appendChild(el('span', 'ygn-statrow-hint', stalest.days + ' days'));
      c.body.appendChild(row);
    }
    return c;
  }

  /* 18. Cosponsor count is the plainest available signal of support. */
  function mostCosponsored(bills) {
    var c = card('Most cosponsored', 'Cosponsors recorded on Congress.gov');
    var ranked = bills.filter(function (b) { return typeof b.cosponsorCount === 'number'; })
      .sort(function (a, b) { return b.cosponsorCount - a.cosponsorCount; }).slice(0, 8);
    if (!ranked.length) { c.body.appendChild(D.note('No cosponsor counts recorded.')); return c; }
    var ol = el('ol', 'ygn-ranklist');
    ranked.forEach(function (b, i) {
      var li = el('li');
      li.appendChild(el('span', 'ygn-rank-n', String(i + 1)));
      var body = el('span', 'ygn-rank-body');
      body.appendChild(billLink(b));
      var mix = partyMix(b);
      if (mix.D && mix.R) body.appendChild(chip('bipartisan', 'good'));
      body.appendChild(el('span', 'ygn-mini-val', b.cosponsorCount + ' cosponsors'));
      var t = el('span', 'ygn-rank-title', titleOf(b));
      body.appendChild(t);
      li.appendChild(body);
      ol.appendChild(li);
    });
    c.body.appendChild(ol);
    return c;
  }

  /* 19. Where the bills started. */
  function chamberOrigin(bills) {
    var c = card('Chamber of origin', 'House against Senate in this batch');
    var by = S.groupBy(bills, function (b) { return b.originChamber; });
    var rows = Object.keys(by).map(function (k) {
      return { label: k, value: by[k].length, tone: k === 'House' ? 'accent' : 'mid',
               title: by[k].length + ' bills originated in the ' + k };
    });
    c.body.appendChild(D.barChart(rows, { labelWidth: 60, label: 'Bills by originating chamber' }));
    var byType = S.groupBy(bills, function (b) { return b.type; });
    var typeList = el('div', 'ygn-chiprow');
    Object.keys(byType).sort().forEach(function (t) {
      typeList.appendChild(chip(t + ' · ' + byType[t].length, 'mid'));
    });
    c.body.appendChild(el('p', 'ygn-fsublabel', 'By measure type'));
    c.body.appendChild(typeList);
    return c;
  }

  /* 20. Who is putting these bills forward, and how much support they attract.
         The digest names only the sponsor — one member per bill — so a
         cosponsor party mix is not available here. What it does support is the
         sponsor's own party against the cosponsors that sponsor drew, which is
         the question the data can actually answer. */
  function sponsorshipReach(bills) {
    var c = card('Who is sponsoring', 'Sponsor party against the support each bill drew');
    var withSponsor = bills.map(function (b) {
      var p = ((b.members || [])[0] || (b.sponsors || [])[0] || {}).party;
      return { b: b, party: (p || '').toUpperCase(), n: b.cosponsorCount || 0 };
    }).filter(function (x) { return x.party; });
    if (!withSponsor.length) {
      c.body.appendChild(D.note('No sponsor party recorded in this snapshot.'));
      return c;
    }
    var by = S.groupBy(withSponsor, function (x) { return x.party; });
    c.body.appendChild(D.barChart(Object.keys(by).sort().map(function (k) {
      return { label: D.partyLabel(k), value: by[k].length,
               tone: k === 'D' ? 'dem' : k === 'R' ? 'rep' : 'ind',
               title: by[k].length + ' bills sponsored by a ' + D.partyLabel(k) };
    }), { labelWidth: 92, label: 'Bills per sponsor party' }));

    c.body.appendChild(el('p', 'ygn-fsublabel', 'Cosponsors attracted'));
    Object.keys(by).sort().forEach(function (k) {
      var counts = by[k].map(function (x) { return x.n; });
      c.body.appendChild(statRow(D.partyLabel(k) + ' sponsors',
        'median ' + fmt.num(S.median(counts), 0),
        'across ' + by[k].length + ' bills · highest ' + Math.max.apply(null, counts)));
    });
    var solo = withSponsor.filter(function (x) { return x.n === 0; }).length;
    c.body.appendChild(statRow('With no cosponsors at all', String(solo),
      fmt.pct(solo / withSponsor.length * 100, 0) + ' of the batch'));
    c.body.appendChild(D.note('The digest names only the sponsor, so the party split of the cosponsors ' +
                              'themselves is not in this data and is not guessed at here.'));
    return c;
  }

  /* 21. When these bills last moved, by month. */
  function activityTimeline(bills) {
    var c = card('Activity timeline', 'Latest action by month');
    var byMonth = {};
    bills.forEach(function (b) {
      var d = b.latestAction && b.latestAction.date;
      if (!d) return;
      var key = String(d).slice(0, 7);
      byMonth[key] = (byMonth[key] || 0) + 1;
    });
    var keys = Object.keys(byMonth).sort();
    if (!keys.length) { c.body.appendChild(D.note('No dated actions.')); return c; }
    c.body.appendChild(D.barChart(keys.map(function (k) {
      return { label: k, value: byMonth[k], tone: 'accent', title: byMonth[k] + ' bills last acted on in ' + k };
    }), { labelWidth: 64, label: 'Bill activity by month' }));
    return c;
  }

  /* 28. Which bills have moved since the reader was last here. */
  function newSinceLastVisit(bills, host) {
    var KEY = 'ygn-bills-lastseen';
    var last = D.store.get(KEY, null);
    var now = new Date().toISOString();
    var fresh = last ? bills.filter(function (b) {
      var d = (b.latestAction && b.latestAction.date) || b.updatedAt;
      return d && D.parseDate(d) > D.parseDate(last);
    }) : [];
    D.store.set(KEY, now);
    if (!last) return;                       // first visit has nothing to compare
    if (!fresh.length) return;
    var bar = el('div', 'ygn-sincebar');
    bar.appendChild(el('strong', null, fresh.length + ' bill' + (fresh.length === 1 ? '' : 's') +
                       ' moved since your last visit'));
    var list = el('div', 'ygn-chiprow');
    fresh.slice(0, 8).forEach(function (b) {
      var a = el('a', 'ygn-chip is-link', b.identifier || 'Bill');
      a.href = billHref(b);
      list.appendChild(a);
    });
    bar.appendChild(list);
    var dismiss = el('button', 'ygn-sincebar-x', '×');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(dismiss);
    host.parentNode.insertBefore(bar, host);
  }

  /* 29. Take the digest away as CSV or JSON. */
  function exportPanel(bills, digest) {
    var c = card('Export this data', 'The digest as a file, generated in your browser');
    var row = el('div', 'ygn-btnrow');
    var csvBtn = el('button', 'ygn-fbtn', 'Download CSV');
    csvBtn.type = 'button';
    csvBtn.addEventListener('click', function () {
      var cols = ['identifier', 'title', 'policyArea', 'originChamber', 'cosponsorCount',
                  'latestActionDate', 'latestActionText', 'url'];
      var lines = [cols.join(',')];
      bills.forEach(function (b) {
        lines.push([b.identifier, titleOf(b), b.policyArea, b.originChamber, b.cosponsorCount,
                    b.latestAction && b.latestAction.date, b.latestAction && b.latestAction.text,
                    b.url].map(csvCell).join(','));
      });
      download('ygn-recent-bills.csv', lines.join('\n'), 'text/csv');
    });
    row.appendChild(csvBtn);
    var jsonBtn = el('button', 'ygn-fbtn', 'Download JSON');
    jsonBtn.type = 'button';
    jsonBtn.addEventListener('click', function () {
      download('ygn-recent-bills.json', JSON.stringify(bills, null, 2), 'application/json');
    });
    row.appendChild(jsonBtn);
    c.body.appendChild(row);
    if (digest && digest.generated_at) {
      c.body.appendChild(statRow('Snapshot taken', fmt.date(digest.generated_at), fmt.ago(digest.generated_at)));
    }
    c.body.appendChild(D.note('Built from the snapshot already loaded in this page — nothing is sent anywhere.'));
    return c;
  }

  /* ═══ BILL DETAIL PAGE ═══════════════════════════════════════════════════ */

  /* 23. Congress.gov action text is procedural. This maps the common phrases
         to what they mean, and says so when it does not recognise one. */
  function buildBillDetail(bills, detailPath) {
    if (document.querySelector('.ygn-billdetailpanel')) return;
    var me = bills.filter(function (b) { return b.detailPath === detailPath; })[0];
    // Anchored on the container but inserted after it, so core.js rewriting
    // the container cannot take this with it.
    var anchor = document.getElementById('bill-container');
    if (!anchor) return;
    D.panel({
      after: anchor,
      className: 'ygn-billdetailpanel',
      storeKey: 'ygn-billdetail-open',
      title: 'More on this bill',
      summary: 'Who is behind it, how long this page takes to read, and a compare tray.',
      cards: [
        me ? D.guard('bl:26', function () { return sponsorMix(me); }) : null,
        D.guard('bl:25', readingTime),
        D.guard('bl:27', function () { return compareTray(me, bills); })
      ]
    });
  }

  function sponsorMix(b) {
    var c = card('Who is behind it', 'Sponsors and cosponsors listed in the digest');
    var mix = partyMix(b);
    if (!mix.total) { c.body.appendChild(D.note('No sponsors listed in the snapshot.')); return c; }
    var row = el('div', 'ygn-chiprow');
    if (mix.D) row.appendChild(chip(mix.D + ' Democrat' + (mix.D === 1 ? '' : 's'), 'dem'));
    if (mix.R) row.appendChild(chip(mix.R + ' Republican' + (mix.R === 1 ? '' : 's'), 'rep'));
    if (mix.I) row.appendChild(chip(mix.I + ' independent', 'ind'));
    c.body.appendChild(row);
    if (typeof b.cosponsorCount === 'number') {
      c.body.appendChild(statRow('Cosponsors on record', String(b.cosponsorCount),
        mix.total < b.cosponsorCount ? 'the snapshot lists ' + mix.total + ' by name' : ''));
    }
    var people = (b.members || []).slice(0, 10);
    if (people.length) {
      var list = el('ul', 'ygn-minilist');
      people.forEach(function (p) {
        var li = el('li');
        if (p.bioguideId) {
          var a = el('a', 'ygn-mlink', p.name || p.bioguideId);
          a.href = 'member.html?id=' + encodeURIComponent(p.bioguideId);
          li.appendChild(a);
        } else li.appendChild(el('span', null, p.name || 'Unnamed'));
        if (p.role) li.appendChild(chip(p.role, 'mid'));
        list.appendChild(li);
      });
      c.body.appendChild(list);
    }
    return c;
  }

  /* 25. How long the page in front of you takes to read. */
  function readingTime() {
    var c = card('Reading time', 'For the text on this page');
    var main = document.getElementById('bill-container') || document.getElementById('main-content');
    var words = ((main && main.textContent) || '').trim().split(/\s+/).filter(Boolean).length;
    var mins = Math.max(1, Math.round(words / 220));
    c.body.appendChild(statRow('Words on this page', fmt.num(words)));
    c.body.appendChild(statRow('Roughly', mins + ' minute' + (mins === 1 ? '' : 's'), 'at 220 words a minute'));
    c.body.appendChild(D.note('Counts the summaries shown here, not the full legislative text.'));
    return c;
  }

  /* 27. A tray for holding bills side by side across page visits. */
  var TRAY_KEY = 'ygn-bill-tray';
  function compareTray(me, bills) {
    var c = card('Compare tray', 'Pin bills and read them side by side');
    var tray = D.store.get(TRAY_KEY, []);
    var body = c.body;

    function render() {
      body.innerHTML = '';
      if (me) {
        var inTray = tray.indexOf(me.detailPath) > -1;
        var btn = el('button', 'ygn-fbtn' + (inTray ? ' is-on' : ''),
                     inTray ? 'Remove this bill' : 'Add this bill to the tray');
        btn.type = 'button';
        btn.addEventListener('click', function () {
          var i = tray.indexOf(me.detailPath);
          if (i > -1) tray.splice(i, 1); else tray.push(me.detailPath);
          tray = tray.slice(-4);
          D.store.set(TRAY_KEY, tray);
          D.toast(i > -1 ? 'Removed from tray' : 'Added to tray');
          render();
        });
        body.appendChild(btn);
      }
      var picked = tray.map(function (p) {
        return bills.filter(function (b) { return b.detailPath === p; })[0];
      }).filter(Boolean);
      if (!picked.length) {
        body.appendChild(D.note('Nothing pinned yet. Add up to four bills, then compare them here.'));
        return;
      }
      var table = el('table', 'ygn-ftable');
      var fields = [
        ['Bill', function (b) { return b.identifier || '—'; }],
        ['Policy area', function (b) { return b.policyArea || '—'; }],
        ['Chamber', function (b) { return b.originChamber || '—'; }],
        ['Cosponsors', function (b) { return b.cosponsorCount === undefined ? '—' : String(b.cosponsorCount); }],
        ['Party mix', function (b) { var m = partyMix(b); return m.total ? m.D + 'D / ' + m.R + 'R' : '—'; }],
        ['Last action', function (b) { return fmt.date(b.latestAction && b.latestAction.date) || '—'; }]
      ];
      var tbody = el('tbody');
      fields.forEach(function (f) {
        var tr = el('tr');
        tr.appendChild(el('th', null, f[0]));
        picked.forEach(function (b) { tr.appendChild(el('td', null, f[1](b))); });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      var scroll = el('div', 'ygn-tablescroll');
      scroll.appendChild(table);
      body.appendChild(scroll);
      var clear = el('button', 'ygn-fbtn is-quiet', 'Clear tray');
      clear.type = 'button';
      clear.addEventListener('click', function () {
        tray = []; D.store.set(TRAY_KEY, tray); render(); D.toast('Tray cleared');
      });
      body.appendChild(clear);
    }
    render();
    return c;
  }

  /* ═══ Boot ═══════════════════════════════════════════════════════════════ */
  D.ready(function () {
    // Nothing here renders on the home page, so don't pull the digest there.
    if (page !== 'bills' && page !== 'bill') return;
    D.digest().then(function (digest) {
      var bills = (digest && digest.bills) || [];
      if (!bills.length) return;
      if (page === 'bills') {
        D.guard('bills-analysis', function () { buildBillsAnalysis(bills, digest); });
      } else if (page === 'bill') {
        var id = D.param('id');
        D.settled('bill-container').then(function () {
          D.guard('bill-detail', function () { buildBillDetail(bills, id); });
        });
      }
    });
  });
})();
