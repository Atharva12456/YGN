/* ═══════════════════════════════════════════════════════════════════════════
   YGN — personal tools
   ───────────────────────────────────────────────────────────────────────────
   Eleven features for the reader rather than the data. The site could already
   save a member or a bill, but saving was the end of the road: there was no
   way to annotate, compare, export, or find out what had changed.

   Everything is stored in this browser under an ygn- key, which means the
   settings menu already knows how to count and clear it. Nothing is sent
   anywhere, and every writer here goes through the same store so a backup can
   round-trip the lot.

    40  Private notes             46  Reading history
    41  Member compare tray       47  Data freshness
    42  Export saved items        48  Palette filters (state: party: chamber:)
    43  Printable briefing        49  Shareable filtered links
    44  My delegation             50  Backup and restore
    45  Watchlist digest
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var D = window.ygnData;
  if (!D) return;
  var page = D.page();

  var el = D.el, card = D.card, fmt = D.fmt;

  var KEYS = {
    notes:   'ygn-notes',
    tray:    'ygn-member-tray',
    home:    'ygn-home-state',
    history: 'ygn-history',
    seen:    'ygn-saved-seen',
    savedM:  'ygn_saved_members_v1',
    savedB:  'ygn_saved_bills_v1'
  };

  function chip(t, tone) { return el('span', 'ygn-chip' + (tone ? ' is-' + tone : ''), t); }
  function statRow(label, value, hint) {
    var r = el('div', 'ygn-statrow');
    r.appendChild(el('span', 'ygn-statrow-label', label));
    r.appendChild(el('span', 'ygn-statrow-value', value));
    if (hint) r.appendChild(el('span', 'ygn-statrow-hint', hint));
    return r;
  }
  function savedMembers() { return D.store.get(KEYS.savedM, []) || []; }
  function savedBills() { return D.store.get(KEYS.savedB, []) || []; }
  function download(name, text, type) {
    try {
      var blob = new Blob([text], { type: type });
      var url = URL.createObjectURL(blob);
      var a = el('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      D.toast('Downloaded ' + name);
      return true;
    } catch (e) { D.toast('Could not build the file', 'warn'); return false; }
  }
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* ── 40. Private notes on a member or bill ─────────────────────────────── */
  function notesPanel(subjectKey, subjectLabel) {
    var c = card('Your notes', 'Private to this browser');
    var all = D.store.get(KEYS.notes, {}) || {};
    var box = el('textarea', 'ygn-notebox');
    box.rows = 4;
    box.placeholder = 'Anything you want to remember about ' + subjectLabel + '…';
    box.value = (all[subjectKey] && all[subjectKey].text) || '';
    box.setAttribute('aria-label', 'Notes on ' + subjectLabel);
    c.body.appendChild(box);

    var meta = el('p', 'ygn-fnote');
    function setMeta() {
      var n = (D.store.get(KEYS.notes, {}) || {})[subjectKey];
      meta.textContent = n && n.updated ? 'Saved ' + fmt.ago(n.updated) : 'Not saved yet.';
    }
    setMeta();
    c.body.appendChild(meta);

    var row = el('div', 'ygn-btnrow');
    var save = el('button', 'ygn-fbtn', 'Save note');
    save.type = 'button';
    save.addEventListener('click', function () {
      var store = D.store.get(KEYS.notes, {}) || {};
      var text = box.value.trim();
      if (!text) delete store[subjectKey];
      else store[subjectKey] = { text: text, label: subjectLabel, updated: new Date().toISOString() };
      D.store.set(KEYS.notes, store);
      setMeta();
      D.toast(text ? 'Note saved' : 'Note cleared');
    });
    row.appendChild(save);
    var clear = el('button', 'ygn-fbtn is-quiet', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', function () { box.value = ''; save.click(); });
    row.appendChild(clear);
    c.body.appendChild(row);
    return c;
  }

  /* ── 41. Pin members and compare them ──────────────────────────────────── */
  function memberTray(roster, meId) {
    var c = card('Compare tray', 'Pin up to four members and read them side by side');
    var tray = D.store.get(KEYS.tray, []) || [];
    var me = meId ? roster.filter(function (m) { return m.id === meId; })[0] : null;

    function render() {
      c.body.innerHTML = '';
      if (me) {
        var inTray = tray.indexOf(me.id) > -1;
        var btn = el('button', 'ygn-fbtn' + (inTray ? ' is-on' : ''),
                     inTray ? 'Remove ' + me.last : 'Add ' + me.last + ' to the tray');
        btn.type = 'button';
        btn.addEventListener('click', function () {
          var i = tray.indexOf(me.id);
          if (i > -1) tray.splice(i, 1); else tray.push(me.id);
          tray = tray.slice(-4);
          D.store.set(KEYS.tray, tray);
          D.toast(i > -1 ? 'Removed from tray' : 'Added to tray');
          render();
        });
        c.body.appendChild(btn);
      }
      var picked = tray.map(function (id) {
        return roster.filter(function (m) { return m.id === id; })[0];
      }).filter(Boolean);
      if (!picked.length) {
        c.body.appendChild(D.note('Nothing pinned. Add members from their pages, then compare them here.'));
        return;
      }
      var fields = [
        ['Member', function (m) { return m.name; }],
        ['Party', function (m) { return m.party || '—'; }],
        ['State', function (m) { return m.state || '—'; }],
        ['Chamber', function (m) { return m.chamber || '—'; }],
        ['Ideology', function (m) { return fmt.ideology(m.ideology); }],
        ['Lean', function (m) { return fmt.lean(m.ideology); }],
        ['Ethics', function (m) { return m.ethics === null ? '—' : fmt.num(m.ethics, 1); }],
        ['Grade', function (m) { return m.grade || '—'; }],
        ['Since', function (m) { return m.firstYear ? String(m.firstYear) : '—'; }]
      ];
      var table = el('table', 'ygn-ftable');
      var tbody = el('tbody');
      fields.forEach(function (f) {
        var tr = el('tr');
        tr.appendChild(el('th', null, f[0]));
        picked.forEach(function (m) { tr.appendChild(el('td', null, f[1](m))); });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      var scroll = el('div', 'ygn-tablescroll');
      scroll.appendChild(table);
      c.body.appendChild(scroll);
      var clear = el('button', 'ygn-fbtn is-quiet', 'Clear tray');
      clear.type = 'button';
      clear.addEventListener('click', function () {
        tray = []; D.store.set(KEYS.tray, tray); render(); D.toast('Tray cleared');
      });
      c.body.appendChild(clear);
    }
    render();
    return c;
  }

  /* ── 42 + 43 + 50. The saved-items workbench ───────────────────────────── */
  function savedWorkbench(roster) {
    var c = card('Your saved items', 'Export, print, back up');
    var members = savedMembers(), bills = savedBills();
    var notes = D.store.get(KEYS.notes, {}) || {};
    c.body.appendChild(statRow('Saved members', String(members.length)));
    c.body.appendChild(statRow('Saved bills', String(bills.length)));
    c.body.appendChild(statRow('Notes written', String(Object.keys(notes).length)));

    function resolved() {
      return members.map(function (id) {
        return roster.filter(function (m) { return m.id === id; })[0] || { id: id, name: id };
      });
    }

    var row = el('div', 'ygn-btnrow');

    /* 42. CSV of everything saved. */
    var csv = el('button', 'ygn-fbtn', 'Export CSV');
    csv.type = 'button';
    csv.addEventListener('click', function () {
      var lines = ['type,id,name,party,state,chamber,ideology,ethics,grade,note'];
      resolved().forEach(function (m) {
        var n = notes['member:' + m.id];
        lines.push(['member', m.id, m.name, m.party, m.state, m.chamber,
                    m.ideology, m.ethics, m.grade, n && n.text].map(csvCell).join(','));
      });
      bills.forEach(function (b) {
        var n = notes['bill:' + b];
        lines.push(['bill', b, '', '', '', '', '', '', '', n && n.text].map(csvCell).join(','));
      });
      download('ygn-saved.csv', lines.join('\n'), 'text/csv');
    });
    row.appendChild(csv);

    /* 43. A printable briefing sheet. */
    var brief = el('button', 'ygn-fbtn', 'Printable briefing');
    brief.type = 'button';
    brief.addEventListener('click', function () {
      var sheet = document.querySelector('.ygn-briefing');
      if (sheet) sheet.remove();
      sheet = el('div', 'ygn-briefing');
      var h = el('h1', null, 'YGN briefing');
      sheet.appendChild(h);
      sheet.appendChild(el('p', 'ygn-brief-meta',
        'Prepared ' + new Date().toLocaleString('en-US') + ' from items saved in this browser.'));
      if (resolved().length) {
        sheet.appendChild(el('h2', null, 'Members'));
        resolved().forEach(function (m) {
          var b = el('div', 'ygn-brief-item');
          b.appendChild(el('h3', null, m.name));
          b.appendChild(el('p', null, [m.party, m.state, m.chamber].filter(Boolean).join(' · ')));
          b.appendChild(el('p', null,
            'Ideology ' + fmt.ideology(m.ideology) + ' (' + fmt.lean(m.ideology) + ') · ' +
            'Ethics ' + (m.ethics === null ? '—' : fmt.num(m.ethics, 1)) + ' (' + (m.grade || '—') + ')'));
          var n = notes['member:' + m.id];
          if (n) b.appendChild(el('p', 'ygn-brief-note', 'Note: ' + n.text));
          sheet.appendChild(b);
        });
      }
      if (bills.length) {
        sheet.appendChild(el('h2', null, 'Bills'));
        bills.forEach(function (id) {
          var b = el('div', 'ygn-brief-item');
          b.appendChild(el('h3', null, id));
          var n = notes['bill:' + id];
          if (n) b.appendChild(el('p', 'ygn-brief-note', 'Note: ' + n.text));
          sheet.appendChild(b);
        });
      }
      if (!resolved().length && !bills.length) {
        sheet.appendChild(el('p', null, 'Nothing saved yet.'));
      }
      document.body.appendChild(sheet);
      window.print();
    });
    row.appendChild(brief);
    c.body.appendChild(row);

    /* 50. Backup and restore, so the local data is not a trap. */
    var row2 = el('div', 'ygn-btnrow');
    var backup = el('button', 'ygn-fbtn is-quiet', 'Back up everything');
    backup.type = 'button';
    backup.addEventListener('click', function () {
      var dump = { format: 'ygn-backup-v1', exported: new Date().toISOString(), data: {} };
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf('ygn') === 0) dump.data[k] = localStorage.getItem(k);
        }
      } catch (e) {}
      download('ygn-backup.json', JSON.stringify(dump, null, 2), 'application/json');
    });
    row2.appendChild(backup);

    var restoreLabel = el('label', 'ygn-fbtn is-quiet', 'Restore from file');
    var file = el('input');
    file.type = 'file';
    file.accept = 'application/json,.json';
    file.className = 'ygn-visually-hidden';
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          if (!parsed || parsed.format !== 'ygn-backup-v1' || !parsed.data) {
            D.toast('That is not a YGN backup file', 'warn');
            return;
          }
          var n = 0;
          Object.keys(parsed.data).forEach(function (k) {
            if (k.indexOf('ygn') !== 0) return;      // never write outside our namespace
            try { localStorage.setItem(k, parsed.data[k]); n++; } catch (e) {}
          });
          D.toast('Restored ' + n + ' items — reloading');
          setTimeout(function () { location.reload(); }, 900);
        } catch (e) { D.toast('Could not read that file', 'warn'); }
      };
      reader.readAsText(f);
    });
    restoreLabel.appendChild(file);
    row2.appendChild(restoreLabel);
    c.body.appendChild(row2);
    c.body.appendChild(D.note('A backup is a plain JSON file of your ygn- keys. Restoring overwrites the ' +
                              'matching keys in this browser.'));
    return c;
  }

  /* ── 44. Your own delegation, pinned ───────────────────────────────────── */
  function myDelegation(roster) {
    var c = card('My delegation', 'Pick your state and keep it here');
    var chosen = D.store.get(KEYS.home, null);
    var select = el('select', 'ygn-fselect');
    select.setAttribute('aria-label', 'Your state');
    var blank = el('option', null, 'Choose a state…');
    blank.value = '';
    select.appendChild(blank);
    Object.keys(D.states).sort().forEach(function (st) {
      var o = el('option', null, st);
      o.value = st;
      if (st === chosen) o.selected = true;
      select.appendChild(o);
    });
    c.body.appendChild(select);
    var out = el('div');
    c.body.appendChild(out);

    function render() {
      out.innerHTML = '';
      if (!chosen) { out.appendChild(D.note('Choose a state to see its delegation here on every visit.')); return; }
      var mates = roster.filter(function (m) { return m.state === chosen; });
      if (!mates.length) { out.appendChild(D.note('No members on record for ' + chosen + '.')); return; }
      var senate = mates.filter(function (m) { return m.chamber === 'Senate'; });
      var house = mates.filter(function (m) { return m.chamber !== 'Senate'; });
      [['Senate', senate], ['House', house]].forEach(function (grp) {
        if (!grp[1].length) return;
        out.appendChild(el('p', 'ygn-fsublabel', grp[0] + ' (' + grp[1].length + ')'));
        var list = el('ul', 'ygn-minilist');
        grp[1].sort(function (a, b) { return (a.district || 0) - (b.district || 0); }).forEach(function (m) {
          var li = el('li');
          var a = el('a', 'ygn-mlink', m.name);
          a.href = 'member.html?id=' + encodeURIComponent(m.id);
          li.appendChild(a);
          li.appendChild(chip(m.partyKey, m.partyKey === 'D' ? 'dem' : m.partyKey === 'R' ? 'rep' : 'ind'));
          if (m.districtLabel && m.districtLabel !== 'Statewide') {
            li.appendChild(el('span', 'ygn-mini-val', m.districtLabel));
          }
          list.appendChild(li);
        });
        out.appendChild(list);
      });
      var link = el('a', 'ygn-flink', 'Open ' + chosen + ' in the member list');
      link.href = 'members.html?state=' + encodeURIComponent(chosen);
      out.appendChild(link);
    }
    select.addEventListener('change', function () {
      chosen = select.value || null;
      if (chosen) D.store.set(KEYS.home, chosen); else D.store.del(KEYS.home);
      render();
      if (chosen) D.toast(chosen + ' pinned');
    });
    render();
    return c;
  }

  /* ── 45. What moved among the things you saved ─────────────────────────── */
  function watchlistDigest(digestBills) {
    var bills = savedBills();
    var c = card('Your watchlist', 'Movement on the bills you saved');
    if (!bills.length) {
      c.body.appendChild(D.note('Nothing saved yet. The ☆ on any bill adds it here.'));
      return c;
    }
    var seen = D.store.get(KEYS.seen, {}) || {};
    var next = {};
    var moved = [], quiet = [];
    bills.forEach(function (id) {
      var b = (digestBills || []).filter(function (x) { return x.detailPath === id; })[0];
      var stamp = b && ((b.latestAction && b.latestAction.date) || b.updatedAt);
      next[id] = stamp || seen[id] || null;
      if (!b) return;
      if (seen[id] && stamp && stamp !== seen[id]) moved.push({ b: b, from: seen[id], to: stamp });
      else quiet.push(b);
    });
    D.store.set(KEYS.seen, next);

    if (moved.length) {
      c.body.appendChild(el('p', 'ygn-fsublabel', 'Moved since you last looked'));
      var list = el('ul', 'ygn-minilist');
      moved.forEach(function (m) {
        var li = el('li');
        var a = el('a', 'ygn-mlink', m.b.identifier || m.b.detailPath);
        a.href = 'bill.html?id=' + encodeURIComponent(m.b.detailPath);
        li.appendChild(a);
        li.appendChild(chip('updated', 'good'));
        li.appendChild(el('span', 'ygn-mini-val', fmt.date(m.to)));
        list.appendChild(li);
      });
      c.body.appendChild(list);
    } else {
      c.body.appendChild(D.note('No change recorded on your saved bills since your last visit.'));
    }
    if (quiet.length) {
      c.body.appendChild(statRow('Unchanged', String(quiet.length), 'of ' + bills.length + ' saved'));
    }
    var missing = bills.length - (moved.length + quiet.length);
    if (missing > 0) {
      c.body.appendChild(D.note(missing + ' saved bill' + (missing === 1 ? ' is' : 's are') +
                                ' no longer in the recent digest, so no status is available.'));
    }
    return c;
  }

  /* ── 46. Reading history with times ────────────────────────────────────── */
  function recordVisit() {
    if (page !== 'member' && page !== 'bill') return;
    var id = D.param('id');
    if (!id) return;
    setTimeout(function () {
      var main = document.getElementById('main-content');
      var h = main && main.querySelector('h1, h2');
      var title = ((h && h.textContent) || document.title).replace(/\s*[-|].*$/, '').trim();
      if (!title) return;
      var hist = D.store.get(KEYS.history, []) || [];
      hist = hist.filter(function (x) { return x && x.url !== location.pathname + location.search; });
      hist.unshift({ title: title.slice(0, 90), url: location.pathname + location.search,
                     kind: page, at: new Date().toISOString() });
      D.store.set(KEYS.history, hist.slice(0, 40));
    }, 1500);
  }
  function historyPanel() {
    var hist = D.store.get(KEYS.history, []) || [];
    var c = card('What you have been reading', hist.length + ' pages in this browser');
    if (!hist.length) {
      c.body.appendChild(D.note('Nothing yet. Member and bill pages you open are listed here.'));
      return c;
    }
    var list = el('ul', 'ygn-minilist');
    hist.slice(0, 12).forEach(function (h) {
      var li = el('li');
      var a = el('a', 'ygn-mlink', h.title);
      a.href = h.url;
      li.appendChild(a);
      li.appendChild(chip(h.kind, 'mid'));
      li.appendChild(el('span', 'ygn-mini-val', fmt.ago(h.at)));
      list.appendChild(li);
    });
    c.body.appendChild(list);
    var clear = el('button', 'ygn-fbtn is-quiet', 'Clear history');
    clear.type = 'button';
    clear.addEventListener('click', function () {
      D.store.del(KEYS.history);
      D.toast('History cleared');
      c.body.innerHTML = '';
      c.body.appendChild(D.note('Cleared.'));
    });
    c.body.appendChild(clear);
    return c;
  }

  /* ── 47. How old the data on screen actually is ────────────────────────── */
  function freshnessPanel() {
    var c = card('Data freshness', 'When each snapshot was last rebuilt');
    var rows = [
      ['Member roster', D.officials()],
      ['Ethics and ideology', D.scores()],
      ['Recent bills', D.digest()],
      ['Build manifest', D.manifest()],
      ['Service health', D.health()]
    ];
    var body = c.body;
    body.appendChild(D.note('Loading…'));
    Promise.all(rows.map(function (r) { return r[1]; })).then(function (out) {
      body.innerHTML = '';
      out.forEach(function (data, i) {
        var when = data && (data.generated_at || data.generatedAt);
        var label = rows[i][0];
        if (!data) { body.appendChild(statRow(label, 'unavailable', 'snapshot did not load')); return; }
        if (!when) { body.appendChild(statRow(label, 'loaded', 'no timestamp recorded')); return; }
        var days = Math.floor((Date.now() - new Date(when).getTime()) / 86400000);
        var hint = fmt.ago(when);
        var row = statRow(label, fmt.date(when), hint);
        if (days > 14) row.appendChild(chip('stale', 'bad'));
        else if (days > 5) row.appendChild(chip('ageing', 'mid'));
        body.appendChild(row);
      });
      var health = out[4];
      if (health && health.status) {
        body.appendChild(statRow('Reported status', String(health.status),
          health.mode ? 'mode: ' + health.mode : ''));
      }
      body.appendChild(D.note('These pages read committed snapshots, so a stale timestamp means the ' +
                              'rebuild has not run — not that the site is down.'));
    });
    return c;
  }

  /* ── 48. Structured filters in the command palette ────────────────────────
     ux.js calls this with the raw query before it scores. Returning null means
     "no structured filter here, carry on normally". */
  function installPaletteFilters() {
    // The palette is site-wide but the roster is a 500 KB join, so it is only
    // fetched once someone actually types a filter. Until it resolves the hook
    // returns null and the palette does its normal substring search.
    var byId = null;
    function warm() {
      if (byId) return;
      byId = {};
      D.roster().then(function (roster) {
        (roster || []).forEach(function (m) { byId[m.id] = m; });
      });
    }
    window.ygnPaletteFilter = function (query, pool) {
      if (!/\b(state|party|chamber|grade)\s*:/i.test(query)) return null;
      warm();
      if (!byId || !Object.keys(byId).length) return null;
      var re = /\b(state|party|chamber|grade)\s*:\s*("[^"]+"|\S+)/gi;
      var filters = [], m, rest = query;
      while ((m = re.exec(query))) {
        filters.push({ key: m[1].toLowerCase(), value: m[2].replace(/"/g, '').toLowerCase() });
        rest = rest.replace(m[0], ' ');
      }
      if (!filters.length) return null;
      var out = pool.filter(function (item) {
        if (item.kind !== 'Member') return false;
        var person = byId[(item.href.split('id=')[1] || '')];
        if (!person) return false;
        return filters.every(function (f) {
          if (f.key === 'state') {
            return person.state.toLowerCase().indexOf(f.value) === 0 ||
                   person.stateAbbr.toLowerCase() === f.value;
          }
          if (f.key === 'party') return person.partyKey.toLowerCase() === f.value[0];
          if (f.key === 'chamber') return person.chamber.toLowerCase().indexOf(f.value) === 0;
          if (f.key === 'grade') return (person.grade || '').toLowerCase() === f.value;
          return true;
        });
      });
      var text = rest.trim().toLowerCase();
      if (text) {
        out = out.filter(function (item) { return item.label.toLowerCase().indexOf(text) > -1; });
      }
      return out.slice(0, 40);
    };
  }

  /* ── 49. Filters that survive a link ──────────────────────────────────────
     The members page has four controls whose state was invisible to anyone you
     sent the page to. This reads them from the URL on load and writes them back
     as they change, which also makes the state links elsewhere on the site work. */
  function shareableFilters() {
    var map = [
      ['state', 'members-state'], ['party', 'members-party'],
      ['chamber', 'members-chamber'], ['sort', 'members-sort'], ['q', 'members-search']
    ];
    var controls = map.map(function (p) { return [p[0], document.getElementById(p[1])]; })
                      .filter(function (p) { return p[1]; });
    if (!controls.length) return;

    var params = new URLSearchParams(location.search);
    var applied = false;
    controls.forEach(function (p) {
      var v = params.get(p[0]);
      if (v === null) return;
      p[1].value = v;
      applied = true;
      try { p[1].dispatchEvent(new Event(p[1].tagName === 'INPUT' ? 'input' : 'change', { bubbles: true })); }
      catch (e) {}
    });

    function sync() {
      var next = new URLSearchParams(location.search);
      controls.forEach(function (p) {
        var v = (p[1].value || '').trim();
        // Leave the control's own "all"/default option out of the URL.
        if (!v || /^(all|any|)$/i.test(v)) next.delete(p[0]);
        else next.set(p[0], v);
      });
      var qs = next.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
      shareBtn.hidden = !qs;
    }
    controls.forEach(function (p) {
      p[1].addEventListener('change', sync);
      p[1].addEventListener('input', sync);
    });

    var shareBtn = el('button', 'ygn-sharebtn', 'Copy link to this view');
    shareBtn.type = 'button';
    shareBtn.hidden = true;
    shareBtn.addEventListener('click', function () {
      var url = location.href;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () { D.toast('Link copied'); },
                                                function () { D.toast('Could not copy', 'warn'); });
      } else D.toast('Copying is not available here', 'warn');
    });
    var anchor = document.getElementById('members-count');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(shareBtn, anchor.nextSibling);
    sync();
    if (applied) D.toast('Filters restored from the link');
  }

  /* ═══ Boot ═══════════════════════════════════════════════════════════════ */
  /* On the detail pages two modules mount asynchronously and whichever settles
     first ends up on top. The personal tools always belong last, so there they
     append to main-content rather than inserting after a moving anchor. */
  function mountLast(cards, title) {
    var main = document.getElementById('main-content');
    if (!main) return;
    return mount(main, cards, title, true);
  }

  function mount(host, cards, title, append) {
    if (!host || (!append && !host.parentNode)) return;
    var wrap = el('div', 'ygn-analysis ygn-personalpanel');
    var head = el('div', 'ygn-analysis-head');
    head.appendChild(el('h2', null, title || 'Your tools'));
    var toggle = el('button', 'ygn-analysis-toggle', 'Hide');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    head.appendChild(toggle);
    wrap.appendChild(head);
    var grid = el('div', 'ygn-analysis-grid');
    cards.filter(Boolean).forEach(function (c) { grid.appendChild(c); });
    if (!grid.children.length) return;
    wrap.appendChild(grid);
    toggle.addEventListener('click', function () {
      var open = grid.hidden;
      grid.hidden = !open;
      toggle.textContent = open ? 'Hide' : 'Show';
      toggle.setAttribute('aria-expanded', String(open));
    });
    if (append) host.appendChild(wrap);
    else host.parentNode.insertBefore(wrap, host.nextSibling);
    return wrap;
  }

  D.ready(function () {
    D.guard('pe:46-record', recordVisit);

    D.guard('pe:48', installPaletteFilters);
    if (page === 'members') D.guard('pe:49', shareableFilters);

    if (D.page() === 'home' && D.file().indexOf('index') === 0) {
      D.roster().then(function (roster) {
        D.digest().then(function (digest) {
          var host = document.getElementById('home-recent-bills') || document.getElementById('district-map');
          mount(host, [
            D.guard('pe:44', function () { return myDelegation(roster); }),
            D.guard('pe:45', function () { return watchlistDigest(digest && digest.bills); }),
            D.guard('pe:46', historyPanel),
            D.guard('pe:42', function () { return savedWorkbench(roster); }),
            D.guard('pe:47', freshnessPanel)
          ], 'Your tools');
        });
      });
    }

    if (page === 'member') {
      var id = D.param('id');
      if (!id) return;
      Promise.all([D.roster(), D.settled('dossier-container')]).then(function (out) {
        var roster = out[0] || [];
        var me = roster.filter(function (m) { return m.id === id; })[0];
        // Sit below the comparison panel when it exists, otherwise directly
        // after the dossier. Both anchors live in main-content, which core.js
        // does not rewrite.
        mountLast([
          D.guard('pe:41', function () { return memberTray(roster, id); }),
          D.guard('pe:40', function () {
            return notesPanel('member:' + id, me ? me.name : 'this member');
          })
        ], 'Your tools');
      });
    }

    if (page === 'bill') {
      var billId = D.param('id');
      if (!billId) return;
      D.settled('bill-container').then(function () {
        mountLast([
          D.guard('pe:40b', function () { return notesPanel('bill:' + billId, 'this bill'); })
        ], 'Your tools');
      });
    }
  });
})();
