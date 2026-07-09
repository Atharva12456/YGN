const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  // Navigate to the member page
  await page.goto('http://localhost:8080/member.html?id=M000312', { waitUntil: 'networkidle0' });
  
  // Wait for the container to have either the layout or error
  await page.waitForFunction(() => {
    const el = document.getElementById('dossier-container');
    return el && (el.querySelector('.dossier-layout') || el.querySelector('.error-state'));
  }, { timeout: 10000 }).catch(() => console.log('Timeout waiting for dossier-container'));
  
  const content = await page.evaluate(() => {
    const el = document.getElementById('dossier-container');
    return el ? el.innerHTML : 'No container';
  });
  
  const backLink = await page.evaluate(() => {
    const link = document.querySelector('.back-link');
    return link ? link.getAttribute('href') : null;
  });
  
  console.log('Back link:', backLink);
  
  // Check if we have the 8 sections
  const text = await page.evaluate(() => document.body.innerText);
  console.log('Page text snapshot length:', text.length);
  
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
