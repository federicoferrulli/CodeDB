'use strict';
const assert = require('node:assert/strict');
if (process.argv.includes('--mutant')) require('node:module').registerHooks({ load(url, context, next) {
  const r = next(url, context);
  return url.endsWith('/MongoScriptRunner.js') ? { ...r, source: String(r.source).replace('if (opz.options) payload.options', 'if (false) payload.options') } : r;
} });
if (process.argv.includes('--mutant=replace')) require('node:module').registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/MongoScriptRunner.js')) return result;
  const from = 'findOneAndReplace: chiamabile';
  assert.ok(String(result.source).includes(from), 'Mutazione replace non applicata');
  return { ...result, source: String(result.source).replace(from, 'metodoAssente: chiamabile') };
} });
const { eseguiScript, sembraScriptJs } = require('../db/MongoScriptRunner');
const MongoShell = require('../db/MongoShell');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const { opzioniDriver } = require('../db/mongoOpzioni');
const { guardStrategy } = require('../auth/guardStrategy');
const { ROOT_PRINCIPAL } = require('../auth/principal');

module.exports = (async () => {
  let falliti = 0;
  async function prova(nome, fn) {
    try { await fn(); console.log(`  OK   ${nome}`); }
    catch (err) { falliti++; console.error(`  FAIL ${nome}: ${err.stack}`); }
  }
  await prova('Shell e script inoltrano collation, hint, tempo e batch al medesimo contratto', async () => {
    const code = 'db.c.find({}).collation({locale:"en", strength:2}).hint({nome:1}).maxTimeMS(20).batchSize(10).comment("prova")';
    const piano = MongoShell.translate(code);
    const calls = [];
    await eseguiScript(`${code}.toArray()`, { find: async (db, coll, p) => { calls.push(p); return { docs: [] }; } }, { db: 'test' });
    assert.deepEqual(JSON.parse(calls[0].options), piano.options);
    assert.equal(piano.options.collation.strength, 2);
    assert.equal(piano.options.maxTimeMS, 20);
    assert.deepEqual(piano.options.hint, { nome: 1 });
  });
  await prova('Le chiavi let e return dei documenti non cambiano interprete', () => {
    assert.equal(sembraScriptJs('db.c.find({return:1}, {}, {let:{x:1}})'), false);
    assert.equal(sembraScriptJs('SELECT let FROM t'), false);
    assert.equal(sembraScriptJs('const c = db.c.find({}); c.toArray()'), true);
  });
  await prova('Aggregate conserva l’ordine della catena e le opzioni', async () => {
    let payload;
    await eseguiScript('db.c.aggregate([], {allowDiskUse:true}).limit(2).sort({n:1}).toArray()', {
      aggregate: async (db, coll, p) => { payload = p; return { docs: [] }; },
    }, { db: 'test' });
    assert.deepEqual(JSON.parse(payload.pipeline), [{ $limit: 2 }, { $sort: { n: 1 } }]);
    assert.equal(JSON.parse(payload.options).allowDiskUse, true);
  });
  await prova('Il commento utente conserva l’identità di annullamento e non amplia il timeout', () => {
    assert.deepEqual(opzioniDriver({ maxTimeMS: 500, comment: 'utente' }, { runId: 'r1' }, 100), {
      maxTimeMS: 100, comment: { codedbRunId: 'r1', comment: 'utente' },
    });
    assert.equal(opzioniDriver({ maxTimeMS: 0 }, {}, 100).maxTimeMS, 100);
    assert.equal(opzioniDriver({ maxTimeMS: 10 }, {}, 100).maxTimeMS, 10);
  });
  await prova('bulkWrite attraversa il controllo host per ogni operazione e rispetta ordered', async () => {
    for (const ordered of [true, false]) {
      const calls = [];
      const host = { write: async (db, coll, p) => {
        calls.push(p.op);
        if (p.op === 'deleteOne') throw new Error('Permesso delete negato');
        return { inserted: 1 };
      } };
      await assert.rejects(() => eseguiScript(`db.c.bulkWrite([
        {insertOne:{document:{n:1}}}, {deleteOne:{filter:{n:2}}}, {insertOne:{document:{n:3}}}
      ], {ordered:${ordered}})`, host, { db: 'test' }), /Permesso delete negato/);
      assert.deepEqual(calls, ordered ? ['insertOne', 'deleteOne'] : ['insertOne', 'deleteOne', 'insertOne']);
    }
  });
  await prova('bulkWrite valida tutti i filtri prima della prima mutazione', async () => {
    let writes = 0;
    await assert.rejects(() => eseguiScript('db.c.bulkWrite([{insertOne:{document:{n:1}}},{deleteMany:{}}])', {
      write: async () => { writes++; },
    }, { db: 'test' }), /filtro obbligatorio/);
    assert.equal(writes, 0);
  });
  await prova('Il driver riceve pipeline di aggiornamento e opzioni delle cancellazioni', async () => {
    const calls = [];
    const strategy = new MongoDbStrategy();
    strategy.requireClient = () => ({ db: () => ({ listCollections: () => ({ toArray: async () => [] }), collection: () => ({
      updateMany: async (...args) => { calls.push(args); return { matchedCount: 1, modifiedCount: 1 }; },
      deleteOne: async (...args) => { calls.push(args); return { deletedCount: 1 }; },
      findOneAndUpdate: async () => ({ _id: 1, value: 'campo del documento' }),
    }) }) });
    await strategy.shellWrite('d', 'c', { op: 'updateMany', filter: '{}', update: '[{"$set":{"n":{"$add":["$n",1]}}}]', options: '{"upsert":true}' });
    assert(Array.isArray(calls[0][1]));
    assert.equal(calls[0][2].upsert, true);
    await strategy.shellWrite('d', 'c', { op: 'deleteOne', filter: '{}', options: '{"collation":{"locale":"en","strength":2}}' });
    assert.equal(Number(calls[1][1].collation.strength), 2);
    const r = await strategy.shellWrite('d', 'c', { op: 'findOneAndUpdate', filter: '{}', update: '{"$set":{"n":1}}' });
    assert.equal(r.doc.value, 'campo del documento');
  });
  await prova('Le opzioni non aggirano il divieto di JavaScript lato server', async () => {
    let chiamate = 0;
    const protetta = guardStrategy({ type: 'mongodb', collectionFind: async () => { chiamate++; } }, { principal: ROOT_PRINCIPAL, connName: 'test' });
    await assert.rejects(() => protetta.collectionFind('d', 'c', {
      filter: '{}', options: '{"let":{"x":{"$function":{"body":"x","args":[],"lang":"js"}}}}',
    }), /non consentito/);
    assert.equal(chiamate, 0);
  });
  await prova('findOneAndReplace richiede anche la lettura prima di arrivare al driver', async () => {
    const { makePrincipal } = require('../auth/principal');
    let calls = 0;
    const strategy = guardStrategy({ type: 'mongodb', shellWrite: async () => { calls++; } }, { connName: 'test',
      principal: makePrincipal({ _id: 'test', type: 'subuser', ownerId: 'owner' },
        [{ connName: 'test', capabilities: ['write'], scope: { databases: ['d'], collections: ['c'] } }]) });
    await assert.rejects(strategy.shellWrite('d', 'c', { op: 'findOneAndReplace', filter: '{}', doc: '{"n":1}' }), /Permesso negato/);
    assert.equal(calls, 0);
  });
  await prova('Lo script inoltra filtro, documento e opzioni di findOneAndReplace', async () => {
    const calls = [];
    await eseguiScript('db.c.findOneAndReplace({id:1},{n:2},{returnDocument:"after"})', {
      write: async (db, coll, payload) => { calls.push({ db, coll, payload }); return { doc: { n: 2 } }; },
    }, { db: 'd' });
    assert.equal(calls.length, 1); assert.equal(calls[0].payload.op, 'findOneAndReplace');
    assert.deepEqual(JSON.parse(calls[0].payload.doc), { n: 2 });
    assert.deepEqual(JSON.parse(calls[0].payload.options), { returnDocument: 'after' });
  });
  if (falliti) process.exitCode = 1;
})();
