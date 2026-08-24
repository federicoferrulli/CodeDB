'use strict';

/* ---------------------------------------------------------------------------
 * Confine di fiducia degli artefatti di database.
 *
 * Export `.codedb.json` e backup arrivano da file e sono quindi input non
 * fidati. Questo modulo e' l'unico punto che li trasforma in valori applicabili:
 * normalizza la struttura, estrae il bersaglio EFFETTIVO delle DDL e verifica
 * che coincida con la risorsa dichiarata. Un checksum dimostra l'integrita'
 * rispetto a un manifest, mai l'identita' di chi lo ha prodotto; le due
 * proprieta' restano percio' separate nel risultato.
 * ------------------------------------------------------------------------- */

const { splitStatementsDetailed } = require('./sqlText');

const FORMATO_EXPORT = 'codedb-database';
const TIPI_SQL = new Set(['mysql', 'postgresql']);

function tipoDb(value) {
  const valueNorm = String(value || '').toLowerCase();
  return valueNorm === 'postgres' ? 'postgresql' : valueNorm;
}

function errore(messaggio, sql) {
  const estratto = String(sql || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  throw new Error(`${messaggio}${estratto ? `: "${estratto}"` : ''}.`);
}

function copiaJson(value, cosa) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    throw new Error(`${cosa} non e' serializzabile come JSON: ${err.message}`);
  }
}

/** Token minimi necessari a leggere la testa di una DDL senza usare regex. */
function tokenizza(sql) {
  const testo = String(sql == null ? '' : sql);
  const tokens = [];
  let i = 0;
  const parola = (c) => c != null && /[A-Za-z0-9_$]/.test(c);

  while (i < testo.length) {
    const c = testo[i];
    const next = testo[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && next === '-') {
      i += 2;
      while (i < testo.length && testo[i] !== '\n') i++;
      continue;
    }
    if (c === '#') {
      while (i < testo.length && testo[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < testo.length && !(testo[i] === '*' && testo[i + 1] === '/')) i++;
      i = Math.min(testo.length, i + 2);
      continue;
    }
    if (c === '$') {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(testo.slice(i));
      if (match) {
        const tag = match[0];
        const fine = testo.indexOf(tag, i + tag.length);
        tokens.push({ type: 'string', value: '' });
        i = fine < 0 ? testo.length : fine + tag.length;
        continue;
      }
    }
    if (c === "'") {
      let value = '';
      i++;
      while (i < testo.length) {
        if (testo[i] === "'") {
          if (testo[i + 1] === "'") { value += "'"; i += 2; continue; }
          i++;
          break;
        }
        value += testo[i++];
      }
      tokens.push({ type: 'string', value });
      continue;
    }
    if (c === '`' || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c;
      let value = '';
      i++;
      while (i < testo.length) {
        if (testo[i] === close) {
          if (testo[i + 1] === close) { value += close; i += 2; continue; }
          i++;
          break;
        }
        value += testo[i++];
      }
      tokens.push({ type: 'identifier', value, quoted: true });
      continue;
    }
    if (parola(c)) {
      const start = i++;
      while (parola(testo[i])) i++;
      tokens.push({ type: 'identifier', value: testo.slice(start, i), quoted: false });
      continue;
    }
    tokens.push({ type: 'symbol', value: c });
    i++;
  }
  return tokens;
}

function keyword(token, value) {
  return token && token.type === 'identifier' && token.value.toUpperCase() === value;
}

function salta(tokens, index, parole) {
  let i = index;
  while (i < tokens.length && parole.has(tokens[i].value.toUpperCase())) i++;
  return i;
}

function leggiNome(tokens, index) {
  const parti = [];
  let i = index;
  if (!tokens[i] || tokens[i].type !== 'identifier') return null;
  parti.push(tokens[i++]);
  while (tokens[i] && tokens[i].value === '.' && tokens[i + 1] && tokens[i + 1].type === 'identifier') {
    i++;
    parti.push(tokens[i++]);
  }
  return { parts: parti, next: i, name: parti[parti.length - 1].value };
}

function stessoNome(token, expected, dbType) {
  if (!token) return false;
  // Anche MySQL puo' distinguere le maiuscole nei nomi di tabella
  // (`lower_case_table_names=0`): al confine di fiducia il confronto deve
  // quindi essere conservativo e non inventare equivalenze dipendenti
  // dall'installazione.
  if (dbType === 'mysql') return token.value === String(expected);
  if (token.quoted) return token.value === String(expected);
  return token.value.toLowerCase() === String(expected)
    && String(expected) === String(expected).toLowerCase();
}

function validaQualificatore(nome, database, dbType, sql) {
  if (!nome || nome.parts.length === 1) return;
  if (nome.parts.length !== 2 || !stessoNome(nome.parts[0], database, dbType)) {
    errore(`La DDL punta al database/schema estraneo "${nome.parts.slice(0, -1).map((p) => p.value).join('.')}"`, sql);
  }
}

function indiceKeyword(tokens, value, from = 0) {
  for (let i = from; i < tokens.length; i++) if (keyword(tokens[i], value)) return i;
  return -1;
}

/** Estrae tipo, oggetto creato e tabella realmente modificata dalla DDL. */
function estraiBersaglio(sql) {
  const tokens = tokenizza(sql);
  if (!tokens.length) errore('Istruzione DDL vuota', sql);
  let i = 0;
  const first = tokens[i] && tokens[i].value.toUpperCase();
  if (first === 'DROP' || first === 'TRUNCATE') errore(`Istruzione ${first} non ammessa`, sql);

  if (first === 'ALTER') {
    if (!keyword(tokens[1], 'TABLE')) errore('Sono ammesse soltanto ALTER TABLE', sql);
    i = salta(tokens, 2, new Set(['IF', 'EXISTS', 'ONLY']));
    const table = leggiNome(tokens, i);
    if (!table) errore('ALTER TABLE senza bersaglio leggibile', sql);
    return { kind: 'alter-table', object: table, table, tokens };
  }

  if (first !== 'CREATE') errore(`Istruzione ${first || 'sconosciuta'} non ammessa`, sql);
  const tipi = new Set(['TABLE', 'INDEX', 'VIEW', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT', 'SEQUENCE']);
  let typeIndex = -1;
  for (let k = 1; k < tokens.length; k++) {
    if (tokens[k].type === 'identifier' && tipi.has(tokens[k].value.toUpperCase())) { typeIndex = k; break; }
  }
  if (typeIndex < 0) errore('Forma CREATE non ammessa', sql);
  const type = tokens[typeIndex].value.toUpperCase();
  i = salta(tokens, typeIndex + 1, new Set(['IF', 'NOT', 'EXISTS', 'ONLY', 'CONCURRENTLY']));
  const object = leggiNome(tokens, i);
  if (!object) errore(`CREATE ${type} senza bersaglio leggibile`, sql);

  if (type === 'TABLE') return { kind: 'create-table', object, table: object, tokens };
  if (type === 'INDEX') {
    const on = indiceKeyword(tokens, 'ON', object.next);
    const table = on < 0 ? null : leggiNome(tokens, salta(tokens, on + 1, new Set(['ONLY'])));
    if (!table) errore('CREATE INDEX senza tabella bersaglio leggibile', sql);
    return { kind: 'create-index', object, table, tokens };
  }
  if (type === 'TRIGGER') {
    const on = indiceKeyword(tokens, 'ON', object.next);
    const table = on < 0 ? null : leggiNome(tokens, on + 1);
    if (!table) errore('CREATE TRIGGER senza tabella bersaglio leggibile', sql);
    return { kind: 'create-trigger', object, table, tokens };
  }
  return { kind: `create-${type.toLowerCase()}`, object, table: null, tokens };
}

function validaRiferimentiCrossDatabase(target, database, dbType, sql) {
  const keywords = new Set(['FROM', 'JOIN', 'REFERENCES', 'UPDATE', 'INTO', 'LIKE']);
  for (let i = 0; i < target.tokens.length; i++) {
    if (!target.tokens[i] || !keywords.has(target.tokens[i].value.toUpperCase())) continue;
    const nome = leggiNome(target.tokens, salta(target.tokens, i + 1, new Set(['ONLY'])));
    if (nome) validaQualificatore(nome, database, dbType, sql);
  }
}

function validaDdlCollezione(sql, { dbType, database, collection, forme = null, allowUnsafeSchema = false } = {}) {
  const testo = String(sql == null ? '' : sql);
  const statements = splitStatementsDetailed(testo, { backslashEscape: tipoDb(dbType) === 'mysql' });
  if (!statements.length) throw new Error(`Il file di schema di "${collection}" e' vuoto.`);
  if (allowUnsafeSchema) return testo;
  const motore = tipoDb(dbType);
  const allowed = forme || new Set(['create-table', 'create-index', 'alter-table']);
  for (const statement of statements) {
    const target = estraiBersaglio(statement.sql);
    if (!allowed.has(target.kind)) errore(`Forma ${target.kind} non ammessa per la tabella "${collection}"`, statement.sql);
    validaQualificatore(target.object, database, motore, statement.sql);
    validaQualificatore(target.table, database, motore, statement.sql);
    if (!stessoNome(target.table.parts[target.table.parts.length - 1], collection, motore)) {
      errore(`La DDL riguarda un'altra tabella, "${target.table.name}", non "${collection}"`, statement.sql);
    }
    if (target.kind === 'alter-table') {
      const action = target.tokens[target.table.next];
      if (!keyword(action, 'ADD')) {
        errore('Sono ammesse soltanto ALTER TABLE additive (ADD)', statement.sql);
      }
    }
    validaRiferimentiCrossDatabase(target, database, motore, statement.sql);
  }
  return testo;
}

function validaOggetto(sql, expected, { dbType, database, kind, table = null } = {}) {
  const motore = tipoDb(dbType);
  // PostgreSQL accetta piu' comandi nella stessa query: il bersaglio della
  // prima CREATE non puo' autorizzare cio' che segue. Il suo dollar-quoting e'
  // gia' riconosciuto dallo splitter, quindi i `;` nei corpi delle routine non
  // producono falsi statement. Su MySQL si applica la stessa regola alle forme
  // senza corpi procedurali; routine/trigger/eventi sono protetti anche da
  // `multipleStatements: false` nel driver.
  if (motore === 'postgresql' || ['view', 'sequence'].includes(kind)) {
    const statements = splitStatementsDetailed(sql, { backslashEscape: motore === 'mysql' });
    if (statements.length !== 1) errore(`La definizione di ${kind} contiene piu' istruzioni`, sql);
  }
  const target = estraiBersaglio(sql);
  const kindExpected = kind === 'routine' ? new Set(['create-function', 'create-procedure']) : new Set([`create-${kind}`]);
  if (!kindExpected.has(target.kind)) errore(`Forma ${target.kind} non ammessa per ${kind} "${expected}"`, sql);
  validaQualificatore(target.object, database, motore, sql);
  if (!stessoNome(target.object.parts[target.object.parts.length - 1], expected, motore)) {
    errore(`La DDL crea "${target.object.name}", non l'oggetto dichiarato "${expected}"`, sql);
  }
  if (table) {
    validaQualificatore(target.table, database, motore, sql);
    if (!stessoNome(target.table.parts[target.table.parts.length - 1], table, motore)) {
      errore(`Il trigger riguarda "${target.table.name}", non la tabella dichiarata "${table}"`, sql);
    }
  }
  validaRiferimentiCrossDatabase(target, database, motore, sql);
  return String(sql).trim();
}

function fiduciaExport(parsed) {
  return {
    integrita: { verificata: false, metodo: null, motivo: 'Il formato export non contiene checksum.' },
    autenticita: { verificata: false, metodo: null, motivo: 'Nessuna firma crittografica disponibile.' },
    provenienzaDichiarata: parsed.generatore || null,
  };
}

function fiduciaBackup(integrity = {}) {
  const nonVerificabili = Number(integrity.unverifiableCount) || 0;
  return {
    integrita: {
      verificata: nonVerificabili === 0,
      metodo: 'SHA-256',
      fileVerificati: Number(integrity.verifiedCount) || 0,
      fileNonVerificabili: nonVerificabili,
    },
    autenticita: {
      verificata: false,
      metodo: null,
      motivo: 'Il checksum prova integrita rispetto al manifest, non autenticita.',
    },
  };
}

function normalizzaExportDatabase(input, { expectedDbType = null } = {}) {
  let parsed;
  try { parsed = typeof input === 'string' ? JSON.parse(input) : copiaJson(input, 'L\'export'); }
  catch (err) { throw new Error(`JSON non valido: ${err.message}`); }
  if (!parsed || parsed.formato !== FORMATO_EXPORT || !Array.isArray(parsed.collections)) {
    throw new Error(`Il file non e' un export di database di CodeDB (atteso "formato": "${FORMATO_EXPORT}").`);
  }
  const motore = tipoDb(parsed.dbType);
  if (!['mongodb', 'mysql', 'postgresql'].includes(motore)) throw new Error(`Tipo di database "${parsed.dbType}" non valido.`);
  if (expectedDbType && motore !== tipoDb(expectedDbType)) {
    throw new Error(`Il file e' un export ${motore}, ma questa connessione e' ${tipoDb(expectedDbType)}.`);
  }
  if (typeof parsed.db !== 'string' || !parsed.db) throw new Error('File malformato: manca il database dichiarato.');
  const names = new Set();
  for (const collection of parsed.collections) {
    if (!collection || typeof collection.name !== 'string' || !collection.name || !Array.isArray(collection.docs)) {
      throw new Error('File malformato: ogni collection deve avere "name" e l\'array "docs".');
    }
    if (names.has(collection.name)) throw new Error(`File malformato: la collection "${collection.name}" e' dichiarata piu' volte.`);
    names.add(collection.name);
    if (TIPI_SQL.has(motore)) {
      if (collection.ddl != null && typeof collection.ddl !== 'string') {
        throw new Error(`File malformato: "ddl" di "${collection.name}" deve essere testo.`);
      }
      if (collection.ddl) validaDdlCollezione(collection.ddl, {
        dbType: motore, database: parsed.db, collection: collection.name,
      });
      if (collection.postDdl != null
          && (!Array.isArray(collection.postDdl) || collection.postDdl.some((s) => typeof s !== 'string' || !s.trim()))) {
        throw new Error(`File malformato: "postDdl" di "${collection.name}" deve essere un elenco di istruzioni SQL.`);
      }
      for (const ddl of collection.postDdl || []) validaDdlCollezione(ddl, {
        dbType: motore, database: parsed.db, collection: collection.name,
        forme: new Set(['create-index', 'alter-table']),
      });
    } else {
      if (collection.ddl != null || collection.postDdl != null) {
        throw new Error(`File MongoDB malformato: "${collection.name}" contiene DDL SQL.`);
      }
      if (collection.indexes != null && !Array.isArray(collection.indexes)) {
        throw new Error(`File malformato: "indexes" di "${collection.name}" deve essere un elenco.`);
      }
    }
  }
  parsed.dbType = motore;
  parsed.fiducia = fiduciaExport(parsed);
  return parsed;
}

function elencoOggetti(objects, field) {
  const value = objects[field] == null ? [] : objects[field];
  if (!Array.isArray(value)) throw new Error(`Oggetti di schema malformati: "${field}" deve essere un elenco.`);
  return value;
}

function normalizzaOggetti(objects, { dbType, database, collections, allowUnsafeSchema }) {
  if (objects == null) return null;
  const out = copiaJson(objects, 'Gli oggetti di schema');
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('File degli oggetti di schema malformato.');
  if (tipoDb(dbType) === 'mongodb') {
    for (const field of ['views', 'collectionOptions']) {
      for (const item of elencoOggetti(out, field)) {
        if (!item || typeof item.name !== 'string' || !item.name) throw new Error(`${field}: nome oggetto mancante.`);
      }
    }
    return out;
  }
  const gruppi = [
    ['views', 'view'], ['routines', 'routine'], ['triggers', 'trigger'],
    ['events', 'event'], ['sequences', 'sequence'],
  ];
  for (const [field, kind] of gruppi) {
    for (const item of elencoOggetti(out, field)) {
      if (!item || typeof item.name !== 'string' || !item.name || typeof item.ddl !== 'string' || !item.ddl.trim()) {
        throw new Error(`${field}: nome o DDL dell'oggetto mancante.`);
      }
      if (kind === 'trigger' && (typeof item.table !== 'string' || !item.table)) {
        throw new Error('triggers: tabella bersaglio mancante.');
      }
      if (!allowUnsafeSchema) validaOggetto(item.ddl, item.name, {
        dbType, database, kind, table: kind === 'trigger' ? item.table : null,
      });
    }
  }
  for (const ddl of elencoOggetti(out, 'foreignKeys')) {
    if (allowUnsafeSchema) continue;
    const target = estraiBersaglio(ddl);
    if (target.kind !== 'alter-table') errore('Una chiave esterna deve essere ALTER TABLE', ddl);
    validaQualificatore(target.table, database, tipoDb(dbType), ddl);
    if (collections && collections.size
        && ![...collections].some((name) => stessoNome(target.table.parts[target.table.parts.length - 1], name, tipoDb(dbType)))) {
      errore(`Il vincolo modifica la tabella non dichiarata "${target.table.name}"`, ddl);
    }
    validaRiferimentiCrossDatabase(target, database, tipoDb(dbType), ddl);
  }
  for (const item of elencoOggetti(out, 'sequenceValues')) {
    if (allowUnsafeSchema) continue;
    const match = /^\s*SELECT\s+(?:pg_catalog\.)?setval\s*\(\s*'((?:[^']|'')+)'\s*,\s*-?\d+\s*(?:,\s*(?:true|false)\s*)?\)\s*;?\s*$/i.exec(String(item.sql || ''));
    const actual = match && match[1].replace(/''/g, "'").split('.').pop();
    if (!match || actual !== item.name) errore(`Valore di sequenza non valido per "${item.name}"`, item.sql);
  }
  return out;
}

function normalizzaLayerBackup(input, { allowUnsafeSchema = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Layer di backup malformato.');
  const motore = tipoDb(input.dbType);
  if (!['mongodb', 'mysql', 'postgresql'].includes(motore)) throw new Error(`Tipo di database "${input.dbType}" non valido.`);
  const database = String(input.database || '');
  if (!database) throw new Error('Layer di backup senza database dichiarato.');
  if (!Array.isArray(input.schemas)) throw new Error('Layer di backup senza elenco degli schemi.');
  const schemas = input.schemas.map((schema) => {
    if (!schema || typeof schema.collection !== 'string' || typeof schema.sql !== 'string') {
      throw new Error('Definizione di tabella malformata nel layer di backup.');
    }
    if (schema.database != null && String(schema.database) !== database) {
      throw new Error(
        `La definizione di "${schema.collection}" dichiara il database/schema estraneo "${schema.database}" `
        + `invece di "${database}".`
      );
    }
    validaDdlCollezione(schema.sql, {
      dbType: motore, database, collection: schema.collection, allowUnsafeSchema,
    });
    return { ...schema };
  });
  const collections = new Set((input.collections || schemas.map((s) => s.collection)).map(String));
  return {
    formato: 'codedb-backup-layer', dbType: motore, database, schemas,
    objects: normalizzaOggetti(input.objects, { dbType: motore, database, collections, allowUnsafeSchema }),
    fiducia: fiduciaBackup(input.integrity),
  };
}

module.exports = {
  FORMATO_EXPORT,
  tipoDb,
  estraiBersaglio,
  validaDdlCollezione,
  normalizzaExportDatabase,
  normalizzaLayerBackup,
};
