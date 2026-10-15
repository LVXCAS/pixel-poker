/* Browser QA for the integrated multiplayer build (see integrate.py). Usage: node flow-offline.js <integrated-dir> */
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');   // PLAYWRIGHT=/path/to/node_modules/playwright
const ROOT = require('path').resolve(process.argv[2] || '.'), SHOT = ROOT + '/qa-shots/';
require('fs').mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => { try { localStorage.setItem('pixelholdem.tutorial.v1', JSON.stringify({ done: [], offered: true })); } catch (e) {} });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto('file://' + ROOT + '/index.html');   // no fake: offline room needs no network
  await sleep(400);
  await page.click('#nav-multi');
  await page.click('[data-key="hub-offline"]');
  await sleep(300);
  await page.screenshot({ path: SHOT + 'C1-offline-lobby.png' });
  await page.click('[data-key="start"]');
  const t0 = Date.now(); const hands = new Set(); let folds = 0;
  while (Date.now() - t0 < 30000 && hands.size < 3) {
    const mode = await page.getAttribute('#action-bar', 'data-mode');
    if (mode === 'hero') { folds++; await page.keyboard.press('f'); await sleep(100); await page.keyboard.press('f'); }
    else if (mode === 'between') await page.keyboard.press(' ');
    hands.add(await page.textContent('#tb-hand'));
    await sleep(250);
  }
  console.log('hands', [...hands], 'level:', await page.textContent('.mp-level'), 'peerjs loaded?', await page.evaluate(() => typeof window.Peer));
  await page.screenshot({ path: SHOT + 'C2-offline-table.png' });
  // leave via main's leave button -> lobby onLeave -> hub
  await page.click('#tb-menu');
  await sleep(200);
  await page.click('.modal-overlay button:has-text("leave")');
  await sleep(400);
  console.log('after leave screen:', await page.getAttribute('body', 'data-screen'));
  console.log('ERRORS:', errs.length ? errs : 'none');
  await browser.close();
})().catch((e) => { console.error('FLOW FAILED', e); process.exit(1); });
