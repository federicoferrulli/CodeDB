// Diagnosi isolata: renderer reale, trasporto e dati di prova.
const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
const fs = require('node:fs');
const root = 'test-reports/revisione-2026-10-09/lag';
fs.mkdirSync(root, { recursive: true });
(async () => {
  const server = await startTestServer({ port: 3185 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    for (const selector of ['#onboarding-close', '.onb-checklist-close']) if (await page.locator(selector).isVisible()) await page.locator(selector).click();
    await page.evaluate(async () => { window.modules = await Promise.all(['tabs','socket','tabbar','workspace','colltabs'].map(x => import(`/js/${x}.js`))); });
    await page.evaluate(() => {
      const [tabs, socket, bar, workspace, objects] = window.modules;
      const docs = Array.from({ length: 2000 }, (_, i) => Object.fromEntries(Array.from({ length: 30 }, (_, j) => [j ? `campo_${j}` : '_id', j % 3 ? `Valore ${i}, colonna ${j}` : i * 30 + j])));
      const columns = Object.keys(docs[0]);
      const collections = [{ name: 'ordini' }, { name: 'clienti' }];
      const fields = columns.map(name => ({ name, types:['string'], presence:100 }));
      const fake = { connected:true, on(){}, off(){}, emit(name, payload, ack) { ack?.({ok:true, docs, data:docs, columns, fields, indexes:[], total:docs.length, stats:{count:docs.length}, collections, databases:[{name:'negozio',collections}]}); }, timeout(){return {emit:(n,p,ack)=>fake.emit(n,p,r=>ack(null,r))};} };
      socket.impostaSocket(fake);
      const tab = tabs.createTab({id:'prestazioni'}); tab.label='Connessione di prova'; tab.dbType='mongodb';
      Object.assign(tab.state,{connected:true,connLabel:tab.label,dbType:'mongodb',databases:[{name:'negozio',collections}],limit:2000});
      tabs.tabs.activeId=tab.id; bar.renderTabBar(); workspace.renderWorkspace(); objects.openCollTab('negozio','ordini');
    });
    await page.locator('#grid.virtual tbody tr:not(.v-spacer)').first().waitFor();
    await page.waitForTimeout(700);
    await page.screenshot({path:`${root}/prima.png`});
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
    await page.evaluate(() => {
      window.perf = { righeAggiunte:0, righeRimosse:0, longTasks:[], frames:[] };
      window.obs = new MutationObserver(records => { for(const r of records) { window.perf.righeAggiunte += [...r.addedNodes].filter(n=>n.nodeName==='TR').length; window.perf.righeRimosse += [...r.removedNodes].filter(n=>n.nodeName==='TR').length; } });
      window.obs.observe(document.querySelector('#grid tbody'),{childList:true});
      window.long = new PerformanceObserver(list=>window.perf.longTasks.push(...list.getEntries().map(e=>e.duration)));
      window.long.observe({type:'longtask',buffered:false});
    });
    const measurements = {};
    measurements.scroll = await page.evaluate(async () => {
      const wrap=document.querySelector('.grid-wrap'); let previous=performance.now();
      for(let i=0;i<60;i++) { await new Promise(requestAnimationFrame); const now=performance.now(); window.perf.frames.push(now-previous); previous=now; wrap.scrollTop += 30; }
      await new Promise(r=>setTimeout(r,100)); const result=structuredClone(window.perf);
      window.perf={righeAggiunte:0,righeRimosse:0,longTasks:[],frames:[]}; return result;
    });
    const cell = page.locator('#grid tbody td[data-c="1"]').nth(12);
    await cell.click();
    for(let i=0;i<25;i++) await page.keyboard.press('Shift+ArrowRight');
    measurements.tastiera = await page.evaluate(() => {const result=structuredClone(window.perf);window.perf={righeAggiunte:0,righeRimosse:0,longTasks:[],frames:[]}; return result;});
    await page.evaluate(()=>{document.querySelector('.grid-wrap').scrollLeft=0;});
    const from=await page.locator('#grid tbody td[data-c="1"]').nth(12).boundingBox();
    const to=await page.locator('#grid tbody td[data-c="4"]').nth(22).boundingBox();
    await page.mouse.move(from.x+8,from.y+8); await page.mouse.down();
    await page.mouse.move(to.x+8,to.y+8,{steps:40}); await page.mouse.up();
    measurements.mouse = await page.evaluate(()=>window.perf);
    const {profile} = await cdp.send('Profiler.stop');
    fs.writeFileSync(`${root}/profilo.json`,JSON.stringify(profile));
    const counts=new Map(); profile.samples?.forEach(id=>counts.set(id,(counts.get(id)||0)+1));
    measurements.hot = profile.nodes.map(n=>({nome:n.callFrame.functionName,url:n.callFrame.url,riga:n.callFrame.lineNumber+1,campioni:counts.get(n.id)||0})).sort((a,b)=>b.campioni-a.campioni).slice(0,25);
    fs.writeFileSync(`${root}/misure.json`,JSON.stringify(measurements,null,2)); console.log(JSON.stringify(measurements,null,2));
  } finally { await browser.close(); await server.stop(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
