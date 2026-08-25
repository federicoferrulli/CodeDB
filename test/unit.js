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

  // Test 5e-bis: integrità end-to-end dei backup. Nomi distinti non devono
  // collidere, il verificatore deve controllare entrambi i versi del manifest e
  // il restore deve fermarsi PRIMA di scrivere se un layer è corrotto.
  {
    const {
      createFileSink, readLines, safeName, sha256File, verifyBackupDir,
    } = require('../backup/lib/util');
    const { preflightChain } = require('../backup/lib/restore');
    const { notifySlack } = require('../backup/lib/notify');

    assert.strictEqual(safeName('clienti'), 'clienti', 'un nome storico già sicuro resta stabile');
    assert.notStrictEqual(
      safeName('clienti vip'),
      safeName('clienti_vip'),
      'due nomi che condividono lo stem normalizzato non devono condividere il file'
    );
    assert.notStrictEqual(safeName('Foo'), safeName('foo'), 'la differenza di maiuscole deve sopravvivere su Windows');
    assert.notStrictEqual(safeName('CON'), 'CON', 'i nomi riservati di Windows devono essere riscritti');

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-backup-hardening-'));
    try {
      const abortPath = path.join(temp, 'annullato.ndjson');
      const abortSink = createFileSink(abortPath, { compress: false });
      abortSink.writeLine('{"parziale":true}');
      await abortSink.abort(new Error('annullamento test'));
      assert.throws(
        () => abortSink.writeLine('{"tardi":true}'),
        /annullamento test/,
        'un sink annullato deve rifiutare altre scritture'
      );

      await assert.rejects(
        async () => {
          for await (const _line of readLines(path.join(temp, 'mancante.ndjson.gz'))) {
            // Nessuna riga attesa.
          }
        },
        /ENOENT|no such file/i,
        'un errore dello stream sorgente gzip deve emergere e non lasciare il restore appeso'
      );

      const dataDir = path.join(temp, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      const dataPath = path.join(dataDir, 'clienti.ndjson');
      const originale = '{"_id":1}\n';
      fs.writeFileSync(dataPath, originale, 'utf8');
      const file = {
        path: 'data/clienti.ndjson',
        collection: 'clienti',
        kind: 'data',
        count: 1,
        bytes: Buffer.byteLength(originale),
        sha256: await sha256File(dataPath),
      };
      const manifest = {
        tool: 'codedb-backup',
        version: 1,
        id: '20260814-120000000Z_full',
        type: 'full',
        dbType: 'mongodb',
        db: 'test',
        files: [file],
      };
      const manifestPath = path.join(temp, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      let report = await verifyBackupDir(temp);
      assert.strictEqual(report.valid, true, 'file dichiarato, dimensione e checksum corretti: backup valido');
      assert.strictEqual(report.okCount, 1, 'il file integro deve risultare verificato');

      const extraPath = path.join(temp, 'non-dichiarato.txt');
      fs.writeFileSync(extraPath, 'extra', 'utf8');
      report = await verifyBackupDir(temp);
      assert.strictEqual(report.extraCount, 1, 'un file sottratto dal manifest deve essere rilevato sul disco');
      assert.strictEqual(report.valid, false, 'un file non dichiarato invalida il backup');
      fs.unlinkSync(extraPath);

      // Stessa dimensione, contenuto diverso: il controllo deve arrivare fino
      // allo SHA-256 e il preflight deve impedire qualunque restore.
      fs.writeFileSync(dataPath, '{"_id":2}\n', 'utf8');
      report = await verifyBackupDir(temp);
      assert.strictEqual(report.failedCount, 1, 'una modifica a byte invariati deve risultare corrotta');
      assert(report.details.some((d) => d.status === 'CORRUPTED'), 'il dettaglio deve identificare la corruzione');
      await assert.rejects(
        preflightChain([{ dir: temp, manifest }], { info() {} }),
        /Nessuna modifica è stata applicata/,
        'la catena corrotta deve fermarsi prima del database'
      );

      // Compatibilità: un manifest storico senza checksum resta ripristinabile,
      // ma non può essere presentato come verificato.
      fs.writeFileSync(dataPath, originale, 'utf8');
      const storico = { ...manifest, files: [{ ...file }] };
      delete storico.files[0].sha256;
      fs.writeFileSync(manifestPath, JSON.stringify(storico, null, 2), 'utf8');
      report = await verifyBackupDir(temp);
      assert.strictEqual(report.unverifiableCount, 1, 'il checksum assente deve essere esplicito');
      assert.strictEqual(report.valid, false, 'non verificabile non equivale a valido');
      const avvisi = [];
      const preflight = await preflightChain(
        [{ dir: temp, manifest: storico }],
        { info(message) { avvisi.push(message); } }
      );
      assert.strictEqual(preflight.unverifiableCount, 1, 'il preflight deve contare i file storici');
      assert(avvisi.some((m) => /senza checksum/.test(m)), 'il restore storico deve produrre un avviso');

      // Anche una voce manifest strutturalmente nulla deve diventare un
      // dettaglio utilizzabile da UI/MCP, non un TypeError.
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, files: [null] }, null, 2), 'utf8');
      report = await verifyBackupDir(temp);
      assert(report.details.some((d) => d.status === 'INVALID_ENTRY'), 'voce nulla del manifest rilevata');

      // La notifica è un confine esterno: gli URI citati dagli errori dei
      // driver devono essere redatti prima di entrare nel body Slack.
      const fetchOriginale = global.fetch;
      let corpoSlack = null;
      const erroriLog = [];
      global.fetch = async (_url, options) => {
        corpoSlack = JSON.parse(options.body);
        return { ok: true, status: 200 };
      };
      try {
        await notifySlack(
          'https://hooks.slack.com/services/T/B/X',
          'Errore mongodb://utente:segreto-super@localhost:27017/db',
          { info() {}, error(message) { erroriLog.push(message); } }
        );
      } finally {
        global.fetch = fetchOriginale;
      }
      assert(corpoSlack && !corpoSlack.text.includes('segreto-super'), 'la password non deve uscire verso Slack');
      assert(corpoSlack.text.includes('utente:***@'), 'la redazione deve conservare un messaggio diagnostico utile');
      assert.strictEqual(erroriLog.length, 0, 'il mock Slack deve risultare riuscito');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log('  OK   Integrità backup, preflight restore e redazione Slack passed');
  }

  // Test 5e-ter: la CLI deve decifrare anche le URI complete. Una URI contiene
  // spesso le credenziali e il server la salva quindi come segreto ENC:.
  {
    const Vault = require('../db/vault');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-connstore-uri-'));
    const ini = path.join(temp, 'connections.ini');
    const modulo = require.resolve('../backup/lib/connstore');
    const envPrecedente = process.env.CODEDB_CONNECTIONS_FILE;
    try {
      const passphrase = 'passphrase-test-uri';
      const uri = 'mongodb://utente:password-uri@localhost:27017/database';
      const { meta, dataKey } = Vault.createMeta(passphrase);
      Vault.writeMeta(ini, meta);
      fs.writeFileSync(
        ini,
        '[connessione-uri]\ndbType=mongodb\nuri=' + Vault.encryptWith(uri, dataKey) + '\n',
        'utf8'
      );

      process.env.CODEDB_CONNECTIONS_FILE = ini;
      delete require.cache[modulo];
      const connstore = require('../backup/lib/connstore');
      assert.strictEqual(connstore.hasEncryptedSecrets(), true, 'la URI ENC: deve richiedere la passphrase');
      const caricate = connstore.loadConnections(passphrase);
      assert.strictEqual(caricate['connessione-uri'].uri, uri, 'la CLI deve consegnare al driver la URI in chiaro');
    } finally {
      delete require.cache[modulo];
      if (envPrecedente === undefined) delete process.env.CODEDB_CONNECTIONS_FILE;
      else process.env.CODEDB_CONNECTIONS_FILE = envPrecedente;
      fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log('  OK   Connstore CLI: URI cifrata decifrata passed');
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
      'a\nb', 'a\u0000b', '   ', '',
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

    // Il server incorporato deve essere AVVIATO, non solo caricato: `server.js`
    // mette `startServer()` dietro `require.main === module`, che da
    // electron-main.js è falso. Senza la chiamata esplicita l'app desktop non
    // apre alcuna porta e finisce per funzionare solo quando trova già in
    // ascolto un server avviato a parte — con il vault e il processo di
    // QUELL'istanza, quindi senza passphrase richiesta e senza aggiornamenti.
    // È successo davvero, e da fuori sembrava tutto normale.
    // NB: si cerca la CHIAMATA (`qualcosa.startServer(`), non il nome: la
    // semplice occorrenza compare anche nel messaggio d'errore qui accanto, e
    // un test che passa per quello non verificherebbe nulla.
    assert.ok(/\w+\.startServer\s*\(/.test(mainSrc),
      'electron-main.js deve chiamare startServer() dopo aver caricato server.js');
    assert.ok(/module\.exports[\s\S]*startServer/.test(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')),
      'server.js deve esportare startServer per l\'app desktop');

    // Porta occupata da un'ALTRA applicazione: `server.js` reagisce a
    // EADDRINUSE con process.exit(1), che dentro Electron uccide tutto. Da
    // quando il server viene davvero avviato, il caso è raggiungibile: va
    // deciso prima quale porta usare.
    assert.ok(/function scegliPorta/.test(mainSrc) && /net\.createServer/.test(mainSrc),
      'electron-main.js deve verificare la disponibilità della porta prima di avviare il server');

    // Ponte verso l'interfaccia: la voce "Controlla Aggiornamenti" nel menu ⋮
    // esiste solo se il main process lo espone (il menu nativo è nascosto da
    // autoHideMenuBar, quindi quella voce da sola non basta).
    assert.ok(/globalThis\.__codedbDesktop/.test(mainSrc),
      'electron-main.js deve esporre il ponte __codedbDesktop al server incorporato');

    // I SEGRETI NON DEVONO FINIRE DENTRO IL PACCHETTO, per NESSUNO dei due
    // percorsi di pacchettizzazione. Erano due elenchi indipendenti — `IGNORE`
    // in tools/build-desktop.mjs e `build.files` qui — e mancavano in entrambi
    // `vault.json` (il salt scrypt e la DEK avvolta dello sviluppatore) e
    // `provenienza/` (il registro che la documentazione tiene fuori da git
    // perché pubblicarlo «consegnerebbe l'elenco di cosa cancellare»). Il
    // controllo storico guardava tre voci e solo in package.json.
    const { ESCLUSIONI, regexPackager } = require('../tools/esclusioni-distribuzione');

    // 1) build.files rispecchia l'elenco unico.
    for (const escluso of ESCLUSIONI) {
      assert.ok((pkg.build.files || []).includes(escluso),
        `build.files deve escludere ${escluso}: allinealo a tools/esclusioni-distribuzione.js`);
    }

    // 2) Il percorso @electron/packager esclude gli STESSI file. Si prova sui
    //    percorsi veri, non sui pattern: è ciò che finisce nel pacchetto.
    const rxPackager = regexPackager();
    const daEscludere = [
      '/vault.json', '/vault.json.bak', '/provenienza/impronte.json',
      '/.env', '/connections.ini', '/connections.ini.bak',
      '/data/conns/507f1f77bcf86cd799439011.ini',
      '/ui-audit.log', '/ui-audit.log.1', '/mcp-audit.log', '/codedb.log',
      '/backups/x/manifest.json', '/test/unit.js', '/docs/x.md', '/tools/x.js',
    ];
    for (const p of daEscludere) {
      assert.ok(rxPackager.some((r) => r.test(p)),
        `IGNORE di build-desktop.mjs deve escludere ${p} dal pacchetto`);
      // …e lo stesso file non deve passare nemmeno da electron-builder.
      const nome = p.replace(/^\//, '');
      assert.ok(
        ESCLUSIONI.some((e) => {
          const g = e.slice(1);
          if (g.endsWith('/**')) return nome.startsWith(g.slice(0, -2));
          const rx = new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
          return rx.test(nome);
        }),
        `build.files deve escludere ${p} dal pacchetto`
      );
    }

    // 3) Ciò che DEVE restare non è stato escluso per eccesso di zelo: la AGPL
    //    pretende che la licenza accompagni il programma, e l'app legge
    //    MANLEVA.md/EULA.md a runtime per "Informazioni & Licenza".
    for (const p of ['/server.js', '/public/js/main.js', '/LICENSE.md', '/MANLEVA.md', '/EULA.md']) {
      assert.ok(!rxPackager.some((r) => r.test(p)), `${p} NON deve essere escluso dal pacchetto`);
    }
    console.log('  OK   Electron: AppUserModelID allineato a build.appId (barra applicazioni) passed');
    console.log('  OK   Distribuzione: segreti e registro di provenienza esclusi da ENTRAMBI i pacchettizzatori (CDB-A57)');
  }

  // Test 5k-bis: licenza e manleva. Il testo compare in due posti — la pagina
  // di accettazione dell'installer NSIS e la schermata "Informazioni & Licenza"
  // dentro l'app — ma la sorgente deve restare UNA: due versioni divergenti
  // dello stesso impegno legale sono il difetto peggiore possibile qui, e non
  // se ne accorge nessuno finché non è troppo tardi.
  {
    const pkg = require('../package.json');
    const { contenutoLicenza, USCITA } = require('../tools/genera-licenza');
    const radice = path.join(__dirname, '..');

    const manleva = fs.readFileSync(path.join(radice, 'MANLEVA.md'), 'utf8');
    assert.ok(/AGPL-3\.0/.test(manleva), 'MANLEVA.md deve citare la licenza applicata');
    assert.ok(/senza garanzie/i.test(manleva) && /non rispondono/i.test(manleva),
      'MANLEVA.md deve contenere l\'esclusione di garanzia e la limitazione di responsabilità');

    // L'EULA è l'altra metà dell'accordo: sta nello stesso file generato,
    // perché l'installer è il punto in cui l'utente lo accetta davvero.
    const eula = fs.readFileSync(path.join(radice, 'EULA.md'), 'utf8');
    assert.ok(/EULA/i.test(eula) && /AGPL-3\.0/.test(eula),
      'EULA.md deve dichiarare l\'accordo con l\'utente finale e la licenza applicata');

    // L'installer deve mostrarli: senza `nsis.license` il setup non presenta
    // alcuna pagina di accettazione.
    assert.strictEqual(pkg.build.nsis.license, 'build/license.txt',
      'build.nsis.license deve puntare al file generato da MANLEVA.md ed EULA.md');

    assert.ok(fs.existsSync(USCITA), 'build/license.txt deve esistere (npm run electron:licenza)');
    const generato = fs.readFileSync(USCITA, 'utf8');

    // Confronto INSENSIBILE ai fine riga: il contenuto deve coincidere, ma non
    // si può pretendere che il working copy conservi i CRLF — dipende da
    // `core.autocrlf` e da .gitattributes della macchina, e un test che fallisce
    // per come git ha fatto il checkout non dice nulla sulla manleva. Il
    // generatore scrive comunque CRLF (lo legge un installer Windows) e
    // .gitattributes lo dichiara `eol=crlf`.
    const soloTesto = (s) => s.replace(/\r\n?/g, '\n');
    assert.strictEqual(soloTesto(generato), soloTesto(contenutoLicenza()),
      'build/license.txt è disallineato da MANLEVA.md/EULA.md: rigeneralo con `npm run electron:licenza`');

    // Entrambe le parti devono esserci: una pagina di accettazione che mostra
    // la sola manleva chiederebbe di accettare metà accordo.
    assert.ok(/Contratto di licenza con l'utente finale/.test(generato),
      'build/license.txt deve contenere anche l\'EULA');

    // Gli elenchi puntati dell'EULA non devono fondersi nel paragrafo
    // precedente: è proprio l'elenco degli obblighi da accettare.
    assert.ok(/\n\s+- /.test(soloTesto(generato)),
      'build/license.txt deve conservare gli elenchi puntati dell\'EULA');

    // I paragrafi devono restare separati: su Windows `MANLEVA.md` arriva con
    // CRLF e una divisione ingenua li fondeva tutti in un muro di testo — il
    // file generato era leggibile solo a fatica, e diverso da quello prodotto
    // su Linux (da cui il fallimento in CI).
    assert.ok(soloTesto(generato).includes('\n\n'),
      'build/license.txt deve conservare le righe vuote fra i paragrafi');

    // IL MARKDOWN DEVE ESSERE SPARITO. È l'asserzione complementare, e rende
    // inutile inseguire i costrutti uno per uno: il confronto qui sopra è fra
    // il file e l'output della STESSA funzione, quindi un costrutto non gestito
    // resta grezzo da entrambe le parti e passa inosservato — finché non compare
    // nella schermata che l'utente deve accettare. Un rimando alla AGPL o al
    // repository ufficiale è esattamente ciò che si aggiunge a un EULA.
    const residui = [
      [/\][ ]*\(/, 'link markdown [testo](url)'],
      [/\*\*/, 'grassetto **'],
      [/`/, 'codice inline con backtick'],
      [/^#{1,6}\s/m, 'titoli #'],
      [/^\s*>\s/m, 'citazioni >'],
    ];
    for (const [rx, nome] of residui) {
      assert.ok(!rx.test(soloTesto(generato)),
        `build/license.txt contiene ancora ${nome}: testoSemplice() non lo converte, e arriverebbe grezzo alla schermata di accettazione`);
    }

    // La riga orizzontale non si può cercare nel generato: l'impaginatore ne
    // scrive una LUNGA di suo per separare manleva ed EULA. Si prova quindi la
    // conversione direttamente, su un campione che contiene ogni costrutto.
    const { testoSemplice } = require('../tools/genera-licenza');
    const campione = [
      '# Titolo',
      '## Sottotitolo',
      '---',
      'Vedi la [licenza AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html) e il',
      '**repository ufficiale** con il file `LICENSE.md`.',
      '> Nota importante.',
      'Testo in *corsivo* e in _corsivo_.',
    ].join('\n');
    const convertito = testoSemplice(campione);
    assert.ok(convertito.includes('licenza AGPL-3.0 (https://www.gnu.org/licenses/agpl-3.0.html)'),
      `Un link deve diventare "testo (url)": ottenuto ${JSON.stringify(convertito)}`);
    for (const [rx, nome] of [...residui, [/^\s*(?:[-*_]\s*){3,}$/m, 'righe orizzontali']]) {
      assert.ok(!rx.test(convertito), `testoSemplice() deve rimuovere: ${nome}`);
    }
    assert.ok(convertito.includes('Nota importante.') && convertito.includes('corsivo'),
      'La conversione non deve perdere il testo');

    // NSIS legge il file come ANSI senza BOM: gli accenti italiani diventano
    // caratteri illeggibili proprio nella schermata da accettare.
    assert.strictEqual(generato.charCodeAt(0), 0xFEFF, 'build/license.txt deve iniziare con il BOM UTF-8');
    assert.ok(!/[*`#]/.test(generato), 'il markdown non deve arrivare nell\'installer come testo');

    // La landing pubblica la SUA copia dell'EULA (`landing/license.html`), che
    // non si può generare da `EULA.md` — è un sito a parte, con un altro
    // impianto. Resta però il difetto che questo test esiste per impedire: due
    // versioni divergenti dello stesso accordo, una accettata all'installazione
    // e una pubblicata sul sito. Non si confronta il testo parola per parola
    // (la pagina ha una sua forma), ma le clausole che, mancando da una parte,
    // cambiano ciò a cui l'utente si è obbligato.
    const paginaEula = path.join(radice, 'landing', 'license.html');
    if (fs.existsSync(paginaEula)) {
      const pagina = fs.readFileSync(paginaEula, 'utf8');
      const clausole = [
        [/art\.\s*13/i, 'l\'obbligo AGPL sul software offerto via rete (art. 13)'],
        [/indennizzare/i, 'l\'obbligo di manleva e difesa'],
        [/legge italiana/i, 'la legge applicabile'],
        [/foro/i, 'il foro competente'],
        [/federicoferrulli\/CodeDB/, 'il repository ufficiale'],
        [/Versione 1\.0/, 'la versione dell\'accordo'],
      ];
      for (const [re, cosa] of clausole) {
        assert.ok(re.test(eula), `EULA.md non dichiara ${cosa}`);
        assert.ok(re.test(pagina), `landing/license.html è disallineato da EULA.md: manca ${cosa}`);
      }
    }

    // Gli script di build devono rigenerarlo, altrimenti l'installer resterebbe
    // con la manleva della build precedente.
    for (const s of ['build:win', 'release:win']) {
      assert.ok((pkg.scripts[s] || '').includes('electron:licenza'), `${s} deve rigenerare la licenza`);
    }
    console.log('  OK   Licenza e manleva: sorgente unica per installer e app passed');
  }

  // Test 5k: aggiornamenti dell'app desktop (electron-updater). Il modulo non
  // tocca Electron finché non si crea il gestore, quindi gli helper puri sono
  // verificabili qui; della configurazione si verifica ciò che, sbagliato, si
  // scoprirebbe solo DOPO aver pubblicato una release.
  {
    const pkg = require('../package.json');
    const upd = require('../electron-aggiornamenti');
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron-main.js'), 'utf8');

    // electron-updater gira nel processo principale dell'app INSTALLATA: deve
    // stare fra le dependencies, non fra le devDependencies (electron-builder
    // esclude queste ultime dal pacchetto e il modulo mancherebbe a runtime).
    assert.ok(pkg.dependencies['electron-updater'], 'electron-updater deve essere una dependency di runtime');
    assert.ok(!(pkg.devDependencies || {})['electron-updater'], 'electron-updater non deve stare nelle devDependencies');

    // Senza `build.publish` electron-builder non scrive `app-update.yml` nel
    // pacchetto: il controllo fallirebbe su ogni installazione con "ENOENT".
    const pub = (pkg.build.publish || [])[0];
    assert.ok(pub && pub.provider, 'build.publish deve dichiarare un provider di pubblicazione');
    if (pub.provider === 'github') {
      assert.strictEqual(pub.owner, upd.REPO.owner, 'build.publish.owner deve coincidere con il repo usato dal modulo aggiornamenti');
      assert.strictEqual(pub.repo, upd.REPO.repo, 'build.publish.repo deve coincidere con il repo usato dal modulo aggiornamenti');

      // …e con il repository dichiarato dal pacchetto, che è quello che l'EULA
      // cita come sorgente ispezionabile: due nomi diversi significano un feed
      // di aggiornamenti che punta altrove rispetto al codice pubblicato, e la
      // concessione della AGPL che rimanda a un repository che può non esistere.
      const url = (pkg.repository && pkg.repository.url) || '';
      assert.ok(url.includes(`${pub.owner}/${pub.repo}`),
        `package.json repository (${url}) deve puntare allo stesso repo di build.publish (${pub.owner}/${pub.repo})`);
    }

    // Feed personalizzato (server statico HTTP): HTTPS obbligatorio fuori dal
    // loopback — su HTTP semplice un attaccante in rete non "vede" ma
    // SOSTITUISCE l'installer scaricato.
    assert.strictEqual(upd.feedPersonalizzato({}), null, 'nessuna variabile impostata = nessun feed personalizzato');
    assert.deepStrictEqual(
      upd.feedPersonalizzato({ CODEDB_UPDATE_URL: 'https://aggiornamenti.example/codedb/' }),
      { provider: 'generic', url: 'https://aggiornamenti.example/codedb/' },
      'un URL HTTPS produce un feed generic'
    );
    assert.strictEqual(
      upd.feedPersonalizzato({ CODEDB_UPDATE_URL: 'https://x.example/', CODEDB_UPDATE_CHANNEL: 'beta' }).channel,
      'beta', 'il canale è propagato al feed');
    assert.ok(upd.feedPersonalizzato({ CODEDB_UPDATE_URL: 'http://aggiornamenti.example/' }).errore,
      'HTTP semplice su host remoto rifiutato');
    assert.ok(!upd.feedPersonalizzato({ CODEDB_UPDATE_URL: 'http://127.0.0.1:8080/' }).errore,
      'HTTP su loopback ammesso (prove locali)');
    assert.ok(upd.feedPersonalizzato({ CODEDB_UPDATE_URL: 'non-un-url' }).errore, 'URL malformato rifiutato');

    // Confronto versioni (rete di sicurezza se isUpdateAvailable manca).
    assert.ok(upd.confrontaVersioni('1.2.0', '1.1.9') > 0, '1.2.0 > 1.1.9');
    assert.ok(upd.confrontaVersioni('1.10.0', '1.9.0') > 0, 'confronto numerico, non lessicografico');
    assert.strictEqual(upd.confrontaVersioni('v1.0.0', '1.0.0'), 0, 'il prefisso "v" è ignorato');
    assert.ok(upd.confrontaVersioni('1.2.0-beta.1', '1.2.0') < 0, 'una pre-release vale meno della versione finale');
    assert.ok(upd.confrontaVersioni('1.2.0', '1.2.0-beta.1') > 0, 'e viceversa');
    // Le componenti di pre-release si confrontano una per una: per confronto
    // testuale "beta.10" starebbe PRIMA di "beta.9", cioè la decima beta non
    // verrebbe mai offerta a chi ha la nona.
    assert.ok(upd.confrontaVersioni('1.2.0-beta.10', '1.2.0-beta.9') > 0, 'beta.10 > beta.9 (numerico)');
    assert.ok(upd.confrontaVersioni('1.2.0-beta', '1.2.0-beta.1') < 0, 'meno identificatori = versione minore');
    assert.ok(upd.confrontaVersioni('1.2.0-alpha.3', '1.2.0-beta.1') < 0, 'alpha < beta');
    assert.strictEqual(upd.confrontaVersioni('1.2.0+build.9', '1.2.0'), 0, 'i metadati di build non contano');

    // Pre-release: la scelta è ESPLICITA. Il valore implicito di
    // electron-updater ("solo chi ha una beta installata") sparisce da solo alla
    // prima versione stabile, e non dà modo né di provare le beta partendo da
    // una stabile né di escluderle su una macchina che oggi ne ha una.
    assert.strictEqual(upd.versioneDiPreRelease('0.1.1-beta.1'), true, '-beta.1 è una pre-release');
    assert.strictEqual(upd.versioneDiPreRelease('1.0.0'), false, '1.0.0 non lo è');
    assert.strictEqual(upd.versioneDiPreRelease('v0.1.0-b'), true, 'anche la forma corta -b');
    assert.strictEqual(upd.permettePreRelease({}, '0.2.0-beta.1'), true,
      'chi ha installato una beta continua a ricevere le beta');
    assert.strictEqual(upd.permettePreRelease({}, '1.0.0'), false,
      'chi ha una versione stabile non riceve le beta senza chiederlo');
    assert.strictEqual(upd.permettePreRelease({ CODEDB_UPDATE_PRERELEASE: '1' }, '1.0.0'), true,
      'la variabile d\'ambiente permette di iscriversi al canale di prova');
    assert.strictEqual(upd.permettePreRelease({ CODEDB_UPDATE_PRERELEASE: 'off' }, '0.2.0-beta.1'), false,
      'e di uscirne anche partendo da una beta');
    assert.strictEqual(upd.permettePreRelease({ CODEDB_UPDATE_PRERELEASE: 'forse' }, '1.0.0'), false,
      'un valore non riconosciuto non deve valere "sì" per caso');

    // Metà SERVER del canale di prova: una beta pubblicata su GitHub come
    // release normale diventa la `/releases/latest` del repository, cioè viene
    // offerta anche a chi le pre-release non le ha mai volute. Il tipo di
    // release lo decide quindi la versione, non un valore fisso in package.json.
    {
      const pubblica = require('../tools/pubblica.js');
      for (const v of ['0.1.1-beta.1', '1.0.0', 'v2.0.0-rc.1', '1.2.3+build.4']) {
        assert.strictEqual(pubblica.versioneDiPreRelease(v), upd.versioneDiPreRelease(v),
          `tools/pubblica.js e electron-aggiornamenti.js devono concordare su ${v}`);
      }
      assert.strictEqual(pubblica.preRelease({}, '0.1.1-beta.1'), true, 'una beta si pubblica come pre-release');
      assert.strictEqual(pubblica.preRelease({}, '1.0.0'), false, 'una stabile no');
      assert.strictEqual(pubblica.preRelease({ CODEDB_RELEASE_PRERELEASE: '0' }, '1.0.0-rc.1'), false,
        'la variabile d\'ambiente permette il rilascio fuori regola');
      for (const p of ['win', 'mac', 'linux']) {
        assert.ok(/tools\/pubblica\.js/.test(pkg.scripts[`release:${p}`]),
          `release:${p} deve passare da tools/pubblica.js, altrimenti una beta finisce pubblicata come release stabile`);
      }

      // TAG DOPPI. La release sta sotto `v${version}`, ma `releases.atom` — il
      // feed da cui electron-updater sceglie la versione — elenca anche i tag
      // SENZA release: un `0.1.3-beta.1` creato a mano accanto a
      // `v0.1.3-beta.1` compare per primo e l'updater cerca `latest.yml` dove
      // non c'è nulla. È accaduto davvero con la 0.1.3-beta.1, e dalla build
      // non si vedeva: artefatti tutti al loro posto, aggiornamento rotto.
      assert.strictEqual(pubblica.tagDiRilascio('0.1.3-beta.1'), 'v0.1.3-beta.1');
      assert.strictEqual(pubblica.tagDiRilascio('v1.0.0'), 'v1.0.0', 'la "v" non si raddoppia');

      const tagFinti = ['v0.1.2-beta.1', '0.1.3-beta.1', 'v0.1.3-beta.1', 'V0.1.3-BETA.1', '0.1.3-beta.1'];
      assert.deepStrictEqual(pubblica.tagDuplicati(tagFinti, '0.1.3-beta.1'),
        ['0.1.3-beta.1', 'V0.1.3-BETA.1'],
        'vanno segnalate tutte le scritture alternative della stessa versione, una volta sola ciascuna');
      assert.deepStrictEqual(pubblica.tagDuplicati(tagFinti, '0.1.4-beta.1'), [],
        'i tag di ALTRE versioni non sono duplicati');
      assert.deepStrictEqual(pubblica.tagDuplicati(['v0.1.3-beta.1'], '0.1.3-beta.1'), [],
        'il tag della release non è un duplicato di se stesso');
      assert.deepStrictEqual(pubblica.tagDuplicati([], '0.1.3-beta.1'), [], 'nessun tag = nessun duplicato');

      // La guardia deve essere chiamata PRIMA di electron-builder: scoprire il
      // tag doppio dopo la pubblicazione significa avere già la release rotta.
      const srcPubblica = fs.readFileSync(path.join(__dirname, '..', 'tools', 'pubblica.js'), 'utf8');
      assert.ok(srcPubblica.indexOf('verificaTag(version)') !== -1
        && srcPubblica.indexOf('verificaTag(version)') < srcPubblica.indexOf('electron-builder/cli.js'),
        'verificaTag deve precedere l\'esecuzione di electron-builder');
    }

    // Note di rilascio: markup ridotto a testo e lunghezza limitata (finiscono
    // in un dialog nativo, che non interpreta HTML).
    const note = upd.noteRilascio({ releaseNotes: '<p>Corretto <b>tutto</b></p><ul><li>uno</li></ul>' });
    assert.ok(!/[<>]/.test(note) && /Corretto tutto/.test(note), 'le note di rilascio devono essere testo semplice');
    assert.ok(upd.noteRilascio({ releaseNotes: 'x'.repeat(5000) }).length <= 701, 'le note lunghe vengono accorciate');
    assert.strictEqual(upd.noteRilascio({}), '', 'nessuna nota = stringa vuota');

    // La voce di menu deve esistere e chiamare il controllo MANUALE (true):
    // con `false` il controllo resterebbe silenzioso e il clic non darebbe
    // alcuna risposta quando l'app è già aggiornata.
    assert.ok(/Controlla aggiornamenti/.test(mainSrc), 'il menu deve contenere la voce "Controlla aggiornamenti…"');
    assert.ok(/aggiornamenti\.controlla\(true\)/.test(mainSrc), 'la voce di menu deve eseguire un controllo manuale');
    // Workflow di release: è l'unico modo di produrre il `.dmg` senza un Mac
    // (electron-builder rifiuta la build macOS altrove). Il rischio vero non è
    // che il file sparisca, ma che uno script npm venga rinominato e il
    // workflow resti a citare quello vecchio: se ne accorgerebbe solo la
    // prossima release, fallendo dopo il tag.
    {
      const wf = path.join(__dirname, '..', '.github', 'workflows', 'release.yml');
      assert.ok(fs.existsSync(wf), '.github/workflows/release.yml deve esistere');
      const testo = fs.readFileSync(wf, 'utf8');
      for (const runner of ['windows-latest', 'macos-latest', 'ubuntu-latest']) {
        assert.ok(testo.includes(runner), `il workflow deve costruire su ${runner}`);
      }
      // Gli script sono referenziati con la variabile di matrice: qui si
      // verifica che ESISTANO tutti e sei quelli che quella variabile può
      // produrre.
      assert.ok(/npm run release:\$\{\{ matrix\.piattaforma \}\}/.test(testo)
        && /npm run build:\$\{\{ matrix\.piattaforma \}\}/.test(testo),
      'il workflow deve invocare gli script npm per piattaforma');
      for (const p of ['win', 'mac', 'linux']) {
        for (const k of ['build', 'release']) {
          assert.ok(pkg.scripts[`${k}:${p}`], `il workflow richiede lo script ${k}:${p} in package.json`);
        }
      }
      // Senza certificato, electron-builder cercherebbe un'identità nel
      // portachiavi del runner e fallirebbe invece di produrre un pacchetto
      // non firmato.
      assert.ok(testo.includes('CSC_IDENTITY_AUTO_DISCOVERY'),
        'la build non firmata deve disattivare la ricerca automatica del certificato');
    }
    console.log('  OK   Electron: aggiornamenti (feed, versioni, note, menu) passed');
    console.log('  OK   Workflow di release: runner per piattaforma e script npm coerenti passed');
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

  // Test 23: Custom Charts (aggregazioni, valori EJSON, regole di leggibilità)
  require('./unit-charts');

  // Test 24: Statistiche della selezione di celle (valori EJSON, precisione)
  require('./unit-cell-stats');

  // Test 24-ter: Grafico della selezione di celle (asse dedotto, una serie per
  // colonna numerica, raggruppamento solo se i valori dell'asse si ripetono)
  // Sbagliato non lancia: disegna barre plausibili e false.
  require('./unit-cell-chart');

  // Test 24-bis: Statistiche di una selezione GEOMETRICA (misure sferiche,
  // geometrie proiettate escluse dai totali)
  require('./unit-geo-stats');

  // Test 24-quater: Geometrie dentro i RISULTATI di una query (vista 🗺 Mappa):
  // dove si cerca (sottodocumenti, array) e dove no (valori EJSON)
  require('./unit-geo-risultati');

  // Test 24-quinquies: decisioni del pannello 🔗 delle chiavi esterne (quale
  // campo è collegato e dove, quale colonna fa da etichetta, quando due chiavi
  // sono la stessa chiave). Sbagliate non lanciano: aprono un pannello che
  // sembra funzionare e mostra un elenco di righe indistinguibili.
  require('./unit-fk-relazioni');

  // Test 24-quater: euristiche di analisi dello schema, condivise fra
  // l'interfaccia (Grafo 3D) e il gateway MCP. Erano due copie già divergenti:
  // un ordine di popolamento sbagliato e un report GDPR pieno di falsi positivi
  // non sembrano rotti, sembrano risposte.
  // Test 24-sexies: conversione valore -> testo di cella. Prova che il costo
  // dipende dal TETTO e non dalla dimensione del valore: e' cio' che decide se
  // il thread principale regge lo scorrimento di una tabella con dentro JSON o
  // stringhe da megabyte.
  require('./unit-valori');

  require('./unit-schema-analisi');

  // Test 24-quinquies: generatori e lettori di schema (DDL, DBML, Mermaid).
  // Producono un artefatto che l'utente porta via: un DDL con due PRIMARY KEY
  // nella stessa CREATE TABLE si scopre solo quando qualcuno lo esegue.
  require('./unit-schema-export');

  // Test 24-septies: DDL del round-trip export/import di un intero database.
  // Il difetto qui non lancia e non si vede: un DDL che qualifica lo schema di
  // ORIGINE fa "riuscire" l'import scrivendo nel posto sbagliato, e indici,
  // vincoli e FK spariscono in silenzio. Vedi CDB-A83.
  await require('./unit-ddl-roundtrip');

  // Test 24-octies: oggetti di schema nel backup e rinomina di un database.
  // Su MongoDB e MySQL la rinomina è dump → verifica → restore: se il backup
  // non porta view, routine, trigger, vincoli e validatori, quella "rinomina"
  // è una perdita silenziosa. Vedi CDB-A85.
  await require('./unit-rinomina-oggetti');

  // Test 24-novies: lettura dello schema PostgreSQL condivisa fra strategia e
  // motore di backup. Erano due copie della stessa logica: correggendone una
  // (CDB-A83) il backup ha continuato a produrre DDL rotte per un'intera
  // revisione, senza che nulla lo segnalasse. Vedi CDB-A87.
  await require('./unit-pg-ddl');

  // Test 24-decies: tipi geometrici NATIVI di PostgreSQL (point, polygon, box…)
  // tradotti da e verso GeoJSON. Non sono PostGIS: scambiarli per tali rendeva
  // la tabella illeggibile, e l'editor su mappa non riusciva a scriverli.
  require('./unit-pg-geo-nativo');

  // Test 24-decies-bis: l'import a blocchi deve convertire le geometrie native
  // come l'inserimento singolo, compresa la forma `{ x, y }` degli export
  // PostgreSQL storici. Senza, `point` fallisce con "invalid input syntax".
  await require('./unit-import-geometrie-postgres');

  // Test 24-undecies: scelta della collation di connessione su MySQL. Il
  // driver ne impone una COMPILATA DENTRO DI SÉ, che nessuno ha scelto, e la
  // ereditano variabili utente e CAST: bastava a far fallire in CodeDB query
  // corrette altrove (errore 1267). Qui si prova la regola di scelta; che il
  // server la accetti lo prova test/e2e-collazione-mysql.js.
  require('./unit-collazione');

  // Test 24-duodecies: decisioni del pannello di esecuzione script. Uno script
  // di due istruzioni mostrava nella griglia il risultato della PRIMA, contava
  // le istruzioni spacciandole per record ed elencava metà log: tre errori che
  // non lanciano, e che fanno sembrare il pannello funzionante mentre racconta
  // un'altra esecuzione.
  await require('./unit-script-esito');

  // Test 24-terdecies: deposito su file dei result set di uno script. Decide
  // quanto disco e quanta memoria costa "un risultato per istruzione", e
  // soprattutto che i file NON restino: dentro ci sono righe di database, e
  // dimenticarne uno non fa fallire nulla.
  await require('./unit-script-results');

  // Test 24-ter: MARCATORI DI PROVENIENZA ancora presenti nel codice.
  // Un refactor può cancellarne uno senza che nessuno se ne accorga, e da quel
  // momento il registro (vedi docs/provenienza.md) promette qualcosa che il
  // codice non ha più — cioè lo strumento darebbe un falso negativo proprio
  // quando serve. Se il registro privato non c'è (clone qualsiasi, CI) il
  // controllo si salta: è un file volutamente fuori da git.
  {
    const registroImpronte = process.env.CODEDB_IMPRONTE
      || path.join(__dirname, '..', 'provenienza', 'impronte.json');
    if (!fs.existsSync(registroImpronte)) {
      console.log('  SKIP Marcatori di provenienza: registro privato assente (docs/provenienza.md)');
    } else {
      const { leggiRegistro, analizza, punteggio } = require('../tools/impronte');
      const reg = leggiRegistro();
      const ris = analizza(path.join(__dirname, '..'), reg.marcatori);
      const mancanti = ris.regole.filter((r) => !r.trovato);
      const soloDoc = mancanti.filter((r) => r.docOnly).map((r) => r.m.id);
      assert.strictEqual(
        mancanti.length, 0,
        `Marcatori di provenienza spariti dal codice: ${mancanti.map((r) => r.m.id).join(', ')}`
        + (soloDoc.length ? ` (presenti nella sola documentazione: ${soloDoc.join(', ')})` : '')
      );
      const p = punteggio(ris.regole);
      console.log(`  OK   Marcatori di provenienza: ${reg.marcatori.length} presenti nel codice (${p.ottenuto}/${p.tot})`);
    }
  }

  // Test 25: Errori parlanti (traduzione dei codici dei driver)
  require('./unit-errors');

  // Test 25-bis: tetto di tempo sulla query libera — vale anche in SCRITTURA,
  // su entrambi i motori SQL, e segue la configurazione.
  await require('./unit-tetto-tempo');

  // Test 25-ter: i campi riservati al server nel payload di query:execute —
  // rimozione per regola dichiarata e registro dell'esecuzione solo dal server.
  await require('./unit-payload-esecuzione');

  // Test 26: Guida introduttiva (quando si apre, novità per versione, traguardi)
  require('./unit-onboarding');

  // Test 27: Colonne della tabella dei risultati (larghezze misurate, ordinamento EJSON)
  require('./unit-table-cols');

  // Scorciatoie da tastiera: catalogo, combinazioni, mappa effettiva.
  await require('./unit-scorciatoie');

  // Ricerca della palette Ctrl+P: quale voce sopravvive al termine scritto e
  // in che ordine — con le tabelle di tutti i database in elenco, e' la
  // funzione, non un dettaglio di disegno.
  await require('./unit-palette-ricerca');

  // Test 27-quater: cronologia della tab Query & Aggregate (dedup globale,
  // tetti, filtri, storage rotto).
  require('./unit-query-history');

  // Test 27-ter: scope dei permessi su SQL libero — le tabelle CITATE nella
  // query, non un bersaglio dedotto dal primo FROM (CDB-A03).
  require('./unit-sql-tables');

  // Le quattro funzioni del tabellare (identificatore di riga, sua lettura,
  // ordinamento, pezzi della SELECT) vivevano in due copie identiche dentro i
  // due adattatori SQL, dove correggerne una lasciava l'altra intatta. Ora sono
  // un modulo puro: nessun database.
  require('./unit-sql-tabellare');

  // La regola unica per scrivere il nome di una tabella o di una colonna:
  // **se** vada quotato e come si raddoppia l'apice che contiene. Stessa
  // decisione presa in sette punti, e uno solo sapeva rispondere alla prima
  // domanda. Modulo puro, provato dalle due parti (browser e server).
  await require('./unit-identificatori');

  // I tetti su righe, byte e tempo non sono piu' funzioni che ogni adattatore
  // puo' ricordarsi di chiamare: li impone la giuntura avvolgendo l'esecuzione.
  // L'adattatore finto in memoria e' deliberatamente disobbediente, cosi' se il
  // risultato arriva limitato il limite non puo' venire da lui.
  await require('./unit-tetti');

  // La tabella che il Proxy autorizzante consulta copre TUTTI i metodi delle
  // tre strategie: un metodo non classificato non e' sicuro, e' invisibile.
  // Controllo statico sui prototipi veri, perche' nessun controllo di tipo
  // puo' confrontare un oggetto letterale con tre catene di prototipi.
  await require('./unit-tabella-autorizzazioni');

  // Gli operatori che eseguono JavaScript sul SERVER MongoDB sono vietati da
  // UNA definizione sola: ce n'erano tre, e la terza riconosceva il divieto
  // guardando il testo di un messaggio d'errore.
  await require('./unit-divieto-server-js');

  // Il trasporto del frontend, staccato dal sacco delle utilita': riconnessione
  // delle sole connessioni salvate, annullamento su tab chiuso, marcatura
  // dell'origine della risposta. Socket finto, nessun server.
  await require('./unit-trasporto');

  // Il modulo unico della griglia: aritmetica della finestra virtuale (che
  // stava scritta due volte), capacita' dichiarate, corpo della tabella.
  await require('./unit-griglia');

  // L'ORDER BY passa dal metodo della STRATEGIA su tutti i percorsi, griglia
  // compresa: il punto di estensione c'era ma la composizione della SELECT lo
  // scavalcava, e chi lo compone riceve ora anche le colonne con la loro
  // nullabilita'. Pool finto, nessun database.
  await require('./unit-ordinamento-strategia');

  // Gli altri metodi che i due adattatori SQL implementano con lo stesso nome
  // (chiave primaria, colonne, campi, indici unici, keyset, conteggio): una
  // sola implementazione, con le differenze fra i motori dichiarate come dati.
  // Il pool è finto, quindi si provano i dialetti VERI senza alcun database.
  await require('./unit-sql-metadati');

  // Test 27-bis: le SCRITTURE del frontend congelano il bersaglio invece di
  // rileggerlo dal Proxy `state`, che punta al tab attivo alla chiamata.
  require('./unit-scritture-bersaglio');

  // Test 27-septies: in server.js la sessione di un tab ha due nomi (`sess` e
  // `session`) a seconda dell'handler, e in script:execute era finito quello
  // sbagliato — ReferenceError, cioè runner di script morto (CDB-A70).
  // Controllo statico, come unit-scritture-bersaglio: riprodurre il difetto
  // vero richiederebbe un socket, una sessione DB viva e un database.
  require('./unit-handler-scope');

  // La giuntura degli eventi socket, INVOCATA: il contesto della sessione e'
  // un argomento, quindi un handler si puo' chiamare con socket finto, sessioni
  // finte e principal finto — senza rete e senza database. Prima di questo i
  // test di server.js potevano solo leggerlo come testo.
  await require('./unit-giuntura-socket');

  // I quattro eventi di osservazione rientrano nella giuntura dei dati: erano
  // i quattro soli candidati puri fra i quarantotto registrati per la via
  // generica (ADR-0001), e rifacevano a mano la ricerca della sessione.
  await require('./unit-osservazione-giuntura');

  // La giuntura amministrativa: ventisei eventi che non toccano alcuna
  // strategia, e la voce di audit che non si puo' piu' dimenticare perche' un
  // evento non dichiarato non si registra affatto.
  await require('./unit-giuntura-amministrativa');

  // Gli otto punti di estensione delle operazioni lunghe (ADR-0001, terza
  // famiglia): nomi dichiarati invece di un'affermazione in prosa, e la
  // famiglia rifiuta cio' che non ne usa nessuno.
  await require('./unit-operazioni-lunghe');

  // Il guardiano delle tre famiglie: ogni evento socket sta in UNA famiglia, e
  // registrarne uno fuori dalle giunture previste — o dichiararlo in due — fa
  // fallire questo test. Terzo gradino del criterio di chiusura del lotto.
  require('./unit-registrazione-eventi');

  // Il filtro come DATO: un elenco di condizioni che ogni motore rende nel
  // proprio dialetto PARAMETRIZZANDO. Il valore non attraversa mai il testo
  // della query, ed e' questa — non un elenco di caratteri vietati — la ragione
  // per cui un valore ostile non puo' cambiarne la struttura.
  require('./unit-filtro');

  // Il filtro rapido del frontend: una parola cercata in tutte le colonne, e
  // chi scrive non deve sapere quale motore c'e' sotto.
  await require('./unit-filtro-rapido');

  // L'intenzione `contieneOvunque` viene resa dal server sui tre motori:
  // include JSON annidati, array, valori scalari e colonne oltre la sesta.
  require('./unit-ricerca-globale');

  // Il filtro strutturato e lo scope: uscire dal proprio perimetro non e'
  // ESPRIMIBILE, perche' ogni campo diventa un identificatore quotato intero.
  // E' la proprieta' che autorizza il ticket 24 a cancellare il firewall.
  require('./unit-filtro-autorizzazione');

  // Test 27-sexies: il TIPO di una colonna è sintassi interpolata nel DDL, e su
  // PostgreSQL le DDL usano il simple query protocol: senza validazione,
  // column:add/column:alter erano esecuzione di SQL arbitrario per chi ha la
  // sola capability `ddl` (CDB-A67). Nessun database.
  require('./unit-tipi-colonna');

  // Test 27-quater: temi — conversioni di colore, contrasto, derivazione delle
  // famiglie di token e validazione di un tema importato (che finisce in un
  // selettore CSS, quindi va trattato come dato ostile).
  require('./unit-tema');

  // Test 27-quinquies: monitor delle sessioni del server di database. Le tre
  // fonti ($currentOp, PROCESSLIST, pg_stat_activity) non si somigliano, e la
  // normalizzazione sbagliata non produce una tabella storta ma un pulsante
  // "Termina" accanto alla riga sbagliata. Nessun database: le righe di prova
  // hanno la forma esatta di quelle vere.
  require('./unit-sessioni');

  // Test 27-octies: geometria della Split-View. Le quote dei pannelli non sono
  // stili inline ma dati dell'albero, perché il DOM viene rimontato a ogni
  // aggiunta o chiusura; sbagliata, questa matematica non lancia errori — dà
  // proporzioni storte o un pannello vivo che nessuno disegna. Nessun browser.
  require('./unit-split-layout');

  // Test 27-octies-bis: velocità dello scorrimento automatico ai bordi mentre
  // si trascina una selezione sulla griglia. Sbagliata non lancia: fa scappare
  // la tabella dalla parte opposta al puntatore, oppure la fa scorrere mentre
  // si seleziona tranquillamente in mezzo allo schermo. Nessun browser.
  require('./unit-scorrimento');

  // Test 27-novies: JSON/BSON — validazione, formattazione e minificazione dei
  // documenti scritti a mano (editor ⚡ e modali). Qui la proprietà da
  // proteggere è che formattare NON cambi un valore: un intero oltre i 53 bit
  // o un ObjectId che passassero da JSON.parse tornerebbero indietro diversi,
  // e la perdita sarebbe silenziosa. Nessun browser, nessun database.
  require('./unit-json-bson');

  // Test 27-decies: completamento automatico consapevole dello schema. Non si
  // verifica che compaiano suggerimenti, ma che siano quelli del punto in cui
  // sta il cursore (dopo FROM tabelle, dopo `u.` le colonne del solo `u`):
  // un elenco sbagliato fa scrivere query che non esistono. Nessun browser.
  require('./unit-intellisense');

  // Test 27-undecies: calcoli pesanti spostati su Web Worker. Il rischio non è
  // la lentezza ma la DIVERGENZA fra i due percorsi (con e senza Worker): qui
  // si prova che il dispatcher è unico, che il precalcolo del grafico dà
  // esattamente lo stesso disegno di prima e che sopravvive alla copia fra
  // thread. Nessun browser: il Worker vero si prova in Playwright.
  require('./unit-calcoli');

  // Test 27-duodecies: duplicazione di una riga. Le decisioni su chiavi
  // primarie, indici unici e colonne calcolate stanno in un modulo puro
  // (db/duplica.js) proprio perche' sbagliarle non si vede: il duplicato
  // sembra corretto anche quando ha perso o conservato la chiave sbagliata.
  require('./unit-duplica');

  // Test 28: export di database e backup attraversano lo stesso confine di
  // fiducia prima di esporre un artefatto applicabile.
  require('./unit-artefatti');

  // Test 28-bis: identita stabile dei layer di backup. Un timestamp seleziona
  // le modifiche, ma solo PK/UNIQUE NOT NULL (o _id MongoDB) identifica la
  // stessa riga nel tempo. Include il controesempio con una riga ripetuta fra
  // full e incrementale: la cardinalita finale non e' la somma delle scritture.
  require('./unit-identita-backup');

  // Test 29: Barriere all'avvio quando l'istanza esce dal loopback — proxy
  // HTTPS e autenticazione sono due dichiarazioni distinte (CDB-A06).
  // Avvia processi veri: la decisione sta nel percorso di avvio, non in una
  // funzione. Nessun database richiesto.
  require('./unit-avvio-rete');

  // La riga finale NON si stampa qui.
  //
  // Due motivi, entrambi verificati (CDB-A64). Primo: dodici sotto-suite su
  // venti segnalano il fallimento con `process.exitCode = 1` invece di
  // lanciare, quindi il flusso arrivava comunque fin qui e dichiarava che era
  // andato tutto bene mentre il codice di uscita diceva il contrario. Secondo:
  // le sotto-suite scritte come IIFE asincrono restituiscono il controllo a
  // `require()` appena finisce la loro parte SINCRONA, quindi la riga poteva
  // essere stampata prima che avessero eseguito una sola asserzione.
  //
  // L'hook `exit` gira quando il ciclo di eventi si e' svuotato (cioe' dopo le
  // sotto-suite asincrone) e vede il codice di uscita definitivo.
})().catch((err) => {
  console.error('\nErrore non gestito nella suite unitaria:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

process.on('exit', (code) => {
  if (code === 0) {
    console.log('\nTutti i test unitari superati con successo!');
  } else {
    console.error(`\nSuite unitaria FALLITA (codice di uscita ${code}): cerca "FAIL" o "falliti" qui sopra.`);
  }
});


