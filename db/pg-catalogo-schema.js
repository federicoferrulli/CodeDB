'use strict';

const DbStrategy = require('./DbStrategy');
const { tipoDaCatalogo } = require('./pg-valori');
const { raggruppaVincoli } = require('./relazioni');
const { quotaSempre, quotaQualificato } = require('./identificatori');
const { isPostgresGeometryType, isPostgresNativeGeometryType } = require('./geometry');
const { definisciMetodi } = require('./prototipoStrategia');
const { creaIndiceSql, pianificaDuplicatoSql } = require('./sqlCatalogoComune');

const DEFAULT_SCHEMA = 'public';

function schemaOf(db) {
  const s = String(db == null ? '' : db).trim();
  return s || DEFAULT_SCHEMA;
}

function qid(name) {
  return quotaSempre(name, 'postgresql');
}

function qtable(db, table) {
  return quotaQualificato([schemaOf(db), table], 'postgresql');
}

const SERIAL_PER_TIPO = {
  smallint: 'smallserial',
  integer: 'serial',
  bigint: 'bigserial',
};

function defaultSql(v) {
  const t = String(v).trim();
  if (/^(NULL|CURRENT_TIMESTAMP(\(\d*\))?|NOW\(\)|TRUE|FALSE)$/i.test(t)) return t.toUpperCase();
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  return `'${t.replace(/'/g, "''")}'`;
}

function columnSql(c) {
  const name = String((c && c.name) || '').trim();
  let type = String((c && c.type) || '').trim();
  if (!name || !type) throw new Error('Ogni colonna deve avere nome e tipo.');
  DbStrategy.assertColumnType(type);

  if (c.autoIncrement) {
    if (/bigint/i.test(type)) type = 'BIGSERIAL';
    else if (/int/i.test(type)) type = 'SERIAL';
  }

  let s = `${qid(name)} ${type}`;
  if (c.nullable === false) s += ' NOT NULL';
  if (c.default != null && String(c.default).trim() !== '' && !c.autoIncrement) {
    s += ` DEFAULT ${defaultSql(c.default)}`;
  }
  return s;
}

/**
 * Dialetto PostgreSQL per i metadati comuni (`db/sqlMetadati.js`).
 */
const DIALETTO_METADATI = {
  qid,
  segnaposto: (n) => `$${n}`,
  schema: schemaOf,
  esegui: async (strategia, sql, params) => (
    await (params === undefined ? strategia.requirePool().query(sql) : strategia.requirePool().query(sql, params))
  ).rows,

  chiavePrimaria: {
    query: (db, table) => ({
      sql: `SELECT kcu.column_name AS name
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
               AND tc.table_schema = kcu.table_schema
             WHERE tc.constraint_type = 'PRIMARY KEY'
               AND tc.table_schema = $2
               AND tc.table_name = $1
          ORDER BY kcu.ordinal_position`,
      params: [table, schemaOf(db)],
    }),
  },

  colonne: {
    tentativi: (db, coll) => [{
      sql: `WITH RECURSIVE colonne AS (
              SELECT a.attname, a.atttypid, a.atttypmod, a.attndims
                FROM pg_catalog.pg_attribute a
                JOIN pg_catalog.pg_class t ON t.oid = a.attrelid
                JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
               WHERE n.nspname = $1 AND t.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
            ), tipi AS (
              SELECT attname, atttypid AS oid, 0 AS depth FROM colonne
              UNION ALL
              SELECT p.attname, CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.typelem END, p.depth + 1
                FROM tipi p JOIN pg_catalog.pg_type t ON t.oid = p.oid
               WHERE p.depth < 32 AND (t.typtype = 'd' OR t.typcategory = 'A')
                 AND CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.typelem END <> 0
            )
            SELECT c.column_name AS name, c.udt_name AS type, c.is_nullable AS nullable,
                   c.is_generated AS generated,
                   pg_catalog.format_type(a.atttypid, a.atttypmod) AS "declaredType", a.attndims AS dimensions,
                   (SELECT json_agg(json_build_object('oid', t.oid, 'name', t.typname, 'schema', n.nspname,
                            'kind', t.typtype, 'category', t.typcategory, 'base', t.typbasetype,
                            'element', t.typelem, 'delimiter', t.typdelim, 'dimensions', t.typndims,
                            'array', EXISTS (SELECT 1 FROM pg_catalog.pg_type element WHERE element.oid = t.typelem AND element.typarray = t.oid)) ORDER BY p.depth)
                      FROM tipi p JOIN pg_catalog.pg_type t ON t.oid = p.oid
                      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
                     WHERE p.attname = c.column_name) AS type_nodes
              FROM information_schema.columns c JOIN colonne a ON a.attname = c.column_name
             WHERE c.table_schema = $1 AND c.table_name = $2
          ORDER BY c.ordinal_position`,
      params: [schemaOf(db), coll],
    }],
    generato: (r) => String(r.generated || '') === 'ALWAYS',
    dettagli: (r) => ({ pgType: tipoDaCatalogo(r.type_nodes, r.dimensions) }),
    classi: [
      { nome: 'geo', riconosce: isPostgresGeometryType },
      { nome: 'geoNativo', riconosce: isPostgresNativeGeometryType },
    ],
    arricchisci: async (strategia, info, db, coll) => {
      if (!info.geo.size) return;
      for (const c of info.geo.values()) c.erroreSrid = true;
      try {
        const srid = await strategia.requirePool().query(
          `SELECT f_geometry_column AS name, srid, type AS geotipo, 'geometry' AS kind
             FROM geometry_columns WHERE f_table_schema = $1 AND f_table_name = $2
            UNION ALL
           SELECT f_geography_column AS name, srid, type AS geotipo, 'geography' AS kind
             FROM geography_columns WHERE f_table_schema = $1 AND f_table_name = $2`,
          [schemaOf(db), coll]
        );
        for (const r of srid.rows) {
          const c = info.geo.get(r.name);
          if (!c) continue;
          c.srid = r.srid == null ? null : Number(r.srid);
          c.erroreSrid = false;
          c.kind = r.kind;
          c.geoTipo = r.geotipo == null ? null : String(r.geotipo);
        }
      } catch {
        for (const c of info.geo.values()) c.erroreSrid = true;
      }
    },
  },

  campi: {
    query: (db, table) => ({
      sql: `SELECT c.column_name AS name,
                   pg_catalog.format_type(a.atttypid, a.atttypmod) AS ctype,
                   c.is_nullable AS nullable,
                   c.column_default AS cdefault,
                   c.is_identity AS identity,
                   c.identity_generation,
                   c.is_generated AS generated,
                   c.generation_expression AS "generationExpression",
                   a.attgenerated AS "generationCode",
                   CASE WHEN a.attcollation<>ty.typcollation THEN a.attcollation::regcollation::text END AS collation,
                   pg_catalog.format_type(COALESCE(NULLIF(ty.typbasetype, 0), ty.oid), NULL) AS base_type,
                   (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e
                     WHERE e.enumtypid = COALESCE(NULLIF(ty.typbasetype, 0), ty.oid)) AS enum_values
              FROM information_schema.columns c
              JOIN pg_catalog.pg_namespace n ON n.nspname = c.table_schema
              JOIN pg_catalog.pg_class t ON t.relnamespace = n.oid AND t.relname = c.table_name
              JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid
                                            AND a.attname = c.column_name
                                            AND a.attnum > 0
                                            AND NOT a.attisdropped
              JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid
             WHERE c.table_schema = $2 AND c.table_name = $1
          ORDER BY c.ordinal_position`,
      params: [table, schemaOf(db)],
    }),
    tipo: (c) => String(c.ctype || 'varchar'),
    dettagli: (c) => ({
      baseType: c.base_type,
      enumValues: c.enum_values,
      identityGeneration: c.identity_generation,
      generationExpression: c.generationExpression == null ? null : String(c.generationExpression),
      generationKind: c.generationCode === 's' ? 'STORED' : (c.generationCode === 'v' ? 'VIRTUAL' : null),
      ...(c.collation ? { collation: c.collation } : {}),
    }),
    autoIncrement: (c) => /nextval/i.test(String(c.cdefault || '')) || String(c.identity || '') === 'YES',
    generato: (c) => String(c.generated || '') === 'ALWAYS',
    chiaveDallaPrimaria: true,
    chiave: (c, pkSet) => (pkSet.has(c.name) ? 'PRI' : ''),
  },

  indici: {
    query: (db, table) => ({
      sql: `SELECT i.relname AS name, ix.indisunique AS unico, ix.indisprimary AS primaria,
                   a.attname AS colonna, k.ord
              FROM pg_catalog.pg_class t
              JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
              JOIN pg_catalog.pg_index ix ON ix.indrelid = t.oid
              JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
              JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
              LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
             WHERE n.nspname = $2 AND t.relname = $1
          ORDER BY i.relname, k.ord`,
      params: [table, schemaOf(db)],
    }),
    lettori: {
      nome: (r) => r.name,
      colonna: (r) => r.colonna,
      ordine: (r) => r.ord,
      unico: (r) => r.unico,
      primario: (r) => r.primaria,
    },
  },

  stima: {
    query: (db, coll) => ({
      sql: `SELECT c.reltuples::bigint AS n
              FROM pg_class c
              JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
             WHERE c.relname = $1
               AND c.relkind = 'r'
               AND nsp.nspname = $2
             LIMIT 1`,
      params: [coll, schemaOf(db)],
    }),
    attendibile: (n) => n >= 0,
  },
};

const DIALETTO_DUPLICA_PG = {
  qid,
  qtable,
  segnaposto: DIALETTO_METADATI.segnaposto,
  esegui: DIALETTO_METADATI.esegui,
};

/**
 * Installa su `PostgreSqlStrategy.prototype` le operazioni di catalogo, DDL,
 * relazioni UML/griglia, indici, statistiche e piano di duplicazione.
 */
function installaCatalogoPg(prototipo) {
  return definisciMetodi(prototipo, {
    async conSearchPath(schema, fn) {
      const pool = this.requirePool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        try {
          await client.query(`SET LOCAL search_path TO ${qid(schema)}`);
          return await fn(client);
        } finally {
          await client.query('ROLLBACK').catch(() => {});
        }
      } finally {
        client.release();
      }
    },

    async tableDdl(db, coll) {
      const schema = schemaOf(db);
      const fields = await this.tableFields(db, coll);
      if (!fields.length) return null;

      const ident = await this.conSearchPath(schema, (client) => client.query(
        `SELECT column_name AS name, identity_generation AS generation
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND is_identity = 'YES'`,
        [schema, coll]
      ));
      const identita = new Map(ident.rows.map((r) => [r.name, String(r.generation || 'BY DEFAULT')]));

      const colDefs = fields.map((f) => {
        if (f.generated) {
          return require('./pg-ddl').pgGeneratedDdl({
            name: f.name,
            type: f.types[0],
            expression: f.generationExpression,
            kind: f.generationKind,
            nullable: f.nullable,
            collation: f.collation,
          });
        }
        const generation = identita.get(f.name);
        if (generation) {
          return `${qid(f.name)} ${f.types[0]} GENERATED ${generation} AS IDENTITY`;
        }
        const seriale = f.default != null && /\bnextval\s*\(/i.test(f.default)
          ? SERIAL_PER_TIPO[String(f.types[0] || '').toLowerCase()]
          : null;
        if (seriale) {
          let def = `${qid(f.name)} ${seriale}`;
          if (!f.nullable) def += ' NOT NULL';
          return def;
        }
        let def = `${qid(f.name)} ${f.types[0]}`;
        if (f.collation) def += ` COLLATE ${f.collation}`;
        if (!f.nullable) def += ' NOT NULL';
        if (f.default != null) def += ` DEFAULT ${f.default}`;
        return def;
      });

      const vincoli = await this.conSearchPath(schema, (client) => client.query(
        `SELECT pg_catalog.pg_get_constraintdef(c.oid) AS def
           FROM pg_catalog.pg_constraint c
           JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = $2 AND c.contype IN ('p', 'u', 'c')
       ORDER BY c.contype DESC, c.conname`,
        [schema, coll]
      ));
      for (const r of vincoli.rows) colDefs.push(String(r.def));

      return `CREATE TABLE ${qid(coll)} (\n  ${colDefs.join(',\n  ')}\n);`;
    },

    async tableAuxDdl(db, coll) {
      const schema = schemaOf(db);
      return this.conSearchPath(schema, (client) => require('./pg-ddl').pgAuxDdl(
        (sql, params) => client.query(sql, params),
        schema,
        coll
      ));
    },

    async dbSchema(db) {
      const pool = this.requirePool();
      const schema = schemaOf(db);
      const tablesRes = await pool.query(
        `SELECT t.table_name, c.reltuples::bigint AS approx_rows
           FROM information_schema.tables t
           LEFT JOIN pg_class c ON c.relname = t.table_name
            AND c.relnamespace = to_regnamespace(t.table_schema)::oid
          WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_name`,
        [schema]
      );

      const columnsRes = await pool.query(
        `SELECT table_name, column_name, data_type, udt_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
        [schema]
      );

      const colsByTable = new Map();
      for (const row of columnsRes.rows) {
        if (!colsByTable.has(row.table_name)) colsByTable.set(row.table_name, []);
        const typeName = row.data_type === 'USER-DEFINED' ? row.udt_name : (row.data_type || row.udt_name || 'varchar');
        colsByTable.get(row.table_name).push({
          name: row.column_name,
          types: [typeName],
          presence: row.is_nullable === 'YES' ? 0 : 100,
          nullable: row.is_nullable === 'YES',
        });
      }

      const collections = tablesRes.rows.map((t) => ({
        name: t.table_name,
        fields: colsByTable.get(t.table_name) || [],
        rowsApprox: t.approx_rows == null || Number(t.approx_rows) < 0 ? null : Number(t.approx_rows),
      }));

      const fkRes = await pool.query(
        `SELECT tc.constraint_name, kcu.ordinal_position, kcu.table_name, kcu.column_name,
                rcu.table_schema AS referenced_table_schema,
                rcu.table_name AS referenced_table_name,
                rcu.column_name AS referenced_column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.referential_constraints rc
             ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
           JOIN information_schema.key_column_usage rcu
             ON rcu.constraint_name = rc.unique_constraint_name
            AND rcu.constraint_schema = rc.unique_constraint_schema
            AND rcu.ordinal_position = kcu.position_in_unique_constraint
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
       ORDER BY tc.constraint_name, kcu.ordinal_position`,
        [schema]
      );

      const relations = [];
      const fkSet = new Set();
      for (const fk of fkRes.rows) {
        relations.push({
          from: fk.table_name,
          field: fk.column_name,
          to: fk.referenced_table_name,
          toDb: fk.referenced_table_schema || schema,
          external: !!fk.referenced_table_schema && fk.referenced_table_schema !== schema,
          many: true,
          constraint: fk.constraint_name,
          ordine: Number(fk.ordinal_position) || 1,
          toField: fk.referenced_column_name,
          origine: 'vincolo',
        });
        fkSet.add(`${fk.table_name}.${fk.column_name}->${fk.referenced_table_name}`);
      }

      const detected = DbStrategy.detectRelations(collections);
      for (const r of detected) {
        const key = `${r.from}.${r.field}->${r.to}`;
        if (!fkSet.has(key)) relations.push(r);
      }

      return { collections, relations };
    },

    async columnRelations(db, coll) {
      const pool = this.requirePool();
      const schema = schemaOf(db);
      const res = await pool.query(
        `SELECT tc.constraint_name, kcu.ordinal_position, kcu.column_name,
                rc.delete_rule, rc.update_rule,
                rcu.table_schema AS referenced_table_schema,
                rcu.table_name   AS referenced_table_name,
                rcu.column_name  AS referenced_column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.referential_constraints rc
             ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
           JOIN information_schema.key_column_usage rcu
             ON rcu.constraint_name = rc.unique_constraint_name
            AND rcu.constraint_schema = rc.unique_constraint_schema
            AND rcu.ordinal_position = kcu.position_in_unique_constraint
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
       ORDER BY tc.constraint_name, kcu.ordinal_position`,
        [schema, coll]
      );
      return raggruppaVincoli(res.rows.map((r) => ({
        nome: r.constraint_name,
        onDelete: r.delete_rule,
        onUpdate: r.update_rule,
        ordine: r.ordinal_position,
        campo: r.column_name,
        db: r.referenced_table_schema || schema,
        tabella: r.referenced_table_name,
        colonna: r.referenced_column_name,
      })));
    },

    async primaryKeyName(db, coll) {
      const res = await this.requirePool().query(
        `SELECT c.conname FROM pg_catalog.pg_constraint c
         JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'p'`,
        [schemaOf(db), coll]
      );
      return res.rows[0]?.conname || null;
    },

    async createCollection(db, name, payload = {}) {
      const pool = this.requirePool();
      const table = String(name || '').trim();
      if (!table) throw new Error('Nome della tabella mancante.');
      DbStrategy.assertCreatableName(table, 'della tabella');
      const cols = Array.isArray(payload.columns) ? payload.columns : [];
      let defs;
      if (!cols.length) {
        defs = [`${qid('id')} SERIAL PRIMARY KEY`];
      } else {
        defs = cols.map(columnSql);
        const pk = cols.filter((c) => c.primaryKey).map((c) => qid(String(c.name).trim()));
        if (pk.length) defs.push(`PRIMARY KEY (${pk.join(', ')})`);
      }
      await pool.query(`CREATE TABLE ${qtable(db, table)} (${defs.join(', ')})`);
    },

    async renameCollection(db, coll, newName) {
      const pool = this.requirePool();
      const to = String(newName || '').trim();
      if (!to) throw new Error('Nuovo nome della tabella mancante.');
      DbStrategy.assertCreatableName(to, 'della tabella');
      await pool.query(`ALTER TABLE ${qtable(db, coll)} RENAME TO ${qid(to)}`);
      this._cacheColonne.clear();
    },

    async dropCollection(db, coll) {
      const pool = this.requirePool();
      await pool.query(`DROP TABLE ${qtable(db, coll)}`);
      this._cacheColonne.clear();
    },

    async addColumn(db, coll, column) {
      const pool = this.requirePool();
      await pool.query(`ALTER TABLE ${qtable(db, coll)} ADD COLUMN ${columnSql(column || {})}`);
      this._cacheColonne.clear();
    },

    async alterColumn(db, coll, payload) {
      const pool = this.requirePool();
      const oldName = String((payload && payload.oldName) || '').trim();
      if (!oldName) throw new Error('Nome della colonna da modificare mancante.');
      const col = payload.column || {};
      const newName = String(col.name || '').trim();
      const type = String(col.type || '').trim();
      if (!newName) throw new Error('Nome della colonna mancante.');
      if (type) DbStrategy.assertColumnType(type);
      if (newName !== oldName) DbStrategy.assertCreatableName(newName, 'della colonna');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query(
          `SELECT column_default
             FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
          [schemaOf(db), coll, oldName]
        );
        if (!current.rowCount) throw new Error(`La colonna "${oldName}" non esiste nella tabella "${coll}".`);
        const currentDefault = current.rows[0].column_default == null
          ? '' : String(current.rows[0].column_default).trim();

        if (newName && newName !== oldName) {
          await client.query(`ALTER TABLE ${qtable(db, coll)} RENAME COLUMN ${qid(oldName)} TO ${qid(newName)}`);
        }

        const targetName = newName || oldName;
        if (type) {
          await client.query('SAVEPOINT codedb_tipo_colonna');
          try {
            await client.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} TYPE ${type}`);
            await client.query('RELEASE SAVEPOINT codedb_tipo_colonna');
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT codedb_tipo_colonna');
            if (/cannot be cast automatically/i.test(err.message || '')) {
              await client.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} TYPE ${type} USING ${qid(targetName)}::${type}`);
            } else {
              throw err;
            }
          }
        }
        if (col.nullable === false) {
          await client.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} SET NOT NULL`);
        } else if (col.nullable === true) {
          await client.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} DROP NOT NULL`);
        }

        if (Object.prototype.hasOwnProperty.call(col, 'default')) {
          const requestedDefault = String(col.default == null ? '' : col.default).trim();
          if (requestedDefault !== currentDefault) {
            const clause = requestedDefault
              ? `SET DEFAULT ${defaultSql(requestedDefault)}`
              : 'DROP DEFAULT';
            await client.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} ${clause}`);
          }
        }

        await client.query('COMMIT');
        this._cacheColonne.clear();
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async dropColumn(db, coll, name) {
      const pool = this.requirePool();
      const column = String(name || '').trim();
      if (!column) throw new Error('Nome della colonna da eliminare mancante.');
      await pool.query(`ALTER TABLE ${qtable(db, coll)} DROP COLUMN ${qid(column)}`);
      this._cacheColonne.clear();
    },

    async createIndex(db, coll, payload) {
      return creaIndiceSql(this, DIALETTO_DUPLICA_PG, db, coll, payload);
    },

    async dropIndex(db, coll, name) {
      const pool = this.requirePool();
      const idx = String(name || '').trim();
      if (!idx) throw new Error('Nome dell\'indice da eliminare mancante.');
      const table = String(coll || '').trim();
      if (!table) throw new Error('Tabella proprietaria dell\'indice mancante.');
      const schema = schemaOf(db);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL lock_timeout = \'10s\'');
        await client.query(`LOCK TABLE ${qtable(schema, table)} IN ACCESS EXCLUSIVE MODE`);
        const found = await client.query(
          `SELECT 1
             FROM pg_catalog.pg_class i
             JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
             JOIN pg_catalog.pg_index x ON x.indexrelid = i.oid
             JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
            WHERE n.nspname = $1 AND i.relname = $2 AND t.relname = $3`,
          [schema, idx, table]
        );
        if (!found.rowCount) {
          throw new Error('L\'indice indicato non appartiene alla tabella selezionata.');
        }
        await client.query(`DROP INDEX ${qid(schema)}.${qid(idx)}`);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async indexList(db, table) {
      const indici = await this.elencoIndici(db, table);
      return indici.map((i) => ({
        name: i.name,
        key: Object.fromEntries(i.columns.map((c) => [c, 1])),
        unique: i.unique,
        primary: i.primary,
      }));
    },

    async duplicatePlan(db, coll, payload) {
      return pianificaDuplicatoSql(this, DIALETTO_DUPLICA_PG, db, coll, payload);
    },

    async collectionStats(db, coll) {
      const pool = this.requirePool();
      const countRes = await pool.query(`SELECT COUNT(*) AS total FROM ${qtable(db, coll)}`);
      const count = Number(countRes.rows[0]?.total) || 0;

      const sizeRes = await pool.query(
        `SELECT pg_relation_size($1::regclass) AS data_size, pg_total_relation_size($1::regclass) AS total_size`,
        [qtable(db, coll)]
      );
      const dataSize = Number(sizeRes.rows[0]?.data_size) || 0;
      const totalSize = Number(sizeRes.rows[0]?.total_size) || 0;

      const indexes = await this.indexList(db, coll);
      const fields = await this.tableFields(db, coll);

      return {
        stats: {
          count,
          size: dataSize,
          storageSize: totalSize,
          avgObjSize: count > 0 ? Math.round(dataSize / count) : 0,
          totalIndexSize: totalSize - dataSize,
          nindexes: indexes.length,
        },
        indexes,
        fields,
        sampled: count,
      };
    },
  });
}

module.exports = {
  DEFAULT_SCHEMA,
  schemaOf,
  DIALETTO_METADATI,
  defaultSql,
  columnSql,
  installaCatalogoPg,
};
