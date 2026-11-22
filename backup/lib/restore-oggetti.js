'use strict';

/* ---------------------------------------------------------------------------
 * Oggetti di schema del ripristino: riqualificazione DDL verso il database o
 * schema di destinazione, rimozione DEFINER su MySQL, e applicazione ordinata
 * di opzioni/view MongoDB e collation, tipi, routine, view, sequenze, trigger,
 * eventi, indici, FK e valori di sequenza SQL.
 * ------------------------------------------------------------------------- */

const { preparaCollectionMongo } = require('../../db/mongoCollectionOptions');
const { quotaSempre } = require('../../db/identificatori');
const { normalizzaLayerBackup } = require('../../db/artefatti');

const myQid = (name) => quotaSempre(name, 'mysql');
const pgQid = (name) => quotaSempre(name, 'postgresql');

/**
 * Riqualifica in modo conservativo i riferimenti espliciti al database/schema
 * di origine dentro una DDL destinata a `dbDestinazione`.
 */
function riqualificaDdl(ddl, dbOrigine, dbDestinazione, dbType = null) {
  if (!dbOrigine || dbOrigine === dbDestinazione) return String(ddl);
  if (dbType === 'postgresql' || dbType === 'postgres') {
    const indice = require('../../db/pg-indici').riqualificaIndice(ddl, dbOrigine, dbDestinazione);
    if (indice != null) return indice;
  }
  const esc = String(dbOrigine).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedPg = String(dbOrigine).replace(/"/g, '""');
  const escapedPgRegex = escapedPg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let riscritta = String(ddl)
    .replace(new RegExp('`' + esc + '`\\s*\\.', 'g'), myQid(dbDestinazione) + '.')
    .replace(
      new RegExp('"' + escapedPgRegex + '"\\s*\\.', 'g'),
      `"${String(dbDestinazione).replace(/"/g, '""')}".`,
    );
  if (dbType === 'postgresql' || dbType === 'postgres') {
    riscritta = riscritta.replace(
      new RegExp('(^|[^\\w"\'])' + esc + '\\s*\\.', 'gi'),
      (_match, prefix) => `${prefix}"${String(dbDestinazione).replace(/"/g, '""')}".`,
    );
  }

  const residuo = new RegExp('(^|[^\\w`])' + esc + '(?![\\w])', 'i');
  const senzaNomiQuotati = riscritta
    .replace(new RegExp('`' + esc + '`(?!\\s*\\.)', 'g'), '')
    .replace(new RegExp('"' + escapedPgRegex + '"(?!\\s*\\.)', 'g'), '');
  if (residuo.test(senzaNomiQuotati)) {
    throw new Error(
      `La definizione nomina ancora il database di origine "${dbOrigine}" in una forma non riscrivibile: `
      + 'ripristinandola punterebbe alle tabelle originali invece che a quelle appena create.'
    );
  }
  return riscritta;
}

/**
 * Toglie la clausola DEFINER da una DDL MySQL.
 */
function senzaDefiner(ddl) {
  return String(ddl).replace(/\sDEFINER\s*=\s*(`(?:[^`]|``)+`|'(?:[^']|'')*'|\S+)@(`(?:[^`]|``)+`|'(?:[^']|'')*'|\S+)/i, '');
}

/**
 * Applica gli oggetti di schema di un backup al database di destinazione.
 */
async function restoreSchemaObjects({
  strategy, targetDb, dbType, oggetti, dbOrigine, problems, log, allowUnsafeSchema = false, applied = null, preserveViewIdentity = false,
}) {
  if (!oggetti || typeof oggetti !== 'object') return;

  oggetti = normalizzaLayerBackup({
    dbType,
    database: dbOrigine || targetDb,
    schemas: [],
    objects: oggetti,
    integrity: { verifiedCount: 0, unverifiableCount: 0 },
  }, { allowUnsafeSchema }).objects;

  if (dbType === 'mongodb') {
    const client = strategy.client;
    for (const opt of oggetti.collectionOptions || []) {
      try {
        await preparaCollectionMongo(client, targetDb, opt.name, opt.options, { metadata: opt });
      } catch (err) {
        problems.push(`opzioni di "${opt.name}": ${err.message}`);
      }
    }
    let pending = (oggetti.views || []).map(require('../../db/mongoSchemaBson').decodificaMetadati);
    while (pending.length) {
      const failed = [];
      for (const v of pending) {
        try {
          const database = client.db(targetDb);
          try {
            await database.createCollection(v.name, {
              viewOn: v.viewOn, pipeline: v.pipeline || [],
              ...(v.collation ? { collation: v.collation } : {}),
            });
          } catch (err) {
            if (err.code !== 48 && !/already exists/i.test(err.message)) throw err;
            const existing = (await database.listCollections({ name: v.name }).toArray()).find(item => item.name === v.name);
            if (existing?.type !== 'view') throw new Error(`"${v.name}" esiste ma non è una vista.`);
            const current = existing.options || {};
            if (JSON.stringify(current.collation || null) !== JSON.stringify(v.collation || null)) {
              await database.collection(v.name).drop();
              await database.createCollection(v.name, { viewOn: v.viewOn, pipeline: v.pipeline || [], ...(v.collation ? { collation: v.collation } : {}) });
            } else await database.command({ collMod: v.name, viewOn: v.viewOn, pipeline: v.pipeline || [] });
          }
        } catch (err) { failed.push({ ...v, error: err.message }); }
      }
      if (failed.length === pending.length) {
        problems.push(...failed.map(v => `view "${v.name}": ${v.error}`));
        break;
      }
      pending = failed;
    }
    const n = (oggetti.views || []).length + (oggetti.collectionOptions || []).length;
    if (n && log) log.info(`  Oggetti di schema applicati: ${n}`);
    return;
  }

  // --- SQL -----------------------------------------------------------------
  const visteDaSostituire = new Set();
  const materializzateDaAggiornare = new Set();
  const esegui = async (sql, cosa) => {
    const testo = String(sql).trim();
    let pulito = riqualificaDdl(dbType === 'mysql' ? senzaDefiner(testo) : testo, dbOrigine, targetDb, dbType);
    if (dbType === 'postgresql') pulito = pulito.replace(/^CREATE\s+(FUNCTION|PROCEDURE)\b/i, 'CREATE OR REPLACE $1');
    if (visteDaSostituire.has(cosa) && !/^CREATE\s+MATERIALIZED\s+VIEW/i.test(pulito)) {
      pulito = pulito.replace(/^CREATE\s+(?!OR\s+REPLACE\b)/i, 'CREATE OR REPLACE ');
    }
    if (applied?.has(pulito)) return;
    try { await strategy.collectionAggregate(targetDb, null, { pipeline: pulito }); }
    catch (err) {
      if (dbType !== 'mysql' || !/^(routine|evento) /.test(cosa)
          || !([1304, 1537].includes(err.errno) || /already exists/i.test(err.message))) throw err;
      const target = require('../../db/artefatti').estraiBersaglio(pulito);
      const kind = { 'create-function': 'FUNCTION', 'create-procedure': 'PROCEDURE', 'create-event': 'EVENT' }[target.kind];
      if (!kind) throw err;
      await strategy.collectionAggregate(targetDb, null, { pipeline: `DROP ${kind} ${myQid(targetDb)}.${myQid(target.object.name)}` });
      await strategy.collectionAggregate(targetDb, null, { pipeline: pulito });
    }
    if (applied) applied.add(pulito);
    if (log) log.info(`  ${cosa} applicato/a`);
  };

  if (oggetti.collations?.length) {
    const existing = await require('../../db/pg-types').readCollations((s, p) => strategy.pool.query(s, p), targetDb);
    for (const c of oggetti.collations) {
      const found = existing.find(x => x.name === c.name);
      if (found) {
        if (require('../../db/schemaObjects').canonicalSqlForDb(c.ddl, dbOrigine) !== require('../../db/schemaObjects').canonicalSqlForDb(found.ddl, targetDb)) throw new Error(`Collation "${c.name}" incompatibile con la destinazione.`);
      } else await esegui(c.ddl, `collation "${c.name}"`);
    }
  }
  let types = [...(oggetti.types || [])];
  if (types.length) {
    const existing = await require('../../db/pg-types').readTypes((s, p) => strategy.pool.query(s, p), targetDb);
    const canonical = require('../../db/schemaObjects').canonicalSqlForDb;
    types = types.filter(t => {
      const found = existing.find(x => x.name === t.name); if (!found) return true;
      if (canonical(t.ddl, dbOrigine) !== canonical(found.ddl, targetDb)) throw new Error(`Il tipo PostgreSQL "${t.name}" esiste con una definizione diversa.`);
      return false;
    });
  }
  for (const t of types.filter(t => t.shell)) await esegui(`CREATE TYPE ${pgQid(t.name)}`, `tipo shell "${t.name}"`);
  let routines = [...(oggetti.typeRoutines || [])];
  while (types.length || routines.length) {
    let routineProgress = false;
    const deferred = [];
    for (const r of routines) { try { await esegui(r.ddl, `routine del tipo "${r.name}"`); routineProgress = true; } catch { deferred.push(r); } }
    routines = deferred;
    const failed = [];
    for (const t of types) {
      try { await esegui(t.ddl, `tipo "${t.name}"`); }
      catch (err) { failed.push({ ...t, error: err.message }); }
    }
    if (failed.length === types.length && !routineProgress) { problems.push(...failed.map(t => `tipo "${t.name}": ${t.error}`)); break; }
    types = failed;
  }

  if (oggetti.views?.length && typeof strategy.pool?.query === 'function') {
    const names = new Set(oggetti.views.map(v => v.name));
    let existing;
    if (dbType === 'postgresql') {
      existing = (await strategy.pool.query(`SELECT c.relname AS name, c.relkind AS kind
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind IN ('v','m')`, [targetDb])).rows;
    } else {
      const [rows] = await strategy.pool.query(`SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA=?`, [targetDb]);
      existing = rows;
    }
    let pending = existing.filter(v => names.has(v.name));
    if (preserveViewIdentity) {
      for (const view of pending.filter(item => item.kind !== 'm')) visteDaSostituire.add(`view "${view.name}"`);
      const current = dbType === 'postgresql'
        ? await require('../../db/schemaObjects').readSchemaObjects(strategy, dbType, targetDb) : null;
      for (const view of pending.filter(item => item.kind === 'm')) {
        const wanted = oggetti.views.find(item => item.name === view.name);
        const found = current?.views.find(item => item.name === view.name);
        const canonical = require('../../db/schemaObjects').canonicalSqlForDb;
        if (wanted && found && canonical(wanted.ddl, dbOrigine) === canonical(found.ddl, targetDb)) {
          materializzateDaAggiornare.add(view.name);
        }
      }
      pending = pending.filter(item => item.kind === 'm');
      pending = pending.filter(item => !materializzateDaAggiornare.has(item.name));
    }
    while (pending.length) {
      const failed = [];
      for (const v of pending) {
        try {
          const quota = dbType === 'mysql' ? myQid : pgQid;
          await strategy.collectionAggregate(targetDb, null, { pipeline:
            `DROP ${v.kind === 'm' ? 'MATERIALIZED ' : ''}VIEW ${quota(targetDb)}.${quota(v.name)}` });
        } catch (_error) { failed.push(v); }
      }
      if (failed.length === pending.length) {
        for (const v of failed) visteDaSostituire.add(`view "${v.name}"`);
        break;
      }
      pending = failed;
    }
  }

  let rimaste = [
    ...(oggetti.routines || []).map(r => ({ ...r, etichetta: `routine "${r.name}"` })),
    ...(oggetti.views || []).map(v => ({ ...v, etichetta: `view "${v.name}"` })),
  ];
  while (rimaste.length) {
    const falliti = [];
    let progresso = false;
    for (const v of rimaste) {
      try {
        if (v.materialized && materializzateDaAggiornare.has(v.name)) {
          await strategy.pool.query(`REFRESH MATERIALIZED VIEW ${pgQid(targetDb)}.${pgQid(v.name)}`);
        } else await esegui(v.ddl, v.etichetta);
        progresso = true;
      } catch (err) {
        falliti.push({ ...v, errore: err.message });
      }
    }
    if (!progresso) {
      for (const v of falliti) problems.push(`${v.etichetta}: ${v.errore}`);
      break;
    }
    rimaste = falliti;
  }

  for (const gruppo of [
    { voci: oggetti.sequences || [], etichetta: (s) => `sequenza "${s.name}"` },
    { voci: oggetti.triggers || [], etichetta: (t) => `trigger "${t.name}"` },
    { voci: oggetti.events || [], etichetta: (e) => `evento "${e.name}"` },
  ]) {
    for (const voce of gruppo.voci) {
      try {
        await esegui(voce.ddl, gruppo.etichetta(voce));
        if (dbType === 'postgresql' && voce.ownerTable) {
          await strategy.collectionAggregate(targetDb, null, { pipeline:
            `ALTER SEQUENCE ${pgQid(targetDb)}.${pgQid(voce.name)} OWNED BY ${pgQid(targetDb)}.${pgQid(voce.ownerTable)}.${pgQid(voce.ownerColumn)}` });
        }
      } catch (err) {
        problems.push(`${gruppo.etichetta(voce)}: ${err.message}`);
      }
    }
  }

  for (const indice of oggetti.indexes || []) {
    try {
      await esegui(indice, 'indice');
    } catch (err) {
      let uguale = false;
      if (err.code === '42P07' || /already exists|esiste già/i.test(err.message)) {
        const target = require('../../db/artefatti').estraiBersaglio(indice);
        if (typeof strategy.tableAuxDdl === 'function') {
          try {
            const table = target.table.parts.at(-1);
            const aux = await strategy.tableAuxDdl(targetDb, table.quoted ? table.value : table.value.toLowerCase());
            const canonical = require('../../db/schemaObjects').canonicalSqlForDb;
            const expected = canonical(riqualificaDdl(indice, dbOrigine, targetDb, dbType), targetDb);
            uguale = (aux.indexes || []).some(sql => canonical(sql, targetDb) === expected);
          } catch (checkError) {
            problems.push(`Verifica dell'indice esistente: ${checkError.message}`);
          }
        }
      }
      if (!uguale) problems.push(`indice: ${err.message}`);
    }
  }
  for (const fk of oggetti.foreignKeys || []) {
    try { await esegui(fk, 'vincolo'); }
    catch (err) {
      if (!/duplicate|already exists|esiste già/i.test(err.message)) problems.push(`chiave esterna: ${err.message}`);
    }
  }

  for (const seq of oggetti.sequenceValues || []) {
    const cosa = `valore della sequenza "${seq.name}"`;
    try {
      const sql = String(seq.sql || '').trim();
      // setval da solo sopravvive al ROLLBACK. RESTART assegna alla sequenza
      // uno stato transazionale: anche un contatore esistente torna identico
      // se fallisce la verifica successiva o viene annullata la promozione.
      if (dbType === 'postgresql' && require('../../db/pg-restore-transaction').inTransazioneRipristino(strategy)) {
        await strategy.pool.query(`ALTER SEQUENCE ${pgQid(targetDb)}.${pgQid(seq.name)} RESTART`);
      }
      await strategy.collectionAggregate(targetDb, null, { pipeline: sql });
      if (log) log.info(`  ${cosa} ripristinato`);
    } catch (err) {
      problems.push(`${cosa}: ${err.message}`);
    }
  }
}

module.exports = {
  riqualificaDdl,
  senzaDefiner,
  restoreSchemaObjects,
};
