'use strict';

const assert = require('node:assert/strict');
const DbStrategy = require('../db/DbStrategy');
const SqlToMql = require('../db/SqlToMql');
const VirtualJoin = require('../db/VirtualJoinEngine');
const { revisioneSchema } = require('../db/schemaProgressivo');
const { conSessioneSql, chiudiSessioneSql } = require('../db/sqlSessione');
let completato = false;
process.once('beforeExit', () => { if (!completato) { console.error('FAIL: prova di preproduzione rimasta sospesa'); process.exitCode = 1; } });

module.exports = (async () => {
  const row = { testo: '🦊'.repeat(30) };
  const bytes = Buffer.byteLength(JSON.stringify([row]));
  assert.equal(DbStrategy.truncateBySize([row], bytes).rows.length, 1);
  assert.deepEqual(DbStrategy.truncateBySize([row], bytes - 1), { rows: [], truncated: true });
  let chiuso = false;
  async function* cursor() { try { yield row; yield row; } finally { chiuso = true; } }
  assert.deepEqual(await DbStrategy.collectCapped(cursor(), 100, bytes - 1), { docs: [], truncated: true });
  assert(chiuso, 'il cursore va liberato anche sulla prima riga enorme');

  const base = { collections: [{ name: 'a', fields: [{ name: 'id', type: 'int' }] }], relations: [{ from: 'a', to: 'b', field: 'id' }] };
  for (const modifica of [s => { s.collections[0].fields[0].name = 'altro'; }, s => { s.collections[0].fields[0].type = 'text'; }, s => { s.relations[0].to = 'c'; }]) {
    const altro = structuredClone(base); modifica(altro);
    assert.notEqual(revisioneSchema(base), revisioneSchema(altro));
  }
  assert.equal(revisioneSchema(base), revisioneSchema({ ...base, count: 900 }));

  const { registra, leggiVoci } = await import('../public/js/query-history-store.js');
  const storage = { value: '[]', getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
  for (const meta of [{ code: "SELECT 'a  b'", coll: 'a' }, { code: "SELECT 'a b'", coll: 'a' }, { code: "SELECT 'a b'", coll: 'b' }]) registra(storage, meta);
  assert.equal(leggiVoci(storage).length, 3, 'letterali e collezioni diverse non devono sparire');

  assert(SqlToMql.translate('SELECT COUNT(*) AS n FROM t').pipeline[0].$group);
  const alias = SqlToMql.translate('SELECT _id, nome AS n FROM t ORDER BY n');
  assert.deepEqual(alias.pipeline, [{ $sort: { nome: 1 } }, { $project: { _id: '$_id', n: '$nome' } }]);

  const spec = { virtualJoin: { sourceA: { db: 'a', collection: 'x' }, sourceB: { db: 'b', collection: 'y' }, on: { leftKey: 'id', rightKey: 'id' } } };
  const strategy = docs => ({ type: 'mongodb', async collectionAggregate() { return { docs }; } });
  const joined = await VirtualJoin.execute(spec, strategy([{ id: 1 }, { id: null }]), strategy([{ id: 1, n: 'a' }, { id: 1, n: 'b' }]));
  assert.equal(joined.length, 3);
  assert.deepEqual(joined.map(r => r.joined_data?.n || null), ['a', 'b', null]);
  await assert.rejects(() => VirtualJoin.execute(spec, { type: 'mongodb', async collectionAggregate() { return { docs: [{ id: 1 }], truncated: true }; } }, strategy([])), /incompleto/);

  const connessioni = require('../server/connessioni').createModule({ vault: {}, dependencies: {}, errori: {} });
  const session = { strategy: {}, effectiveCfg: {}, reconnecting: true, reconnectPromise: Promise.resolve() };
  let esecuzioni = 0;
  await assert.rejects(() => connessioni.executeWithReconnect(session, async () => {
    esecuzioni++;
    throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
  }), err => err.operationOutcomeUnknown && /non è stata ripetuta/.test(err.message));
  assert.equal(esecuzioni, 1, 'una risposta persa non deve duplicare una scrittura');
  const { INCLUSIONI, regexPackager } = require('../tools/esclusioni-distribuzione');
  const files = require('../package.json').build.files;
  assert(!files.includes('**/*'));
  for (const voce of INCLUSIONI) assert(files.includes(voce));
  for (const file of ['/export-clienti.json', '/.scratch/credenziali.txt', '/landing/node_modules/prova.js']) {
    assert(regexPackager().some(re => re.test(file)), `File locale incluso nel portatile: ${file}`);
  }

  for (const tipo of ['MySql', 'PostgreSql']) {
    const st = new (require(`../db/${tipo}Strategy`))({ env: { CODEDB_AGGREGATE_TIMEOUT_MS: '0' } });
    const chiamate = [];
    let numero = 0;
    const apri = async () => {
      const id = ++numero;
      return { query: async query => {
        const sql = typeof query === 'string' ? query : query.sql;
        chiamate.push({ id, sql });
        return tipo === 'MySql' ? [[], []] : { rows: [], fields: [], command: 'SELECT' };
      }, release() {}, destroy() {} };
    };
    st.pool = { getConnection: apri, connect: apri, async end() {} };
    const scopeA = {}, scopeB = {};
    const query = (scope, sql, extra = {}) => conSessioneSql(scope, () => st.collectionAggregate('d', 't', { pipeline: sql, ...extra }));
    await query(scopeA, 'BEGIN');
    await query(scopeB, 'SELECT 2');
    await query(scopeA, 'INSERT INTO t VALUES (1)');
    await assert.rejects(() => query(scopeA, 'SELECT 3', { readOnly: true }), /seconda transazione/);
    await query(scopeA, 'ROLLBACK');
    const transazione = chiamate.filter(x => /^(BEGIN|INSERT|ROLLBACK)$/.test(x.sql.split(' ')[0]));
    assert.equal(new Set(transazione.map(x => x.id)).size, 1, 'BEGIN, scrittura e ROLLBACK devono usare lo stesso client');
    assert.notEqual(chiamate.find(x => x.sql === 'SELECT 2').id, transazione[0].id, 'gli script paralleli sono isolati');
    await query(scopeA, 'BEGIN');
    await chiudiSessioneSql(scopeA);
    assert.equal(chiamate.at(-1).sql, 'ROLLBACK', 'terminare lo script annulla la transazione incompleta');
    await chiudiSessioneSql(scopeB);
    await st.disconnect();
  }
  console.log('  OK   Preproduzione: byte UTF-8, cursori, cronologia, SQL→MQL, JOIN e transazioni isolate');
  completato = true;
})();
module.exports.catch(err => { console.error(err); process.exitCode = 1; });
