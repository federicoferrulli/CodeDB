// Diagnosi isolata: renderer reale, trasporto e dati di prova.
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const mutant = process.argv.includes('--mutant') ? 'dom' : process.argv.find(x=>x.startsWith('--mutant='))?.split('=')[1];
const probe = process.argv.find(x=>x.startsWith('--probe='))?.split('=')[1];
const root = `${process.env.CODEDB_REPORT_ROOT || 'test-reports/revisione-2026-10-09'}/fluidita${mutant ? `-mutante-${mutant}` : probe ? `-${probe}` : ''}`;
fs.mkdirSync(root, { recursive: true });
(async () => {
  const server = await startTestServer({ port: 3185 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const mutations = {
      dom: ['griglia.js','const precedente = conservaRighe &&','const precedente = false &&'],
      colonne: ['table-resize.js','const scrivi = value => {','const scrivi = value => { return;'],
      connessioni: ['connmanager.js','if (!nuova && aperta)','if (false)'],
      anteprima: ['colltabs.js','pinCollTab(ct.id); bar.querySelector','/* mutazione: anteprima non fissata */ bar.querySelector'],
      bozza: ['colltabs.js','if (bozza || precedente.snapQuery','if (false || precedente.snapQuery'],
      navigatore: ['connmanager.js','function impostaSezione(sidebar, button, collapse) {','function impostaSezione(sidebar, button, collapse) { collapse = false;'],
      drawer: ['responsive.js', "navigator.classList.toggle('collapsed');", 'false;'],
      sheet: ['responsive.js','openNavigationSheet(el,',"el.querySelector('input').value = ''; openNavigationSheet(el,"],
      larghezza_mobile: ['responsive.js','openNavigationSheet(el, () => closeDrawers({ restoreFocus: true }));',"openNavigationSheet(el, () => closeDrawers({ restoreFocus: true })); el.style.width = '208px';"],
      menu_mobile: ['utils.js','menu.showPopover?.();',"if (menu.closest('.arc-navigation-sheet')) menu.removeAttribute('popover'); else menu.showPopover?.();"],
    };
    if (mutant && mutant !== 'scroll_mobile') await page.route(`**/js/${mutations[mutant][0]}`, async route => {
      const response = await route.fetch(); const code = await response.text();
      const [,from,to]=mutations[mutant]; assert(code.includes(from));
      await route.fulfill({ response, body: code.replace(from,to) });
    });
    await page.goto(server.url);
    if(mutant === 'scroll_mobile')await page.addStyleTag({content:'@media(max-width:900px){#navigator > #conn-sidebar,#navigator > #sidebar{display:none;}}'});
    await page.waitForSelector('html[data-arc-ready="true"]');
    for (const selector of ['#onboarding-close', '.onb-checklist-close']) if (await page.locator(selector).isVisible()) await page.locator(selector).click();
    if (await page.getByRole('button', {name:'Nascondi i primi passi'}).isVisible()) await page.getByRole('button', {name:'Nascondi i primi passi'}).click();
    await page.evaluate(async () => { window.modules = await Promise.all(['tabs','socket','tabbar','workspace','colltabs'].map(x => import(`/js/${x}.js`))); });
    await page.evaluate(() => {
      const [tabs, socket, bar, workspace, objects] = window.modules;
      const docs = Array.from({ length: 2000 }, (_, i) => Object.fromEntries(Array.from({ length: 30 }, (_, j) => [j ? `campo_${j}` : '_id', j % 3 ? `Valore ${i}, colonna ${j}` : i * 30 + j])));
      const columns = Object.keys(docs[0]);
      const collections = ['ordini','clienti','prodotti','fatture'].map(name=>({name}));
      const fields = columns.map(name => ({ name, types:['string'], presence:100 }));
      window.richiesteGriglia = [];
      const fake = { connected:true, on(){}, off(){}, emit(name, payload, ack) { window.richiesteGriglia.push(name); ack?.({ok:true, docs, data:docs, columns, fields, indexes:[], skip:0, limit:2000, total:docs.length, stats:{count:docs.length}, collections, databases:[{name:'negozio',collections}],connections:[{name:'Connessione di prova',label:'MongoDB di prova',dbType:'mongodb'}]}); }, timeout(){return {emit:(n,p,ack)=>fake.emit(n,p,r=>ack(null,r))};} };
      socket.impostaSocket(fake);
      const tab = tabs.createTab({id:'prestazioni',connName:'Connessione di prova'}); tab.label='Connessione di prova'; tab.dbType='mongodb';
      Object.assign(tab.state,{connected:true,connLabel:tab.label,dbType:'mongodb',databases:[{name:'negozio',collections}],limit:2000});
      tabs.tabs.activeId=tab.id; bar.renderTabBar(); workspace.renderWorkspace(); objects.openCollTab('negozio','ordini');
    });
    await page.locator('#grid.virtual tbody tr:not(.v-spacer)').first().waitFor();
    if (probe === 'movimento') await page.addStyleTag({content:'#grid * { transition: none !important; animation: none !important; }'});
    if (probe && probe !== 'movimento') await page.evaluate(probe => {
      const visit = sheet => {
        try { if(!sheet.cssRules) return; } catch { return; }
        for (let i=sheet.cssRules.length-1;i>=0;i--) {
          const rule=sheet.cssRules[i];
          if(rule.styleSheet) visit(rule.styleSheet);
          else if(rule.cssRules) visit(rule);
          else if(rule.selectorText?.includes(probe==='shell'?'.body:has(':probe==='tutti'?'body:has(':'body:has(.overlay')) sheet.deleteRule(i);
        }
      };
      for(const sheet of document.styleSheets) visit(sheet);
    },probe);
    await page.waitForTimeout(700);
    await page.screenshot({path:`${root}/prima.png`});
    const cdp = await page.context().newCDPSession(page);
    const trace = [];
    if (process.argv.includes('--trace')) {
      cdp.on('Tracing.dataCollected', e=>trace.push(...e.value));
      await cdp.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking,disabled-by-default-blink.debug'});
    }
    await cdp.send('Performance.enable');
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
    await page.evaluate(() => {
      window.perf = { righeAggiunte:0, righeRimosse:0, longTasks:[], frames:[] };
      window.obs = new MutationObserver(records => { for(const r of records) { window.perf.righeAggiunte += [...r.addedNodes].filter(n=>n.nodeName==='TR').length; window.perf.righeRimosse += [...r.removedNodes].filter(n=>n.nodeName==='TR').length; } });
      window.obs.observe(document.querySelector('#grid tbody'),{childList:true});
      window.long = new PerformanceObserver(list=>window.perf.longTasks.push(...list.getEntries().map(e=>e.duration)));
      window.long.observe({type:'longtask',buffered:false});
    });
    const measurements = {};
    const before = await cdp.send('Performance.getMetrics');
    measurements.scroll = await page.evaluate(async () => {
      const wrap=document.querySelector('.grid-wrap'); let previous=performance.now();
      for(let i=0;i<60;i++) { await new Promise(requestAnimationFrame); const now=performance.now(); window.perf.frames.push(now-previous); previous=now; wrap.scrollTop += 30; }
      await new Promise(r=>setTimeout(r,100)); const result=structuredClone(window.perf);
      window.perf={righeAggiunte:0,righeRimosse:0,longTasks:[],frames:[]}; return result;
    });
    const after = await cdp.send('Performance.getMetrics');
    measurements.costiScroll = Object.fromEntries(after.metrics.filter(m=>['LayoutCount','RecalcStyleCount','LayoutDuration','RecalcStyleDuration','ScriptDuration','TaskDuration'].includes(m.name)).map(m=>[m.name,m.value-before.metrics.find(b=>b.name===m.name).value]));
    const cell = page.locator('#grid tbody td[data-c="1"]').nth(12);
    await cell.click();
    for(let i=0;i<25;i++) await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(100);
    measurements.tastiera = await page.evaluate(() => {const result=structuredClone(window.perf);window.perf={righeAggiunte:0,righeRimosse:0,longTasks:[],frames:[]}; return result;});
    await page.evaluate(()=>{document.querySelector('.grid-wrap').scrollLeft=0;});
    const from=await page.locator('#grid tbody td[data-c="1"]').nth(12).boundingBox();
    const to=await page.locator('#grid tbody td[data-c="4"]').nth(22).boundingBox();
    await page.mouse.move(from.x+8,from.y+8); await page.mouse.down();
    await page.mouse.move(to.x+8,to.y+8,{steps:40}); await page.mouse.up();
    await page.waitForTimeout(100);
    measurements.mouse = await page.evaluate(()=>window.perf);
    const {profile} = await cdp.send('Profiler.stop');
    if (process.argv.includes('--trace')) {
      const done = new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
      await cdp.send('Tracing.end'); await done;
      fs.writeFileSync(`${root}/trace.json`,JSON.stringify(trace));
    }
    fs.writeFileSync(`${root}/profilo.json`,JSON.stringify(profile));
    const counts=new Map(); profile.samples?.forEach(id=>counts.set(id,(counts.get(id)||0)+1));
    measurements.hot = profile.nodes.map(n=>({nome:n.callFrame.functionName,url:n.callFrame.url,riga:n.callFrame.lineNumber+1,campioni:counts.get(n.id)||0})).sort((a,b)=>b.campioni-a.campioni).slice(0,25);
    fs.writeFileSync(`${root}/misure.json`,JSON.stringify(measurements,null,2));
    console.log(JSON.stringify({scroll:measurements.scroll.righeAggiunte,tastiera:measurements.tastiera.righeAggiunte,blocchi:measurements.scroll.longTasks.length}));
    assert(measurements.scroll.righeAggiunte < 120, 'Scorrere 60 righe deve montare solo le righe entranti, conservando quelle visibili');
    assert.equal(measurements.tastiera.righeAggiunte, 0, 'Estendere la selezione orizzontale non deve ricostruire righe');
    const ridimensiona = async (selector, nome, surface = page) => {
      const handle = surface.locator(`${selector} .qt-col-resizer`).first();
      const th = handle.locator('..');
      await handle.scrollIntoViewIfNeeded();
      const prima = (await th.boundingBox()).width;
      await handle.focus(); await handle.press('ArrowRight');
      assert(Math.abs((await th.boundingBox()).width-prima-16)<2, `${nome}: freccia modifica la larghezza reale`);
      const box = await handle.boundingBox();
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down();
      await page.mouse.move(box.x+box.width/2+75,box.y+box.height/2,{steps:5}); await page.mouse.up();
      const dopo = (await th.boundingBox()).width;
      assert(Math.abs(dopo-prima-91)<2, `${nome}: trascinamento modifica la larghezza reale`);
      return dopo;
    };
    const letturePrima = await page.evaluate(()=>window.richiesteGriglia.filter(x=>x==='collection:find').length);
    const larghezza = await ridimensiona('#grid','Dati');
    assert.equal(await page.evaluate(()=>window.richiesteGriglia.filter(x=>x==='collection:find').length),letturePrima,'Ridimensionare non ordina né riesegue la query');
    await page.evaluate(()=>{const m=window.modules[4];window.documentoOriginale=m.currentCollTab().id;m.openCollTab('negozio','clienti');});
    await page.evaluate(()=>window.modules[4].switchCollTab(window.documentoOriginale));
    assert(Math.abs((await page.locator('#grid th[data-c="0"]').boundingBox()).width-larghezza)<2,'Larghezza conservata tornando al documento');
    await page.screenshot({path:`${root}/colonne-desktop.png`});
    await page.locator('.view-tab[data-view="query"]').click();
    await page.locator('#query-editor-input').fill('db.ordini.find({})'); await page.locator('#query-run-btn').click();
    await page.locator('#query-result-table tbody tr:not(.v-spacer)').first().waitFor();
    await ridimensiona('#query-result-table','Risultati query');
    await page.evaluate(async()=>{const q=await import('/js/query-tab.js');q.renderResults([{identificatore:1}],['identificatore']);});
    await ridimensiona('#query-result-table','Risultato con una sola colonna');
    await page.locator('.view-tab[data-view="data"]').click();
    await page.evaluate(async()=>{window.splitModule=await import('/js/splitview.js');});
    await page.evaluate(()=>window.splitModule.addOrSplitPane(null,'right',{db:'negozio',coll:'ordini',tabId:'prestazioni'}));
    const pane = await require('./split-frame').frame(page);
    await pane.locator('#grid tbody tr:not(.v-spacer)').first().waitFor();
    await ridimensiona('#grid','Pannello', pane);
    await page.evaluate(()=>window.modules[4].switchCollTab(window.documentoOriginale));
    await page.locator('.view-tab[data-view="data"]').click();
    await page.setViewportSize({width:390,height:844});
    const handle=page.locator('#grid .qt-col-resizer').first(); await handle.scrollIntoViewIfNeeded();
    const h=await handle.boundingBox(), primaTouch=(await handle.locator('..').boundingBox()).width;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:h.x+12,y:h.y+h.height/2}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:h.x+62,y:h.y+h.height/2}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert((await handle.locator('..').boundingBox()).width>primaTouch+40,'Il trascinamento touch ridimensiona la colonna');
    await handle.press('Enter'); await page.getByRole('menuitem',{name:'Imposta larghezza…'}).click();
    await page.locator('#askinput-value').fill('280'); await page.locator('#askinput-ok').click();
    assert(Math.abs((await handle.locator('..').boundingBox()).width-280)<2,'La larghezza è impostabile anche senza trascinare');
    await page.screenshot({path:`${root}/colonne-mobile.png`});
    console.log('OK: larghezza reale, nessun ordinamento accidentale, persistenza del documento, query, pannello, touch e immissione numerica');
    await page.setViewportSize({width:1440,height:900});
    await page.evaluate(async()=>{window.connManager=await import('/js/connmanager.js');});
    await page.evaluate(()=>window.connManager.loadSavedConnections());
    const conn=page.locator('#conn-tree .conn-item > .node-label').first(); await conn.waitFor();
    const nSessioni=await page.evaluate(()=>window.modules[0].tabs.list.length);
    await conn.click(); await conn.click();
    assert.equal(await page.evaluate(()=>window.modules[0].tabs.list.length),nSessioni,'Cliccare una connessione aperta riprende la sessione, senza duplicarla');
    await page.locator('#db-tree .node-label[data-coll="prodotti"]').click();
    await page.getByRole('button',{name:'Mantieni aperta prodotti',exact:true}).click();
    await page.locator('#db-tree .node-label[data-coll="fatture"]').click();
    assert(await page.evaluate(()=>window.modules[0].activeTab().state.collTabs.some(c=>c.coll==='prodotti'&&!c.preview)),'Mantieni conserva il documento dopo la successiva anteprima');
    await page.evaluate(()=>{
      const tab=window.modules[0].activeTab(); tab.state.editDrafts=new Map([[JSON.stringify(['negozio','fatture','0','campo_1']),'Bozza di prova']]);
      window.modules[4].openCollTab('negozio','archivio',{preview:true});
    });
    assert(await page.evaluate(()=>window.modules[0].activeTab().state.collTabs.some(c=>c.coll==='fatture'&&!c.preview)),'Una bozza impedisce la sostituzione del documento in anteprima');
    const settings=await page.locator('#conn-settings-btn').boundingBox(), sidebar=await page.locator('#sidebar').boundingBox();
    assert(settings.y>=sidebar.y+sidebar.height-1,'Strumenti resta sotto l’elenco dei database');
    const main=await page.locator('.tab-body > main').boundingBox();
    const tree=await page.locator('#db-tree').elementHandle();
    assert.equal(await page.locator('.navigation-label').count(),0,'La barra non ripete l’etichetta Sessioni');
    assert.equal(await page.locator('#documents-open').isVisible(),false,'Schede resta solo su mobile');
    assert.equal(await page.locator('#conn-sidebar [aria-controls="conn-section-body"]').count(),0,'Connessioni non ha un controllo di compressione');
    await page.locator('#conn-sidebar .navigator-section-title').click();
    assert(await page.locator('#conn-section-body').isVisible(),'La testata Connessioni lascia sempre visibile l’elenco');
    await page.locator('#menu-conns-btn').click();
    await page.locator('#conn-sidebar').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#conn-sidebar').isVisible(),false,'Il comando chiude tutto il navigatore');
    assert.equal(await page.locator('#sidebar').isVisible(),false);
    assert.equal(await page.locator('#navigator-tools').isVisible(),false);
    assert.equal(await page.locator('.resizer[data-resize="conn-sidebar"]').isVisible(),false);
    assert.equal(await page.locator('#menu-conns-btn').getAttribute('aria-expanded'),'false');
    await page.screenshot({path:`${root}/navigatore-chiuso-desktop.png`});
    assert((await page.locator('.tab-body > main').boundingBox()).width>main.width+200,'La chiusura restituisce spazio al documento');
    await page.keyboard.press('Control+b');
    assert.equal(await page.locator('#menu-conns-btn').getAttribute('aria-expanded'),'true','Ctrl+B riapre il navigatore');
    await page.waitForFunction(() => !document.querySelector('.main-area').getAnimations().length);
    assert.deepEqual(await page.locator('.tab-body > main').boundingBox(),main,'La riapertura ripristina la larghezza');
    await page.locator('#conn-search').focus();
    await page.keyboard.press('Control+b');
    assert(await page.locator('#menu-conns-btn').evaluate(el=>el===document.activeElement),'La chiusura sposta il focus fuori dal pannello');
    await page.setViewportSize({width:390,height:844});
    await page.locator('#mobile-nav-conns').click();
    await page.locator('#conn-search').waitFor({state:'visible'});
    assert.equal(await page.locator('#conn-search').evaluate(el=>!!el.closest('[inert]')),false,'Il drawer chiuso su desktop non blocca le connessioni mobile');
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:1440,height:900});
    assert.equal(await page.locator('#conn-sidebar').isVisible(),false,'Il ritorno desktop mantiene il drawer chiuso');
    await page.locator('#menu-conns-btn').click();
    await page.waitForFunction(() => !document.querySelector('.main-area').getAnimations().length);
    assert(await page.locator('#conn-settings-btn').isVisible());
    await page.locator('#explorer-toggle-btn').click();
    assert.equal(await page.locator('#db-tree').isVisible(),false);
    assert(await page.locator('#navigator-tools').evaluate(el=>Math.abs(el.getBoundingClientRect().bottom-document.getElementById('navigator').getBoundingClientRect().bottom)<1),'Strumenti resta ancorato in basso con Database chiuso');
    assert(await page.locator('#sidebar').evaluate(el=>Math.abs(el.getBoundingClientRect().bottom-document.getElementById('navigator-tools').getBoundingClientRect().top)<1),'Database collassato resta sopra Strumenti');
    assert.deepEqual(await page.locator('.tab-body > main').boundingBox(),main,'Chiudere le sezioni non ridimensiona il documento');
    await page.locator('#explorer-toggle-btn').click();
    assert(await tree.evaluate(el=>el.isConnected),'Riaprire una sezione conserva l’albero montato');
    const divider=page.locator('#navigator-divider'),height=(await page.locator('#conn-sidebar').boundingBox()).height;
    await divider.press('ArrowDown');
    assert(Math.abs((await page.locator('#conn-sidebar').boundingBox()).height-height-16)<2,'Le sezioni si ridimensionano anche da tastiera');
    await page.locator('#conn-settings-btn').click();
    assert(await page.getByRole('menuitem',{name:'Importa connessioni',exact:true}).isVisible());
    await page.keyboard.press('Escape');
    await page.screenshot({path:`${root}/navigatore-desktop.png`});
    await page.setViewportSize({width:390,height:844});
    await page.locator('#documents-open').click();
    await page.locator('.arc-navigation-sheet[role="dialog"]:has(#documents-panel)').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.activeElement===document.getElementById('documents-open'),{},{timeout:2000});
    assert(await page.locator('#documents-open').evaluate(el=>el===document.activeElement),'Schede resta utilizzabile su mobile e recupera il focus');
    await page.locator('#mobile-nav-dbs').click();
    await page.locator('#db-tree').waitFor({state:'visible'});
    await page.locator('#db-tree > .db > .node-actions').first().click();
    assert(await page.locator('#context-menu [role="menuitem"]').evaluateAll(items=>items.every(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})),'Le azioni del database sono raggiungibili anche nel foglio ridotto');
    await page.keyboard.press('Escape');
    await page.locator('.arc-navigation-sheet [data-grabber]').press('Home');
    await page.waitForFunction(()=>document.querySelector('.arc-navigation-sheet').getBoundingClientRect().top<100);
    assert(await tree.evaluate(el=>el===document.getElementById('db-tree')),'Il Bottom Sheet conserva lo stesso albero');
    await page.locator('#db-search').fill('prodotti');
    assert(await page.locator('#db-tree .node-label[data-coll="prodotti"]').isVisible());
    await page.keyboard.press('Escape');
    await page.locator('.arc-navigation-sheet').waitFor({state:'detached'});
    assert(await page.locator('#mobile-nav-dbs').evaluate(el=>el===document.activeElement),'Escape restituisce il focus al comando Database');
    await page.locator('#mobile-nav-dbs').click();
    await page.locator('#db-search').waitFor({state:'visible'});
    assert.equal(await page.locator('#db-search').inputValue(),'prodotti','La ricerca sopravvive alla chiusura');
    await page.locator('#db-search').fill('');
    await page.locator('.arc-navigation-sheet [data-grabber]').press('Home');
    await page.waitForFunction(()=>document.querySelector('.arc-navigation-sheet').getBoundingClientRect().top<100);
    await page.screenshot({path:`${root}/navigatore-mobile.png`});
    await page.locator('#db-tree > .db > .node-actions').first().click();
    await page.keyboard.press('Escape');
    assert(await page.locator('.arc-navigation-sheet').isVisible(),'Escape chiude prima il menu annidato');
    await page.locator('#conn-settings-btn').click();
    assert(await page.getByRole('menuitem',{name:'Esporta connessioni',exact:true}).isVisible());
    await page.getByRole('menuitem',{name:'Tema',exact:true}).click();
    await page.locator('#modal-theme').waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    assert(await page.locator('.arc-navigation-sheet').isVisible(),'La finestra Strumenti si chiude senza perdere la navigazione');
    await page.waitForFunction(()=>document.querySelector('.arc-navigation-sheet')?.contains(document.activeElement),{},{timeout:2000});
    assert(await page.locator('.arc-navigation-sheet').evaluate(el=>el.contains(document.activeElement)),'Il focus torna al pannello di navigazione');
    const databases=await page.evaluate(async()=>{
      const {state}=await import('/js/state.js');const original=state.databases;
      (await import('/js/dbtree.js')).renderDbTree([...original,...Array.from({length:80},(_,i)=>({name:`Archivio di prova ${i}`}))]);
      document.getElementById('db-tree').scrollTop=240;
      return original;
    });
    const treeScroll=await page.locator('#db-tree').evaluate(el=>el.scrollTop);
    assert(treeScroll>100,'La fixture presenta un albero realmente scorrevole');
    await page.locator('.arc-navigation-sheet').getByRole('button',{name:'Chiudi',exact:true}).click();
    await page.locator('.arc-navigation-sheet').waitFor({state:'detached'});
    await page.locator('#mobile-nav-dbs').click();await page.locator('#db-tree').waitFor({state:'visible'});
    assert.equal(await page.locator('#db-tree').evaluate(el=>el.scrollTop),treeScroll,'Chiudere e riaprire il foglio conserva la posizione nell’albero');
    await page.setViewportSize({width:1440,height:900});
    assert.equal(await page.locator('#db-tree').evaluate(el=>el.scrollTop),treeScroll,'Il ritorno desktop conserva lo scroll');
    await page.evaluate(async databases=>(await import('/js/dbtree.js')).renderDbTree(databases),databases);
    await page.setViewportSize({width:390,height:844});await page.locator('#mobile-nav-dbs').click();
    await page.getByRole('button',{name:'Chiudi',exact:true}).click();
    await page.locator('.arc-navigation-sheet').waitFor({state:'detached'});
    await page.locator('#mobile-nav-conns').click();
    await page.locator('#conn-search').waitFor({state:'visible'});
    await page.locator('.arc-navigation-sheet [data-grabber]').press('Home');
    assert(await page.locator('#conn-sidebar').evaluate(el=>Math.abs(el.getBoundingClientRect().width-el.closest('.arc-navigation-slot').getBoundingClientRect().width)<2),'Le connessioni occupano tutta la larghezza del BottomSheet, senza ereditare il resize desktop');
    await page.screenshot({path:`${root}/connessioni-mobile.png`});
    await page.locator('#conn-settings-btn').click();
    await page.getByRole('menuitem',{name:'Tema',exact:true}).click();
    await page.locator('#modal-theme').waitFor({state:'visible'});
    await page.setViewportSize({width:1440,height:900});
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.arc-navigation-sheet').count(),0);
    assert(await page.locator('#conn-tree').evaluate(el=>!!el.closest('#navigator')),'Il ritorno desktop ripristina gli stessi nodi');
    await page.locator('#db-tree > .db > .node-actions').first().click();
    assert(await page.locator('#context-menu').isVisible(),'Il menu resta collegato dopo chiusura della modale e cambio viewport');
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:390,height:844});
    await page.locator('#mobile-nav-dbs').click();
    await page.keyboard.press('Escape');
    await page.locator('.arc-navigation-sheet').waitFor({state:'detached'});
    for(const theme of ['light','dark'])for(const [width,height] of [[360,800],[390,844],[430,932],[768,1024],[320,800],[844,390]]){
      await page.setViewportSize({width,height});
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      await page.locator('#mobile-nav-conns').click();
      await page.locator('#conn-search').waitFor({state:'visible'});
      await page.locator('.arc-navigation-sheet [data-grabber]').press('Home');
      await page.waitForFunction(()=>document.querySelector('.arc-navigation-sheet').getBoundingClientRect().top<100);
      assert(await page.locator('#conn-sidebar').evaluate(el=>Math.abs(el.getBoundingClientRect().width-el.closest('.arc-navigation-slot').getBoundingClientRect().width)<2),`Connessioni a larghezza piena ${width}×${height}`);
      assert(await page.locator('#conn-settings-btn').evaluate(el=>{const r=el.getBoundingClientRect();return r.bottom<=innerHeight&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),`Strumenti raggiungibile ${width}×${height}`);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:`${root}/sheet-${theme}-${width}.png`});
      await page.locator('.arc-navigation-sheet').getByRole('button',{name:'Chiudi',exact:true}).click();
      await page.locator('.arc-navigation-sheet').waitFor({state:'detached'});
    }
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#menu-conns-btn').click();
    await page.reload();
    await page.waitForSelector('html[data-arc-ready="true"]');
    assert.equal(await page.locator('#menu-conns-btn').getAttribute('aria-expanded'),'false','La chiusura del drawer sopravvive al ricaricamento');
    await page.locator('#menu-conns-btn').click();
    await page.locator('#conn-search').waitFor({state:'visible'});
    assert(await page.locator('#conn-search').isVisible(),'Dopo il ricaricamento Connessioni resta espansa');
    assert.deepEqual(errors,[],'Nessun errore runtime nei flussi del navigatore');
    console.log('OK: ripresa della connessione, anteprima esplicita, conservazione della bozza e comandi del navigatore');
  } finally { await browser.close(); await server.stop(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
