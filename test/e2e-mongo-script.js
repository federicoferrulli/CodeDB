'use strict';

/* ---------------------------------------------------------------------------
 * Test E2E dell'interprete di script MongoDB (Fase C) contro un MongoDB vero.
 *
 * I test unitari verificano il LINGUAGGIO e la sandbox con un host finto; qui
 * si verifica che uno script scriva davvero sul database attraverso la
 * strategia: creazione di collezioni, insert/update/delete, cicli che leggono
 * e riscrivono, e l'interruzione di uno script fuori controllo.
 *
 * Uso: node test/e2e-mongo-script.js
 * ------------------------------------------------------------------------- */

const { io } = require('socket.io-client');
const { startTestServer } = require('./e2e-harness');

let socket = null;
let testServer = null;
const DB = 'gui_mongodb_e2e';

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

/** Esegue uno script tramite il Query Engine e ne restituisce la risposta. */
function script(code, extra = {}) {
  return emit('query:execute', { db: DB, code, ...extra });
}

/** Righe di `print` restituite dallo script. */
function stampe(res) {
  return (res && res.scriptOutput) || [];
}

(async () => {
  testServer = await startTestServer({ port: parseInt(process.env.E2E_PORT, 10) || 3151 });
  socket = io(testServer.url);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  await runTests();
})().catch(async (err) => {
  console.error('Impossibile avviare i test:', (err && err.message) || err);
  process.exitCode = 1;
  if (socket) socket.close();
  if (testServer) await testServer.stop();
});

async function runTests() {
  try {
    console.log('--- Test E2E interprete script MongoDB ---');

    console.log('1. Connessione');
    const conn = await emit('mongo:connect', { host: 'localhost', port: 27017 });
    assert(conn.ok, 'Connessione a MongoDB riuscita');
    if (!conn.ok) return socket.close();

    for (const c of ['script_src', 'script_dst', 'script_nuova']) {
      await emit('collection:drop', { db: DB, coll: c }).catch(() => {});
    }

    console.log('2. Uno script crea una collezione e inserisce documenti');
    const r1 = await script(`
      db.createCollection('script_src');
      for (let i = 1; i <= 5; i++) {
        db.script_src.insertOne({ n: i, pari: i % 2 === 0, nome: 'elemento ' + i });
      }
      print('inseriti', db.script_src.countDocuments({}));
    `);
    assert(r1.ok, `Script eseguito (${r1.error || ''})`);
    assert(stampe(r1).includes('inseriti 5'), `print riporta 5 inserimenti (${JSON.stringify(stampe(r1))})`);

    const conteggio = await emit('collection:count', { db: DB, coll: 'script_src', filter: '{}' });
    assert(conteggio.ok && conteggio.total === 5, `I documenti esistono davvero sul database (${conteggio.total})`);

    console.log('3. Ciclo che legge e riscrive su un\'altra collezione');
    const r2 = await script(`
      const pari = db.script_src.find({ pari: true }).sort({ n: 1 }).toArray();
      for (const d of pari) {
        db.script_dst.insertOne({ origine: d.n, etichetta: 'n=' + d.n });
      }
      print('copiati', pari.length);
    `);
    assert(r2.ok, `Script di copia eseguito (${r2.error || ''})`);
    assert(stampe(r2).includes('copiati 2'), `Copiati i 2 documenti pari (${JSON.stringify(stampe(r2))})`);

    const dst = await emit('collection:find', { db: DB, coll: 'script_dst', filter: '{}' });
    assert(dst.ok && dst.docs.length === 2, `La collezione di destinazione ha 2 documenti (${dst.docs && dst.docs.length})`);

    console.log('4. updateMany con operatori e deleteMany');
    const r3 = await script(`
      const u = db.script_src.updateMany({ pari: false }, { $set: { categoria: 'dispari' } });
      print('modificati', u.modified);
      const d = db.script_src.deleteMany({ n: { $gt: 4 } });
      print('cancellati', d.deleted);
      print('rimasti', db.script_src.countDocuments({}));
    `);
    assert(r3.ok, `Script di modifica eseguito (${r3.error || ''})`);
    assert(stampe(r3).includes('modificati 3'), `updateMany ha toccato 3 documenti (${JSON.stringify(stampe(r3))})`);
    assert(stampe(r3).includes('cancellati 1'), 'deleteMany ha cancellato 1 documento');
    assert(stampe(r3).includes('rimasti 4'), 'Il conteggio finale è coerente');

    console.log('5. Aggregazione e distinct dentro uno script');
    const r4 = await script(`
      const gruppi = db.script_src.aggregate([
        { $group: { _id: '$pari', quanti: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]).toArray();
      print('gruppi', gruppi.length);
      const valori = db.script_src.distinct('pari');
      print('distinti', valori.length);
    `);
    assert(r4.ok, `Aggregazione nello script eseguita (${r4.error || ''})`);
    assert(stampe(r4).includes('gruppi 2'), `Due gruppi (${JSON.stringify(stampe(r4))})`);
    assert(stampe(r4).includes('distinti 2'), 'Due valori distinti');

    console.log('6. Un aggiornamento senza operatori viene rifiutato');
    const r5 = await script("db.script_src.updateMany({ n: 1 }, { nome: 'sostituito' });");
    assert(!r5.ok && /operatori/i.test(r5.error || ''), `Rifiutato con spiegazione (${r5.error})`);

    console.log('7. La sandbox regge anche passando dal socket');
    const evasioni = [
      { code: 'print([].constructor)', atteso: /constructor/ },
      { code: 'print(require("fs"))', atteso: /non definito/i },
      { code: 'print(process.env)', atteso: /non definito/i },
      { code: 'const f = () => 1; print(f.constructor);', atteso: /constructor|non espongono/ },
    ];
    for (const ev of evasioni) {
      const res = await script(ev.code);
      assert(!res.ok && ev.atteso.test(res.error || ''), `Bloccato: ${ev.code.slice(0, 40)} (${res.error})`);
    }

    console.log('8. $where resta vietato anche negli script');
    const rWhere = await script('print(db.script_src.find({ $where: "true" }).toArray().length);');
    assert(!rWhere.ok && /\$where|JavaScript/i.test(rWhere.error || ''), `Operatore server-side rifiutato (${rWhere.error})`);

    console.log('9. Un ciclo fuori controllo si ferma da solo');
    const tStart = Date.now();
    const rInf = await script('let i = 0; while (true) { i++; }');
    const durata = Date.now() - tStart;
    assert(!rInf.ok, `Ciclo infinito interrotto (${rInf.error})`);
    assert(durata < 90000, `Interrotto in tempo ragionevole (${Math.round(durata / 1000)}s)`);

    console.log('10. Errori di runtime indicano la riga');
    const rErr = await script('const a = 1;\nnonEsiste();\n');
    assert(!rErr.ok && /riga 2/.test(rErr.error || ''), `Errore con numero di riga (${rErr.error})`);

    console.log('11. Lo script è tracciato nell\'audit come scrittura');
    const audit = await emit('audit:list', { limit: 20 });
    const voce = audit.ok && (audit.entries || []).find((e) => e.op === 'Script MongoDB');
    assert(!!voce, 'Voce di audit "Script MongoDB" presente');
    assert(voce && voce.category === 'write', `Categorizzato come scrittura (${voce && voce.category})`);

    console.log('12. SQL di scrittura e DDL su MongoDB');
    const sqlCreate = await script('CREATE TABLE script_nuova (id INT, nome VARCHAR(50))');
    assert(sqlCreate.ok, `CREATE TABLE tradotto (${sqlCreate.error || ''})`);
    const collezioni = await emit('db:collections', { db: DB });
    assert(collezioni.ok && collezioni.collections.some((c) => (c.name || c) === 'script_nuova'),
      'La collezione creata via SQL esiste davvero');

    const sqlInsert = await script("INSERT INTO script_nuova (id, nome) VALUES (1, 'uno'), (2, 'due')");
    assert(sqlInsert.ok, `INSERT tradotto (${sqlInsert.error || ''})`);
    const dopoInsert = await emit('collection:count', { db: DB, coll: 'script_nuova', filter: '{}' });
    assert(dopoInsert.total === 2, `Due documenti inseriti via SQL (${dopoInsert.total})`);

    const sqlUpdate = await script("UPDATE script_nuova SET nome = 'aggiornato' WHERE id = 1");
    assert(sqlUpdate.ok, `UPDATE tradotto (${sqlUpdate.error || ''})`);
    const aggiornato = await emit('collection:find', { db: DB, coll: 'script_nuova', filter: '{"id":1}' });
    assert(aggiornato.ok && aggiornato.docs[0] && aggiornato.docs[0].nome === 'aggiornato',
      'UPDATE ha modificato il documento giusto');

    const sqlDelete = await script('DELETE FROM script_nuova WHERE id = 2');
    assert(sqlDelete.ok, `DELETE tradotto (${sqlDelete.error || ''})`);
    const dopoDelete = await emit('collection:count', { db: DB, coll: 'script_nuova', filter: '{}' });
    assert(dopoDelete.total === 1, `Un documento rimasto (${dopoDelete.total})`);

    const sqlAlter = await script('ALTER TABLE script_nuova ADD COLUMN x INT');
    assert(!sqlAlter.ok && /schema fisso|ALTER/i.test(sqlAlter.error || ''),
      `ALTER rifiutato spiegando perché (${sqlAlter.error})`);

    console.log('13. Pulizia');
    for (const c of ['script_src', 'script_dst', 'script_nuova']) {
      await emit('collection:drop', { db: DB, coll: c }).catch(() => {});
    }

    if (process.exitCode) console.error('\n--- Alcuni test FALLITI ---');
    else console.log('\n--- Tutti i test dell\'interprete su MongoDB superati! ---');
  } catch (err) {
    console.error('Errore durante i test:', (err && err.stack) || err);
    process.exitCode = 1;
  } finally {
    socket.close();
    if (testServer) await testServer.stop();
  }
}
