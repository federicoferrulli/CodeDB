'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createE2eTargetRegistry } = require('../e2e-harness');
let transactionModule = require('../../db/pg-restore-transaction');
if (process.argv.includes('--mutant')) {
  const Module = require('node:module'), filename = require.resolve('../../db/pg-restore-transaction');
  const source = fs.readFileSync(filename, 'utf8');
  const changed = source.replace('await client.query(`ROLLBACK TO SAVEPOINT ${name}`);', '/* rollback del batch saltato intenzionalmente */');
  assert.notEqual(changed, source);
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(changed, filename); transactionModule = mod.exports;
}
const { apriTransazioneRipristino } = transactionModule;
const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/pg-restore-transaction');
fs.mkdirSync(dir, { recursive: true });
const files = ['db/pg-restore-transaction.js', 'test/lab/pg-restore-transaction.cjs'];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../..', file))).digest('hex')]));
const report = { suite: 'pg-restore-transaction', verifiche: [], sorgenti: hashes() };
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lab_tx_restore' });
const schema = registry.target('origine'), table = `"${schema}"."righe"`;
let pool, external, tx;
async function check(id, action) {
  try { await action(); report.verifiche.push({ id, ok: true }); console.log('OK ' + id); }
  catch (error) { report.verifiche.push({ id, ok: false, errore: error.stack }); console.error('FAIL ' + id + ': ' + error.message); }
}
(async () => {
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    const { Pool, Client } = require('pg');
    const config = { host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), user: 'postgres', password: process.env.LAB_PG_PASSWORD || 'lab_postgres', database: 'postgres' };
    pool = new Pool({ ...config, max: 2 }); external = new Client(config); await external.connect();
    await external.query(`CREATE SCHEMA "${schema}"`);
    await external.query(`CREATE TABLE ${table} (id integer PRIMARY KEY,valore integer)`);
    await external.query(`INSERT INTO ${table} VALUES (1,10)`);
    const value = async reader => (await reader.query(`SELECT valore FROM ${table} WHERE id=1`)).rows[0].valore;
    tx = await apriTransazioneRipristino({ pool });
    await check('isolamento-pool-e-visibilita', async () => {
      assert.notEqual(tx.strategy.pool, pool);
      await tx.strategy.pool.query(`UPDATE ${table} SET valore=20`);
      assert.equal(await value(tx.strategy.pool), 20); assert.equal(await value(external), 10);
    });
    await check('errore-recuperabile-non-aborta-promozione', async () => {
      await assert.rejects(tx.strategy.pool.query('SELECT 1/0'), error => error.code === '22012');
      assert.equal(await value(tx.strategy.pool), 20);
    });
    await check('rollback-batch-non-annulla-promozione', async () => {
      const client = await tx.strategy.pool.connect();
      await client.query('BEGIN'); await client.query(`UPDATE ${table} SET valore=30`); await client.query('ROLLBACK'); client.release();
      assert.equal(await value(tx.strategy.pool), 20); assert.equal(await value(external), 10);
    });
    await check('commit-batch-non-pubblica-promozione', async () => {
      await tx.strategy.pool.query('BEGIN'); await tx.strategy.pool.query(`UPDATE ${table} SET valore=40`); await tx.strategy.pool.query('COMMIT');
      assert.equal(await value(tx.strategy.pool), 40); assert.equal(await value(external), 10);
    });
    await check('commit-pubblica-dopo-verifica', async () => {
      assert.equal(await value(tx.strategy.pool), 40); await tx.commit();
      assert.equal(tx.state, 'confermata'); assert.equal(await value(external), 40);
    });
    tx = await apriTransazioneRipristino({ pool });
    await check('rollback-integrale-preserva-originale', async () => {
      await tx.strategy.pool.query(`UPDATE ${table} SET valore=99`); await tx.rollback();
      assert.equal(tx.state, 'annullata'); assert.equal(await value(external), 40);
    });
    await check('risposta-commit-persa-non-promette-rollback', async () => {
      const client = new EventEmitter(), calls = []; let releases = 0;
      client.query = async sql => { calls.push(sql); if (sql === 'COMMIT') throw new Error('Risposta persa'); return {}; };
      client.release = () => { releases++; };
      const uncertain = await apriTransazioneRipristino({ pool: { connect: async () => client } });
      await assert.rejects(uncertain.commit(), error => error.commitUncertain === true);
      assert.equal(uncertain.state, 'incerta');
      await assert.rejects(uncertain.rollback(), /incerto/);
      assert(!calls.includes('ROLLBACK')); assert.equal(releases, 1);
    });
  } catch (error) { report.fatale = error.stack; }
  finally {
    if (tx?.state === 'aperta') await tx.rollback().catch(error => { report.rollbackError = error.message; });
    if (external) {
      try { await registry.cleanup(name => external.query(`DROP SCHEMA "${name}" CASCADE`)); report.pulizia = true; }
      catch (error) { report.errorePulizia = error.message; }
      await external.end();
    }
    if (pool) await pool.end();
    report.sorgentiStabili = JSON.stringify(report.sorgenti) === JSON.stringify(hashes());
    report.ok = !report.fatale && !report.rollbackError && report.pulizia && report.sorgentiStabili && report.verifiche.length === 7 && report.verifiche.every(x => x.ok);
    fs.writeFileSync(path.join(dir, 'pg-restore-transaction.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
})();
