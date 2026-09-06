'use strict';
const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
(async () => {
  const server = await startTestServer({ port: 3465 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(2000);
  const out = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { renderGrid } = await import('/js/grid.js');
    document.getElementById('onboarding-overlay')?.remove();
    document.getElementById('welcome').classList.add('hidden');
    document.getElementById('tab-body').classList.remove('hidden');
    document.getElementById('workspace').classList.remove('hidden');
    document.getElementById('placeholder').classList.add('hidden');
    document.getElementById('coll-tab-bar').classList.remove('hidden');
    state.docs = Array.from({length:300},(_,i)=>({_id:i+1,nome:'x'+i,q:i}));
    state.columns=['_id','nome','q']; state.total=300;
    renderGrid();
    const h = (s) => { const e=document.querySelector(s); if(!e) return null;
      const r=e.getBoundingClientRect(); return {h:Math.round(r.height), w:Math.round(r.width), top:Math.round(r.top)}; };
    const wh = document.querySelector('.workspace-head');
    const vt = document.querySelector('.view-tabs');
    return {
      viewport: innerHeight,
      header: h('header'),
      tabBarWrap: h('.tab-bar-wrap'),
      collTabBar: h('#coll-tab-bar'),
      workspaceHead: h('.workspace-head'),
      viewTabs: h('.view-tabs'),
      vuotoASinistraDelleTab: vt && wh ? Math.round(vt.getBoundingClientRect().left - wh.getBoundingClientRect().left) : null,
      toolbar: h('#view-data .toolbar'),
      gridWrap: h('#view-data .grid-wrap'),
      footer: h('#view-data .grid-footer') || h('.pager') || h('#pager'),
      altezzaRiga: (() => { const tr=document.querySelector('#grid tbody tr'); return tr?Math.round(tr.getBoundingClientRect().height):null; })(),
      righeVisibili: (() => { const g=document.querySelector('#view-data .grid-wrap'); const tr=document.querySelector('#grid tbody tr');
        return g&&tr?Math.floor(g.getBoundingClientRect().height/tr.getBoundingClientRect().height):null; })(),
    };
  });
  console.log(JSON.stringify(out,null,1));
  await browser.close(); await server.stop();
})();
