'use strict';
// Controller e componenti reali, risposte amministrative sintetiche e nessuna scrittura esterna.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant') ? 'progresso' : process.argv.find(x=>x.startsWith('--mutant='))?.split('=')[1];
const dir = `${process.env.CODEDB_REPORT_ROOT || 'test-reports/revisione-2026-10-09'}/superfici${mutant ? `-${mutant}` : ''}`;
fs.mkdirSync(dir, { recursive:true });
const report = { environment:'Chromium; UI reale, trasporto simulato', checks:[], surfaces:[], errors:[], requests:[] };
(async () => {
  const server = await startTestServer({port:3183});
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('response',r=>{if(r.url().startsWith(server.url)&&r.status()>=400)report.requests.push(`${r.status()} ${r.url()}`);});
  try {
    if(mutant) await page.route(`**/js/${mutant==='sessione'?'sessions':'backupmanager'}.js`,async route=>{
      const response=await route.fetch(),code=await response.text();
      const [from,to]=mutant==='sessione'?[".value = s.query;",".value = s.query.slice(0,140);"]
        :mutant==='concorrenza'?['ripristini.get(ev.operationId)','[...ripristini.values()].at(-1)']
        :['ev.tabId !== progresso.tabId','ev.tabId !== activeTab()?.id'];
      assert(code.includes(from));await route.fulfill({response,body:code.replace(from,to)});
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.waitForFunction(()=>document.querySelector('#documents-panel'));
    if(await page.locator('#onboarding-close').isVisible())await page.locator('#onboarding-close').click();
    if(await page.getByRole('button',{name:'Nascondi i primi passi'}).isVisible())await page.getByRole('button',{name:'Nascondi i primi passi'}).click();
    await page.evaluate(async()=>{
      window.surfModules=await Promise.all(['tabs','socket','tabbar','workspace'].map(name=>import(`/js/${name}.js`)));
    });
    await page.evaluate(()=>{
      const [{createTab,tabs},{socketReale,impostaSocket},tabbar,workspace]=window.surfModules;
      const real=socketReale();
      const users=[{id:'lettore',email:'lettore.delle.analisi@esempio.test',displayName:'Analisi contabile',status:'active',createdAt:'2026-10-09T12:34:56Z'}];
      const connections=[{name:'Collaudo',dbType:'postgresql',status:'ok',latencyMs:12,pool:{active:2,limit:8,idle:6}}, {name:'Archivio non raggiungibile',dbType:'mysql',status:'error',error:'Connessione rifiutata: controllare host e porta.'}];
      const groups={Collaudo:[{id:'20261009-full',type:'full',db:'contabilita',dbType:'postgresql',startedAt:'2026-10-09T10:00:00Z'}]};
      window.surf={sent:[],pending:{},fail:null,push:(event,value)=>real.listeners(event).forEach(fn=>fn(value))};
      const fake={connected:true,on(){},off(){},timeout(){return {emit:(name,payload,cb)=>fake.emit(name,payload,r=>cb(null,r))};},emit(name,payload,cb){
        window.surf.sent.push({name,payload});
        if(['backup:run','backup:restore'].includes(name)){window.surf.pending[name]=cb;return;}
        if(window.surf.fail===name)return cb?.({ok:false,error:'Permessi insufficienti per questa operazione.'});
        const responses={
          'auth:me':{user:{rbac:true,capabilities:['manage','read']}},
          'users:list':{users,limits:{maxSubUsers:10}}, 'roles:list':{roles:[{name:'viewer',capabilities:['read']}]},
          'connections:list':{connections},'health:connections':{connections},
          'grants:list':{grants:[{subjectId:'lettore',connName:'Collaudo',role:'viewer',scope:{databases:['contabilita'],collections:['ordini_*']}}]},
          'apikeys:list':{keys:[{id:'chiave',label:'Client MCP di collaudo',subjectId:'lettore',prefix:'cdb_fixture',connScope:['Collaudo']}]},
          'backup:list':{groups},'backup:verify':{valid:false,failedCount:1,details:[{file:'ordini.ndjson.gz',status:'checksum diverso'}]},
          'vault:status':{formato:2,protetto:true,locked:false},
          'audit:list':{total:1,offset:0,entries:[{event:'doc:update',category:'write',status:'error',ts:'2026-10-09T12:34:56.789Z',connection:'Collaudo',db:'contabilita',coll:'ordini',error:'Vincolo UNIQUE: valore già esistente.'}]},
          'db:sessions':{sessioni:[{id:'71',utente:'analista',host:'fixture',db:'contabilita',stato:'inattiva',transazioneAperta:true,bloccaAltre:1,query:'UPDATE ordini SET stato = $1 /* '+ 'contesto completo '.repeat(30)+'*/',blocchi:{}},{id:'72',utente:'lettore',db:'contabilita',stato:'in attesa',bloccataDa:['71'],query:'SELECT * FROM ordini',blocchi:{connessione:'Permesso richiesto'}}],capacita:{saBloccanti:true},diagnosi:{livello:'attenzione',titolo:'La sessione 71 blocca una lettura',dettaglio:'Transazione aperta: verificare prima di terminarla.'}},
        };
        cb?.({ok:true,databases:[{name:'contabilita'}],collections:[],...responses[name]});
      }};
      impostaSocket(fake);
      for(const id of ['a','b']){const t=createTab({id});t.label=id==='a'?'Collaudo':'Archivio';t.dbType='postgresql';Object.assign(t.state,{connected:true,connLabel:t.label,dbType:'postgresql',databases:[{name:'contabilita'}]});}
      tabs.activeId='a';tabbar.renderTabBar();workspace.renderWorkspace();
    });
    const open=async id=>page.locator(id).evaluate(el=>el.click());
    const snap=async(name,overlay)=>{
      for(const theme of ['dark','light'])for(const width of [1440,390]){
        await page.setViewportSize({width,height:900});
        await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
        await page.locator(`${overlay}[data-arc-dialog="open"]`).waitFor();
        const box=await page.locator(`${overlay} .modal`).boundingBox();
        assert(box&&box.x>=-1&&box.x+box.width<=width+1&&box.y>=-1&&box.y+box.height<=901,`${name}: finestra nel viewport ${width}`);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name}: shell senza overflow`);
        await page.screenshot({path:`${dir}/${name}-${theme}-${width}.png`});
        report.surfaces.push({name,theme,width});
      }
      await page.setViewportSize({width:1440,height:900});
    };
    for(const [trigger,overlay,ready,name] of [
      ['#btn-admin-rbac','#modal-admin-rbac','#subuser-list tbody tr','utenti'],
      ['#btn-audit-log','#modal-audit-log','#audit-log-list tbody tr','audit'],
      ['#btn-health','#modal-health','#health-list tbody tr','salute'],
      ['#btn-sessions','#modal-sessions','#sessions-list tbody tr','sessioni'],
      ['#btn-change-passphrase','#passphrase-overlay','#passphrase-current','vault'],
    ]){
      await open(trigger);await page.locator(ready).first().waitFor();await snap(name,overlay);
      if(name==='utenti')for(const pane of ['grants','apikeys']){await page.locator(`.admin-tab[data-pane="${pane}"]`).click();await snap(pane,overlay);}
      if(name==='sessioni'){
        await page.setViewportSize({width:390,height:900});await page.locator('[data-session-query="71"]').click();
        assert.equal(await page.locator('#session-query-text').inputValue(),'UPDATE ordini SET stato = $1 /* '+'contesto completo '.repeat(30)+'*/','Il monitor rende leggibile e copiabile la query completa');
        await snap('sessione-query', '#session-query-overlay');await page.keyboard.press('Escape');
        assert(await page.locator('#modal-sessions').isVisible(),'Escape chiude soltanto il dettaglio annidato');
      }
      await page.keyboard.press('Escape');await page.locator(overlay).waitFor({state:'hidden'});
    }
    report.checks.push('Utenti, permessi, MCP, audit errore, salute disconnessa, sessioni bloccanti e vault: finestre popolate nei due temi e due viewport');
    await page.evaluate(()=>window.surf.fail='audit:list');await open('#btn-audit-log');
    await page.getByText('Errore nel caricamento dello storico: Permessi insufficienti per questa operazione.').waitFor();
    await snap('audit-permessi','#modal-audit-log');await page.keyboard.press('Escape');
    await page.evaluate(()=>window.surf.fail=null);
    await open('#btn-backup-manager');await snap('backup','#modal-backup-manager');
    await page.locator('#btn-submit-backup').click();
    await page.waitForFunction(()=>window.surf.pending['backup:run']);
    await page.locator('#btn-close-backup-modal').click();
    await page.evaluate(async()=>{(await import('/js/tabs.js')).switchTab('b');(await import('/js/workspace.js')).renderWorkspace();});
    await open('#btn-backup-manager');
    assert((await page.locator('#backup-status-msg').textContent()).includes('Collaudo / contabilita'));
    await page.evaluate(()=>window.surf.pending['backup:run']({ok:true,summary:{id:'fixture',totalDocs:10,totalBytes:1024}}));
    await page.getByText('Backup completato di Collaudo / contabilita:',{exact:false}).waitFor();
    report.checks.push('Backup A resta identificato dopo chiusura, cambio connessione B e riapertura');
    await page.locator('#tab-btn-backup-catalog').click();await page.locator('.btn-verify-backup').click();
    await page.getByText('Verifica FALLITA:',{exact:false}).waitFor();await snap('catalogo-errore','#modal-backup-manager');
    await page.locator('.btn-restore-backup').click();await snap('ripristino-conferma','#restore-overlay');
    assert((await page.locator('#restore-conn').textContent()).includes('Archivio'));
    await page.locator('#restore-target-db').fill('ripristino_fixture');await page.locator('#restore-ok').click();
    await page.waitForFunction(()=>window.surf.pending['backup:restore']);
    await page.locator('#btn-close-backup-modal').click();
    await page.evaluate(async()=>{
      (await import('/js/tabs.js')).switchTab('a');(await import('/js/workspace.js')).renderWorkspace();
      window.surf.restoreB=window.surf.pending['backup:restore'];
      window.surf.operationB=window.surf.sent.findLast(r=>r.name==='backup:restore').payload.operationId;
      window.surf.push('backup:progress',{tabId:'b',operationId:window.surf.operationB,riga:'Fixture: 10 righe ripristinate'});
    });
    await open('#btn-backup-manager');
    assert((await page.locator('#restore-progress').textContent()).includes('10 righe ripristinate'),'Il progresso resta associato al ripristino B quando il focus è su A');
    await page.locator('.btn-restore-backup').click();await page.locator('#restore-target-db').fill('secondo_ripristino');await page.locator('#restore-ok').click();
    await page.evaluate(()=>{
      const operationId=window.surf.sent.findLast(r=>r.name==='backup:restore').payload.operationId;
      window.surf.push('backup:progress',{tabId:'a',operationId,riga:'Progresso secondo ripristino'});
      window.surf.push('backup:progress',{tabId:'b',operationId:window.surf.operationB,riga:'Progresso primo ripristino concorrente'});
    });
    const first=page.locator('.restore-progress').filter({hasText:'Archivio / ripristino_fixture'});
    const second=page.locator('.restore-progress').filter({hasText:'Collaudo / secondo_ripristino'});
    assert((await first.textContent()).includes('primo ripristino concorrente')&&!(await second.textContent()).includes('primo ripristino concorrente'),'I ripristini concorrenti conservano log distinti');
    await page.evaluate(()=>window.surf.restoreB({ok:true,summary:{status:'completato',targetDb:'ripristino_fixture',totalDocs:10,layers:1}}));
    assert((await second.textContent()).includes('in corso'),'Il primo esito non completa il secondo ripristino');
    await page.evaluate(()=>window.surf.pending['backup:restore']({ok:true,summary:{status:'completato',targetDb:'secondo_ripristino',totalDocs:3,layers:1}}));
    await snap('ripristino-esito','#modal-backup-manager');
    report.checks.push('Ripristino: destinatario esplicito, dialog annidato, avanzamento dopo cambio connessione e riapertura, esito persistente');
    assert.deepEqual(report.errors,[]);assert.deepEqual(report.requests,[]);
    console.log(`OK ${report.surfaces.length} superfici/tema/viewport, ${report.checks.length} flussi`);
  }catch(e){report.failure=e.stack;await page.screenshot({path:`${dir}/failure.png`}).catch(()=>{});throw e;}
  finally{fs.writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.stop();}
})().catch(e=>{console.error(e);process.exitCode=1;});
