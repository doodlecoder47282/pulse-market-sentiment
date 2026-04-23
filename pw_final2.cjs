const { chromium } = require('./node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SHOTS_DIR = '/home/user/workspace/screenshots_v2';
fs.mkdirSync(SHOTS_DIR, { recursive: true });
const TARGET = 'http://127.0.0.1:5000';

async function waitFor(url, ms = 15000) {
  const http = require('http');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await new Promise(r => setTimeout(r, 350));
    try {
      await new Promise((res, rej) => {
        const r = http.get(url, resp => { resp.resume(); res(); });
        r.on('error', rej);
        r.setTimeout(1500, () => { r.destroy(); rej(new Error('to')); });
      });
      return true;
    } catch {}
  }
  return false;
}

const tabs = ['signals','chart','models','tradedesk','regime','news','voices','takefive'];

async function enterDashboard(page) {
  // Wait for ready state
  await page.waitForTimeout(4200);
  // Force click even if animated
  try {
    await page.locator('[data-testid="button-launch-batcave"]').click({ force: true, timeout: 5000 });
    console.log('Force-clicked launch button');
  } catch(e) {
    // Try clicking the splash wrapper
    await page.keyboard.press('Enter');
    console.log('Pressed Enter');
  }
  await page.waitForTimeout(2500);
  const dashboardVisible = await page.locator('[data-testid="tabs-dashboard"]').isVisible().catch(() => false);
  console.log('Dashboard visible:', dashboardVisible);
}

(async () => {
  const srv = spawn('node', ['dist/index.cjs'], {
    cwd: __dirname,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  await waitFor(TARGET);
  console.log('Server ready');
  
  const browser = await chromium.launch({ headless: true });
  
  // ── Desktop tabs ──────────────────────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await enterDashboard(page);
  
  for (const tab of tabs) {
    try {
      await page.locator(`[data-testid="tab-${tab}"]`).click({ force: true });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(SHOTS_DIR, `desktop_${tab}.jpg`), type: 'jpeg', quality: 85 });
      console.log('Saved: desktop_' + tab + '.jpg');
    } catch(e) { console.log('Desktop tab error', tab, ':', e.message.slice(0,80)); }
  }
  await ctx.close();
  
  // ── Mobile tabs ───────────────────────────────────────────────────
  const mCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mPage = await mCtx.newPage();
  await mPage.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await enterDashboard(mPage);
  
  for (const tab of tabs) {
    try {
      await mPage.locator(`[data-testid="tab-${tab}"]`).click({ force: true });
      await mPage.waitForTimeout(1500);
      await mPage.screenshot({ path: path.join(SHOTS_DIR, `mobile_${tab}.jpg`), type: 'jpeg', quality: 85 });
      console.log('Saved: mobile_' + tab + '.jpg');
    } catch(e) { console.log('Mobile tab error', tab, ':', e.message.slice(0,80)); }
  }
  await mCtx.close();
  
  await browser.close();
  srv.kill();
  console.log('ALL DONE');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
