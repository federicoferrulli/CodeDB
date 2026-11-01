'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const BSON = require('bson');
const codec = require('../db/mongoBson');
const util = require('../backup/lib/util');
const flag = process.argv.find(value => value.startsWith('--mutant-'));
const originalVerify = util.verifyBackupDir;
if (flag === '--mutant-integrita') util.verifyBackupDir = async () => ({ valid: true });
delete require.cache[require.resolve('../backup/lib/content-state')];
const content = require('../backup/lib/content-state');
util.verifyBackupDir = originalVerify;
const originalHash = content.hashRiga;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' && !value._bsontype
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
if (flag === '--mutant-bson-tipo' || flag === '--mutant-bson-ordine') content.hashRiga = (row, file) => file.encoding === codec.ENCODING
  ? digest(BSON.EJSON.stringify(flag === '--mutant-bson-ordine' ? sorted(BSON.deserialize(codec.decode(row), { promoteValues: false })) : BSON.deserialize(codec.decode(row)), { relaxed: flag === '--mutant-bson-tipo' }))
  : originalHash(row, file);
if (flag === '--mutant-pg-marker') content.hashRiga = (row, file) => file.encoding ? originalHash(row, file)
  : digest(BSON.EJSON.stringify(file.columns.map(name => row[name]), { relaxed: false }));
const originalDelta = content.creaDelta;
if (flag === '--mutant-filtro' || flag === '--mutant-scansione') content.creaDelta = (...args) => {
  const delta = originalDelta(...args), conclude = delta.conclude;
  let scanned = 0;
  const considera = delta.considera;
  delta.considera = (...values) => { scanned++; return considera(...values); };
  delta.conclude = count => {
    const result = conclude(flag === '--mutant-scansione' ? scanned : count);
    if (flag === '--mutant-filtro') { result.content.complete = true; result.replayCardinality = count; }
    return result;
  };
  return delta;
};
const mongo = { collection: 'eventi', columns: ['_id', 'v'], identity: { kind: 'mongodb-id', columns: ['_id'] }, encoding: codec.ENCODING };
const sql = { collection: 'eventi', columns: ['id', 'v'], columnSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'v', type: 'text', nullable: true }], identity: { kind: 'primary-key', columns: ['id'] } };
const state = (rows, file = sql) => new Map(rows.map(row => [content.chiaveRiga(row, file), {
  identity: Object.fromEntries(file.identity.columns.map(name => [name, row[name]])), hash: content.hashRiga(row, file),
}]));
const shape = { kind: 'record', names: ['funzione', 'testo'], children: [{ kind: 'reg', type: 'regproc' }, null], pgCast: '"origine"."coppia"' };
const pg = { ...sql, columnSchema: [sql.columnSchema[0], { name: 'v', type: 'coppia', nullable: false, references: shape }] };
const pgrow = (signature = 'abs(integer)', literal = 'costante') => require('../db/pg-alias').encode({ id: 1, v: { text: `(abs,${literal})`, refs: [{ kind: 'regproc', value: signature }] } }, pg.columnSchema);
const cases = [
  ['CONTENUTO-BSON-TIPI', () => {
    const types = [new BSON.Int32(1), new BSON.Long(1), new BSON.Double(1), new BSON.Decimal128('1'), '1'];
    assert.equal(new Set(types.map(v => content.hashRiga(codec.encode({ _id: 1, v }), mongo))).size, types.length);
  }],
  ['CONTENUTO-BSON-ORDINE', () => assert.notEqual(content.hashRiga(codec.encode({ _id: 1, v: { a: 1, b: 2 } }), mongo), content.hashRiga(codec.encode({ _id: 1, v: { b: 2, a: 1 } }), mongo))],
  ['CONTENUTO-BSON-TAG-LETTERALI', () => assert.notEqual(content.hashRiga(codec.encode({ _id: 1, v: { $numberLong: '1' } }), mongo), content.hashRiga(codec.encode({ _id: 1, v: BSON.Long.ONE }), mongo))],
  ['CONTENUTO-SQL-PRECISIONE', () => {
    assert.notEqual(content.hashRiga({ id: 1, v: '9007199254740992' }, sql), content.hashRiga({ id: 1, v: '9007199254740993' }, sql));
    assert.notEqual(content.hashRiga({ id: 1, v: '2026-01-01 00:00:00.000001' }, sql), content.hashRiga({ id: 1, v: '2026-01-01 00:00:00.000002' }, sql));
  }],
  ['CONTENUTO-SQL-JSON-LETTERALE', () => assert.notEqual(content.hashRiga({ id: 1, v: '{"$numberLong":"1"}' }, sql), content.hashRiga({ id: 1, v: '1' }, sql))],
  ['CONTENUTO-PG-MARKER', () => assert.equal(content.hashRiga(pgrow(), pg), content.hashRiga(pgrow(), pg))],
  ['CONTENUTO-PG-RIFERIMENTO', () => assert.notEqual(content.hashRiga(pgrow(), pg), content.hashRiga(pgrow('abs(bigint)'), pg))],
  ['CONTENUTO-PG-LETTERALE', () => {
    assert.notEqual(content.hashRiga(pgrow('abs(integer)', 'codedb_ref_' + 'a'.repeat(32) + '_0'), pg), content.hashRiga(pgrow('abs(integer)', 'codedb_ref_' + 'b'.repeat(32) + '_0'), pg));
    assert.notEqual(content.hashRiga(pgrow(), sql), content.hashRiga(pgrow(), sql));
  }],
  ['CONTENUTO-PG-NESSUNA-MUTAZIONE', () => {
    const row = pgrow(), before = JSON.stringify(row); content.hashRiga(row, pg); assert.equal(JSON.stringify(row), before);
  }],
  ['DELTA-INVARIATO-ZERO', () => {
    const rows = [{ id: 1, v: 'a' }, { id: 2, v: null }], previous = state(rows);
    const delta = content.creaDelta(previous, sql, { incremental: true });
    assert.deepEqual(rows.map(row => delta.considera(row)), [false, false]);
    assert.deepEqual(delta.conclude(2), { tombstones: [], replayCardinality: 2, content: { version: 1, mode: 'content-delta', complete: true }, scanned: 2, emitted: 0 });
    assert.equal(previous.size, 0);
  }],
  ['DELTA-UPDATE-DELETE-INSERT', () => {
    const delta = content.creaDelta(state([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]), sql, { incremental: true });
    assert.equal(delta.considera({ id: 2, v: 'c' }), true); assert.equal(delta.considera({ id: 3, v: 'd' }), true);
    const result = delta.conclude(2); assert.deepEqual(result.tombstones, [{ id: 1 }]); assert.equal(result.replayCardinality, 2);
  }],
  ['DELTA-FILTRO-CARDINALITA', () => {
    const delta = content.creaDelta(state([{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 5, v: 'e' }]), sql, { incremental: true, explicit: true });
    assert.deepEqual([delta.considera({ id: 1, v: 'c' }, false), delta.considera({ id: 2, v: 'c' }, true), delta.considera({ id: 3, v: 'c' }, false), delta.considera({ id: 4, v: 'd' }, true)], [false, true, false, true]);
    const result = delta.conclude(4); assert.equal(result.content.complete, false); assert.equal(result.replayCardinality, 3); assert.deepEqual(result.tombstones, [{ id: 5 }]);
  }],
  ['DELTA-SNAPSHOT-SENZA-PK', () => {
    const delta = content.creaDelta(new Map(), { ...sql, identity: null }, { incremental: true, explicit: true });
    assert.equal(delta.considera({ id: 1, v: 'a' }, false), true); assert.equal(delta.considera({ id: 1, v: 'a' }, false), true);
    const result = delta.conclude(2); assert.equal(result.content.mode, 'snapshot'); assert.equal(result.replayCardinality, 2); assert.deepEqual(result.tombstones, []);
  }],
  ['DELTA-SCANSIONE-INCOMPLETA', () => {
    const delta = content.creaDelta(new Map(), sql, { incremental: true }); delta.considera({ id: 1, v: 'a' }); assert.throws(() => delta.conclude(2), /Scansione incompleta/);
  }],
  ['SEMANTICA-DELTA-STORICO', () => {
    const { equivalenzaCatena, dichiarazioneCancellazioni } = require('../backup/lib/tombstones');
    const layer = file => ({ manifest: { version: 4, type: 'incremental', deletions: dichiarazioneCancellazioni(), files: [{ ...sql, kind: 'data', ...file }] } });
    assert.equal(equivalenzaCatena([layer({ mode: 'incremental', sinceColumn: 'updated_at' })]).completa, false);
    assert.equal(equivalenzaCatena([layer({ mode: 'full' })]).completa, true);
    assert.equal(equivalenzaCatena([layer({ mode: 'incremental', content: { version: 1, mode: 'content-delta', complete: true } })]).completa, true);
  }],
  ['MANIFEST-FULL-NON-PARZIALE', () => {
    const manifest = { version: 5, type: 'full', dbType: 'mysql', deletions: require('../backup/lib/tombstones').dichiarazioneCancellazioni(), files: [{ ...sql, kind: 'data', mode: 'incremental', count: 1, sourceCardinality: 2, sourceDistinctIdentities: 2, replayCardinality: 2, content: { version: 1, mode: 'content-delta', complete: true } }] };
    assert.throws(() => require('../backup/lib/identity').validaManifestIdentita(manifest), /Semantica/);
  }],
];

module.exports = (async () => {
  for (const [name, action] of cases) {
    try { await action(); console.log(`OK ${name}`); }
    catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-content-'));
  const control = { async avanza() {} };
  const write = (id, type, rows, tombstones = [], baseId = null, legacy = false) => {
    const dir = path.join(root, id); fs.mkdirSync(dir);
    const files = [];
    for (const [kind, values] of [['data', rows], ['tombstones', tombstones]]) {
      if (kind === 'tombstones' && type === 'full') continue;
      const text = values.map(row => legacy ? BSON.EJSON.stringify(row, { relaxed: false }) : JSON.stringify(codec.encode(row))).join('\n') + (values.length ? '\n' : '');
      fs.writeFileSync(path.join(dir, `${kind}.ndjson`), text);
      files.push({ ...mongo, ...(legacy ? { encoding: undefined } : {}), path: `${kind}.ndjson`, kind, mode: type === 'full' ? 'full' : 'incremental', count: values.length,
        bytes: Buffer.byteLength(text), sha256: digest(text), sourceCardinality: rows.length, sourceDistinctIdentities: rows.length });
    }
    const manifest = { version: 4, id, type, baseId, dbType: 'mongodb', db: 'origine', connection: 'c', startedAt: type === 'full' ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z', deletions: require('../backup/lib/tombstones').dichiarazioneCancellazioni(), files };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest)); return dir;
  };
  try {
    const full = write('full', 'full', [{ _id: 1, v: 1 }, { _id: 2, v: 2 }]);
    const inc = write('inc', 'incremental', [{ _id: 1, v: 3 }], [{ _id: 1 }], 'full');
    const checks = [
      ['CATENA-DELETE-PRIMA-UPSERT', async () => {
        const states = await content.caricaStatoCatena(inc, control); assert.equal(states.get('eventi').size, 2);
        assert.equal(states.get('eventi').get(content.chiaveRiga(codec.encode({ _id: 1 }), mongo)).hash, content.hashRiga(codec.encode({ _id: 1, v: 3 }), mongo));
      }],
      ['CATENA-LEGACY-MONGO', async () => {
        const dir = write('legacy', 'full', [{ _id: 1, v: 1 }, { _id: 2, v: 2 }], [], null, true);
        assert.equal((await content.caricaStatoCatena(dir, control)).get('eventi').size, 2);
      }],
      ['CATENA-INTEGRITA', async () => {
        fs.appendFileSync(path.join(full, 'data.ndjson'), ' ');
        await assert.rejects(content.caricaStatoCatena(full, control), /integrità/);
      }],
    ];
    for (const [name, action] of checks) {
      try { await action(); console.log(`OK ${name}`); }
      catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
    }
    try {
      // Si sostituisce soltanto la lettura DB: writer, manifest, resolver,
      // checksum, catalogo e rimozione del parziale restano quelli reali.
      const Module = require('module'), filename = path.resolve(__dirname, '../backup/lib/engine.js');
      const isolated = new Module(filename, module); isolated.filename = filename; isolated.paths = module.paths;
      let altered = false;
      isolated.require = name => name === './__fixture_dump' ? async args => {
        const text = '{"id":1,"v":"a"}\n'; fs.writeFileSync(path.join(args.backupDir, 'data.ndjson'), text);
        return { files: [{ ...sql, kind: 'data', path: 'data.ndjson', mode: args.since ? 'incremental' : 'full',
          columnSchema: [{ ...sql.columnSchema[0], type: altered ? 'bigint' : 'integer' }, sql.columnSchema[1]],
          count: 1, sourceCardinality: 1, sourceDistinctIdentities: 1, replayCardinality: 1,
          content: { version: 1, mode: args.since ? 'content-delta' : 'snapshot', complete: true },
          bytes: Buffer.byteLength(text), sha256: digest(text) }], notes: [], deletionStates: new Map() };
      } : Module.prototype.require.call(isolated, name);
      let source = fs.readFileSync(filename, 'utf8');
      if (flag === '--mutant-pubblicazione') source = source.replace("require('./restore').resolveChain(backupDir);", 'void backupDir;');
      isolated._compile(source + '\ndumpMySql = require("./__fixture_dump");\n', filename);
      const args = { session: { dbType: 'mysql', strategy: { async listCollections() { return [{ name: 'eventi' }]; } } }, connName: 'metadata', db: 'origine', destRoot: root, compress: false, log: { info() {} } };
      const first = await isolated.exports.runBackup({ ...args, type: 'full' });
      const group = path.dirname(first.backupDir), catalog = fs.readFileSync(path.join(group, 'catalog.json'), 'utf8');
      const entries = fs.readdirSync(group).sort(); altered = true;
      await assert.rejects(isolated.exports.runBackup({ ...args, type: 'incremental' }), /Colonne o identita/);
      assert.equal(fs.readFileSync(path.join(group, 'catalog.json'), 'utf8'), catalog);
      assert.deepEqual(fs.readdirSync(group).sort(), entries);
      console.log('OK CATALOGO-METADATA-INCOMPATIBILI');
    } catch (error) { console.error(`FAIL CATALOGO-METADATA-INCOMPATIBILI: ${error.message}`); process.exitCode = 1; }
  } finally {
    assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true });
  }
})();
