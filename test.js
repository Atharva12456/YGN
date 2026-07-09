const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const port = 3000;

// API routes that intentionally return 404 to test fallback
app.get('/officials', (req, res) => {
    res.status(404).json({ error: 'API not found' });
});
app.get('/health', (req, res) => {
    res.status(404).json({ error: 'API not found' });
});
app.get('/officials/:id/nominate', (req, res) => {
    res.status(404).json({ error: 'API not found' });
});
app.get('/officials/:id/wiki', (req, res) => {
    res.status(404).json({ error: 'API not found' });
});

// Serve static files from docs
app.use(express.static(path.join(__dirname, 'docs')));

const server = app.listen(port, async () => {
    console.log(`Server running at http://localhost:${port}`);
    let browser;
    try {
        browser = await puppeteer.launch({ headless: 'new' });
        const page = await browser.newPage();
        
        let errors = [];
        page.on('console', msg => {
            if (msg.type() === 'error') {
                errors.push(msg.text());
                console.error('Browser Error:', msg.text());
            }
        });
        
        await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
        
        console.log("Page loaded. Navigating to members section...");
        await page.click('button[data-section="members"]');
        
        // Wait for members to load
        await page.waitForSelector('.member-tile', { timeout: 5000 });
        
        const tiles = await page.$$('.member-tile');
        console.log(`Found ${tiles.length} member tiles.`);
        
        if (tiles.length === 0) {
            throw new Error("No member tiles rendered.");
        }
        
        // Wait for some nominate fetching to complete
        await new Promise(r => setTimeout(r, 2000));
        
        // Check background colors of tiles
        let colors = [];
        for (let i = 0; i < Math.min(5, tiles.length); i++) {
            const color = await page.evaluate(el => el.style.backgroundColor, tiles[i]);
            colors.push(color);
        }
        console.log("Sample tile background colors:", colors);
        
        // Check popover functionality
        console.log("Hovering first tile to check wiki popover...");
        await page.evaluate(el => el.dispatchEvent(new MouseEvent('mouseenter')), tiles[0]);
        
        await page.waitForSelector('#popover.visible', { timeout: 5000 });
        const popoverText = await page.evaluate(() => document.querySelector('#popover').innerText);
        console.log("Popover text:", popoverText);
        
        console.log("Test completed successfully.");
    } catch (e) {
        console.error("Test failed:", e);
    } finally {
        if (browser) await browser.close();
        server.close();
    }
});
