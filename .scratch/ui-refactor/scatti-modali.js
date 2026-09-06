'use strict';
const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
const OUT = __dirname + '/scatti';
const MODALI = ['backup-modal','audit-modal','health-modal','sessions-modal','tema-modal','pending-queries-modal','path-modal','import-schema-modal'];
(async () => {
  const server = await startTestServer({ port: 3495 });
  const b = await chromium.launch(); const page = await b.newPage({viewport:{width:1400,height:900}});
  const errori=[]; page.on('pageerror',e=>errori.push(e.message));
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid', { state:'attached', timeout:15000 }); await page.waitForTimeout(2200);
  await page.evaluate(() => document.getElementById('onboarding-overlay')?.remove());
  const presenti = await page.evaluate((ids) => ids.filter(i=>document.getElementById(i)), MODALI);
  for (const id of presenti) {
    for (const tema of ['dark','light']) {
      await page.evaluate(({i,t}) => {
        document.documentElement.setAttribute('data-theme',t);
        for(const m of document.querySelectorAll('.overlay')) m.classList.add('hidden');
        document.getElementById(i).classList.remove('hidden');
      }, {i:id,t:tema});
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${OUT}/mod-${id}-${tema}.png` });
    }
  }
  console.log('modali:', presenti.join(', '));
  console.log('errori JS:', errori);
  await b.close(); await server.stop();
})();
