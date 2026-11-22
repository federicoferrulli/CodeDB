import { linguaQuery } from './query-lexer.js';

export const ACCEPT_QUERY_SQL = '.sql,.txt,.queries';
export const ACCEPT_QUERY_MONGO = '.js,.mongodb,.json,.mql,.sql,.txt,.queries';
export const ACCEPT_QUERY_TUTTI = '.sql,.js,.mongodb,.json,.mql,.txt,.queries';

const ESTENSIONI_MONGO_NON_SQL = /\.(?:js|mjs|cjs|mongodb|json|mql)$/i;
const ESTENSIONE_SQL = /\.sql$/i;

function isSqlDb(dbType) {
  return /^(?:mysql|postgresql|postgres|pg)$/i.test(String(dbType || ''));
}

function isMongoDb(dbType) {
  return /^(?:mongodb|mongo)$/i.test(String(dbType || ''));
}

function rimuoviIntestazioneCommenti(code) {
  return String(code || '').replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\/[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');
}

/** Valore `accept` per il file picker dell'editor query, adattato al DBMS attivo. */
export function acceptFileQuery(dbType) {
  if (isSqlDb(dbType)) return ACCEPT_QUERY_SQL;
  if (isMongoDb(dbType)) return ACCEPT_QUERY_MONGO;
  return ACCEPT_QUERY_TUTTI;
}

/** Testi e filtri del pulsante "Apri file" nel menu dell'editor query. */
export function azioneApriFileQuery(dbType) {
  if (isSqlDb(dbType)) {
    return {
      label: 'Apri file SQL…',
      title: 'Apri ed esegui file SQL (.sql, .txt, .queries)',
      accept: ACCEPT_QUERY_SQL,
      titoloNotifica: 'File SQL',
    };
  }
  if (isMongoDb(dbType)) {
    return {
      label: 'Apri file query…',
      title: 'Apri file MongoDB o SQL (.js, .mongodb, .json, .mql, .sql, .txt, .queries)',
      accept: ACCEPT_QUERY_MONGO,
      titoloNotifica: 'File query',
    };
  }
  return {
    label: 'Apri file query…',
    title: 'Apri file query o script',
    accept: ACCEPT_QUERY_TUTTI,
    titoloNotifica: 'File query',
  };
}

/**
 * Valore `accept` per riaprire da disco un file registrato nelle query in sospeso:
 * parte dal DBMS della sessione, ma include sempre l'estensione del file originale
 * così resta selezionabile anche se il tab è stato chiuso dopo un F5.
 */
export function acceptPerRipresaFile(fileName, dbType = '') {
  const base = acceptFileQuery(dbType).split(',');
  const match = /(\.[a-z0-9]+)$/i.exec(String(fileName || ''));
  if (match && !base.includes(match[1].toLowerCase())) base.unshift(match[1].toLowerCase());
  return `${base.join(',')},text/plain`;
}

/** Estensione consigliata per "Salva query…" in base al DBMS, al motore e al codice. */
export function estensioneSalvaQuery({ code = '', dbType = '', engine = 'auto' } = {}) {
  if (isSqlDb(dbType)) return '.sql';
  if (isMongoDb(dbType)) {
    if (engine === 'mongosh') return '.js';
    if (engine === 'sql') return '.sql';
    if (linguaQuery(code, '') === 'sql') return '.sql';
    const corpo = rimuoviIntestazioneCommenti(code);
    if (corpo.startsWith('{') || corpo.startsWith('[')) return '.json';
    return '.js';
  }
  return '.sql';
}

/** Nome file completo per il download da "Salva query…". */
export function nomeFileSalvaQuery({ db = '', code = '', dbType = '', engine = 'auto' } = {}) {
  const base = `${(db || 'query').replace(/[^\w.-]/g, '_')}`;
  return base + estensioneSalvaQuery({ code, dbType, engine });
}

/**
 * Decide se un file grande (> 1 MB) può essere spezzato sui `;` dal chunker SQL.
 *
 * - Su MySQL/PostgreSQL: sempre `true`.
 * - Su MongoDB: `false` per file JS/mongosh/JSON/MQL (spezzarli sui `;` romperebbe
 *   cicli, funzioni e stringhe JSON); `true` per `.sql`.
 * - Per estensioni neutre (`.txt`, `.queries`) su MongoDB: restituisce `null` se
 *   `prefix` non è stato passato (il chiamante legge i primi byte e richiama),
 *   altrimenti `true` solo se il prefisso è SQL.
 */
export function usaChunkingSql({ fileName = '', dbType = '', engine = 'auto', prefix } = {}) {
  if (isSqlDb(dbType)) return true;
  if (!isMongoDb(dbType)) return !ESTENSIONI_MONGO_NON_SQL.test(String(fileName || ''));
  if (engine === 'mongosh') return false;
  const nome = String(fileName || '');
  if (ESTENSIONI_MONGO_NON_SQL.test(nome)) return false;
  if (ESTENSIONE_SQL.test(nome)) return true;
  if (prefix === undefined) return null;
  return linguaQuery(prefix, '') === 'sql';
}
