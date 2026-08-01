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
    async shellWrite(db, coll, payload) { calls.push(['shellWrite', db, coll, payload.op]); return { ok: 1 }; },
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
    await assert.rejects(() => editorScript.shellWrite('shop', 'orders', { op: 'deleteMany', filter: '{}' }),
      /Permesso negato/, 'deleteMany da script negato a chi non ha la capability delete');

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
    ];
    for (const q of scritture) {
      assert.strictEqual(isWriteSql(q), true, `scrittura da riconoscere: ${q}`);
    }
    console.log('  OK   Classificazione SQL lettura/scrittura senza bypass (CDB-02)');
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
      .collectionAggregate('public', null, { pipeline: 'DELETE FROM t' });
    assert.ok(!seen[0].expectRead, 'scrittura riconosciuta: nessuna transazione di sola lettura');

    seen.length = 0;
    await guardStrategy(pgStrategy(), { principal: own, connName: 'prod' })
      .collectionAggregate('public', null, { pipeline: 'SELECT elabora_ordini()' });
    assert.ok(!seen[0].expectRead, 'owner: comportamento invariato (funzioni con effetti collaterali, temp table, SET)');
    console.log('  OK   Barriera READ ONLY per i sottoutenti, owner invariato (CDB-02)');
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

  console.log('\nTutti i test unitari RBAC superati!');
})().catch((err) => {
  console.error('  FAIL', err && err.message);
  process.exitCode = 1;
});
