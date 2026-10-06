'use strict';

// Un solo esecutore per i due formati: il piano decide il perimetro, il sink
// riceve piccoli blocchi e pubblica il file soltanto dopo tutte le verifiche.
const { Binary } = require('bson');
const { randomUUID } = require('crypto');
const { quotaSempre } = require('./identificatori');
const { readSchemaObjects } = require('./schemaObjects');
const { verificaImpronta } = require('./pianoComune');
const { splitMySqlForeignKeys } = require('../backup/lib/engine');
const { pgCreateTable, pgAuxDdl, pgColonne } = require('./pg-ddl');
const { scegliIdentitaSql } = require('../backup/lib/identity');
const { riferimentiChiaveEsterna } = require('./artefatti');
const { stringifyRiga } = require('./codecFedele');
const { deserializeClientObject } = require('./sqlValori');
const MySqlStrategy = require('./MySqlStrategy');
const PostgreSqlStrategy = require('./PostgreSqlStrategy');

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

function insertSql(dbType, table, line, info) {
  const mysql = dbType === 'mysql';
  const row = deserializeClientObject(JSON.parse(line));
  const cols = Object.keys(row);
  if (!cols.length) return mysql ? `INSERT INTO ${table} () VALUES ();\n` : `INSERT INTO ${table} DEFAULT VALUES;\n`;
  const vals = cols.map(c => {
    const b = mysql
      ? MySqlStrategy.geoBinding(c, row[c], info.geo, { importazione: true })
      : PostgreSqlStrategy.geoBinding(c, row[c], info.geo, '$1', info.geoNativo);
    // Sostituzione con callback: un "$&" nei dati non è una direttiva replace.
    return b.sql.replace(mysql ? /\?/ : /\$1\b/, () => letterale(b.param, mysql));
  });
  const overriding = !mysql && info.columns.some(c => c.identity === 'ALWAYS' || c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : '';
  return `INSERT INTO ${table} (${cols.map(c => quotaSempre(c, dbType)).join(', ')})${overriding} VALUES (${vals.join(', ')});\n`;
}

async function esportaDatabase({ strategy, plan, write, progress = () => {}, check = () => {} }) {
  verificaImpronta(plan);
  if (!['codedb-json', 'sql'].includes(plan.formato)) throw new Error('Formato di export non supportato.');
  const mongo = plan.dbType === 'mongodb';
  if (mongo && plan.formato === 'sql') throw new Error('Un database MongoDB richiede il formato EJSON; SQL non ne conserva documenti e indici.');
  if (plan.oggetti.some(o => o.filtro)) throw new Error('Il piano contiene filtri non eseguibili da questo export.');
  const sql = plan.formato === 'sql';
  const db = plan.sourceDb;
  const q = n => quotaSempre(n, plan.dbType);
  const tables = plan.oggetti.filter(o => o.tipo === 'tabella' || o.tipo === 'collection');
  const existingFks = [];
  const guard = q(`codedb_verifica_fk_${randomUUID().replace(/-/g, '')}`);
  let conn;
  let mysqlSession;
  let st = strategy;
  let started = false;
  let rows = 0;
  const send = async text => { check(); await write(text); };
  try {
    if (!mongo) {
      const mysql = plan.dbType === 'mysql';
      conn = mysql ? await strategy.pool.getConnection() : await strategy.pool.connect();
      st = mysql ? new MySqlStrategy() : new PostgreSqlStrategy();
      const borrowed = { query: (...args) => conn.query(...args), release() {} };
      st.pool = { ...borrowed, getConnection: async () => borrowed, connect: async () => borrowed };
      if (mysql) {
        if (sql) {
          const [[session]] = await conn.query('SELECT @@SESSION.time_zone AS timezone, @@SESSION.sql_mode AS mode');
          mysqlSession = session;
          await conn.query("SET SESSION time_zone = '+00:00', SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO,STRICT_ALL_TABLES'");
        }
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
    const allObjects = await readSchemaObjects(st, plan.dbType, db);
    const objects = oggettiSelezionati(allObjects, plan);
    for (const o of plan.oggetti.filter(o => o.struttura && !['tabella', 'collection'].includes(o.tipo))) {
      const field = Object.keys(TIPI_OGGETTO).find(k => TIPI_OGGETTO[k] === o.tipo);
      if (!field || !objects[field].some(item => item.name === o.nome)) {
        throw new Error(`L'oggetto "${o.nome}" non esiste più: ricreare il piano di export.`);
      }
    }
    if (mongo) {
      const names = new Set((await st.client.db(db).listCollections().toArray()).filter(o => o.type !== 'view').map(o => o.name));
      for (const t of tables) if (!names.has(t.nome)) throw new Error(`La collection "${t.nome}" non esiste più.`);
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
    }
    const meta = new Map();
    for (const t of tables) {
      check();
      let ddl = null, indexes = null, postDdl = [];
      let info = null;
      let identity = mongo ? { kind: 'mongodb-id', columns: ['_id'] } : null;
      if (mongo) {
        // La lettura degli indici è obbligatoria: nessun catch che inventa [].
        if (t.struttura) indexes = (await st.client.db(db).collection(t.nome).indexes()).filter(i => i.name !== '_id_');
      } else {
        info = await st.tableColumnsInfo(db, t.nome);
        const primary = await st.primaryKey(db, t.nome);
        const uniques = await st.uniqueIndexes(db, t.nome);
        identity = scegliIdentitaSql(info.columns, [
          ...(primary.length ? [{ kind: 'primary-key', name: 'PRIMARY', columns: primary }] : []),
          ...uniques.map((columns, i) => ({ kind: 'unique', name: `unique_${i}`, columns })),
        ]);
        if (plan.dbType === 'postgresql') info.columns = await pgColonne((s, p) => conn.query(s, p), db, t.nome);
        if (sql && t.dati && !t.struttura) {
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
            ddl = await pgCreateTable((s, p) => conn.query(s, p), db, t.nome);
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
      for (const [id, m] of meta) if (m.ddl) statements.set(id, m.ddl);
      for (const [field, type] of Object.entries(TIPI_OGGETTO)) {
        for (const o of objects[field] || []) if (o.ddl) {
          statements.set(`${type}:${o.name}`, o.materialized ? o.ddl.trim().replace(/;+$/, '') + ' WITH NO DATA' : o.ddl);
        }
      }
      // Le viste esistono già per le routine che le riferiscono; quelle
      // materializzate si popolano solo dopo il caricamento delle tabelle.
      for (const id of plan.ordine.creazione) {
        if (/^(trigger|evento):/.test(id)) continue;
        const ddl = statements.get(id);
        if (ddl) await send(statement(ddl, plan.dbType));
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
      } else if (existingFks.length) {
        // Anche cicli e autorelazioni si controllano dopo tutte le righe.
        // La differibilità originale viene ripristinata nella stessa transazione.
        for (const fk of existingFks) if (!fk.differibile) await send(`ALTER TABLE ${q(db)}.${q(fk.table)} ALTER CONSTRAINT ${q(fk.nome)} DEFERRABLE;\n`);
        await send('SET CONSTRAINTS ALL DEFERRED;\n');
      }
    } else {
      await send(JSON.stringify({ formato: 'codedb-database', versione: 1, generatore: 'CodeDB', dbType: plan.dbType, db,
        creato: new Date().toISOString(), consistenza: plan.consistenza, objects }).slice(0, -1) + ',"collections":[\n');
    }
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i], m = meta.get(t.id);
      if (!sql) {
        const { info: _info, ...header } = m;
        await send((i ? ',\n' : '') + JSON.stringify(header).slice(0, -1) + ',"docs":[');
      }
      let count = 0;
      if (t.dati) {
        if (mongo) {
          const collection = st.client.db(db).collection(t.nome);
          const expected = await collection.countDocuments({});
          const cursor = collection.find({}, { promoteValues: false }).batchSize(100);
          try {
            for await (const doc of cursor) {
              await send((count ? ',\n' : '') + stringifyRiga(doc));
              count++;
              if (count % 100 === 0) progress({ collection: t.nome, rows: rows + count });
            }
          } finally { await cursor.close(); }
          if (count !== expected || count !== await collection.countDocuments({})) throw new Error(`"${t.nome}": conteggio cambiato durante l'export. Ripetere senza scritture concorrenti.`);
        } else {
          const mysql = plan.dbType === 'mysql';
          const table = `${q(db)}.${q(t.nome)}`;
          const counts = await conn.query(`SELECT COUNT(*) AS total FROM ${table}`);
          const total = Number(mysql ? counts[0][0].total : counts.rows[0].total);
          const columns = m.info.columns.filter(c => !c.generated);
          const projection = columns.map(c => {
            const id = q(c.name);
            const type = String(c.type || c.ctype || '').toLowerCase();
            if (m.info.geo.has(c.name)) return `ST_AsGeoJSON(${id}${mysql ? ', 17, 2' : ''}) AS ${id}`;
            if (mysql && /^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bit)\b/.test(type)) return id;
            // Il testo prodotto dal DBMS conserva precisione, microsecondi,
            // array e JSON: non passa dalle conversioni lossy del driver.
            return mysql ? `CAST(${id} AS CHAR CHARACTER SET utf8mb4) AS ${id}` : `${id}::text AS ${id}`;
          }).join(', ') || '1 AS __codedb_vuota';
          const consume = async row => {
            if (!columns.length) delete row.__codedb_vuota;
            (mysql ? MySqlStrategy : PostgreSqlStrategy).geoRowsToJson([row], m.info.geo, m.info.geoNativo);
            for (const c of columns) if (Buffer.isBuffer(row[c.name])) row[c.name] = new Binary(row[c.name]);
            const line = stringifyRiga(row);
            await send(sql ? insertSql(plan.dbType, q(t.nome), line, m.info) : (count ? ',\n' : '') + line);
            count++;
            if (count % 100 === 0) progress({ collection: t.nome, rows: rows + count });
          };
          if (mysql) {
            const stream = conn.connection.query(`SELECT ${projection} FROM ${table}`).stream({ highWaterMark: 100 });
            try { for await (const row of stream) await consume(row); }
            finally { stream.destroy(); }
          } else {
            await conn.query(`DECLARE codedb_export NO SCROLL CURSOR FOR SELECT ${projection} FROM ${table}`);
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
      if (!sql) await send(']}');
    }
    if (sql) {
      if (plan.dbType === 'mysql') {
        for (const fk of existingFks) {
          const present = fk.coppie.map(p => `c.${q(p.campo)} IS NOT NULL`).join(' AND ');
          const match = fk.coppie.map(p => `p.${q(p.colonna)} = c.${q(p.campo)}`).join(' AND ');
          await send(`INSERT INTO ${guard} SELECT ${letterale(fk.nome, true)} FROM ${q(db)}.${q(fk.table)} c WHERE ${present} AND NOT EXISTS (SELECT 1 FROM ${q(fk.db || db)}.${q(fk.tabella)} p WHERE ${match} LOCK IN SHARE MODE) LIMIT 1;\n`);
        }
        if (existingFks.length) await send(`DROP TEMPORARY TABLE ${guard};\nSET SESSION foreign_key_checks = 1;\n`);
        await send('COMMIT;\n');
      } else if (existingFks.length) {
        await send('SET CONSTRAINTS ALL IMMEDIATE;\n');
        for (const fk of existingFks) if (!fk.differibile) await send(`ALTER TABLE ${q(db)}.${q(fk.table)} ALTER CONSTRAINT ${q(fk.nome)} NOT DEFERRABLE;\n`);
      }
      for (const m of meta.values()) for (const ddl of m.postDdl) await send(statement(ddl, plan.dbType));
      const materializzate = new Set(objects.views.filter(o => o.materialized).map(o => `vista:${o.name}`));
      for (const id of plan.ordine.creazione) if (materializzate.has(id)) await send(`REFRESH MATERIALIZED VIEW ${q(db)}.${q(id.slice('vista:'.length))};\n`);
      for (const field of ['triggers', 'events']) for (const o of objects[field]) await send(statement(o.ddl, plan.dbType));
      for (const value of objects.sequenceValues || []) await send(statement(value.sql, plan.dbType));
      await send(plan.dbType === 'mysql'
        ? 'SET SESSION sql_mode = @codedb_sql_mode, SESSION time_zone = @codedb_time_zone, SESSION foreign_key_checks = @codedb_fk_checks;\n'
        : 'COMMIT;\n');
    } else await send('\n]}\n');
    if (started) { await conn.query('COMMIT'); started = false; }
    return { rows, collections: tables.length };
  } finally {
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

module.exports = { esportaDatabase, oggettiSelezionati, insertSql, letterale, statement };
