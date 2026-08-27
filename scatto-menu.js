'use strict';
/* Scatto del menu «Vicini» aperto, nei due temi. File temporaneo di verifica. */
const { chromium } = require('playwright');
const { startTestServer } = require('./test/e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3457 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#graph3d-canvas', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const g = document.getElementById('onboarding-overlay');
    if (g) g.remove();
    document.getElementById('welcome').classList.add('hidden');
    document.getElementById('tab-body').classList.remove('hidden');
    document.getElementById('workspace').classList.remove('hidden');
    for (const v of document.querySelectorAll('#workspace .view-panel')) v.classList.add('hidden');
    document.getElementById('view-graph3d').classList.remove('hidden');
    // Il filtro è disattivato finché non si sceglie una tabella: qui interessa
    // come si VEDE il menu, quindi lo si abilita a mano.
    document.getElementById('graph3d-hop-btn').disabled = false;
  });
  for (const tema of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), tema);
    await page.waitForTimeout(300);
    await page.click('#graph3d-hop-btn');
    await page.waitForTimeout(400);
    const zona = await page.evaluate(() => {
      const bar = document.querySelector('.graph3d-bar').getBoundingClientRect();
      const menu = document.getElementById('graph3d-hop-menu').getBoundingClientRect();
      const x = Math.max(0, Math.min(bar.left, menu.left) - 12);
      const y = Math.max(0, bar.top - 8);
      return {
        x, y,
        width: Math.max(bar.right, menu.right) - x + 12,
        height: Math.max(bar.bottom, menu.bottom) - y + 12,
      };
    });
    await page.screenshot({ path: `menu-${tema}.png`, clip: zona });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  await browser.close();
  await server.stop();
  console.log('scatti pronti');
})();
