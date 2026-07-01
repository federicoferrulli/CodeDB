'use strict';

// Test end-to-end: esercita l'intero flusso socket contro un MongoDB locale.
// Uso: node test/e2e.js

const { io } = require('socket.io-client');

const socket = io('http://localhost:3030');
const DB = 'gui_mongodb_e2e';
const COLL = 'people';
const TMP_DB = 'gui_mongodb_e2e_tmp';
const TMP_DB2 = 'gui_mongodb_e2e_tmp2';

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    process.exitCode = 1;
  }
}

socket.on('connect', async () => {
  try {
    console.log('1. mongo:connect');
    const conn = await emit('mongo:connect', { host: 'localhost', port: 27017 });
    assert(conn.ok, `connessione riuscita (${conn.ok ? conn.databases.length + ' db' : conn.error})`);
    if (!conn.ok) return socket.close();

    console.log('2. doc:insert');
    const ins1 = await emit('doc:insert', { db: DB, coll: COLL, doc: '{ "name": "Ada", "age": 36, "city": "Torino" }' });
    const ins2 = await emit('doc:insert', { db: DB, coll: COLL, doc: '{ "name": "Bruno", "age": 41, "city": "Bari", "tags": ["a", "b"] }' });
    assert(ins1.ok && ins2.ok, 'due documenti inseriti');

    console.log('3. db:collections');
    const colls = await emit('db:collections', { db: DB });
    assert(colls.ok && colls.collections.some((c) => c.name === COLL), `collection "${COLL}" presente`);

    console.log('4. collection:find con filtro e sort');
    const find = await emit('collection:find', {
      db: DB, coll: COLL,
      filter: '{ "age": { "$gt": 30 } }',
      sort: '{ "age": -1 }',
      limit: 50, skip: 0,
    });
    assert(find.ok && find.total === 2, `total = ${find.ok ? find.total : find.error}`);
    assert(find.ok && find.docs[0].name === 'Bruno', 'sort decrescente per age');
    assert(find.ok && find.columns.includes('tags'), 'colonne = unione delle chiavi');

    console.log('5. doc:update ($set)');
    const id = JSON.stringify(find.docs[0]._id);
    const upd = await emit('doc:update', { db: DB, coll: COLL, id, set: { age: 42, city: 'Roma' } });
    assert(upd.ok && upd.modified === 1, 'documento aggiornato');

    const check = await emit('collection:find', { db: DB, coll: COLL, filter: '{ "name": "Bruno" }' });
    assert(check.ok && check.docs[0].age === 42 && check.docs[0].city === 'Roma', 'modifica persistita');

    console.log('6. collection:aggregate');
    const agg = await emit('collection:aggregate', {
      db: DB, coll: COLL,
      pipeline: '[ { "$group": { "_id": null, "totale": { "$sum": "$age" } } } ]',
    });
    assert(agg.ok && agg.docs[0].totale === 78, `aggregazione: totale = ${agg.ok ? agg.docs[0].totale : agg.error}`);

    console.log('7. filtro con errore di sintassi');
    const bad = await emit('collection:find', { db: DB, coll: COLL, filter: '{ non valido }' });
    assert(!bad.ok && bad.error, 'errore riportato correttamente');

    console.log('8. doc:replace (riga intera)');
    const rep = await emit('doc:replace', {
      db: DB, coll: COLL, id,
      doc: '{ "name": "Bruno", "age": 50, "role": "admin" }',
    });
    assert(rep.ok && rep.modified === 1, 'documento sostituito');
    const repCheck = await emit('collection:find', { db: DB, coll: COLL, filter: '{ "name": "Bruno" }' });
    assert(
      repCheck.ok && repCheck.docs[0].age === 50 && repCheck.docs[0].role === 'admin' && repCheck.docs[0].city === undefined,
      'replace persistito (campo "city" rimosso)'
    );

    console.log('9. collection:stats');
    const stats = await emit('collection:stats', { db: DB, coll: COLL });
    assert(stats.ok && stats.stats.count === 2, `count = ${stats.ok ? stats.stats.count : stats.error}`);
    assert(stats.ok && stats.indexes.some((i) => i.name === '_id_'), 'indice _id_ presente');
    assert(
      stats.ok && stats.fields.some((f) => f.name === 'name' && f.types.includes('string')),
      'schema rilevato: campo "name" string'
    );

    console.log('10. db:schema con relazione (orders.people_id -> people)');
    const insOrd = await emit('doc:insert', {
      db: DB, coll: 'orders',
      doc: `{ "people_id": ${ins1.insertedId}, "amount": 10 }`,
    });
    assert(insOrd.ok, 'ordine inserito');
    const schema = await emit('db:schema', { db: DB });
    assert(schema.ok && schema.collections.some((c) => c.name === 'orders'), 'schema contiene "orders"');
    assert(
      schema.ok && schema.relations.some((r) => r.from === 'orders' && r.to === 'people' && r.field === 'people_id'),
      'relazione orders.people_id -> people rilevata'
    );

    console.log('11. doc:delete');
    const all = await emit('collection:find', { db: DB, coll: COLL, filter: '{ "name": "Ada" }' });
    const del = await emit('doc:delete', { db: DB, coll: COLL, id: JSON.stringify(all.docs[0]._id) });
    assert(del.ok && del.deleted === 1, 'documento eliminato');

    console.log('11b. collection:create/rename/drop + indici');
    const ccre = await emit('collection:create', { db: DB, name: 'gadgets' });
    assert(ccre.ok, `collection "gadgets" creata${ccre.ok ? '' : ' (' + ccre.error + ')'}`);
    const idx = await emit('index:create', { db: DB, coll: 'gadgets', fields: '{"sku": 1}', unique: true, name: 'sku_unique' });
    assert(idx.ok && idx.name === 'sku_unique', `indice creato (${idx.ok ? idx.name : idx.error})`);
    const idxStats = await emit('collection:stats', { db: DB, coll: 'gadgets' });
    assert(idxStats.ok && idxStats.indexes.some((i) => i.name === 'sku_unique' && i.unique), 'indice presente e unico');
    const idDel = await emit('index:drop', { db: DB, coll: 'gadgets', name: '_id_' });
    assert(!idDel.ok, 'eliminazione di "_id_" rifiutata');
    const idxDel = await emit('index:drop', { db: DB, coll: 'gadgets', name: 'sku_unique' });
    assert(idxDel.ok, 'indice eliminato');
    const cren = await emit('collection:rename', { db: DB, coll: 'gadgets', newName: 'widgets' });
    assert(cren.ok, `collection rinominata in "widgets"${cren.ok ? '' : ' (' + cren.error + ')'}`);
    const cls2 = await emit('db:collections', { db: DB });
    assert(cls2.ok && cls2.collections.some((c) => c.name === 'widgets') && !cls2.collections.some((c) => c.name === 'gadgets'),
      'rinomina riflessa nell\'elenco');
    const cdrop = await emit('collection:drop', { db: DB, coll: 'widgets' });
    assert(cdrop.ok, 'collection eliminata');

    console.log('11c. gestione campi su tutti i documenti (column:add/alter/drop)');
    const fadd = await emit('column:add', { db: DB, coll: COLL, column: { name: 'status', default: 'new' } });
    assert(fadd.ok && fadd.modified === 1, `campo "status" aggiunto (${fadd.ok ? fadd.modified + ' documenti' : fadd.error})`);
    const fchk1 = await emit('collection:find', { db: DB, coll: COLL, filter: '' });
    assert(fchk1.ok && fchk1.docs[0].status === 'new', 'valore iniziale applicato');
    const fren = await emit('column:alter', { db: DB, coll: COLL, oldName: 'status', column: { name: 'stato', type: '' } });
    assert(fren.ok && fren.modified === 1, 'campo rinominato in "stato" ($rename)');
    const fconv = await emit('column:alter', { db: DB, coll: COLL, oldName: 'age', column: { name: 'age', type: 'string' } });
    assert(fconv.ok, 'campo "age" convertito a string ($convert)');
    const fchk2 = await emit('collection:find', { db: DB, coll: COLL, filter: '' });
    assert(fchk2.ok && fchk2.docs[0].stato === 'new' && typeof fchk2.docs[0].age === 'string',
      `rinomina e conversione persistite (age = ${fchk2.ok ? JSON.stringify(fchk2.docs[0].age) : '?'})`);
    const fbad = await emit('column:alter', { db: DB, coll: COLL, oldName: 'age', column: { name: 'age', type: 'tipo_inventato' } });
    assert(!fbad.ok, 'tipo di conversione non valido rifiutato');
    const fdrop = await emit('column:drop', { db: DB, coll: COLL, name: 'stato' });
    assert(fdrop.ok && fdrop.modified === 1, 'campo rimosso da tutti i documenti ($unset)');
    const fchk3 = await emit('collection:find', { db: DB, coll: COLL, filter: '' });
    assert(fchk3.ok && !('stato' in fchk3.docs[0]), 'campo assente dopo la rimozione');
    const fid = await emit('column:drop', { db: DB, coll: COLL, name: '_id' });
    assert(!fid.ok, 'eliminazione di "_id" rifiutata');

    console.log('12. db:create / db:list / db:rename / db:drop');
    const create = await emit('db:create', { db: TMP_DB, coll: 'c1' });
    assert(create.ok, `database "${TMP_DB}" creato${create.ok ? '' : ' (' + create.error + ')'}`);
    await emit('doc:insert', { db: TMP_DB, coll: 'c1', doc: '{ "x": 1 }' });
    const list1 = await emit('db:list', {});
    assert(list1.ok && list1.databases.some((d) => d.name === TMP_DB), 'db:list contiene il nuovo database');
    const dup = await emit('db:create', { db: TMP_DB, coll: 'c1' });
    assert(!dup.ok, 'creazione di un db già esistente rifiutata');
    const ren = await emit('db:rename', { db: TMP_DB, newName: TMP_DB2 });
    assert(ren.ok, `database rinominato in "${TMP_DB2}"${ren.ok ? '' : ' (' + ren.error + ')'}`);
    const renCheck = await emit('collection:find', { db: TMP_DB2, coll: 'c1', filter: '' });
    assert(renCheck.ok && renCheck.total === 1, 'dati presenti nel database rinominato');
    const list2 = await emit('db:list', {});
    assert(list2.ok && !list2.databases.some((d) => d.name === TMP_DB), 'il vecchio nome non esiste più');
    const drop1 = await emit('db:drop', { db: TMP_DB2 });
    assert(drop1.ok, `database "${TMP_DB2}" eliminato`);
    const sysDrop = await emit('db:drop', { db: 'admin' });
    assert(!sysDrop.ok, 'eliminazione di un db di sistema rifiutata');

    console.log('13. pulizia: db:drop del database di test');
    const drop2 = await emit('db:drop', { db: DB });
    assert(drop2.ok, `database "${DB}" eliminato`);
    const list3 = await emit('db:list', {});
    assert(list3.ok && !list3.databases.some((d) => d.name === DB), 'database di test rimosso');

    console.log('14. connessioni salvate (connections.ini)');
    const CONN_NAME = 'e2e-locale';
    const reconn = await emit('mongo:connect', { host: 'localhost', port: 27017, saveAs: CONN_NAME });
    assert(reconn.ok && reconn.label === 'localhost:27017', `connessione salvata con saveAs (label = ${reconn.label})`);
    const clist = await emit('connections:list', {});
    assert(clist.ok && clist.connections.some((c) => c.name === CONN_NAME), 'connections:list contiene la connessione');
    const bySaved = await emit('mongo:connect', { saved: CONN_NAME });
    assert(bySaved.ok && bySaved.label === 'localhost:27017', 'riconnessione tramite connessione salvata');
    const missing = await emit('mongo:connect', { saved: 'inesistente' });
    assert(!missing.ok, 'connessione salvata inesistente rifiutata');

    console.log('15. connessioni salvate: get / save / export / import');
    const CONN_NAME2 = 'e2e-rinominata';
    const cget = await emit('connections:get', { name: CONN_NAME });
    assert(cget.ok && cget.fields.host === 'localhost' && !('password' in cget.fields), 'connections:get non espone la password');
    const csave = await emit('connections:save', { name: CONN_NAME2, oldName: CONN_NAME, cfg: { host: '127.0.0.1', port: 27017 } });
    assert(csave.ok, 'connections:save aggiorna e rinomina');
    const clistR = await emit('connections:list', {});
    assert(
      clistR.ok && clistR.connections.some((c) => c.name === CONN_NAME2) && !clistR.connections.some((c) => c.name === CONN_NAME),
      'rinomina applicata alla lista'
    );

    const cpw1 = await emit('connections:save', { name: 'e2e-pw', cfg: { host: 'localhost', username: 'u1', password: 'segreta' } });
    const cpw2 = await emit('connections:save', { name: 'e2e-pw', cfg: { host: 'localhost', username: 'u2' } });
    assert(cpw1.ok && cpw2.ok, 'connections:save crea e aggiorna "e2e-pw"');
    const cexp = await emit('connections:export', {});
    assert(cexp.ok && cexp.ini.includes(`[${CONN_NAME2}]`) && cexp.ini.includes('host=127.0.0.1'), 'export contiene la connessione rinominata');
    const cpwGet = await emit('connections:get', { name: 'e2e-pw' });
    assert(
      cexp.ok && cexp.ini.includes('username=u2') && cexp.ini.includes('password=ENC:') && cpwGet.ok && cpwGet.hasPassword,
      'update senza password preserva quella salvata (cifrata nell\'export)'
    );

    await emit('connections:delete', { name: CONN_NAME2 });
    const cimp = await emit('connections:import', { ini: cexp.ini });
    assert(cimp.ok && cimp.imported >= 1, `import ripristina le connessioni (${cimp.ok ? cimp.imported + ' importate, ' + cimp.overwritten + ' sovrascritte' : cimp.error})`);
    const cimpBad = await emit('connections:import', { ini: 'testo senza sezioni' });
    assert(!cimpBad.ok, 'import di un file non valido rifiutato');

    const cdel = await emit('connections:delete', { name: CONN_NAME2 });
    const cdelPw = await emit('connections:delete', { name: 'e2e-pw' });
    assert(cdel.ok && cdelPw.ok, 'connessioni salvate eliminate');
    const clist2 = await emit('connections:list', {});
    assert(
      clist2.ok && !clist2.connections.some((c) => c.name === CONN_NAME2 || c.name === 'e2e-pw'),
      'connessioni rimosse dalla lista'
    );

    console.log('16. mongo:disconnect');
    const disc = await emit('mongo:disconnect', {});
    assert(disc.ok, 'disconnessione pulita');

    console.log('17. sessioni multiple per tab (tabId)');
    const tabA = await emit('mongo:connect', { host: 'localhost', port: 27017, tabId: 'tabA' });
    const tabB = await emit('mongo:connect', { host: 'localhost', port: 27017, tabId: 'tabB' });
    assert(tabA.ok && tabA.tabId === 'tabA' && tabB.ok && tabB.tabId === 'tabB', 'due tab connessi in parallelo sullo stesso socket');
    const insA = await emit('doc:insert', { tabId: 'tabA', db: DB, coll: COLL, doc: '{ "who": "tabA" }' });
    const findB = await emit('collection:find', { tabId: 'tabB', db: DB, coll: COLL, filter: '{ "who": "tabA" }' });
    assert(insA.ok && findB.ok && findB.total === 1, 'sessioni separate sullo stesso server');
    const noTab = await emit('collection:find', { tabId: 'tabZ', db: DB, coll: COLL, filter: '' });
    assert(!noTab.ok, 'tabId senza sessione rifiutato');
    const discA = await emit('mongo:disconnect', { tabId: 'tabA' });
    const findA = await emit('collection:find', { tabId: 'tabA', db: DB, coll: COLL, filter: '' });
    const findB2 = await emit('collection:find', { tabId: 'tabB', db: DB, coll: COLL, filter: '' });
    assert(discA.ok && !findA.ok && findB2.ok, 'chiusura di un tab: gli altri restano attivi');
    const dropTab = await emit('db:drop', { tabId: 'tabB', db: DB });
    assert(dropTab.ok, 'pulizia del database di test dal tab B');
    await emit('mongo:disconnect', { tabId: 'tabB' });

    console.log('18. connections:test');
    const tOk = await emit('connections:test', { host: 'localhost', port: 27017 });
    assert(tOk.ok && tOk.dbType === 'mongodb' && tOk.databases >= 1, `test connessione riuscito (${tOk.ok ? tOk.databases + ' db' : tOk.error})`);
    const tBad = await emit('connections:test', { host: 'localhost', port: 1 });
    assert(!tBad.ok, 'test connessione verso porta chiusa fallisce');

    console.log(process.exitCode ? '\nTEST FALLITI' : '\nTUTTI I TEST SUPERATI');
  } catch (err) {
    console.error('Errore inatteso:', err);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});

setTimeout(() => {
  console.error('Timeout: il server non risponde.');
  process.exit(1);
}, 30000).unref();
