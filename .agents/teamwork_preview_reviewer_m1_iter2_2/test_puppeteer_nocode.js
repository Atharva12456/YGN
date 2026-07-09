const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().includes('dossier')) {
      request.respond({
        content: 'application/json',
        headers: {"Access-Control-Allow-Origin": "*"},
        body: JSON.stringify({
          member: {
            name: "John Fetterman",
            party: "Democrat",
          },
          bioguideId: "F000476",
          committees: {
            assignments: [
              { committee: "Agriculture", isSubcommittee: false }, 
              { committee: "Sub 1", isSubcommittee: true }
            ] // no 'code' property
          }
        })
      });
    } else {
      request.continue();
    }
  });

  await page.goto('http://localhost:8080/member.html?id=F000476', { waitUntil: 'networkidle0' });
  
  await page.waitForFunction(() => {
    const el = document.getElementById('dossier-container');
    return el && (el.querySelector('.dossier-layout') || el.querySelector('.error-state'));
  }, { timeout: 5000 }).catch(() => console.log('Timeout'));
  
  const content = await page.evaluate(() => {
    const el = document.getElementById('dossier-container');
    return el ? el.innerHTML : 'No container';
  });
  
  const hasCommittees = content.includes('Committees</h3>');
  console.log('Committees section rendered:', hasCommittees);

  await browser.close();
})();
