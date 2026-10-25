'use strict';

const fs = require('fs');
const { EJSON } = require('bson');
const { fileDelBackup } = require('./util');
const { normalizzaLayerBackup, estraiBersaglio } = require('../../db/artefatti');

/** Ogni file moderno è una fotografia completa, non un elenco di modifiche.
 * La fotografia vuota è significativa: l'ultimo oggetto è stato rimosso.
 * Nei backup precedenti l'assenza del file è ambigua, quindi si conserva
 * l'ultima fotografia disponibile dichiarando il limite, senza inventare dati. */
function risolviOggettiCatena(chain, { allowUnsafeSchema = false } = {}) {
  let objects = {}, db = chain[0]?.manifest.db, layerId = null;
  let complete = false;
  const indexes = Object.create(null), indexNames = Object.create(null);
  const managedSql = { triggers: [], indexes: [], foreignKeys: [] };
  const managedObjects = { views: [], routines: [], events: [] };
  const mysqlInline = new Map();
  const add = (kind, item) => {
    if (!managedSql[kind].some(value => value.name === item.name && value.table === item.table)) managedSql[kind].push(item);
  };
  let indiciCompleti = true;
  for (const layer of chain) {
    if (layer.manifest.dbType === 'mysql') {
      for (const schema of layer.manifest.files.filter(file => file.kind === 'schema')) {
        const text = fs.readFileSync(fileDelBackup(layer.dir, schema.path, 'file di schema'), 'utf8');
        if (schema.sha256 && require('crypto').createHash('sha256').update(text).digest('hex') !== schema.sha256) {
          throw new Error(`Il file di schema di "${schema.collection}" non corrisponde al checksum del manifest.`);
        }
        // Si valida la CREATE originale, prima di separare qualsiasi vincolo.
        normalizzaLayerBackup({ dbType: 'mysql', database: layer.manifest.db,
          schemas: [{ collection: schema.collection, database: layer.manifest.db, sql: text }] }, { allowUnsafeSchema });
        const foreignKeys = require('./engine').splitMySqlForeignKeys(text, schema.collection).foreignKeys;
        // Anche l'elenco vuoto sostituisce il precedente: una FK rimossa non
        // deve riapparire soltanto perché esisteva nel full storico.
        mysqlInline.set(schema.collection, foreignKeys);
        for (const sql of foreignKeys) {
          const target = estraiBersaglio(sql), name = target.tokens[target.table.next + 2];
          if (name?.type === 'identifier') add('foreignKeys', { name: name.value, table: schema.collection });
        }
      }
    }
    if (layer.manifest.dbType === 'mongodb') {
      const idxFiles = layer.manifest.files.filter(file => file.kind === 'indexes');
      const seen = new Set();
      for (const file of idxFiles) {
        if (file.mode != null && file.mode !== 'snapshot') throw new Error(`Modalità degli indici MongoDB non supportata: ${file.mode}.`);
        const name = file.collection;
        if (typeof name !== 'string' || !name || seen.has(name)) throw new Error('Inventario degli indici MongoDB malformato o duplicato.');
        seen.add(name);
        const specs = JSON.parse(fs.readFileSync(fileDelBackup(layer.dir, file.path, 'file degli indici'), 'utf8'));
        if (!Array.isArray(specs) || specs.some(index => !index || typeof index.name !== 'string' || !index.key || typeof index.key !== 'object' || Array.isArray(index.key))) {
          throw new Error(`Inventario degli indici MongoDB di "${name}" non valido.`);
        }
        for (const spec of specs) require('../../db/mongoSchemaBson').normalizzaMetadati(spec);
        indexes[name] = specs;
        indexNames[name] = [...new Set([...(indexNames[name] || []), ...specs.filter(index => index.name !== '_id_').map(index => index.name)])];
      }
      indiciCompleti = layer.manifest.files.filter(file => file.kind === 'data')
        .every(file => idxFiles.some(indexFile => indexFile.collection === file.collection && indexFile.mode === 'snapshot'));
    }
    const files = layer.manifest.files.filter(file => file.kind === 'objects');
    if (files.length > 1) throw new Error(`Il layer ${layer.manifest.id} contiene più fotografie degli oggetti.`);
    const file = files[0];
    complete = file?.mode === 'snapshot';
    if (!file) continue;
    if (file.mode != null && file.mode !== 'snapshot') throw new Error(`Modalità degli oggetti di schema non supportata: ${file.mode}.`);
    const objectText = fs.readFileSync(fileDelBackup(layer.dir, file.path, 'file di oggetti'), 'utf8');
    const input = layer.manifest.dbType === 'mongodb' ? JSON.parse(objectText) : EJSON.parse(objectText);
    objects = normalizzaLayerBackup({
      dbType: layer.manifest.dbType, database: layer.manifest.db, schemas: [],
      collections: layer.manifest.files.filter(item => item.kind === 'data').map(item => item.collection),
      objects: input,
    }, { allowUnsafeSchema }).objects || {};
    for (const kind of Object.keys(managedObjects)) for (const item of objects[kind] || []) {
      if (!managedObjects[kind].some(previous => previous.name === item.name && previous.ddl === item.ddl)) {
        managedObjects[kind].push({ ...item, sourceDb: layer.manifest.db });
      }
    }
    if (layer.manifest.dbType !== 'mongodb') {
      const nameOf = token => token.quoted || layer.manifest.dbType === 'mysql' ? token.value : token.value.toLowerCase();
      for (const item of objects.triggers || []) add('triggers', { name: item.name, table: item.table });
      for (const [kind, ddls] of [['indexes', objects.indexes || []], ['foreignKeys', objects.foreignKeys || []]]) {
        for (const ddl of ddls) {
          let target;
          try { target = estraiBersaglio(ddl); } catch (err) { if (!allowUnsafeSchema) throw err; continue; }
          if (kind === 'indexes' && target.kind === 'create-index') {
            add(kind, { name: nameOf(target.object.parts.at(-1)), table: nameOf(target.table.parts.at(-1)) });
          } else if (kind === 'foreignKeys' && target.kind === 'alter-table') {
            const constraint = target.tokens[target.table.next + 1];
            const name = target.tokens[target.table.next + 2];
            if (!constraint?.quoted && constraint?.value.toUpperCase() === 'CONSTRAINT' && name?.type === 'identifier') {
              add(kind, { name: nameOf(name), table: nameOf(target.table.parts.at(-1)) });
            }
          }
        }
      }
    }
    db = layer.manifest.db;
    layerId = layer.manifest.id;
  }
  if (chain[0]?.manifest.dbType === 'mysql') {
    const canonical = require('../../db/schemaObjects').canonicalSqlForDb;
    const seen = new Set();
    objects = { ...objects, foreignKeys: [...(objects.foreignKeys || []), ...[...mysqlInline.values()].flat()]
      .filter(sql => { const key = canonical(sql, db); if (seen.has(key)) return false; seen.add(key); return true; }) };
  }
  const note = [];
  if (!complete) note.push(layerId
    ? `Gli oggetti di schema usano l'ultima fotografia storica disponibile (${layerId}). L'ultimo layer non dichiara una fotografia completa: modifiche o rimozioni successive non sono verificabili.`
    : 'La catena storica non contiene una fotografia degli oggetti di schema: non è possibile distinguere uno schema senza oggetti da oggetti non salvati.');
  if (!indiciCompleti) note.push('Gli indici MongoDB usano gli ultimi elenchi disponibili: l’ultimo layer non dichiara una fotografia completa per ogni collection e le modifiche successive non sono verificabili.');
  complete = complete && indiciCompleti;
  return { objects, db, layerId, complete, nota: note.join(' ') || null, indexes, indexNames, managedSql, managedObjects };
}

function coerenzaOggetti(snapshot) {
  return { completa: snapshot.complete, layerId: snapshot.layerId, nota: snapshot.nota };
}

function equivalenzaConSchema(dati, snapshot) {
  return { ...dati, completa: dati.completa && snapshot.complete,
    motivo: [dati.motivo, snapshot.nota].filter(Boolean).join(' ') || null };
}

module.exports = { risolviOggettiCatena, coerenzaOggetti, equivalenzaConSchema };
