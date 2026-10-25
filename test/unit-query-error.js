'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// La mutazione usa il loader: nessun sorgente condiviso viene riscritto.
if (process.argv.includes('--mutant=posizione')) require('node:module').registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/query-error.js')) return result;
  const from = 'if (range) err.queryError = range;';
  assert(String(result.source).includes(from));
  return { ...result, source: String(result.source).replace(from, 'if (range) err.queryError = { start: 0, end: 1 };') };
} });
if (process.argv.includes('--mutant=virtual-join')) require('node:module').registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/VirtualJoinEngine.js')) return result;
  const from = 'delete err.queryError;';
  assert(String(result.source).includes(from));
  return { ...result, source: String(result.source).replace(from, '/* Mutante: propaga gli offset della query interna. */') };
} });

const { intervalloErroreQuery } = require('../db/queryError');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const MySqlStrategy = require('../db/MySqlStrategy');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');

const error = (message, fields = {}) => Object.assign(new Error(message), fields);
const interval = (text, token) => ({ start: text.indexOf(token), end: text.indexOf(token) + token.length });
const pgError = sql => error('relation "inesistente" does not exist', {
  code: '42P01', position: String([...sql.slice(0, sql.indexOf('inesistente'))].length + 1),
});

function postgres({ preambolo = false, rows = [], senzaPosizione = false } = {}) {
  const strategy = new PostgreSqlStrategy();
  strategy.pool = { async connect() { return {
    async query(query) {
      const sql = typeof query === 'string' ? query : query.text;
      if (preambolo && sql.startsWith('SET search_path')) throw error('Errore del SET interno', { position: '1' });
      if (sql.includes('inesistente')) {
        const err = pgError(sql);
        if (senzaPosizione) delete err.position;
        throw err;
      }
      return { rows, command: 'SELECT', fields: [] };
    }, release() {},
  }; }, async end() {} };
  return strategy;
}

function mysql({ rows = [] } = {}) {
  const strategy = new MySqlStrategy();
  strategy.pool = { async getConnection() { return {
    async query(query) {
      const sql = typeof query === 'string' ? query : query.sql;
      if (sql.includes('inesistente')) throw error("Table 'prova.inesistente' doesn't exist", { code: 'ER_NO_SUCH_TABLE', errno: 1146 });
      return [rows, []];
    }, release() {},
  }; }, async end() {} };
  return strategy;
}

module.exports = (async () => {
  const source = 'SELECT \'😀\', "inesistente" FROM utenti';
  assert.deepEqual(intervalloErroreQuery(pgError(source), source, 'postgresql'), interval(source, '"inesistente"'));
  assert.deepEqual(intervalloErroreQuery(error('fine query', { position: '7' }), 'SELECT', 'postgresql'), { start: 6, end: 6 });
  for (const position of ['0', '-1', '9999', 'NaN']) assert.equal(intervalloErroreQuery(error('errore', { position }), source, 'postgresql'), null);
  assert.equal(intervalloErroreQuery(error('procedura', { internalPosition: '1' }), source, 'postgresql'), null);
  const syntax = error("You have an error in your SQL syntax; near 'FRM utenti' at line 2", { code: 'ER_PARSE_ERROR' });
  const multiline = "SELECT 'FRM utenti'\nFRM utenti";
  assert.deepEqual(intervalloErroreQuery(syntax, multiline, 'mysql'), { start: multiline.lastIndexOf('FRM'), end: multiline.lastIndexOf('FRM') + 3 });
  const column = error("Unknown column 'assente' in 'field list'", { code: 'ER_BAD_FIELD_ERROR' });
  assert.deepEqual(intervalloErroreQuery(column, "SELECT 'assente', `assente` FROM utenti", 'mysql'), { start: 18, end: 27 });
  assert.equal(intervalloErroreQuery(column, 'SELECT assente, assente FROM utenti', 'mysql'), null, 'Un token ripetuto è ambiguo');
  assert.equal(intervalloErroreQuery(error('Connessione interrotta'), source, 'postgresql'), null);
  const nomeAssente = 'SELECT * FROM sndasjkdn;';
  const dettaglioPg = error('La tabella indicata non esiste. (dettaglio tecnico: relation "sndasjkdn" does not exist)');
  assert.deepEqual(intervalloErroreQuery(dettaglioPg, nomeAssente, 'postgresql'), interval(nomeAssente, 'sndasjkdn'));
  assert.deepEqual(intervalloErroreQuery(dettaglioPg, "SELECT 'sndasjkdn' FROM sndasjkdn -- sndasjkdn", 'postgresql'), { start: 24, end: 33 });
  assert.equal(intervalloErroreQuery(dettaglioPg, 'SELECT sndasjkdn FROM sndasjkdn', 'postgresql'), null, 'Un nome ambiguo non indica un token preciso');
  assert.deepEqual(intervalloErroreQuery(error('relation "prova" does not exist'), 'SELECT * FROM Prova', 'postgresql'), { start: 14, end: 19 });
  assert.equal(intervalloErroreQuery(error('relation "prova" does not exist'), 'SELECT * FROM "Prova"', 'postgresql'), null, 'Un nome quotato conserva le maiuscole');
  assert.deepEqual(intervalloErroreQuery(error("Errore. (dettaglio tecnico: Table 'prova.sndasjkdn' doesn't exist)"), nomeAssente, 'mysql'), interval(nomeAssente, 'sndasjkdn'));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-query-error-'));
  const server = require('../server/createServer').createServer({ config: { desktop: null, env: {
    CODEDB_RBAC: 'off', CODEDB_CONNECTIONS_FILE: path.join(root, 'connections.ini'),
    CODEDB_CONNECTIONS_DIR: path.join(root, 'conns'), CODEDB_BACKUPS_DIR: path.join(root, 'backups'),
    CODEDB_SCRIPT_RESULTS_DIR: path.join(root, 'results'),
    CODEDB_UI_AUDIT_FILE: path.join(root, 'ui.log'), CODEDB_MCP_AUDIT_FILE: path.join(root, 'mcp.log'),
  } } });
  const sessions = new Map([
    ['pg', sessioneFinta({ strategy: postgres(), dbType: 'postgresql' })],
    ['mysql', sessioneFinta({ strategy: mysql(), dbType: 'mysql' })],
    ['preambolo', sessioneFinta({ strategy: postgres({ preambolo: true }), dbType: 'postgresql' })],
    ['pg-senza-posizione', sessioneFinta({ strategy: postgres({ senzaPosizione: true }), dbType: 'postgresql' })],
    ['pg-join', sessioneFinta({ strategy: postgres({ rows: [{ id: 1 }] }), dbType: 'postgresql' })],
    ['mysql-join', sessioneFinta({ strategy: mysql({ rows: [{ id: 1 }] }), dbType: 'mysql' })],
    ['mongo', sessioneFinta({ strategy: { type: 'mongodb', async disconnect() {} } })],
  ]);
  const ctx = contestoFinto({ sessioni: [...sessions] });
  server.registraEventi(ctx);
  const execute = (tabId, code) => ctx.socket.chiama('query:execute', { tabId, code, db: 'prova', coll: 'utenti' });
  try {
    for (const tabId of ['pg', 'mysql', 'pg-senza-posizione']) {
      const code = "\n  -- commento 😀\nSELECT * FROM inesistente;";
      const result = await execute(tabId, code);
      assert.equal(result.ok, false);
      assert.deepEqual(result.queryError, interval(code, 'inesistente'), `${tabId}: posizione persa lungo query → strategia → ack`);
      assert(result.error.length > 0, 'Il messaggio italiano deve accompagnare la posizione');
    }
    assert.equal((await execute('preambolo', 'SELECT 1')).queryError, undefined, 'Il SET interno non deve sottolineare la query utente');
    for (const tabId of ['pg-join', 'mysql-join']) {
      for (const source of ['sourceA', 'sourceB']) {
        for (const supplied of [true, false]) {
          const valid = { tabId, db: 'prova', table: 'utenti' };
          const failing = supplied ? { ...valid, query: 'SELECT * FROM inesistente' } : { ...valid, table: 'inesistente' };
          const virtualJoin = { sourceA: { ...valid }, sourceB: { ...valid }, on: { leftKey: 'id', rightKey: 'id' } };
          virtualJoin[source] = failing;
          const code = JSON.stringify({ virtualJoin }, null, 2);
          // Sia il contesto SQL sia quello Mongo possono eseguire un Virtual JOIN.
          for (const active of [tabId, 'mongo']) {
            const result = await execute(active, code);
            assert.equal(result.ok, false);
            assert.match(result.error, /inesistente/);
            assert.equal(result.queryError, undefined, `${tabId}/${source}/${supplied}/${active}: offset SQL interno applicato al JSON esterno`);
          }
        }
      }
      const valid = { tabId, db: 'prova', table: 'utenti' };
      const result = await execute(tabId, JSON.stringify({ virtualJoin: {
        sourceA: valid, sourceB: valid, on: { leftKey: 'id', rightKey: 'id' },
      } }));
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.data, [{ id: 1, joined_data: { id: 1 } }]);
    }
    for (const [code, token] of [
      ['\n  // commento\ndb.utenti.find({ nome: Mario })', 'Mario'],
      ['\n  /* commento */ { eta: { $gte: } }', '}'],
      ['\n  // commento\n[{ $match: { nome: "non chiusa } }]', '"non chiusa } }]'],
      ['SELECT * FROM utenti ORDER BY eta FRM', 'FRM'],
    ]) {
      const result = await execute('mongo', code);
      assert.equal(result.ok, false);
      assert.deepEqual(result.queryError, interval(code, token), `Posizione Mongo errata: ${code}: ${result.error}`);
    }
    const eof = 'db.utenti.find({ eta:';
    assert.deepEqual((await execute('mongo', eof)).queryError, { start: eof.length, end: eof.length });
    const code = '\n  SELECT 1;\n\n SELECT * FROM inesistente;';
    const ack = await ctx.socket.chiama('script:execute', { tabId: 'pg', code, db: 'prova', runId: 'posizione-script' });
    assert.equal(ack.ok, true, ack.error);
    const run = sessions.get('pg').scripts.get('posizione-script');
    await run.completion;
    const failure = run.results.find(r => !r.ok);
    assert.deepEqual(failure.queryError, interval(code, 'inesistente'), 'Lo script espone offset nel codice completo, compresi spazi iniziali');
    const progress = ctx.socket.inviati.find(event => event.evento === 'script:progress' && event.args[0].result?.ok === false);
    assert.deepEqual(progress.args[0].result.queryError, failure.queryError);
    console.log('OK: posizioni query PostgreSQL/MySQL/MQL, Unicode, offset script e ack socket; errori interni e ambigui esclusi.');
  } finally {
    await server.stop();
    // Il target è esclusivamente la directory temporanea creata sopra.
    assert(path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('codedb-query-error-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
