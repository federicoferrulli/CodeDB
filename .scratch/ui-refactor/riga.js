const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
(async () => {
  const server = await startTestServer({ port: 3469 });
  const b = await chromium.launch(); const page = await b.newPage({viewport:{width:1400,height:900}});
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid', { timeout: 15000, state:'attached' }); await page.waitForTimeout(2000);
  console.log(JSON.stringify(await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { renderGrid } = await import('/js/grid.js');
    document.getElementById('welcome').classList.add('hidden');
    document.getElementById('tab-body').classList.remove('hidden');
    document.getElementById('workspace').classList.remove('hidden');
    document.getElementById('placeholder').classList.add('hidden');
    state.docs=Array.from({length:50},(_,i)=>({_id:i,n:'x'+i,b:i%2===0}));
    state.columns=['_id','n','b']; state.total=50; renderGrid();
    const tr=document.querySelector('#grid tbody tr');
    return [...tr.children].map((td)=>{const r=td.getBoundingClientRect();
      const cs=getComputedStyle(td);
      return {cls:td.className,h:Math.round(r.height),pad:cs.padding,lh:cs.lineHeight,
        figli:[...td.children].map(c=>({t:c.tagName,cls:c.className,h:Math.round(c.getBoundingClientRect().height)}))};});
  }),null,1));
  await b.close(); await server.stop();
})();
