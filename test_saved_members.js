const assert = require('assert');
const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/officials/:id/wiki', (req, res) => {
  // A short delay verifies that a pending biography request cannot reopen the
  // popover after the save button suppresses it.
  setTimeout(() => res.json({ title: req.params.id, summary: 'Test biography.' }), 100);
});
app.get('/officials/:id/dossier', (req, res) => {
  res.json({
    member: {
      bioguideId: req.params.id,
      name: 'Saved Member',
      partyName: 'Independent',
      state: 'Test State',
      chamber: 'House of Representatives',
    },
    history: { yearsOfService: 1 },
    legislation: { sponsored: [], cosponsored: [], sponsoredCount: 0, cosponsoredCount: 0 },
  });
});
app.use(express.static(path.join(__dirname, 'docs')));

function listen(serverApp) {
  return new Promise((resolve, reject) => {
    const server = serverApp.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

(async () => {
  const server = await listen(app);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser;

  try {
    // --no-sandbox is required on CI (GitHub Ubuntu runners have no user
    // namespace sandbox); without it Chrome fails to launch ("Code: null").
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/members.html?api=origin`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('ygn_saved_members_v1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.member-tile .member-save-button--tile');

    const initialUrl = page.url();
    const first = await page.$eval('.member-tile .member-save-button--tile', button => ({
      id: button.dataset.saveMemberId,
      name: button.dataset.saveMemberName,
    }));

    await page.hover('.member-tile .member-save-button--tile');
    await page.click('.member-tile .member-save-button--tile');
    await page.waitForFunction(
      id => document.querySelector(`[data-save-member-id="${id}"]`).getAttribute('aria-pressed') === 'true',
      {},
      first.id,
    );
    await new Promise(resolve => setTimeout(resolve, 175));

    assert.strictEqual(page.url(), initialUrl, 'saving from a tile must not navigate');
    assert.strictEqual(
      await page.$eval('#popover', element => element.classList.contains('visible')),
      false,
      'saving from a tile must not leave or reopen the biography popover',
    );
    assert.deepStrictEqual(
      await page.evaluate(() => JSON.parse(localStorage.getItem('ygn_saved_members_v1'))),
      [first.id],
      'saved member ID should persist in localStorage',
    );

    await page.click('#members-saved-toggle');
    await page.waitForFunction(() => document.querySelectorAll('.member-tile').length === 1);
    assert.strictEqual(
      await page.$eval('#members-count', element => element.textContent.trim()),
      '1 saved member',
      'saved-only view should report its filtered count',
    );

    await page.click('.member-tile .member-save-button--tile');
    await page.waitForSelector('.saved-members-empty');
    assert.match(
      await page.$eval('.saved-members-empty p', element => element.textContent),
      /have not saved any current members/i,
      'saved-only view should explain an empty saved list',
    );

    await page.click('#saved-members-empty-action');
    await page.waitForFunction(() => document.querySelectorAll('.member-tile').length > 1);
    await page.click(`.member-save-button--tile[data-save-member-id="${first.id}"]`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`.member-save-button--tile[data-save-member-id="${first.id}"][aria-pressed="true"]`);

    await page.click(`.member-save-button--tile[data-save-member-id="${first.id}"] ~ .party-badge`);
    await page.waitForFunction(id => new URL(location.href).searchParams.get('id') === id, {}, first.id);
    const detailUrl = new URL(page.url());
    assert.strictEqual(detailUrl.searchParams.get('api'), 'origin', 'member routing should preserve ?api');
    await page.waitForSelector('.member-save-button--detail[aria-pressed="true"]');

    const beforeDetailSave = page.url();
    await page.click('.member-save-button--detail');
    assert.strictEqual(page.url(), beforeDetailSave, 'saving from the detail hero must not navigate');
    assert.deepStrictEqual(
      await page.evaluate(() => JSON.parse(localStorage.getItem('ygn_saved_members_v1'))),
      [],
      'detail hero control should update the same persisted saved list',
    );

    const homePage = await browser.newPage();
    await homePage.goto(`${baseUrl}/index.html`, { waitUntil: 'domcontentloaded' });
    await homePage.waitForSelector('#home-congress-balance:not([hidden])');
    const balanceText = await homePage.$eval(
      '#home-congress-balance',
      element => element.textContent.replace(/\s+/g, ' ').trim(),
    );
    assert.match(balanceText, /Who runs the 119th Congress/i);
    assert.match(balanceText, /212 Democrats/);
    assert.match(balanceText, /218 Republicans/);
    assert.match(balanceText, /45 Democrats/);
    assert.match(balanceText, /52 Republicans/);

    await homePage.waitForSelector('#on-this-day:not([hidden])');
    const historyMapGap = await homePage.evaluate(() => {
      const history = document.querySelector('#on-this-day').getBoundingClientRect();
      const map = document.querySelector('#district-map').getBoundingClientRect();
      return map.top - history.bottom;
    });
    assert.ok(
      historyMapGap >= 24,
      `history banner and map heading should have breathing room (received ${historyMapGap}px)`,
    );

    console.log(`PASS: saved members (${first.name}, ${first.id})`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
