const { chromium } = require('./node_modules/playwright');
const fs = require('fs');
const path = require('path');

const SCREENSHOTS_DIR = '/home/user/workspace/screenshots_v2';
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const TARGET = 'http://127.0.0.1:5000';

(async () => {
  const browser = await chromium.launch({ headless: true });
  
  // ─── Desktop context ───────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  
  console.log('Navigating to app...');
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  // t=0 — immediate (atmospheric phase)
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'opener_t0.jpg'), type: 'jpeg', quality: 85 });
  console.log('t=0 screenshot saved');
  
  // t=500ms — atmospheric with rain  
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'opener_t500.jpg'), type: 'jpeg', quality: 85 });
  console.log('t=500 screenshot saved');
  
  // t=1200ms — cube tumbling
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'opener_t1200.jpg'), type: 'jpeg', quality: 85 });
  console.log('t=1200 screenshot saved');
  
  // t=2000ms — cube settling
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'opener_t2000.jpg'), type: 'jpeg', quality: 85 });
  console.log('t=2000 screenshot saved');
  
  // t=2500ms — logo slam / BATCAVE reveal
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'opener_t2500.jpg'), type: 'jpeg', quality: 85 });
  console.log('t=2500 screenshot saved');
  
  // t=3200ms — ready state with button
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'opener_t3200.jpg'), type: 'jpeg', quality: 85 });
  console.log('t=3200 screenshot saved');
  
  // ─── Click through to dashboard ───────────────────────
  try {
    await page.waitForSelector('[data-testid="button-launch-batcave"]', { timeout: 5000 });
    await page.click('[data-testid="button-launch-batcave"]');
    console.log('Clicked launch button');
  } catch(e) {
    // Skip cinematic by pressing Enter
    await page.keyboard.press('Enter');
    console.log('Pressed Enter to skip/launch');
  }
  
  await page.waitForTimeout(2500);
  
  // ─── Dashboard screenshots — desktop ──────────────────
  const tabs = [
    ['signals', 'tab-signals'],
    ['chart', 'tab-chart'],
    ['models', 'tab-models'],
    ['tradedesk', 'tab-tradedesk'],
    ['regime', 'tab-regime'],
    ['news', 'tab-news'],
    ['voices', 'tab-voices'],
    ['takefive', 'tab-takefive'],
  ];
  
  for (const [name, testId] of tabs) {
    try {
      await page.locator(`[data-testid="${testId}"]`).click();
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `desktop_${name}.jpg`), type: 'jpeg', quality: 85 });
      console.log(`desktop_${name} screenshot saved`);
    } catch(e) {
      console.log(`Error on tab ${name}: ${e.message}`);
    }
  }
  
  await ctx.close();
  
  // ─── Mobile screenshots ────────────────────────────────
  const mobileCtx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  const mobilePg = await mobileCtx.newPage();
  await mobilePg.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await mobilePg.waitForTimeout(3800);
  
  try {
    const btn = await mobilePg.waitForSelector('[data-testid="button-launch-batcave"]', { timeout: 5000 });
    await btn.click();
  } catch(e) {
    await mobilePg.keyboard.press('Enter');
  }
  await mobilePg.waitForTimeout(2000);
  
  for (const [name, testId] of tabs) {
    try {
      await mobilePg.locator(`[data-testid="${testId}"]`).click();
      await mobilePg.waitForTimeout(1500);
      await mobilePg.screenshot({ path: path.join(SCREENSHOTS_DIR, `mobile_${name}.jpg`), type: 'jpeg', quality: 85 });
      console.log(`mobile_${name} screenshot saved`);
    } catch(e) {
      console.log(`Error on mobile tab ${name}: ${e.message}`);
    }
  }
  
  await mobileCtx.close();
  await browser.close();
  console.log('All screenshots complete!');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
