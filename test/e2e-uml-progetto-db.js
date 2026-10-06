'use strict';
const assert = require('assert');
const { prepara, applica } = require('../db/umlProgetto');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const { createE2eTargetRegistry } = require('./e2e-harness');
const { guardStrategy } = require('../auth/guardStrategy');

// Solo database/schema con nome casuale posseduto dalla fixture; mai i dati dell'utente.
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_uml' });
(async () => {
  for (const [type, Class, config] of [
    ['mysql', MySqlStrategy, { host: '127.0.0.1', port: process.env.MYSQL_PORT || 3306, username: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD || '' }],
    ['postgresql', PostgreSqlStrategy, { host: '127.0.0.1', port: process.env.PG_PORT || 5432, username: process.env.PG_USER || 'postgres', password: process.env.PG_PASSWORD || '', database: process.env.PG_DATABASE || 'postgres' }],
  ]) {
    const raw = new Class();
    const db = targets.target(type);
    targets.assertOwned(db);
    let created = false;
    try {
      await raw.connect(config);
      await raw.createDatabase(db); created = true;
      const principal = { grants: [{ connName: 'test', capabilities: ['read', 'ddl'], scope: { databases: [db], collections: ['clienti', 'ordini', 'ordini_nuovi'] } }] };
      const strategy = guardStrategy(raw, { principal, connName: 'test' });
      const run = async (operations) => {
        const plan = await prepara(strategy, db, operations, () => {});
        const res = await applica(strategy, plan, () => {});
        assert.strictEqual(res.status, 'completato', JSON.stringify(res));
        return plan;
      };
      const id = { name: 'id', type: 'integer', nullable: false, primaryKey: true };
      await run([
        { kind: 'createTable', table: 'clienti', columns: [id] },
        { kind: 'createTable', table: 'ordini', columns: [id, { name: 'cliente_id', type: 'integer', nullable: true }] },
        { kind: 'addForeignKey', table: 'ordini', name: 'fk_cliente', target: 'clienti', columns: ['cliente_id'], references: ['id'], onDelete: 'CASCADE' },
      ]);
      assert.strictEqual((await raw.columnRelations(db, 'ordini'))[0].nome, 'fk_cliente');
      if (type === 'mysql') {
        await raw.requirePool().query(`ALTER TABLE \`${db}\`.ordini ADD COLUMN speciale varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT (concat('a','b')) INVISIBLE COMMENT 'nota', ADD COLUMN posizione POINT NOT NULL SRID 4326`);
        const special = (await raw.tableFields(db, 'ordini')).find((f) => f.name === 'speciale');
        await run([{ kind: 'alterColumn', table: 'ordini', oldName: 'speciale', column: { name: 'speciale', type: 'varchar(60)', nullable: true, default: special.default } },
          { kind: 'alterColumn', table: 'ordini', oldName: 'posizione', column: { name: 'posizione', type: 'POINT', nullable: false } }]);
        const ddl = await raw.tableDdl(db, 'ordini');
        assert.match(ddl, /utf8mb4_bin/);
        assert.match(ddl, /concat/i);
        assert.match(ddl, /INVISIBLE/);
        assert.match(ddl, /SRID 4326/);
        assert.match(ddl, /COMMENT 'nota'/);
      }
      await run([{ kind: 'addColumn', table: 'ordini', column: { name: 'note', type: 'varchar(50)', nullable: true, default: '' } }]);
      await run([{ kind: 'alterColumn', table: 'ordini', oldName: 'note', column: { name: 'descrizione', type: 'varchar(100)', nullable: false, default: 'iniziale' } }]);
      let fields = await raw.tableFields(db, 'ordini');
      assert.ok(fields.some((f) => f.name === 'descrizione' && f.nullable === false));
      await run([{ kind: 'replaceForeignKey', table: 'ordini', oldName: 'fk_cliente', name: 'fk_cliente_nuova', target: 'clienti', columns: ['cliente_id'], references: ['id'], onDelete: 'SET NULL' }]);
      assert.strictEqual((await raw.columnRelations(db, 'ordini'))[0].nome, 'fk_cliente_nuova');
      if (type === 'postgresql') {
        await run([{ kind: 'replaceForeignKey', table: 'ordini', oldName: 'fk_cliente_nuova', name: 'fk_cliente_nuova', target: 'clienti', columns: ['cliente_id'], references: ['id'], onDelete: 'SET DEFAULT', onUpdate: 'SET DEFAULT' }]);
        const relation = (await raw.columnRelations(db, 'ordini'))[0];
        assert.strictEqual(relation.onDelete, 'SET DEFAULT');
        assert.strictEqual(relation.onUpdate, 'SET DEFAULT');
      }
      await run([{ kind: 'dropForeignKey', table: 'ordini', name: 'fk_cliente_nuova' }, { kind: 'dropColumn', table: 'ordini', name: 'descrizione' }]);
      await run([{ kind: 'replacePrimaryKey', table: 'ordini', columns: ['id', 'cliente_id'] }]);
      assert.deepStrictEqual(await raw.primaryKey(db, 'ordini'), ['id', 'cliente_id']);
      await run([{ kind: 'dropPrimaryKey', table: 'ordini' }]);
      await run([{ kind: 'addPrimaryKey', table: 'ordini', columns: ['id'] }]);
      await run([{ kind: 'renameTable', table: 'ordini', name: 'ordini_nuovi' }]);
      assert.ok((await raw.listCollections(db)).some((t) => t.name === 'ordini_nuovi'));
      await run([{ kind: 'dropTable', table: 'ordini_nuovi' }]);
      assert.ok(!(await raw.listCollections(db)).some((t) => t.name === 'ordini_nuovi'));
      await run([
        { kind: 'createTable', table: 'ordini', columns: [id] },
        { kind: 'alterColumn', table: 'ordini', oldName: 'id', column: { name: 'numero', type: 'bigint', nullable: false } },
        { kind: 'addColumn', table: 'ordini', column: { name: 'nota', type: 'varchar(20)', nullable: true } },
        { kind: 'alterColumn', table: 'ordini', oldName: 'nota', column: { name: 'testo', type: 'varchar(40)', nullable: false, default: 'prima' } },
        { kind: 'renameTable', table: 'ordini', name: 'ordini_nuovi' },
        { kind: 'alterColumn', table: 'ordini_nuovi', oldName: 'testo', column: { name: 'testo', type: 'varchar(80)', nullable: true, default: 'dopo' } },
        { kind: 'replacePrimaryKey', table: 'ordini_nuovi', columns: ['numero', 'testo'] },
        { kind: 'dropPrimaryKey', table: 'ordini_nuovi' },
        { kind: 'addPrimaryKey', table: 'ordini_nuovi', columns: ['numero'] },
        { kind: 'alterColumn', table: 'ordini_nuovi', oldName: 'numero', column: { name: 'numero', type: 'integer', nullable: false } },
      ]);
      fields = await raw.tableFields(db, 'ordini_nuovi');
      assert.match(fields.find(f => f.name === 'numero').types[0], /^(int|integer)$/i, 'tipo finale della sequenza CREATE/ALTER/RENAME/ALTER');
      assert.match(fields.find(f => f.name === 'testo').types[0], /(?:varchar|character varying)\(80\)/i);
      assert.deepStrictEqual(await raw.primaryKey(db, 'ordini_nuovi'), ['numero']);
      if (type === 'mysql') {
        await raw.requirePool().query(`ALTER TABLE \`${db}\`.clienti MODIFY id INT NOT NULL AUTO_INCREMENT`);
        const concurrent = await prepara(strategy, db, [{ kind: 'addColumn', table: 'clienti', column: { name: 'nota', type: 'text' } }], () => {});
        await raw.requirePool().query(`INSERT INTO \`${db}\`.clienti () VALUES ()`);
        assert.strictEqual((await applica(strategy, concurrent, () => {})).status, 'completato', 'AUTO_INCREMENT avanzato da un INSERT non è una modifica di schema');
      }
      console.log(`✓ ${type}: creazione, FK, colonne, PK, rinomina ed eliminazione contro DB reale con scope limitato`);
    } finally {
      if (created) await targets.drop(db, (name) => raw.dropDatabase(name));
      await raw.disconnect();
    }
  }
})().catch((err) => { console.error(err.message); process.exitCode = 1; });
