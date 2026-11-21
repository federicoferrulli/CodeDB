'use strict';

// Un solo esecutore per i due formati: il piano decide il perimetro, il sink
// riceve piccoli blocchi e pubblica il file soltanto dopo tutte le verifiche.
const { randomUUID } = require('crypto');
const { quotaSempre } = require('./identificatori');
const { readSchemaObjects } = require('./schemaObjects');
const { verificaImpronta } = require('./pianoComune');
const { splitMySqlForeignKeys } = require('../backup/lib/engine');
const { pgCreateTable, pgAuxDdl, pgColonne } = require('./pg-ddl');
const { scegliIdentitaSql } = require('../backup/lib/identity');
const { riferimentiChiaveEsterna } = require('./artefatti');
const { deserializeClientObject } = require('./sqlValori');
const MySqlStrategy = require('./MySqlStrategy');
const PostgreSqlStrategy = require('./PostgreSqlStrategy');
const mongoBson = require('./mongoBson');
const { preamboloMongosh, documentoMongosh, espressioneBson } = require('./exportMongoScript');
const { preparaTabelle, seRichiesto, seAssenteMySql, nomeMySql, indicePartizione } = require('./exportSqlTabelle');

const TIPI_OGGETTO = { views: 'vista', routines: 'routine', triggers: 'trigger', events: 'evento', sequences: 'sequenza', collectionOptions: 'collection' };

function oggettiSelezionati(objects, plan) {
  const struttura = new Set(plan.oggetti.filter(o => o.struttura).map(o => o.id));
  return Object.fromEntries(Object.entries(TIPI_OGGETTO).map(([campo, tipo]) => [
    campo, (objects[campo] || []).filter(o => struttura.has(`${tipo}:${o.name}`)),
  ]));
}

function letterale(value, mysql) {
  if (value == null) return 'NULL';
  if (value && value._bsontype) {
    if (value._bsontype === 'Binary') value = Buffer.from(value.buffer);
    else if (['Long', 'Decimal128', 'Int32', 'Double'].includes(value._bsontype)) value = value.toString();
  }
  if (Buffer.isBuffer(value)) return mysql ? `X'${value.toString('hex')}'` : `decode('${value.toString('hex')}', 'hex')`;
  if (value instanceof Date) value = value.toISOString();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'object') value = JSON.stringify(value);
  // MySQL: testo UTF-8 esadecimale, indipendente da NO_BACKSLASH_ESCAPES.
  if (mysql) return `CONVERT(X'${Buffer.from(String(value), 'utf8').toString('hex')}' USING utf8mb4)`;
  return `E'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

// Le colonne INCLUDE, gli indici parziali e le espressioni non sono un
// bersaglio ON CONFLICT (colonne). I vincoli differibili non possono arbitrare.
async function chiaveConflittoPg(conn, db, table, modo) {
  const { rows } = await conn.query(`SELECT i.indimmediate AS immediato, i.indisunique AS unico,
      i.indpred IS NULL AND i.indexprs IS NULL AS semplice,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, pos)
            JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num
            WHERE k.pos <= i.indnkeyatts ORDER BY k.pos) AS colonne
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname=$2 AND i.indisvalid AND (i.indisunique OR i.indisexclusion)
    ORDER BY i.indisprimary DESC, i.indnkeyatts, i.indexrelid`, [db, table]);
  const differibili = rows.filter(r => !r.immediato);
  if (modo === 'ignora') {
    if (differibili.length) throw new Error(`La tabella "${table}" ha un vincolo differibile: PostgreSQL non consente ON CONFLICT DO NOTHING su tutti i suoi vincoli. Scegli INSERT.`);
    return [];
  }
  // PostgreSQL inferisce tutti gli indici sulle stesse colonne, in qualsiasi
  // ordine. Se fra loro c'è un differibile, anche un gemello immediato fallisce.
  const valida = rows.find(r => r.unico && r.semplice && r.immediato && !differibili.some(d =>
    d.semplice && d.colonne.length === r.colonne.length && d.colonne.every(c => r.colonne.includes(c))));
  if (!valida) throw new Error(`Per aggiornare i duplicati di "${table}" serve una chiave primaria o un indice UNIQUE immediato, non parziale, su colonne semplici. Scegli INSERT o una diversa tabella.`);
  return valida.colonne;
}

function scritturaRighe(dbType, table, columns, modo, chiave) {
  const mysql = dbType === 'mysql';
  const q = name => quotaSempre(name, dbType);
  if (modo === 'replace' && mysql) return { comando: 'REPLACE', coda: '' };
  if (modo === 'ignora' && !mysql) return { comando: 'INSERT', coda: ' ON CONFLICT DO NOTHING' };
  if (modo !== 'aggiorna' && modo !== 'ignora') throw new Error(`Modalità delle righe SQL non supportata per ${dbType}.`);
  const scrivibili = columns.filter(c => !c.generated);
  const aggiornabili = scrivibili.filter(c => !chiave.includes(c.name) && !c.identity && !c.autoIncrement).map(c => q(c.name));
  if (mysql) {
    const campo = scrivibili[0];
    if (!campo) throw new Error(`Nessuna colonna scrivibile in "${table}" per ON DUPLICATE KEY UPDATE.`);
    // INSERT IGNORE declasserebbe anche troncamenti ed errori di tipo.
    const assegnazioni = modo === 'aggiorna' && aggiornabili.length
      ? aggiornabili.map(c => `${c} = VALUES(${c})`).join(', ')
      : `${q(campo.name)} = ${q(campo.name)}`;
    return { comando: 'INSERT', coda: ` ON DUPLICATE KEY UPDATE ${assegnazioni}` };
  }
  const azione = aggiornabili.length
    ? `DO UPDATE SET ${aggiornabili.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`
    : 'DO NOTHING';
  // Una tabella chiamata "excluded" renderebbe ambiguo il riferimento alla
  // riga proposta. L'alias nasconde il nome della tabella a PostgreSQL.
  return { comando: 'INSERT', alias: table === 'excluded' ? ' AS codedb_destinazione' : '',
    coda: ` ON CONFLICT (${chiave.map(q).join(', ')}) ${azione}` };
}

function insertSql(dbType, table, line, info) {
  const mysql = dbType === 'mysql';
  const row = deserializeClientObject(JSON.parse(line));
  const cols = Object.keys(row);
  const { comando = 'INSERT', alias = '', coda = '' } = info.scrittura || {};
  const into = `${comando} INTO ${table}${alias}`;
  if (!cols.length) return `${into} ${mysql ? '() VALUES ()' : 'DEFAULT VALUES'}${coda};\n`;
  const vals = cols.map(c => {
    if(!mysql && row[c]?.$pgReference) {
      if(row[c].$pgReference.kind==='nested')return require('./pg-alias').sqlNested(row[c],v=>letterale(v,false));
      const bind=require('./pg-alias').binding(row[c]);
      return bind.sql.replace('$1',()=>letterale(bind.param,false));
    }
    const ordinal = mysql && require('./mysql-ordinal').binding(row[c], info.columns.find(column => column.name === c));
    if (ordinal) return `CAST('${ordinal.param}' AS UNSIGNED)`;
    const b = mysql
      ? MySqlStrategy.geoBinding(c, row[c], info.geo, { importazione: true })
      : PostgreSqlStrategy.geoBinding(c, row[c], info.geo, '$1', info.geoNativo);
    // Sostituzione con callback: un "$&" nei dati non è una direttiva replace.
    return b.sql.replace(mysql ? /\?/ : /\$1\b/, () => letterale(b.param, mysql));
  });
  const overriding = !mysql && info.columns.some(c => c.identity === 'ALWAYS' || c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : '';
  const insert = `${into} (${cols.map(c => quotaSempre(c, dbType)).join(', ')})${overriding} VALUES (${vals.join(', ')})${coda};\n`;
  const zeroEnum = mysql && cols.some(c => require('./mysql-ordinal').binding(row[c], info.columns.find(column => column.name === c))?.zero);
  return zeroEnum ? `SET @codedb_enum_mode = @@SESSION.sql_mode;\nSET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO';\n${insert}SET SESSION sql_mode = @codedb_enum_mode;\n` : insert;
}

async function scriviLargeObjectPg({ oid, size, chunks }, riusa, send) {
  const esistente = "pg_catalog.current_setting('codedb.lo_esistente')::boolean";
  const errore = `RAISE EXCEPTION 'Il contenuto del Large Object % presente nella destinazione è diverso da quello esportato', ${oid};`;
  if (riusa) {
    // Gli OID sono globali al database fisico. Sovrascrivere l'oggetto
    // modificherebbe anche eventuali riferimenti esterni allo schema esportato.
    await send(`SELECT pg_catalog.set_config('codedb.lo_esistente', (EXISTS (SELECT 1 FROM pg_catalog.pg_largeobject_metadata WHERE oid = ${oid}))::text, true);\n`);
    await send(`DO $codedb$ BEGIN IF ${esistente} THEN
      IF pg_catalog.octet_length(pg_catalog.lo_get(${oid}, ${size}, 1)) <> 0 THEN ${errore} END IF;
      ELSE PERFORM pg_catalog.lo_create(${oid}); END IF; END $codedb$;\n`);
  } else await send(`SELECT pg_catalog.lo_create(${oid});\n`);
  let offset = 0;
  for await (const bytes of chunks) {
    const dato = `decode('${bytes.toString('hex')}', 'hex')`;
    if (riusa) {
      await send(`DO $codedb$ DECLARE atteso bytea := pg_catalog.${dato}; BEGIN IF ${esistente} THEN
        IF pg_catalog.lo_get(${oid}, ${offset}, ${bytes.length}) IS DISTINCT FROM atteso THEN ${errore} END IF;
        ELSE PERFORM pg_catalog.lo_put(${oid}, ${offset}, atteso); END IF; END $codedb$;\n`);
    } else await send(`SELECT pg_catalog.lo_put(${oid}, ${offset}, ${dato});\n`);
    offset += bytes.length;
  }
}

async function esportaDatabase({ strategy, plan, write, progress = () => {}, check = () => {} }) {
  verificaImpronta(plan);
  if (!['codedb-json', 'sql', 'mongosh'].includes(plan.formato)) throw new Error('Formato di export non supportato.');
  const mongo = plan.dbType === 'mongodb';
  const scriptMongo = plan.formato === 'mongosh';
  const json = plan.formato === 'codedb-json';
  if (scriptMongo && !mongo) throw new Error('Il formato mongosh richiede un database MongoDB.');
  if (mongo && plan.formato === 'sql') throw new Error('Un database MongoDB richiede il formato CodeDB; SQL non ne conserva documenti e indici.');
  if (plan.oggetti.some(o => o.filtro)) throw new Error('Il piano contiene filtri non eseguibili da questo export.');
  const sql = plan.formato === 'sql';
  const db = plan.sourceDb;
  const q = n => quotaSempre(n, plan.dbType);
  const tables = plan.oggetti.filter(o => o.tipo === 'tabella' || o.tipo === 'collection');
  const modoRighe = plan.opzioniSql?.righe || 'insert';
  const existingFks = [];
  let nuoveTabelle = new Map();
  const mysql = plan.dbType === 'mysql';
  const literal = value => letterale(value, mysql);
  const ddlCondizionale = (ddl, condizione) => seRichiesto(ddl, condizione, { mysql, literal, statement });
  const tabelleCondizionali = sql && (plan.opzioniSql?.tabelle || 'crea') !== 'crea';
  const vincoliNativi = tabelleCondizionali || (sql && modoRighe !== 'insert');
  const guard = q(`codedb_verifica_fk_${randomUUID().replace(/-/g, '')}`);
  let conn;
  let mysqlSession;
  let mongoRead;
  let st = strategy;
  let started = false;
  let rows = 0;
  const largeObjectIds = new Set();
  const send = async text => { check(); await write(text); };
  try {
    if (mongo) mongoRead = await require('./mongoTopologia').apriLettura(strategy.client);
    if (!mongo) {
      conn = mysql ? await strategy.pool.getConnection() : await strategy.pool.connect();
      st = mysql ? new MySqlStrategy() : new PostgreSqlStrategy();
      if (mysql) st.metadataPool = strategy.pool;
      const borrowed = { query: (...args) => conn.query(...args), release() {} };
      st.pool = { ...borrowed, getConnection: async () => borrowed, connect: async () => borrowed };
      if (mysql) {
        const [[session]] = await conn.query('SELECT @@SESSION.time_zone AS timezone, @@SESSION.sql_mode AS mode');
        mysqlSession = session;
        await conn.query("SET SESSION time_zone = '+00:00', SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO,STRICT_ALL_TABLES'");
        await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      } else {
        await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      }
      started = true;
      if (!mysql && tables.length) await conn.query(`LOCK TABLE ${tables.map(t => `${q(db)}.${q(t.nome)}`).join(', ')} IN ACCESS SHARE MODE`);
      // I metadati PostgreSQL devono usare lo stesso client senza BEGIN annidati.
      if (!mysql) {
        await conn.query(`SET LOCAL search_path TO ${q(db)}, public`);
        await conn.query("SET LOCAL DateStyle = 'ISO, YMD'; SET LOCAL IntervalStyle = 'postgres'; SET LOCAL TimeZone = 'UTC'");
        st.conSearchPath = async (_schema, fn) => fn(borrowed);
      }
    }
    const sqlPgSuEsistente = vincoliNativi && plan.dbType === 'postgresql';
    const allObjects = await readSchemaObjects(st, plan.dbType, db, { statoSequenze: sqlPgSuEsistente });
    const objects = oggettiSelezionati(allObjects, plan);
    const partizioni = !mysql && vincoliNativi
      ? await require('./pg-partizioni').catalogoPartizioni((s, p) => conn.query(s, p), db) : new Map();
    const indiciPartizioni = new Map();
    if (partizioni.size) {
      const indici = await conn.query(`SELECT f.relname AS figlio, p.relname AS nome, pn.nspname AS schema
        FROM pg_catalog.pg_inherits h JOIN pg_catalog.pg_class f ON f.oid=h.inhrelid
        JOIN pg_catalog.pg_class p ON p.oid=h.inhparent JOIN pg_catalog.pg_namespace n ON n.oid=f.relnamespace
        JOIN pg_catalog.pg_namespace pn ON pn.oid=p.relnamespace WHERE n.nspname=$1 AND f.relkind IN ('i','I')`, [db]);
      for (const indice of indici.rows) indiciPartizioni.set(indice.figlio, indice);
    }
    const ddlAccessoria = (ddl, table) => {
      if (indiciPartizioni.size && /^CREATE (?:UNIQUE )?INDEX\b/i.test(ddl)) {
        const indice = indiciPartizioni.get(require('./artefatti').estraiBersaglio(ddl).object.name);
        if (indice) ddl = indicePartizione(ddl, table, indice, { schema: db, q, literal });
      }
      return ddlCondizionale(ddl, nuoveTabelle.get(table));
    };
    if (plan.dbType === 'postgresql') {
      objects.types = tables.some(t => t.struttura) ? allObjects.types || [] : [];
      objects.collations = tables.some(t => t.struttura) ? allObjects.collations || [] : [];
      objects.extensions = allObjects.extensions || [];
      objects.sequences = (allObjects.sequences || []).filter(s =>
        s.ownerTable ? tables.some(t => t.struttura && t.nome === s.ownerTable) : objects.sequences.includes(s));
    }
    for (const o of plan.oggetti.filter(o => o.struttura && !['tabella', 'collection'].includes(o.tipo))) {
      const field = Object.keys(TIPI_OGGETTO).find(k => TIPI_OGGETTO[k] === o.tipo);
      if (!field || !objects[field].some(item => item.name === o.nome)) {
        throw new Error(`L'oggetto "${o.nome}" non esiste più: ricreare il piano di export.`);
      }
    }
    let catalogoMongo;
    if (mongo) {
      const infos = await st.client.db(db).listCollections({}, { promoteValues: false, bsonRegExp: true }).toArray();
      catalogoMongo = new Map(infos.map(o => [o.name, o]));
      for (const t of tables) {
        const info = catalogoMongo.get(t.nome);
        if (!info || info.type === 'view') throw new Error(`La collection "${t.nome}" non esiste più.`);
      }
    }
    // Le sequenze possedute da una colonna non hanno una CREATE separata.
    // Si conserva il loro avanzamento solo per le tabelle con dati esportati.
    if (plan.dbType === 'postgresql') {
      const seq = await conn.query(`SELECT s.relname AS name, t.relname AS tabella
        FROM pg_class s JOIN pg_namespace n ON n.oid=s.relnamespace
        JOIN pg_depend d ON d.objid=s.oid AND d.deptype IN ('a','i')
        JOIN pg_class t ON t.oid=d.refobjid WHERE s.relkind='S' AND n.nspname=$1`, [db]);
      const owners = new Map(seq.rows.map(r => [r.name, r.tabella]));
      objects.sequenceValues = (allObjects.sequenceValues || []).filter(s =>
        tables.some(t => t.dati && t.nome === owners.get(s.name))
        || plan.oggetti.some(o => o.id === `sequenza:${s.name}` && o.struttura));
      if (sqlPgSuEsistente) for (const s of objects.sequenceValues) s.tabella = owners.get(s.name);
    }
    const meta = new Map();
    for (const t of tables) {
      check();
      let ddl = null, indexes = null, postDdl = [];
      let info = null;
      let identity = mongo ? { kind: 'mongodb-id', columns: ['_id'] } : null;
      if (mongo) {
        // La lettura degli indici è obbligatoria: nessun catch che inventa [].
        if (t.struttura) indexes = (await st.client.db(db).collection(t.nome).indexes({ promoteValues: false, bsonRegExp: true }))
          .filter(i => i.name !== '_id_').map(require('./mongoSchemaBson').codificaMetadati);
      } else {
        // In uno script SQL una PK invisibile va comunque inserita per far
        // riconoscere a REPLACE e agli upsert la riga corretta.
        info = await st.tableColumnsInfo(db, t.nome, { includiInvisibili: sql && plan.dbType === 'mysql' });
        const primary = await st.primaryKey(db, t.nome);
        const uniques = await st.uniqueIndexes(db, t.nome);
        identity = scegliIdentitaSql(info.columns, [
          ...(primary.length ? [{ kind: 'primary-key', name: 'PRIMARY', columns: primary }] : []),
          ...uniques.map((columns, i) => ({ kind: 'unique', name: `unique_${i}`, columns })),
        ]);
        if (plan.dbType === 'postgresql') info.columns = await pgColonne((s, p) => conn.query(s, p), db, t.nome);
        if (sql && mysql && modoRighe !== 'insert') info.primaria = primary;
        if (sql && t.dati && !t.struttura && !vincoliNativi) {
          const fks = plan.dbType === 'mysql' ? await st.columnRelations(db, t.nome)
            : (await conn.query(`SELECT c.conname AS nome, c.condeferrable AS differibile
                FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
                JOIN pg_namespace n ON n.oid=t.relnamespace
                WHERE c.contype='f' AND n.nspname=$1 AND t.relname=$2`, [db, t.nome])).rows;
          existingFks.push(...fks.map(fk => ({ ...fk, table: t.nome })));
        }
        if (t.struttura) {
          if (plan.dbType === 'mysql') {
            const raw = await st.tableDdl(db, t.nome);
            if (!raw) throw new Error(`Struttura di "${t.nome}" non disponibile.`);
            const [fk] = await conn.query(`SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME=?`, [db, t.nome]);
            const split = splitMySqlForeignKeys(raw, t.nome, fk.length);
            ddl = split.ddl;
            postDdl = split.foreignKeys;
          } else {
            const partizione = partizioni.get(t.nome);
            ddl = await pgCreateTable((s, p) => conn.query(s, p), db, t.nome, { partizione });
            const aux = await pgAuxDdl((s, p) => conn.query(s, p), db, t.nome, { qualificato: true });
            postDdl = [...aux.indexes, ...aux.foreignKeys];
          }
          if (!ddl) throw new Error(`Struttura di "${t.nome}" non disponibile.`);
          // I vincoli fuori perimetro restano prerequisiti dichiarati, non SQL
          // che farà fallire il ripristino dopo aver caricato tutti i dati.
          const omitted = plan.vincoliOmessi.filter(v => v.da === t.id);
          postDdl = postDdl.filter(s => !omitted.some(v => riferimentiChiaveEsterna(s).includes(v.a.slice(v.a.indexOf(':') + 1))));
        }
      }
      meta.set(t.id, { name: t.nome, ddl, indexes, identity, postDdl: mongo ? null : postDdl, info });
    }
    if (sql) {
      await send('-- Esportazione CodeDB. Lo script usa il database/schema di origine indicato qui sotto.\n');
      await send(`-- Consistenza: ${String(plan.consistenza).replace(/[\r\n]/g, ' ')}.\n`);
      const struttura = plan.oggetti.some(o => o.struttura);
      if (plan.dbType === 'postgresql') await send(`BEGIN;\n${struttura ? `CREATE SCHEMA IF NOT EXISTS ${q(db)};\n` : ''}SET LOCAL search_path TO ${q(db)}, public;\nSET LOCAL standard_conforming_strings = on;\nSET LOCAL DateStyle = 'ISO, YMD';\nSET LOCAL IntervalStyle = 'postgres';\nSET LOCAL TimeZone = 'UTC';\n`);
      else await send(`${struttura ? `CREATE DATABASE IF NOT EXISTS ${q(db)};\n` : ''}USE ${q(db)};\nSET NAMES utf8mb4;\nSET @codedb_sql_mode = @@SESSION.sql_mode, @codedb_time_zone = @@SESSION.time_zone, @codedb_fk_checks = @@SESSION.foreign_key_checks;\nSET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO,STRICT_ALL_TABLES', SESSION time_zone = '+00:00', SESSION foreign_key_checks = 1;\n`);
      const statements = new Map();
      const preparazione = preparaTabelle({ plan, tables, objects, q, literal, statement });
      nuoveTabelle = preparazione.nuove;
      for (const part of preparazione.preambolo) await send(part);
      for (const c of objects.collations || []) {
        const ddl = tabelleCondizionali ? c.ddl.replace(/^CREATE COLLATION /i, 'CREATE COLLATION IF NOT EXISTS ') : c.ddl;
        await send(statement(ddl, plan.dbType));
      }
      if (objects.types?.length) {
        await send('SET LOCAL check_function_bodies = false;\n');
        for (const ddl of require('./pg-types').prelude(objects)) {
          const tipo = tabelleCondizionali && objects.types.find(t => t.ddl === ddl || (t.shell && ddl === 'CREATE TYPE ' + q(t.name)));
          const manca = tipo && `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=${literal(db)} AND t.typname=${literal(tipo.name)}${ddl === tipo.ddl ? ' AND t.typisdefined' : ''})`;
          await send(ddlCondizionale(ddl, manca));
        }
      }
      for (const s of objects.sequences.filter(s => s.ownerTable)) await send(ddlCondizionale(s.ddl, nuoveTabelle.get(s.ownerTable)));
      for (const [id, m] of meta) if (m.ddl) {
        statements.set(id, nuoveTabelle.has(m.name) ? m.ddl.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ') : m.ddl);
      }
      for (const [field, type] of Object.entries(TIPI_OGGETTO)) {
        for (const o of objects[field] || []) if (o.ddl) {
          const key = `${type}:${o.name}`;
          let ddl = o.materialized ? o.ddl.trim().replace(/;+$/, '') + ' WITH NO DATA' : o.ddl;
          if (mysql && type === 'vista' && plan.opzioniSql?.tabelle === 'ricrea') ddl = ddl.replace(/^CREATE /i, 'CREATE OR REPLACE ');
          if (type === 'routine') statements.set(key, [...(statements.get(key) || []), mysql && tabelleCondizionali ? seAssenteMySql(ddl) : ddl]);
          else statements.set(key, ddl);
        }
      }
      // Le viste esistono già per le routine che le riferiscono; quelle
      // materializzate si popolano solo dopo il caricamento delle tabelle.
      const creazione = plan.ordine.creazione;
      for (const id of creazione) {
        if (/^(trigger|evento):/.test(id)) continue;
        const ddl = statements.get(id);
        let manca;
        if (tabelleCondizionali && id.startsWith('vista:') && !(mysql && plan.opzioniSql.tabelle === 'ricrea')) {
          const nome = id.slice('vista:'.length);
          manca = mysql ? `NOT EXISTS (SELECT 1 FROM information_schema.VIEWS WHERE ${nomeMySql('TABLE_SCHEMA', ['DATABASE()'])} AND ${nomeMySql('TABLE_NAME', [literal(nome)])})`
            : `pg_catalog.to_regclass(${literal(q(db) + '.' + q(nome))}) IS NULL`;
        }
        if (ddl) for (const part of Array.isArray(ddl) ? ddl : [ddl]) await send(ddlCondizionale(part, manca));
      }
      if (!mysql && ['aggiorna', 'ignora'].includes(plan.opzioniSql?.righe)) {
        // Gli indici autonomi partecipano ai conflitti fin dalla prima riga.
        for (const id of [...creazione].reverse()) {
          const m = meta.get(id);
          if (!m) continue;
          const anticipati = m.postDdl.filter(ddl => /^CREATE UNIQUE INDEX\b/i.test(ddl));
          for (const ddl of anticipati) await send(ddlAccessoria(ddl, m.name));
          m.postDdl = m.postDdl.filter(ddl => !anticipati.includes(ddl));
        }
      }
      for (const s of objects.sequences.filter(s => s.ownerTable)) {
        await send(ddlCondizionale(`ALTER SEQUENCE ${q(s.name)} OWNED BY ${q(s.ownerTable)}.${q(s.ownerColumn)}`, nuoveTabelle.get(s.ownerTable)));
      }
      if (plan.dbType === 'mysql') {
        await send('START TRANSACTION;\n');
        if (existingFks.length) {
          // MySQL non ricontrolla le FK quando le si riattiva. La tabella
          // temporanea fa fallire il caricamento se la verifica trova orfani.
          await send(`CREATE TEMPORARY TABLE ${guard} (violazione_fk VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY);\n`);
          for (const fk of existingFks) await send(`INSERT INTO ${guard} VALUES (${letterale(fk.nome, true)});\n`);
          await send('SET SESSION foreign_key_checks = 0;\n');
        }
      } else if (vincoliNativi) {
        // I vincoli aggiunti localmente sulla destinazione restano attivi.
        await send('SET CONSTRAINTS ALL DEFERRED;\n');
      } else if (existingFks.length) {
        // Anche cicli e autorelazioni si controllano dopo tutte le righe.
        // La differibilità originale viene ripristinata nella stessa transazione.
        for (const fk of existingFks) if (!fk.differibile) await send(`ALTER TABLE ${q(db)}.${q(fk.table)} ALTER CONSTRAINT ${q(fk.nome)} DEFERRABLE;\n`);
        await send('SET CONSTRAINTS ALL DEFERRED;\n');
      }
    } else if (scriptMongo) {
      await send(preamboloMongosh(plan));
      await send(require('./exportMongoStruttura').strutturaMongosh({ plan, tables, meta, espressioneBson, catalogoMongo }));
    } else {
      await send(JSON.stringify({ formato: 'codedb-database', versione: mongo ? 2 : 1, generatore: 'CodeDB', dbType: plan.dbType, db,
        creato: new Date().toISOString(), consistenza: mongoRead?.coerenza.avviso || plan.consistenza,
        objects: mongo ? require('./codecFedele').serializeConservativo(objects) : objects }).slice(0, -1) + ',"collections":[\n');
    }
    const perId = new Map(tables.map(t => [t.id, t]));
    const tabelleDaScrivere = vincoliNativi ? plan.ordine.dati.map(id => perId.get(id)) : tables;
    for (let i = 0; i < tabelleDaScrivere.length; i++) {
      const t = tabelleDaScrivere[i], m = meta.get(t.id);
      if (json) {
        const { info: _info, ...header } = m;
        if (mongo) header.encoding = mongoBson.ENCODING;
        await send((i ? ',\n' : '') + JSON.stringify(header).slice(0, -1) + ',"docs":[');
      }
      let count = 0;
      if (t.dati) {
        if (mongo) {
          const collection = st.client.db(db).collection(t.nome);
          const expected = await collection.countDocuments({}, mongoRead.options);
          const cursor = collection.find({}, { raw: true, ...mongoRead.options }).batchSize(100);
          try {
            for await (const doc of cursor) {
              await send(scriptMongo ? documentoMongosh(doc, t.nome, catalogoMongo.get(t.nome).type === 'timeseries')
                : (count ? ',\n' : '') + JSON.stringify(mongoBson.encode(doc)));
              count++;
              if (count % 100 === 0) progress({ collection: t.nome, rows: rows + count });
            }
          } finally { await cursor.close(); }
          if (count !== expected || count !== await collection.countDocuments({}, mongoRead.options)) throw new Error(`"${t.nome}": conteggio cambiato durante l'export. Ripetere senza scritture concorrenti.`);
        } else {
          const table = `${q(db)}.${q(t.nome)}`;
          // Ogni partizione esporta le proprie righe fisiche. Se si legge
          // anche attraverso il padre si duplicano o si includono foglie escluse.
          const origine = partizioni.has(t.nome) ? 'ONLY ' + table : table;
          const counts = await conn.query(`SELECT COUNT(*) AS total FROM ${origine}`);
          const total = Number(mysql ? counts[0][0].total : counts.rows[0].total);
          // Una tabella vuota non genera INSERT e non richiede una chiave di conflitto.
          if (sql && total > 0 && modoRighe !== 'insert') {
            const chiave = mysql ? m.info.primaria : await chiaveConflittoPg(conn, db, t.nome, modoRighe);
            m.info.scrittura = scritturaRighe(plan.dbType, t.nome, m.info.columns, modoRighe, chiave);
          }
          const references = mysql ? {} : await require('./pg-references').columnReferences((s, p) => conn.query(s, p), db, t.nome);
          if(!mysql)require('./pg-alias').attach(m.info.columns,references);
          const projection = require('./sqlTransfer').projection(m.info, mysql);
          const consume = async row => {
            if (!mysql) require('./pg-references').rowReferences(require('./pg-alias').encode(row,m.info.columns), references, id => { largeObjectIds.add(id); return id; });
            const line = require('./sqlTransfer').encodeRow(row, m.info.columns, mysql);
            await send(sql ? insertSql(plan.dbType, table, line, m.info) : (count ? ',\n' : '') + line);
            count++;
            if (count % 100 === 0) progress({ collection: t.nome, rows: rows + count });
          };
          if (mysql) {
            const stream = conn.connection.query(`SELECT ${projection} FROM ${table}`).stream({ highWaterMark: 100 });
            try { for await (const row of stream) await consume(row); }
            finally { stream.destroy(); }
          } else {
            await conn.query('SET LOCAL search_path TO pg_catalog');
            await conn.query(`DECLARE codedb_export NO SCROLL CURSOR FOR SELECT ${projection} FROM ${origine}`);
            try {
              for (;;) {
                check();
                const page = await conn.query('FETCH FORWARD 100 FROM codedb_export');
                for (const row of page.rows) await consume(row);
                if (!page.rows.length) break;
              }
            } finally { await conn.query('CLOSE codedb_export'); }
          }
          if (count !== total) throw new Error(`"${t.nome}": esportate ${count} righe, attese ${total}.`);
        }
      }
      rows += count;
      if (json) await send(']}');
    }
    if (sql) {
      if (!mongo && plan.dbType === 'postgresql') {
        for await (const object of require('./pg-references').streamLargeObjects((s, p) => conn.query(s, p), largeObjectIds)) {
          await scriviLargeObjectPg(object, sqlPgSuEsistente, send);
        }
      }
      if (plan.dbType === 'mysql') {
        for (const fk of existingFks) {
          const present = fk.coppie.map(p => `c.${q(p.campo)} IS NOT NULL`).join(' AND ');
          const match = fk.coppie.map(p => `p.${q(p.colonna)} = c.${q(p.campo)}`).join(' AND ');
          await send(`INSERT INTO ${guard} SELECT ${letterale(fk.nome, true)} FROM ${q(db)}.${q(fk.table)} c WHERE ${present} AND NOT EXISTS (SELECT 1 FROM ${q(fk.db || db)}.${q(fk.tabella)} p WHERE ${match} LOCK IN SHARE MODE) LIMIT 1;\n`);
        }
        if (existingFks.length) await send(`DROP TEMPORARY TABLE ${guard};\nSET SESSION foreign_key_checks = 1;\n`);
        await send('COMMIT;\n');
      } else if (vincoliNativi) {
        await send('SET CONSTRAINTS ALL IMMEDIATE;\n');
      } else if (existingFks.length) {
        await send('SET CONSTRAINTS ALL IMMEDIATE;\n');
        for (const fk of existingFks) if (!fk.differibile) await send(`ALTER TABLE ${q(db)}.${q(fk.table)} ALTER CONSTRAINT ${q(fk.nome)} NOT DEFERRABLE;\n`);
      }
      // Gli indici specifici delle foglie precedono l'indice padre che li collega.
      const dopoDati = partizioni.size
        ? [...plan.ordine.creazione].reverse().filter(id => meta.has(id)).map(id => meta.get(id))
        : meta.values();
      for (const m of dopoDati) for (const ddl of m.postDdl) await send(ddlAccessoria(ddl, m.name));
      const materializzate = new Set(objects.views.filter(o => o.materialized).map(o => `vista:${o.name}`));
      for (const id of plan.ordine.creazione) if (materializzate.has(id)) await send(`REFRESH MATERIALIZED VIEW ${q(db)}.${q(id.slice('vista:'.length))};\n`);
      for (const field of ['triggers', 'events']) for (const o of objects[field]) {
        const manca = tabelleCondizionali && !mysql && `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=pg_catalog.to_regclass(${literal(q(db) + '.' + q(o.table))}) AND tgname=${literal(o.name)})`;
        await send(ddlCondizionale(tabelleCondizionali && mysql ? seAssenteMySql(o.ddl) : o.ddl, manca));
      }
      for (const value of objects.sequenceValues || []) {
        let sqlValore = value.sql;
        if (sqlPgSuEsistente) {
          const t = tables.find(item => item.nome === value.tabella);
          const nuova = nuoveTabelle.get(value.tabella);
          if (nuova || !t?.struttura) {
            // Su una sequenza esistente si porta avanti anche is_called:
            // a parità di valore, false viene prima di true in entrambi i versi.
            sqlValore += ` FROM ${q(db)}.${q(value.name)} WHERE ${nuova ? nuova + ' OR ' : ''}last_value ${value.crescente ? '<' : '>'} ${value.valore}`
              + (value.chiamata ? ` OR (last_value = ${value.valore} AND NOT is_called)` : '');
          }
        }
        await send(statement(sqlValore, plan.dbType));
      }
      await send(plan.dbType === 'mysql'
        ? 'SET SESSION sql_mode = @codedb_sql_mode, SESSION time_zone = @codedb_time_zone, SESSION foreign_key_checks = @codedb_fk_checks;\n'
        : 'COMMIT;\n');
    } else if (scriptMongo) {
      await send('})();\n');
    } else {
      await send('\n]');
      if (plan.dbType === 'postgresql') {
        await send(',"largeObjects":['); let first=true;
        for await (const object of require('./pg-references').streamLargeObjects((s,p)=>conn.query(s,p),largeObjectIds)) {
          await send((first?'':',')+JSON.stringify({oid:object.oid,size:object.size}).slice(0,-1)+',"chunks":[');first=false;
          let firstChunk=true;
          for await (const bytes of object.chunks) { await send((firstChunk?'':',')+JSON.stringify(bytes.toString('base64')));firstChunk=false; }
          await send(']}');
        }
        await send(']');
      }
      await send('}\n');
    }
    if (started) { await conn.query('COMMIT'); started = false; }
    return { rows, collections: tables.length, views: objects.views.length };
  } finally {
    await mongoRead?.close();
    if (started) await conn.query('ROLLBACK').catch(() => {});
    if (conn) {
      try {
        if (mysqlSession) await conn.query('SET SESSION time_zone = ?, SESSION sql_mode = ?', [mysqlSession.timezone, mysqlSession.mode]);
        conn.release();
      } catch (err) { conn.destroy(); throw err; }
    }
  }
}

function statement(ddl, type) {
  const text = String(ddl).trim().replace(/;+$/, '');
  if (type !== 'mysql' || !/\b(PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i.test(text)) return text + ';\n';
  // DELIMITER è una direttiva del client mysql, non SQL inviato al DBMS.
  let delimiter = '$codedb$';
  while (text.includes(delimiter)) delimiter += '$';
  return `DELIMITER ${delimiter}\n${text}${delimiter}\nDELIMITER ;\n`;
}

module.exports = { esportaDatabase, oggettiSelezionati, insertSql, scritturaRighe, letterale, statement };
