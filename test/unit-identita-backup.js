'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EJSON } = require('bson');
const {
  scegliIdentitaSql,
  validaManifestIdentita,
  chiaveIdentita,
  riepilogaIdentitaLayer,
} = require('../backup/lib/identity');
const { resolveChain } = require('../backup/lib/restore');
const { runBackup } = require('../backup/lib/engine');

function prova(nome, fn) {
  try {
    fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    console.error(`  FAIL ${nome}:`, err);
    process.exitCode = 1;
  }
}

prova('Identita SQL: PK prima di UNIQUE e UNIQUE solo interamente NOT NULL', () => {
  const id = scegliIdentitaSql(
    [
      { name: 'tenant', nullable: false },
      { name: 'email', nullable: false },
      { name: 'alias', nullable: true },
    ],
    [
      { name: 'uq_alias', kind: 'unique', columns: ['alias'] },
      { name: 'uq_email', kind: 'unique', columns: ['tenant', 'email'] },
    ],
  );
  assert.deepStrictEqual(id, { kind: 'unique', name: 'uq_email', columns: ['tenant', 'email'] });

  assert.strictEqual(scegliIdentitaSql(
    [{ name: 'alias', nullable: true }],
    [{ name: 'uq_alias', kind: 'unique', columns: ['alias'] }],
  ), null);
});

prova('Manifest v2: incrementali senza identita e manifest storici non sono promossi', () => {
  assert.throws(() => validaManifestIdentita({
    version: 2, dbType: 'mysql',
    type: 'incremental',
    files: [{
      kind: 'data', collection: 'eventi', columns: ['quando'],
      columnSchema: [{ name: 'quando', type: 'datetime', nullable: false }], identity: null,
      sourceCardinality: 0, sourceDistinctIdentities: null,
    }],
  }), /identit.+stabile/i);
  assert.throws(() => validaManifestIdentita({
    version: 1,
    type: 'incremental',
    files: [{ kind: 'data', collection: 'eventi' }],
  }), /storico|versione/i);
  assert.doesNotThrow(() => validaManifestIdentita({
    version: 1,
    type: 'full',
    files: [{ kind: 'data', collection: 'eventi' }],
  }));
  assert.throws(() => validaManifestIdentita({
    version: 2, dbType: 'mongodb', type: 'full',
    files: [{
      kind: 'data', collection: 'utenti', columns: ['_id', 'email'],
      identity: { kind: 'unique', columns: ['email'] },
      sourceCardinality: 0, sourceDistinctIdentities: 0,
    }],
  }), /MongoDB.*_id/i);
  assert.throws(() => validaManifestIdentita({
    version: 2, dbType: 'postgresql', type: 'full',
    files: [{
      kind: 'data', collection: 'utenti', columns: ['id'],
      identity: { kind: 'primary-key', columns: ['id'] },
      sourceCardinality: 0, sourceDistinctIdentities: 0,
    }],
  }), /tipi.*nullabilita/i);
});

prova('Identita composta: valori mancanti o nulli sono rifiutati', () => {
  const identity = { kind: 'unique', columns: ['tenant', 'email'] };
  assert.strictEqual(typeof chiaveIdentita({ tenant: 7, email: 'a@b.it' }, identity), 'string');
  assert.throws(() => chiaveIdentita({ tenant: 7 }, identity), /email/);
  assert.throws(() => chiaveIdentita({ tenant: 7, email: null }, identity), /null/i);
});

prova('Duplicazione dei layer: la cardinalita finale e il numero di identita distinte non sono la somma delle scritture', () => {
  const identity = { kind: 'primary-key', columns: ['id'] };
  const esito = riepilogaIdentitaLayer([
    { identity, rows: [{ id: 1 }, { id: 2 }] },
    { identity, rows: [{ id: 2 }, { id: 3 }] },
  ]);
  assert.strictEqual(esito.writes, 4, 'il margine incrementale ripete legittimamente una scrittura');
  assert.strictEqual(esito.distinct, 3, 'il risultato finale contiene tre righe, non quattro');
  // Questa e' la sensibilita' richiesta: il vecchio confronto con la somma
  // delle scritture produrrebbe 4 e il test fallirebbe.
  assert.notStrictEqual(esito.distinct, esito.writes);
});

prova('Catena: uno storico o un cambio di colonne/identita richiedono un nuovo full', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-identita-'));
  try {
    const write = (id, manifest) => {
      const dir = path.join(root, id);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        id,
        connection: 'c',
        db: 'd',
        dbType: 'mysql',
        startedAt: manifest.startedAt,
        files: manifest.files,
        ...manifest,
      }));
      return dir;
    };
    write('full-old', {
      version: 1, type: 'full', baseId: null, startedAt: '2026-01-01T00:00:00Z',
      files: [{ kind: 'data', collection: 't' }],
    });
    const oldInc = write('inc-old', {
      version: 2, type: 'incremental', baseId: 'full-old', startedAt: '2026-01-02T00:00:00Z',
      files: [{
        kind: 'data', collection: 't', columns: ['id'],
        columnSchema: [{ name: 'id', type: 'int', nullable: false }],
        identity: { kind: 'primary-key', columns: ['id'] },
        sourceCardinality: 0, sourceDistinctIdentities: 0,
      }],
    });
    assert.throws(() => resolveChain(oldInc), /storico/i);

    write('full-new', {
      version: 2, type: 'full', baseId: null, startedAt: '2026-02-01T00:00:00Z',
      files: [{
        kind: 'data', collection: 't', columns: ['id', 'nome'],
        columnSchema: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'nome', type: 'varchar(50)', nullable: true },
        ],
        identity: { kind: 'primary-key', columns: ['id'] },
        sourceCardinality: 0, sourceDistinctIdentities: 0,
      }],
    });
    const changed = write('inc-changed', {
      version: 2, type: 'incremental', baseId: 'full-new', startedAt: '2026-02-02T00:00:00Z',
      files: [{
        kind: 'data', collection: 't', columns: ['id', 'email'],
        columnSchema: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'email', type: 'varchar(50)', nullable: true },
        ],
        identity: { kind: 'primary-key', columns: ['id'] },
        sourceCardinality: 0, sourceDistinctIdentities: 0,
      }],
    });
    assert.throws(() => resolveChain(changed), /colonne|identita/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-manifest-v2-'));
  try {
    const docs = [{ _id: 1, nome: 'Anna' }, { _id: 2, email: 'b@example.test' }];
    const collection = {
      find() {
        return {
          batchSize() { return this; },
          async close() {},
          async *[Symbol.asyncIterator]() { yield* docs; },
        };
      },
      async indexes() { return [{ name: '_id_', key: { _id: 1 } }]; },
      async countDocuments() { return docs.length; },
    };
    const mongoDb = {
      collection() { return collection; },
      listCollections() { return { async toArray() { return []; } }; },
    };
    const strategy = {
      async listCollections() { return [{ name: 'utenti' }]; },
      client: { db() { return mongoDb; } },
    };
    const summary = await runBackup({
      session: { strategy, dbType: 'mongodb' },
      connName: 'test', db: 'db', type: 'full', destRoot: root,
      compress: false, level: 0, log: { info() {} },
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(summary.backupDir, 'manifest.json'), 'utf8'));
    const data = manifest.files.find((f) => f.kind === 'data');
    assert.strictEqual(manifest.version, 2);
    assert.deepStrictEqual(data.identity, { kind: 'mongodb-id', columns: ['_id'] });
    assert.deepStrictEqual(new Set(data.columns), new Set(['_id', 'nome', 'email']));
    console.log('  OK   Il dump MongoDB scrive davvero manifest v2, colonne e identita _id');
  } catch (err) {
    console.error('  FAIL Manifest v2 prodotto dal motore:', err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-restore-identita-'));
  try {
    const writeLayer = (id, type, baseId, startedAt, rows) => {
      const dir = path.join(root, id);
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      const body = rows.map((row) => EJSON.stringify(row, { relaxed: false })).join('\n') + '\n';
      const dataPath = path.join(dir, 'data', 'utenti.ndjson');
      fs.writeFileSync(dataPath, body);
      const manifest = {
        tool: 'codedb-backup', version: 2, id, type, baseId,
        connection: 'c', dbType: 'mongodb', db: 'origine', startedAt,
        files: [{
          path: 'data/utenti.ndjson', collection: 'utenti', kind: 'data',
          columns: ['_id', 'nome'], identity: { kind: 'mongodb-id', columns: ['_id'] },
          sourceCardinality: type === 'full' ? rows.length : 3,
          sourceDistinctIdentities: type === 'full' ? rows.length : 3,
          count: rows.length, bytes: Buffer.byteLength(body),
          sha256: crypto.createHash('sha256').update(body).digest('hex'),
        }],
      };
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
      return dir;
    };
    writeLayer('full', 'full', null, '2026-01-01T00:00:00Z', [
      { _id: 1, nome: 'Anna' }, { _id: 2, nome: 'Bruno' },
    ]);
    const inc = writeLayer('inc', 'incremental', 'full', '2026-01-02T00:00:00Z', [
      { _id: 2, nome: 'Bruno aggiornato' }, { _id: 3, nome: 'Carla' },
    ]);

    const documents = new Map();
    const collection = {
      async insertMany(rows) { for (const row of rows) documents.set(String(row._id), row); },
      async bulkWrite(ops) {
        for (const op of ops) documents.set(String(op.replaceOne.replacement._id), op.replaceOne.replacement);
      },
      async countDocuments() { return documents.size; },
      aggregate() { return { async toArray() { return documents.size ? [{ n: documents.size }] : []; } }; },
      async createIndex() {},
      async drop() { documents.clear(); },
    };
    // Il doppio deve avere i metodi del driver che il restore usa davvero:
    // `createCollection` materializza le collection VUOTE, che altrimenti non
    // nascerebbero mai (una collection nasce alla prima scrittura).
    const create = [];
    const strategy = {
      client: {
        db() {
          return {
            collection() { return collection; },
            async createCollection(name) { create.push(name); },
          };
        },
      },
    };
    const summary = await require('../backup/lib/restore').runRestore({
      session: { strategy, dbType: 'mongodb' }, backupDir: inc, targetDb: 'destinazione',
      drop: true, log: { info() {} },
    });
    assert.strictEqual(summary.totalWrites, 4);
    assert.strictEqual(summary.totalDocs, 3);
    assert.strictEqual(summary.expectedDocs, 3);
    assert.strictEqual(documents.get('2').nome, 'Bruno aggiornato');
    console.log('  OK   Restore reale della catena: 4 scritture, cardinalita finale e identita distinte 3');

    const incManifestPath = path.join(inc, 'manifest.json');
    const incManifest = JSON.parse(fs.readFileSync(incManifestPath, 'utf8'));
    incManifest.files[0].sourceCardinality = 4;
    incManifest.files[0].sourceDistinctIdentities = 4;
    fs.writeFileSync(incManifestPath, JSON.stringify(incManifest));
    documents.clear();
    await assert.rejects(
      require('../backup/lib/restore').runRestore({
        session: { strategy, dbType: 'mongodb' }, backupDir: inc,
        targetDb: 'destinazione', drop: true, log: { info() {} },
      }),
      /cardinalita finale 3 di 4/i,
    );
    console.log('  OK   La verifica finale intercetta una identita sorgente omessa, non e tautologica');

    const storicoDir = path.join(root, 'storico');
    fs.mkdirSync(path.join(storicoDir, 'data'), { recursive: true });
    const storicoBody = `${EJSON.stringify({ _id: 10, nome: 'Storico' }, { relaxed: false })}\n`;
    fs.writeFileSync(path.join(storicoDir, 'data', 'utenti.ndjson'), storicoBody);
    fs.writeFileSync(path.join(storicoDir, 'manifest.json'), JSON.stringify({
      tool: 'codedb-backup', version: 1, id: 'storico', type: 'full', baseId: null,
      connection: 'c', dbType: 'mongodb', db: 'origine', startedAt: '2025-01-01T00:00:00Z',
      files: [{
        path: 'data/utenti.ndjson', collection: 'utenti', kind: 'data', count: 1,
        bytes: Buffer.byteLength(storicoBody),
        sha256: crypto.createHash('sha256').update(storicoBody).digest('hex'),
      }],
    }));
    documents.clear();
    documents.set('99', { _id: 99, nome: 'Esistente' });
    await assert.rejects(
      require('../backup/lib/restore').runRestore({
        session: { strategy, dbType: 'mongodb' }, backupDir: storicoDir,
        targetDb: 'destinazione', drop: false, log: { info() {} },
      }),
      /destinazione vuota/i,
    );
    assert.strictEqual(documents.size, 1, 'il full storico rifiutato non deve scrivere');
    console.log('  OK   Full storico senza identita rifiutato su destinazione popolata prima di scrivere');
  } catch (err) {
    console.error('  FAIL Restore reale con verifica finale delle identita:', err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
