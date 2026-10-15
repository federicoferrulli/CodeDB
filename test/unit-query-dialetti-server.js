'use strict';

const assert = require('node:assert/strict');
if (process.argv.includes('--mutant=bson')) require('node:module').registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/sqlEspressioni.js')) return result;
  const from = "if (e.tipo === 'valore') return { $literal: e.valore };";
  assert.ok(String(result.source).includes(from));
  return { ...result, source: String(result.source).replace(from, "if (e.tipo === 'valore') return { $literal: JSON.parse(JSON.stringify(e.valore)) };") };
} });
const { createModule } = require('../server/query');
const { payloadEsecuzione } = require('../db/payloadEsecuzione');

module.exports = (async () => {
  const chiamate = [];
  const strategy = { type: 'mongodb',
    mongoSqlRead: async (db, coll, p) => {
      const sql = require('../db/SqlToMql');
      chiamate.push({ db, coll, ...p, pipeline: require('bson').EJSON.stringify(sql.planToPipeline(sql.translate(p.sql))) });
      return { docs: [{ nome: 'Ada' }] };
    },
    collectionFind: async (db, coll, p) => { chiamate.push({ db, coll, ...p }); return { docs: [{ nome: 'Ada' }] }; },
    collectionAggregate: async (db, coll, p) => { chiamate.push({ db, coll, ...p }); return { docs: [{ totale: 3 }] }; },
  };
  const query = createModule({ config: { env: {} }, connessioni: {
    executeWithReconnect: (s, fn) => fn(s.strategy),
  }, dependencies: { DbFactory: { isSqlType: tipo => ['mysql', 'postgresql'].includes(tipo) } } });
  const esegui = code => query.executeQueryCode({ strategy }, payloadEsecuzione({ code, db: 'laboratorio', coll: 'utenti', engine: strategy.type }));
  const casi = [
    ['Commenti iniziali SQL→MQL', '-- documentazione\nSELECT nome FROM utenti', r => assert.equal(r.res.docs[0].nome, 'Ada')],
    ['Filtro MongoDB nativo', '{ nome: \'Ada\', eta: { $gte: 18 } }', () => assert.deepEqual(JSON.parse(chiamate.at(-1).filter), { nome: 'Ada', eta: { $gte: 18 } })],
    ['Pipeline MongoDB nativa con commento', '// aggregazione\n[{ $match: { nome: \'Ada\' } }, { $count: \'totale\' }]', () => assert.deepEqual(JSON.parse(chiamate.at(-1).pipeline), [{ $match: { nome: 'Ada' } }, { $count: 'totale' }])],
    ['Costruttore BSON nativo', '{ x: NumberLong("9007199254740993") }', () => assert.equal(JSON.parse(chiamate.at(-1).filter).x.$numberLong, '9007199254740993')],
    ['Intero nativo oltre 53 bit intatto', '{ x: 9007199254740993 }', () => assert.equal(JSON.parse(chiamate.at(-1).filter).x.$numberLong, '9007199254740993')],
    ['Costruttore BSON con argomento numerico', '{ x: NumberLong(9007199254740993) }', () => assert.equal(JSON.parse(chiamate.at(-1).filter).x.$numberLong, '9007199254740993')],
    ['Intero EJSON originale intatto', '{"x":9007199254740993}', () => assert(chiamate.at(-1).filter.includes('9007199254740993'))],
    ['Cursore shell toArray', 'db.utenti.find({}).toArray()', r => assert.equal(r.res.docs[0].nome, 'Ada')],
    ['SQL inviato intatto al runtime con catalogo', "SELECT HEX(X'00ff') AS valore FROM utenti", () => {
      assert.equal(chiamate.at(-1).sql,"SELECT HEX(X'00ff') AS valore FROM utenti");
      assert.ok(chiamate.at(-1).pipeline.includes('"$binary"')); assert.ok(chiamate.at(-1).pipeline.includes('"base64":"AP8="'));
    }],
  ];
  let falliti = 0;
  for (const [nome, code, verifica] of casi) {
    try { verifica(await esegui(code)); console.log(`  OK   ${nome}`); }
    catch (err) { falliti++; console.error(`  FAIL ${nome}: ${err.message}`); }
  }
  await assert.rejects(esegui('[{ $project: { x: { $function: { body: "x", args: [], lang: "js" } } } }]'), /JavaScript|vietat|consentit/i);
  await assert.rejects(esegui('db.utenti.find({}, {}, {let:{x:{$function:{body:"x",args:[],lang:"js"}}}})'), /JavaScript|vietat|consentit/i);
  for (const tipo of ['mysql', 'postgresql']) {
    strategy.type = tipo;
    const code = tipo === 'postgresql' ? "SELECT doc#>>'{a,b}' FROM utenti" : 'SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1';
    await esegui(code);
    assert.equal(chiamate.at(-1).pipeline, code, `${tipo}: SQL trasmesso intatto`);
    console.log(`  OK   ${tipo}: SQL trasmesso intatto alla strategia`);
  }
  strategy.type = 'mysql';
  await esegui('/*! SELECT 1 */');
  assert.equal(chiamate.at(-1).pipeline, '/*! SELECT 1 */');
  if (falliti) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; });
