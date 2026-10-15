'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {_electron}=require('playwright');
const {verifica}=require('./e2e-mongosh-advanced.cjs');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'.scratch','mongosh-electron-package');
const dir=path.join(root,'.scratch','mongosh-electron-installed');
const profile=path.join(root,'.scratch','mongosh-electron-profile');
const installer=path.join(output,`CodeDBMongoshTest-${require('../package.json').version}-setup.exe`);
const executablePath=path.join(dir,'CodeDBMongoshTest.exe');
let app,installed=false;
(async()=>{
  assert(dir.startsWith(path.join(root,'.scratch')+path.sep));
  assert(!fs.existsSync(dir),'La cartella di installazione della prova deve essere vuota');
  fs.mkdirSync(profile,{recursive:true});
  fs.writeFileSync(path.join(profile,'connections.ini'),'');
  execFileSync(installer,['/S',`/D=${dir}`],{windowsHide:true,timeout:180000});
  installed=true; assert(fs.existsSync(executablePath));
  console.log('OK installazione NSIS reale con identità e cartella dedicate');
  const env={...process.env,PORT:'3197',HOST:'127.0.0.1',CODEDB_RBAC:'off',GUI_MONGO_PASSPHRASE:'',
    CODEDB_ELECTRON_USER_DATA_DIR:profile,CODEDB_CONNECTIONS_FILE:path.join(profile,'connections.ini'),
    CODEDB_CONNECTIONS_DIR:path.join(profile,'conns'),CODEDB_UI_AUDIT_FILE:path.join(profile,'ui-audit.log'),
    CODEDB_MCP_AUDIT_FILE:path.join(profile,'mcp-audit.log'),CODEDB_BACKUPS_DIR:path.join(profile,'backups'),
    CODEDB_MONGOSH_MONGOCRYPTD_URI:'mongodb://127.0.0.1:27065'};
  delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath,env,timeout:90000});
  app.process().stderr.on('data',data=>process.stderr.write(data));
  const page=await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  const info=await app.evaluate(({app})=>({packaged:app.isPackaged,path:app.getAppPath(),profile:app.getPath('userData'),versions:process.versions}));
  assert.equal(info.packaged,true); assert.equal(info.profile,profile); assert(info.path.endsWith('app.asar'));
  console.log('OK Electron installato',info.versions.electron,'Node incorporato',info.versions.node);
  assert.equal(new URL(page.url()).port,'3197');
  await page.locator('#app, body').first().waitFor();
  await verifica('http://127.0.0.1:3197');
  await page.screenshot({path:path.join(output,'app-installata.png')});
  await app.close();app=null;
  console.log('OK runtime, moduli nativi e test DB reali dall’app installata in ASAR');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  await app?.close().catch(()=>{});
  if(installed) {
    const uninstaller=path.join(dir,'Uninstall CodeDBMongoshTest.exe');
    execFileSync(uninstaller,['/S',`_?=${dir}`],{windowsHide:true,timeout:120000});
    assert(!fs.existsSync(executablePath),'La disinstallazione deve rimuovere l’eseguibile');
    assert(fs.existsSync(path.join(profile,'connections.ini')),'La disinstallazione deve conservare i dati del profilo');
    assert(fs.realpathSync(dir).startsWith(path.join(root,'.scratch')+path.sep));
    fs.rmSync(dir,{recursive:true,force:true});
    console.log('OK disinstallazione NSIS e conservazione del profilo');
  }
});
