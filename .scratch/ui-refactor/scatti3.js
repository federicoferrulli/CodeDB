'use strict';
const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
const OUT = __dirname + '/scatti';
(async () => {
  const server = await startTestServer({ port: 3467 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  page.on('pageerror', (e) => console.log('ERRORE JS:', e.message));
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => document.getElementById('onboarding-overlay')?.remove());
  // Modale "Aggiungi connessione"
  await page.click('#conn-add-btn').catch(() => {});
  await page.waitForTimeout(700);
  for (const tema of ['dark','light']) {
    await page.evaluate((t)=>document.documentElement.setAttribute('data-theme',t), tema);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/modale-conn-${tema}.png` });
  }
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  // Menu impostazioni
  await page.click('#conn-settings-btn').catch(async () => { await page.click('text=Impostazioni'); });
  await page.waitForTimeout(500);
  for (const tema of ['dark','light']) {
    await page.evaluate((t)=>document.documentElement.setAttribute('data-theme',t), tema);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/menu-imp-${tema}.png`, clip:{x:0,y:300,width:520,height:650} });
  }
  await browser.close(); await server.stop(); console.log('fatto');
})();
