'use strict';

const assert = require('assert/strict');
const conteggi = require('../db/conteggiNavigatore');
// Mutazione solo in memoria: riproduce il falso zero senza modificare i sorgenti.
if (process.argv.includes('--mutant')) conteggi.conteggioLimitato = () => ({ count: 0, countApprox: false });
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const MySqlStrategy = require('../db/MySqlStrategy');
const MongoDbStrategy = require('../db/MongoDbStrategy');

const catalogo = [
  { name: 'Prova', ttype: 'BASE TABLE', cnt: -1, actual: 3 },
  { name: 'vuota', ttype: 'BASE TABLE', cnt: 0, actual: 0 },
  { name: 'vecchia', ttype: 'BASE TABLE', cnt: 4, actual: 9 },
  { name: 'grande', ttype: 'BASE TABLE', cnt: 2500000, actual: 2500042 },
  { name: 'appena_importata', ttype: 'BASE TABLE', cnt: null, actual: 200000 },
  { name: 'limite', ttype: 'BASE TABLE', cnt: 999, actual: 1000 },
  { name: 'vista', ttype: 'VIEW', cnt: 0, actual: 3000000 },
  { name: 'lenta', ttype: 'BASE TABLE', cnt: 50, error: true },
  { name: 'negata', ttype: 'BASE TABLE', cnt: null, error: true },
  { name: 'strana"`', ttype: 'BASE TABLE', cnt: 0, actual: 2 },
];

function fixtureSql(Strategy) {
  const pg = Strategy === PostgreSqlStrategy;
  const s = new Strategy(), calls = [], lifecycle = [];
  let active = 0, peak = 0;
  const result = rows => pg ? { rows } : [rows];
  const query = async (input, params) => {
    const sql = typeof input === 'string' ? input : input.sql;
    calls.push({ sql, params });
    if (/information_schema\.tables/i.test(sql)) return result(catalogo.map(c => ({ ...c })));
    if (!/SELECT.*COUNT\(\*\)/i.test(sql)) { lifecycle.push(sql); return result([]); }
    assert.match(sql, /FROM \(SELECT 1 FROM .* LIMIT 1001\) AS campione/, 'Il limite deve precedere il COUNT');
    const row = catalogo.find(c => sql.includes(pg ? `"${c.name.replaceAll('"', '""')}"` : '`' + c.name.replaceAll('`', '``') + '`'));
    assert(row, 'Nome della tabella quotato e riconosciuto');
    assert(sql.includes(pg ? '"diego".' : '`diego`.'), 'Conteggio qualificato sullo schema richiesto');
    assert.notEqual(row.name, 'grande', 'Le tabelle grandi usano solo i metadati');
    assert.notEqual(row.name, 'vista', 'Nessuna scansione delle viste');
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    if (row.error) throw Object.assign(new Error('Conteggio troppo lento'), { code: pg ? '57014' : 'PROTOCOL_SEQUENCE_TIMEOUT' });
    return result([{ n: Math.min(row.actual, 1001) }]);
  };
  const conn = () => ({ query, threadId: 42, release() { lifecycle.push('release'); }, destroy() { lifecycle.push('destroy'); } });
  s.pool = { query, connect: async () => conn(), getConnection: async () => conn() };
  s.uccidiSulServer = async id => { assert.equal(id, 42); lifecycle.push('kill'); };
  return { s, calls, lifecycle, peak: () => peak };
}

module.exports = (async () => {
  for (const Strategy of [PostgreSqlStrategy, MySqlStrategy]) {
    const { s, calls, lifecycle, peak } = fixtureSql(Strategy);
    const rows = await s.listCollections('diego');
    const byName = name => rows.find(c => c.name === name);
    assert.equal(byName('Prova').count, 3, 'Una tabella appena popolata senza statistiche deve mostrare le sue 3 righe, non zero');
    for (const name of ['vuota', 'vecchia', 'limite', 'strana"`']) {
      assert.equal(byName(name).count, catalogo.find(c => c.name === name).actual);
      assert.equal(byName(name).countApprox, false);
    }
    assert.equal(byName('grande').count, 2500000);
    assert.equal(byName('grande').countApprox, true);
    assert.equal(byName('appena_importata').countLowerBound, true);
    assert.equal(byName('appena_importata').count, 1001, 'Il campione non è il totale');
    assert.equal(byName('lenta').count, 50);
    assert.equal(byName('lenta').countApprox, true);
    assert.equal(byName('negata').count, null);
    assert.equal(byName('vista').count, null);
    assert(peak() <= 2);
    if (Strategy === PostgreSqlStrategy) {
      assert(lifecycle.includes('ROLLBACK'));
      assert(lifecycle.some(sql => /^SET LOCAL statement_timeout = (?:[1-9]\d?|100)$/.test(sql)));
    } else {
      assert.equal(lifecycle.filter(x => x === 'destroy').length, 2, 'Connessioni scadute escluse dal pool');
      assert.equal(lifecycle.filter(x => x === 'kill').length, 2);
    }
    const prima = calls.length;
    const names = await s.listCollections('diego', { includeCounts: false });
    assert.equal(calls.length - prima, 1, 'Solo catalogo per palette e selettori');
    assert.equal(names.length, rows.length);
    console.log(`  OK   ${s.type}: piccoli esatti, grandi stimati, null/zero, viste, timeout, nomi quotati, massimo 2 query`);
  }

  const mongo = new MongoDbStrategy();
  let active = 0, peak = 0, scans = 0, estimates = 0;
  mongo.client = { db() { return {
    listCollections() { return { async toArray() { return catalogo.map(c => ({ name: c.name, type: c.ttype === 'VIEW' ? 'view' : 'collection' })); } }; },
    collection(name) {
      const c = catalogo.find(r => r.name === name);
      return {
        async estimatedDocumentCount(options) {
          assert.notEqual(c.ttype, 'VIEW'); assert(options.maxTimeMS > 0 && options.maxTimeMS <= 100);
          estimates++; active++; peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 2)); active--;
          return Math.max(0, c.cnt || 0);
        },
        async countDocuments(filter, options) {
          scans++; assert.deepEqual(filter, {}); assert.equal(options.limit, 1001); assert(options.maxTimeMS <= 100);
          assert.notEqual(name, 'grande');
          if (c.error) throw new Error('Timeout');
          return Math.min(c.actual, options.limit);
        },
      };
    },
  }; } };
  const mongoRows = await mongo.listCollections('diego');
  assert.equal(mongoRows.find(c => c.name === 'Prova').count, 3);
  assert.equal(mongoRows.find(c => c.name === 'grande').countApprox, true);
  assert.equal(mongoRows.find(c => c.name === 'lenta').count, 50);
  assert.equal(mongoRows.find(c => c.name === 'negata').count, null);
  assert(peak <= 2);
  const callsBefore = scans + estimates;
  await mongo.listCollections('diego', { includeCounts: false });
  assert.equal(scans + estimates, callsBefore);
  console.log('  OK   MongoDB: letture limitate, stime esplicite, viste escluse, solo nomi senza conteggi');

  let probes = 0;
  const many = Array.from({ length: 2000 }, (_, i) => ({ name: String(i), ...conteggi.stimaConteggio(null) }));
  const start = performance.now();
  await conteggi.completaConteggi(many, async (_coll, _limit, ms) => {
    probes++;
    await new Promise(resolve => setTimeout(resolve, ms));
    throw new Error('Timeout');
  });
  assert(probes <= 10, `Budget rispettato: ${probes} richieste per 2000 tabelle lente`);
  assert.equal(many.length, 2000, 'Il budget non tronca mai l’elenco delle tabelle');
  assert(many.every(c => c.count === null), 'L’assenza del conteggio non diventa zero');
  console.log(`  OK   2000 tabelle lente: ${probes} richieste, ${Math.round(performance.now() - start)} ms, elenco completo`);
})();
