'use strict';

/* ---------------------------------------------------------------------------
 * Test end-to-end della CLI di backup (backup/cli.js) su MySQL.
 *
 * Richiede un MySQL locale (root; password da env MYSQL_PASSWORD, default
 * vuota; porta da env MYSQL_PORT, default 3306). NON richiede il server su
 * :3030 e NON tocca il connections.ini reale (CODEDB_CONNECTIONS_FILE).
 * Crea e poi elimina i database gui_mysql_e2e_backup (+ _restore).
 *
 * Flusso: seed → backup full → nuove scritture → backup incremental (colonna
 * updated_at rilevata da sola) → restore della catena su altro schema.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const mysql = require('mysql2/promise');

const DB = 'gui_mysql_e2e_backup';
const DB_RESTORE = 'gui_mysql_e2e_backup_restore';
const PORT = parseInt(process.env.MYSQL_PORT, 10) || 3306;
const PASSWORD = process.env.MYSQL_PASSWORD || '';
const CLI = path.join(__dirname, '..', 'backup', 'cli.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-backup-e2e-mysql-'));
const iniFile = path.join(tmpRoot, 'connections.ini');
const destRoot = path.join(tmpRoot, 'backups');
fs.writeFileSync(
  iniFile,
  `[e2e-backup-mysql]\ndbType=mysql\nhost=localhost\nport=${PORT}\nusername=root\n${PASSWORD ? `password=${PASSWORD}\n` : ''}`,
  'utf8'
);

function cli(...args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CODEDB_CONNECTIONS_FILE: iniFile },
  });
}

async function main() {
  const conn = await mysql.createConnection({
    host: 'localhost', port: PORT, user: 'root', password: PASSWORD, multipleStatements: true,
  });
  try {
    await conn.query(`DROP DATABASE IF EXISTS ${DB}; DROP DATABASE IF EXISTS ${DB_RESTORE}; CREATE DATABASE ${DB}`);
    await conn.query(
      `CREATE TABLE ${DB}.clienti (
         id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         nome VARCHAR(50) NOT NULL,
         saldo DECIMAL(10,2),
         updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
       )`
    );
    await conn.query(`INSERT INTO ${DB}.clienti (nome, saldo) VALUES ('Anna', 10.50), ('Bruno', 20.00)`);

    // 1. Backup full.
    const outFull = cli('backup', '--conn', 'e2e-backup-mysql', '--db', DB, '--type', 'full', '--dest', destRoot);
    assert.match(outFull, /stato=SUCCESSO/, 'il backup full deve riuscire');

    // 2. Nuove scritture (insert + update), poi incrementale: la colonna
    // updated_at deve essere rilevata automaticamente.
    await new Promise((r) => setTimeout(r, 1100)); // granularità 1s di TIMESTAMP
    await conn.query(`INSERT INTO ${DB}.clienti (nome, saldo) VALUES ('Carla', 30.00)`);
    await conn.query(`UPDATE ${DB}.clienti SET saldo = 11.00 WHERE nome = 'Anna'`);
    const outInc = cli('backup', '--conn', 'e2e-backup-mysql', '--db', DB, '--type', 'incremental', '--dest', destRoot);
    assert.match(outInc, /stato=SUCCESSO/, 'il backup incrementale deve riuscire');

    const groupDir = path.join(destRoot, `e2e-backup-mysql_${DB}`);
    const catalog = JSON.parse(fs.readFileSync(path.join(groupDir, 'catalog.json'), 'utf8'));
    assert.strictEqual(catalog.backups.length, 2);
    const [full, inc] = catalog.backups;
    const incManifest = JSON.parse(fs.readFileSync(path.join(groupDir, inc.id, 'manifest.json'), 'utf8'));
    const incData = incManifest.files.find((f) => f.kind === 'data' && f.collection === 'clienti');
    assert.strictEqual(incData.sinceColumn, 'updated_at', 'deve usare la colonna updated_at');
    assert.strictEqual(incData.count, 2, 'l\'incrementale deve contenere insert + update');

    // 3. Restore della catena su un altro schema (i layer upsert via REPLACE).
    const outRestore = cli(
      'restore', '--conn', 'e2e-backup-mysql', '--from', path.join(groupDir, inc.id),
      '--target-db', DB_RESTORE, '--drop', '--dest', destRoot
    );
    assert.match(outRestore, /stato=SUCCESSO/, 'il restore deve riuscire');

    const [rows] = await conn.query(`SELECT nome, saldo FROM ${DB_RESTORE}.clienti ORDER BY nome`);
    assert.strictEqual(rows.length, 3, 'devono esserci 3 clienti dopo il restore');
    assert.strictEqual(Number(rows.find((r) => r.nome === 'Anna').saldo), 11, 'l\'update deve essere applicato dal layer incrementale');

    // 4. Verifica checksum del full.
    const outVerify = cli('verify', '--from', path.join(groupDir, full.id));
    assert.match(outVerify, /0 problemi/);

    console.log('e2e-backup-mysql: tutti i test superati.');
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS ${DB}; DROP DATABASE IF EXISTS ${DB_RESTORE}`).catch(() => {});
    await conn.end().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('e2e-backup-mysql FALLITO:', err);
  process.exitCode = 1;
});
