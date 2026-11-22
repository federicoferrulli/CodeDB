'use strict';

// Solo database usa-e-getta, con nomi casuali; porte richieste esplicitamente.
const assert = require('assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { creaPianoExport } = require('../db/exportPlan');
const { leggiCatalogoExport } = require('../db/exportCatalogo');
const { esportaDatabase } = require('../db/databaseExport');
const { splitStatementsDetailed } = require('../db/sqlText');
const { normalizzaExportDatabase } = require('../db/artefatti');
const MySql = require('../db/MySqlStrategy');
const Pg = require('../db/PostgreSqlStrategy');
const Mongo = require('../db/MongoDbStrategy');
const { Long } = require('bson');

async function exportFile(strategy, db, modalita, formato, selezione, onFirstWrite, opzioniSql) {
  const catalogo = await leggiCatalogoExport(strategy, strategy.type, db);
  const plan = creaPianoExport({ catalogo: { ...catalogo, db, dbType: strategy.type }, connection: 'test', modalita, formato, selezione, opzioniSql });
  let text = '';
  const result = await esportaDatabase({ strategy, plan, write: async part => {
    text += part;
    if (onFirstWrite) { const action = onFirstWrite; onFirstWrite = null; await action(); }
  } });
  return { text, result, plan };
}

// Il client mysql riconosce DELIMITER prima di spedire gli statement.
function mysqlStatements(text) {
  const out = []; let delimiter = ';', buffer = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('DELIMITER ')) { delimiter = line.slice(10); continue; }
    if (!buffer && (!line.trim() || line.startsWith('--'))) continue;
    buffer += line + '\n';
    if (buffer.trimEnd().endsWith(delimiter)) {
      out.push(buffer.trimEnd().slice(0, -delimiter.length)); buffer = '';
    }
  }
  assert(!buffer.trim(), 'script SQL incompleto');
  return out;
}

async function sql(type, port) {
  const strategy = type === 'mysql' ? new MySql() : new Pg();
  const db = 'codedb_export_' + crypto.randomBytes(6).toString('hex');
  const mysql = type === 'mysql';
  const password = require('./lab/credenziali.cjs')(type);
  const passwordEnv = mysql ? 'MYSQL_PWD' : 'PGPASSWORD';
  const clientNativo = (container, args, input) => spawnSync('docker', ['exec', '-i', '-e', passwordEnv, container, ...args], {
    env: { ...process.env, [passwordEnv]: password }, input, encoding: 'utf8', windowsHide: true,
  });
  await strategy.connect({ host: '127.0.0.1', port, username: mysql ? 'root' : 'postgres', password, database: mysql ? '' : 'postgres' });
  const conn = mysql ? await strategy.pool.getConnection() : await strategy.pool.connect();
  const q = async s => { const r = await conn.query(s); return mysql ? r[0] : r.rows; };
  const eseguiFile = async text => {
    const container = process.env[mysql ? 'EXPORT_MYSQL_CONTAINER' : 'EXPORT_PG_CONTAINER'];
    if (container) {
      const args = mysql ? ['mysql', '-uroot', '--default-character-set=utf8mb4'] : ['psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'];
      const native = clientNativo(container, args, text);
      assert.strictEqual(native.status, 0, native.stderr || native.error?.message);
    } else {
      for (const statement of mysql ? mysqlStatements(text) : splitStatementsDetailed(text).map(s => s.sql)) {
        try { await q(statement); } catch (err) { err.message += '\nSQL della fixture: ' + statement; throw err; }
      }
    }
  };
  try {
    await q(mysql ? `CREATE DATABASE ${db}` : `CREATE SCHEMA ${db}`);
    await q(mysql ? `USE ${db}` : `SET search_path TO ${db}, public`);
    await q(`CREATE TABLE padre (id INT PRIMARY KEY)`);
    await q(`CREATE TABLE t (id ${mysql ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'}, parent_id INT, n DECIMAL(30,10), testo TEXT, bin ${mysql ? 'BLOB' : 'BYTEA'}, dt ${mysql ? 'DATETIME(6)' : 'TIMESTAMP(6)'}, calcolata INT GENERATED ALWAYS AS (parent_id+1) ${mysql ? 'STORED' : 'STORED'}, CONSTRAINT fk_padre FOREIGN KEY (parent_id) REFERENCES padre(id))`);
    await q('INSERT INTO padre VALUES (1)');
    await q(`INSERT INTO t (parent_id,n,testo,bin,dt) VALUES (1,12345678901234567890.1234567890,'test',${mysql ? "X'00FF7F'" : "decode('00ff7f','hex')"},'2026-09-25 12:34:56.123456')`);
    await conn.query(mysql ? 'UPDATE t SET testo=?' : 'UPDATE t SET testo=$1', ["apice ' backslash \\ newline\n emoji 🦊 $&"]);
    await q(`ALTER TABLE t ADD COLUMN g ${mysql ? 'GEOMETRY' : 'POINT'}`);
    await q(`ALTER TABLE t ADD COLUMN j ${mysql ? 'JSON' : 'JSONB'}`);
    await q(`UPDATE t SET g=${mysql ? "ST_GeomFromText('POINT(12 41)',0)" : "'(12,41)'::point"}, j='{"n":9007199254740993}'`);
    await q('CREATE VIEW v AS SELECT parent_id FROM t');
    await q('CREATE VIEW a_riepilogo AS SELECT parent_id FROM v');
    if (mysql) {
      await q("SET SESSION time_zone='+05:30'");
      await q('ALTER TABLE t ADD COLUMN istante TIMESTAMP(6) NULL');
      await q("UPDATE t SET id=0, istante='2026-10-12 12:34:56.123456'");
    }
    if (!mysql) {
      await q('CREATE MATERIALIZED VIEW mv AS SELECT parent_id FROM t');
      await q('CREATE VIEW v_mv AS SELECT * FROM mv');
      await q('CREATE MATERIALIZED VIEW mv_seconda AS SELECT * FROM v_mv');
    }
    if (mysql) {
      await q('CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END');
      const { guardStrategy } = require('../auth/guardStrategy');
      const { ROOT_PRINCIPAL, makePrincipal } = require('../auth/principal');
      const guarded = guardStrategy(strategy, { principal: ROOT_PRINCIPAL, connName: 'test' });
      await assert.rejects(guarded.collectionAggregate(db, null, {
        pipeline: 'CREATE PROCEDURE p_extra() BEGIN SELECT 1; END; DROP TABLE padre',
      }), /syntax/i, 'il driver rifiuta comandi accodati al corpo');
      assert.strictEqual((await q('SELECT * FROM padre')).length, 1);
      const scoped = makePrincipal({ _id: 'test', ownerId: 'owner', type: 'subuser' },
        [{ connName: 'test', capabilities: ['read', 'ddl', 'manage'], scope: { databases: [db], collections: ['*'] } }]);
      await assert.rejects(guardStrategy(strategy, { principal: scoped, connName: 'test' }).collectionAggregate(db, null, {
        pipeline: 'CREATE PROCEDURE p_scoped() BEGIN SELECT 1; SELECT 2; END',
      }), /istruzioni SQL|ambito|Permesso negato/i);
    } else {
      await q('ALTER TABLE t ADD COLUMN numeri NUMERIC[]');
      await q('ALTER TABLE t ADD COLUMN seriale BIGSERIAL');
      await q('ALTER SEQUENCE t_seriale_seq RENAME TO "Seq prova"');
      await q('ALTER SEQUENCE "Seq prova" INCREMENT BY 7 START WITH 100');
      await q('ALTER SEQUENCE t_id_seq INCREMENT BY 5');
      await q("SELECT setval('\"Seq prova\"',41,false)");
      await q("UPDATE t SET numeri=ARRAY[12345678901234567890.1234567890::numeric]");
      const { pgColonneDaSalvare } = require('../db/pg-ddl');
      const { select } = await pgColonneDaSalvare((s, p) => conn.query(s, p), db, 't');
      const [saved] = await q(`SELECT ${select} FROM t`);
      assert.strictEqual(saved.j, '{"n": 9007199254740993}', 'backup PG: JSON senza conversioni');
      assert.strictEqual(saved.numeri, '{12345678901234567890.1234567890}', 'backup PG: array senza arrotondamenti');
    }
    const compare = mysql
      ? 'SELECT id,parent_id,CAST(n AS CHAR) AS n,testo,HEX(bin) AS bin,CAST(dt AS CHAR) AS dt,calcolata,ST_AsText(g) AS g,CAST(j AS CHAR) AS j,CAST(istante AS CHAR) AS istante FROM t'
      : "SELECT id,parent_id,n::text AS n,testo,encode(bin,'hex') AS bin,dt::text AS dt,calcolata,g::text AS g,j::text AS j,numeri::text AS numeri FROM t";
    const expected = await q(compare);
    const copy = db + '_copy';
    try {
      await roundtripJson(type, port, db, copy);
      await q(mysql ? `USE ${copy}` : `SET search_path TO ${copy}, public`);
      assert.deepStrictEqual(await q(compare), expected, 'roundtrip CodeDB: valori esatti e tipi');
      assert.strictEqual((await q('SELECT * FROM v')).length, 1);
      assert.deepStrictEqual(await q('SELECT * FROM a_riepilogo'), [{ parent_id: 1 }]);
      if (!mysql) assert.strictEqual((await q('SELECT nextval(\'"Seq prova"\')::text AS n'))[0].n, '41');
      if (mysql) await q('CALL p()');
      await q('INSERT INTO t(parent_id) VALUES(1)');
      await q(mysql ? `DROP DATABASE ${copy}` : `DROP SCHEMA ${copy} CASCADE`);
      await q(mysql ? `USE ${db}` : `SET search_path TO ${db}, public`);
      await roundtripJson(type, port, db, copy, 'sql');
      await q(mysql ? `USE ${copy}` : `SET search_path TO ${copy}, public`);
      assert.deepStrictEqual(await q(compare), expected, 'import SQL CodeDB: valori esatti e tipi');
      assert.deepStrictEqual(await q('SELECT * FROM a_riepilogo'), [{ parent_id: 1 }]);
      const externalContainer = process.env[mysql ? 'EXPORT_MYSQL_CONTAINER' : 'EXPORT_PG_CONTAINER'];
      if (externalContainer) {
        const args = mysql ? ['mysqldump', '-uroot', '--default-character-set=utf8mb4', '--hex-blob', '--no-tablespaces', '--set-gtid-purged=OFF', '--routines', '--databases', db]
          : ['pg_dump', '-U', 'postgres', '--no-owner', '--no-privileges', '--schema=' + db, 'postgres'];
        const dump = clientNativo(externalContainer, args);
        assert.strictEqual(dump.status, 0, dump.stderr || dump.error?.message);
        const reportDir = require('node:path').join(process.env.CODEDB_REPORT_ROOT || 'test-reports', 'import-export-2026-10-12');
        require('fs').mkdirSync(reportDir, { recursive: true });
        require('fs').writeFileSync(require('node:path').join(reportDir, type + '.sql'), dump.stdout);
        await q(mysql ? `DROP DATABASE ${copy}` : `DROP SCHEMA ${copy} CASCADE`);
        await q(mysql ? `USE ${db}` : `SET search_path TO ${db}, public`);
        const externalSql = mysql ? dump.stdout.replace("TIME_ZONE='+00:00'", "TIME_ZONE='+05:30'")
          .replace('2026-10-12 07:04:56.123456', '2026-10-12 12:34:56.123456') : dump.stdout;
        await roundtripJson(type, port, db, copy, 'sql', externalSql);
        await q(mysql ? `USE ${copy}` : `SET search_path TO ${copy}, public`);
        assert.deepStrictEqual(await q(compare), expected, 'dump nativo esterno: tutti i valori conservati');
        assert.deepStrictEqual(await q('SELECT * FROM a_riepilogo'), [{ parent_id: 1 }], 'viste concatenate del dump nativo');
      }
      await q(mysql ? `USE ${db}` : `SET search_path TO ${db}, public`);
      await q(mysql ? `DROP DATABASE ${copy}` : `DROP SCHEMA ${copy} CASCADE`);
      const placeholder = mysql ? 'CREATE TABLE costante (n INT); DROP TABLE costante;' : '';
      await roundtripJson(type, port, db, copy, 'sql', placeholder + 'CREATE VIEW costante AS SELECT 42 AS n;');
      assert.deepStrictEqual(await q(`SELECT * FROM ${copy}.costante`), [{ n: 42 }]);
    } finally {
      await q(mysql ? `USE ${db}` : `SET search_path TO ${db}, public`);
      await q(mysql ? `DROP DATABASE IF EXISTS ${copy}` : `DROP SCHEMA IF EXISTS ${copy} CASCADE`);
    }
    const structure = JSON.parse((await exportFile(strategy, db, 'solo-struttura', 'codedb-json')).text);
    assert.strictEqual(structure.collections.length, 2);
    assert(structure.collections.every(c => c.ddl && c.docs.length === 0));
    normalizzaExportDatabase(structure);
    const data = JSON.parse((await exportFile(strategy, db, 'solo-dati', 'codedb-json')).text);
    assert(data.collections.every(c => !c.ddl && !c.postDdl.length));
    assert(!data.objects.views.length && !data.objects.routines.length);
    const selected = JSON.parse((await exportFile(strategy, db, 'personalizzata', 'codedb-json', { 'tabella:t': { struttura: true, dati: true } })).text);
    assert(!selected.objects.views.length);
    assert(!selected.collections[0].postDdl.some(s => /REFERENCES/i.test(s)), 'FK fuori perimetro omessa');
    normalizzaExportDatabase(selected);
    if (!mysql) await q("CREATE FUNCTION f_mv() RETURNS TABLE(parent_id integer) LANGUAGE SQL AS 'SELECT parent_id FROM v_mv'");
    const full = await exportFile(strategy, db, 'struttura-e-dati', 'sql', null, async () => {
      // Scrittura concorrente DOPO l'apertura della snapshot: non deve entrare
      // a metà export, neppure nel conteggio verificato alla fine.
      await q('INSERT INTO padre VALUES (2)');
      await q('INSERT INTO t(parent_id) VALUES (2)');
    });
    await q(mysql ? `DROP DATABASE ${db}` : `DROP SCHEMA ${db} CASCADE`);
    await eseguiFile(full.text);
    await q(mysql ? `USE ${db}` : `SET search_path TO ${db}, public`);
    assert.deepStrictEqual(await q(compare), expected, 'roundtrip SQL: valori esatti, tipi e colonne generate');
    assert.strictEqual((await q('SELECT * FROM v')).length, 1);
    assert.deepStrictEqual(await q('SELECT * FROM a_riepilogo'), [{ parent_id: 1 }]);
    if (!mysql) {
      for (const view of ['mv', 'v_mv', 'mv_seconda']) {
        assert.deepStrictEqual(await q(`SELECT * FROM ${view}`), [{ parent_id: 1 }], `vista ${view} popolata dopo il ripristino dei dati`);
      }
      assert.deepStrictEqual(await q('SELECT * FROM f_mv()'), [{ parent_id: 1 }], 'la routine trova la vista già definita e poi popolata');
    }
    if (mysql) await q('CALL p()');
    await q(`INSERT INTO t(parent_id) VALUES(1)`);
    console.log(`  OK ${type}: quattro modalità, SQL reimportabile, precisione, binari, date, FK, view e identità`);

    // Rilegge il risultato sul motore anche quando la tabella esiste già.
    await q('CREATE TABLE prezzi (negozio INT, prodotto INT, prezzo INT, PRIMARY KEY(negozio, prodotto))');
    await q('CREATE INDEX per_prezzo ON prezzi(prezzo)');
    await q('INSERT INTO prezzi VALUES (1,1,30),(1,2,40)');
    const script = async (righe, tabelle, struttura) => (await exportFile(strategy, db, 'personalizzata', 'sql',
      { 'tabella:prezzi': { struttura, dati: true } }, null, { righe, tabelle })).text;
    const aggiorna = await conSessioneExport(type, port, 'postgres', (emit, url) =>
      scaricaExport(emit, url, { db, formato: 'sql', modalita: 'personalizzata',
        selezione: { 'tabella:prezzi': { struttura: true, dati: true } },
        opzioniSql: { righe: 'aggiorna', tabelle: 'se-assente' } }));
    const ignora = await script('ignora', 'crea', false);
    const replace = mysql && await script('replace', 'crea', false);
    const ricrea = await script('insert', 'ricrea', true);
    const leggi = () => q('SELECT prezzo FROM prezzi ORDER BY negozio, prodotto');
    const cambia = async () => {
      await q('UPDATE prezzi SET prezzo=90 WHERE negozio=1 AND prodotto=1');
      await q('DELETE FROM prezzi WHERE prodotto=2');
    };
    await q('INSERT INTO prezzi VALUES (2,1,99)');
    await q('ALTER TABLE prezzi ADD COLUMN locale INT DEFAULT 7');
    await cambia();
    await eseguiFile(ignora);
    assert.deepStrictEqual(await leggi(), [{ prezzo: 90 }, { prezzo: 40 }, { prezzo: 99 }]);
    await eseguiFile(aggiorna);
    assert.deepStrictEqual(await leggi(), [{ prezzo: 30 }, { prezzo: 40 }, { prezzo: 99 }]);
    assert.deepStrictEqual(await q('SELECT locale FROM prezzi WHERE negozio=1 AND prodotto=1'), [{ locale: 7 }]);
    if (mysql) {
      await q('UPDATE prezzi SET locale=8, prezzo=12 WHERE negozio=1 AND prodotto=1');
      await eseguiFile(replace);
      assert.deepStrictEqual(await q('SELECT prezzo, locale FROM prezzi WHERE negozio=1 AND prodotto=1'), [{ prezzo: 30, locale: 7 }]);
    }
    await eseguiFile(ricrea);
    assert.deepStrictEqual(await leggi(), [{ prezzo: 30 }, { prezzo: 40 }]);
    assert.deepStrictEqual(await q('SELECT * FROM padre'), [{ id: 1 }], 'la tabella esclusa conserva i dati');
    await q('DROP TABLE prezzi');
    await eseguiFile(aggiorna);
    assert.deepStrictEqual(await leggi(), [{ prezzo: 30 }, { prezzo: 40 }], 'se assente crea anche su una destinazione vuota');
    const deveFallire = async (sql, motivo) => {
      await assert.rejects(eseguiFile(sql), motivo);
      // Nell'esecuzione attraverso il driver PostgreSQL la sessione è riusata.
      if (!mysql) await q('ROLLBACK');
    };
    await q('CREATE TABLE dipendente(negozio INT, prodotto INT, FOREIGN KEY (negozio,prodotto) REFERENCES prezzi(negozio,prodotto))');
    await deveFallire(ricrea, /foreign key|depend/i);
    assert.deepStrictEqual(await leggi(), [{ prezzo: 30 }, { prezzo: 40 }], 'la FK della tabella esclusa protegge il bersaglio');
    await q('DROP TABLE dipendente');
    await q(mysql ? 'RENAME TABLE prezzi TO dati_locali' : 'ALTER TABLE prezzi RENAME TO dati_locali');
    await q('DELETE FROM dati_locali');
    await q('CREATE VIEW prezzi AS SELECT * FROM dati_locali');
    for (const sql of [aggiorna, ignora]) {
      await deveFallire(sql, /richiede una tabella/i);
      assert.deepStrictEqual(await q('SELECT * FROM dati_locali'), [], 'la vista aggiornabile non riceve scritture');
    }
    if (!mysql) await verificaPartizioniExport({ strategy, db, q, eseguiFile, deveFallire });
    console.log(`  OK ${type}: script su tabella esistente e assente, chiave composta, dati locali e perimetro della DROP`);
  } finally {
    try { await q(mysql ? `DROP DATABASE IF EXISTS ${db}` : `DROP SCHEMA IF EXISTS ${db} CASCADE`); }
    finally { conn.release(); await strategy.disconnect(); }
  }
}

async function verificaPartizioniExport({ strategy, db, q, eseguiFile, deveFallire }) {
  await q('CREATE TABLE radice (id INT PRIMARY KEY, n INT) PARTITION BY RANGE(id)');
  await q('CREATE TABLE foglia_a PARTITION OF radice FOR VALUES FROM (0) TO (10)');
  await q('CREATE TABLE foglia_b PARTITION OF radice FOR VALUES FROM (10) TO (20)');
  await q('CREATE INDEX per_n ON radice(n)');
  await q('ALTER INDEX foglia_a_n_idx RENAME TO "Indice foglia A"');
  await q('INSERT INTO radice VALUES (1, 42), (11, 43)');
  const esporta = async (nomi, tabelle = 'ricrea', righe = 'insert') => (await exportFile(strategy, db, 'personalizzata', 'sql',
    Object.fromEntries(nomi.map(n => ['tabella:' + n, { struttura: true, dati: true }])),
    null, { tabelle, righe })).text;
  const leggi = () => q('SELECT tableoid::regclass::text AS foglia, n FROM radice ORDER BY id');
  const attese = await leggi();
  await deveFallire(await esporta(['radice']), /partizione esclusa/);
  assert.deepStrictEqual(await leggi(), attese);
  await eseguiFile(await esporta(['foglia_a', 'foglia_b', 'radice']));
  assert.deepStrictEqual(await leggi(), attese, 'ogni riga ricade una sola volta nella partizione originale');
  assert.strictEqual((await q("SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent='per_n'::regclass"))[0].n, 2);
  const parziale = await esporta(['radice', 'foglia_a'], 'se-assente', 'aggiorna');
  const solaFoglia = await esporta(['foglia_a']);
  await q('UPDATE radice SET n=0');
  await eseguiFile(parziale);
  await eseguiFile(solaFoglia);
  assert.deepStrictEqual(await leggi(), [{ foglia: 'foglia_a', n: 42 }, { foglia: 'foglia_b', n: 0 }]);
  assert.strictEqual((await q("SELECT count(*)::int AS n FROM pg_index WHERE indrelid='foglia_a'::regclass"))[0].n, 2);
  assert((await q(`SELECT to_regclass('"Indice foglia A"') IS NOT NULL AS presente`))[0].presente);
}

async function mongo(port) {
  const strategy = new Mongo();
  const db = 'codedb_export_' + crypto.randomBytes(6).toString('hex');
  await strategy.connect({ host: '127.0.0.1', port, directConnection: true });
  try {
    const collection = strategy.client.db(db).collection('t');
    await collection.insertOne({ n: Long.fromString('9007199254740993') });
    await collection.createIndex({ n: 1 }, { unique: true, name: 'n_unico' });
    await strategy.client.db(db).createCollection('v', { viewOn: 't', pipeline: [] });
    await strategy.client.db(db).createCollection('a_riepilogo', { viewOn: 'v', pipeline: [] });
    const artifact = JSON.parse((await exportFile(strategy, db, 'struttura-e-dati', 'codedb-json')).text);
    normalizzaExportDatabase(artifact);
    assert.deepStrictEqual(artifact.collections.map(c => c.name), ['t']);
    assert.deepStrictEqual(artifact.objects.views.map(v => v.name).sort(), ['a_riepilogo', 'v']);
    assert.strictEqual(require('bson').deserialize(require('../db/mongoBson').decode(artifact.collections[0].docs[0]), { promoteLongs: false }).n.toString(), '9007199254740993');
    assert(artifact.collections[0].indexes.some(i => i.name === 'n_unico' && i.unique));
    const copy = db + '_copy';
    try {
      await roundtripJson('mongodb', port, db, copy);
      const restored = strategy.client.db(copy).collection('t');
      assert.strictEqual((await restored.findOne({}, { promoteLongs: false })).n.toString(), '9007199254740993');
      assert((await restored.indexes()).some(i => i.name === 'n_unico' && i.unique));
      assert.strictEqual(await strategy.client.db(copy).collection('a_riepilogo').countDocuments(), 1);
    } finally { await strategy.client.db(copy).dropDatabase(); }
    console.log('  OK mongodb: EJSON canonico e indici completi');
  } finally { await strategy.client.db(db).dropDatabase(); await strategy.disconnect(); }
}

async function conSessioneExport(type, port, physicalDb, prova) {
    const { startTestServer } = require('./e2e-harness');
    const { io } = require('socket.io-client');
    const server = await startTestServer({ port: 3159 });
    const socket = io(server.url);
    const emit = (event, payload) => new Promise((resolve, reject) => socket.timeout(15000).emit(event, payload, (err, result) => {
      if (err) reject(err); else if (!result.ok) reject(new Error(result.error)); else resolve(result);
    }));
    try {
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      await emit('mongo:connect', { tabId: 'export', host: '127.0.0.1', port, dbType: type,
        directConnection: type === 'mongodb',
        username: type === 'mysql' ? 'root' : type === 'postgresql' ? 'postgres' : '', password: require('./lab/credenziali.cjs')(type), database: type === 'postgresql' ? physicalDb : undefined });
      return await prova(emit, server.url);
    } finally { socket.close(); await server.stop(); }
}

async function scaricaExport(emit, url, richiesta) {
  const tabId = 'export';
  const { plan } = await emit('database:export:plan', { tabId, ...richiesta });
  await assert.rejects(emit('database:export:start', { tabId, fingerprint: 'diversa' }), /piano.*cambiato/i);
  const { operation: start } = await emit('database:export:start', { tabId, fingerprint: plan.fingerprint });
  const scadenza = Date.now() + 120000;
  let operation;
  do {
    assert(Date.now() < scadenza, 'export non terminato entro due minuti');
    await new Promise(resolve => setTimeout(resolve, 30));
    ({ operation } = await emit('database:export:status', { tabId, db: richiesta.db, operationId: start.id }));
  } while (operation.status === 'in_corso');
  assert.strictEqual(operation.status, 'completato', operation.error);
  if (richiesta.formato === 'mongosh') assert.equal(operation.filename, richiesta.db + '.mongosh.js');
  const download = await fetch(url + operation.url);
  assert.strictEqual(download.status, 200);
  assert(download.headers.get('etag'));
  const denied = await fetch(url + operation.url.split('?')[0]);
  assert.strictEqual(denied.status, 403, 'il download richiede il ticket');
  return download.text();
}

async function roundtripJson(type, port, db, targetDb, formato = 'codedb-json', externalSql = null, physicalDb = 'postgres') {
  return conSessioneExport(type, port, physicalDb, async (emit, url) => {
      const esportato = await scaricaExport(emit, url, { db, formato });
      const content = externalSql ?? esportato;
      if (formato === 'codedb-json') normalizzaExportDatabase(JSON.parse(content));
      const { uploadId } = await emit('database:import:upload:start', { tabId: 'export', format: formato });
      for (let offset = 0, index = 0; offset < content.length; offset += 65536) {
        await emit('database:import:upload:chunk', { tabId: 'export', uploadId, index: index++, chunk: content.slice(offset, offset + 65536) });
      }
      const uploaded = await emit('database:import:upload:finish', { tabId: 'export', uploadId });
      const request = { tabId: 'export', uploadId, targetDb, drop: true };
      const preview = await emit('database:import:start', { ...request, previewOnly: true });
      if (uploaded.artifact.views.length && !uploaded.artifact.collections.length) {
        const { selezione } = await emit('database:import:selezione', request);
        assert.deepStrictEqual(selezione.voci.map(v => v.nome), preview.plan.views);
      }
      const { accepted } = await emit('database:import:start', { ...request, expectedFingerprint: preview.plan.fingerprint });
      const deadline = Date.now() + 120000;
      let operation;
      do {
        assert(Date.now() < deadline, 'import non terminato entro due minuti');
        await new Promise(resolve => setTimeout(resolve, 50));
        ({ operation } = await emit('database:import:state', { tabId: 'export', operationId: accepted.operationId }));
      } while (operation.status === 'in_corso');
      assert.strictEqual(operation.status, 'completato', JSON.stringify(operation));
      await emit('database:import:cleanup', { tabId: 'export', operationId: accepted.operationId });
      console.log(`  OK ${type}: export HTTP, ticket, upload e import ${formato} con staging`);
  });
}

if (require.main === module) (async () => {
  assert(process.env.EXPORT_MYSQL_PORT && process.env.EXPORT_PG_PORT && process.env.EXPORT_MONGO_PORT, 'Indicare le tre porte dei database usa-e-getta.');
  await sql('mysql', Number(process.env.EXPORT_MYSQL_PORT));
  await sql('postgresql', Number(process.env.EXPORT_PG_PORT));
  await mongo(Number(process.env.EXPORT_MONGO_PORT));
})().catch(err => { console.error(err); process.exitCode = 1; });

module.exports = { roundtripJson, conSessioneExport, scaricaExport };
