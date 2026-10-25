'use strict';

// LAB007: la verifica usa il catalogo simulato, il parser e l'adapter veri.
// Solo l'applicazione dei dati è sostituita: tutte le tabelle sono vuote e
// queste prove isolano le rappresentazioni equivalenti dello stesso schema.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const MySqlStrategy = require('../db/MySqlStrategy');
const { splitMySqlForeignKeys } = require('../backup/lib/engine');
const mysqlDdl = require('../db/mysql-ddl');
const auxOriginale = MySqlStrategy.prototype.tableAuxDdl;
const canonicalOriginale = mysqlDdl.canonicalMySqlTableDdl;
if (process.argv.includes('--mutant-fk')) MySqlStrategy.prototype.tableAuxDdl = async () => ({ indexes: [], foreignKeys: [] });
if (process.argv.includes('--mutant-azioni')) MySqlStrategy.prototype.tableAuxDdl = async function (...args) {
  const result = await auxOriginale.apply(this, args);
  return { ...result, foreignKeys: result.foreignKeys.map(sql => sql.replace('ON DELETE CASCADE', 'ON DELETE RESTRICT')) };
};
if (process.argv.includes('--mutant-charset')) {
  assert.equal(typeof canonicalOriginale, 'function', 'Il mutante richiede la canonicalizzazione MySQL implementata');
  mysqlDdl.canonicalMySqlTableDdl = (sql, ...args) => canonicalOriginale(String(sql)
    .replace(/\bCHARACTER\s+SET\s+\w+/gi, '').replace(/\bCOLLATE\s*(?:=\s*)?\w+/gi, ''), ...args);
}
const log = { info() {}, warn() {}, error() {} };
const q = value => '`' + value.replaceAll('`', '``') + '`';
const ddlPadre = `CREATE TABLE \`padri\` (
  \`id\` int NOT NULL,
  \`codice\` int NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`codice\` (\`codice\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
const ddlFiglia = `CREATE TABLE \`figli\` (
  \`id\` int NOT NULL,
  \`padre_id\` int DEFAULT NULL,
  \`codice_padre\` int DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`padre_id\` (\`padre_id\`),
  KEY \`codice_padre\` (\`codice_padre\`),
  CONSTRAINT \`fk_padre\` FOREIGN KEY (\`padre_id\`) REFERENCES \`padri\` (\`id\`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT \`fk_codice\` FOREIGN KEY (\`codice_padre\`) REFERENCES \`padri\` (\`codice\`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
const ddlTesto = (column = 'COLLATE utf8mb4_bin', literal = 'CHARACTER SET utf8mb4 COLLATE utf8mb4_bin', table = 'utf8mb4_0900_ai_ci') => `CREATE TABLE \`testi\` (
  \`id\` int NOT NULL,
  \`nome\` varchar(80) ${column} DEFAULT NULL,
  \`nota\` varchar(120) DEFAULT '${literal.replaceAll("'", "''")}',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${table}`;

function strategiaCatalogo(tables, { fkCount = null, erroreCatalogo = false, auxReali = false } = {}) {
  const strategy = new MySqlStrategy(), calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/^SHOW CREATE TABLE /.test(sql)) {
      const name = [...tables.keys()].find(table => sql.endsWith('.' + q(table)));
      assert(name, `SHOW CREATE di tabella inattesa: ${sql}`);
      return [[{ 'Create Table': tables.get(name) }]];
    }
    if (sql.includes('TABLE_CONSTRAINTS') && sql.includes('FOREIGN KEY')) {
      if (erroreCatalogo) throw Object.assign(new Error('Accesso al catalogo FK negato'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
      const name = params[1];
      assert(tables.has(name), `Inventario FK di tabella inattesa: ${name}`);
      return [[{ n: fkCount ?? splitMySqlForeignKeys(tables.get(name), name).foreignKeys.length }]];
    }
    if (/SELECT COUNT\(\*\) AS cardinality/.test(sql)) return [[{ cardinality: 0, distinctIdentities: null }]];
    if (/information_schema\.(TABLES|ROUTINES|TRIGGERS|EVENTS)/.test(sql)) return [[]];
    throw new Error(`Query catalogo non prevista dalla fixture: ${sql}`);
  };
  strategy.pool = { query, async getConnection() { return { query, release() {} }; } };
  strategy.listCollections = async () => [...tables.keys()].map(name => ({ name, type: 'table' }));
  if (!auxReali) strategy.tableAuxDdl = async (_db, name) => ({ indexes: [],
    foreignKeys: splitMySqlForeignKeys(tables.get(name), name).foreignKeys });
  return { strategy, calls };
}

function adapterIsolato() {
  const filename = require.resolve('../db/backupRestoreAdapter');
  const isolated = new Module(filename, module);
  isolated.filename = filename; isolated.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = isolated.require.bind(isolated);
  isolated.require = name => name === '../backup/lib/restore'
    ? { ...originalRequire(name), runRestore: async ({ targetDb }) => ({ targetDb, totalDocs: 0, expectedDocs: 0, collections: [] }) }
    : originalRequire(name);
  isolated._compile(fs.readFileSync(filename, 'utf8'), filename);
  return isolated.exports;
}

function creaBackup(root, name, tables, objects = {}) {
  const dir = path.join(root, name, '20261023-000000_full');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const add = (relative, content, metadata) => {
    const absolute = path.join(dir, relative); fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    const bytes = fs.readFileSync(absolute);
    files.push({ path: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...metadata });
  };
  for (const [name, ddl] of tables) {
    add(`schema/${name}.sql`, ddl + ';\n', { kind: 'schema', collection: name });
    add(`data/${name}.ndjson`, '', { kind: 'data', collection: name, mode: 'full', count: 0 });
  }
  add('objects/schema.json', JSON.stringify(objects), { kind: 'objects', collection: null, mode: 'snapshot' });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ tool: 'codedb-backup', version: 1,
    id: '20261023-000000_full', type: 'full', baseId: null, connection: 'unit-mysql-schema', db: 'src', dbType: 'mysql',
    startedAt: '2026-10-23T00:00:00.000Z', endedAt: '2026-10-23T00:00:01.000Z', files }));
  return dir;
}

async function verifica(root, name, expected, actual, objects = {}) {
  const backupDir = creaBackup(root, name, expected, objects);
  const api = adapterIsolato(), source = api.descriviBackup(backupDir);
  const plan = { kind: 'restore-backup', dbType: 'mysql', source, sourceDb: 'src', targetDb: 'dest',
    collections: source.collections, drop: true };
  const fake = strategiaCatalogo(actual);
  const adapter = api.createBackupRestoreAdapter({ strategy: fake.strategy, dbType: 'mysql', connName: 'unit-mysql-schema', log });
  await adapter.validatePlan(plan); await adapter.apply(plan, { db: 'dest' });
  return adapter.verify(plan, 'staging', { db: 'dest' });
}

const casi = [];
casi.push(['tableAuxDdl legge entrambe le FK dal catalogo e conserva le azioni', async () => {
  const fake = strategiaCatalogo(new Map([['figli', ddlFiglia]]), { auxReali: true });
  const actual = await fake.strategy.tableAuxDdl('src', 'figli');
  assert.equal(actual.foreignKeys.length, 2, '[MYSQL-SCHEMA-INVENTARIO] entrambe le FK devono essere lette dalla strategia');
  assert.deepEqual(actual.foreignKeys, splitMySqlForeignKeys(ddlFiglia, 'figli', 2).foreignKeys,
    '[MYSQL-SCHEMA-AZIONI] azioni e colonne delle FK devono restare intatte');
  assert(fake.calls.some(call => call.sql.includes('TABLE_CONSTRAINTS')), '[MYSQL-SCHEMA-INVENTARIO] controllare il numero di FK sul catalogo');
  assert(actual.foreignKeys.some(sql => sql.includes('ON DELETE CASCADE ON UPDATE RESTRICT')));
  assert(actual.foreignKeys.some(sql => sql.includes('ON DELETE SET NULL ON UPDATE CASCADE')));
}]);
casi.push(['FK non leggibili o conteggio discordante non diventano un inventario vuoto', async () => {
  for (const options of [{ fkCount: 3 }, { erroreCatalogo: true }]) {
    const fake = strategiaCatalogo(new Map([['figli', ddlFiglia]]), { auxReali: true, ...options });
    await assert.rejects(fake.strategy.tableAuxDdl('src', 'figli'), options.erroreCatalogo ? /negato/ : /catalogo|riconosciut|chiavi esterne/i,
      '[MYSQL-SCHEMA-INVENTARIO] un errore di lettura non può dichiarare lo schema verificato');
  }
}]);
casi.push(['FK inline, separate e duplicate dichiarate descrivono lo stesso schema', async root => {
  const separated = splitMySqlForeignKeys(ddlFiglia, 'figli', 2);
  const actual = new Map([['figli', ddlFiglia], ['padri', ddlPadre]]);
  for (const [name, ddl, objects] of [
    ['separate', separated.ddl, { foreignKeys: separated.foreignKeys }],
    ['inline', ddlFiglia, {}],
    ['entrambe', ddlFiglia, { foreignKeys: separated.foreignKeys }],
  ]) {
    const result = await verifica(root, `fk-${name}`, new Map([['figli', ddl], ['padri', ddlPadre]]), actual, objects);
    assert.equal(result.ok, true, `[MYSQL-SCHEMA-FK-EQUIVALENTI] ${name}: ${JSON.stringify(result.schemaDifferences)}`);
    assert.equal(result.snapshot.schema.indexes.__all.length, 2, '[MYSQL-SCHEMA-FK-EQUIVALENTI] le FK non devono essere contate due volte');
  }
}]);
casi.push(['una FK mancante o diversa non supera la verifica', async root => {
  const separated = splitMySqlForeignKeys(ddlFiglia, 'figli', 2);
  const expected = new Map([['figli', separated.ddl], ['padri', ddlPadre]]);
  const variants = [
    ['mancante', ddlFiglia.replace(/\n  CONSTRAINT `fk_codice`[^\n]+/, '').replace(/,\n\)/, '\n)')],
    ['on-delete', ddlFiglia.replace('ON DELETE CASCADE', 'ON DELETE RESTRICT')],
    ['on-update', ddlFiglia.replace('ON UPDATE RESTRICT', 'ON UPDATE CASCADE')],
    ['colonna-referenziata', ddlFiglia.replace('REFERENCES `padri` (`id`)', 'REFERENCES `padri` (`codice`)')],
  ];
  for (const [name, ddl] of variants) {
    const result = await verifica(root, `fk-negativo-${name}`, expected, new Map([['figli', ddl], ['padri', ddlPadre]]),
      { foreignKeys: separated.foreignKeys });
    assert.equal(result.ok, false, `[MYSQL-SCHEMA-FK-DIVERSE] ${name} deve rimanere una differenza reale`);
    assert(result.schemaDifferences.some(diff => diff.field === 'indexes:__all'), '[MYSQL-SCHEMA-FK-DIVERSE] differenza di vincoli esplicita');
  }
}]);
casi.push(['CHARACTER SET ridondante con COLLATE esplicito è equivalente', async root => {
  for (const [name, expected, actual] of [
    ['esplicito', ddlTesto(), ddlTesto('CHARACTER SET utf8mb4 COLLATE utf8mb4_bin')],
    ['implicito', ddlTesto('CHARACTER SET utf8mb4 COLLATE utf8mb4_bin'), ddlTesto()],
  ]) {
    const result = await verifica(root, `charset-${name}`, new Map([['testi', expected]]), new Map([['testi', actual]]));
    assert.equal(result.ok, true, `[MYSQL-SCHEMA-CHARSET-EQUIVALENTE] ${name}: ${JSON.stringify(result.schemaDifferences)}`);
  }
}]);
casi.push(['charset, collation e letterali realmente diversi restano distinti', async root => {
  const variants = [
    ['collation', ddlTesto(), ddlTesto('CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')],
    ['charset', ddlTesto(), ddlTesto('CHARACTER SET latin1 COLLATE latin1_bin')],
    ['charset-senza-collation', ddlTesto('', undefined, 'utf8mb4_bin'), ddlTesto('CHARACTER SET utf8mb4', undefined, 'utf8mb4_bin')],
    ['literal', ddlTesto(), ddlTesto(undefined, 'CHARACTER SET latin1 COLLATE latin1_bin')],
    ['identificatore', ddlTesto().replace('`nome`', '`CHARACTER SET utf8mb4`'), ddlTesto().replace('`nome`', '`CHARACTER SET latin1`')],
  ];
  for (const [name, expected, actual] of variants) {
    const result = await verifica(root, `charset-negativo-${name}`, new Map([['testi', expected]]), new Map([['testi', actual]]));
    assert.equal(result.ok, false, `[MYSQL-SCHEMA-CHARSET-DIVERSO] ${name} deve restare distinguibile`);
    assert(result.schemaDifferences.some(diff => diff.field === 'table:testi'), '[MYSQL-SCHEMA-CHARSET-DIVERSO] la differenza riguarda la DDL della tabella');
  }
}]);

module.exports = (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-unit-mysql-schema-'));
  const errors = [];
  try {
    for (const [name, run] of casi) {
      try { await run(root); console.log('  OK   Schema MySQL:', name); }
      catch (error) { errors.push(error); console.error('  FAIL Schema MySQL:', name, error.stack); }
    }
    if (errors.length) throw new AggregateError(errors, `${errors.length} gruppi Schema MySQL non superati`);
  } finally {
    MySqlStrategy.prototype.tableAuxDdl = auxOriginale;
    if (canonicalOriginale) mysqlDdl.canonicalMySqlTableDdl = canonicalOriginale;
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
if (require.main === module) module.exports.catch(error => { console.error(error.message); process.exitCode = 1; });
