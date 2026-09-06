'use strict';
/* Scatti delle schermate principali, nei due temi. Strumento di analisi UI. */
const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');

const VISTE = ['view-data', 'view-details', 'view-uml', 'view-graph3d', 'view-query'];
const OUT = __dirname + '/scatti';

(async () => {
  const server = await startTestServer({ port: 3459 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('ERRORE JS:', e.message));
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    document.getElementById('onboarding-overlay')?.remove();
  });
  for (const tema of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), tema);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${tema}-00-welcome.png` });
    await page.evaluate(() => {
      document.getElementById('welcome').classList.add('hidden');
      document.getElementById('tab-body').classList.remove('hidden');
      document.getElementById('workspace').classList.remove('hidden');
    });
    for (const v of VISTE) {
      await page.evaluate((vista) => {
        for (const p of document.querySelectorAll('#workspace .view-panel')) p.classList.add('hidden');
        document.getElementById(vista).classList.remove('hidden');
      }, v);
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${OUT}/${tema}-${v}.png` });
    }
  }
  await browser.close();
  await server.stop();
  console.log('fatto');
})();
