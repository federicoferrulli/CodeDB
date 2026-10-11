'use strict';
// Griglia virtuale vera e trasporto simulato: chiusura, date e bozze senza dati personali.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const dir = `${process.env.CODEDB_REPORT_ROOT || 'test-reports/revisione-2026-10-09'}/uscita-editing${mutant ? '-mutante' : ''}`;
fs.mkdirSync(dir,{recursive:true});
(async()=>{
  const server=await startTestServer({port:3186}),browser=await chromium.launch();
  const report={checks:[],errors:[]};
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    page.on('pageerror',e=>report.errors.push(e.message));
    if(mutant)await page.route('**/js/grid.js',async route=>{const response=await route.fetch(),code=await response.text();assert(code.includes('if (conservaRighe && tbody.querySelector'));await route.fulfill({response,body:code.replace('if (conservaRighe && tbody.querySelector','if (tbody.querySelector')});});
    await page.goto(server.url);await page.waitForSelector('html[data-arc-ready="true"]');
    if(await page.locator('#onboarding-close').isVisible())await page.locator('#onboarding-close').click();
    if(await page.getByRole('button',{name:'Nascondi i primi passi'}).isVisible())await page.getByRole('button',{name:'Nascondi i primi passi'}).click();
    await page.evaluate(async()=>{
      const [{createTab,tabs},{impostaSocket},workspace,colltabs]=await Promise.all(['tabs','socket','workspace','colltabs'].map(x=>import(`/js/${x}.js`)));
      const docs=Array.from({length:1200},(_,i)=>({_id:i,data:{$date:'2023-01-07T18:30:00.123Z'},nome:`Riga ${i}`}));
      window.writes=[];window.docsEditing=docs;
      impostaSocket({on(){},off(){},emit(name,p,cb){if(name==='doc:update'){window.writes.push(p);if(window.failEditing)return cb({ok:false,error:'Errore della fixture'});Object.assign(docs[p.id],p.set);}cb?.({ok:true,docs,columns:['_id','data','nome'],total:1200,limit:2000,skip:0,fields:[],indexes:[],relazioni:[]});}});
      const t=createTab({id:'uscita'});t.dbType='mongodb';t.label='Date di prova';tabs.activeId=t.id;Object.assign(t.state,{connected:true,dbType:'mongodb',limit:2000,databases:[{name:'fixture',collections:[{name:'date'}]}]});
      workspace.renderWorkspace();colltabs.openCollTab('fixture','date');
    });
    const cell=page.locator('#grid td[data-r="0"][data-c="1"]'),editor=page.locator('#grid td.editing');
    const open=async()=>{await cell.dblclick();await editor.locator('.arc-time-input').waitFor();};
    await open();await editor.locator('.arc-time-input').press('Escape');
    assert.equal(await editor.count(),0,'Escape deve uscire dalla modifica della griglia virtuale');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});await open();
      await editor.locator('.arc-time-input').fill('20:21:22.789');
      const before=await page.evaluate(()=>window.writes.length);
      await editor.getByRole('button',{name:'Annulla modifica',exact:true}).click();
      assert.equal(await editor.count(),0,'Annulla chiude senza lasciare celle in modifica');
      assert.equal(await page.evaluate(()=>window.writes.length),before,'Annulla non invia scritture');
      await open();await editor.getByRole('button',{name:'Data UTC',exact:true}).click();
      await page.keyboard.press('Escape');assert.equal(await editor.count(),1,'Il primo Escape chiude solo il calendario');
      await editor.locator('.arc-time-input').fill('20:21:22.789');
      await page.screenshot({path:`${dir}/azioni-${width}.png`});
      await editor.getByRole('button',{name:'Applica modifica',exact:true}).click();
      await editor.waitFor({state:'detached'});
      assert.deepEqual(await page.evaluate(()=>window.writes.at(-1).set.data),{$date:'2023-01-07T20:21:22.789Z'});
      report.checks.push(`Escape, calendario, Applica/Annulla e millisecondi: ${width}px`);
    }
    await open();await editor.locator('.arc-time-input').fill('ora non valida');
    await editor.getByRole('button',{name:'Applica modifica',exact:true}).click();assert.equal(await editor.count(),1);
    await editor.getByRole('button',{name:'Annulla modifica',exact:true}).click();assert.equal(await editor.count(),0);
    await page.evaluate(()=>window.failEditing=true);await open();await editor.locator('.arc-time-input').fill('12:34:56.789');
    await editor.getByRole('button',{name:'Applica modifica',exact:true}).click();await editor.waitFor({state:'detached'});
    await open();assert.equal(await editor.locator('.arc-time-input').inputValue(),'12:34:56.789','Errore server conserva la bozza');
    await editor.getByRole('button',{name:'Annulla modifica',exact:true}).click();assert.equal(await editor.count(),0);
    report.checks.push('Data non valida annullabile; bozza recuperabile dopo errore server');
    await open();await editor.locator('.arc-time-input').fill('ora non valida');
    const draft=await page.evaluate(async()=>[...(await import('/js/state.js')).state.editDrafts]);
    await page.evaluate(async()=>{(await import('/js/main.js')).setView('details');});
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(async()=>[...(await import('/js/state.js')).state.editDrafts]),draft,'Nascondere l’ancora non annulla la bozza');
    await page.evaluate(async()=>{window.failEditing=false;(await import('/js/main.js')).setView('data');});
    if(await editor.count())await editor.getByRole('button',{name:'Annulla modifica',exact:true}).click();
    await page.evaluate(()=>{const container=document.getElementById('grid').parentElement;container.scrollTop=container.scrollHeight;});
    const last=page.locator('#grid td[data-r="1199"][data-c="1"]');
    await last.waitFor();await last.dblclick();
    const cancel=editor.getByRole('button',{name:'Annulla modifica',exact:true});
    if(process.argv.includes('--mutant-bordo'))await editor.locator('.inline-edit-actions').evaluate(el=>{el.hidePopover();el.removeAttribute('popover');el.style.cssText='position:absolute;top:100%;left:0';});
    assert(await cancel.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'Annulla è raggiungibile anche sull’ultima riga');
    await cancel.press('Escape');assert.equal(await editor.count(),0,'Escape funziona anche dai comandi della cella');
    await last.dblclick();await editor.locator('.arc-time-input').fill('10:11:12.345');
    await editor.getByRole('button',{name:'Applica modifica',exact:true}).focus();
    await editor.getByRole('button',{name:'Annulla modifica',exact:true}).focus();
    await page.locator('#menu-conns-btn').focus();
    await editor.waitFor({state:'detached'});
    assert.deepEqual(await page.evaluate(()=>window.writes.at(-1).set.data),{$date:'2023-01-07T10:11:12.345Z'},'Uscire dall’intera cella salva anche dopo il passaggio sui comandi');
    assert.deepEqual(report.errors,[]);console.log('OK uscita editing virtuale, date e bozze');
  }catch(e){report.failure=e.stack;throw e;}finally{fs.writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.stop();}
})().catch(e=>{console.error(e);process.exitCode=1;});
