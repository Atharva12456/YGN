/* ═══════════════════════════════════════════════════════════════════════════
   YGN — roster analysis
   ───────────────────────────────────────────────────────────────────────────
   Fifteen features that read the whole chamber at once. The site already had
   per-member pages and a per-member ethics grade; what it had no way to answer
   was "compared to whom?" — every number sat on its own with nothing to place
   it against. These all place a member or a state against the full population.

   Everything is computed from officials.json joined to member-scores.json by
   the shared data layer. NOMINATE dim1 is the first-dimension ideal point
   (negative left, positive right); the ethics score is the site's own 0-100
   campaign-finance measure, which is why the ethics panels link out to the
   methodology rather than presenting the number as self-evident.

     Members page                      Member detail
     1  Ideology distribution         11  Ideology percentile + lean
     2  Ethics grade distribution     12  Ethics percentile (chamber + party)
     3  Party overlap                 13  Closest ideological neighbours
     4  Ethics vs ideology            14  Nearest member across the aisle
     5  House vs Senate               15  Rank within their delegation
     6  Longest serving
     7  Freshman class
     8  Ethics outliers
     9  Delegation table
    10  Most divided delegations
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var D = window.ygnData;
  if (!D) return;
  var page = D.page();

  var el = D.el, card = D.card, fmt = D.fmt, S = D.stats;
  var chip = D.chip, statRow = D.statRow;

  /* ── Shared bits ───────────────────────────────────────────────────────── */
  var PARTY_CATS = [
    { label: 'Democrat',    tone: 'dem', test: function (m) { return m.partyKey === 'D'; } },
    { label: 'Republican',  tone: 'rep', test: function (m) { return m.partyKey === 'R'; } },
    { label: 'Independent', tone: 'ind', test: function (m) { return m.partyKey === 'I'; } }
  ];
  function partyTone(k) { return k === 'D' ? 'dem' : k === 'R' ? 'rep' : 'ind'; }

  function memberLink(m) {
    var a = el('a', 'ygn-mlink');
    a.href = 'member.html?id=' + encodeURIComponent(m.id);
    a.textContent = m.name;
    return a;
  }
  function legend(cats) {
    var wrap = el('div', 'ygn-legend');
    cats.forEach(function (c) {
      var i = el('span', 'ygn-legend-item');
      i.appendChild(el('span', 'ygn-legend-swatch is-' + c.tone));
      i.appendChild(el('span', null, c.label));
      wrap.appendChild(i);
    });
    return wrap;
  }

  // A compact ranked list used by several of the leaderboards below.
  function rankList(items, render, limit) {
    var ol = el('ol', 'ygn-ranklist');
    items.slice(0, limit || 10).forEach(function (it, i) {
      var li = el('li');
      li.appendChild(el('span', 'ygn-rank-n', String(i + 1)));
      var body = el('span', 'ygn-rank-body');
      render(body, it);
      li.appendChild(body);
      ol.appendChild(li);
    });
    return ol;
  }

  /* ═══ MEMBERS PAGE ═══════════════════════════════════════════════════════ */
  function buildMembersAnalysis(roster) {
    if (document.querySelector('.ygn-memberpanel')) return;
    // Below the member grid, not above it: this is supporting reading, and the
    // page exists to show members.
    var anchor = document.getElementById('members-grid');
    if (!anchor) return;
    var withIdeology = roster.filter(function (m) { return m.ideology !== null; });
    var withEthics = roster.filter(function (m) { return m.ethics !== null; });

    D.panel({
      after: anchor,
      className: 'ygn-memberpanel',
      storeKey: 'ygn-memberpanel-open',
      title: 'Chamber analysis',
      summary: 'How the whole chamber compares — party distance, ethics, seniority and delegations.',
      cards: [
        D.guard('an:1', function () { return gradeDistribution(withEthics); }),
        D.guard('an:2', function () { return partyDistance(withIdeology); }),
        D.guard('an:3', function () { return ethicsVsIdeology(roster); }),
        D.guard('an:4', function () { return chamberCompare(roster); }),
        D.guard('an:5', function () { return longestServing(roster); }),
        D.guard('an:6', function () { return freshmanClass(roster); }),
        D.guard('an:7', function () { return ethicsOutliers(withEthics); }),
        D.guard('an:8', function () { return delegationTable(roster); }),
        D.guard('an:9', function () { return dividedDelegations(withIdeology); })
      ]
    });
  }

  /* 1. Ethics grades, ordered A → F rather than by count.
        (An ideology histogram used to live here too. It duplicated the
        #ideology-strip features.js already draws above the member grid — and
        that one is filter-aware, so it was also the better of the two. Its only
        unique content, the party medians, moved into partyDistance below.) */
  var GRADE_ORDER = ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F'];
  function gradeDistribution(members) {
    var c = card('Ethics grades', 'How the ' + members.length + ' scored members are distributed');
    var byGrade = S.groupBy(members, function (m) { return m.grade; });
    var rows = GRADE_ORDER.filter(function (g) { return byGrade[g]; }).map(function (g) {
      return { label: g, value: byGrade[g].length,
               tone: g[0] === 'A' || g[0] === 'B' ? 'good' : g[0] === 'C' ? 'mid' : 'bad',
               title: byGrade[g].length + ' members graded ' + g };
    });
    c.body.appendChild(D.barChart(rows, { label: 'Members per ethics grade', labelWidth: 40 }));
    var scores = members.map(function (m) { return m.ethics; });
    c.body.appendChild(statRow('Median score', fmt.num(S.median(scores), 1) + ' / 100'));
    c.body.appendChild(statRow('Spread (SD)', fmt.num(S.sd(scores), 1)));
    var link = el('a', 'ygn-flink', 'How grades are computed');
    link.href = 'ethics-methodology.html';
    c.body.appendChild(link);
    return c;
  }

  /* 2. How far apart the parties actually sit: medians, the gap between them,
        and whether their ranges overlap at all. The strip above the member grid
        draws the shape of the distribution; this states the numbers, which it
        does not. */
  function partyDistance(members) {
    var c = card('How far apart the parties are', 'Measured on NOMINATE, across ' + members.length + ' rated members');
    var dem = members.filter(function (m) { return m.partyKey === 'D'; });
    var rep = members.filter(function (m) { return m.partyKey === 'R'; });
    if (!dem.length || !rep.length) { c.body.appendChild(D.note('Not enough rated members.')); return c; }
    var demVals = dem.map(function (m) { return m.ideology; });
    var repVals = rep.map(function (m) { return m.ideology; });

    c.body.appendChild(statRow('Democratic median', fmt.ideology(S.median(demVals))));
    c.body.appendChild(statRow('Republican median', fmt.ideology(S.median(repVals))));
    c.body.appendChild(statRow('Gap between them',
      fmt.ideology(S.median(repVals) - S.median(demVals)), 'on a scale running roughly −1 to +1'));

    var demMax = Math.max.apply(null, demVals), repMin = Math.min.apply(null, repVals);
    // Members in the zone where the two parties' ranges cross over.
    var crossers = members.filter(function (m) {
      if (m.partyKey === 'D') return m.ideology >= repMin;
      if (m.partyKey === 'R') return m.ideology <= demMax;
      return false;
    }).sort(function (a, b) { return a.ideology - b.ideology; });

    c.body.appendChild(statRow('Overlap zone', fmt.ideology(repMin) + ' to ' + fmt.ideology(demMax),
      demMax >= repMin ? 'the two parties’ ranges cross here' : 'the ranges do not touch'));
    c.body.appendChild(statRow('Members inside it', String(crossers.length),
      fmt.pct(crossers.length / members.length * 100, 1) + ' of rated members'));
    if (crossers.length) {
      var list = el('ul', 'ygn-minilist');
      crossers.slice(0, 6).forEach(function (m) {
        var li = el('li');
        li.appendChild(memberLink(m));
        li.appendChild(chip(m.partyKey, partyTone(m.partyKey)));
        li.appendChild(el('span', 'ygn-mini-val', fmt.ideology(m.ideology)));
        list.appendChild(li);
      });
      c.body.appendChild(list);
      if (crossers.length > 6) c.body.appendChild(D.note('Showing 6 of ' + crossers.length + '.'));
    } else {
      c.body.appendChild(D.note('No member of either party scores inside the other party’s range.'));
    }
    return c;
  }

  /* 4. Is there any relationship between ideology and the ethics score?
        Reported with the correlation stated plainly, including when it is
        near zero — which is itself the interesting answer. */
  function ethicsVsIdeology(roster) {
    var both = roster.filter(function (m) { return m.ideology !== null && m.ethics !== null; });
    var c = card('Ethics against ideology', both.length + ' members have both scores');
    if (both.length < 10) { c.body.appendChild(D.note('Not enough overlap to plot.')); return c; }
    c.body.appendChild(D.scatterChart(both.map(function (m) {
      return { x: m.ideology, y: m.ethics, tone: partyTone(m.partyKey),
               title: m.name + ' — ideology ' + fmt.ideology(m.ideology) + ', ethics ' + fmt.num(m.ethics, 1) };
    }), { xLabel: 'liberal ← ideology → conservative', yLabel: 'ethics score', yMin: 0, yMax: 100,
          label: 'Ethics score plotted against ideology' }));
    var r = S.correlation(both.map(function (m) { return [m.ideology, m.ethics]; }));
    var strength = r === null ? 'unknown'
      : Math.abs(r) < 0.1 ? 'essentially none'
      : Math.abs(r) < 0.3 ? 'weak'
      : Math.abs(r) < 0.5 ? 'moderate' : 'strong';
    c.body.appendChild(statRow('Correlation (r)', r === null ? '—' : r.toFixed(2), strength + ' relationship'));
    c.body.appendChild(D.note(
      'A near-zero correlation means the ethics score is not tracking left or right — ' +
      'it is measuring something else.'));
    return c;
  }

  /* 5. House against Senate on both measures. */
  function chamberCompare(roster) {
    var c = card('House against Senate', 'Medians for each chamber');
    var byCh = S.groupBy(roster, function (m) { return m.chamber; });
    var table = el('table', 'ygn-ftable');
    table.innerHTML = '<thead><tr><th>Chamber</th><th>Members</th><th>Median ideology</th>' +
                      '<th>Median ethics</th><th>Median tenure</th></tr></thead>';
    var tbody = el('tbody');
    var thisYear = new Date().getFullYear();
    Object.keys(byCh).sort().forEach(function (ch) {
      var ms = byCh[ch];
      var tr = el('tr');
      [ch, String(ms.length),
       fmt.ideology(S.median(ms.map(function (m) { return m.ideology; }))),
       fmt.num(S.median(ms.map(function (m) { return m.ethics; })), 1),
       (function () {
         var yrs = ms.map(function (m) { return m.firstYear ? thisYear - m.firstYear : null; });
         var med = S.median(yrs);
         return med === null ? '—' : fmt.num(med, 0) + ' yrs';
       })()
      ].forEach(function (v) { tr.appendChild(el('td', null, v)); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    // Five columns of tabular data do not fit a phone; let the table scroll
    // inside its own card rather than stretching it.
    var scroll = el('div', 'ygn-tablescroll');
    scroll.appendChild(table);
    c.body.appendChild(scroll);
    return c;
  }

  /* 6. Longest-serving, from the earliest term start year on record. */
  function longestServing(roster) {
    var thisYear = new Date().getFullYear();
    var ranked = roster.filter(function (m) { return m.firstYear; })
      .sort(function (a, b) { return a.firstYear - b.firstYear; });
    var c = card('Longest serving', 'By first year of service in the record');
    c.body.appendChild(rankList(ranked, function (body, m) {
      body.appendChild(memberLink(m));
      body.appendChild(chip(m.stateAbbr + ' · ' + m.partyKey, partyTone(m.partyKey)));
      body.appendChild(el('span', 'ygn-mini-val', (thisYear - m.firstYear) + ' yrs'));
    }, 6));
    c.body.appendChild(D.note('Counted from the earliest term Congress.gov lists, so a break in service is not subtracted.'));
    return c;
  }

  /* 7. Newest members — the mirror of the above. */
  function freshmanClass(roster) {
    var latest = Math.max.apply(null, roster.map(function (m) { return m.firstYear || 0; }));
    var fresh = roster.filter(function (m) { return m.firstYear === latest; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    var c = card('Newest members', fresh.length + ' first seated in ' + latest);
    var byParty = S.groupBy(fresh, function (m) { return m.partyKey; });
    c.body.appendChild(statRow('Party split',
      ['D', 'R', 'I'].filter(function (k) { return byParty[k]; })
        .map(function (k) { return byParty[k].length + ' ' + k; }).join(' · ') || '—'));
    var list = el('ul', 'ygn-minilist');
    fresh.slice(0, 8).forEach(function (m) {
      var li = el('li');
      li.appendChild(memberLink(m));
      li.appendChild(chip(m.stateAbbr + ' · ' + m.partyKey, partyTone(m.partyKey)));
      list.appendChild(li);
    });
    c.body.appendChild(list);
    if (fresh.length > 8) c.body.appendChild(D.note('Showing 8 of ' + fresh.length + '.'));
    return c;
  }

  /* 8. Ethics scores more than 1.5 SD from the mean, both directions. */
  function ethicsOutliers(members) {
    var vals = members.map(function (m) { return m.ethics; });
    var mean = S.mean(vals), sd = S.sd(vals);
    var c = card('Ethics outliers', 'More than 1.5 standard deviations from the mean');
    if (mean === null || !sd) { c.body.appendChild(D.note('Not enough scored members.')); return c; }
    var hi = members.filter(function (m) { return m.ethics >= mean + 1.5 * sd; })
                    .sort(function (a, b) { return b.ethics - a.ethics; });
    var lo = members.filter(function (m) { return m.ethics <= mean - 1.5 * sd; })
                    .sort(function (a, b) { return a.ethics - b.ethics; });
    c.body.appendChild(statRow('Mean', fmt.num(mean, 1), 'SD ' + fmt.num(sd, 1)));
    [['Well above', hi, 'good'], ['Well below', lo, 'bad']].forEach(function (pair) {
      c.body.appendChild(el('p', 'ygn-fsublabel', pair[0] + ' (' + pair[1].length + ')'));
      if (!pair[1].length) { c.body.appendChild(D.note('None.')); return; }
      var list = el('ul', 'ygn-minilist');
      pair[1].slice(0, 4).forEach(function (m) {
        var li = el('li');
        li.appendChild(memberLink(m));
        li.appendChild(chip(m.grade || '—', pair[2]));
        li.appendChild(el('span', 'ygn-mini-val', fmt.num(m.ethics, 1)));
        list.appendChild(li);
      });
      c.body.appendChild(list);
    });
    return c;
  }

  /* 9. Every state as a row: size, party split, and both medians. Sortable,
        because the interesting question changes depending on what you came for. */
  function delegationTable(roster) {
    var c = card('State delegations', 'Click a column to sort');
    var byState = S.groupBy(roster, function (m) { return m.state; });
    var rows = Object.keys(byState).map(function (st) {
      var ms = byState[st];
      var byP = S.groupBy(ms, function (m) { return m.partyKey; });
      return {
        state: st, abbr: D.abbr(st), n: ms.length,
        d: (byP.D || []).length, r: (byP.R || []).length, i: (byP.I || []).length,
        ideology: S.median(ms.map(function (m) { return m.ideology; })),
        ethics: S.median(ms.map(function (m) { return m.ethics; }))
      };
    });
    var table = el('table', 'ygn-ftable ygn-ftable--sortable');
    var cols = [
      { key: 'state', label: 'State', num: false },
      { key: 'n', label: 'Seats', num: true },
      { key: 'split', label: 'D / R / I', num: false },
      { key: 'ideology', label: 'Median ideology', num: true },
      { key: 'ethics', label: 'Median ethics', num: true }
    ];
    var thead = el('thead'), htr = el('tr');
    cols.forEach(function (col) {
      var th = el('th', 'ygn-sortable-th', col.label);
      th.tabIndex = 0;
      th.setAttribute('role', 'button');
      th.addEventListener('click', function () { sortBy(col); });
      th.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(col); }
      });
      col.th = th;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = el('tbody');
    table.appendChild(tbody);

    var dir = 1, activeKey = 'state';
    function sortBy(col) {
      dir = activeKey === col.key ? -dir : 1;
      activeKey = col.key;
      cols.forEach(function (x) { x.th.removeAttribute('data-sort'); });
      col.th.setAttribute('data-sort', dir === 1 ? 'asc' : 'desc');
      render();
    }
    function render() {
      var sorted = rows.slice().sort(function (a, b) {
        // Sort by partisan margin. The parenthesis matters: without it `dir`
        // multiplies only the second term and the ordering is nonsense.
        if (activeKey === 'split') return ((a.d - a.r) - (b.d - b.r)) * dir;
        var av = a[activeKey], bv = b[activeKey];
        if (av === null) return 1;
        if (bv === null) return -1;
        if (typeof av === 'string') return av.localeCompare(bv) * dir;
        return (av - bv) * dir;
      });
      tbody.innerHTML = '';
      sorted.forEach(function (r) {
        var tr = el('tr');
        var stCell = el('td');
        var link = el('a', 'ygn-mlink', r.state);
        link.href = 'members.html?state=' + encodeURIComponent(r.state);
        stCell.appendChild(link);
        tr.appendChild(stCell);
        tr.appendChild(el('td', null, String(r.n)));
        var splitCell = el('td', 'ygn-split');
        [['D', r.d, 'dem'], ['R', r.r, 'rep'], ['I', r.i, 'ind']].forEach(function (p) {
          if (!p[1]) return;
          splitCell.appendChild(chip(p[1] + ' ' + p[0], p[2]));
        });
        tr.appendChild(splitCell);
        tr.appendChild(el('td', null, fmt.ideology(r.ideology)));
        tr.appendChild(el('td', null, r.ethics === null ? '—' : fmt.num(r.ethics, 1)));
        tbody.appendChild(tr);
      });
    }
    sortBy(cols[0]);
    var scroll = el('div', 'ygn-tablescroll');
    scroll.appendChild(table);
    c.body.appendChild(scroll);
    return c;
  }

  /* 10. Which delegations disagree with themselves the most. */
  function dividedDelegations(members) {
    var byState = S.groupBy(members, function (m) { return m.state; });
    var rows = Object.keys(byState).map(function (st) {
      var vals = byState[st].map(function (m) { return m.ideology; });
      return { state: st, n: vals.length, sd: S.sd(vals),
               range: vals.length > 1 ? Math.max.apply(null, vals) - Math.min.apply(null, vals) : null };
    }).filter(function (r) { return r.n >= 3 && r.sd !== null; });
    var c = card('Most divided delegations', 'Spread of ideology within a state, 3+ rated members');
    if (!rows.length) { c.body.appendChild(D.note('Not enough data.')); return c; }
    rows.sort(function (a, b) { return b.sd - a.sd; });
    c.body.appendChild(el('p', 'ygn-fsublabel', 'Widest internal spread'));
    c.body.appendChild(D.barChart(rows.slice(0, 5).map(function (r) {
      return { label: D.abbr(r.state), value: +r.sd.toFixed(3), display: r.sd.toFixed(2),
               tone: 'mid', title: r.state + ': SD ' + r.sd.toFixed(3) + ' across ' + r.n + ' members' };
    }), { labelWidth: 34, label: 'Most divided delegations' }));
    c.body.appendChild(el('p', 'ygn-fsublabel', 'Most uniform'));
    c.body.appendChild(D.barChart(rows.slice(-5).reverse().map(function (r) {
      return { label: D.abbr(r.state), value: +r.sd.toFixed(3), display: r.sd.toFixed(2),
               tone: 'good', title: r.state + ': SD ' + r.sd.toFixed(3) + ' across ' + r.n + ' members' };
    }), { labelWidth: 34, label: 'Most uniform delegations' }));
    return c;
  }

  /* ═══ MEMBER DETAIL PAGE ═════════════════════════════════════════════════ */
  function buildMemberAnalysis(roster, id) {
    var me = roster.filter(function (m) { return m.id === id; })[0];
    if (!me) return;
    var container = document.getElementById('dossier-container');
    var host = document.getElementById('main-content') || container;
    if (!host) return;
    if (document.querySelector('.ygn-member-analysis')) return;

    var wrap = el('div', 'ygn-member-analysis');
    wrap.appendChild(el('h2', 'ygn-ma-title', 'How ' + me.last + ' compares'));
    var grid = el('div', 'ygn-analysis-grid');
    wrap.appendChild(grid);

    var peers = roster.filter(function (m) { return m.chamber === me.chamber; });

    D.guard('ma:11', function () { grid.appendChild(ideologyPercentile(me, peers)); });
    D.guard('ma:12', function () { grid.appendChild(ethicsPercentile(me, peers, roster)); });
    D.guard('ma:13', function () { grid.appendChild(nearestNeighbours(me, peers)); });
    D.guard('ma:14', function () { grid.appendChild(acrossTheAisle(me, peers)); });
    D.guard('ma:15', function () { grid.appendChild(delegationRank(me, roster)); });

    host.appendChild(wrap);
  }

  /* 11. Where this member sits in their own chamber. */
  function ideologyPercentile(me, peers) {
    var c = card('Ideological position', 'Against the ' + D.chamberShort(me.chamber));
    if (me.ideology === null) { c.body.appendChild(D.note('No NOMINATE score on record.')); return c; }
    var vals = peers.map(function (m) { return m.ideology; });
    var pct = S.percentile(vals, me.ideology);
    c.body.appendChild(statRow('Score', fmt.ideology(me.ideology), fmt.lean(me.ideology)));
    c.body.appendChild(statRow('More conservative than', fmt.pct(pct, 0),
      'of the ' + D.chamberShort(me.chamber)));
    var own = peers.filter(function (m) { return m.partyKey === me.partyKey; });
    var ownPct = S.percentile(own.map(function (m) { return m.ideology; }), me.ideology);
    c.body.appendChild(statRow('Within their party', fmt.pct(ownPct, 0),
      'of ' + D.partyLabel(me.partyKey) + 's are to their left'));
    // The member's own position marked on the chamber distribution.
    var bins = S.histogram(peers.filter(function (m) { return m.ideology !== null; }),
                           function (m) { return m.ideology; }, 22);
    // The categories stack, so a member counted by both their party and the
    // "me" band would make their own bin one taller than it really is. The
    // party tests exclude them here.
    var cats = PARTY_CATS.map(function (cat) {
      return { label: cat.label, tone: cat.tone,
               test: function (m) { return m.id !== me.id && cat.test(m); } };
    }).concat([{ label: me.last, tone: 'me', test: function (m) { return m.id === me.id; } }]);
    var chart = D.histogramChart(bins, cats,
      { xLeft: '← liberal', xRight: 'conservative →', label: 'Position within the chamber' });
    c.body.appendChild(chart);
    c.body.appendChild(D.note('Their own bar is highlighted.'));
    return c;
  }

  /* 12. The same idea for the ethics score, against chamber and party. */
  function ethicsPercentile(me, peers, roster) {
    var c = card('Ethics standing', 'Against peers on the site’s 0-100 score');
    if (me.ethics === null) { c.body.appendChild(D.note('No ethics score on record.')); return c; }
    var chamberPct = S.percentile(peers.map(function (m) { return m.ethics; }), me.ethics);
    var party = roster.filter(function (m) { return m.partyKey === me.partyKey; });
    var partyPct = S.percentile(party.map(function (m) { return m.ethics; }), me.ethics);
    var statePeers = roster.filter(function (m) { return m.state === me.state; });
    c.body.appendChild(statRow('Score', fmt.num(me.ethics, 1) + ' / 100', 'grade ' + (me.grade || '—')));
    c.body.appendChild(statRow('Above', fmt.pct(chamberPct, 0), 'of the ' + D.chamberShort(me.chamber)));
    c.body.appendChild(statRow('Above', fmt.pct(partyPct, 0), 'of ' + D.partyLabel(me.partyKey) + 's'));
    if (statePeers.length > 1) {
      var stateRanked = statePeers.filter(function (m) { return m.ethics !== null; })
        .sort(function (a, b) { return b.ethics - a.ethics; });
      var idx = stateRanked.map(function (m) { return m.id; }).indexOf(me.id);
      if (idx > -1) {
        c.body.appendChild(statRow('In ' + me.state, '#' + (idx + 1) + ' of ' + stateRanked.length,
          'by ethics score'));
      }
    }
    var link = el('a', 'ygn-flink', 'What this score measures');
    link.href = 'ethics-methodology.html';
    c.body.appendChild(link);
    return c;
  }

  /* 13. The members whose ideal points sit closest to theirs. */
  function nearestNeighbours(me, peers) {
    var c = card('Closest neighbours', 'Nearest ideal points in the same chamber');
    if (me.ideology === null) { c.body.appendChild(D.note('No score to compare.')); return c; }
    var near = peers.filter(function (m) { return m.id !== me.id && m.ideology !== null; })
      .map(function (m) { return { m: m, d: Math.abs(m.ideology - me.ideology) }; })
      .sort(function (a, b) { return a.d - b.d; })
      .slice(0, 5);
    var list = el('ul', 'ygn-minilist');
    near.forEach(function (n) {
      var li = el('li');
      li.appendChild(memberLink(n.m));
      li.appendChild(chip(n.m.stateAbbr + ' · ' + n.m.partyKey, partyTone(n.m.partyKey)));
      li.appendChild(el('span', 'ygn-mini-val', fmt.ideology(n.m.ideology)));
      list.appendChild(li);
    });
    c.body.appendChild(list);
    c.body.appendChild(D.note('Closeness on this scale reflects overall voting pattern, not agreement on any one bill.'));
    return c;
  }

  /* 14. The nearest member of the other party — often the more telling number. */
  function acrossTheAisle(me, peers) {
    var c = card('Across the aisle', 'Nearest member of the other party');
    if (me.ideology === null || !me.partyKey) { c.body.appendChild(D.note('No score to compare.')); return c; }
    var otherKey = me.partyKey === 'D' ? 'R' : me.partyKey === 'R' ? 'D' : null;
    if (!otherKey) { c.body.appendChild(D.note('Not applicable for independents.')); return c; }
    var others = peers.filter(function (m) { return m.partyKey === otherKey && m.ideology !== null; })
      .map(function (m) { return { m: m, d: Math.abs(m.ideology - me.ideology) }; })
      .sort(function (a, b) { return a.d - b.d; });
    if (!others.length) { c.body.appendChild(D.note('No rated members of the other party.')); return c; }
    var list = el('ul', 'ygn-minilist');
    others.slice(0, 4).forEach(function (n) {
      var li = el('li');
      li.appendChild(memberLink(n.m));
      li.appendChild(chip(n.m.stateAbbr, partyTone(n.m.partyKey)));
      li.appendChild(el('span', 'ygn-mini-val', 'gap ' + n.d.toFixed(2)));
      list.appendChild(li);
    });
    c.body.appendChild(list);
    var ownSide = peers.filter(function (m) {
      return m.partyKey === me.partyKey && m.ideology !== null && m.id !== me.id;
    }).map(function (m) { return Math.abs(m.ideology - me.ideology); });
    var nearestOwn = ownSide.length ? Math.min.apply(null, ownSide) : null;
    if (nearestOwn !== null) {
      c.body.appendChild(statRow('Nearest in own party', nearestOwn.toFixed(2),
        others[0].d < nearestOwn ? 'further than the nearest across the aisle' : 'closer than any opponent'));
    }
    return c;
  }

  /* 15. Their place in their own state's delegation. */
  function delegationRank(me, roster) {
    var mates = roster.filter(function (m) { return m.state === me.state; });
    var c = card('In the ' + me.state + ' delegation', mates.length + ' members');
    var byP = S.groupBy(mates, function (m) { return m.partyKey; });
    c.body.appendChild(statRow('Party split',
      ['D', 'R', 'I'].filter(function (k) { return byP[k]; })
        .map(function (k) { return byP[k].length + ' ' + k; }).join(' · ')));
    var rated = mates.filter(function (m) { return m.ideology !== null; })
      .sort(function (a, b) { return a.ideology - b.ideology; });
    var idx = rated.map(function (m) { return m.id; }).indexOf(me.id);
    if (idx > -1) {
      c.body.appendChild(statRow('Ideological rank', '#' + (idx + 1) + ' of ' + rated.length,
        'most liberal to most conservative'));
    }
    var list = el('ul', 'ygn-minilist');
    rated.forEach(function (m) {
      var li = el('li');
      if (m.id === me.id) li.className = 'is-me';
      li.appendChild(m.id === me.id ? el('span', 'ygn-mlink is-me', m.name) : memberLink(m));
      li.appendChild(chip(m.partyKey, partyTone(m.partyKey)));
      li.appendChild(el('span', 'ygn-mini-val', fmt.ideology(m.ideology)));
      list.appendChild(li);
    });
    c.body.appendChild(list);
    return c;
  }

  /* ═══ Boot ═══════════════════════════════════════════════════════════════ */
  D.ready(function () {
    if (page === 'members') {
      D.roster().then(function (roster) {
        if (roster && roster.length) D.guard('members-analysis', function () { buildMembersAnalysis(roster); });
      });
    } else if (page === 'member') {
      var id = D.param('id');
      if (!id) return;
      // The dossier is written more than once; wait for it to settle, then
      // mount below it inside main-content so a later write can't wipe this.
      Promise.all([D.roster(), D.settled('dossier-container')]).then(function (out) {
        var roster = out[0];
        if (!roster || !roster.length) return;
        D.guard('member-analysis', function () { buildMemberAnalysis(roster, id); });
      });
    }
  });
})();
