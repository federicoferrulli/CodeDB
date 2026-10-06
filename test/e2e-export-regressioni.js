'use strict';

const assert = require('assert');
const { randomBytes } = require('crypto');
const MySql = require('../db/MySqlStrategy');
const Pg = require('../db/PostgreSqlStrategy');
const { leggiCatalogoExport } = require('../db/exportCatalogo');
const { creaPianoExport } = require('../db/exportPlan');
const { esportaDatabase } = require('../db/databaseExport');
const { splitStatementsDetailed } = require('../db/sqlText');

(async () => {
  assert(process.env.EXPORT_MYSQL_PORT && process.env.EXPORT_PG_PORT, 'Indicare le porte dei due DB usa-e-getta.');
  for (const mysql of [true, false]) {
    const st = mysql ? new MySql() : new Pg();
    await st.connect({ host: '127.0.0.1', port: Number(process.env[mysql ? 'EXPORT_MYSQL_PORT' : 'EXPORT_PG_PORT']),
      username: mysql ? 'root' : 'postgres', database: mysql ? '' : 'postgres' });
    const db = 'codedb_regressioni_' + randomBytes(6).toString('hex');
    const conn = mysql ? await st.pool.getConnection() : await st.pool.connect();
    const q = async (sql) => { const r = await conn.query(sql); return mysql ? r[0] : r.rows; };
    const dump = async (modalita, selezione) => {
      const plan = creaPianoExport({ catalogo: await leggiCatalogoExport(st, st.type, db), connection: 'test', formato: 'sql', modalita, selezione });
      let text = '';
      await esportaDatabase({ strategy: st, plan, write: s => { text += s; } });
      return text;
    };
    const restore = async (text) => {
      try { for (const stmt of splitStatementsDetailed(text, { backslashEscape: mysql })) await q(stmt.sql); }
      catch (err) { await q('ROLLBACK'); if (mysql) await q('SET foreign_key_checks=1'); throw err; }
    };
    const empty = async () => {
      if (mysql) {
        await q('SET foreign_key_checks=0');
        for (const table of ['a_child', 'z_parent', 'self_ref', 'temporal']) await q(`DELETE FROM ${table}`);
        await q('SET foreign_key_checks=1');
      } else await q('TRUNCATE a_child, z_parent, self_ref, temporal');
    };
    try {
      await q(`CREATE ${mysql ? 'DATABASE' : 'SCHEMA'} ${db}`);
      await q(mysql ? `USE ${db}` : `SET search_path TO ${db}, public`);
      await q('CREATE TABLE z_parent (id INT PRIMARY KEY, child_id INT, tenant INT, UNIQUE(id, tenant))');
      await q('CREATE TABLE a_child (id INT PRIMARY KEY, parent_id INT, tenant INT)');
      await q('CREATE TABLE self_ref (id INT PRIMARY KEY, parent_id INT)');
      await q('INSERT INTO z_parent VALUES (1,1,7)');
      await q('INSERT INTO a_child VALUES (1,1,7)');
      await q('INSERT INTO self_ref VALUES (1,2),(2,1),(3,NULL)');
      await q('ALTER TABLE z_parent ADD CONSTRAINT fk_child FOREIGN KEY(child_id) REFERENCES a_child(id)');
      await q(`ALTER TABLE a_child ADD CONSTRAINT fk_parent FOREIGN KEY(parent_id,tenant) REFERENCES z_parent(id,tenant)${mysql ? '' : ' DEFERRABLE INITIALLY DEFERRED'}`);
      await q('ALTER TABLE self_ref ADD CONSTRAINT fk_self FOREIGN KEY(parent_id) REFERENCES self_ref(id)');
      await q(`CREATE TABLE temporal (id ${mysql ? 'INT AUTO_INCREMENT' : 'INT GENERATED ALWAYS AS IDENTITY'} PRIMARY KEY, moment ${mysql ? 'TIMESTAMP(6)' : 'TIMESTAMPTZ(6)'})`);
      if (mysql) await q("SET sql_mode='NO_AUTO_VALUE_ON_ZERO', time_zone='+00:00'");
      await q(`INSERT INTO temporal(id,moment) ${mysql ? '' : 'OVERRIDING SYSTEM VALUE '}VALUES(0,'2026-10-01 12:34:56.123456${mysql ? '' : '+00'}')`);
      const select = `SELECT id, ${mysql ? 'UNIX_TIMESTAMP(moment)' : 'extract(epoch FROM moment)::text'} AS moment FROM temporal`;
      const expected = await q(select);
      const full = await dump('struttura-e-dati');
      await q(`DROP ${mysql ? 'DATABASE' : 'SCHEMA'} ${db}${mysql ? '' : ' CASCADE'}`);
      if (mysql) await q("SET sql_mode='NO_BACKSLASH_ESCAPES', time_zone='+02:00'");
      await restore(full);
      assert.deepStrictEqual(await q(select), expected, 'ID zero e istante esatto sopravvivono al ripristino');
      if (mysql) assert.deepStrictEqual(await q('SELECT @@sql_mode AS mode, @@time_zone AS zone'), [{ mode: 'NO_BACKSLASH_ESCAPES', zone: '+02:00' }], 'la sessione destinataria viene ripristinata');
      const data = await dump('solo-dati');
      const partial = await dump('personalizzata', { 'tabella:a_child': { struttura: false, dati: true } });
      const constraints = mysql ? null : await q(`SELECT conname, condeferrable, condeferred FROM pg_constraint WHERE connamespace='${db}'::regnamespace ORDER BY conname`);
      await empty();
      await restore(data);
      assert.deepStrictEqual(await q(select), expected);
      assert.strictEqual((await q('SELECT * FROM a_child')).length, 1);
      assert.strictEqual((await q('SELECT * FROM self_ref')).length, 3);
      if (!mysql) assert.deepStrictEqual(await q(`SELECT conname, condeferrable, condeferred FROM pg_constraint WHERE connamespace='${db}'::regnamespace ORDER BY conname`), constraints, 'la differibilità non viene modificata permanentemente');
      await empty();
      await assert.rejects(restore(partial), /foreign key|Duplicate entry/i, 'una selezione con orfani non viene confermata');
      assert.strictEqual((await q('SELECT * FROM a_child')).length, 0, 'il fallimento annulla il caricamento');
      console.log(`  OK ${st.type}: ID zero, timestamp, solo dati con cicli/FK composte/autorelazioni e rollback degli orfani`);
    } finally {
      await q('ROLLBACK');
      await q(`DROP ${mysql ? 'DATABASE' : 'SCHEMA'} IF EXISTS ${db}${mysql ? '' : ' CASCADE'}`);
      conn.release(); await st.disconnect();
    }
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
