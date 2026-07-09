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
          bioguideId: "F000476"
          // all other sections are missing!
        })
      });
    } else {
      request.continue();
    }
  });

  await page.goto('http://localhost:8080/member.html?id=F000476', { waitUntil: 'networkidle0' });
  
  await page.waitForFunction(() => {
    const el = document.getElementById('dossier-container');
    return el && el.querySelector('.dossier-layout');
  }, { timeout: 5000 }).catch(() => console.log('Timeout'));
  
  const content = await page.evaluate(() => {
    const el = document.getElementById('dossier-container');
    return el ? el.innerHTML : 'No container';
  });
  
  const hasIdentity = content.includes('dossier-identity');
  const hasAbout = content.includes('About</h3>');
  const hasCareer = content.includes('Career History</h3>');
  const hasFunding = content.includes('Campaign Funding</h3>');
  const hasStocks = content.includes('Financial Disclosures</h3>');
  const hasLegislation = content.includes('Legislation</h3>');
  const hasCommittees = content.includes('Committees</h3>');
  const hasContact = content.includes('Contact &amp; Links</h3>');
  
  console.log('Identity:', hasIdentity);
  console.log('About:', hasAbout);
  console.log('Career:', hasCareer);
  console.log('Funding:', hasFunding);
  console.log('Stocks:', hasStocks);
  console.log('Legislation:', hasLegislation);
  console.log('Committees:', hasCommittees);
  console.log('Contact:', hasContact);

  await browser.close();
})();
