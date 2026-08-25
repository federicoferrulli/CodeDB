'use strict';

const assert = require('assert');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');

module.exports = (async () => {
  const mysql = new MySqlStrategy();
  const mysqlQuery = [];
  mysql.pool = {
    async query(sql, params) {
      mysqlQuery.push({ sql, params });
      return [{ affectedRows: 2 }];
    },
  };

  await assert.rejects(
    mysql.collectionImport('negozio', 'clienti', {
      docs: [{ id: 1, nome: 'Ada' }], upsert: true, conflictColumns: [],
    }),
    /identit[aà] stabile/i,
  );
  assert.strictEqual(mysqlQuery.length, 0, 'MySQL deve rifiutare il piano prima della prima query');

  const mysqlResult = await mysql.collectionImport('negozio', 'clienti', {
    docs: [
      { id: 1, nome: 'Ada' },
      { id: 2, nome: 'Lin', nota: 'VIP' },
    ],
    upsert: true,
    conflictColumns: ['id'],
  });
  assert.strictEqual(mysqlResult.inserted, 2, 'il conteggio applicato conta righe, non affectedRows MySQL');
  assert.strictEqual(mysqlQuery.length, 2, 'forme diverse conservano tutte le colonne in gruppi distinti');
  assert(mysqlQuery.every((q) => /ON DUPLICATE KEY UPDATE/i.test(q.sql)), 'ogni gruppo usa un vero upsert');
  assert(mysqlQuery.every((q) => !/\bREPLACE\b/i.test(q.sql)), 'l\'upsert non deve eseguire REPLACE');
  assert(mysqlQuery[1].sql.includes('`nota`'), 'la seconda forma conserva la colonna aggiuntiva');

  const pg = new PostgreSqlStrategy();
  const pgQuery = [];
  pg.pool = {
    async query(sql, params) {
      pgQuery.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };
  pg.tableColumnsInfo = async () => ({
    columns: [{ name: 'email' }, { name: 'nome' }], geo: new Map(), geoNativo: new Map(),
  });
  pg.primaryKey = async () => [];

  await assert.rejects(
    pg.collectionImport('public', 'utenti', {
      docs: [{ email: 'a@example.test', nome: 'Ada' }], upsert: true,
    }),
    /identit[aà] stabile/i,
  );
  assert.strictEqual(pgQuery.length, 0, 'PostgreSQL non ripiega su INSERT senza identità');

  await pg.collectionImport('public', 'utenti', {
    docs: [{ email: 'a@example.test', nome: 'Ada' }],
    upsert: true,
    conflictColumns: ['email'],
  });
  assert.match(pgQuery[0].sql, /ON CONFLICT \("email"\).*DO UPDATE/i);

  console.log('  OK   Upsert SQL identitario senza effetti delete passed');
})().catch((err) => {
  console.error('  FAIL Upsert SQL identitario:', err.stack || err);
  process.exitCode = 1;
});

