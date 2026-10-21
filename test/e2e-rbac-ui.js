'use strict';
// Login e gestione utenti reali, sul control plane posseduto dall'harness.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { BASE,OWNER,startRbacServer,stopRbacServer,cleanupMongo,seedData }=require('./rbac-harness');
const dir=`${process.env.CODEDB_REPORT_ROOT||'test-reports/revisione-2026-10-09'}/rbac-ui`;
fs.mkdirSync(dir,{recursive:true});
const report={checks:[],errors:[],environment:'Chromium + backend RBAC + MongoDB reale isolato'};
(async()=>{
  let server,browser;
  try{
    await cleanupMongo();await seedData();server=await startRbacServer({maxSubUsers:2});
    browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    if(process.argv.includes('--mutant'))await page.route('**/js/admin-rbac.js',async route=>{const response=await route.fetch(),code=await response.text();assert(code.includes('status: btn.dataset.status'));await route.fulfill({response,body:code.replace('status: btn.dataset.status',"status: 'active'")});});
    page.on('pageerror',e=>report.errors.push(e.message));await page.goto(BASE);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.locator('#login-email').fill(OWNER.email);await page.locator('#login-password').fill('password-sbagliata');
    await page.locator('#login-submit').click();await page.locator('#login-error:not(.hidden)').waitFor();
    for(const width of [1440,390]){await page.setViewportSize({width,height:900});await page.screenshot({path:`${dir}/login-errore-${width}.png`});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
    await page.locator('#login-password').fill(OWNER.password);await page.locator('#login-submit').click();await page.locator('#login-overlay').waitFor({state:'hidden'});
    // L'ultimo screenshot lascia la viewport mobile: Arc sostituisce la X
    // desktop della guida con il comando accessibile del BottomSheet.
    await page.locator('#onboarding-overlay').getByRole('button',{name:'Chiudi finestra',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('onboarding-overlay').classList.contains('hidden')&&!document.getElementById('onboarding-overlay').dataset.arcDialog);
    if(await page.getByRole('button',{name:'Nascondi i primi passi'}).isVisible())await page.getByRole('button',{name:'Nascondi i primi passi'}).click();
    await page.locator('#btn-admin-rbac').evaluate(el=>el.click());await page.locator('#subuser-email').fill('fixture-ui@esempio.test');
    await page.locator('#subuser-name').fill('Operatore della fixture');await page.locator('#subuser-password').fill('Password-fixture-123');
    await page.locator('#subuser-form button[type="submit"]').click();await page.locator('#subuser-list tr').filter({hasText:'fixture-ui@esempio.test'}).waitFor();
    await page.locator('[data-action="toggle-user"]').click();await page.locator('#subuser-list').getByText('Sospeso',{exact:true}).waitFor();
    for(const width of [1440,390]){await page.setViewportSize({width,height:900});await page.screenshot({path:`${dir}/utente-reale-${width}.png`});}
    await page.locator('[data-action="toggle-user"]').click();await page.locator('#subuser-list').getByText('Attivo',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    report.checks.push('Login errato recuperabile e login owner reale a 390/1440; creazione, sospensione e riattivazione sottoutente dalla UI su control plane MongoDB');
    assert.deepEqual(report.errors,[]);console.log('OK login e amministrazione RBAC reali');
  }catch(e){report.failure=e.stack;throw e;}
  finally{await browser?.close();await stopRbacServer(server);await cleanupMongo();fs.writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1;});
