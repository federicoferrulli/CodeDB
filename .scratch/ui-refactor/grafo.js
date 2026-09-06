const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
(async () => {
  const server = await startTestServer({ port: 3477 });
  const b = await chromium.launch(); const page = await b.newPage({viewport:{width:1440,height:900}});
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#graph3d-canvas', { timeout: 15000, state:'attached' }); await page.waitForTimeout(2000);
  console.log(JSON.stringify(await page.evaluate(() => {
    document.getElementById('onboarding-overlay')?.remove();
    document.getElementById('welcome').classList.add('hidden');
    document.getElementById('tab-body').classList.remove('hidden');
    document.getElementById('workspace').classList.remove('hidden');
    document.getElementById('placeholder').classList.add('hidden');
    for (const p of document.querySelectorAll('#workspace .view-panel')) p.classList.add('hidden');
    document.getElementById('view-graph3d').classList.remove('hidden');
    const pannello=document.getElementById('graph3d-side-panel');
    pannello.classList.remove('hidden');
    document.querySelector('.graph3d-container').classList.add('pannello-aperto');
    const btn=document.getElementById('graph3d-export-menu-btn'); btn.click();
    const menu=document.getElementById('graph3d-export-menu');
    const r=(e)=>{const x=e.getBoundingClientRect();return {l:Math.round(x.left),t:Math.round(x.top),r:Math.round(x.right),b:Math.round(x.bottom),w:Math.round(x.width),h:Math.round(x.height)};};
    return { viewport:{w:innerWidth,h:innerHeight}, menu:r(menu), pannello:r(pannello),
      menuNascosto: menu.classList.contains('hidden'), barra:r(document.querySelector('.graph3d-bar')) };
  }),null,1));
  await b.close(); await server.stop();
})();
