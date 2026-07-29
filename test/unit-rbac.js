'use strict';

// Test unitari del motore RBAC: classificazione delle operazioni, decisione dei
// permessi e Proxy autorizzante sulle strategie. Nessun database e nessun
// socket: sono eseguiti anche da `npm test`.
// Il gate HTTP del gateway MCP è provato a parte in test/unit-mcp-auth.js.

const assert = require('assert');

const { ROOT_PRINCIPAL, makePrincipal } = require('../auth/principal');
const { eventCapability, matchesAny } = require('../auth/capabilities');
const { can, allowedConnections, canUseConnection, canWholeConnection } = require('../auth/permissions');
const { guardStrategy } = require('../auth/guardStrategy');

console.log('--- Test Unitari RBAC ---');

/* --- Classificazione degli eventi -------------------------------------------- */

assert.strictEqual(eventCapability('collection:find', {}, null), 'read');
assert.strictEqual(eventCapability('doc:insert', {}, null), 'write');
assert.strictEqual(eventCapability('doc:delete', {}, null), 'delete');
assert.strictEqual(eventCapability('collection:deleteMany', {}, null), 'delete');
assert.strictEqual(eventCapability('db:drop', {}, null), 'ddl');
assert.strictEqual(eventCapability('index:create', {}, null), 'ddl');
assert.strictEqual(eventCapability('mongo:disconnect', {}, null), null, 'eventi non classificati non richiedono capability');
// collection:aggregate è ambiguo: dipende da strategia e codice, come per l'audit.
const sqlSess = { strategy: { type: 'mysql' } };
const mongoSess = { strategy: { type: 'mongodb' } };
assert.strictEqual(eventCapability('collection:aggregate', { pipeline: 'SELECT 1' }, sqlSess), 'read');
assert.strictEqual(eventCapability('collection:aggregate', { pipeline: 'DELETE FROM t' }, sqlSess), 'write');
assert.strictEqual(eventCapability('collection:aggregate', { pipeline: '[{"$match":{}}]' }, mongoSess), 'read');
assert.strictEqual(eventCapability('collection:aggregate', { pipeline: '[{"$out":"copia"}]' }, mongoSess), 'write');
console.log('  OK   Classificazione eventi → capability');

/* --- Match glob dello scope --------------------------------------------------- */

assert.ok(matchesAny(['orders*'], 'orders_2024'));
assert.ok(!matchesAny(['orders*'], 'customers'));
assert.ok(matchesAny(['*'], 'qualsiasi'));
assert.ok(matchesAny([], 'senza limiti'), 'lista vuota = nessun limite');
assert.ok(matchesAny(['a', 'b*'], 'bravo'));
assert.ok(!matchesAny(['Orders*'], 'orders'), 'il match è case-sensitive');
console.log('  OK   Match glob dello scope');

/* --- Decisione dei permessi --------------------------------------------------- */

const viewer = makePrincipal(
  { _id: 'u1', type: 'subuser', ownerId: 'o1', email: 'v@x.it' },
  [{ connName: 'prod', role: 'viewer', capabilities: ['read'], scope: { databases: ['shop'], collections: ['orders*'] } }],
);
const editor = makePrincipal(
  { _id: 'u2', type: 'subuser', ownerId: 'o1', email: 'e@x.it' },
  [{ connName: 'prod', role: 'editor', capabilities: ['read', 'write'], scope: null }],
);
const owner = makePrincipal({ _id: 'o1', type: 'owner', ownerId: 'o1', email: 'o@x.it' }, []);

assert.ok(can(ROOT_PRINCIPAL, { connName: 'x', capability: 'manage' }), 'root può tutto (RBAC spento)');
assert.ok(can(viewer, { connName: 'prod', capability: 'read', db: 'shop', coll: 'orders_2024' }));
assert.ok(!can(viewer, { connName: 'prod', capability: 'read', db: 'shop', coll: 'customers' }), 'collezione fuori scope');
assert.ok(!can(viewer, { connName: 'prod', capability: 'read', db: 'altro', coll: 'orders' }), 'database fuori scope');
assert.ok(!can(viewer, { connName: 'prod', capability: 'write', db: 'shop', coll: 'orders' }), 'viewer non scrive');
assert.ok(!can(viewer, { connName: 'staging', capability: 'read' }), 'connessione senza grant');
assert.ok(!can(viewer, { capability: 'manage' }), 'nessuna amministrazione senza connessione');
assert.ok(can(editor, { connName: 'prod', capability: 'write', db: 'qualsiasi', coll: 'qualsiasi' }), 'grant senza scope');
assert.ok(!can(editor, { connName: 'prod', capability: 'delete' }), 'editor non cancella');
assert.ok(can(owner, { connName: 'prod', capability: 'manage' }), 'l\'owner amministra il proprio tenant');
console.log('  OK   Decisione dei permessi (can)');

// Le API key possono restringere ulteriormente le connessioni raggiungibili.
const keyOwner = makePrincipal({ _id: 'o1', type: 'owner', ownerId: 'o1', email: 'o@x.it' }, [], ['prod']);
assert.ok(can(keyOwner, { connName: 'prod', capability: 'read' }));
assert.ok(!can(keyOwner, { connName: 'staging', capability: 'read' }), 'connScope della API key rispettato');
assert.deepStrictEqual(allowedConnections(viewer, ['prod', 'staging']), ['prod']);
assert.deepStrictEqual(allowedConnections(owner, ['prod', 'staging']), ['prod', 'staging']);
assert.deepStrictEqual(allowedConnections(keyOwner, ['prod', 'staging']), ['prod']);
assert.ok(canUseConnection(viewer, 'prod') && !canUseConnection(viewer, 'staging'));
// Backup/restore: servono capability e nessuno scope, non applicabile su quel percorso.
assert.ok(!canWholeConnection(viewer, 'prod', 'read'), 'con scope non si fa backup');
assert.ok(canWholeConnection(editor, 'prod', 'read'), 'senza scope il backup è ammesso');
console.log('  OK   API key, filtri e operazioni sull\'intera connessione');

/* --- Proxy autorizzante ------------------------------------------------------- */

function fakeStrategy() {
  const calls = [];
  return {
    type: 'mongodb',
    currentDb: null,
    calls,
    async listDatabases() { return [{ name: 'shop' }, { name: 'altro' }]; },
    async listCollections(db) { calls.push(['listCollections', db]); return [{ name: 'orders' }, { name: 'customers' }]; },
    async dbSchema() {
      return {
        collections: [{ name: 'orders' }, { name: 'customers' }],
        relations: [{ from: 'orders', to: 'customers' }],
      };
    },
    async search() { return [{ name: 'shop', collections: [{ name: 'orders' }, { name: 'customers' }] }]; },
    async collectionFind(db, coll) { calls.push(['find', db, coll]); return { docs: [] }; },
    async docInsert(db, coll) { calls.push(['insert', db, coll]); return { inserted: 1 }; },
    async renameCollection(db, coll, newName) { calls.push(['rename', db, coll, newName]); return {}; },
    async collectionAggregate(db, coll, payload) { calls.push(['aggregate', payload.pipeline]); return { docs: [] }; },
    async health() { return { latencyMs: 1 }; },
  };
}

(async () => {
  const raw = fakeStrategy();
  assert.strictEqual(guardStrategy(raw, null), raw, 'senza contesto la strategia non viene avvolta');
  assert.strictEqual(guardStrategy(raw, { principal: ROOT_PRINCIPAL }), raw, 'root: nessun Proxy, zero overhead');

  const guarded = guardStrategy(fakeStrategy(), { principal: viewer, connName: 'prod' });

  assert.strictEqual(guarded.type, 'mongodb', 'le proprietà passano invariate');
  guarded.currentDb = 'shop';
  assert.strictEqual(guarded.currentDb, 'shop', 'la scrittura di currentDb funziona (Query Engine)');
  assert.deepStrictEqual(await guarded.health(), { latencyMs: 1 }, 'i metodi non classificati passano');

  await guarded.collectionFind('shop', 'orders', {});
  await assert.rejects(() => guarded.collectionFind('shop', 'customers', {}), /Permesso negato/, 'lettura fuori scope negata');
  await assert.rejects(() => guarded.docInsert('shop', 'orders', {}), /Permesso negato/, 'scrittura negata al viewer');
  await assert.rejects(() => guarded.collectionFind('altro', 'orders', {}), /Permesso negato/, 'database fuori scope negato');

  // Le liste di navigazione non vengono negate ma filtrate.
  assert.deepStrictEqual(await guarded.listDatabases(), [{ name: 'shop' }], 'listDatabases filtrata');
  assert.deepStrictEqual(await guarded.listCollections('shop'), [{ name: 'orders' }], 'listCollections filtrata');
  const schema = await guarded.dbSchema('shop');
  assert.deepStrictEqual(schema.collections, [{ name: 'orders' }], 'dbSchema filtrato');
  assert.deepStrictEqual(schema.relations, [], 'relazioni verso collezioni nascoste rimosse');
  const found = await guarded.search('o');
  assert.deepStrictEqual(found[0].collections, [{ name: 'orders' }], 'search filtrata');

  // La destinazione di una rename deve rientrare nello scope quanto l'origine.
  const guardedAdmin = guardStrategy(fakeStrategy(), {
    principal: makePrincipal(
      { _id: 'u3', type: 'subuser', ownerId: 'o1', email: 'a@x.it' },
      [{ connName: 'prod', role: 'admin', capabilities: ['read', 'ddl'], scope: { databases: ['shop'], collections: ['orders*'] } }],
    ),
    connName: 'prod',
  });
  await guardedAdmin.renameCollection('shop', 'orders', 'orders_old');
  await assert.rejects(() => guardedAdmin.renameCollection('shop', 'orders', 'clienti'),
    /Permesso negato/, 'rename verso un nome fuori scope negata');

  // collection:aggregate: la stessa firma è lettura o scrittura secondo il codice.
  const guardedEditor = guardStrategy(fakeStrategy(), { principal: editor, connName: 'prod' });
  await guardedEditor.collectionAggregate('shop', 'orders', { pipeline: '[{"$match":{}}]' });
  const guardedViewerAgg = guardStrategy(fakeStrategy(), { principal: viewer, connName: 'prod' });
  await guardedViewerAgg.collectionAggregate('shop', 'orders', { pipeline: '[{"$match":{}}]' });
  await assert.rejects(() => guardedViewerAgg.collectionAggregate('shop', 'orders', { pipeline: '[{"$out":"copia"}]' }),
    /Permesso negato/, 'pipeline di scrittura negata al viewer');
  console.log('  OK   Proxy autorizzante sulle strategie');

  console.log('\nTutti i test unitari RBAC superati!');
})().catch((err) => {
  console.error('  FAIL', err && err.message);
  process.exitCode = 1;
});
