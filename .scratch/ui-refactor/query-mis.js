const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
(async () => {
  const server = await startTestServer({ port: 3481 });
  const b = await chromium.launch(); const page = await b.newPage({viewport:{width:1600,height:950}});
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid', { timeout: 15000, state:'attached' }); await page.waitForTimeout(2000);
  console.log(JSON.stringify(await page.evaluate(async () => {
    const { renderResults, setResultsViewMode } = await import('/js/query-tab.js');
    document.getElementById('onboarding-overlay')?.remove();
    document.getElementById('welcome').classList.add('hidden');
    document.getElementById('tab-body').classList.remove('hidden');
    document.getElementById('workspace').classList.remove('hidden');
    document.getElementById('placeholder').classList.add('hidden');
    for (const p of document.querySelectorAll('#workspace .view-panel')) p.classList.add('hidden');
    document.getElementById('view-query').classList.remove('hidden');
    setResultsViewMode('table');
    renderResults(Array.from({length:200},(_,i)=>({id:i,nome:'n'+i,q:i})));
    const r=(s)=>{const e=document.querySelector(s); if(!e)return null; const x=e.getBoundingClientRect();
      return {h:Math.round(x.height),w:Math.round(x.width),top:Math.round(x.top),left:Math.round(x.left)};};
    return {
      barra: r('#view-query .toolbar') || r('.query-toolbar'),
      schema: r('#query-schema-browser') || r('.query-schema'),
      editorPanel: r('.query-editor-panel') || r('#query-editor-wrap'),
      editor: r('#query-editor'),
      risultati: r('#query-results-panel') || r('#query-table-view'),
      righeVisibili: (()=>{const c=document.querySelector('#query-table-view'); const tr=document.querySelector('#query-result-table tbody tr');
        return c&&tr?Math.floor(c.getBoundingClientRect().height/tr.getBoundingClientRect().height):null;})(),
      figliDiViewQuery: [...document.getElementById('view-query').children].map(e=>({cls:e.className,id:e.id,h:Math.round(e.getBoundingClientRect().height)})),
    };
  }),null,1));
  await b.close(); await server.stop();
})();
