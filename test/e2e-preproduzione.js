'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { io } = require('socket.io-client');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');

(async () => {
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_preprod' });
  const db = targets.target('dati');
  const server = await startTestServer({ port: 3157 });
  const socket = io(server.url, { transports: ['websocket'] });
  const strategie = [];
  const emit = (event, payload) => new Promise((resolve, reject) => socket.timeout(20000).emit(event, payload, (err, res) => {
    if (err || !res?.ok) reject(err || new Error(res?.error || event)); else resolve(res);
  }));
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    for (const [type, classe, variabile] of [['mongodb', 'MongoDb', 'EXPORT_MONGO_PORT'], ['mysql', 'MySql', 'EXPORT_MYSQL_PORT'], ['postgresql', 'PostgreSql', 'EXPORT_PG_PORT']]) {
      const port = Number(process.env[variabile]);
      assert(port, `${variabile} obbligatoria: usare database dedicati`);
      const cfg = { dbType: type, host: '127.0.0.1', port, directConnection: type === 'mongodb', username: type === 'postgresql' ? 'postgres' : type === 'mysql' ? 'root' : '', password: require('./lab/credenziali.cjs')(type), database: type === 'postgresql' ? 'postgres' : '' };
      const st = new (require(`../db/${classe}Strategy`))();
      await st.connect(cfg); strategie.push(st);
      await emit('mongo:connect', { ...cfg, tabId: type });
      if (type === 'mongodb') {
        await st.client.db(db).collection('t').insertMany([{ id: 1, nome: 'A', city: 'Roma' }, { id: 1, nome: 'B', city: 'Roma' }, { id: 2, nome: 'C', city: null }, { id: 3, nome: 'D' }]);
      } else {
        const conn = type === 'mysql' ? await st.pool.getConnection() : await st.pool.connect();
        try {
          await conn.query(type === 'mysql' ? `CREATE DATABASE ${db}` : `CREATE SCHEMA ${db}`);
          await conn.query(`CREATE TABLE ${db}.t (id INT PRIMARY KEY, nome TEXT)`);
          await conn.query(`INSERT INTO ${db}.t VALUES (1,'origine'),(2,'secondo')`);
        } finally { conn.release(); }
      }
    }
    const query = async (tabId, code, extra = {}) => (await emit('query:execute', { tabId, db, coll: 't', engine: 'auto', code, ...extra })).data;
    const gruppi = await query('mongodb', 'SELECT city, COUNT(*) AS n FROM t GROUP BY city ORDER BY n DESC');
    assert.deepEqual(gruppi.sort((a, b) => String(a.city).localeCompare(String(b.city))), [{ city: null, n: 2 }, { city: 'Roma', n: 2 }]);
    assert.equal((await query('mongodb', 'SELECT COUNT(city) AS n FROM t'))[0].n, 2);
    const alias = await query('mongodb', 'SELECT nome AS n FROM t ORDER BY n DESC');
    assert.deepEqual(alias.map(r => r.n), ['D', 'C', 'B', 'A']);
    for (const tabId of ['mysql', 'postgresql']) {
      await query(tabId, 'BEGIN');
      await query(tabId, 'INSERT INTO t VALUES (8,\'rollback\')');
      await query(tabId, 'ROLLBACK');
      assert.equal((await query(tabId, 'SELECT * FROM t WHERE id=8')).length, 0);
      const fase = (evento, runId, payload, fallitiAttesi = 0) => new Promise(async (resolve, reject) => {
        const timer = setTimeout(() => { socket.off('script:progress', listener); reject(new Error('Timeout script')); }, 20000);
        function listener(ev) {
          if (ev.runId !== runId || !['done', 'aborted', 'paused'].includes(ev.tipo)) return;
          clearTimeout(timer); socket.off('script:progress', listener);
          if (ev.stato.falliti !== fallitiAttesi) reject(new Error(JSON.stringify(ev.stato.results))); else resolve(ev.stato);
        }
        socket.on('script:progress', listener);
        try {
          const args = { tabId, runId, ...payload };
          if (evento === 'script:execute') await (await import('../public/js/script-upload.js')).inviaScript(emit, args);
          else await emit(evento, args);
        }
        catch (err) { clearTimeout(timer); socket.off('script:progress', listener); reject(err); }
      });
      const script = (code, extra = {}, fallitiAttesi = 0) =>
        fase('script:execute', randomUUID(), { db, coll: 't', engine: 'auto', code, ...extra }, fallitiAttesi);
      if (tabId === 'mysql') {
        const prefix = "INSERT INTO t VALUES (4, SHA2('";
        const literal = 'a'.repeat(512 * 1024 - 1 - prefix.length) + '😀' + 'x'.repeat(5 * 1024 * 1024);
        const stato = await script(prefix + literal + "', 256));", { fileChunk: true });
        assert.ok(JSON.stringify(stato).length < 10000, 'Il riepilogo del blocco non contiene il literal da oltre 5 MiB');
        await script('/*!50001 CREATE*/ /*!50001 VIEW v_blocchi AS SELECT nome FROM t WHERE id=4 */;');
        const vista = await query(tabId, 'SELECT nome FROM v_blocchi');
        assert.equal(vista[0].nome, require('node:crypto').createHash('sha256').update(literal).digest('hex'),
          'La vista del dump legge il valore ottenuto dal literal UTF-8 integro');
      }
      await Promise.all([
        script('BEGIN; INSERT INTO t VALUES (10,\'annulla\'); ROLLBACK;'),
        script('BEGIN; INSERT INTO t VALUES (11,\'conferma\'); COMMIT;'),
      ]);
      assert.deepEqual((await query(tabId, 'SELECT id FROM t WHERE id>=10')).map(r => r.id), [11]);
      const primo = await script('BEGIN; INSERT INTO t VALUES (20,\'fra blocchi\');', { keepSqlSession: true });
      await query(tabId, 'SELECT 1');
      await script('ROLLBACK;', { previousRunId: primo.id });
      assert.equal((await query(tabId, 'SELECT * FROM t WHERE id=20')).length, 0, 'rollback attraversa i blocchi del file SQL');
      const parziale = await script("BEGIN; INSERT INTO t VALUES (23,'prima'); INSERT INTO t VALUES (1,'duplicato');", { keepSqlSession: true }, 1);
      assert.equal((await query(tabId, 'SELECT id FROM t WHERE id=23')).length, 0, 'il confine del blocco non esegue un commit implicito');
      const concluso = await script("INSERT INTO t VALUES (24,'dopo'); COMMIT;", { previousRunId: parziale.id });
      assert.deepEqual((await query(tabId, 'SELECT id FROM t WHERE id IN (23,24) ORDER BY id')).map(r => r.id), [23, 24],
        'il COMMIT del file conferma le righe valide prima e dopo la chiave duplicata');
      assert.equal(concluso.status, 'done');
      const cambiato = await script(`USE ${db};`, { db: 'information_schema', keepSqlSession: true });
      await script("INSERT INTO t VALUES (25,'dopo USE');", { db: 'information_schema', previousRunId: cambiato.id });
      assert.equal((await query(tabId, 'SELECT id FROM t WHERE id=25')).length, 1, 'la continuazione usa il database scelto nello script');
      const fermato = await script("BEGIN; INSERT INTO t VALUES (26,'prima'); INSERT INTO t VALUES (1,'duplicato'); COMMIT;",
        { stopOnError: true, keepSqlSession: true }, 1);
      assert.equal(fermato.status, 'paused');
      assert.equal(fermato.eseguiti, 3, 'la pausa precede il COMMIT');
      await emit('script:abort', { tabId, runId: fermato.id });
      assert.equal((await query(tabId, 'SELECT id FROM t WHERE id=26')).length, 0, 'annullare il blocco in pausa annulla le scritture pendenti');
      const riprendibile = await script("BEGIN; INSERT INTO t VALUES (29,'prima'); INSERT INTO t VALUES (1,'duplicato'); INSERT INTO t VALUES (30,'dopo'); COMMIT;",
        { stopOnError: true, fileChunk: true }, 1);
      assert.equal(riprendibile.status, 'paused');
      assert.equal((await fase('script:resume', riprendibile.id, {}, 1)).status, 'done');
      assert.deepEqual((await query(tabId, 'SELECT id FROM t WHERE id IN (29,30) ORDER BY id')).map(r => r.id), [29, 30]);
      if (tabId === 'postgresql') {
        await script("BEGIN; SAVEPOINT codedb_istruzione; INSERT INTO t VALUES (27,'annulla'); INSERT INTO t VALUES (1,'duplicato'); ROLLBACK TO codedb_istruzione; INSERT INTO t VALUES (28,'conferma'); COMMIT;", {}, 1);
        assert.deepEqual((await query(tabId, 'SELECT id FROM t WHERE id IN (27,28)')).map(r => r.id), [28], 'il savepoint esplicito rimane utilizzabile');
        const annullato = await script("BEGIN; INSERT INTO t VALUES (34,'persa'); ROLLBACK TO assente; COMMIT; INSERT INTO t VALUES (35,'da saltare');",
          { fileChunk: true }, 2);
        assert.equal(annullato.status, 'aborted');
        assert.match(annullato.results.at(-1).error, /annullato.*COMMIT/);
        assert.equal((await query(tabId, 'SELECT id FROM t WHERE id IN (34,35)')).length, 0);
      } else {
        const implicito = await script("BEGIN; INSERT INTO t VALUES (34,'confermata dal DDL'); ALTER TABLE t ADD PRIMARY KEY(id); INSERT INTO t VALUES (35,'da saltare');",
          { fileChunk: true }, 1);
        assert.equal(implicito.status, 'aborted', 'un DDL MySQL che fallisce dopo un commit implicito ha chiuso la transazione');
        assert.deepEqual((await query(tabId, 'SELECT id FROM t WHERE id IN (34,35)')).map(r => r.id), [34]);
      }
      const pid = tabId === 'mysql' ? 'CONNECTION_ID()' : 'pg_backend_pid()';
      const daInterrompere = await script(`BEGIN; INSERT INTO t VALUES (31,'prima'); SELECT ${pid} AS pid;`, { keepSqlSession: true });
      const { ultimoRisultato } = await emit('script:state', { tabId, runId: daInterrompere.id });
      const proprioPid = Number(ultimoRisultato.docs[0].pid);
      assert(Number.isSafeInteger(proprioPid) && proprioPid > 0, 'PID della sessione SQL della fixture');
      const strategia = strategie.find(s => s.type === tabId);
      await strategia.pool.query(tabId === 'mysql' ? `KILL CONNECTION ${proprioPid}` : `SELECT pg_terminate_backend(${proprioPid})`);
      const persa = await script("INSERT INTO t VALUES (32,'dopo'); COMMIT; INSERT INTO t VALUES (33,'da saltare');",
        { previousRunId: daInterrompere.id, keepSqlSession: true }, 1);
      assert.equal(persa.status, 'aborted', 'la perdita della connessione SQL interrompe il file');
      assert.equal(persa.eseguiti, 1, 'nessun COMMIT o scrittura automatica su una nuova sessione');
      assert.equal((await query(tabId, 'SELECT id FROM t WHERE id IN (31,32,33)')).length, 0);
      const interrotto = await script('BEGIN; INSERT INTO t VALUES (21,\'interrotto\');', { keepSqlSession: true });
      assert.equal((await emit('script:abort', { tabId, runId: interrotto.id })).transazioneAnnullata, true);
      assert.equal((await query(tabId, 'SELECT * FROM t WHERE id=21')).length, 0, 'interruzione del file annulla la transazione aperta');
      await script('CREATE TEMPORARY TABLE prova_sessione (id INT); INSERT INTO prova_sessione VALUES (1); SELECT * FROM prova_sessione; DROP TABLE prova_sessione;');
      const avviso = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off('script:progress', listener); reject(new Error('Avviso rollback mancante')); }, 20000);
        function listener(ev) {
          if (ev.tabId !== tabId || ev.tipo !== 'avviso') return;
          clearTimeout(timer); socket.off('script:progress', listener); resolve(ev);
        }
        socket.on('script:progress', listener);
      });
      const senzaCommit = await script('BEGIN; INSERT INTO t VALUES (22,\'senza commit\');');
      assert.equal(senzaCommit.transazioneAnnullata, true, 'il riepilogo finale deve distinguere una transazione annullata');
      const evento = await avviso;
      assert.equal(evento.runId, senzaCommit.id);
      assert.match(evento.avviso, /annullata/);
      assert.equal((await query(tabId, 'SELECT * FROM t WHERE id=22')).length, 0, 'transazione incompleta annullata con avviso');
      const code = JSON.stringify({ virtualJoin: { sourceA: { tabId, db, table: 't', dbType: tabId }, sourceB: { tabId: 'mongodb', db, collection: 't', dbType: 'mongodb' }, on: { leftKey: 'id', rightKey: 'id' } } });
      const joined = await query(tabId, code, { engine: 'crossdb' });
      assert.equal(joined.filter(r => r.id === 1).length, 2, 'non perdere la seconda corrispondenza cross-DB');
    }
    console.log('PASS: MongoDB reale (GROUP BY, COUNT, alias); MySQL/PostgreSQL reali (COMMIT fra blocchi con errori, USE, pausa, rollback, script concorrenti, JOIN cross-DB).');
  } finally {
    socket.close();
    await server.stop();
    for (const st of strategie) {
      try {
        await targets.drop(db, async () => {
          if (st.type === 'mongodb') await st.client.db(db).dropDatabase();
          else await st.pool.query(st.type === 'mysql' ? `DROP DATABASE IF EXISTS ${db}` : `DROP SCHEMA IF EXISTS ${db} CASCADE`);
        });
      } finally { await st.disconnect(); }
    }
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
