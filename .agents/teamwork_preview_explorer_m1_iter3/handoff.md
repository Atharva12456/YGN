# Handoff Report

## 1. Observation

- **Table of Trades**: In `docs/app.js` line ~2005-2010 (inside `renderDossierUI`), the condition `if (stocks.trades && stocks.trades.length > 0)` currently renders a hardcoded dummy message: `<p>Trade parsing is available but UI for table is pending full spec, showing basic breakdown.</p>`. The trades array objects contain `transactionDate`, `ticker`, `assetDescription`, `type`, `amountRange`, and `owner` properties (as seen in `empty-folder/CongressMembers.py`).
- **Campaign Funding Badge**: In `docs/app.js` line ~1963-1990 (inside `renderDossierUI`), the Funding card header is rendered as `<h3>Campaign Funding</h3>` without any ethics badge, even though `funding.grade` contains the ethics score info with `grade` and `score` properties.
- **Wikipedia Thumbnail**: In `docs/app.js` line ~1903-1910 (inside `renderDossierUI`), the About card renders the `wiki.extract` text, but ignores `wiki.thumbnail.source` if it is present.

## 2. Logic Chain

1. **Table of Trades**: To fix the integrity violation regarding the hardcoded dummy message, we must map over `stocks.trades` to generate an HTML `<table>`. The columns should map to the standard trade properties (Date, Ticker, Asset, Type, Amount, Owner).
2. **Campaign Funding Badge**: We need to use `funding.grade.grade` and `getEthicsColor(funding.grade.score)` to render an ethics badge next to the "Campaign Funding" header, fulfilling the requirement for a badge in that section.
3. **Wikipedia Thumbnail**: We need to insert an `<img>` tag into the About section if `wiki.thumbnail.source` is available. Floating it to the right with some margin allows the extract text to wrap around it elegantly.

## 3. Caveats

- We are assuming `stocks.trades` conforms strictly to the dictionary schema observed in `empty-folder/CongressMembers.py`. The properties will gracefully degrade to `'-'` if undefined.
- We apply basic inline CSS styles to the new elements to ensure they fit correctly into the `dossier-card` layout without needing changes to `docs/styles.css`.

## 4. Conclusion

The main agent must implement the following three code replacements in `docs/app.js` (`renderDossierUI`):

**Fix 1: Table of Trades**
Replace the block at line ~2005:
```javascript
    if (stocks.trades && stocks.trades.length > 0) {
      stocksContent = '<p>Trade parsing is available but UI for table is pending full spec, showing basic breakdown.</p>';
      const self = stocks.ownerBreakdown?.self || 0;
      const spouse = stocks.ownerBreakdown?.spouse || 0;
      const child = stocks.ownerBreakdown?.dependent || stocks.ownerBreakdown?.child || 0;
      stocksContent += `<p>Trades by owner: Self (${self}), Spouse (${spouse}), Child (${child}).</p>`;
    }
```
With:
```javascript
    if (stocks.trades && stocks.trades.length > 0) {
      stocksContent = \`
        <div style="overflow-x: auto; margin-bottom: 1rem;">
          <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem;">
            <thead>
              <tr style="border-bottom: 1px solid var(--color-border);">
                <th style="padding: 0.5rem;">Date</th>
                <th style="padding: 0.5rem;">Ticker</th>
                <th style="padding: 0.5rem;">Asset</th>
                <th style="padding: 0.5rem;">Type</th>
                <th style="padding: 0.5rem;">Amount</th>
                <th style="padding: 0.5rem;">Owner</th>
              </tr>
            </thead>
            <tbody>
              \${stocks.trades.map(t => \`
                <tr style="border-bottom: 1px solid var(--color-border-light);">
                  <td style="padding: 0.5rem;">\${t.transactionDate || '-'}</td>
                  <td style="padding: 0.5rem;"><strong>\${t.ticker || '-'}</strong></td>
                  <td style="padding: 0.5rem; max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="\${t.assetDescription || ''}">\${t.assetDescription || '-'}</td>
                  <td style="padding: 0.5rem;">\${t.type || '-'}</td>
                  <td style="padding: 0.5rem;">\${t.amountRange || '-'}</td>
                  <td style="padding: 0.5rem;">\${t.owner || '-'}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        </div>
      \`;
      const self = stocks.ownerBreakdown?.self || 0;
      const spouse = stocks.ownerBreakdown?.spouse || 0;
      const child = stocks.ownerBreakdown?.dependent || stocks.ownerBreakdown?.child || 0;
      stocksContent += \`<p class="muted-text">Trades by owner: Self (\${self}), Spouse (\${spouse}), Child (\${child}).</p>\`;
    }
```

**Fix 2: Campaign Funding Ethics Badge**
Modify the block around line ~1963:
```javascript
      fundingHtml = \`
        <div class="dossier-card">
          <h3>Campaign Funding</h3>
```
To:
```javascript
      let fundingGradeHtml = '';
      if (funding.grade && funding.grade.grade) {
        fundingGradeHtml = \`<span style="background-color: \${getEthicsColor(funding.grade.score)}; padding: 0.2rem 0.5rem; border-radius: 4px; color: white; font-weight: bold; font-size: 0.8rem; vertical-align: middle; margin-left: 0.5rem;">Ethics Grade: \${funding.grade.grade}</span>\`;
      }

      fundingHtml = \`
        <div class="dossier-card">
          <h3 style="display: flex; align-items: center; justify-content: space-between;">
            Campaign Funding
            \${fundingGradeHtml}
          </h3>
```

**Fix 3: Wikipedia Thumbnail**
Modify the block around line ~1903:
```javascript
  if (wiki) {
    let fallbackNote = wiki.source === "congress_fallback" ? '<p class="muted-text" style="margin-top: 1rem;">Note: This biography is a generated summary (no Wikipedia page resolved).</p>' : '';
    aboutHtml = \`
      <div class="dossier-card">
        <h3>About</h3>
        <p>\${wiki.extract || wiki.summary || 'No biography available.'}</p>
        \${wiki.wiki_url ? \`<a href="\${wiki.wiki_url}" target="_blank" rel="noopener" style="margin-top: 1rem; display: inline-block; color: var(--color-accent); font-weight: 600;">Read more on Wikipedia</a>\` : ''}
        \${fallbackNote}
      </div>
    \`;
  }
```
To:
```javascript
  if (wiki) {
    let thumbHtml = (wiki.thumbnail && wiki.thumbnail.source) 
      ? \`<img src="\${wiki.thumbnail.source}" alt="\${name}" style="float: right; margin-left: 1rem; margin-bottom: 0.5rem; max-width: 100px; border-radius: 4px; object-fit: cover;">\` 
      : '';
    let fallbackNote = wiki.source === "congress_fallback" ? '<p class="muted-text" style="margin-top: 1rem; clear: both;">Note: This biography is a generated summary (no Wikipedia page resolved).</p>' : '';
    aboutHtml = \`
      <div class="dossier-card" style="overflow: hidden;">
        <h3>About</h3>
        \${thumbHtml}
        <p>\${wiki.extract || wiki.summary || 'No biography available.'}</p>
        \${wiki.wiki_url ? \`<div style="clear: both; padding-top: 0.5rem;"><a href="\${wiki.wiki_url}" target="_blank" rel="noopener" style="color: var(--color-accent); font-weight: 600;">Read more on Wikipedia</a></div>\` : ''}
        \${fallbackNote}
      </div>
    \`;
  }
```

## 5. Verification Method

- Implement the above code changes using the `replace_file_content` tool on `docs/app.js`.
- Launch the backend with `uvicorn app:app --reload` (or view files using an HTTP server if `api=static` parameter is applied).
- Navigate to `member.html?id=...` and verify that the Table of Trades renders instead of the dummy text, the Campaign Funding card displays the Ethics Grade badge in its header, and the About section displays a thumbnail image when available.

**Fix 4: Defensive Optional Chaining**
Modify the block around line ~2129 (in Contact & Links):
```javascript
    let socLines = Object.entries(soc).map(([net, data]) => `<div><a href="${data.url}" target="_blank" style="color: var(--color-accent);">${net.charAt(0).toUpperCase() + net.slice(1)} (@${data.handle})</a></div>`);
```
To:
```javascript
    let socLines = Object.entries(soc).map(([net, data]) => {
      if (!data) return '';
      return `<div><a href="${data.url}" target="_blank" style="color: var(--color-accent);">${net.charAt(0).toUpperCase() + net.slice(1)} (@${data.handle})</a></div>`;
    }).filter(Boolean);
```

Modify the block around line ~2079 (in Committees):
```javascript
    assignments.forEach(a => {
      if (!a.isSubcommittee) {
        if (!grouped[a.code]) grouped[a.code] = { ...a, subcommittees: [] };
      }
    });
    assignments.forEach(a => {
      if (a.isSubcommittee) {
        const parentCode = Object.keys(grouped).find(k => a.code.startsWith(k));
        if (parentCode) grouped[parentCode].subcommittees.push(a);
        else {
          if (!grouped['MISC']) grouped['MISC'] = { committee: 'Other Subcommittees', subcommittees: [], isSubcommittee: false };
          grouped['MISC'].subcommittees.push(a);
        }
      }
    });
```
To:
```javascript
    assignments.forEach(a => {
      if (!a.isSubcommittee) {
        const code = a.code || 'UNKNOWN';
        if (!grouped[code]) grouped[code] = { ...a, subcommittees: [] };
      }
    });
    assignments.forEach(a => {
      if (a.isSubcommittee) {
        const parentCode = Object.keys(grouped).find(k => k !== 'UNKNOWN' && a.code && a.code.startsWith(k));
        if (parentCode) grouped[parentCode].subcommittees.push(a);
        else {
          if (!grouped['MISC']) grouped['MISC'] = { committee: 'Other Subcommittees', subcommittees: [], isSubcommittee: false };
          grouped['MISC'].subcommittees.push(a);
        }
      }
    });
```
