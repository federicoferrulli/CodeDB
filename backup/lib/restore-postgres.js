'use strict';

/* ---------------------------------------------------------------------------
 * Applicazione di un singolo layer di backup su PostgreSQL (schema effettivo,
 * prerequisiti di collation/tipi/sequenze/routine, Large Objects, riferimenti
 * reg*, tombstone tipizzati e batch tramite collectionImport).
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const { EJSON } = require('bson');
const { readLines, fileDelBackup } = require('./util');
const { quotaSempre } = require('../../db/identificatori');
const { leggiIdentitaPostgres, identityCompatibile } = require('./identity');
const { parseClientValue, toSqlValue } = require('../../db/sqlValori');
const {
  BATCH_SIZE, eliminaSePresente, registraFileAtteso, registraAttesa,
  assertColumnsAndIdentity, checkApplied, readSchemaFile,
} = require('./restore-catena');
const { riqualificaDdl, restoreSchemaObjects } = require('./restore-oggetti');

const pgQid = (name) => quotaSempre(name, 'postgresql');

async function pgExistingTables(strategy, targetSchema) {
  const res = await strategy.collectionAggregate(targetSchema, null, {
    pipeline: 'SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $$SCHEMA$$'
      .replace('$$SCHEMA$$', `'${String(targetSchema).replace(/'/g, "''")}'`),
    readOnly: true,
  });
  const rows = (res && (res.docs || res.rows)) || [];
  return new Set(rows.map((r) => r.tablename).filter(Boolean));
}

async function pgTargetIdentity(strategy, schema, table, expectedIdentity = null) {
  const pool = strategy.pool;
  const columns = (await require('../../db/pg-ddl').pgColonne((s, p) => pool.query(s, p), schema, table)).map((c) => ({
    name: c.name,
    type: c.ctype.toLowerCase(),
    cast: c.ctype,
    nullable: !c.notnull,
  }));
  const identities = await leggiIdentitaPostgres(
    (sql, params) => pool.query(sql, params), schema, table, columns,
  );
  return {
    columnSchema: columns,
    identity: identities.find((candidate) => identityCompatibile(expectedIdentity, candidate))
      || identities[0] || null,
  };
}

function pgTargetSchema(targetDb, layer, explicitTarget) {
  if (explicitTarget) return explicitTarget;
  const declared = (layer.manifest.files || []).find((f) => f.schema);
  if (declared) return declared.schema;
  return 'public';
}

async function restoreLayerPostgreSql({ strategy, targetDb, layer, isFirst, onlyCollections, drop, log, problems, opts, explicitTarget, tracker }) {
  const dataFiles = layer.manifest.files.filter(
    (f) => f.kind === 'data' && (!onlyCollections || onlyCollections.includes(f.collection))
  );
  targetDb = pgTargetSchema(targetDb, layer, explicitTarget);
  const nuovi = dataFiles.filter(f=>!tracker.has(f.collection));
  if (isFirst) await strategy.pool.query(`CREATE SCHEMA IF NOT EXISTS ${pgQid(targetDb)}`);
  if (onlyCollections && (isFirst || nuovi.length)) {
    const sourceDdl = opts.ddlSelezionate ?? require('../../db/pg-routine-selezione').ddlSelettiveBackup([layer],onlyCollections,opts);
      opts.selectedRoutines = await require('../../db/pg-routine-selezione').routineSelettivePg({
        query: (sql, params) => strategy.pool.query(sql, params), targetDb, collections: onlyCollections,
        objects: opts.schemaSnapshot.objects, ddl: sourceDdl,
        references: opts.routineReferences,
      });
  }
  if (isFirst) {
      // Una DROP elimina anche le sequenze possedute. Si sostituiscono prima
      // tutte le tabelle della catena, comprese quelle introdotte da un delta.
      if (drop) for (const table of opts.tabelleDaSostituire) {
        await eliminaSePresente(() => strategy.dropCollection(targetDb, table), {
          dbType: 'postgresql', target: `${targetDb}.${table}`,
        });
      }
      const objects = opts.schemaSnapshot.objects;
      const sequences = (objects.sequences || []).filter(s => !onlyCollections || onlyCollections.includes(s.ownerTable));
      // Dopo la DROP una sequenza posseduta dalla tabella non esiste più.
      // Un'omonima superstite appartiene alla destinazione: IF NOT EXISTS
      // la riuserebbe e OWNED BY ne cambierebbe proprietario e contatore.
      const possedute = sequences.filter(s => s.ownerTable).map(s => s.name);
      if (drop && possedute.length) {
        const { rows } = await strategy.pool.query(`SELECT s.relname FROM pg_catalog.pg_class s
          JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace
          WHERE n.nspname=$1 AND s.relname=ANY($2::text[]) LIMIT 1`, [targetDb, possedute]);
        if (rows.length) throw new Error(`La sequenza "${rows[0].relname}" coincide con una relazione estranea alle tabelle da sostituire.`);
      }
      await require('../../db/pg-types').checkExtensions(strategy, objects.extensions);
      await restoreSchemaObjects({ strategy, targetDb, dbType: 'postgresql',
        oggetti: { collations: objects.collations, types: objects.types, typeRoutines: opts.selectedRoutines || objects.routines, sequences: sequences.map(({ ownerTable, ownerColumn, ...s }) => s) },
        dbOrigine: opts.schemaSnapshot.db, problems, log, allowUnsafeSchema: opts.allowUnsafeSchema, applied: opts.appliedObjects });
      if (problems.length) throw new Error(problems.join('; '));
  }
  log.info(`  Schema di destinazione PostgreSQL: ${targetDb}`);
  let total = 0;
  let existingTables = null;
  if (nuovi.length) {
    existingTables = await pgExistingTables(strategy, targetDb).catch((err) => {
      log.error(`  Impossibile elencare le tabelle di "${targetDb}": ${err.message}`);
      return null;
    });
  }
  for (const f of nuovi) {
      const standalone = f.partitionParent && onlyCollections && !onlyCollections.includes(f.partitionParent) && !existingTables?.has(f.partitionParent);
      const kind = standalone ? 'schema-standalone' : 'schema';
      const schemaFile = layer.manifest.files.find(x => x.kind === kind && x.collection === f.collection);
      if (!schemaFile && !existingTables?.has(f.collection)) throw new Error('Schema di "'+f.collection+'" assente dal backup: impossibile ricreare la tabella.');
      const mustCreate = schemaFile && (!existingTables || !existingTables.has(f.collection));
      if (mustCreate) {
        const sql = riqualificaDdl(readSchemaFile(layer.dir, schemaFile, f.collection, {
          ...opts, dbType: 'postgresql', database: layer.manifest.db,
        }), layer.manifest.db, targetDb, 'postgresql');
        try {
          await strategy.collectionAggregate(targetDb, f.collection, { pipeline: sql });
          if (existingTables) existingTables.add(f.collection);
        } catch (err) {
          throw new Error(
            `Impossibile ricreare la tabella "${f.collection}" in "${targetDb}": ${err.message}`
          );
        }
      }
  }
  if (isFirst || nuovi.length) {
    const objects = opts.schemaSnapshot.objects;
    await restoreSchemaObjects({
      strategy, targetDb, dbType: 'postgresql',
      oggetti: { routines: opts.selectedRoutines || objects.routines },
      dbOrigine: opts.schemaSnapshot.db, problems: [], log,
      allowUnsafeSchema: opts.allowUnsafeSchema, applied: opts.appliedObjects,
    });
  }
  if (dataFiles.some(f=>f.pgPhysical)) {
    const catalogo = await require('../../db/pg-partizioni').catalogoPartizioni((s,p)=>strategy.pool.query(s,p),targetDb);
    const canonica = require('../../db/schemaObjects').canonicalSqlForDb;
    for (const f of dataFiles.filter(f=>f.pgPhysical)) {
      const actual = catalogo.get(f.collection);
      const parent = f.partitionParent && (!onlyCollections || onlyCollections.includes(f.partitionParent) || existingTables?.has(f.partitionParent)) ? f.partitionParent : null;
      if ((actual?.parent || null) !== parent
          || canonica(actual?.key,targetDb) !== canonica(f.partitionKey,layer.manifest.db)
          || (parent && canonica(actual?.bound,targetDb) !== canonica(f.partitionBound,layer.manifest.db))) {
        throw new Error('La struttura delle partizioni di "'+f.collection+'" diverge dal backup.');
      }
    }
  }
  const referenceShapes = new Map();
  let wantedLargeObjects = null;
  if (onlyCollections) {
    wantedLargeObjects = new Set();
    opts.largeObjectReferences ||= new Map();
    for (const f of dataFiles) {
      const shape = await require('../../db/pg-references').columnReferences((s, p) => strategy.pool.query(s, p), targetDb, f.collection);
      referenceShapes.set(f.collection, shape);
      // Senza colonne OID/Large Object la tabella non può riferire alcun LO:
      // evitare di scansionare il file e di accumulare una Map di Set vuoti in RAM.
      if (!shape.length) continue;
      if (f.mode === 'full' || !opts.largeObjectReferences.has(f.collection)) opts.largeObjectReferences.set(f.collection, new Map());
      const state = opts.largeObjectReferences.get(f.collection);
      const tombstone = layer.manifest.files.find(file => file.kind === 'tombstones' && file.collection === f.collection);
      if (tombstone) for await (const line of readLines(fileDelBackup(layer.dir, tombstone.path))) {
        state.delete(require('./content-state').chiaveRiga(parseClientValue(line), f));
      }
      let ordinal = 0;
      for await (const line of readLines(fileDelBackup(layer.dir, f.path, 'riferimenti Large Objects'))) {
        const row = parseClientValue(line), ids = new Set();
        require('../../db/pg-references').rowReferences(row, shape, id => { ids.add(id); return id; });
        const key = f.identity ? require('./content-state').chiaveRiga(row, f) : ordinal++;
        if (ids.size) state.set(key, ids);
        else state.delete(key);
      }
    }
    for (const state of opts.largeObjectReferences.values()) for (const ids of state.values()) for (const id of ids) wantedLargeObjects.add(id);
  }
  for (const file of layer.manifest.files.filter(f => f.kind === 'large-objects')) {
    const objects = JSON.parse(fs.readFileSync(fileDelBackup(layer.dir, file.path, 'Large Objects'), 'utf8'));
    const map = await require('../../db/pg-references').importLargeObjects(strategy.pool, objects.filter(o => !wantedLargeObjects || wantedLargeObjects.has(o.oid)), opts.largeObjectMap);
    for (const [id, value] of map) opts.largeObjectMap.set(id, value);
  }
  const largeFiles = layer.manifest.files.filter(f => f.kind === 'large-object' && (!wantedLargeObjects || wantedLargeObjects.has(f.oid))).map(f => ({ ...f, path: fileDelBackup(layer.dir, f.path, 'Large Object') }));
  if (largeFiles.length) {
    const map = await require('../../db/pg-references').importLargeObjectFiles(strategy.pool, largeFiles, opts.largeObjectMap);
    for (const [id, value] of map) opts.largeObjectMap.set(id, value);
  }
  for (const f of dataFiles) {
    const primaApparizione = !tracker.has(f.collection);
    const only = f.pgPhysical ? 'ONLY ' : '';
    registraFileAtteso(tracker, f);
    const references = referenceShapes.get(f.collection) || await require('../../db/pg-references').columnReferences((s, p) => strategy.pool.query(s, p), targetDb, f.collection);
    const rewrite = row => require('../../db/pg-references').rowReferences(row, references, id => opts.largeObjectMap.get(id) || id,
      (value, node) => node.type === 'regnamespace' && [layer.manifest.db, pgQid(layer.manifest.db)].includes(value) ? pgQid(targetDb) : riqualificaDdl(value, layer.manifest.db, targetDb, 'postgresql'));
    const targetMeta = await pgTargetIdentity(strategy, targetDb, f.collection, f.identity);
    let empty = false;
    if (!f.identity) {
      if (!primaApparizione && f.mode === 'full' && f.content?.mode === 'snapshot') {
        const metadata = { ...f, columnSchema: f.columnSchema?.map(c => ({ ...c, type: riqualificaDdl(c.type, layer.manifest.db, targetDb, 'postgresql') })) };
        assertColumnsAndIdentity(metadata, targetMeta.columnSchema, targetMeta.identity, { empty: true });
        await strategy.pool.query(`DELETE FROM ${only}${pgQid(targetDb)}.${pgQid(f.collection)}`);
      }
      const res = await strategy.pool.query(
        `SELECT NOT EXISTS(SELECT 1 FROM ${only}${pgQid(targetDb)}.${pgQid(f.collection)} LIMIT 1) AS empty`,
      );
      empty = !!res.rows[0].empty;
    }
    const expectedMeta = { ...f, columnSchema: f.columnSchema?.map(c => ({ ...c, type: riqualificaDdl(c.type, layer.manifest.db, targetDb, 'postgresql') })) };
    assertColumnsAndIdentity(expectedMeta, targetMeta.columnSchema, targetMeta.identity, { empty });
    const eliminazioni = layer.manifest.files.find((x) => x.kind === 'tombstones' && x.collection === f.collection);
    if (!isFirst && eliminazioni) {
      const columnTypes = new Map(targetMeta.columnSchema.map(column => [column.name, column]));
      for await (const line of readLines(fileDelBackup(layer.dir, eliminazioni.path, 'file di cancellazioni'))) {
        const id = rewrite(EJSON.parse(line, { relaxed: false }));
        await require('../../db/pg-alias').resolveNested((sql, params) => strategy.pool.query(sql, params), [id], references);
        const params = [];
        const whereDelete = f.identity.columns.map(c => {
          const column = columnTypes.get(c), value = id[c];
          const reference = value?.$pgReference && value.$pgReference.kind === column.type
            ? require('../../db/pg-alias').binding(value) : null;
          params.push(reference ? reference.param : (f.binarie || []).includes(c) && typeof value === 'string' ? Buffer.from(value, 'hex') : toSqlValue(value));
          const placeholder = `$${params.length}`;
          return `${pgQid(c)} = ${reference ? reference.sql.replace('$1', placeholder) : `${placeholder}::${column.cast}`}`;
        }).join(' AND ');
        await strategy.pool.query(
          `DELETE FROM ${only}${pgQid(targetDb)}.${pgQid(f.collection)} WHERE ${whereDelete}`,
          params,
        );
      }
    }
    let batch = [];
    let applied = 0;
    let failed = 0;
    const firstErrors = [];
    const flush = async () => {
      if (!batch.length) return;
      const imp = await strategy.collectionImport(targetDb, f.collection, {
        docs: batch,
        upsert: !!f.identity && (!primaApparizione || !drop),
        conflictColumns: f.identity ? f.identity.columns : undefined,
      });
      applied += imp.inserted;
      failed += imp.failed || 0;
      for (const e of (imp.errors || [])) {
        if (firstErrors.length < 3) firstErrors.push(typeof e === 'string' ? e : (e.error || JSON.stringify(e)));
      }
      batch = [];
    };
    const binarie = Array.isArray(f.binarie) ? f.binarie : [];
    for await (const line of readLines(fileDelBackup(layer.dir, f.path, 'file di dati'))) {
      let riga;
      try {
        riga = rewrite(parseClientValue(line));
      } catch (err) {
        failed += 1;
        if (firstErrors.length < 3) firstErrors.push(`riga non leggibile: ${err.message}`);
        continue;
      }
      for (const col of binarie) {
        if (typeof riga[col] === 'string') riga[col] = { $binary: { base64: Buffer.from(riga[col], 'hex').toString('base64'), subType: '00' } };
      }
      registraAttesa(tracker, f);
      batch.push(riga);
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    total += applied;
    log.info(`  ${f.collection}: ${applied} righe applicate (layer ${layer.manifest.id}, ${!isFirst || (!drop && f.identity) ? 'UPSERT' : 'INSERT'}).`);
    if (failed) log.error(`  ${f.collection}: ${failed} righe NON applicate. Primi errori: ${firstErrors.join(' | ')}`);
    checkApplied(problems, layer, f, applied, failed ? `${failed} righe rifiutate (${firstErrors.join(' | ')})` : null);
  }
  return total;
}

module.exports = {
  pgExistingTables,
  pgTargetIdentity,
  pgTargetSchema,
  restoreLayerPostgreSql,
};
