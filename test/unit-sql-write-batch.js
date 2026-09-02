'use strict';

// Interfaccia delle Strategie SQL per il batch di scrittura: tutte le
// istruzioni usano una sola connessione e una sola transazione.

const assert = require('assert');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const { guardStrategy } = require('../auth/guardStrategy');
const { ROOT_PRINCIPAL } = require('../auth/principal');
const DbStrategy = require('../db/DbStrategy');

// Il tetto di tempo va OSSERVATO, non dato per scontato: la connessione finta
// registra il `timeout` per-query che mysql2 riceve davvero.
const TETTO = DbStrategy.aggregateTimeoutMs();
const conTetto = (elenco) => elenco.flatMap((sql) => [sql, `TIMEOUT=${TETTO}`]);

console.log('--- Test transazione SQL per execute_write batch ---');

function mysqlFinto({ fallisceSu, timeoutSu } = {}) {
  const eventi = [];
  const conn = {
    threadId: 42,
    async query(request) {
      const sql = typeof request === 'string' ? request : request.sql;
      eventi.push(sql);
      if (typeof request === 'object' && request.timeout) eventi.push(`TIMEOUT=${request.timeout}`);
      if (timeoutSu && sql.includes(timeoutSu)) {
        // La forma con cui mysql2 segnala lo scadere del proprio timeout
        // per-query: il driver smette di aspettare, il server no.
        const err = new Error('Query inactivity timeout');
        err.code = 'PROTOCOL_SEQUENCE_TIMEOUT';
        throw err;
      }
      if (fallisceSu && sql.includes(fallisceSu)) throw new Error('Errore MySQL simulato');
      if (/^INSERT/i.test(sql)) return [{ affectedRows: 1, insertId: 7, info: 'inserita' }, []];
      if (/^UPDATE/i.test(sql)) return [{ affectedRows: 2 }, []];
      return [{ affectedRows: 0 }, []];
    },
    async beginTransaction() { eventi.push('BEGIN'); },
    async commit() { eventi.push('COMMIT'); },
    async rollback() { eventi.push('ROLLBACK'); },
    release() { eventi.push('RELEASE'); },
    destroy() { eventi.push('DESTROY'); },
  };
  return { eventi, pool: { async getConnection() { eventi.push('GET_CONNECTION'); return conn; } } };
}

function postgresFinto({ fallisceSu } = {}) {
  const eventi = [];
  const client = {
    async query(sql) {
      eventi.push(sql);
      if (fallisceSu && sql.includes(fallisceSu)) throw new Error('Errore PostgreSQL simulato');
      if (/^INSERT/i.test(sql)) return { command: 'INSERT', rowCount: 1, rows: [], fields: [] };
      if (/^UPDATE/i.test(sql)) return { command: 'UPDATE', rowCount: 2, rows: [], fields: [] };
      return { command: String(sql).split(/\s+/)[0], rowCount: null, rows: [], fields: [] };
    },
    release() { eventi.push('RELEASE'); },
  };
  return { eventi, pool: { async connect() { eventi.push('CONNECT'); return client; } } };
}

module.exports = (async () => {
  const statements = [
    'INSERT INTO persone (nome) VALUES (\'Ada\')',
    'UPDATE persone SET attivo = 1 WHERE nome = \'Ada\'',
  ];

  const mysqlOk = mysqlFinto();
  const mysql = new MySqlStrategy();
  mysql.pool = mysqlOk.pool;
  const mysqlResult = await mysql.executeWriteBatch('app', statements);
  assert.deepStrictEqual(mysqlOk.eventi, [
    'GET_CONNECTION', 'USE `app`', 'BEGIN', ...conTetto(statements), 'COMMIT', 'RELEASE',
  ]);
  assert.strictEqual(mysqlResult.transactional, true);
  assert.strictEqual(mysqlResult.completed, 2);
  assert.deepStrictEqual(mysqlResult.results.map((result) => result.righeCoinvolte), [1, 2]);

  const mysqlKo = mysqlFinto({ fallisceSu: 'UPDATE' });
  mysql.pool = mysqlKo.pool;
  await assert.rejects(() => mysql.executeWriteBatch('app', statements), (err) => {
    assert.strictEqual(err.auditResult.rolledBack, true);
    assert.strictEqual(err.auditResult.failedIndex, 1);
    assert.strictEqual(err.auditResult.completed, 0, 'dopo il rollback nessuna mutazione e completata');
    return true;
  });
  assert.deepStrictEqual(mysqlKo.eventi, [
    'GET_CONNECTION', 'USE `app`', 'BEGIN', ...conTetto(statements), 'ROLLBACK', 'RELEASE',
  ]);
  console.log('  OK   MySQL: commit unico e rollback integrale al primo errore');

  // Il tetto di tempo lascia la connessione AVVELENATA: il ROLLBACK esplicito
  // non si puo' mandare e la connessione si distrugge invece di tornare al
  // pool. La transazione viene comunque annullata dal server alla
  // disconnessione, ed e' esattamente cio' che l'audit deve dichiarare —
  // prima registrava `rolledBack: false` con le mutazioni date per applicate,
  // cioe' scriveva nel registro delle scritture che non esistono.
  const mysqlTimeout = mysqlFinto({ timeoutSu: 'UPDATE' });
  mysql.pool = mysqlTimeout.pool;
  const uccisi = [];
  mysql.uccidiSulServer = async (threadId) => { uccisi.push(threadId); };
  await assert.rejects(() => mysql.executeWriteBatch('app', statements), (err) => {
    assert.strictEqual(err.auditResult.rolledBack, true,
      'la disconnessione annulla la transazione: l\'audit non deve dire il contrario');
    assert.strictEqual(err.auditResult.rolledBackBy, 'disconnessione',
      'e deve dichiarare COME e stata annullata');
    assert.strictEqual(err.auditResult.completed, 0,
      'nessuna mutazione resta applicata');
    return true;
  });
  assert.deepStrictEqual(uccisi, [42], 'la query va fermata anche sul server, non solo nel driver');
  assert(mysqlTimeout.eventi.includes('DESTROY') && !mysqlTimeout.eventi.includes('RELEASE'),
    'una connessione avvelenata si distrugge, non torna nel pool');
  assert(!mysqlTimeout.eventi.includes('ROLLBACK'),
    'su una connessione avvelenata il ROLLBACK esplicito non si manda');
  console.log('  OK   MySQL: il timeout distrugge la connessione e dichiara l\'annullamento');

  const pgOk = postgresFinto();
  const postgres = new PostgreSqlStrategy();
  postgres.pool = pgOk.pool;
  const pgResult = await postgres.executeWriteBatch('app', statements);
  assert.strictEqual(pgOk.eventi[0], 'CONNECT');
  assert.strictEqual(pgOk.eventi[1], 'BEGIN');
  assert(pgOk.eventi.some((sql) => /SET LOCAL search_path TO "app"/.test(sql)));
  assert.deepStrictEqual(pgOk.eventi.slice(-4), [...statements, 'COMMIT', 'RELEASE']);
  assert.strictEqual(pgResult.transactional, true);
  assert.deepStrictEqual(pgResult.results.map((result) => result.righeCoinvolte), [1, 2]);

  const pgKo = postgresFinto({ fallisceSu: 'UPDATE' });
  postgres.pool = pgKo.pool;
  await assert.rejects(() => postgres.executeWriteBatch('app', statements), (err) => {
    assert.strictEqual(err.auditResult.rolledBack, true);
    assert.strictEqual(err.auditResult.failedIndex, 1);
    assert.strictEqual(err.auditResult.completed, 0);
    return true;
  });
  assert.deepStrictEqual(pgKo.eventi.slice(-3), [statements[1], 'ROLLBACK', 'RELEASE']);
  assert(pgKo.eventi.indexOf('ROLLBACK') < pgKo.eventi.indexOf('RELEASE'));
  console.log('  OK   PostgreSQL: commit unico e rollback integrale al primo errore');

  const chiamateProtette = [];
  const raw = {
    type: 'mysql',
    async executeWriteBatch(db, sql) { chiamateProtette.push({ db, sql }); return { completed: sql.length }; },
  };
  const soloWrite = guardStrategy(raw, {
    connName: 'sql',
    principal: {
      id: 'writer', type: 'subuser', ownerId: 'tenant', root: false, owner: false,
      grants: [{ connName: 'sql', capabilities: ['read', 'write'], scope: null }],
      connScope: null,
    },
  });
  await assert.rejects(
    () => soloWrite.executeWriteBatch('app', [
      'INSERT INTO persone (nome) VALUES (\'Ada\')',
      'DELETE FROM persone WHERE nome = \'Ada\'',
    ]),
    /Permesso negato/,
    'la presenza di DELETE deve richiedere la capability delete',
  );
  assert.strictEqual(chiamateProtette.length, 0, 'un batch non autorizzato non deve raggiungere il driver');

  const root = guardStrategy(raw, { connName: 'sql', principal: ROOT_PRINCIPAL });
  await assert.rejects(
    () => root.executeWriteBatch('app', ['DROP TABLE persone']),
    /solo INSERT, UPDATE, DELETE o REPLACE/,
    'nemmeno root puo usare il metodo DML per aggirare execute_ddl',
  );
  await assert.rejects(
    () => root.executeWriteBatch('app', ['INSERT INTO a VALUES (1); DELETE FROM b WHERE id = 1']),
    /un solo statement/,
    'ogni descrittore deve restare uno statement singolo anche alla conferma',
  );
  console.log('  OK   il metodo batch applica capability e invarianti SQL anche alla conferma');

  // Due copie identiche si comportano identicamente: un test di solo
  // comportamento passerebbe anche con la logica del batch ricopiata nei due
  // adattatori, che e' esattamente com'era prima. La regola sta in
  // `db/sqlWriteBatch.js` e gli adattatori dichiarano solo il dialetto: qui si
  // controlla il TESTO, come gia' si fa per la regola degli identificatori.
  const fs = require('fs');
  const path = require('path');
  for (const file of ['MySqlStrategy.js', 'PostgreSqlStrategy.js']) {
    const sorgente = fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8');
    const corpo = sorgente.slice(sorgente.indexOf('async executeWriteBatch('));
    const metodo = corpo.slice(0, corpo.indexOf('\n  }\n') + 4);
    assert(/eseguiBatchScritture\(/.test(metodo),
      `${file} deve passare dal motore comune del batch`);
    assert(!/auditResult/.test(metodo),
      `${file} non deve ricomporre l'esito di fallimento: e' la parte che divergeva`);
    assert(!/rolledBack/.test(metodo),
      `${file} non deve decidere da se' come si dichiara l'annullamento`);
  }
  console.log('  OK   nessuna copia della logica del batch sopravvive nei due adattatori');
})().catch((err) => {
  console.error('  FAIL transazione SQL batch:', err.stack || err);
  process.exitCode = 1;
});
