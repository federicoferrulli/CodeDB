const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
const OUT = __dirname + '/scatti';
(async () => {
  const server = await startTestServer({ port: 3473 });
  const b = await chromium.launch(); const page = await b.newPage({viewport:{width:1400,height:900}});
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid', { timeout: 15000, state:'attached' }); await page.waitForTimeout(2000);
  await page.evaluate(() => document.getElementById('onboarding-overlay')?.remove());
  for (const tema of ['light','dark']) {
    await page.evaluate((t)=>document.documentElement.setAttribute('data-theme',t), tema);
    await page.keyboard.press('Control+p'); await page.waitForTimeout(500);
    await page.keyboard.type('conn'); await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/palette-${tema}.png`, clip:{x:340,y:60,width:720,height:400} });
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  }
  await b.close(); await server.stop(); console.log('fatto');
})();
