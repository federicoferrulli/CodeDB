'use strict';

/* ---------------------------------------------------------------------------
 * Test di regressione per le criticità P0 dell'audit (Sprint 1):
 *  - [C-1] PostgreSQL countWithTimeout / collectionFind / collectionDeleteMany
 *          (BEGIN READ ONLY, queryMode: 'extended', blocco multi-statement)
 *          + MySQL READ ONLY e pool poisoning su timeout ([M-1])
 *  - [C-2] auth/sqlClause.js: bypass \' su PostgreSQL, $$, stringhe non chiuse
 *  - [C-3] collectionExplain: ANALYZE, /*! ... *\/, RBAC/scope e READ ONLY
 *  - [C-4] apikeys:create/revoke: isolamento tenantAdmin vs owner
 *  - [C-5] auth/sqlTables.js: CTE shadowing, FROM (SELECT) x, tab2, FROM (tab),
 *          UPDATE multi-tabella, INSERT senza INTO, DESCRIBE, nomi quotati
 *  - [C-6] keepPasswordFrom vietato ai sottoutenti e non combinabile con saved
 * ------------------------------------------------------------------------- */

const assert = require('node:assert/strict');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const MySqlStrategy = require('../db/MySqlStrategy');
const { assertScopedClauses } = require('../auth/sqlClause');
const { assertTabelleNelloScope } = require('../auth/sqlTables');
const { makePrincipal } = require('../auth/principal');
const { guardStrategy } = require('../auth/guardStrategy');
const { AppStore } = require('../auth/AppStore');

module.exports = (async () => {
  console.log('  --- Regressioni sicurezza P0 (Sprint 1) ---');

  /* --- [C-1] PostgreSQL READ ONLY + extended protocol + no multi-statement --- */
  {
    const pg = new PostgreSqlStrategy({ env: { CODEDB_QUERY_TIMEOUT_MS: '0', CODEDB_COUNT_TIMEOUT_MS: '5000' } });
    assert.throws(
      () => pg.buildSelect('public', 'ordini', { filter: '1=1; DROP TABLE utenti' }),
      /più istruzioni/i,
      'filter multi-statement deve essere rifiutato prima del driver',
    );
    assert.throws(
      () => pg.buildSelect('public', 'ordini', { sort: 'id ASC; DROP TABLE utenti' }),
      /più istruzioni/i,
      'sort multi-statement deve essere rifiutato prima del driver',
    );
    assert.doesNotThrow(
      () => pg.buildSelect('public', 'ordini', { filter: "nota = 'a;b'" }),
      'un punto e virgola dentro una stringa letterale resta valido',
    );

    const queries = [];
    const client = {
      async query(q) {
        queries.push(q);
        if (typeof q === 'object' && /COUNT\(\*\)/i.test(q.text)) return { rows: [{ total: '7' }] };
        return { rows: [], fields: [] };
      },
      release() {},
    };
    pg.pool = { connect: async () => client, query: async (q) => { queries.push(q); return { rowCount: 0, rows: [] }; } };

    const cnt = await pg.countWithTimeout('"public"."ordini"', ' WHERE 1=1', []);
    assert.equal(cnt.total, 7);
    assert.equal(queries[0], 'BEGIN READ ONLY', 'countWithTimeout deve aprire BEGIN READ ONLY');
    assert.equal(queries[2].queryMode, 'extended', 'countWithTimeout deve forzare queryMode: extended');
    assert.equal(queries[3], 'ROLLBACK', 'countWithTimeout deve chiudere con ROLLBACK e mai COMMIT');

    queries.length = 0;
    pg.primaryKey = async () => ['id'];
    pg.tableColumnsInfo = async () => ({ columns: [{ name: 'id', type: 'integer' }], geo: new Map(), geoNativo: new Map() });
    await pg.collectionFind('public', 'ordini', { deferCount: true });
    assert.equal(queries[0], 'BEGIN READ ONLY', 'collectionFind deve aprire BEGIN READ ONLY anche con timeout=0 e senza opHandle');
    assert.equal(queries[1].queryMode, 'extended', 'collectionFind deve forzare queryMode: extended');
    assert.equal(queries[2], 'ROLLBACK');

    queries.length = 0;
    await pg.collectionDeleteMany('public', 'ordini', { filter: 'id = 1' });
    assert.equal(queries[0].queryMode, 'extended', 'collectionDeleteMany deve forzare queryMode: extended');
    console.log('  OK   [C-1] PostgreSQL READ ONLY + extended protocol + blocco multi-statement');
  }

  /* --- [C-1 + M-1] MySQL READ ONLY + anti pool-poisoning su timeout --- */
  {
    const my = new MySqlStrategy({ env: { CODEDB_QUERY_TIMEOUT_MS: '500', CODEDB_COUNT_TIMEOUT_MS: '500' } });
    let killed = null;
    my.uccidiSulServer = async (tid) => { killed = tid; };
    let destroyed = false;
    let released = false;
    const seen = [];
    my.pool = {
      getConnection: async () => ({
        threadId: 4242,
        async query(q) {
          const text = typeof q === 'string' ? q : q.sql;
          seen.push(text);
          if (/SELECT COUNT/i.test(text)) {
            const err = new Error('Query inactivity timeout');
            err.code = 'PROTOCOL_SEQUENCE_TIMEOUT';
            throw err;
          }
          return [[], []];
        },
        destroy() { destroyed = true; },
        release() { released = true; },
      }),
    };
    const res = await my.countWithTimeout('`shop`.`ordini`', ' WHERE id > 0', []);
    assert.equal(res.timedOut, true);
    assert.equal(seen[0], 'START TRANSACTION READ ONLY', 'countWithTimeout MySQL usa READ ONLY con clausola WHERE');
    assert.equal(killed, 4242, 'su timeout MySQL invia KILL QUERY');
    assert.equal(destroyed, true, 'su timeout la connessione avvelenata viene distrutta');
    assert.equal(released, false, 'la connessione avvelenata non torna nel pool');
    console.log('  OK   [C-1/M-1] MySQL READ ONLY e distruzione connessione su timeout');
  }

  /* --- [C-2] auth/sqlClause.js su PostgreSQL e generico --- */
  {
    assert.throws(
      () => assertScopedClauses({ filter: "col = '\\' OR (SELECT COUNT(*) FROM utenti) > 0 --'" }, { dbms: 'postgresql' }),
      /non consentito/i,
      'backslash prima di apice su PostgreSQL non deve mascherare una subquery',
    );
    assert.throws(
      () => assertScopedClauses({ filter: "col = '\\'; DROP TABLE utenti; --'" }, { dbms: 'postgresql' }),
      /non consentito/i,
    );
    assert.throws(
      () => assertScopedClauses({ filter: "col = '\\' OR 1=1'" }),
      /non consentito/i,
      'senza dbms esplicito il backslash-apice viene rifiutato fail-closed',
    );
    assert.throws(
      () => assertScopedClauses({ filter: 'col = $$ciao$$' }, { dbms: 'postgresql' }),
      /dollar-quoted/i,
    );
    assert.throws(
      () => assertScopedClauses({ filter: "col = 'non chiusa" }, { dbms: 'postgresql' }),
      /non chiusa/i,
    );
    assert.doesNotThrow(
      () => assertScopedClauses({ filter: "stato = 'aperto' AND nome = 'O''Brien'" }, { dbms: 'postgresql' }),
      'le stringhe legittime con apici raddoppiati restano ammesse',
    );
    console.log('  OK   [C-2] sqlClause: bloccati bypass backslash PG, $$ e stringhe non chiuse');
  }

  /* --- [C-3] collectionExplain: ANALYZE, /*! *\/ e scope/RBAC --- */
  {
    const viewer = makePrincipal(
      { _id: 'u1', type: 'subuser', ownerId: 'o1' },
      [{ connName: 'prod', role: 'viewer', capabilities: ['read'], scope: null }],
    );
    const scoped = makePrincipal(
      { _id: 'u2', type: 'subuser', ownerId: 'o1' },
      [{ connName: 'prod', role: 'viewer', capabilities: ['read'], scope: { databases: ['shop'], collections: ['ordini'] } }],
    );
    const fakeMy = { type: 'mysql', async collectionExplain() { return { ok: true }; } };
    const gViewer = guardStrategy(fakeMy, { principal: viewer, connName: 'prod' });
    const gScoped = guardStrategy(fakeMy, { principal: scoped, connName: 'prod' });

    await assert.rejects(
      () => gViewer.collectionExplain('shop', 'ordini', { mode: 'aggregate', pipeline: 'DELETE FROM ordini' }),
      /Permesso negato/,
      'viewer non può eseguire EXPLAIN su DML distruttivo',
    );
    await assert.rejects(
      () => gViewer.collectionExplain('shop', 'ordini', { mode: 'aggregate', pipeline: 'SELECT /*!50000 1 */ FROM ordini' }),
      /commenti SQL eseguibili/,
      'commenti eseguibili vietati in EXPLAIN',
    );
    await assert.rejects(
      () => gScoped.collectionExplain('shop', 'ordini', { mode: 'aggregate', pipeline: 'SELECT * FROM ordini' }),
      /SQL Raw non consentito con un ambito limitato/,
      'utenti con scope limitato non possono inviare SQL Raw in collectionExplain',
    );

    const my = new MySqlStrategy();
    my.pool = { getConnection: async () => { throw new Error('non deve toccare il pool'); } };
    await assert.rejects(
      () => my.collectionExplain('shop', 'ordini', { mode: 'aggregate', pipeline: 'ANALYZE SELECT * FROM ordini' }),
      /EXPLAIN ANALYZE/,
      'MySqlStrategy.collectionExplain deve rifiutare ANALYZE prima di connettersi',
    );
    console.log('  OK   [C-3] collectionExplain: protetti ANALYZE, commenti eseguibili e scope RBAC');
  }

  /* --- [C-4] apikeys:create/revoke: tenantAdmin non tocca owner --- */
  {
    const users = new Map([
      ['owner-1', { _id: 'owner-1', ownerId: 'owner-1', type: 'owner', status: 'active' }],
      ['sub-1', { _id: 'sub-1', ownerId: 'owner-1', type: 'subuser', status: 'active' }],
    ]);
    const keys = new Map([
      ['k-owner', { _id: 'k-owner', ownerId: 'owner-1', subjectId: 'owner-1', revokedAt: null }],
      ['k-sub', { _id: 'k-sub', ownerId: 'owner-1', subjectId: 'sub-1', revokedAt: null }],
    ]);
    const store = new AppStore({ uri: 'mongodb://unused' });
    store.db = {
      collection(name) {
        if (name === 'users') {
          return { findOne: async (q) => { const u = users.get(q._id); return u && (!q.ownerId || u.ownerId === q.ownerId) ? u : null; } };
        }
        if (name === 'api_keys') {
          return {
            insertOne: async (doc) => { keys.set(doc._id, doc); },
            findOne: async (q) => { const k = keys.get(q._id); return k && k.ownerId === q.ownerId ? k : null; },
            updateOne: async (q, u) => { const k = keys.get(q._id); if (!k) return { matchedCount: 0 }; Object.assign(k, u.$set); return { matchedCount: 1 }; },
          };
        }
        throw new Error('collezione imprevista: ' + name);
      },
    };
    await assert.rejects(
      () => store.createApiKey({ ownerId: 'owner-1', subjectId: 'owner-1', label: 'escalate', onlySubUser: true }),
      /solo l’owner può creare API key per l’account owner/,
    );
    const okSub = await store.createApiKey({ ownerId: 'owner-1', subjectId: 'sub-1', label: 'ok', onlySubUser: true });
    assert.ok(okSub.key.startsWith('cdb_'));
    await assert.rejects(
      () => store.revokeApiKey('owner-1', 'k-owner', { onlySubUser: true }),
      /solo l’owner può revocare le proprie API key/,
    );
    await store.revokeApiKey('owner-1', 'k-sub', { onlySubUser: true });
    assert.ok(keys.get('k-sub').revokedAt instanceof Date);
    console.log('  OK   [C-4] apikeys:create/revoke isola owner da tenantAdmin delegato');
  }

  /* --- [C-5] auth/sqlTables.js: chiusura bypass scope --- */
  {
    const scope = { databases: ['shop'], collections: ['ordini'] };
    const no = (sql) => assert.throws(() => assertTabelleNelloScope(sql, scope, 'shop'), /Query non consentita/, `doveva rifiutare: ${sql}`);
    no('SELECT * FROM utenti WHERE EXISTS (WITH utenti AS (SELECT 1) SELECT 1)');
    no('SELECT * FROM (SELECT 1) x, utenti');
    no('SELECT * FROM (utenti)');
    no('UPDATE ordini, utenti SET utenti.ruolo = 1');
    no('INSERT utenti VALUES (1)');
    no('DESCRIBE utenti');
    no('SELECT * FROM "user-secrets"');
    no('SELECT * FROM `123_segreti`');
    no('SELECT * FROM ordini /*!50000 JOIN utenti ON 1=1 */');
    assert.doesNotThrow(() => assertTabelleNelloScope('WITH x AS (SELECT * FROM ordini) SELECT * FROM x', scope, 'shop'));
    assert.doesNotThrow(() => assertTabelleNelloScope('SELECT * FROM (SELECT * FROM ordini) a, ordini b', scope, 'shop'));
    console.log('  OK   [C-5] sqlTables: chiusi CTE shadowing, FROM parentesizzato/derivato, UPDATE multi, nomi quotati');
  }

  /* --- [C-6] keepPasswordFrom vietato ai sottoutenti e non combinabile con saved --- */
  {
    const { createModule: createIdentita } = require('../server/identita');
    const { createModule: createConnessioni } = require('../server/connessioni');
    const identita = createIdentita({
      config: { env: {}, rbacOn: () => true },
      trasporto: { app: { post() {}, get() {} }, io: { use() {}, sockets: { sockets: new Map() } }, checkOrigin: () => ({ ok: true }) },
      audit: {}, errori: { errMsg: (e) => String(e) }, dependencies: {},
    });
    const subuser = makePrincipal(
      { _id: 'u1', type: 'subuser', ownerId: 'o1' },
      [{ connName: 'pubblica', role: 'viewer', capabilities: ['read'], scope: null }],
    );
    assert.doesNotThrow(() => identita.assertConnAllowed(subuser, { saved: 'pubblica' }, 'pubblica'));
    assert.throws(
      () => identita.assertConnAllowed(subuser, { saved: 'pubblica', keepPasswordFrom: 'produzione' }, 'pubblica'),
      /owner del tenant/,
      'un sottoutente non può usare keepPasswordFrom',
    );

    const connMod = createConnessioni({
      vault: { loadConnections: () => ({ pubblica: { host: '127.0.0.1' }, produzione: { host: 'db', password: 'secret' } }), connDbType: () => 'mongodb', sshEnabled: () => false },
      dependencies: {}, errori: { errMsg: (e) => String(e) }, config: { env: {} },
    });
    await assert.rejects(
      () => connMod.establishConnection({ saved: 'pubblica', keepPasswordFrom: 'produzione' }),
      /Non è consentito combinare/,
    );
    console.log('  OK   [C-6] keepPasswordFrom bloccato per sottoutenti e non combinabile con saved');
  }
})();
