'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const DbStrategy = require('../db/DbStrategy');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const McpGateway = require('../mcp/McpGateway');
const Restore = require('../backup/lib/restore');

const MUTANT_CONTRATTO = process.argv.includes('--mutant-contratto');

const METODI_MONGO_SQL = [
  'mongoSqlRead',
  'mongoSqlReturning',
  'mongoSqlSchema',
  'mongoSqlProcedure',
  'mongoSqlTrigger',
];

const METODI_COMUNI_STRATEGIA = [
  'connect',
  'disconnect',
  'health',
  'listDatabases',
  'search',
  'createDatabase',
  'renameDatabase',
  'dropDatabase',
  'listCollections',
  'createCollection',
  'renameCollection',
  'dropCollection',
  'addColumn',
  'alterColumn',
  'dropColumn',
  'createIndex',
  'dropIndex',
  'collectionStats',
  'dbSchema',
  'columnRelations',
  'duplicatePlan',
  'collectionFind',
  'collectionAggregate',
  'collectionExplain',
  'docInsert',
  'docUpdate',
  'docReplace',
  'docDelete',
  'collectionDeleteMany',
  'collectionUpdateMany',
  'collectionExport',
  'collectionImport',
  'listSessions',
  'killSession',
  'cancelQuery',
];

const EXPORT_MCP_FUNZIONI = [
  'attachMcp',
  'assertReadOnlySql',
  'assertWriteSql',
  'assertDdlSql',
  'assertReadOnlyPipeline',
  'refreshSessionPrincipal',
  'refreshWritesAllowed',
  'credentialFingerprint',
  'sameMcpIdentity',
  'backupVerificationPayload',
  'resolveBackupSelection',
  'hasTopLevelSqlKeyword',
];

const EXPORT_RESTORE_ATTESI = [
  'runRestore',
  'resolveChain',
  'preflightChain',
  'restoreSchemaObjects',
  'riqualificaDdl',
  'senzaDefiner',
  'checkApplied',
  'assertSafeSchemaSql',
  'splitStatements',
  'eliminaSePresente',
  'cardinalitaDestinazione',
];

module.exports = (async () => {
  if (MUTANT_CONTRATTO) {
    DbStrategy.prototype.mongoSqlRead = async () => {
      throw new Error('Mutante deliberato sul contratto neutro');
    };
  }

  async function prova(nome, fn) {
    await fn();
    console.log('  OK   Architettura modulare: ' + nome);
  }

  await prova('DbStrategy e gli adattatori SQL restano privi di metodi specifici MongoDB', () => {
    const base = new DbStrategy();
    const mysql = new MySqlStrategy();
    const pg = new PostgreSqlStrategy();
    const mongo = new MongoDbStrategy();

    for (const metodo of METODI_MONGO_SQL) {
      assert.strictEqual(
        metodo in base,
        false,
        `DbStrategy non deve dichiarare il metodo specifico MongoDB "${metodo}"`
      );
      assert.strictEqual(
        metodo in mysql,
        false,
        `MySqlStrategy non deve ereditare il metodo specifico MongoDB "${metodo}"`
      );
      assert.strictEqual(
        metodo in pg,
        false,
        `PostgreSqlStrategy non deve ereditare il metodo specifico MongoDB "${metodo}"`
      );
      assert.strictEqual(
        typeof mongo[metodo],
        'function',
        `MongoDbStrategy deve esporre "${metodo}"`
      );
    }
  });

  await prova('sottosistemi installati sui prototipi senza inquinare for...in e preservando gli statici', () => {
    const istanze = [
      ['mysql', new MySqlStrategy(), MySqlStrategy, ['tableDdl', 'tableAuxDdl', 'executeWriteBatch', 'columnAlterSql', 'columnDefinition', 'attesePerLock', 'threadIdsDelPool']],
      ['postgresql', new PostgreSqlStrategy(), PostgreSqlStrategy, ['tableDdl', 'tableAuxDdl', 'executeWriteBatch', 'primaryKeyName', 'conSearchPath', 'indexList', 'processIDsDelPool']],
      ['mongodb', new MongoDbStrategy(), MongoDbStrategy, ['shellWrite', 'indexList', 'watch', 'unwatch', 'watchSchema', 'unwatchSchema']],
    ];

    for (const [etichetta, istanza, Classe, extra] of istanze) {
      for (const chiave in istanza) {
        assert.strictEqual(
          Object.prototype.hasOwnProperty.call(istanza, chiave),
          true,
          `${etichetta}: la proprietà ereditata dal prototipo "${chiave}" non deve essere enumerabile su for...in`
        );
      }
      for (const metodo of [...METODI_COMUNI_STRATEGIA, ...extra]) {
        assert.strictEqual(
          typeof istanza[metodo],
          'function',
          `${etichetta}: metodo "${metodo}" mancante sul prototipo`
        );
        const descr = Object.getOwnPropertyDescriptor(Classe.prototype, metodo)
          || Object.getOwnPropertyDescriptor(DbStrategy.prototype, metodo);
        assert(descr, `${etichetta}: descrittore mancante per "${metodo}"`);
        assert.strictEqual(descr.enumerable, false, `${etichetta}: "${metodo}" deve essere non enumerabile`);
        assert.strictEqual(descr.writable, true, `${etichetta}: "${metodo}" deve restare sostituibile nei test`);
        assert.strictEqual(descr.configurable, true, `${etichetta}: "${metodo}" deve restare configurabile`);
      }
    }

    assert.strictEqual(typeof MySqlStrategy.columnSql, 'function');
    assert.strictEqual(typeof MySqlStrategy.defaultSql, 'function');
    assert.strictEqual(typeof MySqlStrategy.columnAlterSql, 'function');
    assert.strictEqual(typeof MySqlStrategy.scegliCollazione, 'function');
    assert.strictEqual(typeof MySqlStrategy.geoBinding, 'function');
    assert.strictEqual(typeof MySqlStrategy.csvCell, 'function');
    assert.strictEqual(typeof PostgreSqlStrategy.columnSql, 'function');
    assert.strictEqual(typeof PostgreSqlStrategy.defaultSql, 'function');
    assert.strictEqual(typeof PostgreSqlStrategy.geoBinding, 'function');
    assert.strictEqual(typeof PostgreSqlStrategy.csvCell, 'function');
    assert.strictEqual(typeof MongoDbStrategy.serialize, 'function');
  });

  await prova('sqlCatalogoComune produce indici coerenti con quotatura specifica per MySQL e PostgreSQL', async () => {
    const queryMysql = [];
    const mysql = new MySqlStrategy();
    mysql.pool = { query: async (sql) => { queryMysql.push(sql); return [[]]; } };

    const queryPg = [];
    const pg = new PostgreSqlStrategy();
    pg.pool = { query: async (sql) => { queryPg.push(sql); return { rows: [] }; } };

    const esitoMysql = await mysql.createIndex('negozio', 'ordini', {
      fields: '{"cliente_id": 1, "creato_il": -1}',
      unique: true,
    });
    const esitoPg = await pg.createIndex('public', 'Ordini', {
      fields: '{"cliente_id": 1, "creato_il": -1}',
      unique: true,
    });

    assert.strictEqual(esitoMysql.name, 'cliente_id_creato_il_idx');
    assert.strictEqual(esitoPg.name, 'cliente_id_creato_il_idx');
    assert.strictEqual(
      queryMysql[0],
      'CREATE UNIQUE INDEX `cliente_id_creato_il_idx` ON `negozio`.`ordini` (`cliente_id` ASC, `creato_il` DESC)'
    );
    assert.strictEqual(
      queryPg[0],
      'CREATE UNIQUE INDEX "cliente_id_creato_il_idx" ON "public"."Ordini" ("cliente_id" ASC, "creato_il" DESC)'
    );
  });

  await prova('facciate pubbliche McpGateway e restore preservate integralmente e orchestratori snelli', () => {
    assert.strictEqual(McpGateway.MCP_PATH, '/mcp');
    for (const nome of EXPORT_MCP_FUNZIONI) {
      assert.strictEqual(typeof McpGateway[nome], 'function', `McpGateway.${nome} deve essere esportato`);
    }
    for (const nome of EXPORT_RESTORE_ATTESI) {
      assert.strictEqual(typeof Restore[nome], 'function', `restore.${nome} deve essere esportato`);
    }

    const radice = path.resolve(__dirname, '..');
    const orchestratori = [
      ['mcp/McpGateway.js', 500],
      ['backup/lib/restore.js', 450],
      ['db/PostgreSqlStrategy.js', 1100],
      ['db/MySqlStrategy.js', 1150],
      ['db/MongoDbStrategy.js', 1000],
    ];
    for (const [rel, tettoRighe] of orchestratori) {
      const righe = fs.readFileSync(path.join(radice, rel), 'utf8').split(/\r?\n/).length;
      assert(
        righe <= tettoRighe,
        `${rel} supera il tetto di coesione (${righe} > ${tettoRighe} righe)`
      );
    }
  });
})();
