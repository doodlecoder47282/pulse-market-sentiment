const { chromium } = require('./node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCREENSHOTS_DIR = '/home/user/workspace/screenshots_v2';
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
const TARGET = 'http://127.0.0.1:5000';

async function waitForServer(url, maxMs = 20000) {
  const http = require('http');
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 400));
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => { res.resume(); resolve(); });
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch(e) {}
  }
  return false;
}

(async () => {
  const server = spawn('node', ['dist/index.cjs'], {
    cwd: __dirname,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  
  console.log('Waiting for server...');
  const ok = await waitForServer(TARGET);
  if (!ok) throw new Error('Server never started');
  console.log('Server ready');
  
  const browser = await chromium.launch({ headless: true });
  
  try {
    // Helper
    const goTab = async (page, tabId) => {
      const loc = page.locator(`[data-testid="tab-${tabId}"]`);
      const exists = await loc.count();
      if (!exists) { console.log(`Tab ${tabId} not found`); return; }
      await loc.click();
      await page.waitForTimeout(2500);
      const p = path.join(SCREENSHOTS_DIR, `desktop_${tabId}.jpg`);
      await page.screenshot({ path: p, type: 'jpeg', quality: 85 });
      console.log(`Saved: desktop_${tabId}.jpg`);
    };
    
    const goTabMobile = async (page, tabId) => {
      const loc = page.locator(`[data-testid="tab-${tabId}"]`);
      const exists = await loc.count();
      if (!exists) { console.log(`Mobile tab ${tabId} not found`); return; }
      await loc.click();
      await page.waitForTimeout(1500);
      const p = path.join(SCREENSHOTS_DIR, `mobile_${tabId}.jpg`);
      await page.screenshot({ path: p, type: 'jpeg', quality: 85 });
      console.log(`Saved: mobile_${tabId}.jpg`);
    };
    
    const enterDashboard = async (page) => {
      await page.waitForTimeout(3800);
      const btnLoc = page.locator('[data-testid="button-launch-batcave"]');
      const btnVis = await btnLoc.isVisible().catch(() => false);
      if (btnVis) {
        await btnLoc.click();
        console.log('Clicked launch button');
      } else {
        await page.keyboard.press('Enter');
        console.log('Pressed Enter to enter dashboard');
      }
      await page.waitForTimeout(2000);
    };
    
    const tabs = ['signals','chart','models','tradedesk','regime','news','voices','takefive'];
    
    // Desktop
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const pg = await ctx.newPage();
    await pg.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await enterDashboard(pg);
    for (const tab of tabs) await goTab(pg, tab);
    await ctx.close();
    
    // Mobile
    const mCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const mPg = await mCtx.newPage();
    await mPg.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await enterDashboard(mPg);
    for (const tab of tabs) await goTabMobile(mPg, tab);
    await mCtx.close();
    
  } finally {
    await browser.close();
    server.kill();
    console.log('Done!');
    process.exit(0);
  }
})().catch(e => { console.error('FATAL:', e.message.slice(0,200)); process.exit(1); });
