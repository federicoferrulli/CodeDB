const {chromium}=require('playwright');
const fs=require('node:fs');
(async()=>{
 const port=fs.readFileSync('test-reports/revisione-2026-10-09/verifica-attuale/contenitori/profilo-ZSKVKQ/DevToolsActivePort','utf8').split(/\r?\n/)[0];
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 for(const page of browser.contexts().flatMap(context=>context.pages())){
  console.log(page.url());console.log(await page.evaluate(()=>({ready:document.readyState,arc:document.documentElement.dataset.arcReady,visible:[...document.querySelectorAll('.overlay:not(.hidden)')].map(x=>x.id),text:document.body.innerText.slice(0,2500)})));
  await page.screenshot({path:'test-reports/revisione-2026-10-09/electron-diagnosi.png'});
 }
 await browser.close();
})();
