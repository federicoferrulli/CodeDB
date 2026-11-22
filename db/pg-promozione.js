'use strict';

const { quotaSempre } = require('./identificatori');
const { canonicalSqlForDb } = require('./schemaObjects');
const { canonicaIdentificatori } = require('./pg-schema-compare');
const q = name => quotaSempre(name, 'postgresql');
const table = (db, name) => `${q(db)}.${q(name)}`;

async function sequenzeSchema(pool, db) {
  return (await pool.query(`SELECT s.relname AS name, t.relname AS tabella, a.attname AS colonna, d.deptype,
      format_type(p.seqtypid, NULL) AS tipo, p.seqincrement AS passo, p.seqmin AS minimo, p.seqmax AS massimo,
      p.seqstart AS inizio, p.seqcache AS cache, p.seqcycle AS ciclo
    FROM pg_catalog.pg_class s JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace
    JOIN pg_catalog.pg_sequence p ON p.seqrelid=s.oid
    LEFT JOIN pg_catalog.pg_depend d ON d.classid='pg_class'::regclass AND d.objid=s.oid
      AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
    LEFT JOIN pg_catalog.pg_class t ON t.oid=d.refobjid
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    WHERE n.nspname=$1`, [db])).rows;
}

// Allinea la sequenza nativa mantenendo il suo OID. Anche i default e le
// dipendenze esterne che la nominano seguono una rinomina fatta nel backup.
function pianoSequenze(prima, dopo, tabelleFinali) {
  const comandi = [];
  const proprieta = s => JSON.stringify([s.tabella, s.colonna, s.deptype]);
  const opzioni = s => `AS ${s.tipo} INCREMENT BY ${s.passo} MINVALUE ${s.minimo} MAXVALUE ${s.massimo} START WITH ${s.inizio} CACHE ${s.cache} ${s.ciclo ? 'CYCLE' : 'NO CYCLE'}`;
  for (const vecchia of prima) {
    if (vecchia.tabella && !tabelleFinali.has(vecchia.tabella)) continue;
    let finale = dopo.find(s => s.name === vecchia.name && proprieta(s) === proprieta(vecchia));
    if (!finale) {
      const candidate = dopo.filter(s => proprieta(s) === proprieta(vecchia));
      if (!vecchia.tabella || candidate.length !== 1 || prima.filter(s => proprieta(s) === proprieta(vecchia)).length !== 1) return null;
      finale = candidate[0];
      if (prima.some(s => s.name === finale.name) || dopo.some(s => s.name === vecchia.name)) return null;
      comandi.push({ nome: vecchia.name, clausola: 'RENAME TO ' + q(finale.name) });
    }
    if (opzioni(vecchia) !== opzioni(finale)) {
      comandi.push({ nome: finale.name, clausola: opzioni(finale) + ' RESTART WITH ' + finale.inizio });
    }
  }
  return comandi;
}

// La tabella compatibile viene riempita nella stessa transazione conservando
// OID e tipo composito. I riferimenti esterni continuano così a indicarla.
async function promuoviTabelleCompatibili({ strategy, targetDb, stagingDb, backupDir, log }) {
  const native = strategy.pool;
  const list = async db => (await strategy.listCollections(db)).filter(item => item.type !== 'view');
  const oldTables = await list(targetDb), newTables = await list(stagingDb);
  const partizioni = async db => [...(await require('./pg-partizioni').catalogoPartizioni((s,p)=>native.query(s,p),db)).values()]
    .map(p=>JSON.stringify([p.name,p.parentSchema === db ? p.parent : [p.parentSchema,p.parent],p.key,p.bound])).sort();
  if (JSON.stringify(await partizioni(targetDb)) !== JSON.stringify(await partizioni(stagingDb))) return false;
  const oldNames = new Set(oldTables.map(item => item.name)), newNames = new Set(newTables.map(item => item.name));
  const sequenze = pianoSequenze(await sequenzeSchema(native, targetDb), await sequenzeSchema(native, stagingDb), newNames);
  if (!sequenze) return false;
  const normalize = (ddl, db) => canonicaIdentificatori(canonicalSqlForDb(ddl, db));
  // Il percorso ordinario resta disponibile per schemi completamente nuovi.
  // Qui la compatibilità è verificata dal catalogo, non dedotta dal nome.
  const changed = [];
  for (const name of [...oldNames].filter(name => newNames.has(name))) {
    if (normalize(await strategy.tableDdl(targetDb, name), targetDb)
      !== normalize(await strategy.tableDdl(stagingDb, name), stagingDb)) changed.push(name);
  }
  const relatedKeys = async () => (await native.query(`SELECT c.oid, c.conname AS name,
      n.nspname AS schema,t.relname AS "table",pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_class parent ON parent.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace
    WHERE c.contype='f' AND c.conparentid=0 AND (n.nspname=$1 OR pn.nspname=$1)
    ORDER BY n.nspname,t.relname,c.conname`, [targetDb])).rows;
  let keys = await relatedKeys();
  const locks = new Set([...oldTables.map(item => table(targetDb, item.name)), ...keys.map(key => table(key.schema, key.table))]);
  for (const relation of [...locks].sort()) await native.query(`LOCK TABLE ${relation} IN ACCESS EXCLUSIVE MODE`);
  for (const { nome, clausola } of sequenze) await native.query(`ALTER SEQUENCE ${table(targetDb, nome)} ${clausola}`);
  keys = await relatedKeys();
  // La DROP di un vincolo esterno è transazionale e la sua definizione viene
  // riapplicata e validata prima del commit, comprese le FK immediate.
  for (const key of keys) await native.query(`ALTER TABLE ${table(key.schema, key.table)} DROP CONSTRAINT ${q(key.name)}`);
  // Lo staging verificato contiene già gli oggetti locali da conservare.
  // Gli indici estranei a quella fotografia sono stati rimossi dalla catena;
  // lasciarli qui potrebbe anche imporre un vecchio UNIQUE ai nuovi dati.
  const indexes = async db => (await native.query(`SELECT i.relname AS name FROM pg_index x
    JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=i.relnamespace
    WHERE n.nspname=$1 AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid=i.oid) AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=i.oid)`, [db])).rows;
  const finalIndexes = new Set((await indexes(stagingDb)).map(item => item.name));
  for (const index of await indexes(targetDb)) if (!finalIndexes.has(index.name)) {
    await native.query(`DROP INDEX ${table(targetDb, index.name)}`);
  }
  const triggers = (await native.query(`SELECT t.tgname AS name,c.relname AS "table" FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND NOT t.tgisinternal AND t.tgparentid=0`, [targetDb])).rows;
  for (const trigger of triggers) await native.query(`DROP TRIGGER ${q(trigger.name)} ON ${table(targetDb, trigger.table)}`);
  // Svuotare insieme evita conflitti temporanei durante scambi di valori
  // UNIQUE. PK e indici compatibili mantengono la loro identità nativa.
  if (oldTables.length) await native.query(`TRUNCATE TABLE ${oldTables.map(item => table(targetDb, item.name)).join(',')}`);
  if (changed.length) {
    const objects = await require('./schemaObjects').readSchemaObjects(strategy, 'postgresql', stagingDb);
    const problems = [];
    await require('../backup/lib/restore').restoreSchemaObjects({ strategy, targetDb, dbType: 'postgresql',
      oggetti: { types: objects.types, collations: objects.collations, sequences: objects.sequences, routines: objects.routines },
      dbOrigine: stagingDb, problems, log });
    if (problems.length) throw new Error(problems.join('; '));
    for (const name of changed) await require('./pg-evoluzione').evolviTabella({ strategy, targetDb, stagingDb, name });
  }
  const restored = await require('../backup/lib/restore').runRestore({
    session: { strategy, dbType: 'postgresql' }, backupDir, targetDb, onlyCollections: null, drop: false,
    log, preserveViewIdentity: true,
  });
  const views = async db => (await native.query(`SELECT c.relname AS name,c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('v','m')`, [db])).rows;
  const finalViews = new Set((await views(stagingDb)).map(item => item.name));
  let obsoleteViews = (await views(targetDb)).filter(item => !finalViews.has(item.name));
  while (obsoleteViews.length) {
    const deferred = [];
    for (const view of obsoleteViews) {
      try { await native.query(`DROP ${view.kind === 'm' ? 'MATERIALIZED ' : ''}VIEW ${table(targetDb, view.name)}`); }
      catch (error) { deferred.push({ ...view, error }); }
    }
    if (deferred.length === obsoleteViews.length) throw deferred[0].error;
    obsoleteViews = deferred;
  }
  const routines = async db => (await native.query(`SELECT p.proname AS name,p.prokind AS kind,
    oidvectortypes(p.proargtypes) AS types,pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prokind IN ('f','p')
    AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype IN ('i','e'))`, [db])).rows;
  const signature = (routine, db) => JSON.stringify([routine.name, routine.kind, normalize(routine.types, db)]);
  const finalRoutines = new Set((await routines(stagingDb)).map(item => signature(item, stagingDb)));
  for (const routine of await routines(targetDb)) if (!finalRoutines.has(signature(routine, targetDb))) {
    await native.query(`DROP ${routine.kind === 'p' ? 'PROCEDURE' : 'FUNCTION'} ${table(targetDb, routine.name)}(${routine.args})`);
  }
  for (const key of keys.filter(item => item.schema !== targetDb)) {
    await native.query(`ALTER TABLE ${table(key.schema, key.table)} ADD CONSTRAINT ${q(key.name)} ${key.definition}`);
  }
  // Senza CASCADE: un riferimento esterno incompatibile impedisce la modifica
  // e lascia al piano il rollback dell'intera transazione.
  for (const name of [...oldNames].filter(name => !newNames.has(name))) await native.query(`DROP TABLE ${table(targetDb, name)}`);
  return { restored, retainedStaging: true };
}

module.exports = { promuoviTabelleCompatibili };
