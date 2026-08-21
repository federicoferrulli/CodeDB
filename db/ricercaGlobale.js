'use strict';

/**
 * Ricerca globale della vista Dati.
 *
 * Il browser invia soltanto l'intenzione (`contieneOvunque`); nomi, tipi e
 * percorsi vengono decisi dal server. In questo modo una colonna non scompare
 * dalla ricerca perche non era nella pagina corrente e il client non deve
 * conoscere i dialetti dei tre motori.
 */

const OPERATORE = 'contieneOvunque';
const MAX_TESTO = 2000;
const MAX_CATALOGHI = 32;
const DURATA_CATALOGO_MS = 60_000;

function normalizzaRicerca(input) {
  if (input == null || input === '') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Ricerca globale non valida: atteso un oggetto strutturato.');
  }
  if (input.operatore !== OPERATORE) {
    throw new Error(`Ricerca globale non valida: operatore atteso "${OPERATORE}".`);
  }
  const valore = String(input.valore == null ? '' : input.valore).trim();
  if (!valore) return null;
  if (valore.length > MAX_TESTO) {
    throw new Error(`Ricerca globale troppo lunga: massimo ${MAX_TESTO} caratteri.`);
  }
  return valore;
}

function modelloLike(valore) {
  // `=` come carattere di escape evita di dipendere da NO_BACKSLASH_ESCAPES
  // su MySQL e dalle regole sulle stringhe del server PostgreSQL.
  return `%${String(valore).replace(/[=%_]/g, (ch) => `=${ch}`)}%`;
}

function modelloRegex(valore) {
  return String(valore).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tipoScalare(value) {
  if (value == null) return null;
  if (typeof value !== 'object') return typeof value;
  if (value instanceof Date) return 'date';
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return null;
  const nome = value && value._bsontype;
  if (nome === 'Binary') return null;
  if (nome) return String(nome).toLowerCase();
  return null;
}

function firmaToken(tokens) {
  return tokens.map((t) => (t.array ? '[]' : `.${JSON.stringify(t.key)}`)).join('');
}

/** Raccoglie soltanto percorsi verso VALORI scalari; le chiavi non sono dati. */
function percorsiScalari(value, tokens = [], out = new Map(), visti = new Set()) {
  const tipo = tipoScalare(value);
  if (tipo) {
    const firma = firmaToken(tokens);
    if (!out.has(firma)) out.set(firma, { tokens: tokens.map((t) => ({ ...t })), tipi: new Set() });
    out.get(firma).tipi.add(tipo);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (visti.has(value)) return out;
  visti.add(value);
  if (Array.isArray(value)) {
    for (const item of value) percorsiScalari(item, [...tokens, { array: true }], out, visti);
  } else {
    for (const [key, item] of Object.entries(value)) {
      percorsiScalari(item, [...tokens, { key }], out, visti);
    }
  }
  visti.delete(value);
  return out;
}

function catalogoDaDocumenti(docs, estrai = (doc) => doc) {
  const out = new Map();
  for (const doc of Array.isArray(docs) ? docs : []) percorsiScalari(estrai(doc), [], out);
  return out;
}

function unisciCatalogo(dest, src) {
  for (const [firma, voce] of src || []) {
    let corrente = dest.get(firma);
    if (!corrente) {
      corrente = { tokens: voce.tokens.map((t) => ({ ...t })), tipi: new Set() };
      dest.set(firma, corrente);
    }
    for (const tipo of voce.tipi || []) corrente.tipi.add(tipo);
  }
  return dest;
}

/** Cache LRU piccola: conserva percorsi e tipi, mai i documenti campionati. */
function aggiornaCacheCatalogo(cache, chiave, catalogo, ora = Date.now()) {
  const precedente = cache.get(chiave);
  const unito = precedente ? precedente.catalogo : new Map();
  unisciCatalogo(unito, catalogo);
  cache.delete(chiave);
  cache.set(chiave, { catalogo: unito, verificatoIl: ora });
  while (cache.size > MAX_CATALOGHI) cache.delete(cache.keys().next().value);
  return unito;
}

function catalogoValido(cache, chiave, ora = Date.now()) {
  const voce = cache.get(chiave);
  return voce && ora - voce.verificatoIl < DURATA_CATALOGO_MS ? voce.catalogo : null;
}

function valoreMongo(expr) {
  return {
    $regexMatch: {
      input: { $convert: { input: expr, to: 'string', onError: '', onNull: '' } },
      regex: null,
      options: 'i',
    },
  };
}

function espressioneMongo(tokens, regex, input = '$$ROOT') {
  if (!tokens.length) {
    const out = valoreMongo(input);
    out.$regexMatch.regex = regex;
    return out;
  }
  const [primo, ...resto] = tokens;
  if (primo.array) {
    return {
      $anyElementTrue: {
        $map: {
          input: { $cond: [{ $isArray: input }, input, []] },
          as: 'cdb_valore',
          in: espressioneMongo(resto, regex, '$$cdb_valore'),
        },
      },
    };
  }
  const prossimo = {
    $cond: [
      { $eq: [{ $type: input }, 'object'] },
      { $getField: { field: { $literal: primo.key }, input } },
      null,
    ],
  };
  return espressioneMongo(resto, regex, prossimo);
}

function filtroMongo(valore, catalogo) {
  const regex = modelloRegex(valore);
  const condizioni = [...(catalogo || new Map()).values()]
    .map((voce) => ({ $expr: espressioneMongo(voce.tokens, regex) }));
  return condizioni.length ? { $or: condizioni } : { $expr: false };
}

function tipoNome(colonna) {
  return String((colonna && (colonna.type || colonna.dataType || colonna.udt_name)) || '').toLowerCase();
}

function tipoJsonMySql(colonna) { return tipoNome(colonna) === 'json'; }
function tipoJsonPostgres(colonna) { return /^(json|jsonb|_.+|.+\[\])$/.test(tipoNome(colonna)); }
function tipoEscluso(colonna) {
  return /(blob|binary|bytea|geometry|geography|point|linestring|polygon|raster)/.test(tipoNome(colonna));
}

function percorsoJsonMySql(tokens) {
  return '$' + tokens.map((t) => (t.array ? '[*]' : `.${JSON.stringify(t.key)}`)).join('');
}

function separaCataloghiJson(catalogo, nomiColonne) {
  const ammessi = new Set(nomiColonne || []);
  const out = new Map();
  for (const voce of (catalogo || new Map()).values()) {
    const [radice, ...resto] = voce.tokens;
    if (!radice || radice.array || !ammessi.has(radice.key)) continue;
    if (!out.has(radice.key)) out.set(radice.key, new Map());
    const ridotta = { tokens: resto, tipi: new Set(voce.tipi) };
    out.get(radice.key).set(firmaToken(resto), ridotta);
  }
  return out;
}

function clausolaMySql(valore, colonne, cataloghiJson, qid) {
  const modello = modelloLike(valore);
  const sql = [];
  const params = [];
  for (const col of colonne || []) {
    if (!col || !col.name || tipoEscluso(col)) continue;
    const nome = qid(col.name);
    if (tipoJsonMySql(col)) {
      const cat = cataloghiJson && cataloghiJson.get(col.name);
      for (const voce of cat ? cat.values() : []) {
        sql.push(`LOWER(CONVERT(JSON_UNQUOTE(JSON_EXTRACT(${nome}, ?)) USING utf8mb4)) COLLATE utf8mb4_bin `
          + `LIKE LOWER(CONVERT(? USING utf8mb4)) COLLATE utf8mb4_bin ESCAPE '='`);
        params.push(percorsoJsonMySql(voce.tokens), modello);
      }
    } else {
      // LOWER rende il confronto case-insensitive; la collation binaria
      // conserva invece la distinzione fra accenti ("e" non equivale a "è").
      sql.push(`LOWER(CONVERT(${nome} USING utf8mb4)) COLLATE utf8mb4_bin `
        + `LIKE LOWER(CONVERT(? USING utf8mb4)) COLLATE utf8mb4_bin ESCAPE '='`);
      params.push(modello);
    }
  }
  return { sql: sql.length ? `(${sql.join(' OR ')})` : 'FALSE', params };
}

function clausolaPostgres(valore, colonne, qid, segnaposto, da = 1) {
  const modello = modelloLike(valore);
  const sql = [];
  const params = [];
  for (const col of colonne || []) {
    if (!col || !col.name || tipoEscluso(col)) continue;
    const nome = qid(col.name);
    const p = segnaposto(da + params.length);
    if (tipoJsonPostgres(col)) {
      sql.push(`EXISTS (SELECT 1 FROM (`
        + `SELECT cdb_v FROM jsonb_path_query(to_jsonb(${nome}), 'strict $') AS cdb_root(cdb_v) `
        + `UNION ALL SELECT cdb_v FROM jsonb_path_query(to_jsonb(${nome}), 'strict $.**') AS cdb_figli(cdb_v)`
        + `) AS cdb_scalari WHERE jsonb_typeof(cdb_v) IN ('string','number','boolean') `
        + `AND LOWER(cdb_v #>> '{}') LIKE LOWER(${p}) ESCAPE '=' )`);
    } else {
      sql.push(`LOWER(CAST(${nome} AS TEXT)) LIKE LOWER(${p}) ESCAPE '='`);
    }
    params.push(modello);
  }
  return { sql: sql.length ? `(${sql.join(' OR ')})` : 'FALSE', params };
}

module.exports = {
  OPERATORE,
  normalizzaRicerca,
  modelloLike,
  modelloRegex,
  percorsiScalari,
  catalogoDaDocumenti,
  unisciCatalogo,
  aggiornaCacheCatalogo,
  catalogoValido,
  filtroMongo,
  clausolaMySql,
  clausolaPostgres,
  tipoJsonMySql,
  separaCataloghiJson,
};
