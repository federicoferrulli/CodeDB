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
      const cfg = { dbType: type, host: '127.0.0.1', port, username: type === 'postgresql' ? 'postgres' : type === 'mysql' ? 'root' : '', password: require('./lab/credenziali.cjs')(type), database: type === 'postgresql' ? 'postgres' : '' };
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
      const script = (code, extra = {}) => new Promise(async (resolve, reject) => {
        const runId = randomUUID();
        const timer = setTimeout(() => { socket.off('script:progress', listener); reject(new Error('Timeout script')); }, 20000);
        function listener(ev) {
          if (ev.runId !== runId || !['done', 'aborted'].includes(ev.stato?.status)) return;
          clearTimeout(timer); socket.off('script:progress', listener);
          if (ev.stato.falliti) reject(new Error(JSON.stringify(ev.stato.results))); else resolve(ev.stato);
        }
        socket.on('script:progress', listener);
        try { await emit('script:execute', { tabId, runId, db, coll: 't', engine: 'auto', code, ...extra }); }
        catch (err) { clearTimeout(timer); socket.off('script:progress', listener); reject(err); }
      });
      await Promise.all([
        script('BEGIN; INSERT INTO t VALUES (10,\'annulla\'); ROLLBACK;'),
        script('BEGIN; INSERT INTO t VALUES (11,\'conferma\'); COMMIT;'),
      ]);
      assert.deepEqual((await query(tabId, 'SELECT id FROM t WHERE id>=10')).map(r => r.id), [11]);
      const primo = await script('BEGIN; INSERT INTO t VALUES (20,\'fra blocchi\');', { keepSqlSession: true });
      await query(tabId, 'SELECT 1');
      await script('ROLLBACK;', { previousRunId: primo.id });
      assert.equal((await query(tabId, 'SELECT * FROM t WHERE id=20')).length, 0, 'rollback attraversa i blocchi del file SQL');
      const interrotto = await script('BEGIN; INSERT INTO t VALUES (21,\'interrotto\');', { keepSqlSession: true });
      await emit('script:abort', { tabId, runId: interrotto.id });
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
      const evento = await avviso;
      assert.equal(evento.runId, senzaCommit.id);
      assert.match(evento.avviso, /annullata/);
      assert.equal((await query(tabId, 'SELECT * FROM t WHERE id=22')).length, 0, 'transazione incompleta annullata con avviso');
      const code = JSON.stringify({ virtualJoin: { sourceA: { tabId, db, table: 't', dbType: tabId }, sourceB: { tabId: 'mongodb', db, collection: 't', dbType: 'mongodb' }, on: { leftKey: 'id', rightKey: 'id' } } });
      const joined = await query(tabId, code, { engine: 'crossdb' });
      assert.equal(joined.filter(r => r.id === 1).length, 2, 'non perdere la seconda corrispondenza cross-DB');
    }
    console.log('PASS: MongoDB reale (GROUP BY, COUNT, alias); MySQL/PostgreSQL reali (rollback interattivo, script concorrenti, JOIN cross-DB).');
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
