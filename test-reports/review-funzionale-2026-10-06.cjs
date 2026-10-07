'use strict';

// Diagnostica della review: nessuna rete e nessun database reale.
// Ogni FAIL indica un contratto funzionale non rispettato, non un errore del runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const SqlToMql = require('../db/SqlToMql');
const VirtualJoin = require('../db/VirtualJoinEngine');
const DbStrategy = require('../db/DbStrategy');
const { ScriptRun: ScriptRunner } = require('../db/ScriptRunner');
const { payloadEsecuzione } = require('../db/payloadEsecuzione');
const { revisioneSchema, limitaSchema } = require('../db/schemaProgressivo');
const { createModule } = require('../server/query');
const query = createModule({
  config: { env: {} }, dependencies: {},
  connessioni: { executeWithReconnect: (s, fn) => fn(s.strategy) },
});
const risultati = [];
async function prova(id, nome, fn) {
  try { await fn(); risultati.push({ id, nome, esito: 'PASS' }); }
  catch (err) { risultati.push({ id, nome, esito: err.code === 'ERR_ASSERTION' ? 'FAIL' : 'ERRORE', dettaglio: err.message }); }
}
const sorgenti = {
  virtualJoin: {
    sourceA: { dbType: 'mysql', db: 'shop', table: 'orders' },
    sourceB: { dbType: 'mongodb', db: 'crm', collection: 'customers' },
    on: { leftKey: 'customer_id', rightKey: '_id' },
  },
};
const validaPipeline = p => {
  for (const stage of p.pipeline) {
    assert.equal(Object.keys(stage).length, 1, 'Ogni stage richiede un solo operatore');
    assert(Object.keys(stage)[0].startsWith('$'), 'Manca l’operatore dello stage');
  }
};

(async () => {
  await prova('CDB-F01', 'SQL→MQL: COUNT genera una pipeline valida', () => {
    validaPipeline(SqlToMql.translate('SELECT COUNT(*) AS n FROM users'));
  });
  // Sensibilità: versione corretta solo in memoria, poi guasto reintrodotto.
  const file = path.resolve(__dirname, '../db/SqlToMql.js');
  const source = fs.readFileSync(file, 'utf8');
  const sandbox = { module: { exports: {} }, require: createRequire(file) };
  assert(source.includes('pipeline.push(groupStage);'));
  vm.runInNewContext(source.replace('pipeline.push(groupStage);', 'pipeline.push({ $group: groupStage });'), sandbox);
  validaPipeline(sandbox.module.exports.translate('SELECT COUNT(*) AS n FROM users'));
  assert.throws(() => validaPipeline(SqlToMql.translate('SELECT COUNT(*) AS n FROM users')));
  console.log('CONTROLLO: il test dello stage passa correggendo in memoria e fallisce reintroducendo il guasto.');

  await prova('CDB-F02', 'Virtual JOIN: le sorgenti usano motori distinti', async () => {
    const chiamate = [];
    const strategy = { type: 'mysql', async collectionAggregate(db, coll, payload) {
      chiamate.push({ motore: this.type, db, pipeline: payload.pipeline });
      return { docs: db === 'shop' ? [{ customer_id: 'c1' }] : [{ _id: 'c1' }] };
    } };
    await query.executeQueryCode({ strategy }, payloadEsecuzione({ engine: 'crossdb', db: 'shop', code: JSON.stringify(sorgenti) }));
    assert.deepEqual(chiamate.map(c => c.motore), ['mysql', 'mongodb']);
  });
  await prova('CDB-F03', 'Virtual JOIN: una sorgente troncata non diventa successo completo', async () => {
    const strategy = { type: 'mysql', async collectionAggregate() {
      return { docs: [{ customer_id: 'c1', _id: 'c1' }], truncated: true };
    } };
    await assert.rejects(query.executeQueryCode({ strategy }, payloadEsecuzione({
      engine: 'crossdb', db: 'shop', code: JSON.stringify(sorgenti),
    })), /incomplet|tronc|budget/i);
  });
  await prova('CDB-F03', 'Virtual JOIN: corrispondenze multiple non vengono scartate', async () => {
    const a = { type: 'mysql', async collectionAggregate() { return { docs: [{ customer_id: 'c1' }] }; } };
    const b = { type: 'mongodb', async collectionAggregate() {
      return { docs: [{ _id: 'c1', n: 1 }, { _id: 'c1', n: 2 }] };
    } };
    const spec = structuredClone(sorgenti);
    spec.virtualJoin.on.rightKey = 'customer_id';
    b.collectionAggregate = async () => ({ docs: [{ customer_id: 'c1', n: 1 }, { customer_id: 'c1', n: 2 }] });
    const rows = await VirtualJoin.execute(spec, a, b);
    const numero = rows.flatMap(r => Array.isArray(r.joined_data) ? r.joined_data : [r.joined_data]).filter(Boolean).length;
    assert.equal(numero, 2, 'Due match sul campo non univoco devono restare entrambi');
  });
  await prova('CDB-F04', 'SQL→MQL: SELECT con alias conserva il nome richiesto', () => {
    const p = SqlToMql.translate('SELECT name AS etichetta FROM users');
    const output = p.kind === 'find' ? p.projection : p.pipeline.find(s => s.$project)?.$project;
    assert(Object.hasOwn(output, 'etichetta'), JSON.stringify(p));
  });
  await prova('CDB-F05', 'Schema: rinominare un campo invalida il cursore precedente', () => {
    const prima = { collections: [{ name: 't', fields: [{ name: 'a' }, { name: 'b' }] }], relations: [] };
    const dopo = { collections: [{ name: 't', fields: [{ name: 'z' }, { name: 'b' }] }], relations: [] };
    const page = limitaSchema(dopo, { revisione: revisioneSchema(prima), fieldCursors: { t: 1 }, fieldLimit: 1 });
    assert.equal(page.schemaPage.revisioneCambiata, true, 'Stessa cardinalità non significa stesso catalogo');
  });
  await prova('CDB-F06', 'Cronologia: gli spazi dentro le stringhe distinguono le query', async () => {
    const { registra, leggiVoci } = await import('../public/js/query-history-store.js');
    const valori = new Map();
    const storage = { getItem: k => valori.get(k) || null, setItem: (k, v) => valori.set(k, v) };
    registra(storage, { code: "SELECT 'a  b' AS testo", conn: 'c', db: 'd' });
    registra(storage, { code: "SELECT 'a b' AS testo", conn: 'c', db: 'd' });
    assert.equal(leggiVoci(storage).length, 2, 'La seconda query elimina la prima benché restituiscano testi diversi');
  });
  await prova('CDB-F07', 'Budget risultati: una singola riga fuori budget viene segnalata', () => {
    const esito = DbStrategy.truncateBySize([{ testo: 'x'.repeat(200) }], 100);
    assert.equal(esito.truncated, true, 'Riga da oltre 200 byte accettata con tetto di 100 byte');
  });
  await prova('CDB-F07', 'Budget risultati: il conteggio usa byte UTF-8', () => {
    const righe = [{ testo: '漢'.repeat(40) }, { testo: '漢'.repeat(40) }];
    assert(Buffer.byteLength(JSON.stringify(righe)) > 200);
    assert.equal(DbStrategy.truncateBySize(righe, 200).truncated, true, 'Oltre 260 byte accettati con tetto di 200 byte');
  });
  for (const [tipo, fileStrategia] of [['mysql', '../db/MySqlStrategy'], ['postgresql', '../db/PostgreSqlStrategy']]) {
    await prova('CDB-F08', `Script ${tipo}: BEGIN/INSERT/ROLLBACK restano sulla stessa connessione`, async () => {
      const Strategy = require(fileStrategia);
      const strategy = new Strategy({ env: { CODEDB_AGGREGATE_TIMEOUT_MS: '0' } });
      let indice = 0;
      let persistite = 0;
      const leases = [];
      const connessioni = [0, 1].map(id => ({
        id, transazione: false, pendenti: 0,
        async query(request) {
          const sql = typeof request === 'string' ? request : request.sql;
          if (/^(BEGIN|INSERT|ROLLBACK)/.test(sql)) leases.push({ id, sql });
          if (sql === 'BEGIN') this.transazione = true;
          if (sql.startsWith('INSERT')) {
            if (this.transazione) this.pendenti++;
            else persistite++;
          }
          if (sql === 'ROLLBACK') { this.transazione = false; this.pendenti = 0; }
          return tipo === 'mysql' ? [{ affectedRows: 0 }, []] : { command: sql.split(' ')[0], rowCount: 0 };
        },
        release() {},
      }));
      const checkout = async () => connessioni[indice++ % 2];
      strategy.pool = tipo === 'mysql' ? { getConnection: checkout } : { connect: checkout };
      const run = new ScriptRunner({ id: 'review', statements: ['BEGIN', 'INSERT INTO t VALUES (1)', 'ROLLBACK'].map(sql => ({ sql, line: 1 })), stopOnError: true });
      await run.start(async stmt => (await query.executeQueryCode({ strategy }, payloadEsecuzione({ code: stmt.sql, engine: tipo, db: 'app' }))).res);
      assert.equal(run.state().falliti, 0, 'La simulazione deve attraversare tutte le istruzioni senza errori');
      assert.equal(persistite, 0, `Rollback inefficace nel pool alternato: ${JSON.stringify(leases)}`);
    });
  }
  console.log(JSON.stringify(risultati, null, 2));
  const falliti = risultati.filter(r => r.esito === 'FAIL').length;
  console.log(`${falliti}/${risultati.length} contratti non rispettati; ${new Set(risultati.filter(r => r.esito === 'FAIL').map(r => r.id)).size} rilievi riprodotti.`);
  process.exitCode = risultati.some(r => r.esito === 'ERRORE') ? 2 : falliti ? 1 : 0;
})().catch(err => { console.error(err); process.exitCode = 2; });
