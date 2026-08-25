'use strict';

const { EJSON } = require('bson');

const MANIFEST_VERSION = 2;
const SQL_IDENTITY_KINDS = new Set(['primary-key', 'unique']);
const IDENTITY_KINDS = new Set(['mongodb-id', ...SQL_IDENTITY_KINDS]);

const MYSQL_IDENTITY_SQL = `SELECT tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS ctype,
            kcu.COLUMN_NAME AS col, kcu.ORDINAL_POSITION AS pos
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.KEY_COLUMN_USAGE kcu
         ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND kcu.TABLE_NAME = tc.TABLE_NAME
        AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
        AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
   ORDER BY CASE tc.CONSTRAINT_TYPE WHEN 'PRIMARY KEY' THEN 0 ELSE 1 END,
            tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`;

const POSTGRES_IDENTITY_SQL = `SELECT tc.constraint_name AS name, tc.constraint_type AS ctype,
            kcu.column_name AS col, kcu.ordinal_position AS pos
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_catalog = tc.constraint_catalog
        AND kcu.constraint_schema = tc.constraint_schema
        AND kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
        AND kcu.table_name = tc.table_name
      WHERE tc.table_schema = $2 AND tc.table_name = $1
        AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
   ORDER BY CASE tc.constraint_type WHEN 'PRIMARY KEY' THEN 0 ELSE 1 END,
            tc.constraint_name, kcu.ordinal_position`;

function normalizzaColonna(c) {
  return {
    name: String(c && c.name || ''),
    nullable: c && (c.nullable === true || String(c.nullable).toUpperCase() === 'YES'),
  };
}

/** Sceglie la promessa di unicita piu forte utilizzabile da tutti i layer. */
function scegliIdentitaSql(columns, constraints) {
  const cols = new Map((columns || []).map(normalizzaColonna).map((c) => [c.name, c]));
  const candidate = (constraints || [])
    .filter((c) => c && SQL_IDENTITY_KINDS.has(c.kind) && Array.isArray(c.columns) && c.columns.length)
    .filter((c) => c.columns.every((name) => cols.has(name) && !cols.get(name).nullable))
    .sort((a, b) => {
      const forzaA = a.kind === 'primary-key' ? 0 : 1;
      const forzaB = b.kind === 'primary-key' ? 0 : 1;
      return forzaA - forzaB || a.columns.length - b.columns.length || String(a.name).localeCompare(String(b.name));
    })[0];
  return candidate ? {
    kind: candidate.kind,
    ...(candidate.name ? { name: String(candidate.name) } : {}),
    columns: candidate.columns.map(String),
  } : null;
}

function identitaSqlDaCatalogo(columns, rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    if (!grouped.has(row.name)) grouped.set(row.name, {
      name: row.name,
      kind: row.ctype === 'PRIMARY KEY' ? 'primary-key' : 'unique',
      columns: [],
    });
    grouped.get(row.name).columns.push(row.col);
  }
  return [...grouped.values()]
    .map((candidate) => scegliIdentitaSql(columns, [candidate]))
    .filter(Boolean)
    .sort((a, b) => {
      const forzaA = a.kind === 'primary-key' ? 0 : 1;
      const forzaB = b.kind === 'primary-key' ? 0 : 1;
      return forzaA - forzaB || a.columns.length - b.columns.length || String(a.name).localeCompare(String(b.name));
    });
}

async function leggiIdentitaMySql(execute, db, table, columns) {
  const result = await execute(MYSQL_IDENTITY_SQL, [db, table]);
  return identitaSqlDaCatalogo(columns, result[0]);
}

async function leggiIdentitaPostgres(execute, schema, table, columns) {
  const result = await execute(POSTGRES_IDENTITY_SQL, [table, schema]);
  return identitaSqlDaCatalogo(columns, result.rows);
}

function validaIdentity(identity, file) {
  if (identity == null) return;
  if (!identity || !IDENTITY_KINDS.has(identity.kind)
      || !Array.isArray(identity.columns) || !identity.columns.length
      || identity.columns.some((c) => typeof c !== 'string' || !c)) {
    throw new Error(`Identita stabile non valida per "${file.collection || '?'}".`);
  }
  if (new Set(identity.columns).size !== identity.columns.length) {
    throw new Error(`Identita stabile con colonne duplicate per "${file.collection || '?'}".`);
  }
  if (identity.kind === 'mongodb-id'
      && (identity.columns.length !== 1 || identity.columns[0] !== '_id')) {
    throw new Error(`L'identita MongoDB di "${file.collection || '?'}" deve essere _id.`);
  }
  if (Array.isArray(file.columns)) {
    const disponibili = new Set(file.columns);
    for (const c of identity.columns) {
      if (!disponibili.has(c)) {
        throw new Error(`La colonna di identita "${c}" non e' salvata per "${file.collection || '?'}".`);
      }
    }
  }
}

/**
 * I manifest v1 full restano ripristinabili. Non possono pero' essere usati
 * come prova semantica per una catena incrementale/differenziale.
 */
function validaManifestIdentita(manifest) {
  const version = Number(manifest && manifest.version || 1);
  const type = String(manifest && manifest.type || '');
  const files = Array.isArray(manifest && manifest.files) ? manifest.files : [];
  if (version < MANIFEST_VERSION) {
    if (type !== 'full') {
      throw new Error('Un manifest storico senza identita dichiarata non e un incrementale sicuro. Esegui un nuovo backup full.');
    }
    return { historical: true };
  }
  if (version !== MANIFEST_VERSION) {
    throw new Error(`Versione manifest non supportata: ${version}.`);
  }
  for (const file of files.filter((f) => f && f.kind === 'data')) {
    if (!Array.isArray(file.columns) || file.columns.some((c) => typeof c !== 'string' || !c)) {
      throw new Error(`Il manifest non dichiara le colonne di "${file.collection || '?'}".`);
    }
    validaIdentity(file.identity, file);
    const mongo = ['mongodb', 'mongo'].includes(String(manifest.dbType));
    if (mongo && (!file.identity || file.identity.kind !== 'mongodb-id')) {
      throw new Error(`MongoDB deve dichiarare _id come identita stabile per "${file.collection || '?'}".`);
    }
    if (!mongo) {
      if (!Array.isArray(file.columnSchema) || file.columnSchema.length !== file.columns.length) {
        throw new Error(`Il manifest non dichiara tipi e nullabilita delle colonne di "${file.collection || '?'}".`);
      }
      for (let i = 0; i < file.columns.length; i++) {
        const column = file.columnSchema[i];
        if (!column || column.name !== file.columns[i] || typeof column.type !== 'string'
            || !column.type || typeof column.nullable !== 'boolean') {
          throw new Error(`Schema colonne non valido per "${file.collection || '?'}".`);
        }
      }
    }
    if (!Number.isSafeInteger(file.sourceCardinality) || file.sourceCardinality < 0) {
      throw new Error(`Cardinalita sorgente non valida per "${file.collection || '?'}".`);
    }
    if (Number.isSafeInteger(file.count) && file.count > file.sourceCardinality) {
      throw new Error(`Il layer di "${file.collection || '?'}" contiene piu righe della sorgente dichiarata.`);
    }
    if (file.identity) {
      if (!Number.isSafeInteger(file.sourceDistinctIdentities)
          || file.sourceDistinctIdentities !== file.sourceCardinality) {
        throw new Error(
          `Il manifest di "${file.collection || '?'}" non dimostra che cardinalita e identita sorgente coincidano.`
        );
      }
    } else if (file.sourceDistinctIdentities != null) {
      throw new Error(`Identita distinte dichiarate senza identita stabile per "${file.collection || '?'}".`);
    }
    if (type !== 'full' && !file.identity) {
      throw new Error(`La tabella/collection "${file.collection || '?'}" non ha un'identita stabile: backup ${type} rifiutato.`);
    }
  }
  return { historical: false };
}

function ordinaOggetto(value) {
  if (Array.isArray(value)) return value.map(ordinaOggetto);
  if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)
      || value._bsontype) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, ordinaOggetto(value[k])]));
}

function chiaveIdentita(row, identity) {
  if (!identity) return null;
  const values = identity.columns.map((column) => {
    if (!Object.prototype.hasOwnProperty.call(row, column)) {
      throw new Error(`La riga non contiene la colonna di identita "${column}".`);
    }
    if (row[column] == null) {
      throw new Error(`La colonna di identita "${column}" contiene NULL.`);
    }
    return row[column];
  });
  return EJSON.stringify(ordinaOggetto(values), { relaxed: false });
}

function riepilogaIdentitaLayer(layers) {
  let writes = 0;
  const identities = new Set();
  for (const layer of layers || []) {
    for (const row of layer.rows || []) {
      writes += 1;
      identities.add(chiaveIdentita(row, layer.identity));
    }
  }
  return { writes, distinct: identities.size };
}

function identityCompatibile(expected, actual) {
  if (!expected || !actual) return expected === actual;
  const stessaFamiglia = expected.kind === actual.kind
    || (SQL_IDENTITY_KINDS.has(expected.kind) && SQL_IDENTITY_KINDS.has(actual.kind));
  return stessaFamiglia
    && expected.columns.length === actual.columns.length
    && expected.columns.every((c, i) => c === actual.columns[i]);
}

module.exports = {
  MANIFEST_VERSION,
  scegliIdentitaSql,
  identitaSqlDaCatalogo,
  leggiIdentitaMySql,
  leggiIdentitaPostgres,
  validaManifestIdentita,
  validaIdentity,
  chiaveIdentita,
  riepilogaIdentitaLayer,
  identityCompatibile,
};
