'use strict';
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
require('./fixtures/mongosh-mutante.cjs');
const { autorizza } = require('../db/mongoshRuntime');
module.exports = (async () => {
  const session = principal => ({strategy:{type:'mongodb'},principal});
  for (const principal of [null, {}, {owner:true,email:'tenant@local'}, {email:'admin@local',grants:[{capabilities:['manage']}] }]) {
    assert.throws(()=>autorizza(session(principal), {CODEDB_VAULT_ADMINS:'admin@local'}), /amministratore dell.installazione/);
  }
  autorizza(session({root:true}), {});
  autorizza(session({owner:true,email:'admin@local'}), {CODEDB_VAULT_ADMINS:'admin@local'});
  assert.throws(()=>autorizza({strategy:{type:'mysql'},principal:{root:true}}), /connessione MongoDB/);
  const { suggerisci } = await import(pathToFileURL(path.join(__dirname,'../public/js/intellisense.js')));
  for (const [testo, expected] of [['db.eventi.init','initializeUnorderedBulkOp'],['db.createV','createView'],['rs.st','status'],['sh.st','status'],['config.g','get'],['loa','load']]) {
    const items = suggerisci({testo,cursore:testo.length,motore:'mongo',dbms:'mongodb',mongosh:true,limite:200});
    assert(items.some(v=>v.testo===expected), `${testo} propone ${expected}: ${JSON.stringify(items)}`);
  }
  const {default:catalogo} = await import(pathToFileURL(path.join(__dirname,'../public/js/mongosh-catalogo.mjs')));
  for(const [testo,expected] of [['db.eventi.watch().tryN','tryNext'],['db.eventi.aggregate([{$mat','$match']]) {
    assert(suggerisci({testo,cursore:testo.length,motore:'mongo',dbms:'mongodb',mongosh:true,limite:200}).some(v=>v.testo===expected));
  }
  const {formatCode,minifyCode} = await import(pathToFileURL(path.join(__dirname,'../public/js/query-formatter.js')));
  for(const code of ['select', 'class E {\nmetodo() { return `testo\n    intatto`; }\n}', 'function f() {\nreturn\n{a:1}\n}']) {
    assert.equal(minifyCode(code,'mongosh'),code);
    assert.equal(formatCode(code,'mongosh').replace(/^ +/gm,''),code.replace(/^ +/gm,''));
  }
  for (const [name,spec] of Object.entries(require('@mongosh/shell-api').signatures)) {
    assert.deepEqual(catalogo[name], Object.keys(spec.attributes||{}).filter(k=>!k.startsWith('_')).sort(), `Catalogo ${name} aggiornato`);
  }
  console.log('OK mongosh: permessi installazione, motore corretto e completamento dei helper ufficiali');
})().catch(err=>{process.exitCode=1;throw err;});
