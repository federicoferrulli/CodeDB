'use strict';
// Shell Electron e WebView Android reali; dati di lavoro sintetici e profili isolati.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _android, _electron } = require('playwright');
const root = path.resolve(__dirname,'..');
const dir = path.resolve(process.env.CODEDB_REPORT_ROOT || 'test-reports/revisione-2026-10-09','contenitori');
fs.mkdirSync(dir,{recursive:true});
const report = {checks:[],errors:[],environments:[]};

async function setup(page) {
  await page.waitForSelector('html[data-arc-ready="true"]',{timeout:120000});
  await page.waitForFunction(()=>document.querySelector('#documents-panel'));
  if(await page.evaluate(()=>!JSON.parse(localStorage.getItem('codedb:onboarding')||'{}').visto))await page.locator('#onboarding-close').waitFor({state:'visible'});
  if(await page.locator('#onboarding-close').isVisible())await page.locator('#onboarding-close').click();
  if(await page.getByRole('button',{name:'Nascondi i primi passi'}).isVisible())await page.getByRole('button',{name:'Nascondi i primi passi'}).click();
  await page.evaluate(async()=>{window.nativeModules=await Promise.all(['tabs','socket','tabbar','workspace','colltabs','main','query-tab'].map(name=>import(`/js/${name}.js`)));});
  await page.evaluate(()=>{
    const [{createTab,tabs},{impostaSocket},bar,workspace,colltabs,main,query]=window.nativeModules;
    const docs=[{id:1,nome:'Dato della fixture',preciso:{$numberLong:'9007199254740993'}}];
    const fake={on(){},off(){},connected:true,timeout(){return{emit:(name,payload,cb)=>fake.emit(name,payload,r=>cb(null,r))};},emit(name,payload,cb){cb?.({ok:true,docs,columns:['id','nome','preciso'],total:1,collections:[{name:'ordini'}],fields:[],indexes:[]});}};
    impostaSocket(fake);const t=createTab({id:'contenitore'});tabs.activeId=t.id;t.label='Connessione di prova';t.dbType='mongodb';Object.assign(t.state,{connected:true,dbType:'mongodb',connLabel:t.label,databases:[{name:'fixture',collections:[{name:'ordini'}]}]});
    bar.renderTabBar();workspace.renderWorkspace();colltabs.openCollTab('fixture','ordini');main.setView('query');query.renderResults(docs);
  });
  await page.locator('#query-editor-input').fill('SELECT nome, preciso FROM ordini');
}

async function electron() {
  const profile=fs.mkdtempSync(path.join(dir,'profilo-'));
  const entry=path.join(profile,'avvio.cjs');
  fs.writeFileSync(path.join(profile,'connections.ini'),'');
  fs.writeFileSync(entry,`const {app}=require('electron');\napp.setPath('userData',${JSON.stringify(profile)});\nrequire(${JSON.stringify(path.join(root,'electron-main.js'))});\n`);
  const env={...process.env,PORT:'3184',HOST:'127.0.0.1',CODEDB_RBAC:'off',GUI_MONGO_PASSPHRASE:'',CODEDB_CONNECTIONS_FILE:path.join(profile,'connections.ini'),CODEDB_CONNECTIONS_DIR:path.join(profile,'conns'),CODEDB_BACKUPS_DIR:path.join(profile,'backups'),CODEDB_UI_AUDIT_FILE:path.join(profile,'ui.log'),CODEDB_MCP_AUDIT_FILE:path.join(profile,'mcp.log')};
  delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({args:[entry,'--headless'],env,timeout:120000});
  try{
    const page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',dialog=>dialog.accept().catch(()=>{}));await setup(page);
    report.environments.push(await app.evaluate(()=>({electron:process.versions.electron,chromium:process.versions.chrome,node:process.versions.node})));
    if(process.argv.includes('--mutant-drawers'))await page.addStyleTag({content:'@media(max-width:900px){#navigator > #conn-sidebar{visibility:visible;position:fixed;left:-245px;width:300px;height:100%;z-index:1000;}}'});
    if(process.argv.includes('--mutant'))await page.evaluate(()=>window.addEventListener('resize',()=>{document.getElementById('query-editor-input').value='';}));
    for(const zoom of [1,2]){
      await app.evaluate(({BrowserWindow},zoom)=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1440,900);w.webContents.setZoomFactor(zoom);},zoom);
      await page.waitForTimeout(150);
      const bounds=await page.evaluate(()=>({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1}));
      assert(!bounds.overflow);assert.equal(bounds.width,1440/zoom);
      if(zoom===2)for(const id of ['conn-sidebar','sidebar','query-schema-sidebar'])assert.equal(await page.locator(`#${id}`).isVisible(),false,`Il pannello chiuso ${id} non copre il lavoro dopo il cambio di viewport`);
      const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(dir,`electron-zoom-${zoom}.png`),Buffer.from(png,'base64'));
    }
    await page.locator('#documents-open').click();await page.locator('.arc-navigation-sheet[role="dialog"]:has(#documents-panel)').waitFor();await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.activeElement===document.getElementById('documents-open'));
    assert(await page.locator('#documents-open').evaluate(el=>document.activeElement===el));
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    const saved=path.join(dir,'query-electron.sql');
    await app.evaluate(({BrowserWindow},saved)=>{
      globalThis.__downloadFixture=null;
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download',(_,item)=>{
        item.setSavePath(saved);item.once('done',(_,state)=>globalThis.__downloadFixture=state);
      });
    },saved);
    await page.locator('#query-editor-input').focus();await page.keyboard.press('Control+s');
    for(let i=0;i<40;i++){if(await app.evaluate(()=>globalThis.__downloadFixture==='completed'))break;await page.waitForTimeout(250);}
    assert.equal(await app.evaluate(()=>globalThis.__downloadFixture),'completed','Salvataggio gestito dalla sessione nativa Electron');
    assert.equal(fs.readFileSync(saved,'utf8'),'SELECT nome, preciso FROM ordini');
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);
    report.checks.push('Electron: server incorporato e profilo isolato, ridimensionamento, zoom nativo 100/200%, dialog/focus e salvataggio SQL esatto');
  }finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
}

async function android() {
  const adb=path.join(root,'android/.cache/sdk/platform-tools/adb.exe');
  const run=(...args)=>execFileSync(adb,['-s','emulator-5580',...args],{encoding:'utf8'}).trim();
  assert(run('shell','getprop','ro.kernel.qemu')==='1','Solo emulatore dedicato, mai dispositivo personale');
  run('install','-r',path.join(root,'android/app/build/outputs/apk/debug/app-debug.apk'));
  run('shell','am','force-stop','com.codedb.android.debug');
  run('shell','am','start','-n','com.codedb.android.debug/com.codedb.android.MainActivity');
  let device;
  try{
    device=(await _android.devices({omitDriverInstall:true})).find(d=>d.serial()==='emulator-5580');
    assert(device,'Emulatore dedicato disponibile');
    const webview=await device.webView({pkg:'com.codedb.android.debug'},{timeout:120000});
    const page=await webview.page();
    page.on('pageerror',e=>report.errors.push(e.message));await setup(page);
    report.environments.push({android:run('shell','getprop','ro.build.version.release'),device:'emulator-5580',webview:await page.evaluate(()=>navigator.userAgent)});
    await page.locator('#query-show-editor').click();
    await page.screenshot({path:path.join(dir,'android-editor.png')});
    const before=await page.evaluate(()=>visualViewport.height);
    run('shell','settings','put','secure','show_ime_with_hard_keyboard','1');
    await page.locator('#mobile-nav-dbs').click();await page.locator('#db-search').click();
    await page.waitForFunction(before=>visualViewport.height<before-100,before,{timeout:15000});
    await page.locator('#db-search').fill('ordi');
    assert(await page.locator('#db-search').evaluate(el=>{const r=el.getBoundingClientRect();return r.bottom<=visualViewport.height+visualViewport.offsetTop&&r.top>=visualViewport.offsetTop;}),'Ricerca del BottomSheet visibile sopra la tastiera reale');
    assert(await page.locator('#conn-settings-btn').evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'Strumenti raggiungibile con tastiera Android');
    await page.screenshot({path:path.join(dir,'android-sheet-tastiera.png')});
    fs.writeFileSync(path.join(dir,'android-sheet-ime-dispositivo.png'),execFileSync(adb,['-s','emulator-5580','exec-out','screencap','-p']));
    run('shell','input','keyevent','4');await page.waitForFunction(before=>visualViewport.height>=before-10,before);
    await page.locator('.arc-navigation-sheet').getByRole('button',{name:'Chiudi',exact:true}).click();
    await page.locator('#query-editor-input').click();
    await page.waitForFunction(before=>visualViewport.height<before-100,before,{timeout:15000});
    const ime=run('shell','dumpsys','input_method');fs.writeFileSync(path.join(dir,'android-ime.txt'),ime);
    assert(/mInputShown=true|isInputViewShown=true|mIsInputViewShown=true/.test(ime),'Tastiera di sistema effettivamente visibile');
    assert(await page.locator('#query-editor-input').evaluate(el=>el===document.activeElement&&el.getBoundingClientRect().bottom<=visualViewport.height+visualViewport.offsetTop+1));
    await page.screenshot({path:path.join(dir,'android-tastiera.png')});
    fs.writeFileSync(path.join(dir,'android-editor-ime-dispositivo.png'),execFileSync(adb,['-s','emulator-5580','exec-out','screencap','-p']));
    run('shell','input','keyevent','4');
    await page.waitForFunction(before=>visualViewport.height>=before-10,before);
    assert.equal(await page.locator('#query-editor-input').inputValue(),'SELECT nome, preciso FROM ordini');
    run('shell','settings','put','system','accelerometer_rotation','0');run('shell','settings','put','system','user_rotation','1');
    await page.waitForFunction(()=>innerWidth>innerHeight);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(dir,'android-landscape.png')});
    report.checks.push('Android 15 x86_64: APK aggiornato, WebView e Node Mobile reali; ricerca e Strumenti nel BottomSheet con IME, editor e codice conservati, chiusura tastiera e rotazione landscape');
  }finally{run('shell','settings','put','system','user_rotation','0');if(device)await device.close();}
}

(async()=>{
  try{if(!process.argv.includes('--android-only'))await electron();if(!process.argv.includes('--electron-only'))await android();assert.deepEqual(report.errors,[]);console.log(report.checks.join('\n'));}
  catch(e){report.failure=e.stack;throw e;}
  finally{fs.writeFileSync(path.join(dir,`report${process.argv.includes('--android-only')?'-android':process.argv.includes('--electron-only')?'-electron':''}.json`),JSON.stringify(report,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1;});
