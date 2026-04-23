const { chromium } = require('./node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs');

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
  
  const ok = await waitForServer(TARGET);
  console.log('Server ready:', ok);
  
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  
  try {
    console.log('Navigating...');
    const response = await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Status:', response?.status());
    console.log('Title:', await page.title());
    
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '/home/user/workspace/screenshots_v2/debug_loaded.jpg', type: 'jpeg', quality: 85 });
    console.log('Screenshot saved');
    
  } catch(e) {
    console.error('Error:', e.message);
  }
  
  await ctx.close();
  await browser.close();
  server.kill();
  process.exit(0);
})();
