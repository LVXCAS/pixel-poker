/* Browser QA for the integrated multiplayer build (see integrate.py). Usage: node flow-host.js <integrated-dir> */
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');   // PLAYWRIGHT=/path/to/node_modules/playwright
const ROOT = require('path').resolve(process.argv[2] || '.'), SHOT = ROOT + '/qa-shots/';
require('fs').mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => { try { localStorage.setItem('pixelholdem.tutorial.v1', JSON.stringify({ done: [], offered: true })); } catch (e) {} });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto('file://' + ROOT + '/index.html?fake=1');
  await sleep(600);
  await page.click('#nav-multi');
  await sleep(300);
  await page.screenshot({ path: SHOT + 'A1-hub.png' });
  await page.click('[data-key="hub-host"]');
  await page.waitForSelector('.mp-code-v');
  const code = await page.textContent('.mp-code-v');
  console.log('host code', code);
  await page.evaluate(() => fakeJoin('ann'));
  await page.evaluate(() => fakeJoin('<b>bob</b>'));
  await sleep(300);
  await page.click('[data-key="add-bot"]');
  await sleep(300);
  await page.screenshot({ path: SHOT + 'A2-lobby.png' });
  console.log('seats:', await page.$$eval('.mp-seat-text', (n) => n.map((x) => x.textContent)));
  await page.click('[data-key="start"]');
  await sleep(500);
  let heroTurns = 0, hands = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 45000 && hands.size < 6) {
    const mode = await page.getAttribute('#action-bar', 'data-mode');
    if (mode === 'hero') { heroTurns++; await page.keyboard.press('c'); }
    else if (mode === 'between') await page.keyboard.press(' ');
    hands.add(await page.textContent('#tb-hand'));
    if (heroTurns === 2 && !(await page.$('.mp-drawer:not([hidden])'))) {
      await page.evaluate(() => fakeChat(0, 'gl all <script>alert(1)</script>'));
      await sleep(200);
      await page.screenshot({ path: SHOT + 'A3-table.png' });
    }
    await sleep(250);
  }
  console.log('hands seen', [...hands], 'hero turns', heroTurns);
  await page.click('.mp-tab:has-text("chat")');
  await sleep(200);
  await page.fill('.mp-chat-form .mp-input', 'nice hand');
  await page.keyboard.press('Enter');
  await sleep(300);
  console.log('chat lines:', await page.$$eval('.mp-chat-log li', (n) => n.map((x) => x.textContent)));
  await page.screenshot({ path: SHOT + 'A4-chat.png' });
  await page.click('.mp-tab:has-text("players")');
  await sleep(200);
  await page.screenshot({ path: SHOT + 'A5-players.png' });
  const end = await page.$('.mp-drawer-foot button:has-text("end game")');
  await end.click(); await sleep(100); await end.click();
  await sleep(800);
  await page.screenshot({ path: SHOT + 'A6-podium.png' });
  console.log('modal title:', await page.textContent('.modal h2, .modal-title').catch(() => '?'));
  console.log('client results:', await page.evaluate(() => fake.clients.map((c) => c.results && c.results.reason)));
  await page.click('button:has-text("run it back")');
  await sleep(500);
  console.log('screen after run it back:', await page.getAttribute('body', 'data-screen'), await page.textContent('.mp-board h2'));
  await page.screenshot({ path: SHOT + 'A7-backlobby.png' });
  console.log('client lobby phase:', await page.evaluate(() => fake.clients.map((c) => c.lobby.phase)));
  // close table -> clients get closed
  await page.click('[data-key="back"]');
  await sleep(400);
  console.log('after close: screen', await page.getAttribute('body', 'data-screen'), 'clients closed', await page.evaluate(() => fake.clients.map((c) => c.closed)));
  console.log('ERRORS:', errs.length ? errs : 'none');
  await browser.close();
})().catch((e) => { console.error('FLOW FAILED', e); process.exit(1); });
