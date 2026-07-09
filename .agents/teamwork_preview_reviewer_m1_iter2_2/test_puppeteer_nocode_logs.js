const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  
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
  
  await new Promise(r => setTimeout(r, 2000));
  
  const content = await page.evaluate(() => {
    const el = document.getElementById('dossier-container');
    return el ? el.innerHTML : 'No container';
  });
  
  const isErrorState = content.includes('error-state');
  console.log('Error state rendered:', isErrorState);

  await browser.close();
})();
