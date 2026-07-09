const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  
  await page.goto('http://127.0.0.1:8000', { waitUntil: 'networkidle0' });
  
  const healthText = await page.$eval('#health-indicator', el => el.textContent);
  console.log('Health indicator:', healthText);
  
  const membersGridHTML = await page.$eval('#members-grid', el => el.innerHTML);
  console.log('Members grid has empty state?', membersGridHTML.includes('empty-state'));
  
  await browser.close();
})();
