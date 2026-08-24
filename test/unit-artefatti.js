'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizzaExportDatabase, normalizzaLayerBackup } = require('../db/artefatti');
const { runRestore } = require('../backup/lib/restore');

function exportBase(dbType, collection) {
  return {
    formato: 'codedb-database', versione: 1, generatore: 'CodeDB test',
    creato: '2026-08-24T10:00:00.000Z', dbType, db: 'negozio',
    collections: [{ name: collection, ddl: null, indexes: null, postDdl: null, docs: [] }],
  };
}

// Seam pubblico: soltanto un export validato e normalizzato puo' essere
// consegnato all'applicazione. Non si osservano lexer o helper interni.
{
  const mysql = exportBase('mysql', 'ordini');
  mysql.collections[0].ddl = [
    'CREATE TABLE `ordini` (`id` bigint PRIMARY KEY)',
    'CREATE INDEX `idx_ordini_id` ON `ordini` (`id`)',
    'ALTER TABLE `ordini` ADD COLUMN `nota` text',
  ].join(';\n');
  mysql.collections[0].postDdl = [
    'ALTER TABLE `ordini` ADD CONSTRAINT `fk_cliente` FOREIGN KEY (`id`) REFERENCES `clienti` (`id`)',
  ];
  const normalizzato = normalizzaExportDatabase(JSON.stringify(mysql), { expectedDbType: 'mysql' });
  assert.strictEqual(normalizzato.collections[0].name, 'ordini');
  assert.strictEqual(normalizzato.fiducia.integrita.verificata, false);
  assert.strictEqual(normalizzato.fiducia.autenticita.verificata, false);

  const postgres = exportBase('postgresql', 'Ordini');
  postgres.db = 'vendite';
  postgres.collections[0].ddl = 'CREATE TABLE "Ordini" ("id" bigint PRIMARY KEY)';
  postgres.collections[0].postDdl = [
    'CREATE UNIQUE INDEX "Ordini_id_idx" ON "Ordini" ("id")',
    'ALTER TABLE "Ordini" ADD CONSTRAINT "Ordini_id_fk" FOREIGN KEY ("id") REFERENCES "Clienti" ("id")',
  ];
  assert.strictEqual(normalizzaExportDatabase(postgres, { expectedDbType: 'postgres' }).dbType, 'postgresql');

  const mongo = exportBase('mongodb', 'ordini');
  mongo.collections[0].indexes = [{ name: 'cliente_1', key: { cliente: 1 }, unique: false }];
  assert.deepStrictEqual(
    normalizzaExportDatabase(mongo, { expectedDbType: 'mongodb' }).collections[0].indexes[0].key,
    { cliente: 1 },
  );
}

for (const [label, ddl, pattern] of [
  ['ALTER su altra tabella anche se il nome atteso compare',
    "CREATE TABLE ordini (id int); ALTER TABLE clienti ADD COLUMN nota text DEFAULT 'ordini'", /clienti|altra tabella/i],
  ['DROP', 'CREATE TABLE ordini (id int); DROP TABLE clienti', /DROP|non ammessa/i],
  ['TRUNCATE', 'TRUNCATE TABLE ordini', /TRUNCATE|non ammessa/i],
  ['ALTER distruttiva', 'ALTER TABLE ordini DROP COLUMN nota', /additive|ADD/i],
  ['ALTER che rinomina', 'ALTER TABLE ordini RENAME TO ordini_vecchi', /additive|ADD/i],
  ['CREATE cross-database', 'CREATE TABLE amministrazione.ordini (id int)', /amministrazione|database/i],
  ['indice su altra tabella', 'CREATE INDEX ordini_idx ON clienti (id)', /clienti|altra tabella/i],
]) {
  const artefatto = exportBase('mysql', 'ordini');
  artefatto.collections[0].ddl = ddl;
  assert.throws(() => normalizzaExportDatabase(artefatto, { expectedDbType: 'mysql' }), pattern, label);
}

// Il layer intero viene validato in una volta: una DDL ostile nella seconda
// tabella impedisce di ottenere qualunque artefatto applicabile.
{
  assert.throws(() => normalizzaLayerBackup({
    dbType: 'mysql', database: 'negozio',
    schemas: [
      { collection: 'ordini', sql: 'CREATE TABLE ordini (id int)' },
      { collection: 'clienti', sql: 'ALTER TABLE ordini ADD COLUMN intruso int' },
    ],
    objects: null,
    integrity: { verifiedCount: 2, unverifiableCount: 0 },
  }), /ordini|altra tabella/i);

  const pg = normalizzaLayerBackup({
    dbType: 'postgresql', database: 'vendite',
    schemas: [{ collection: 'Ordini', sql: 'CREATE TABLE "vendite"."Ordini" ("id" bigint)' }],
    objects: {
      views: [{ name: 'OrdiniRecenti', ddl: 'CREATE VIEW "OrdiniRecenti" AS SELECT * FROM "Ordini"' }],
      routines: [{ name: 'totale', ddl: 'CREATE OR REPLACE FUNCTION "totale"() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$' }],
      triggers: [{ name: 'aggiorna', table: 'Ordini', ddl: 'CREATE TRIGGER "aggiorna" BEFORE UPDATE ON "Ordini" FOR EACH ROW EXECUTE FUNCTION "totale"()' }],
      sequences: [{ name: 'progressivo', ddl: 'CREATE SEQUENCE IF NOT EXISTS "progressivo" START WITH 1' }],
      sequenceValues: [{ name: 'progressivo', sql: "SELECT pg_catalog.setval('progressivo', 5, true)" }],
      foreignKeys: ['ALTER TABLE "Ordini" ADD CONSTRAINT "fk" FOREIGN KEY ("id") REFERENCES "Clienti" ("id")'],
    },
    integrity: { verifiedCount: 3, unverifiableCount: 0 },
  });
  assert.strictEqual(pg.fiducia.integrita.verificata, true);
  assert.strictEqual(pg.fiducia.autenticita.verificata, false);

  assert.throws(() => normalizzaLayerBackup({
    dbType: 'postgresql', database: 'vendite', schemas: [],
    objects: { views: [{ name: 'riepilogo', ddl: 'CREATE VIEW "amministrazione"."riepilogo" AS SELECT 1' }] },
    integrity: { verifiedCount: 1, unverifiableCount: 0 },
  }), /amministrazione|database/i, 'oggetto di schema cross-database rifiutato');
}

console.log('  OK   Confine di fiducia unico per export e backup passed');

// Seam restore reale: il secondo schema e' ostile, ma il primo e' valido. Se
// la catena fosse controllata durante l'applicazione, la strategia registrante
// vedrebbe gia' una mutazione. Il contratto pretende zero chiamate.
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-artefatti-'));
  const id = '20260824-100000_full';
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const files = [];
  const add = (rel, content, meta) => {
    const full = path.join(dir, rel);
    fs.writeFileSync(full, content, 'utf8');
    const bytes = fs.statSync(full).size;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    files.push({ path: rel.replace(/\\/g, '/'), bytes, sha256, ...meta });
  };
  add('schema/ordini.sql', 'CREATE TABLE ordini (id int);', { kind: 'schema', collection: 'ordini' });
  add('data/ordini.ndjson', '', { kind: 'data', collection: 'ordini', count: 0, mode: 'full' });
  add('schema/clienti.sql', 'ALTER TABLE ordini ADD COLUMN intruso int;', { kind: 'schema', collection: 'clienti' });
  add('data/clienti.ndjson', '', { kind: 'data', collection: 'clienti', count: 0, mode: 'full' });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    tool: 'codedb-backup', version: 1, id, type: 'full', baseId: null,
    connection: 'test', db: 'negozio', dbType: 'mysql',
    startedAt: '2026-08-24T10:00:00.000Z', endedAt: '2026-08-24T10:00:01.000Z', files,
  }), 'utf8');

  let mutations = 0;
  const strategy = new Proxy({ type: 'mysql' }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => { mutations++; throw new Error(`mutazione inattesa: ${String(prop)}`); };
    },
  });
  try {
    await assert.rejects(
      runRestore({
        session: { strategy, dbType: 'mysql' }, backupDir: dir, targetDb: 'destinazione',
        onlyCollections: null, drop: true, log: { info() {}, error() {} },
      }),
      /ordini|altra tabella/i,
    );
    assert.strictEqual(mutations, 0, 'la DDL ostile deve essere rifiutata prima di ogni mutazione');
    console.log('  OK   Restore rifiuta l’intera catena ostile prima di ogni mutazione passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('  FAIL Confine preflight del restore:', err);
  process.exitCode = 1;
});
