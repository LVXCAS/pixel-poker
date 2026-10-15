/* Browser QA for the integrated multiplayer build (see integrate.py). Usage: node flow-client.js <integrated-dir> [phone] */
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');   // PLAYWRIGHT=/path/to/node_modules/playwright
const ROOT = require('path').resolve(process.argv[2] || '.'), SHOT = ROOT + '/qa-shots/';
require('fs').mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const vp = process.argv[3] === 'phone' ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  const tag = process.argv[3] === 'phone' ? 'P' : 'B';
  const page = await browser.newPage({ viewport: vp });
  await page.addInitScript(() => { try { localStorage.setItem('pixelholdem.tutorial.v1', JSON.stringify({ done: [], offered: true })); } catch (e) {} });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto('file://' + ROOT + '/index.html?fake=1');
  await sleep(500);
  const code = await page.evaluate(() => fakeHost());
  // invite link path: reload with ?room= is not possible (in-page hub would reset), so drive the join screen
  await page.click('#nav-multi');
  await page.click('[data-key="hub-join"]');
  await page.fill('[data-key="join-code"]', code.toLowerCase());
  await page.fill('[data-key="join-name"]', 'lucas');
  await page.screenshot({ path: SHOT + tag + '1-join.png' });
  await page.click('[data-key="join-btn"]');
  await sleep(500);
  await page.screenshot({ path: SHOT + tag + '2-waiting.png' });
  console.log('client lobby header:', await page.textContent('.mp-board h2'));
  await page.evaluate(() => fakeHostStart());
  await sleep(800);
  let heroTurns = 0; const hands = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 40000 && hands.size < 4) {
    const mode = await page.getAttribute('#action-bar', 'data-mode');
    if (mode === 'hero') { heroTurns++; await page.keyboard.press('c'); }
    hands.add(await page.textContent('#tb-hand'));
    if (heroTurns === 1) await page.screenshot({ path: SHOT + tag + '3-table.png' });
    await sleep(250);
  }
  console.log('hands', [...hands], 'hero turns', heroTurns, 'level bar:', await page.textContent('.mp-level').catch(() => 'none'));
  // drop the client connection -> reconnect banner -> rejoin with start+sync
  await page.evaluate(() => { const c = [...fake.host.peers.keys()][0]; fake.hub.drop(c); });
  await sleep(300);
  console.log('banner visible during reconnect:', await page.isVisible('.mp-banner'));
  await page.screenshot({ path: SHOT + tag + '4-reconnecting.png' });
  await sleep(2500);
  console.log('banner after reconnect:', await page.isVisible('.mp-banner'), 'seat conn:', await page.evaluate(() => fake.host.seats.filter((s) => s.kind === 'human').map((s) => s.conn)));
  const t1 = Date.now(); let turns2 = 0;
  while (Date.now() - t1 < 15000 && turns2 < 2) {
    if ((await page.getAttribute('#action-bar', 'data-mode')) === 'hero') { turns2++; await page.keyboard.press('c'); }
    await sleep(250);
  }
  console.log('hero turns after rejoin:', turns2);
  await page.evaluate(() => fake.host.endGame());
  await sleep(800);
  await page.screenshot({ path: SHOT + tag + '5-podium.png' });
  console.log('podium rows:', await page.$$eval('.mp-standings li', (n) => n.length));
  await page.click('button:has-text("back to lobby")');
  await sleep(300);
  await page.evaluate(() => fake.host.close());
  await sleep(800);
  console.log('after host close:', await page.textContent('.mp-error-title').catch(() => 'no error panel'));
  await page.screenshot({ path: SHOT + tag + '6-closed.png' });
  console.log('ERRORS:', errs.length ? errs : 'none');
  await browser.close();
})().catch((e) => { console.error('FLOW FAILED', e); process.exit(1); });
