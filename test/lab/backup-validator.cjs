'use strict';
const { inoltraOutputFiglio } = require('./output-mutanti.cjs');

// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/backup-validator.cjs [--sensitivity]
// I confronti e le scritture di prova usano il driver MongoDB indipendente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { MongoClient } = require('mongodb');
const { EJSON, BSONRegExp, Long, ObjectId, serialize } = require('bson');
const { createE2eTargetRegistry } = require('../e2e-harness');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/lab-006/reali-host');
const silenzioso = { info() {}, warn() {}, error() {} };
const copia = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');

async function worker(mutante) {
  fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-validator', mutante, iniziato: new Date().toISOString(), verifiche: [], operazioni: [], mutazioni: 0, sorgenti: {} };
  for (const name of ['db/schemaObjects.js', 'db/mongoCollectionOptions.js', 'db/mongoSchemaBson.js', 'db/backupRestoreAdapter.js',
    'db/importArtifactAdapter.js', 'db/artefatti.js', 'db/databaseExport.js', 'db/MongoDbStrategy.js',
    'backup/lib/engine.js', 'backup/lib/schema-snapshot.js', 'backup/lib/restore.js', 'test/lab/backup-validator.cjs']) {
    report.sorgenti[name] = hash(fs.readFileSync(path.resolve(__dirname, '../..', name)));
  }
  if (['default', 'validator', 'modi'].includes(mutante)) {
    const schema = require('../../db/schemaObjects'), originale = schema.canonicalSchemaInventory;
    schema.canonicalSchemaInventory = (objects, options) => {
      report.mutazioni++;
      const result = originale(objects, options);
      if (mutante === 'validator' || mutante === 'modi') result.collectionOptions = result.collectionOptions.map(text => {
        const item = JSON.parse(text);
        if (mutante === 'validator') delete item.options.validator;
        if (mutante === 'modi') { delete item.options.validationLevel; delete item.options.validationAction; }
        return JSON.stringify(item);
      }).sort();
      if (mutante === 'default') result.collectionOptions = result.collectionOptions.map(text => {
        const item = JSON.parse(text), metadata = objects.collectionOptions.find(value => value.name === item.name).options;
        return JSON.stringify({ ...item, presenzaDefault: [metadata.validationLevel ?? 'omesso', metadata.validationAction ?? 'omesso'] });
      }).sort();
      return result;
    };
  }
  if (mutante === 'esistenti') {
    const collections = require('../../db/mongoCollectionOptions');
    const originale = collections.preparaCollectionMongo;
    const { codificaMetadati, decodificaMetadati } = require('../../db/mongoSchemaBson');
    collections.preparaCollectionMongo = async (currentClient, db, name, rawOptions = {}, settings = {}) => {
      report.mutazioni++;
      const desired = decodificaMetadati(settings.metadata || { options: rawOptions });
      if (desired.options?.validator && !settings.deferValidation) {
        const current = (await currentClient.db(db).listCollections({ name }).next())?.options;
        if (current?.validator && EJSON.stringify(current.validator, { relaxed: false })
          === EJSON.stringify(desired.options.validator, { relaxed: false })) {
          // Reintroduce la vecchia equivalenza EJSON nella sola scelta collMod;
          // le copie BSON/EJSON restano coerenti e attraversano il vero decoder.
          desired.options.validator = current.validator;
          const metadata = codificaMetadati(desired);
          return originale(currentClient, db, name, metadata.options, { ...settings, metadata });
        }
      }
      return originale(currentClient, db, name, rawOptions, settings);
    };
  }
  const { runBackup } = require('../../backup/lib/engine');
  const { runRestoreViaPlan } = require('../../db/backupRestoreAdapter');
  const { leggiCatalogoExport } = require('../../db/exportCatalogo');
  const { creaPianoExport } = require('../../db/exportPlan');
  const { esportaDatabase } = require('../../db/databaseExport');
  const { creaPianoImport, eseguiPianoImport } = require('../../db/importPlan');
  const { createImportArtifactAdapter } = require('../../db/importArtifactAdapter');
  const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lab_val' });
  const source = registry.target('origine');
  const client = new MongoClient(`mongodb://127.0.0.1:${Number(process.env.LAB_MONGO_PORT || 37017)}/?directConnection=true`, { serverSelectionTimeoutMS: 6000 });
  const strategy = new (require('../../db/MongoDbStrategy'))(); strategy.client = client;
  const validator = { $jsonSchema: { bsonType: 'object', required: ['testo'], properties: { testo: { bsonType: 'string' } } } };
  const tagLetterali = { re: { $regularExpression: { pattern: 'x', options: 'i' } }, long: { $numberLong: '9007199254740993' },
    date: { $date: '2020-01-02T03:04:05.000Z' }, oid: { $oid: '507f1f77bcf86cd799439011' } };
  const tagNativi = { re: new BSONRegExp('x', 'i'), long: Long.fromString('9007199254740993'),
    date: new Date('2020-01-02T03:04:05.000Z'), oid: new ObjectId('507f1f77bcf86cd799439011') };
  const fixtures = [
    { name: 'implicita', options: { validator }, level: 'strict', action: 'error' },
    { name: 'esplicita', options: { validator, validationLevel: 'strict', validationAction: 'error' }, level: 'strict', action: 'error' },
    { name: 'moderata', options: { validator, validationLevel: 'moderate' }, level: 'moderate', action: 'error' },
    { name: 'disattivata', options: { validator, validationLevel: 'off' }, level: 'off', action: 'error' },
    { name: 'avviso', options: { validator, validationAction: 'warn' }, level: 'strict', action: 'warn' },
    { name: 'nessuna', options: {}, level: 'strict', action: 'error', libera: true },
    { name: 'vuota', options: { validator: {}, validationLevel: 'strict', validationAction: 'error' }, level: 'strict', action: 'error', libera: true },
    { name: 'letterale', options: { validator: { annidato: { $eq: { a: 1, b: 2 } } }, validationLevel: 'strict', validationAction: 'error' }, literal: true },
    { name: 'regex', options: { validator: { testo: { $regex: '^ok$', $options: 'i' } } }, regex: true },
    { name: 'literal_regex', options: { validator: { valore: { $eq: { $regex: 'x', $options: 'i' } } } }, literalRegex: true },
    { name: 'literal_tags', options: { validator: Object.fromEntries(Object.entries(tagLetterali).map(([campo, valore]) => [campo, { $eq: valore }])) }, literalTags: true },
  ];
  async function check(id, run) {
    const started = Date.now();
    try { const dettagli = await run(); report.verifiche.push({ id, ok: true, ms: Date.now() - started, dettagli }); console.log(`OK ${id}`); return true; }
    catch (error) { report.verifiche.push({ id, ok: false, ms: Date.now() - started, errore: error.message, stack: error.stack }); console.error(`FAIL ${id}: ${error.message}`); return false; }
  }
  async function snapshot(db, name) {
    const info = await client.db(db).listCollections({ name }).next();
    assert(info, `Collection ${name} mancante`);
    // Oracolo esplicito dei default documentati del server, indipendente da
    // canonicalSchemaInventory; il contenuto del validator resta alla lettera.
    const options = { ...info.options, validator: info.options.validator ?? {},
      validationLevel: info.options.validationLevel ?? 'strict', validationAction: info.options.validationAction ?? 'error' };
    const semantic = EJSON.serialize(options, { relaxed: false });
    // Il catalogo ammette sia l'operatore regex sia il corrispondente valore
    // BSONRegExp. Sono equivalenti per questa fixture; un documento ordinario
    // {pattern,options} resta invece distinto e il probe ne prova il rifiuto.
    const regex = options.validator?.testo;
    if (name === 'regex' && typeof regex?.$regex === 'string') {
      semantic.validator.testo = { $regularExpression: { pattern: regex.$regex, options: regex.$options || '' } };
    }
    const docs = await client.db(db).collection(name).find({}, { promoteValues: false }).sort({ _id: 1 }).toArray();
    const result = { options: semantic, validator: JSON.stringify(semantic.validator),
      docs: docs.map(doc => EJSON.stringify(doc, { relaxed: false })) };
    if (name === 'literal_tags' || name === 'literal_regex') {
      // BSON grezzo distingue un vero tipo dal documento che imita il suo tag
      // EJSON: la sola riserializzazione EJSON non sarebbe un oracolo sufficiente.
      result.validatorBson = serialize(info.options.validator).toString('base64');
      result.docsBson = docs.map(doc => serialize(doc).toString('base64'));
      result.indiciBson = (await client.db(db).collection(name).listIndexes().toArray())
        .filter(index => index.name !== '_id_').map(index => ({ name: index.name,
          key: serialize(index.key).toString('base64'), filtro: serialize(index.partialFilterExpression).toString('base64') }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return result;
  }
  async function comportamento(db, fixture) {
    const coll = client.db(db).collection(fixture.name), id = 9000;
    const rejected = async operation => assert.rejects(operation, error => error.code === 121, 'Il server deve respingere il documento non valido');
    try {
      if (fixture.literal) {
        await coll.insertOne({ _id: id, annidato: { a: 1, b: 2 } });
        await rejected(coll.insertOne({ _id: id + 1, annidato: { b: 2, a: 1 } }));
        return { literalOrdinato: true };
      }
      if (fixture.regex) {
        await coll.insertOne({ _id: id, testo: 'OK' });
        await rejected(coll.insertOne({ _id: id + 1, testo: 'non valido' }));
        return { regexEOpzioni: true };
      }
      if (fixture.literalRegex) {
        await coll.insertOne({ _id: id, valore: { $regex: 'x', $options: 'i' } });
        await rejected(coll.insertOne({ _id: id + 1, valore: new BSONRegExp('x', 'i') }));
        await rejected(coll.insertOne({ _id: id + 1, valore: 'x' }));
        return { documentoLegacyLetterale: true, valoreRegexRespinto: true, stringaRespinta: true };
      }
      if (fixture.literalTags) {
        await coll.insertOne({ _id: id, rank: 1, ...tagLetterali });
        for (const [campo, valore] of Object.entries(tagNativi)) {
          await rejected(coll.insertOne({ _id: id + 1, rank: 1, ...tagLetterali, [campo]: valore }));
          const ids = await coll.find({ [campo]: { $eq: tagLetterali[campo] } }, { projection: { _id: 1 } })
            .hint(`parziale_${campo}`).sort({ _id: 1 }).toArray();
          assert.deepEqual(ids, [{ _id: 1 }, { _id: id }], `Il filtro parziale ${campo} deve indicizzare i documenti letterali`);
        }
        return { documentiLetterali: true, tipiBsonRespinti: Object.keys(tagNativi), indiciParzialiNativi: 4 };
      }
      const permette = fixture.libera || fixture.level === 'off' || fixture.action === 'warn';
      if (permette) await coll.insertOne({ _id: id, testo: 123 });
      else await rejected(coll.insertOne({ _id: id, testo: 123 }));
      const modificaInvalido = coll.updateOne({ _id: 2 }, { $set: { prova: true } });
      if (permette || fixture.level === 'moderate') await modificaInvalido;
      else await rejected(modificaInvalido);
      return { nuovoInvalidoAccettato: !!permette, vecchioInvalidoModificabile: !!permette || fixture.level === 'moderate' };
    } finally {
      await coll.deleteMany({ _id: { $in: [id, id + 1] } });
      await coll.updateOne({ _id: 2 }, { $unset: { prova: '' } }, { bypassDocumentValidation: true });
    }
  }
  async function importazione(artifact, destination, tamper) {
    const plan = creaPianoImport({ artifact, expectedDbType: 'mongodb', connection: 'validator', targetDb: destination, drop: true });
    const adapter = createImportArtifactAdapter({ strategy, dbType: 'mongodb', connName: 'validator',
      recoveryRoot: path.join(reportDir, 'recovery'), log: silenzioso });
    if (tamper) {
      const apply = adapter.apply;
      adapter.apply = async (currentPlan, staging) => { const result = await apply(currentPlan, staging); await tamper(staging.db); return result; };
    }
    const fasi = [];
    const result = await eseguiPianoImport(plan, { adapter, onProgress: evento => fasi.push(evento) });
    report.operazioni.push({ target: destination, tamper: !!tamper, result, fasi });
    return { result, fasi };
  }
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    await client.connect();
    report.server = (await client.db('admin').command({ buildInfo: 1 })).version;
    for (const fixture of fixtures) {
      await client.db(source).createCollection(fixture.name, fixture.options);
      if (fixture.literalTags) for (const [campo, valore] of Object.entries(tagLetterali)) {
        await client.db(source).collection(fixture.name).createIndex({ rank: 1 },
          { name: `parziale_${campo}`, partialFilterExpression: { [campo]: { $eq: valore } } });
      }
      await client.db(source).collection(fixture.name).insertMany(fixture.literal
        ? [{ _id: 1, annidato: { a: 1, b: 2 } }]
        : fixture.regex ? [{ _id: 1, testo: 'ok' }]
          : fixture.literalRegex ? [{ _id: 1, valore: { $regex: 'x', $options: 'i' } }]
            : fixture.literalTags ? [{ _id: 1, rank: 1, ...tagLetterali }]
          : [{ _id: 1, testo: 'valido' }, { _id: 2, testo: 123 }], { bypassDocumentValidation: true });
      await check(`origine-${fixture.name}`, () => comportamento(source, fixture));
    }
    const expected = Object.fromEntries(await Promise.all(fixtures.map(async fixture => [fixture.name, await snapshot(source, fixture.name)])));
    fs.writeFileSync(path.join(reportDir, 'catalogo-nativo-origine.json'), JSON.stringify(expected, null, 2));
    await check('default-reali-omessi', async () => {
      const info = await client.db(source).listCollections({ name: 'implicita' }).next();
      assert(!Object.hasOwn(info.options, 'validationLevel')); assert(!Object.hasOwn(info.options, 'validationAction'));
      const explicit = await client.db(source).listCollections({ name: 'esplicita' }).next();
      assert.equal(explicit.options.validationLevel, 'strict'); assert.equal(explicit.options.validationAction, 'error');
      assert.deepEqual(expected.implicita, expected.esplicita);
      assert.deepEqual(expected.nessuna, expected.vuota, 'Nessun validatore e validatore vuoto hanno lo stesso comportamento');
      return { implicita: info.options, esplicita: explicit.options };
    });
    const backup = await runBackup({ session: { strategy, dbType: 'mongodb' }, connName: 'validator', db: source,
      type: 'full', destRoot: path.join(reportDir, 'archivi'), compress: true, log: silenzioso });
    const target = registry.target('restore');
    const restored = await check('backup-restore', async () => {
      const result = await runRestoreViaPlan({ session: { strategy, dbType: 'mongodb' }, backupDir: backup.backupDir,
        targetDb: target, drop: true, connName: 'validator', recoveryRoot: path.join(reportDir, 'recovery'), log: silenzioso });
      report.operazioni.push({ target, result }); assert.equal(result.status, 'completato', JSON.stringify(result));
      return { status: result.status, coerenzaSchema: result.coerenzaSchema };
    });
    if (restored) for (const fixture of fixtures) await check(`backup-nativo-${fixture.name}`, async () => {
      assert.deepEqual(await snapshot(target, fixture.name), expected[fixture.name]); return comportamento(target, fixture);
    });
    const catalogo = await leggiCatalogoExport(strategy, 'mongodb', source);
    const exportPlan = creaPianoExport({ catalogo: { ...catalogo, db: source, dbType: 'mongodb' }, connection: 'validator', formato: 'codedb-json' });
    let content = '';
    await esportaDatabase({ strategy, plan: exportPlan, write: async part => { content += part; } });
    fs.writeFileSync(path.join(reportDir, 'export.codedb.json'), content);
    const artifact = JSON.parse(content), importedTarget = registry.target('import');
    const imported = await check('export-import', async () => {
      const { result } = await importazione(artifact, importedTarget);
      assert.equal(result.status, 'completato', JSON.stringify(result)); return { status: result.status };
    });
    if (imported) for (const fixture of fixtures) await check(`import-nativo-${fixture.name}`, async () => {
      assert.deepEqual(await snapshot(importedTarget, fixture.name), expected[fixture.name]); return comportamento(importedTarget, fixture);
    });
    for (const [label, changes] of [
      ['default-only', { validationLevel: 'strict', validationAction: 'error' }],
      ['validator-vuoto', { validator: {} }],
    ]) await check(`gate-equivalenza-${label}`, async () => {
      const isolated = copia(artifact), db = registry.target(`equivalente_${label.replace('-', '_')}`);
      isolated.collections = isolated.collections.filter(item => item.name === 'nessuna');
      isolated.objects.collectionOptions = [];
      let metadata;
      const { result } = await importazione(isolated, db, async stage => {
        await client.db(stage).command({ collMod: 'nessuna', ...changes });
        metadata = (await client.db(stage).listCollections({ name: 'nessuna' }).next()).options;
      });
      assert.equal(result.status, 'completato', 'Materializzare solo default non deve bloccare il piano: ' + JSON.stringify(result));
      assert.deepEqual(await snapshot(db, 'nessuna'), expected.nessuna);
      await comportamento(db, fixtures.find(item => item.name === 'nessuna'));
      return { status: result.status, metadata };
    });
    // Questi controlli non dipendono dal fix dei default: l'artefatto dichiara
    // entrambi i valori, poi il driver altera davvero lo staging prima del gate.
    const explicitArtifact = copia(artifact);
    const gateArtifacts = new Map();
    for (const collection of ['esplicita', 'letterale']) {
      const isolated = copia(explicitArtifact);
      isolated.collections = isolated.collections.filter(item => item.name === collection);
      isolated.objects.collectionOptions = isolated.objects.collectionOptions.filter(item => item.name === collection);
      gateArtifacts.set(collection, isolated);
      await check(`gate-controllo-${collection}`, async () => {
        const db = registry.target(`controllo_${collection}`), { result } = await importazione(isolated, db);
        assert.equal(result.status, 'completato', 'Il gemello non alterato deve passare prima di provare il gate: ' + JSON.stringify(result));
        assert.deepEqual(await snapshot(db, collection), expected[collection]);
        return { status: result.status, collection };
      });
    }
    for (const [label, collection, changes] of [
      ['validator', 'esplicita', { validator: { $jsonSchema: { required: ['campo_sbagliato'] } } }],
      ['livello', 'esplicita', { validationLevel: 'off' }],
      ['azione', 'esplicita', { validationAction: 'warn' }],
      ['literal', 'letterale', { validator: { annidato: { $eq: { b: 2, a: 1 } } } }],
    ]) await check(`gate-alterazione-${label}`, async () => {
      const db = registry.target(`alterato_${label}`), sentinella = { _id: 1, preservare: label };
      await client.db(db).collection('sentinella').insertOne(sentinella);
      let applied = 0;
      const { result, fasi } = await importazione(gateArtifacts.get(collection), db, async stage => {
        await client.db(stage).command({ collMod: collection, ...changes }); applied++;
        const current = (await client.db(stage).listCollections({ name: collection }).next()).options;
        for (const [key, value] of Object.entries(changes)) assert.deepEqual(current[key], value);
      });
      assert.equal(applied, 1, 'La mutazione deve avvenire dopo l’applicazione dei dati');
      assert.notEqual(result.status, 'completato', 'Il gate deve rilevare la perdita del vincolo');
      assert(result.verification?.objectMismatches?.some(text => text.startsWith('collectionOptions:')), JSON.stringify(result));
      assert(!fasi.some(evento => evento.phase === 'promozione'), 'Nessuna promozione dopo una divergenza effettiva');
      assert.deepEqual(await client.db(db).collection('sentinella').findOne({ _id: 1 }), sentinella);
      return { status: result.status, differenze: result.verification.objectMismatches, originalePreservato: true };
    });
    const { preparaCollectionMongo } = require('../../db/mongoCollectionOptions');
    const { codificaMetadati } = require('../../db/mongoSchemaBson');
    const existingDb = registry.target('opzioni_esistenti');
    for (const campo of Object.keys(tagLetterali)) for (const direction of ['literal_bson', 'bson_literal']) {
      await check(`esistente-${campo}-${direction}`, async () => {
        const name = `${campo}_${direction}`;
        const [before, after] = direction === 'literal_bson'
          ? [tagLetterali[campo], tagNativi[campo]] : [tagNativi[campo], tagLetterali[campo]];
        const database = client.db(existingDb), coll = database.collection(name);
        await database.createCollection(name, { validator: { valore: { $eq: before } } });
        const probe = async (allowed, denied) => {
          try {
            await coll.insertOne({ _id: 1, valore: allowed });
            await assert.rejects(coll.insertOne({ _id: 2, valore: denied }), error => error.code === 121,
              'Il tipo contrario deve essere rifiutato dal validatore nativo');
          } finally { await coll.deleteMany({ _id: { $in: [1, 2] } }); }
        };
        await probe(before, after);
        const options = { validator: { valore: { $eq: after } }, validationLevel: 'strict', validationAction: 'error' };
        const metadata = codificaMetadati({ name, options });
        await preparaCollectionMongo(client, existingDb, name, metadata.options, { metadata });
        const current = (await database.listCollections({ name }, { promoteValues: false }).next()).options;
        assert.deepEqual(serialize(current.validator), serialize(options.validator), 'collMod deve cambiare davvero il tipo del validatore');
        await probe(after, before);
        return { direzione: direction, tipo: campo, catalogoBsonCorretto: true, accettazioneInvertita: true };
      });
    }
  } catch (error) { report.erroreFatale = error.stack; console.error(error.stack); }
  finally {
    try {
      const owned = registry.targets();
      const ownerOf = name => {
        const suffix = /__codedb_(staging|recovery|recupero)_[a-f0-9]{10}$/.exec(name)?.[0];
        return suffix && owned.find(base => name === base.slice(0, 63 - suffix.length) + suffix);
      };
      const names = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map(db => db.name);
      for (const name of names) {
        const owner = ownerOf(name);
        if (owner) { registry.assertOwned(owner); await client.db(name).dropDatabase(); }
      }
      await registry.cleanup(db => client.db(db).dropDatabase());
      const remaining = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases
        .map(db => db.name).filter(name => owned.includes(name) || ownerOf(name));
      assert.deepEqual(remaining, [], 'Nessun database o staging della fixture deve rimanere');
      report.pulizia = 'completata';
    } catch (error) { report.errorePulizia = error.stack; }
    await client.close().catch(error => { report.erroreChiusura = error.message; });
    report.ok = !report.erroreFatale && !report.errorePulizia && !report.erroreChiusura && report.verifiche.length > 0 && report.verifiche.every(check => check.ok);
    report.terminato = new Date().toISOString();
    fs.writeFileSync(path.join(reportDir, 'backup-validator.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}
async function child(mutante) {
  const dir = path.join(reportDir, mutante ? `mutante-${mutante}` : 'controllo'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'backup-validator.json'); fs.rmSync(file, { force: true });
  const log = fs.createWriteStream(path.join(dir, 'console.log'));
  const exitCode = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [__filename, '--worker', ...(mutante ? [`--mutant-${mutante}`] : [])], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LAB_REPORT_DIR: dir } });
    inoltraOutputFiglio(proc, { log, mutante: mutante || null });
    proc.once('error', reject); proc.once('close', resolve);
  }).finally(() => new Promise(resolve => log.end(resolve)));
  return { exitCode, report: file, ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { ok: false, erroreFatale: 'Rapporto assente' }) };
}
async function main() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1', 'Serve CODEDB_E2E_DESTRUCTIVE=1');
  fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-validator', iniziato: new Date().toISOString(), controllo: await child(null), sensibilita: [] };
  const attesi = { default: ['backup-restore', 'export-import'], validator: ['gate-alterazione-validator', 'gate-alterazione-literal'],
    modi: ['gate-alterazione-livello', 'gate-alterazione-azione'],
    esistenti: ['re', 'long', 'oid'].flatMap(campo => ['literal_bson', 'bson_literal'].map(direction => `esistente-${campo}-${direction}`)) };
  if (process.argv.includes('--sensitivity')) for (const mutante of Object.keys(attesi)) {
    const result = await child(mutante), failures = result.verifiche.filter(item => !item.ok).map(item => item.id).sort();
    report.sensibilita.push({ mutante, result, rilevata: result.exitCode === 1 && result.mutazioni > 0 && result.pulizia === 'completata'
      && !result.erroreFatale && !result.errorePulizia && !result.erroreChiusura
      && JSON.stringify(failures) === JSON.stringify(attesi[mutante].sort()) });
  }
  report.ok = report.controllo.ok && report.controllo.exitCode === 0 && report.sensibilita.every(item => item.rilevata);
  report.totali = { verifiche: report.controllo.verifiche.length, fallite: report.controllo.verifiche.filter(item => !item.ok).length };
  report.terminato = new Date().toISOString();
  fs.writeFileSync(path.join(reportDir, 'backup-validator.json'), JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
(process.argv.includes('--worker') ? worker(process.argv.find(arg => arg.startsWith('--mutant-'))?.slice('--mutant-'.length)) : main())
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
