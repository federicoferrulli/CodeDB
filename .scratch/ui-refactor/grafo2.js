const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
(async () => {
  const server = await startTestServer({ port: 3479 });
  const b = await chromium.launch();
  for (const vp of [{width:1280,height:720},{width:1440,height:900},{width:1680,height:1050}]) {
    const page = await b.newPage({ viewport: vp });
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#graph3d-canvas', { timeout: 15000, state:'attached' }); await page.waitForTimeout(1800);
    const res = await page.evaluate(() => {
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
      const out=[];
      for (const w of document.querySelectorAll('.graph3d-bar .toolbar-dropdown-wrap')) {
        const btn=w.querySelector('button'); const menu=w.querySelector('.toolbar-dropdown-menu');
        if(!btn||!menu) continue;
        btn.click();
        const rM=menu.getBoundingClientRect(), rP=pannello.getBoundingClientRect();
        const x=Math.max(rM.left,rP.left)+4, y=Math.max(rM.top,rP.top)+4;
        const sov = x<Math.min(rM.right,rP.right) && y<Math.min(rM.bottom,rP.bottom);
        let sopra=null;
        if(sov){const el=document.elementFromPoint(x,y); sopra=!!(el&&el.closest&&el.closest('.toolbar-dropdown-menu'));}
        out.push({id:btn.id, sov, sopra});
        menu.classList.add('hidden'); btn.setAttribute('aria-expanded','false');
      }
      return out;
    });
    console.log(vp.width+'x'+vp.height, JSON.stringify(res));
    await page.close();
  }
  await b.close(); await server.stop();
})();
