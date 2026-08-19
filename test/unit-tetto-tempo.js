'use strict';

/* ---------------------------------------------------------------------------
 * Tetto di tempo sull'esecuzione delle query libere (SQL Raw / tab ⚡).
 *
 * `collectionAggregate` è la porta unica della query libera su SQL: ci passano
 * sia le letture sia le scritture. Il tetto di tempo però valeva solo sul ramo
 * di SOLA LETTURA — su MySQL come opzione `timeout` del driver, su PostgreSQL
 * come `SET LOCAL statement_timeout` dentro la transazione READ ONLY — e in
 * entrambi i casi come costante `30000` scritta nel corpo del metodo.
 *
 * Due difetti in uno:
 *
 *   1. una query di SCRITTURA sbagliata (un UPDATE senza WHERE utile, un ALTER
 *      su una tabella enorme) non aveva alcun limite: teneva una connessione
 *      del pool finché il server non finiva da solo;
 *   2. il valore non veniva dalla fonte configurabile dell'interfaccia della
 *      strategia (`DbStrategy.aggregateTimeoutMs`, env
 *      CODEDB_AGGREGATE_TIMEOUT_MS), quindi cambiare la configurazione non
 *      cambiava nulla proprio dove il tetto serviva di più.
 *
 * Qui si prova la DECISIONE, non il database: i pool sono finti e registrano
 * ciò che la strategia chiede al driver. Un timeout vero richiederebbe un
 * server lento; ciò che si può provare senza è che il limite venga IMPOSTO, su
 * entrambi i rami e su entrambi i motori, e che segua la configurazione.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const DbStrategy = require('../db/DbStrategy');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const { spiegaErrore } = require('../db/errors');

let falliti = 0;
function prova(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  OK   ${nome}`))
    .catch((err) => {
      falliti++;
      console.error(`  FAIL ${nome}: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    });
}

/* --- Pool finti ---------------------------------------------------------- */

// mysql2: `pool.getConnection()` → connessione con `query`, `release`,
// `destroy` e `threadId`. Ogni connessione registra le chiamate ricevute.
function poolMySql({ erroreSu = null, errore = null } = {}) {
  const connessioni = [];
  const pool = {
    async getConnection() {
      const conn = {
        threadId: 4242,
        chiamate: [],
        rilasciata: false,
        distrutta: false,
        async query(arg, params) {
          const sql = typeof arg === 'string' ? arg : arg.sql;
          conn.chiamate.push({ arg, sql, params });
          if (errore && erroreSu && sql === erroreSu) throw errore;
          if (/^SELECT CONNECTION_ID/i.test(sql)) return [[{ cid: 4242 }], []];
          return [[], []];
        },
        release() { conn.rilasciata = true; },
        destroy() { conn.distrutta = true; },
      };
      connessioni.push(conn);
      return conn;
    },
  };
  return { pool, connessioni };
}

// pg: `pool.connect()` → client con `query` e `release`.
function poolPg() {
  const clients = [];
  const pool = {
    async connect() {
      const client = {
        processID: 99,
        chiamate: [],
        rilasciato: false,
        async query(sql, params) {
          client.chiamate.push({ sql: String(sql), params });
          return { rows: [], command: 'UPDATE', rowCount: 3 };
        },
        release() { client.rilasciato = true; },
      };
      clients.push(client);
      return client;
    },
  };
  return { pool, clients };
}

function conEnv(valore, fn) {
  const prima = process.env.CODEDB_AGGREGATE_TIMEOUT_MS;
  if (valore == null) delete process.env.CODEDB_AGGREGATE_TIMEOUT_MS;
  else process.env.CODEDB_AGGREGATE_TIMEOUT_MS = String(valore);
  const ripristina = () => {
    if (prima === undefined) delete process.env.CODEDB_AGGREGATE_TIMEOUT_MS;
    else process.env.CODEDB_AGGREGATE_TIMEOUT_MS = prima;
  };
  return Promise.resolve().then(fn).then(
    (v) => { ripristina(); return v; },
    (e) => { ripristina(); throw e; }
  );
}

// La chiamata che porta la query dell'utente, non i preamboli (USE/SET/BEGIN).
function chiamataUtente(chiamate, sqlUtente) {
  return chiamate.find((c) => c.sql === sqlUtente);
}

const SQL_SCRITTURA = 'UPDATE ordini SET stato = 1';
const SQL_LETTURA = 'SELECT * FROM ordini';

/* --- MySQL --------------------------------------------------------------- */

async function mysqlArgQuery(payload, sqlUtente) {
  const { pool, connessioni } = poolMySql();
  const s = new MySqlStrategy();
  s.pool = pool;
  await s.collectionAggregate('negozio', null, { pipeline: sqlUtente, ...payload });
  const c = chiamataUtente(connessioni[0].chiamate, sqlUtente);
  assert.ok(c, `la query dell'utente non è stata eseguita: ${JSON.stringify(connessioni[0].chiamate.map((x) => x.sql))}`);
  return c.arg;
}

module.exports = (async () => {
  console.log('--- Tetto di tempo sulle query libere (MySQL / PostgreSQL) ---');

  await prova('MySQL: la SCRITTURA riceve il tetto di tempo del driver', async () => {
    const arg = await mysqlArgQuery({}, SQL_SCRITTURA);
    assert.strictEqual(typeof arg, 'object',
      'la scrittura viene passata come stringa nuda: nessun tetto di tempo');
    assert.strictEqual(arg.timeout, DbStrategy.aggregateTimeoutMs());
  });

  await prova('MySQL: la LETTURA riceve lo stesso tetto, dalla fonte configurabile', async () => {
    const arg = await mysqlArgQuery({ readOnly: true }, SQL_LETTURA);
    assert.strictEqual(typeof arg, 'object');
    assert.strictEqual(arg.timeout, DbStrategy.aggregateTimeoutMs());
  });

  await prova('MySQL: cambiare CODEDB_AGGREGATE_TIMEOUT_MS cambia il tetto su entrambi i rami', () =>
    conEnv(7321, async () => {
      assert.strictEqual((await mysqlArgQuery({}, SQL_SCRITTURA)).timeout, 7321);
      assert.strictEqual((await mysqlArgQuery({ readOnly: true }, SQL_LETTURA)).timeout, 7321);
    }));

  await prova('MySQL: un tetto <= 0 disattiva il limite', () =>
    conEnv(0, async () => {
      const arg = await mysqlArgQuery({}, SQL_SCRITTURA);
      const timeout = typeof arg === 'string' ? undefined : arg.timeout;
      assert.strictEqual(timeout, undefined, 'con tetto 0 non va imposto alcun timeout');
    }));

  await prova('MySQL: allo scadere la query viene UCCISA sul server e la connessione non torna al pool', async () => {
    const err = new Error('Query inactivity timeout');
    err.code = 'PROTOCOL_SEQUENCE_TIMEOUT';
    const { pool, connessioni } = poolMySql({ erroreSu: SQL_SCRITTURA, errore: err });
    const s = new MySqlStrategy();
    s.pool = pool;
    await assert.rejects(
      () => s.collectionAggregate('negozio', null, { pipeline: SQL_SCRITTURA }),
      (e) => e.code === 'PROTOCOL_SEQUENCE_TIMEOUT',
      'lo scadere del tetto deve risalire al chiamante, con il codice del driver intatto'
    );
    // Il testo italiano (causa + rimedio) vive in un posto solo: `spiegaErrore`.
    assert.match(spiegaErrore(err), /tempo massimo consentito/i);
    const kill = connessioni.some((c) => c.chiamate.some((x) => /^KILL QUERY 4242$/.test(x.sql)));
    assert.ok(kill, 'senza KILL QUERY il server continua a eseguire la scrittura');
    assert.ok(connessioni[0].distrutta,
      'la connessione avvelenata (risultato ancora in arrivo) non va restituita al pool');
    assert.ok(!connessioni[0].rilasciata, 'la connessione avvelenata non va rilasciata');
  });

  // Il riconoscimento del timeout deve restare STRETTO: «Lock wait timeout
  // exceeded» è un errore del SERVER su una connessione sana, e trattarlo come
  // lo scadere del tetto significa distruggere quella connessione, mandare un
  // KILL inutile e — la parte che l'utente vede — spiegare un'attesa su lock
  // come «hai superato CODEDB_AGGREGATE_TIMEOUT_MS»: due diagnosi opposte.
  await prova('MySQL: un lock wait timeout NON viene scambiato per il tetto', async () => {
    const err = new Error('Lock wait timeout exceeded; try restarting transaction');
    err.code = 'ER_LOCK_WAIT_TIMEOUT';
    const { pool, connessioni } = poolMySql({ erroreSu: SQL_SCRITTURA, errore: err });
    const s = new MySqlStrategy();
    s.pool = pool;
    await assert.rejects(
      () => s.collectionAggregate('negozio', null, { pipeline: SQL_SCRITTURA }),
      (e) => e.code === 'ER_LOCK_WAIT_TIMEOUT',
      "l'errore del server deve risalire intatto"
    );
    const kill = connessioni.some((c) => c.chiamate.some((x) => /^KILL QUERY/.test(x.sql)));
    assert.ok(!kill, 'nessun KILL: la query è già finita da sola');
    assert.ok(!connessioni[0].distrutta, 'la connessione è sana e va restituita al pool');
    assert.ok(connessioni[0].rilasciata, 'la connessione va rilasciata');
    assert.match(spiegaErrore(err), /lock/i);
  });

  /* --- PostgreSQL -------------------------------------------------------- */

  async function pgSql(payload, sqlUtente) {
    const { pool, clients } = poolPg();
    const s = new PostgreSqlStrategy();
    s.pool = pool;
    await s.collectionAggregate('negozio', null, { pipeline: sqlUtente, ...payload });
    return clients[0].chiamate.map((c) => c.sql);
  }

  function tettoPg(sqls, sqlUtente) {
    const iUtente = sqls.indexOf(sqlUtente);
    assert.ok(iUtente >= 0, `la query dell'utente non è stata eseguita: ${JSON.stringify(sqls)}`);
    const set = sqls.slice(0, iUtente).find((s) => /statement_timeout/i.test(s));
    return set ? Number(String(set).match(/statement_timeout\s*=\s*(\d+)/)[1]) : null;
  }

  await prova('PostgreSQL: la SCRITTURA riceve statement_timeout prima della query', async () => {
    const sqls = await pgSql({}, SQL_SCRITTURA);
    assert.strictEqual(tettoPg(sqls, SQL_SCRITTURA), DbStrategy.aggregateTimeoutMs(),
      `nessun statement_timeout sul ramo di scrittura: ${JSON.stringify(sqls)}`);
  });

  await prova('PostgreSQL: la SCRITTURA riazzera il tetto prima di restituire il client al pool', async () => {
    const sqls = await pgSql({}, SQL_SCRITTURA);
    assert.ok(sqls.some((s) => /RESET\s+statement_timeout/i.test(s)),
      `un SET fuori transazione resta sulla connessione: va riazzerato (${JSON.stringify(sqls)})`);
  });

  await prova('PostgreSQL: la LETTURA usa la stessa fonte configurabile', async () => {
    const sqls = await pgSql({ readOnly: true }, SQL_LETTURA);
    assert.strictEqual(tettoPg(sqls, SQL_LETTURA), DbStrategy.aggregateTimeoutMs());
  });

  await prova('PostgreSQL: cambiare la configurazione cambia il tetto su entrambi i rami', () =>
    conEnv(7321, async () => {
      assert.strictEqual(tettoPg(await pgSql({}, SQL_SCRITTURA), SQL_SCRITTURA), 7321);
      assert.strictEqual(tettoPg(await pgSql({ readOnly: true }, SQL_LETTURA), SQL_LETTURA), 7321);
    }));

  await prova('PostgreSQL: un tetto <= 0 disattiva il limite', () =>
    conEnv(0, async () => {
      const sqls = await pgSql({}, SQL_SCRITTURA);
      assert.ok(!sqls.some((s) => /statement_timeout/i.test(s)),
        `con tetto 0 non va impostato alcun statement_timeout: ${JSON.stringify(sqls)}`);
    }));

  /* --- MongoDB: invariato ------------------------------------------------ */

  // Client finto: registra le opzioni passate ad `aggregate`. Il tetto su Mongo
  // è `maxTimeMS` ed è ESCLUSO di proposito dalle pipeline che materializzano
  // ($out/$merge): interromperle a metà lascerebbe la destinazione incoerente.
  function clientMongo() {
    const viste = [];
    const cursore = {
      limit() { return cursore; },
      async next() { return null; },
      async close() {},
      async toArray() { return []; },
      async hasNext() { return false; },
      [Symbol.asyncIterator]() { return { next: async () => ({ done: true, value: undefined }) }; },
    };
    const client = {
      db() {
        return {
          collection() {
            return {
              aggregate(pipeline, opts) { viste.push({ pipeline, opts }); return cursore; },
            };
          },
        };
      },
    };
    return { client, viste };
  }

  await prova('MongoDB: la lettura conserva maxTimeMS dalla stessa fonte', async () => {
    const { client, viste } = clientMongo();
    const s = new MongoDbStrategy();
    s.client = client;
    await s.collectionAggregate('negozio', 'ordini', { pipeline: '[{"$match":{}}]' });
    assert.strictEqual(viste[0].opts.maxTimeMS, DbStrategy.aggregateTimeoutMs());
  });

  await prova('MongoDB: $out resta senza maxTimeMS (invariato)', async () => {
    const { client, viste } = clientMongo();
    const s = new MongoDbStrategy();
    s.client = client;
    await s.collectionAggregate('negozio', 'ordini', { pipeline: '[{"$out":"copia"}]' });
    assert.strictEqual(viste[0].opts.maxTimeMS, undefined);
  });

  if (falliti) console.error(`\n${falliti} test del tetto di tempo falliti.`);
})();
