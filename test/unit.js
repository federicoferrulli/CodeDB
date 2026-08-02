'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const VirtualJoinEngine = require('../db/VirtualJoinEngine');
const DbFactory = require('../db/DbFactory');
const DbStrategy = require('../db/DbStrategy');
const SshTunnel = require('../db/SshTunnel');

console.log('--- Test Unitari CodeDB ---');

(async () => {
  // Test 1: DbFactory instanziamento e helper
  const mongoStrategy = DbFactory.getStrategy('mongodb');
  assert.strictEqual(mongoStrategy.type, 'mongodb', 'MongoDbStrategy type deve essere mongodb');
  console.log('  OK   DbFactory MongoDB strategy instantiation passed');

  const mysqlStrategy = DbFactory.getStrategy('mysql');
  assert.strictEqual(mysqlStrategy.type, 'mysql', 'MySqlStrategy type deve essere mysql');
  console.log('  OK   DbFactory MySQL strategy instantiation passed');

  const pgStrategy = DbFactory.getStrategy('postgresql');
  assert.strictEqual(pgStrategy.type, 'postgresql', 'PostgreSqlStrategy type deve essere postgresql');
  console.log('  OK   DbFactory PostgreSQL strategy instantiation passed');

  const pgAliasStrategy = DbFactory.getStrategy('postgres');
  assert.strictEqual(pgAliasStrategy.type, 'postgresql', 'PostgreSqlStrategy alias postgres passed');
  console.log('  OK   DbFactory Postgres alias passed');

  assert.throws(() => DbFactory.getStrategy('unsupported_db'), /Tipo di database non supportato/, 'DbFactory deve lanciare errore su db non supportato');
  console.log('  OK   DbFactory unsupported db check passed');

  assert.strictEqual(DbFactory.defaultPort('mongodb'), 27017, 'Porta default MongoDB = 27017');
  assert.strictEqual(DbFactory.defaultPort('mysql'), 3306, 'Porta default MySQL = 3306');
  assert.strictEqual(DbFactory.defaultPort('postgresql'), 5432, 'Porta default PostgreSQL = 5432');
  console.log('  OK   DbFactory defaultPort passed');

  assert.strictEqual(DbFactory.isSqlType('mysql'), true, 'mysql isSqlType deve essere true');
  assert.strictEqual(DbFactory.isSqlType('postgresql'), true, 'postgresql isSqlType deve essere true');
  assert.strictEqual(DbFactory.isSqlType('mongodb'), false, 'mongodb isSqlType deve essere false');
  console.log('  OK   DbFactory isSqlType passed');

  // Test 2: DbStrategy.detectRelations (euristica UML)
  const collections = [
    { name: 'users', fields: [{ name: '_id', types: ['objectId'] }, { name: 'name', types: ['string'] }] },
    { name: 'orders', fields: [{ name: '_id', types: ['objectId'] }, { name: 'user_id', types: ['objectId'] }, { name: 'total', types: ['number'] }] }
  ];
  const relations = DbStrategy.detectRelations(collections);
  assert.strictEqual(relations.length, 1, 'Deve essere rilevata 1 relazione');
  assert.strictEqual(relations[0].from, 'orders', 'Relazione da orders');
  assert.strictEqual(relations[0].to, 'users', 'Relazione a users');
  assert.strictEqual(relations[0].field, 'user_id', 'Campo della relazione user_id');
  console.log('  OK   DbStrategy.detectRelations passed');

  // Test 3: VirtualJoinEngine check spec validation & in-memory join
  try {
    await VirtualJoinEngine.execute(null, null, null);
    assert.fail('Dovrebbe lanciare errore su spec nulla');
  } catch (err) {
    assert.strictEqual(err.message, 'Formato query Virtual Join non valido. Inserisci una struttura {"virtualJoin": ...}');
    console.log('  OK   VirtualJoinEngine spec null check passed');
  }

  try {
    await VirtualJoinEngine.execute({ virtualJoin: {} }, null, null);
    assert.fail('Dovrebbe lanciare errore su spec incompleta');
  } catch (err) {
    assert.strictEqual(err.message, 'Definizione Virtual Join incompleta: specificare sourceA, sourceB, on.leftKey e on.rightKey.');
    console.log('  OK   VirtualJoinEngine spec incomplete check passed');
  }

  const dummyStrategyA = {
    type: 'mysql',
    async collectionAggregate() {
      return { docs: [{ id: 101, user_id: 'usr_1', amount: 250 }] };
    }
  };
  const dummyStrategyB = {
    type: 'mongodb',
    async collectionAggregate() {
      return { docs: [{ _id: 'usr_1', username: 'mario', email: 'mario@test.com' }] };
    }
  };
  const vjSpec = {
    virtualJoin: {
      sourceA: { dbType: 'mysql', db: 'shop', table: 'orders' },
      sourceB: { dbType: 'mongodb', db: 'crm', collection: 'users' },
      on: { leftKey: 'user_id', rightKey: '_id' },
      as: 'user_info'
    }
  };
  const vjResult = await VirtualJoinEngine.execute(vjSpec, dummyStrategyA, dummyStrategyB);
  assert.strictEqual(vjResult.length, 1, 'VirtualJoinEngine deve ritornare 1 elemento unito');
  assert.strictEqual(vjResult[0].user_info.username, 'mario', 'Cross-DB merge dati corretto');
  console.log('  OK   VirtualJoinEngine in-memory cross-DB join passed');

  // Test 3b: JOIN su chiavi ObjectId (EJSON {$oid}). Regressione: prima le
  // chiavi oggetto collassavano in "[object Object]" e il $in su B non
  // matchava mai (joined_data null). B applica davvero il $match per simulare
  // il comportamento reale di MongoDB.
  const oid = '507f1f77bcf86cd799439011';
  const stratOidA = {
    type: 'mongodb',
    async collectionAggregate() {
      return { docs: [{ _id: { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, userId: { $oid: oid }, tot: 10 }] };
    }
  };
  const usersOidB = [{ _id: { $oid: oid }, name: 'Mario' }];
  const stratOidB = {
    type: 'mongodb',
    async collectionAggregate(db, coll, payload) {
      const pipeline = JSON.parse(payload.pipeline);
      const inList = pipeline[0].$match._id.$in;
      // Nel path Mongo→Mongo il $in contiene wrapper {$oid: hex}: la chiave
      // deve essere l'esadecimale reale, non "[object Object]".
      assert.ok(
        inList.every((k) => k && typeof k === 'object' && /^[0-9a-fA-F]{24}$/.test(k.$oid)),
        'Il $in deve contenere ObjectId {$oid: hex}, non "[object Object]"'
      );
      return { docs: usersOidB.filter((u) => inList.some((k) => k.$oid === u._id.$oid)) };
    }
  };
  const oidSpec = {
    virtualJoin: {
      sourceA: { dbType: 'mongodb', db: 'd', collection: 'orders' },
      sourceB: { dbType: 'mongodb', db: 'd', collection: 'users' },
      on: { leftKey: 'userId', rightKey: '_id' }
    }
  };
  const oidResult = await VirtualJoinEngine.execute(oidSpec, stratOidA, stratOidB);
  assert.ok(oidResult[0].joined_data, 'JOIN su chiave ObjectId deve trovare il match (joined_data non null)');
  assert.strictEqual(oidResult[0].joined_data.name, 'Mario', 'Merge su chiave ObjectId corretto');
  console.log('  OK   VirtualJoinEngine join su chiavi ObjectId ($oid) passed');

  // Test 3b2: JOIN su chiave $numberLong (Mongo Long). Il $in lato B deve
  // ricevere il wrapper EJSON tipizzato {$numberLong}, non la stringa nuda,
  // altrimenti EJSON.parse non ricostruisce il Long e il match fallisce.
  const stratLongA = {
    type: 'mongodb',
    async collectionAggregate() {
      return { docs: [{ _id: { $oid: 'bbbbbbbbbbbbbbbbbbbbbbbb' }, ref: { $numberLong: '12345' }, tot: 7 }] };
    }
  };
  const stratLongB = {
    type: 'mongodb',
    async collectionAggregate(db, coll, payload) {
      const inList = JSON.parse(payload.pipeline)[0].$match.num.$in;
      assert.ok(
        inList.every((k) => k && typeof k === 'object' && k.$numberLong === '12345'),
        'Il $in deve contenere il wrapper tipizzato {$numberLong}, non la stringa nuda'
      );
      return { docs: [{ num: { $numberLong: '12345' }, label: 'ok' }] };
    }
  };
  const longSpec = {
    virtualJoin: {
      sourceA: { dbType: 'mongodb', db: 'd', collection: 'a' },
      sourceB: { dbType: 'mongodb', db: 'd', collection: 'b' },
      on: { leftKey: 'ref', rightKey: 'num' }
    }
  };
  const longResult = await VirtualJoinEngine.execute(longSpec, stratLongA, stratLongB);
  assert.ok(longResult[0].joined_data && longResult[0].joined_data.label === 'ok', 'JOIN su chiave $numberLong deve trovare il match');
  console.log('  OK   VirtualJoinEngine join su chiavi $numberLong passed');

  // Test 3c: maxPayloadSize non numerico non deve rompere/iniettare l'SQL.
  let capturedSql = '';
  const stratSqlA = {
    type: 'mysql',
    async collectionAggregate(db, table, payload) { capturedSql = payload.pipeline; return { docs: [] }; }
  };
  await VirtualJoinEngine.execute({
    virtualJoin: {
      sourceA: { dbType: 'mysql', db: 'shop', table: 'orders' },
      sourceB: { dbType: 'mysql', db: 'shop', table: 'users' },
      on: { leftKey: 'user_id', rightKey: 'id' },
      maxPayloadSize: '5; DROP TABLE users'
    }
  }, stratSqlA, stratSqlA);
  assert.ok(/LIMIT \d+\s*$/.test(capturedSql) && !/DROP/i.test(capturedSql), 'maxPayloadSize non numerico non deve iniettare SQL: LIMIT resta un intero, il resto è scartato');
  console.log('  OK   VirtualJoinEngine maxPayloadSize coercito a intero passed');

  // Test 4: Handling errore connessione PostgreSQL server offline
  try {
    const pgConn = await pgStrategy.connect({ host: 'localhost', database: 'postgres' });
    if (pgConn.ok) {
      console.log('  OK   PostgreSQL connect passed');
    }
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || (err.message && err.message.includes('ECONNREFUSED'))) {
      console.log('  OK   PostgreSQL connect error handled (PostgreSQL server non attivo in ambiente unit test)');
    } else {
      throw err;
    }
  }

  // Test 5: SshTunnel check
  assert.strictEqual(typeof SshTunnel.openSshTunnel, 'function', 'openSshTunnel deve essere una funzione');
  console.log('  OK   SshTunnel.openSshTunnel export passed');

  // Test 5b: AuditLog — la cache in memoria deve restare limitata (no memory
  // leak) pur preservando le voci più recenti e i filtri.
  {
    const { makeAuditor } = require('../db/AuditLog');
    const tmp = path.join(os.tmpdir(), `codedb-audit-unit-${process.pid}.log`);
    for (const f of [tmp, tmp + '.1']) { try { fs.unlinkSync(f); } catch { /* ignora */ } }
    const auditor = makeAuditor(tmp, 1024); // soglia file bassa: forza la rotazione
    for (let i = 0; i < 60000; i++) auditor.audit({ event: 'unit', n: i });
    const recent = auditor.readRecent({ limit: 2 });
    assert(recent.total <= 51000, `cache limitata: total=${recent.total} deve essere <= 51000 (no leak)`);
    assert(recent.total >= 50000, `cache non troppo aggressiva: total=${recent.total} deve essere >= 50000`);
    assert.strictEqual(recent.entries[0].n, 59999, 'la voce più recente deve essere preservata');
    assert.strictEqual(auditor.readRecent({ event: 'unit', limit: 3 }).entries.length, 3, 'i filtri devono continuare a funzionare');
    for (const f of [tmp, tmp + '.1']) { try { fs.unlinkSync(f); } catch { /* ignora */ } }
    console.log('  OK   AuditLog cache limitata (no memory leak) passed');
  }

  // Test 5c: AuditLog — isolamento multi-tenant dello Storico Azioni (CDB-07).
  // `ui-audit.log` è unico per installazione: readRecent deve poter restringere
  // la vista al tenant (ownerId) e al singolo soggetto (userId), e non deve mai
  // far trapelare le voci prive di identità a chi chiede una vista ristretta.
  {
    const { makeAuditor } = require('../db/AuditLog');
    const tmp = path.join(os.tmpdir(), `codedb-audit-tenant-${process.pid}.log`);
    for (const f of [tmp, tmp + '.1']) { try { fs.unlinkSync(f); } catch { /* ignora */ } }
    const auditor = makeAuditor(tmp);
    auditor.audit({ event: 'doc:insert', ownerId: 'A', userId: 'a1' });
    auditor.audit({ event: 'doc:insert', ownerId: 'A', userId: 'a2' });
    auditor.audit({ event: 'doc:insert', ownerId: 'B', userId: 'b1' });
    auditor.audit({ event: 'doc:insert' }); // voce storica, senza attore

    assert.strictEqual(auditor.readRecent({ limit: 100 }).total, 4, 'il root deve vedere tutte le voci');
    assert.strictEqual(auditor.readRecent({ ownerId: 'A', limit: 100 }).total, 2, 'l\'owner deve vedere solo il proprio tenant');
    assert.strictEqual(auditor.readRecent({ ownerId: 'A', userId: 'a1', limit: 100 }).total, 1, 'il sottoutente deve vedere solo le proprie azioni');
    assert.strictEqual(auditor.readRecent({ ownerId: 'B', limit: 100 }).total, 1, 'nessuna fuga di voci fra tenant');
    assert.strictEqual(
      auditor.readRecent({ ownerId: 'A', limit: 100 }).entries.every((e) => e.ownerId === 'A'), true,
      'le voci senza attore non devono comparire in una vista ristretta'
    );
    for (const f of [tmp, tmp + '.1']) { try { fs.unlinkSync(f); } catch { /* ignora */ } }
    console.log('  OK   AuditLog isolamento multi-tenant (CDB-07) passed');
  }

  // Test 5d: restore — un ripristino incompleto non deve mai risultare riuscito
  // (CDB-27), ma un layer che legittimamente non contiene righe sì.
  {
    const { checkApplied } = require('../backup/lib/restore');
    const layer = { manifest: { id: '20260731_full' } };
    const problems = [];

    checkApplied(problems, layer, { collection: 'ordini', count: 100 }, 100);
    assert.strictEqual(problems.length, 0, 'tutte le righe applicate: nessun problema');

    checkApplied(problems, layer, { collection: 'vuota', count: 0 }, 0);
    assert.strictEqual(problems.length, 0, 'collection vuota nel backup: ripristino legittimo');

    checkApplied(problems, layer, { collection: 'clienti', count: 500 }, 0, '500 righe rifiutate');
    assert.strictEqual(problems.length, 1, 'righe dichiarate e non applicate: errore');
    assert(/clienti/.test(problems[0]) && /500/.test(problems[0]), 'il messaggio deve nominare tabella e conteggio atteso');

    checkApplied(problems, layer, { collection: 'storico' }, 0);
    assert.strictEqual(problems.length, 1, 'manifest storico senza count: nessuna asserzione possibile');
    console.log('  OK   Restore: verifica di completezza (CDB-27) passed');
  }

  // Test 5e: il sink di backup deve propagare gli errori invece di bloccarsi
  // (CDB-46). Con la vecchia catena di .pipe() un errore di scrittura lasciava
  // close() in attesa per sempre: backup fermo, nessun messaggio, client appeso.
  {
    const { createFileSink } = require('../backup/lib/util');

    // Percorso felice: byte e checksum coerenti.
    const okPath = path.join(os.tmpdir(), `codedb-sink-ok-${process.pid}.ndjson.gz`);
    const sink = createFileSink(okPath, { compress: true, level: 1 });
    for (let i = 0; i < 2000; i++) {
      const pending = sink.writeLine(JSON.stringify({ i }));
      if (pending) await pending;
    }
    const meta = await sink.close();
    assert(meta.bytes > 0, 'il sink deve riportare i byte scritti');
    assert.strictEqual(meta.sha256.length, 64, 'il sink deve riportare uno SHA-256');
    assert(fs.statSync(okPath).size > 0, 'il file di backup deve esistere e non essere vuoto');
    try { fs.unlinkSync(okPath); } catch { /* ignora */ }

    // Errore asincrono di scrittura (target non scrivibile): close() deve
    // rigettare, non restare appesa.
    const dirPath = path.join(os.tmpdir(), `codedb-sink-dir-${process.pid}`);
    fs.mkdirSync(dirPath, { recursive: true });
    const badSink = createFileSink(dirPath, { compress: true });
    await assert.rejects(
      (async () => { const p = badSink.writeLine('{"a":1}'); if (p) await p; await badSink.close(); })(),
      'un errore di scrittura deve emergere come rigetto, non come blocco'
    );
    try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* ignora */ }
    console.log('  OK   Sink di backup: errori propagati, nessun blocco (CDB-46) passed');
  }

  // Test 5f: politiche sulle destinazioni richieste da un client (CDB-06/CDB-43).
  // Percorso locale confinato, storage cloud solo per alias pre-approvati,
  // webhook solo verso Slack: dal socket e dal gateway MCP non si deve poter
  // scrivere fuori dalla cartella dei backup né esfiltrare un database.
  {
    const { resolveBackupPath, resolveStorageAlias, resolveSlackWebhook } = require('../backup/lib/policy');
    const root = path.join(os.tmpdir(), 'codedb-backups-root');

    assert.strictEqual(resolveBackupPath('', root), path.resolve(root), 'percorso vuoto = radice dei backup');
    assert.strictEqual(resolveBackupPath('gruppo/2026', root), path.resolve(root, 'gruppo/2026'), 'sottocartella consentita');
    assert.throws(() => resolveBackupPath('../fuori', root), /non consentito/, 'risalita con .. rifiutata');
    assert.throws(() => resolveBackupPath('gruppo/../../fuori', root), /non consentito/, 'risalita mascherata rifiutata');
    assert.throws(() => resolveBackupPath(path.resolve(os.tmpdir(), 'altrove'), root), /non consentito/, 'percorso assoluto rifiutato');

    const prevStorage = process.env.CODEDB_BACKUP_STORAGE;
    delete process.env.CODEDB_BACKUP_STORAGE;
    assert.strictEqual(resolveStorageAlias(''), null, 'nessuno storage richiesto: nessuno storage');
    assert.throws(() => resolveStorageAlias('s3://bucket-attaccante/exfil'), /non configurato/, 'senza alias configurati lo storage cloud è disattivato');
    process.env.CODEDB_BACKUP_STORAGE = 'archivio=s3://bucket-aziendale/backup';
    assert.strictEqual(resolveStorageAlias('archivio'), 's3://bucket-aziendale/backup', 'alias approvato risolto');
    assert.throws(() => resolveStorageAlias('s3://bucket-attaccante/exfil'), /non consentita/, 'URI arbitrario rifiutato anche con alias configurati');
    if (prevStorage === undefined) delete process.env.CODEDB_BACKUP_STORAGE;
    else process.env.CODEDB_BACKUP_STORAGE = prevStorage;

    const prevHook = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    assert.strictEqual(resolveSlackWebhook(''), null, 'nessun webhook configurato né richiesto');
    assert.strictEqual(resolveSlackWebhook('https://hooks.slack.com/services/T/B/X'), 'https://hooks.slack.com/services/T/B/X', 'webhook Slack accettato');
    assert.throws(() => resolveSlackWebhook('http://169.254.169.254/latest/meta-data/'), /non consentito/, 'URL arbitrario (SSRF) rifiutato');
    assert.throws(() => resolveSlackWebhook('https://hooks.slack.com.evil.test/x'), /non consentito/, 'dominio simile a Slack rifiutato');
    if (prevHook === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = prevHook;

    console.log('  OK   Destinazioni di backup confinate (CDB-06/CDB-43) passed');
  }

  // Test 5g: tetto sui risultati (CDB-11). Il cap sulle righe è deciso dal
  // server (maxRows è rimosso dai payload del client) e il budget di byte ferma
  // la lettura quando poche righe enormi la farebbero esplodere.
  {
    const DbStrategyMod = require('../db/DbStrategy');
    const cap = DbStrategyMod.resultCap;

    assert.strictEqual(cap({}), 500, 'senza maxRows vale il default della griglia');
    assert.strictEqual(cap({ maxRows: 10000 }), 10000, 'il Query Engine può alzare il tetto');
    assert.strictEqual(cap({ maxRows: 10 ** 9 }), 100000, 'il ceiling assoluto resta invalicabile');

    // Budget di byte: 20 documenti da ~1 KB con budget 5 KB → si tronca.
    const big = Array.from({ length: 20 }, (_, i) => ({ i, blob: 'x'.repeat(1024) }));
    const cut = DbStrategyMod.truncateBySize(big, 5 * 1024);
    assert(cut.truncated, 'il budget di byte deve troncare i risultati troppo grandi');
    assert(cut.rows.length > 0 && cut.rows.length < big.length, 'si conserva almeno una riga, ma non tutte');
    assert.strictEqual(DbStrategyMod.truncateBySize(big, 0).truncated, false, 'budget 0 = controllo disabilitato');

    // Stessa regola sul cursore: si smette di leggere, non si tronca a valle.
    async function* cursorOf(items) { for (const it of items) yield it; }
    const collected = await DbStrategyMod.collectCapped(cursorOf(big), 1000, 5 * 1024);
    assert(collected.truncated, 'il cursore deve fermarsi al budget di byte');
    assert(collected.docs.length < big.length, 'non tutti i documenti devono essere letti');
    const byRows = await DbStrategyMod.collectCapped(cursorOf(big), 3, 0);
    assert.strictEqual(byRows.docs.length, 3, 'il tetto sulle righe resta rispettato');
    assert.strictEqual(byRows.truncated, true, 'e viene segnalato come troncamento');
    console.log('  OK   Tetto righe/byte sui risultati (CDB-11) passed');
  }

  // Test 5h: il restore esegue il DDL contenuto nel backup, quindi deve prima
  // validarlo (CDB-28). Si valida per forma e per tabella attesa, non per numero
  // di statement: un DDL legittimo può includere anche indici e vincoli.
  {
    const { assertSafeSchemaSql } = require('../backup/lib/restore');

    // Accettati: la definizione della tabella attesa, anche su più statement.
    assertSafeSchemaSql('CREATE TABLE `ordini` (id INT PRIMARY KEY);', 'ordini');
    assertSafeSchemaSql('CREATE TABLE "ordini" (id int);\nCREATE INDEX idx ON ordini (id);', 'ordini');
    assertSafeSchemaSql('CREATE TABLE ordini (id int);\nALTER TABLE ordini ADD COLUMN nota text;', 'ordini');
    // Commenti e stringhe non devono confondere l'analisi.
    assertSafeSchemaSql("/* backup CodeDB */\nCREATE TABLE ordini (nota text DEFAULT 'GRANT ALL; DROP TABLE x');", 'ordini');

    // Rifiutati: comandi che non sono definizioni di tabella.
    assert.throws(() => assertSafeSchemaSql('CREATE TABLE ordini (id int); GRANT ALL PRIVILEGES ON *.* TO evil;', 'ordini'),
      /non è una definizione di tabella valida/, 'GRANT nascosto in coda al DDL rifiutato');
    assert.throws(() => assertSafeSchemaSql('DROP DATABASE produzione;', 'ordini'),
      /non è una definizione di tabella valida/, 'DROP DATABASE rifiutato');
    assert.throws(() => assertSafeSchemaSql('CREATE TABLE altra_tabella (id int);', 'ordini'),
      /un'altra tabella/, 'DDL che crea una tabella diversa da quella attesa rifiutato');
    assert.throws(() => assertSafeSchemaSql('   ', 'ordini'), /vuoto/, 'file di schema vuoto rifiutato');

    // Deroga esplicita dell'operatore (solo da CLI): il DDL passa.
    assert.strictEqual(
      assertSafeSchemaSql('GRANT ALL ON *.* TO evil;', 'ordini', { allowUnsafeSchema: true }),
      'GRANT ALL ON *.* TO evil;',
      'con --allow-unsafe-schema la scelta resta all\'operatore'
    );
    console.log('  OK   Validazione del DDL nel backup (CDB-28) passed');
  }

  // Test 5i: nomi creabili da CodeDB (CDB-57). I DBMS accettano identificatori
  // arbitrari se quotati, quindi un nome di database poteva contenere markup e
  // finire nel DOM della sidebar: XSS stored attivabile con la sola capability
  // `ddl`. I nomi PREESISTENTI restano validi — qui si vieta solo di crearne.
  {
    const { assertCreatableName } = require('../db/DbStrategy');

    for (const n of ['shop', 'my_db', 'my-db', 'my.db', 'negozio_2026', 'Città', 'データベース']) {
      assertCreatableName(n, 'del database'); // nomi legittimi: non devono essere rifiutati
    }

    const pericolosi = [
      '<img src=x onerror=alert(1)>',
      'a"b', "a'b", 'a`b', 'a;b', 'a\\b', 'a<b', 'a&b',
      'a\nb', 'a b', '   ', '',
    ];
    for (const n of pericolosi) {
      assert.throws(() => assertCreatableName(n, 'del database'), /non valido|mancante/,
        `nome pericoloso rifiutato: ${JSON.stringify(n)}`);
    }
    console.log('  OK   Nomi creabili senza markup/quoting (CDB-57) passed');
  }

  // Test 5j: distribuzione Electron — l'AppUserModelID impostato nel processo
  // principale DEVE coincidere con `build.appId`, che è quello che l'installer
  // NSIS scrive nel collegamento del menu Start. Se i due divergono, Windows
  // tratta il collegamento appuntato e la finestra aperta come due applicazioni
  // diverse e l'icona compare DUPLICATA nella barra: è un difetto silenzioso,
  // visibile solo dopo aver installato, quindi va bloccato qui.
  {
    const pkg = require('../package.json');
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron-main.js'), 'utf8');

    assert.ok(pkg.build, 'package.json deve contenere la configurazione "build" di electron-builder');
    assert.ok(pkg.build.appId, 'build.appId deve essere definito');

    const m = mainSrc.match(/setAppUserModelId\(\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*\)/);
    assert.ok(m, 'electron-main.js deve chiamare app.setAppUserModelId(...)');
    let used = m[1];
    if (!/^['"]/.test(used)) {
      // Costante: risolvi la sua dichiarazione.
      const decl = mainSrc.match(new RegExp(`const\\s+${used}\\s*=\\s*['"]([^'"]+)['"]`));
      assert.ok(decl, `la costante ${used} passata a setAppUserModelId deve essere dichiarata con un valore letterale`);
      used = `'${decl[1]}'`;
    }
    assert.strictEqual(used.slice(1, -1), pkg.build.appId,
      `l'AppUserModelID di electron-main.js (${used}) deve coincidere con build.appId (${pkg.build.appId})`);

    // Va impostato PRIMA di qualunque finestra: se comparisse dentro main() o
    // dopo createWindow(), i dialog di errore e la finestra principale
    // nascerebbero senza identità e finirebbero in un gruppo separato.
    const idxSet = mainSrc.indexOf('setAppUserModelId');
    const idxWindow = mainSrc.indexOf('new BrowserWindow');
    assert.ok(idxSet > -1 && idxSet < idxWindow,
      'setAppUserModelId deve precedere la creazione della finestra nel sorgente');

    // I segreti non devono finire dentro l'installer.
    for (const escluso of ['!connections.ini', '!.env', '!conns/**']) {
      assert.ok((pkg.build.files || []).includes(escluso),
        `build.files deve escludere ${escluso} dal pacchetto distribuito`);
    }
    console.log('  OK   Electron: AppUserModelID allineato a build.appId (barra applicazioni) passed');
  }

  // Test 6: Controllo presenza file di configurazione ed eseguibili principali
  const requiredFiles = [
    'Dockerfile',
    'docker-compose.yml',
    'bin/codedb.js',
    'electron-main.js',
    'server.js',
    'backup/cli.js',
    'public/js/backupmanager.js',
    'public/js/splitview.js',
    'backup/lib/engine.js',
    'backup/lib/restore.js',
    'backup/lib/storage.js',
    'backup/lib/util.js'
  ];

  for (const relPath of requiredFiles) {
    const fullPath = path.join(__dirname, '..', relPath);
    assert(fs.existsSync(fullPath), `${relPath} deve esistere`);
    console.log(`  OK   ${relPath} file check passed`);
  }

  // Test 7: Logica di Riconnessione Automatica e Rilevazione Errori di Connessione
  const isConnErrTerms = [
    new Error('Nessuna connessione attiva al database'),
    new Error('MongoNetworkError: connection reset by peer'),
    new Error('PROTOCOL_CONNECTION_LOST'),
    new Error('Tunnel SSH caduto: connection timed out'),
    new Error('Connection terminated unexpectedly')
  ];
  const connTerms = [
    'nessuna connessione attiva',
    'topology was destroyed',
    'client is closed',
    'pool is closed',
    'socket closed',
    'connection closed',
    'connection terminated',
    'connection reset',
    'connection lost',
    'tunnel ssh caduto',
    'econnreset',
    'econnrefused',
    'etimedout',
    'protocol_connection_lost'
  ];

  for (const err of isConnErrTerms) {
    const msg = (err.message || '').toLowerCase();
    const isConn = connTerms.some(t => msg.includes(t));
    assert.strictEqual(isConn, true, `Errore "${err.message}" deve essere riconosciuto come errore di connessione`);
  }
  console.log('  OK   Rilevazione errori di disconnessione DB superata');

  // Test 8: VirtualJoinEngine escaping backslashes nelle chiavi SQL IN
  let vjCapturedSql = '';
  const stratVjSql = {
    type: 'mysql',
    async collectionAggregate(db, table, payload) { vjCapturedSql = payload.pipeline; return { docs: [] }; }
  };
  await VirtualJoinEngine.execute({
    virtualJoin: {
      sourceA: { dbType: 'mysql', db: 'shop', table: 'orders' },
      sourceB: { dbType: 'mysql', db: 'shop', table: 'users' },
      on: { leftKey: 'user_id', rightKey: 'id' }
    }
  }, {
    type: 'mysql',
    async collectionAggregate() { return { docs: [{ user_id: 'val\\with\'quotes' }] }; }
  }, stratVjSql);
  assert.ok(vjCapturedSql.includes("'val\\\\with''quotes'"), 'VirtualJoinEngine deve fuggire backslash e apici nelle chiavi SQL');
  console.log('  OK   VirtualJoinEngine backslash escaping in SQL IN passed');

  // Test 9: Interfaccia cancelQuery sulle strategie DB
  const baseStrat = new DbStrategy();
  const resBaseCancel = await baseStrat.cancelQuery({});
  assert.strictEqual(resBaseCancel.cancelled, false, 'DbStrategy base cancelQuery deve ritornare cancelled: false');

  const resMongoCancel = await mongoStrategy.cancelQuery({});
  assert.strictEqual(resMongoCancel.cancelled, false, 'MongoDbStrategy cancelQuery senza client deve ritornare cancelled: false');

  const resMysqlCancel = await mysqlStrategy.cancelQuery({});
  assert.strictEqual(resMysqlCancel.cancelled, false, 'MySqlStrategy cancelQuery senza pool deve ritornare cancelled: false');

  const resPgCancel = await pgStrategy.cancelQuery({});
  assert.strictEqual(resPgCancel.cancelled, false, 'PostgreSqlStrategy cancelQuery senza pool deve ritornare cancelled: false');
  console.log('  OK   DbStrategy cancelQuery interface check passed');

  // Test 10: Esecuzione test unitari sul registro pending queries
  require('./pending-queries');

  // Test 11: Esecuzione test unitari su SqlChunker & USE Statement
  require('./unit-sql-chunking');

  // Test 12: Esecuzione test unitari su Syntax Highlighting
  require('./unit-highlighter');

  // Test 13: Esecuzione test unitari su Lifecycle & Graceful Shutdown
  require('./unit-lifecycle');

  // Test 14: Esecuzione test unitari su RBAC (permessi, Proxy, gate MCP)
  require('./unit-rbac');

  // Test 15: Divisione degli script in istruzioni (base del runner di script)
  require('./unit-sql-split');

  // Test 16: Macchina a stati dell'esecuzione script (pausa/ripresa, errori)
  require('./unit-script-runner');

  // Test 17: Splitter client, e sua coerenza col gemello server
  require('./unit-sql-split-client');

  // Test 18: Interprete degli script MongoDB (linguaggio, sandbox, budget)
  require('./unit-mongo-script');

  // Test 19: Traduzione SQL di scrittura/DDL → MongoDB
  require('./unit-sql-write-mongo');

  // Test 20: Formattatore dell'editor (SQL, JSON/MQL, rientri JavaScript)
  require('./unit-query-formatter');

  // Test 21: Vault a busta (DEK, scrypt, cambio passphrase)
  require('./unit-vault');

  // Test 22: Geometrie (validazione GeoJSON, binding ST_GeomFromGeoJSON, lettura)
  require('./unit-geometry');

  console.log('\nTutti i test unitari superati con successo!');
})();


