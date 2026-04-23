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
    await new Promise(r => setTimeout(r, 300));
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => { res.resume(); resolve(); });
        req.on('error', reject);
        req.setTimeout(1000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch(e) {}
  }
  return false;
}

(async () => {
  // Start server
  const server = spawn('node', ['dist/index.cjs'], {
    cwd: __dirname,
    env: { ...process.env, NODE_ENV: 'production' },
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  
  server.stdout.on('data', d => {
    const s = d.toString();
    if (s.includes('[express]')) process.stdout.write('[server] ' + s.split('\n')[0] + '\n');
  });
  server.stderr.on('data', d => process.stderr.write(d));
  
  console.log('Waiting for server...');
  const ok = await waitForServer(TARGET);
  if (!ok) throw new Error('Server never started');
  console.log('Server ready');
  
  const browser = await chromium.launch({ headless: true });
  
  try {
    // ─── Cinematic opener screenshots ─────────────────────
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await ctx.newPage();
    
    await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('Page loaded');
    
    const take = async (filename) => {
      const p = path.join(SCREENSHOTS_DIR, filename);
      await page.screenshot({ path: p, type: 'jpeg', quality: 85 });
      console.log('Saved:', filename);
    };
    
    // Opener timeline
    await take('opener_t0.jpg');
    await page.waitForTimeout(500);
    await take('opener_t500.jpg');
    await page.waitForTimeout(700);
    await take('opener_t1200.jpg');
    await page.waitForTimeout(800);
    await take('opener_t2000.jpg');
    await page.waitForTimeout(500);
    await take('opener_t2500.jpg');
    await page.waitForTimeout(700);
    await take('opener_t3200.jpg');
    
    // Check what's visible on splash
    const btnVisible = await page.locator('[data-testid="button-launch-batcave"]').isVisible().catch(() => false);
    const splashVisible = await page.locator('text=ARE YOU READY TO FUCKING PRINT').isVisible().catch(() => false);
    console.log('Button visible:', btnVisible, '| Splash text visible:', splashVisible);
    
    // Launch the dashboard
    if (btnVisible) {
      await page.click('[data-testid="button-launch-batcave"]');
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(2500);
    
    // Check we're on dashboard
    const tabsVisible = await page.locator('[data-testid="tabs-dashboard"]').isVisible().catch(() => false);
    console.log('Dashboard tabs visible:', tabsVisible);
    
    // Desktop tab screenshots
    const tabs = ['signals','chart','models','tradedesk','regime','news','voices','takefive'];
    for (const tab of tabs) {
      try {
        await page.locator(`[data-testid="tab-${tab}"]`).click();
        await page.waitForTimeout(2000);
        await take(`desktop_${tab}.jpg`);
      } catch(e) {
        console.log(`Error on tab ${tab}:`, e.message.slice(0,80));
      }
    }
    
    await ctx.close();
    
    // ─── Mobile screenshots ────────────────────────────────
    const mobileCtx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true, hasTouch: true,
    });
    const mobilePg = await mobileCtx.newPage();
    await mobilePg.goto(TARGET, { waitUntil: 'networkidle', timeout: 30000 });
    await mobilePg.waitForTimeout(4000);
    
    const mobileBtn = await mobilePg.locator('[data-testid="button-launch-batcave"]').isVisible().catch(() => false);
    if (mobileBtn) {
      await mobilePg.click('[data-testid="button-launch-batcave"]');
    } else {
      await mobilePg.keyboard.press('Enter');
    }
    await mobilePg.waitForTimeout(2000);
    
    for (const tab of tabs) {
      try {
        await mobilePg.locator(`[data-testid="tab-${tab}"]`).click();
        await mobilePg.waitForTimeout(1500);
        const p = path.join(SCREENSHOTS_DIR, `mobile_${tab}.jpg`);
        await mobilePg.screenshot({ path: p, type: 'jpeg', quality: 85 });
        console.log('Saved:', `mobile_${tab}.jpg`);
      } catch(e) {
        console.log(`Error on mobile tab ${tab}:`, e.message.slice(0,80));
      }
    }
    
    await mobileCtx.close();
  } finally {
    await browser.close();
    server.kill();
    console.log('\nAll screenshots complete!');
    process.exit(0);
  }
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
