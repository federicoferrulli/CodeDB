/**
 * CodeDB — IntelliSense consapevole dello schema
 *
 * Il completamento automatico che c'era prima proponeva le parole chiave del
 * linguaggio più `state.columns`, cioè le colonne della tabella aperta nella
 * griglia. Nell'editor ⚡ Query & Aggregate, dove si scrivono JOIN fra tabelle
 * diverse e query su collezioni che non sono quella aperta, quell'elenco è
 * quasi sempre l'elenco sbagliato.
 *
 * Qui la proposta si deduce da **dove sta il cursore**:
 *
 *  - dopo `FROM` o `JOIN` servono nomi di tabella, non di colonna;
 *  - dopo `u.` servono le colonne di ciò a cui `u` fa da alias, e di nient'altro;
 *  - dentro una `SELECT … FROM ordini o JOIN utenti u` servono le colonne di
 *    **quelle due** tabelle, non di quella aperta nella griglia;
 *  - dopo `db.` servono le collezioni; dopo `db.utenti.` i metodi; dentro
 *    `db.utenti.find({` i campi di `utenti` e gli operatori `$…`.
 *
 * La lingua si deduce **dal testo**, non dal tipo di connessione: su MongoDB
 * si scrive regolarmente SQL (CodeDB lo traduce in MQL con `SqlToMql`), e in
 * quel caso dopo `FROM` servono i nomi delle collezioni. Il tipo di database
 * resta solo il ripiego per quando il testo non dice ancora niente.
 *
 * Questo modulo è **puro**: niente DOM, niente socket. Riceve il testo, la
 * posizione del cursore e uno schema già caricato, e restituisce un elenco
 * ordinato. Tutto il resto (dropdown, cache dello schema, tasti) sta in
 * `autocomplete.js`.
 *
 * Forma dello schema attesa:
 *   { tabelle: [ { nome: 'utenti', campi: [ { nome: 'id', tipo: 'int' } ] } ] }
 */

import {
  vocabolarioSql, METODI_DB_MONGO, quotaIdentificatore, ID_SQL, smarca, ultimoSegmento,
} from './sql-dialetti.js';

/* ==========================================================================
 * Vocabolari
 * ========================================================================== */

export const PAROLE_SQL = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT',
  'OFFSET', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'LIKE', 'IN', 'BETWEEN',
  'IS', 'DISTINCT', 'ASC', 'DESC', 'JOIN', 'LEFT JOIN', 'INNER JOIN',
  'RIGHT JOIN', 'ON', 'USING', 'UNION', 'UNION ALL', 'INSERT INTO', 'VALUES',
  'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'WITH',
];

export const FUNZIONI_SQL = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST',
  'UPPER', 'LOWER', 'TRIM', 'LENGTH', 'SUBSTRING', 'CONCAT', 'ROUND',
  'NOW', 'DATE', 'YEAR', 'MONTH', 'DAY',
];

// Parole ammesse nel filtro/ordinamento della griglia: lì non si scrive una
// query intera, solo il pezzo dopo WHERE / ORDER BY.
export const PAROLE_SQL_WHERE = [
  'AND', 'OR', 'NOT', 'NULL', 'LIKE', 'IN', 'BETWEEN', 'IS', 'ASC', 'DESC',
];

export const OPERATORI_MONGO = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$and', '$or', '$not', '$nor', '$exists', '$type', '$regex', '$expr',
  '$elemMatch', '$size', '$all', '$text',
  '$match', '$group', '$sort', '$project', '$limit', '$skip', '$lookup',
  '$unwind', '$addFields', '$set', '$unset', '$count', '$facet', '$sample',
  '$sum', '$avg', '$min', '$max', '$first', '$last', '$push', '$addToSet',
  '$concat', '$toUpper', '$toLower', '$dateToString', '$cond', '$ifNull',
  // Stadi e operatori meno comuni, ma che sono esattamente quelli che non si
  // ricordano a memoria — cioè quelli per cui un completamento serve davvero.
  '$graphLookup', '$bucket', '$bucketAuto', '$replaceRoot', '$replaceWith',
  '$sortByCount', '$setWindowFields', '$merge', '$out', '$geoNear', '$densify',
  '$switch', '$let', '$map', '$filter', '$reduce', '$arrayElemAt', '$slice',
  '$mergeObjects', '$objectToArray', '$arrayToObject', '$regexMatch',
  '$dateFromString', '$dateDiff', '$toString', '$toInt', '$toDouble',
  '$toObjectId', '$toDate', '$round', '$abs', '$multiply', '$divide',
  '$subtract', '$add', '$strLenCP', '$split', '$trim', '$literal',
  '$geoWithin', '$geoIntersects', '$near', '$nearSphere',
];

export const METODI_MONGO = [
  'find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount',
  'distinct', 'insertOne', 'insertMany', 'updateOne', 'updateMany',
  'replaceOne', 'deleteOne', 'deleteMany', 'createIndex', 'dropIndex',
  'getIndexes', 'drop', 'stats',
];

// Parole che non possono essere l'alias di una tabella: senza questo elenco
// `FROM utenti WHERE` registrerebbe `WHERE` come alias di `utenti`.
const NON_ALIAS = new Set([
  'on', 'where', 'set', 'join', 'inner', 'left', 'right', 'full', 'cross',
  'natural', 'outer', 'using', 'values', 'select', 'limit', 'offset', 'group',
  'order', 'having', 'union', 'and', 'or', 'as', 'returning', 'into', 'from',
]);

const PAROLE_TABELLA = new Set([
  'FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'DESCRIBE', 'DESC', 'TRUNCATE',
]);

// Parole con cui comincia un'istruzione SQL. Servono a due cose: riconoscere
// che nell'editor si sta scrivendo SQL, e proporle su una connessione MongoDB
// (dove l'SQL è tradotto in MQL da SqlToMql) quando ancora non si capisce in
// che lingua si stia scrivendo.
export const INIZI_SQL = [
  'SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'WITH', 'CREATE TABLE',
  'ALTER TABLE', 'DROP TABLE', 'TRUNCATE', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'USE',
];

// Regex del contesto DDL, compilate UNA volta: `posizioneTipoDdl` gira a ogni
// tasto premuto, e costruirne tre nuove a ogni battuta è lavoro puro.
const RE_DDL_TABELLA = /\b(CREATE|ALTER)\s+(TEMPORARY\s+)?TABLE\b/i;
const RE_DOPO_ADD_COLONNA = new RegExp(
  `\\b(?:ADD|MODIFY|CHANGE|ALTER)\\s+(?:COLUMN\\s+)?${ID_SQL}\\s+(?:TYPE\\s+)?$`, 'i');
const RE_DOPO_NOME_COLONNA = new RegExp(`[(,]\\s*${ID_SQL}\\s+$`);

const RE_INIZIO_SQL = /^(?:\s|--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/)*\b(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|CREATE|ALTER|DROP|TRUNCATE|SHOW|DESCRIBE|DESC|EXPLAIN|USE|GRANT|REVOKE|SET)\b/i;

/* ==========================================================================
 * Lettura del contesto
 * ========================================================================== */

/**
 * L'istruzione dentro cui sta il cursore: dal `;` precedente al cursore.
 *
 * In uno script conta la lingua dell'istruzione che si sta scrivendo, non
 * quella della prima riga del file: `SELECT 1; db.utenti.find({ …` sono due
 * lingue diverse nello stesso editor, ed è normale.
 */
function istruzioneCorrente(testo, cursore) {
  const prima = String(testo == null ? '' : testo).slice(0, Math.max(0, cursore));
  const puntoEVirgola = prima.lastIndexOf(';');
  return puntoEVirgola >= 0 ? prima.slice(puntoEVirgola + 1) : prima;
}

/**
 * Il cursore è nel punto in cui una DDL vuole il TIPO di una colonna?
 *
 * Sono i due casi in cui il tipo è obbligatorio e non c'è nient'altro da
 * scrivere: dentro l'elenco colonne di una `CREATE TABLE`, subito dopo il nome
 * della colonna, e dopo `ADD`/`MODIFY`/`ALTER COLUMN nome` di una
 * `ALTER TABLE`. Fuori di lì i tipi non si propongono: in una `SELECT`
 * sarebbero rumore.
 */
export function posizioneTipoDdl(testo, cursore, inizioToken) {
  const istruzione = istruzioneCorrente(testo, cursore);
  if (!RE_DDL_TABELLA.test(istruzione)) return false;

  const prima = String(testo).slice(0, inizioToken == null ? cursore : inizioToken);
  // ALTER TABLE t ADD COLUMN nome |   /   ALTER COLUMN nome TYPE |
  if (RE_DOPO_ADD_COLONNA.test(prima)) return true;
  // CREATE TABLE t ( nome |   /   ..., nome |
  const aperte = contaFuoriDaStringhe(prima, '(') - contaFuoriDaStringhe(prima, ')');
  return aperte > 0 && RE_DOPO_NOME_COLONNA.test(prima);
}

/*
 * Conta un carattere ignorando quelli dentro le stringhe. Una `)` in
 * `COMMENT 'chiave)'` non chiude l'elenco delle colonne, e contarla faceva
 * smettere di proporre i tipi nel bel mezzo di una CREATE TABLE; una `(` in
 * un valore di DEFAULT faceva l'errore opposto.
 */
function contaFuoriDaStringhe(testo, carattere) {
  let n = 0;
  let apice = '';
  for (let i = 0; i < testo.length; i++) {
    const ch = testo[i];
    if (apice) {
      if (ch === '\\') { i++; continue; }
      if (ch === apice) apice = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { apice = ch; continue; }
    if (ch === carattere) n++;
  }
  return n;
}

/**
 * In che lingua è scritta l'istruzione sotto il cursore?
 *
 * **Non si guarda il tipo di database.** Su MongoDB si scrive regolarmente
 * SQL (viene tradotto in MQL), e in quel caso dopo `FROM` servono i nomi delle
 * collezioni: dedurre la lingua dal DBMS invece che dal testo era esattamente
 * l'errore che rendeva inutile il completamento in quel caso.
 *
 * @returns {'sql'|'mongo'|''}  stringa vuota = non si capisce ancora
 */
export function motoreDalTesto(testo, cursore) {
  const istruzione = istruzioneCorrente(testo, cursore);
  if (!istruzione.trim()) return '';
  // La parola iniziale decide: `SELECT * FROM db.utenti` resta SQL anche se
  // contiene un `db.`.
  if (RE_INIZIO_SQL.test(istruzione)) return 'sql';
  if (/^\s*[[{]/.test(istruzione)) return 'mongo';          // filtro o pipeline MQL
  if (/\bdb\s*\.\s*[\w$(]/.test(istruzione)) return 'mongo'; // sintassi shell
  return '';
}

/**
 * Il token che l'utente sta scrivendo, con l'eventuale qualificatore prima del
 * punto (`u.no` → prefisso `no`, qualificatore `u`).
 */
export function tokenAlCursore(testo, cursore) {
  const s = String(testo == null ? '' : testo);
  const pos = Math.max(0, Math.min(Number(cursore) || 0, s.length));
  const prima = s.slice(0, pos);

  const mPrefisso = /([\w$]*)$/.exec(prima);
  const prefisso = mPrefisso ? mPrefisso[1] : '';
  const inizio = pos - prefisso.length;

  const mQual = /([\w$]+|"[^"]+"|`[^`]+`)\.$/.exec(prima.slice(0, inizio));
  const qualificatore = mQual ? mQual[1].replace(/^["`]|["`]$/g, '') : '';

  return { prefisso, qualificatore, inizio, pos };
}

/**
 * L'ultima parola "vera" prima del token in scrittura (in maiuscolo).
 *
 * L'eventuale qualificatore già scritto (`schema.`, `alias.`) non conta come
 * parola: senza saltarlo, `FROM diego.Pro` non avrebbe nessuna parola davanti
 * e il completamento non capirebbe di essere dopo un `FROM`.
 */
function parolaPrecedente(testo, inizioToken) {
  const prima = String(testo).slice(0, inizioToken).replace(/\s+$/, '')
    .replace(/(?:[\w$]+|"[^"]*"|`[^`]*`)\s*\.\s*$/, '')
    .replace(/\s+$/, '');
  const m = /([\w$]+)$/.exec(prima);
  return m ? m[1].toUpperCase() : '';
}

const RE_TABELLA_CITATA = new RegExp(
  `\\b(from|join|update|into)\\s+(${ID_SQL}(?:\\s*\\.\\s*${ID_SQL})*)(?:\\s+(?:as\\s+)?(${ID_SQL}))?`, 'gi');

/**
 * Tabelle citate nella query, con il loro alias.
 * @returns {Array<{nome: string, alias: string}>}
 */
export function tabelleCitate(sql) {
  const s = String(sql == null ? '' : sql);
  const out = [];
  const visti = new Set();
  let m;
  RE_TABELLA_CITATA.lastIndex = 0;
  while ((m = RE_TABELLA_CITATA.exec(s)) !== null) {
    // `schema.tabella`, con o senza virgolette: il nome è l'ultimo pezzo.
    // Le virgolette vanno tolte, perché il nome vero è quello che si confronta
    // con lo schema — su PostgreSQL `FROM diego."Prova" p` cita la tabella
    // `Prova`, e prima quella forma non veniva riconosciuta affatto (quindi
    // l'alias `p` non portava a nessuna colonna).
    const nome = ultimoSegmento(m[2]);
    if (!nome) continue;
    const aliasGrezzo = smarca(m[3] || '');
    const alias = NON_ALIAS.has(aliasGrezzo.toLowerCase()) ? '' : aliasGrezzo;
    const chiave = `${nome} ${alias}`;
    if (visti.has(chiave)) continue;
    visti.add(chiave);
    out.push({ nome, alias });
  }
  return out;
}

/**
 * La collezione su cui si sta lavorando nel punto del cursore, in uno script
 * o in una riga di shell Mongo (`db.utenti.find({ …cursore… })`).
 */
export function collezioneAlCursore(testo, cursore) {
  const prima = String(testo == null ? '' : testo).slice(0, Math.max(0, cursore));
  // L'ULTIMA occorrenza prima del cursore: in uno script con più comandi vale
  // quello in cui si sta scrivendo, non il primo del file.
  const re = /\bdb\.(?:getCollection\(\s*['"]([^'"]+)['"]\s*\)|([\w$]+))\s*\./g;
  let ultima = '';
  let m;
  while ((m = re.exec(prima)) !== null) ultima = m[1] || m[2] || '';
  return ultima;
}

/**
 * Che cosa serve nel punto in cui si trova il cursore.
 * @returns {{tipo: string, prefisso: string, qualificatore: string, tabella: string}}
 *   tipo ∈ 'tabella' | 'colonna' | 'collezione' | 'metodo' | 'campo' | 'operatore'
 */
export function contestoQuery({ testo = '', cursore = 0, motore = 'sql', ripiego = 'sql' } = {}) {
  const { prefisso, qualificatore, inizio } = tokenAlCursore(testo, cursore);
  // 'auto': la lingua la dice il testo; il tipo di connessione serve solo
  // finché il testo non dice niente.
  const rilevato = motore === 'auto' ? motoreDalTesto(testo, cursore) : motore;
  const base = { prefisso, qualificatore, tabella: '', motore: rilevato || ripiego, incerto: !rilevato && motore === 'auto' };

  if ((rilevato || ripiego) === 'mongo') {
    const prima = String(testo).slice(0, inizio);
    // Il `$` fa parte del token (è in [\w$]): un prefisso che comincia con il
    // dollaro è per definizione un operatore in scrittura.
    if (prefisso.startsWith('$')) return { ...base, tipo: 'operatore' };
    if (qualificatore === 'db') return { ...base, tipo: 'collezione' };
    if (qualificatore && /\bdb\.[\w$]+\.$/.test(prima)) {
      return { ...base, tipo: 'metodo', tabella: qualificatore };
    }
    const coll = collezioneAlCursore(testo, cursore);
    return { ...base, tipo: 'campo', tabella: coll };
  }

  // Dopo `FROM`/`JOIN` un punto separa lo SCHEMA dalla tabella, non l'alias
  // dalla colonna: `FROM diego.Prova` chiede una tabella dello schema `diego`.
  // Questo controllo va prima di quello sul qualificatore, altrimenti lì si
  // cercherebbero le colonne di una tabella che si chiama "diego".
  const prec = parolaPrecedente(testo, inizio);
  if (PAROLE_TABELLA.has(prec)) return { ...base, tipo: 'tabella' };

  if (qualificatore) return { ...base, tipo: 'colonna', qualificatore };
  // Il tipo di colonna si propone solo dove la DDL lo pretende.
  if (posizioneTipoDdl(testo, cursore, inizio)) return { ...base, tipo: 'tipo' };
  return { ...base, tipo: 'colonna' };
}

/* ==========================================================================
 * Costruzione dei suggerimenti
 * ========================================================================== */

function campiDi(schema, nomeTabella) {
  if (!schema || !Array.isArray(schema.tabelle) || !nomeTabella) return [];
  const cercato = String(nomeTabella).toLowerCase();
  const t = schema.tabelle.find((x) => String(x.nome).toLowerCase() === cercato);
  return t && Array.isArray(t.campi) ? t.campi : [];
}

function vociCampi(campi, dettaglioExtra) {
  return campi.map((c) => ({
    testo: typeof c === 'string' ? c : String(c.nome),
    tipo: 'campo',
    dettaglio: [typeof c === 'string' ? '' : (c.tipo || ''), dettaglioExtra].filter(Boolean).join(' · '),
  }));
}

/**
 * Ordina e filtra i candidati sul prefisso digitato.
 *
 * Chi comincia con il prefisso viene prima di chi lo contiene soltanto; a
 * parità di punteggio si conserva l'ordine di arrivo, che è già l'ordine di
 * rilevanza deciso da chi ha costruito l'elenco (i campi delle tabelle citate
 * prima delle parole chiave del linguaggio).
 */
export function filtraCandidati(candidati, prefisso, limite = 12) {
  const p = String(prefisso || '').toLowerCase();
  const visti = new Set();
  const puntati = [];

  candidati.forEach((c, ordine) => {
    const voce = typeof c === 'string' ? { testo: c, tipo: 'parola', dettaglio: '' } : c;
    const testo = String(voce.testo || '');
    if (!testo) return;
    const chiave = `${voce.tipo} ${testo.toLowerCase()}`;
    if (visti.has(chiave)) return;

    const basso = testo.toLowerCase();
    let punteggio;
    if (!p) punteggio = 0;
    else if (basso === p) return;               // già scritto per intero
    else if (basso.startsWith(p)) punteggio = 0;
    else if (basso.includes(p)) punteggio = 1;
    else return;

    visti.add(chiave);
    puntati.push({ voce, punteggio, ordine });
  });

  puntati.sort((a, b) => (a.punteggio - b.punteggio) || (a.ordine - b.ordine));
  return puntati.slice(0, limite).map((x) => x.voce);
}

/**
 * Elenco dei suggerimenti per il punto in cui si trova il cursore.
 *
 * @param {object} opts
 * @param {string} opts.testo       contenuto dell'editor o della casella
 * @param {number} opts.cursore     posizione del cursore
 * @param {string} opts.motore      'sql' | 'mongo' | 'auto' (lingua dal testo)
 * @param {string} opts.ripiego     lingua da usare con 'auto' finché il testo tace
 * @param {object} opts.schema      { tabelle: [{ nome, campi }] } già caricato
 * @param {string[]} opts.colonne   colonne della tabella aperta (ripiego)
 * @param {string} opts.collezione  tabella/collezione aperta (ripiego)
 * @param {string} opts.dbms        motore in uso ('mysql'|'postgresql'|'mongodb'):
 *                                  aggiunge funzioni, clausole e tipi di quel dialetto
 * @param {string} opts.database    database (su PostgreSQL: schema) a cui appartiene
 *                                  lo schema caricato, per i nomi qualificati
 * @param {boolean} opts.parole     includere le parole chiave del linguaggio
 * @param {string[]} opts.vocabolario  parole chiave da usare al posto di quelle standard
 * @param {number} opts.limite
 */
export function suggerisci(opts = {}) {
  const {
    testo = '', cursore = 0, motore = 'sql', ripiego = 'sql', schema = null,
    colonne = [], collezione = '', parole = true, vocabolario = null, limite = 12,
    dbms = '', database = '',
  } = opts;

  // Vocabolario del motore in uso. Con un DBMS sconosciuto (o non passato) è
  // vuoto, e il completamento resta quello comune: aggiungere il dialetto non
  // toglie mai niente a chi c'era prima.
  const dialetto = vocabolarioSql(dbms);

  const ctx = contestoQuery({ testo, cursore, motore, ripiego });
  // Da qui in poi conta la lingua RISOLTA, non quella chiesta: con 'auto' è
  // il testo ad averla decisa.
  const lingua = ctx.motore;
  const tabelle = Array.isArray(schema && schema.tabelle) ? schema.tabelle : [];
  const nomiTabella = tabelle.map((t) => ({
    tipo: 'tabella',
    testo: String(t.nome),
    dettaglio: Array.isArray(t.campi) && t.campi.length ? `${t.campi.length} campi` : '',
  }));

  let candidati = [];

  if (ctx.tipo === 'tabella') {
    // Nome qualificato: le tabelle che conosciamo sono quelle del database (su
    // PostgreSQL: dello schema) aperto. Se il qualificatore ne indica un altro
    // non si propone niente — proporre i nomi di QUESTO schema come se fossero
    // di quello sarebbe un elenco falso.
    const altroSchema = ctx.qualificatore && database
      && ctx.qualificatore.toLowerCase() !== String(database).toLowerCase();
    candidati = altroSchema ? [] : nomiTabella;
  } else if (ctx.tipo === 'collezione') {
    // Dopo `db.` non ci sono solo le collezioni: `db.getCollection(…)`,
    // `db.runCommand(…)` e compagnia stanno lì e prima non comparivano.
    candidati = nomiTabella
      .concat(METODI_DB_MONGO.map((m) => ({ testo: m, tipo: 'metodo', dettaglio: 'db' })));
  } else if (ctx.tipo === 'tipo') {
    candidati = dialetto.tipi.map((t) => ({ testo: t, tipo: 'tipo', dettaglio: dialetto.nome }));
  } else if (ctx.tipo === 'metodo') {
    candidati = METODI_MONGO.map((m) => ({ testo: m, tipo: 'metodo', dettaglio: '' }));
  } else if (ctx.tipo === 'operatore') {
    candidati = OPERATORI_MONGO.map((o) => ({ testo: o, tipo: 'operatore', dettaglio: '' }));
  } else if (lingua === 'mongo') {
    // Campi della collezione su cui si sta scrivendo; se non se ne riconosce
    // una, quelli della collezione aperta.
    const nome = ctx.tabella || collezione;
    const daSchema = campiDi(schema, nome);
    candidati = daSchema.length
      ? vociCampi(daSchema, nome)
      : (colonne || []).map((c) => ({ testo: String(c), tipo: 'campo', dettaglio: collezione }));
    if (parole) {
      candidati = candidati.concat(OPERATORI_MONGO.map((o) => ({ testo: o, tipo: 'operatore', dettaglio: '' })));
      // Riga ancora ambigua su una connessione MongoDB: si propongono anche i
      // nomi delle collezioni e le parole con cui comincia un'istruzione SQL.
      // Su MongoDB l'SQL si può scrivere (viene tradotto), e chi digita "SEL"
      // deve poter arrivare a `SELECT` senza sapere che qui esiste anche
      // quella strada.
      if (ctx.incerto) {
        candidati = candidati
          .concat(nomiTabella)
          .concat(INIZI_SQL.map((k) => ({ testo: k, tipo: 'parola', dettaglio: 'SQL' })));
      }
    }
  } else if (ctx.qualificatore) {
    // `u.` → solo le colonne di ciò a cui `u` si riferisce. Se il nome non è
    // riconducibile a nessuna tabella non si propone nulla: proporre le
    // colonne "di qualcos'altro" sarebbe peggio del silenzio.
    const citate = tabelleCitate(testo);
    const trovata = citate.find((t) => t.alias && t.alias.toLowerCase() === ctx.qualificatore.toLowerCase())
      || citate.find((t) => t.nome.toLowerCase() === ctx.qualificatore.toLowerCase());
    const nome = trovata ? trovata.nome : ctx.qualificatore;
    candidati = vociCampi(campiDi(schema, nome), nome);
  } else {
    // Colonne delle tabelle citate nella query, poi quelle della tabella
    // aperta, poi tabelle e vocabolario.
    const citate = tabelleCitate(testo);
    for (const t of citate) candidati = candidati.concat(vociCampi(campiDi(schema, t.nome), t.alias || t.nome));
    if (!candidati.length && colonne && colonne.length) {
      candidati = (colonne || []).map((c) => ({ testo: String(c), tipo: 'campo', dettaglio: collezione }));
    }
    if (parole) {
      // Funzioni: quelle comuni a tutti i dialetti più quelle del motore in
      // uso. `soloQueste` è il caso di MongoDB via SQL→MQL, dove il traduttore
      // riconosce i soli aggregati: proporre `UPPER` lì sarebbe una trappola.
      // Le CLAUSOLE del dialetto seguono il vocabolario ristretto (nel filtro
      // della griglia non si scrive `ON DUPLICATE KEY UPDATE`), le FUNZIONI no:
      // in una condizione WHERE una `DATE_FORMAT` ci sta benissimo.
      const funzioniComuni = dialetto.soloQueste ? [] : FUNZIONI_SQL;
      candidati = candidati
        .concat(nomiTabella)
        .concat((vocabolario || PAROLE_SQL).map((k) => ({ testo: k, tipo: 'parola', dettaglio: '' })))
        .concat(vocabolario ? [] : dialetto.parole.map((k) => ({ testo: k, tipo: 'parola', dettaglio: dialetto.nome })))
        .concat(funzioniComuni.map((k) => ({ testo: k, tipo: 'funzione', dettaglio: '' })))
        .concat(dialetto.funzioni.map((k) => ({ testo: k, tipo: 'funzione', dettaglio: dialetto.nome })));
    }
  }

  return filtraCandidati(candidati, ctx.prefisso, limite);
}

/**
 * Testo risultante dall'accettazione di un suggerimento, con la nuova
 * posizione del cursore. Sta qui, e non nel wiring del DOM, perché è la
 * regola che decide quanto testo viene sostituito — la parte che, sbagliata,
 * mangia caratteri che l'utente aveva scritto.
 */
export function applicaSuggerimento(testo, cursore, suggerimento, opts = {}) {
  const s = String(testo == null ? '' : testo);
  let { inizio, pos } = tokenAlCursore(s, cursore);
  let scelto = String(suggerimento || '');

  // Nomi di tabella, collezione e colonna: si scrivono quotati quando il
  // motore lo richiede. È il punto in cui si evita l'errore più insidioso di
  // PostgreSQL — `FROM diego.Prova` cerca `diego.prova`, perché senza apici il
  // motore abbassa il nome, e la tabella "non esiste".
  const identificatore = opts.tipo === 'tabella' || opts.tipo === 'campo' || opts.tipo === 'colonna';
  if (identificatore && opts.dbms && (opts.lingua || 'sql') === 'sql') {
    scelto = quotaIdentificatore(scelto, opts.dbms);
  }

  // Se l'utente aveva già aperto le virgolette (`FROM "Pro`), quelle fanno
  // parte del nome che si sta scrivendo: vanno sostituite insieme al resto,
  // altrimenti si otterrebbe `""Prova"`.
  const apice = scelto[0];
  if (identificatore && (apice === '"' || apice === '`') && s[inizio - 1] === apice) {
    inizio -= 1;
    if (s[pos] === apice) pos += 1;
  }

  // Il token in scrittura comprende già l'eventuale `$` iniziale, quindi la
  // sostituzione parte da lì: `$g` + `$gt` non deve dare `$$gt`.
  const nuovo = s.slice(0, inizio) + scelto + s.slice(pos);
  return { testo: nuovo, cursore: inizio + scelto.length };
}
