const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
(async () => {
  const server = await startTestServer({ port: 3471 });
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
    const box=tr.querySelector('input');
    const cs=box?getComputedStyle(box):null;
    const prima=Math.round(tr.getBoundingClientRect().height);
    // ipotesi: e' la checkbox a gonfiare la riga
    if(box){box.style.margin='0';box.style.display='block';}
    const dopo=Math.round(tr.getBoundingClientRect().height);
    return { prima, dopo, checkboxMargin: cs&&cs.margin, checkboxH: box&&Math.round(box.getBoundingClientRect().height),
      trHeightCss: getComputedStyle(tr).height };
  }),null,1));
  await b.close(); await server.stop();
})();
