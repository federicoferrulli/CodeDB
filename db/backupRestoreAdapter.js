'use strict';

const path = require('path');
const fs = require('fs');
const { EJSON } = require('bson');
const { canonicaIdentificatori } = require('./pg-schema-compare');
const { resolveChain, preflightChain, runRestore, cardinalitaDestinazione } = require('../backup/lib/restore');
const { createImportArtifactAdapter } = require('./importArtifactAdapter');
const { riqualificaDdl } = require('../backup/lib/restore');
const { equivalenzaCatena } = require('../backup/lib/tombstones');
const { risolviOggettiCatena, coerenzaOggetti, equivalenzaConSchema } = require('../backup/lib/schema-snapshot');
const {
  readSchemaObjects, canonicalSql, canonicalSqlForDb, canonicalSchemaInventory,
  canonicalMongoIndex, inventoryDifferences,
} = require('./schemaObjects');

function descriviBackup(backupDir, onlyCollections = null, { allowUnsafeSchema = false } = {}) {
  const resolved = path.resolve(backupDir);
  const chain = resolveChain(resolved);
  const first = chain[0].manifest;
  const schemaSnapshot = risolviOggettiCatena(chain, { allowUnsafeSchema });
  const selected = onlyCollections ? new Set(onlyCollections) : null;
  const latest = new Map();
  for (const layer of chain) {
    for (const file of layer.manifest.files.filter((item) => item.kind === 'data')) {
      if (!selected || selected.has(file.collection)) latest.set(file.collection, file);
    }
  }
  if (selected) {
    for (const name of selected) if (!latest.has(name)) throw new Error(`Collection/tabella "${name}" non presente nel backup.`);
  }
  return {
    kind: 'backup-chain', backupDir: resolved, dbType: first.dbType,
    sourceDb: first.db, onlyCollections: onlyCollections || null,
    equivalenzaDati: equivalenzaCatena(chain),
    equivalenza: equivalenzaConSchema(equivalenzaCatena(chain), schemaSnapshot),
    coerenzaSchema: coerenzaOggetti(schemaSnapshot),
    layers: chain.map(({ manifest }) => ({
      id: manifest.id, type: manifest.type,
      manifestSha256: manifest.files.map((file) => file.sha256 || null),
    })),
    collections: [...latest].map(([name, file]) => ({
      name, rows: file.replayCardinality ?? file.sourceCardinality ?? file.count,
      sourceRows: file.sourceCardinality ?? file.count,
      identity: file.identity || null, schemaObjects: 0,
    })),
  };
}

function createBackupRestoreAdapter({ strategy, dbType, connName, recoveryRoot, log, signal = null }) {
  const primaryStrategy = strategy;
  const type = dbType === 'postgres' ? 'postgresql' : dbType;
  const shell = createImportArtifactAdapter({ strategy, dbType: type, connName, recoveryRoot, log, signal });
  let activeSignal = signal;
  let snapshot = null;
  let expectedSchema = null;
  let destinationBaseline = null;
  let selectedBaseline = null;
  let identities = new Map();
  // La capacità di rimuovere oggetti superati appartiene soltanto allo staging
  // creato da questo adapter e coperto da una copia di recupero verificata.
  // Un nome tecnico o un booleano ricevuto dal chiamante non la conferiscono.
  const stagingPosseduti = new WeakMap();

  function retargetObjects(objects, sourceDb, targetDb) {
    const copy = type === 'mongodb' ? EJSON.serialize(objects || {}, { relaxed: false })
      : JSON.parse(JSON.stringify(objects || {}));
    for (const values of Object.values(copy)) {
      if (!Array.isArray(values)) continue;
      for (let i = 0; i < values.length; i++) {
        if (typeof values[i] === 'string') values[i] = riqualificaDdl(values[i], sourceDb, targetDb, type);
        else if (values[i] && typeof values[i] === 'object') {
          if (values[i].ddl) values[i].ddl = riqualificaDdl(values[i].ddl, sourceDb, targetDb, type);
          if (values[i].sql) values[i].sql = riqualificaDdl(values[i].sql, sourceDb, targetDb, type);
        }
      }
    }
    return copy;
  }

  function senzaQualificatoreLocale(sql, db) {
    // Il catalogo può omettere lo schema corrente. Si normalizzano soltanto
    // identificatori reali, mai il testo di stringhe, commenti o corpi dollar.
    const text = String(sql), chunks = [];
    let i = 0;
    while (i < text.length) {
      const start = i, c = text[i];
      const dollar = c === '$' && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (dollar) {
        const end = text.indexOf(dollar[0], i + dollar[0].length);
        i = end < 0 ? text.length : end + dollar[0].length;
        chunks.push(text.slice(start, i)); continue;
      }
      if (c === "'") {
        i++;
        while (i < text.length) {
          if (text[i] === '\\') { i += 2; continue; }
          if (text[i++] === "'") { if (text[i] === "'") { i++; continue; } break; }
        }
        chunks.push(text.slice(start, i)); continue;
      }
      if (text.startsWith('--', i) || text.startsWith('/*', i)) {
        const block = text.startsWith('/*', i);
        const end = text.indexOf(block ? '*/' : '\n', i + 2);
        i = end < 0 ? text.length : end + (block ? 2 : 1);
        chunks.push(text.slice(start, i)); continue;
      }
      let name = null, quoted = false;
      if (c === '"' || c === '`') {
        quoted = true; name = ''; i++;
        while (i < text.length) {
          if (text[i] === c) { if (text[i + 1] === c) { name += c; i += 2; continue; } i++; break; }
          name += text[i++];
        }
      } else if (/[\p{L}_]/u.test(c)) {
        i++;
        while (i < text.length && /[\p{L}\p{N}_$]/u.test(text[i])) i++;
        name = text.slice(start, i);
      } else { chunks.push(c); i++; continue; }
      let next = i;
      while (/\s/.test(text[next] || '')) next++;
      if ((quoted ? name === db : name === db || type === 'postgresql' && name.toLowerCase() === db)
        && text[next] === '.') i = next + 1;
      else chunks.push(text.slice(start, i));
    }
    return chunks.join('');
  }

  async function sospendiDipendenzeSelettive(plan, staging) {
    if (type === 'mongodb' || !plan.drop || !plan.source.onlyCollections) return;
    const ownership = stagingPosseduti.get(staging);
    if (!ownership || ownership.db !== staging.db || ownership.fingerprint !== plan.fingerprint) return;
    const quota = name => require('./identificatori').quotaSempre(name, type);
    const selected = new Set(plan.source.onlyCollections);
    const views = (await readSchemaObjects(strategy, type, staging.db)).views || [];
    const foreignKeys = [];
    for (const item of await strategy.listCollections(staging.db)) {
      if (item.type === 'view' || selected.has(item.name)) continue;
      for (const sql of (await strategy.tableAuxDdl(staging.db, item.name)).foreignKeys || []) {
        const target = require('./artefatti').estraiBersaglio(sql);
        const name = target.tokens[target.table.next + 2];
        if (!name || name.type !== 'identifier') throw new Error('Nome del vincolo locale non verificabile.');
        foreignKeys.push({ sql, table: item.name, name: name.value });
      }
    }
    // Solo lo staging posseduto, mai CASCADE. Le definizioni locali sono state
    // congelate anche nell'inventario atteso: ripristinarle è obbligatorio.
    for (const key of foreignKeys) await strategy.collectionAggregate(staging.db, null, {
      pipeline: `ALTER TABLE ${quota(staging.db)}.${quota(key.table)} DROP ${type === 'mysql' ? 'FOREIGN KEY' : 'CONSTRAINT'} ${quota(key.name)}`,
    });
    let pending = [...views];
    while (pending.length) {
      const failed = [];
      for (const view of pending) {
        try { await strategy.collectionAggregate(staging.db, null, {
          pipeline: `DROP ${view.materialized ? 'MATERIALIZED ' : ''}VIEW ${quota(staging.db)}.${quota(view.name)}`,
        }); } catch (error) { failed.push({ ...view, error }); }
      }
      if (failed.length === pending.length) throw new Error('Dipendenze dello staging non separabili: ' + failed.map(v => v.error.message).join('; '));
      pending = failed;
    }
    return async () => {
      const problems = [];
      await require('../backup/lib/restore').restoreSchemaObjects({ strategy, targetDb: staging.db, dbType: type,
        dbOrigine: staging.db, oggetti: { views, foreignKeys: foreignKeys.map(key => key.sql) }, problems, log });
      if (problems.length) throw new Error('Ripristino delle dipendenze locali incompleto: ' + problems.join('; '));
    };
  }

  async function preparaRimozioneOggettiSuperati(plan, staging) {
    const ownership = stagingPosseduti.get(staging);
    if (!ownership || ownership.fingerprint !== plan.fingerprint || ownership.db !== staging.db
      || staging.db === plan.targetDb || plan.drop || plan.source.onlyCollections) return;
    const resolved = risolviOggettiCatena(resolveChain(plan.source.backupDir), { allowUnsafeSchema: plan.allowUnsafeSchema === true });
    if (!resolved.complete) return;
    // Le nuove definizioni vanno applicate prima di distinguere le firme
    // sopravvissute da quelle obsolete: il solo nome non identifica un overload.
    return async () => {
    const current = await readSchemaObjects(strategy, type, staging.db);
    const candidates = [];
    const normalized = (item, sourceDb) => {
      const { sourceDb: _origin, ...definition } = item;
      if (type === 'mongodb') return canonicalSchemaInventory({ views: [definition] }).views[0];
      const ddl = type === 'mysql' ? require('../backup/lib/restore').senzaDefiner(item.ddl) : item.ddl;
      return canonicalSql(senzaQualificatoreLocale(riqualificaDdl(ddl, sourceDb, staging.db, type), staging.db));
    };
    for (const kind of ['views', 'routines', 'events']) {
      const finalNames = new Set((resolved.objects[kind] || []).map(item => item.name));
      const managed = resolved.managedObjects[kind];
      for (const item of current[kind] || []) {
        const retained = type === 'postgresql' && kind === 'routines'
          ? (resolved.objects.routines || []).some(final => final.name === item.name
            && normalized(final, resolved.db) === normalized(item, staging.db))
          : finalNames.has(item.name);
        if (retained || !managed.some(previous => previous.name === item.name)) continue;
        // La verifica completa precede le rimozioni: un omonimo modificato
        // indipendentemente non viene scambiato per l'oggetto del backup.
        const actual = normalized(item, staging.db);
        if (!managed.some(previous => previous.name === item.name && normalized(previous, previous.sourceDb) === actual)) {
          throw new Error(`L'oggetto "${item.name}" nella destinazione ha una definizione diversa dalla catena: il merge conserva la destinazione e non lo elimina.`);
        }
        candidates.push({ kind, item });
      }
    }
    if (!candidates.length) return;
    const quota = name => require('./identificatori').quotaSempre(name, type);
    let pgRoutines = [];
    if (type === 'postgresql' && candidates.some(candidate => candidate.kind === 'routines')) {
      pgRoutines = (await strategy.pool.query(`SELECT p.proname AS name, p.prokind AS kind,
        pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
        pg_catalog.pg_get_functiondef(p.oid) AS ddl
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=$1 AND p.prokind IN ('f','p')`, [staging.db])).rows;
    }
    // Le viste finali hanno già smesso di dipendere dalle routine superate.
      const latest = await readSchemaObjects(strategy, type, staging.db);
      for (const { kind, item } of candidates) {
        if (!(latest[kind] || []).some(currentItem => currentItem.name === item.name
          && normalized(currentItem, staging.db) === normalized(item, staging.db))) {
          throw new Error(`L'oggetto "${item.name}" è cambiato nello staging durante il ripristino: rimozione annullata.`);
        }
      }
      let pending = candidates;
      while (pending.length) {
      const failed = [];
      for (const candidate of pending) {
        const { kind, item } = candidate;
        try {
          if (type === 'mongodb') await strategy.client.db(staging.db).collection(item.name).drop();
          else {
            let target;
            if (kind === 'views') target = `${type === 'postgresql' && /^\s*CREATE\s+MATERIALIZED\s+VIEW/i.test(item.ddl) ? 'MATERIALIZED ' : ''}VIEW ${quota(staging.db)}.${quota(item.name)}`;
            else if (kind === 'events') target = `EVENT ${quota(staging.db)}.${quota(item.name)}`;
            else if (type === 'postgresql') {
              const native = pgRoutines.find(routine => routine.name === item.name
                && canonicalSql(routine.ddl) === canonicalSql(item.ddl));
              if (!native) throw new Error(`Firma nativa di "${item.name}" non verificabile.`);
              target = `${native.kind === 'p' ? 'PROCEDURE' : 'FUNCTION'} ${quota(staging.db)}.${quota(item.name)}(${native.args})`;
            } else target = `${item.type === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION'} ${quota(staging.db)}.${quota(item.name)}`;
            await strategy.collectionAggregate(staging.db, null, { pipeline: `DROP ${target}` });
          }
        } catch (error) { failed.push({ ...candidate, error }); }
      }
      if (failed.length === pending.length) throw new Error(`Oggetti superati non rimovibili nello staging: ${failed.map(candidate => `${candidate.item.name}: ${candidate.error.message}`).join('; ')}`);
        pending = failed;
      }
    };
  }

  async function expectedSchemaOf(plan, stagingDb) {
    const chain = resolveChain(plan.source.backupDir);
    const schemaSnapshot = risolviOggettiCatena(chain, { allowUnsafeSchema: plan.allowUnsafeSchema === true });
    const objects = schemaSnapshot.objects;
    const indexes = Object.create(null);
    if (type === 'mongodb') {
      for (const [name, specs] of Object.entries(schemaSnapshot.indexes)) {
        if (!plan.source.onlyCollections || plan.source.onlyCollections.includes(name)) {
          indexes[name] = specs.filter(index => index.name !== '_id_').map(canonicalMongoIndex).sort();
        }
      }
    }
    const tables = Object.create(null);
    for (const layer of chain) {
      for (const file of layer.manifest.files) {
        const absolute = path.join(layer.dir, file.path);
        if (file.kind === 'schema' && (!plan.source.onlyCollections || plan.source.onlyCollections.includes(file.collection))) {
          const ddl = riqualificaDdl(fs.readFileSync(absolute, 'utf8'), plan.sourceDb, stagingDb, type);
          tables[file.collection] = type === 'mysql' ? require('./mysql-ddl').canonicalMySqlTableDdl(
            require('../backup/lib/engine').splitMySqlForeignKeys(ddl, file.collection).ddl, stagingDb)
            : canonicaIdentificatori(canonicalSqlForDb(ddl, stagingDb));
        }
      }
    }
    const retargeted = retargetObjects(objects, plan.sourceDb, stagingDb);
    if (type !== 'mongodb') {
      const belongs = sql => {
        if (!plan.source.onlyCollections) return true;
        const target = require('./artefatti').estraiBersaglio(sql).table.parts.at(-1);
        return plan.source.onlyCollections.includes(target.quoted || type === 'mysql' ? target.value : target.value.toLowerCase());
      };
      indexes.__all = [...new Set([...(retargeted.indexes || []), ...(retargeted.foreignKeys || [])].filter(belongs)
        .map((sql) => canonicalSqlForDb(sql, stagingDb)))].sort();
      delete retargeted.foreignKeys;
      delete retargeted.indexes;
    }
    const incoming = { objects: canonicalSchemaInventory(retargeted, { db: stagingDb }), indexes, tables };
    if (!plan.drop && type !== 'mongodb' && destinationBaseline) {
      for (const name of Object.keys(tables)) {
        tables[name] = require('./schema-merge').schemaMergeConColonneLocali(tables[name], destinationBaseline.schema.tables[name]);
      }
    }
    if (!plan.source.onlyCollections) return incoming;
    // La selezione possiede tabelle e relativi ausiliari, non tutte le viste
    // o routine che le leggono. La base viene letta PRIMA di creare lo staging.
    const base = destinationBaseline?.schema || { objects: canonicalSchemaInventory({}), indexes: {}, tables: {} };
    const selected = new Set(plan.source.onlyCollections);
    const selectedRoutineNames = new Set(type === 'postgresql' ? (await require('./pg-routine-selezione').routineSelettivePg({
      query: (sql, params) => strategy.pool.query(sql, params), targetDb: plan.targetDb,
      collections: plan.source.onlyCollections, objects,
      references: await require('./pg-routine-selezione').riferimentiRoutineBackup(chain, plan.source.onlyCollections),
      ddl: chain[0].manifest.files.filter(file => file.kind === 'schema' && selected.has(file.collection))
        .map(file => fs.readFileSync(path.join(chain[0].dir, file.path), 'utf8')).join('\n'),
    })).map(item => item.name) : []);
    const owned = (field, value) => {
      if (field === 'routines' && type === 'postgresql') return selectedRoutineNames.has(JSON.parse(value).name);
      if (!['collectionOptions', 'triggers', 'sequences', 'sequenceValues'].includes(field)) return false;
      const item = JSON.parse(value);
      if (field === 'collectionOptions') return selected.has(item.name);
      if (field === 'triggers') return selected.has(item.table);
      if (field === 'sequences') return selected.has(item.ownerTable);
      if (field === 'sequenceValues') {
        return [...(base.objects.sequences || []), ...(incoming.objects.sequences || [])]
          .some(sequence => { const s = JSON.parse(sequence); return s.name === item.name && selected.has(s.ownerTable); });
      }
      return false;
    };
    const projectedObjects = {};
    for (const field of Object.keys(incoming.objects)) {
      projectedObjects[field] = [...(base.objects[field] || []).filter(value => !owned(field, value)),
        ...(incoming.objects[field] || []).filter(value => owned(field, value))].sort();
      // I prerequisiti condivisi assenti vengono creati dal pre-caricamento
      // PostgreSQL anche nel selettivo. Il catalogo atteso deve includerli a
      // partire dal manifest, senza apprenderli dall'esito dell'applicazione.
      // Gli omonimi locali restano soggetti al confronto di compatibilità.
      if (type === 'postgresql' && ['types', 'routines', 'collations', 'extensions'].includes(field)) {
        const present = new Set((base.objects[field] || []).map(value => JSON.parse(value).name));
        projectedObjects[field].push(...(incoming.objects[field] || []).filter(value => !owned(field, value) && !present.has(JSON.parse(value).name)));
        projectedObjects[field].sort();
      }
    }
    const mergedIndexes = { ...base.indexes, ...indexes };
    if (type !== 'mongodb') {
      const replaced = new Set(selectedBaseline?.indexes.__all || []);
      mergedIndexes.__all = [...new Set([...(base.indexes.__all || []).filter(sql => !replaced.has(sql)), ...indexes.__all])].sort();
    }
    return { objects: projectedObjects, indexes: mergedIndexes, tables: { ...base.tables, ...tables } };
  }

  async function schemaOf(db, plannedCollections, strategy = primaryStrategy) {
    const result = {
      objects: canonicalSchemaInventory(await readSchemaObjects(strategy, type, db), { db }),
      indexes: Object.create(null), tables: Object.create(null),
    };
    const sqlAux = [];
    for (const collection of plannedCollections) {
      if (type === 'mongodb') {
        // Senza questo metodo il lato REALE del confronto resterebbe vuoto e
        // ogni indice atteso risulterebbe mancante: una divergenza inventata,
        // non misurata. Finche' era un `typeof ... === 'function'` opzionale, e
        // `MongoDbStrategy` non lo implementava, ogni ripristino di un database
        // con un indice falliva la verifica dello staging.
        if (typeof strategy.indexList !== 'function') {
          throw new Error(`La strategia ${type} non espone indexList: gli indici non sono verificabili.`);
        }
        result.indexes[collection.name] = (await strategy.indexList(db, collection.name, { schemaBson: true }))
          .filter((index) => index.name !== '_id_').map(canonicalMongoIndex).sort();
      } else if (type !== 'mongodb' && typeof strategy.tableAuxDdl === 'function') {
        const aux = await strategy.tableAuxDdl(db, collection.name);
        sqlAux.push(...(type === 'mysql' ? [] : (aux.indexes || [])), ...(aux.foreignKeys || []));
      }
      if (type !== 'mongodb' && typeof strategy.tableDdl === 'function') {
        const ddl = await strategy.tableDdl(db, collection.name);
        result.tables[collection.name] = type === 'mysql' ? require('./mysql-ddl').canonicalMySqlTableDdl(
          require('../backup/lib/engine').splitMySqlForeignKeys(ddl, collection.name).ddl, db)
          : canonicaIdentificatori(canonicalSqlForDb(ddl, db));
      }
    }
    if (type !== 'mongodb') result.indexes.__all = sqlAux.map((sql) => canonicalSqlForDb(sql, db)).sort();
    return result;
  }

  async function snapshotOf(db, strategy = primaryStrategy) {
    const collections = (await strategy.listCollections(db)).filter((item) => item.type !== 'view'
      && (type !== 'mongodb' || !item.name.startsWith('system.')));
    const counts = [];
    for (const collection of collections) {
      const planned = snapshot && snapshot.counts.find((item) => item.name === collection.name);
      const identity = planned ? planned.identity : identities.get(collection.name) || null;
      const value = await cardinalitaDestinazione({
        strategy, dbType: type, targetDb: db, collection: collection.name, identity,
      });
      counts.push({ name: collection.name, identity, ...value });
    }
    return {
      counts: counts.sort((a, b) => a.name.localeCompare(b.name)),
      schema: await schemaOf(db, collections, strategy),
    };
  }

  return {
    setSignal(next) { activeSignal = next; shell.setSignal(next); },
    async validatePlan(plan) {
      if (plan.kind !== 'restore-backup' || plan.dbType !== type) throw new Error('Piano restore incompatibile con la strategia.');
      const current = descriviBackup(plan.source.backupDir, plan.source.onlyCollections, { allowUnsafeSchema: plan.allowUnsafeSchema === true });
      if (JSON.stringify(current) !== JSON.stringify(plan.source)) {
        throw new Error('La catena backup e cambiata dopo la conferma del piano.');
      }
      await preflightChain(resolveChain(plan.source.backupDir), log, { allowUnsafeSchema: plan.allowUnsafeSchema === true });
      identities = new Map(plan.collections.map((collection) => [collection.name, collection.identity || null]));
    },
    destinationExists: shell.destinationExists,
    createRecovery: shell.createRecovery,
    async prepareStaging(plan, recovery, targetExists) {
      // Un restore selettivo parte sempre dalla copia corrente; `drop` elimina
      // soltanto le entita selezionate, non il resto del database.
      const basePlan = plan.source.onlyCollections && targetExists ? { ...plan, drop: false } : plan;
      destinationBaseline = targetExists && !basePlan.drop ? await snapshotOf(plan.targetDb) : null;
      selectedBaseline = destinationBaseline && plan.source.onlyCollections
        ? await schemaOf(plan.targetDb, plan.collections.filter(item => destinationBaseline.counts.some(c => c.name === item.name))) : null;
      expectedSchema = await expectedSchemaOf(plan, plan.targetDb);
      const staging = await shell.prepareStaging(basePlan, recovery, targetExists);
      if (targetExists && !basePlan.drop && recovery?.verified === true && !recovery.empty && staging.db !== plan.targetDb) {
        stagingPosseduti.set(staging, { db: staging.db, fingerprint: plan.fingerprint });
      }
      return staging;
    },
    async apply(plan, staging) {
      if (activeSignal && activeSignal.aborted) throw Object.assign(new Error('Restore annullato.'), { code: 'IMPORT_ABORTED' });
      if (!expectedSchema) expectedSchema = await expectedSchemaOf(plan, staging.db);
      const rimuoviSuperati = await preparaRimozioneOggettiSuperati(plan, staging);
      const ripristinaDipendenze = await sospendiDipendenzeSelettive(plan, staging);
      const summary = await runRestore({
        session: { strategy, dbType: type }, backupDir: plan.source.backupDir,
        targetDb: staging.db, onlyCollections: plan.source.onlyCollections,
        drop: !!plan.drop, log, allowUnsafeSchema: plan.allowUnsafeSchema === true,
      });
      if (summary.largeObjects?.length) staging.largeObjects = [...new Set([...(staging.largeObjects || []), ...summary.largeObjects])];
      if (ripristinaDipendenze) await ripristinaDipendenze();
      if (rimuoviSuperati) await rimuoviSuperati();
      snapshot = await snapshotOf(staging.db);
      // Conteggi delle entità non selezionate indipendenti dallo staging.
      // Una perdita durante l'applicazione non diventa il nuovo valore atteso.
      if (plan.source.onlyCollections && destinationBaseline) {
        const selected = new Set(plan.source.onlyCollections);
        snapshot.counts = [...snapshot.counts.filter(item => selected.has(item.name)),
          ...destinationBaseline.counts.filter(item => !selected.has(item.name))].sort((a, b) => a.name.localeCompare(b.name));
      }
      return summary;
    },
    async verify(_plan, where, staging) {
      if (!snapshot) throw new Error('Snapshot verificata dello staging mancante.');
      const actual = await snapshotOf(where === 'staging' ? staging.db : _plan.targetDb,
        where === 'staging' ? strategy : shell.verificationStrategy());
      const baseline = where === 'staging' ? { ...snapshot, schema: expectedSchema } : snapshot;

      // Le collection ATTESE dal piano, confrontate con quelle presenti. Per lo
      // staging `actual.counts` e `snapshot.counts` sono lo stesso oggetto,
      // quindi il confronto dei conteggi non poteva accorgersi di una
      // collection MANCANTE: entrambe le liste la omettevano insieme. Una
      // collection dichiarata dal backup e assente dalla destinazione e' una
      // perdita di dati, non un dettaglio di schema.
      const presenti = new Set(actual.counts.map((item) => item.name));
      const collezioniMancanti = _plan.collections
        .map((collection) => collection.name)
        .filter((name) => !presenti.has(name));

      const schemaDifferences = [
        ...inventoryDifferences(baseline.schema.objects, actual.schema.objects, { exact: true }),
      ];
      for (const name of new Set([
        ...Object.keys(baseline.schema.indexes || {}), ...Object.keys(actual.schema.indexes || {}),
      ])) {
        schemaDifferences.push(...inventoryDifferences(
          { [`indexes:${name}`]: baseline.schema.indexes[name] || [] },
          { [`indexes:${name}`]: actual.schema.indexes[name] || [] }, { exact: true }
        ));
      }
      for (const name of new Set([
        ...Object.keys(baseline.schema.tables || {}), ...Object.keys(actual.schema.tables || {}),
      ])) {
        if (baseline.schema.tables[name] !== actual.schema.tables[name]) {
          schemaDifferences.push({ field: `table:${name}`, missing: [baseline.schema.tables[name]], extras: [actual.schema.tables[name]] });
        }
      }
      const countsOk = JSON.stringify(actual.counts) === JSON.stringify(snapshot.counts);
      const ok = countsOk && !collezioniMancanti.length && schemaDifferences.length === 0;
      return {
        ok, schemaObjects: schemaDifferences.length === 0, schemaDifferences,
        missing: collezioniMancanti, snapshot: actual,
      };
    },
    promote: shell.promote,
    finalize: shell.finalize,
    restore: shell.restore,
    cleanup: shell.cleanup,
  };
}

async function runRestoreViaPlan({
  session, backupDir, targetDb, onlyCollections, drop, log, recoveryRoot, connName = 'restore', onProgress,
  allowUnsafeSchema = false,
}) {
  const source = descriviBackup(backupDir, onlyCollections, { allowUnsafeSchema });
  const plan = require('./importPlan').creaPianoRestore({
    source, expectedDbType: session.dbType, connection: connName,
    targetDb: targetDb || source.sourceDb, drop: !!drop, allowUnsafeSchema,
  });
  const adapter = createBackupRestoreAdapter({
    strategy: session.strategy, dbType: session.dbType, connName,
    recoveryRoot, log,
  });
  const result = await require('./importPlan').eseguiPianoImport(plan, { adapter, onProgress });
  return { ...result,
    targetDb: plan.targetDb, layers: source.layers.length, fingerprint: plan.fingerprint,
    equivalenza: source.equivalenza, equivalenzaDati: source.equivalenzaDati, coerenzaSchema: source.coerenzaSchema,
    totalDocs: (result.verification && result.verification.snapshot && result.verification.snapshot.counts || [])
      .reduce((sum, item) => sum + item.cardinality, 0),
  };
}

module.exports = { descriviBackup, createBackupRestoreAdapter, runRestoreViaPlan };
