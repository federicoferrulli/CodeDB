'use strict';

/* ---------------------------------------------------------------------------
 * Test end-to-end della CLI di backup (backup/cli.js) su MongoDB.
 *
 * Richiede un MongoDB locale su localhost:27017 (come test/e2e.js); NON
 * richiede il server su :3030 e NON tocca il connections.ini reale: usa un
 * file temporaneo via CODEDB_CONNECTIONS_FILE. Crea e poi elimina il database
 * gui_mongodb_e2e_backup (+ _restore) e una cartella di backup temporanea.
 *
 * Flusso: seed → backup full → nuove scritture → backup incremental →
 * verify → restore (catena full+incremental) su un db diverso → confronti.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MongoClient } = require('mongodb');

const DB = 'gui_mongodb_e2e_backup';
const DB_RESTORE = 'gui_mongodb_e2e_backup_restore';
const CLI = path.join(__dirname, '..', 'backup', 'cli.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-backup-e2e-'));
const iniFile = path.join(tmpRoot, 'connections.ini');
const destRoot = path.join(tmpRoot, 'backups');
fs.writeFileSync(iniFile, '[e2e-backup]\ndbType=mongodb\nhost=localhost\nport=27017\n', 'utf8');

function cli(...args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CODEDB_CONNECTIONS_FILE: iniFile },
  });
}

async function main() {
  const client = new MongoClient('mongodb://localhost:27017', { serverSelectionTimeoutMS: 4000 });
  await client.connect();
  try {
    await client.db(DB).dropDatabase().catch(() => {});
    await client.db(DB_RESTORE).dropDatabase().catch(() => {});

    // Seed: due collection, un indice, tipi EJSON significativi (Date).
    const utenti = client.db(DB).collection('utenti');
    await utenti.insertMany([
      { nome: 'Anna', punti: 10, creato: new Date('2026-01-01T00:00:00Z') },
      { nome: 'Bruno', punti: 20, creato: new Date('2026-02-01T00:00:00Z') },
    ]);
    await utenti.createIndex({ nome: 1 }, { unique: true, name: 'nome_unico' });
    await client.db(DB).collection('ordini').insertMany([{ totale: 99.5 }, { totale: 12 }]);

    // 1. Backup full.
    const outFull = cli('backup', '--conn', 'e2e-backup', '--db', DB, '--type', 'full', '--dest', destRoot);
    assert.match(outFull, /stato=SUCCESSO/, 'il backup full deve riuscire');

    // 2. Nuove scritture, poi backup incrementale (heuristica ObjectId:
    // granularità 1 secondo, serve superare il secondo del backup full).
    await new Promise((r) => setTimeout(r, 1100));
    await utenti.insertOne({ nome: 'Carla', punti: 30, creato: new Date() });
    const outInc = cli('backup', '--conn', 'e2e-backup', '--db', DB, '--type', 'incremental', '--dest', destRoot);
    assert.match(outInc, /stato=SUCCESSO/, 'il backup incrementale deve riuscire');

    // 3. Catalogo e manifest.
    const groupDir = path.join(destRoot, `e2e-backup_${DB}`);
    const catalog = JSON.parse(fs.readFileSync(path.join(groupDir, 'catalog.json'), 'utf8'));
    assert.strictEqual(catalog.backups.length, 2, 'il catalogo deve avere 2 backup');
    const [full, inc] = catalog.backups;
    assert.strictEqual(full.type, 'full');
    assert.strictEqual(inc.type, 'incremental');
    assert.strictEqual(inc.baseId, full.id, 'l\'incrementale deve basarsi sul full');
    const incManifest = JSON.parse(fs.readFileSync(path.join(groupDir, inc.id, 'manifest.json'), 'utf8'));
    const incUtenti = incManifest.files.find((f) => f.kind === 'data' && f.collection === 'utenti');
    assert.strictEqual(incUtenti.count, 1, 'l\'incrementale deve contenere solo il nuovo documento');

    // 4. Verifica checksum.
    const outVerify = cli('verify', '--from', path.join(groupDir, inc.id));
    assert.match(outVerify, /0 problemi/, 'verify non deve trovare problemi');

    // 5. List.
    const outList = cli('list', '--dest', destRoot);
    assert.match(outList, new RegExp(full.id));
    assert.match(outList, new RegExp(inc.id));

    // 6. Restore dell'incrementale (catena full → incremental) su altro db.
    const outRestore = cli(
      'restore', '--conn', 'e2e-backup', '--from', path.join(groupDir, inc.id),
      '--target-db', DB_RESTORE, '--drop', '--dest', destRoot
    );
    assert.match(outRestore, /stato=SUCCESSO/, 'il restore deve riuscire');

    const restored = client.db(DB_RESTORE).collection('utenti');
    assert.strictEqual(await restored.countDocuments(), 3, 'devono esserci 3 utenti dopo il restore');
    const anna = await restored.findOne({ nome: 'Anna' });
    assert.ok(anna.creato instanceof Date, 'le date devono restare Date dopo il roundtrip EJSON');
    const indexes = await restored.indexes();
    assert.ok(indexes.some((i) => i.name === 'nome_unico' && i.unique), 'l\'indice unico deve essere ricreato');
    assert.strictEqual(await client.db(DB_RESTORE).collection('ordini').countDocuments(), 2);

    // 7. Restore selettivo su collection inesistente: deve fallire.
    let failed = false;
    try {
      cli('restore', '--conn', 'e2e-backup', '--from', path.join(groupDir, full.id),
        '--target-db', DB_RESTORE, '--collections', 'inesistente', '--dest', destRoot);
    } catch {
      failed = true;
    }
    assert.ok(failed, 'il restore di una collection inesistente deve fallire');

    console.log('e2e-backup: tutti i test superati.');
  } finally {
    await client.db(DB).dropDatabase().catch(() => {});
    await client.db(DB_RESTORE).dropDatabase().catch(() => {});
    await client.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('e2e-backup FALLITO:', err);
  process.exitCode = 1;
});
