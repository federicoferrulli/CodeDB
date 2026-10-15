/**
 * CodeDB — Formattazione del codice nell'editor ⚡ Query & Aggregate
 *
 * Il bottone "Formatta" prima sapeva fare una cosa sola: `JSON.stringify` se il
 * testo cominciava con `{` o `[`. Su SQL non faceva **nulla**, in silenzio —
 * il caso peggiore per un comando, perché sembra rotto senza dirlo.
 *
 * Qui ci sono tre formattatori, scelti in base a cosa c'è davvero nell'editor:
 *
 *  - **SQL** (`formatSql`): ricostruito dai token, con le clausole a capo, le
 *    parole chiave in maiuscolo e le definizioni di colonna una per riga.
 *  - **MQL/EJSON** (`formatJsonLike`): indentazione JSON, come prima.
 *  - **Script JavaScript** (`reindentJs`): **solo** rientri. Un vero
 *    riformattatore JS riscriverebbe il codice, e sbagliare lì significa
 *    rompere lo script dell'utente: qui si tocca esclusivamente lo spazio a
 *    inizio riga, mai il contenuto.
 *
 * Il lessico è condiviso con l'evidenziatore; i nomi di funzioni e tipi arrivano
 * dagli stessi cataloghi usati dal completamento.
 */

import { SQL_KEYWORDS, SQL_TYPES, SQL_FUNCTIONS } from './query-highlighter.js';
import { vocabolarioSql, dialettoDi } from './sql-dialetti.js';
import { tokenizzaQuery, linguaQuery } from './query-lexer.js';
import { formattaJsonBson, minificaJsonBson, sembraJsonBson } from './json-bson.js';

const INDENT = '  ';

/* ==========================================================================
 * Dispatcher
 * ========================================================================== */

/** Il testo è uno script JavaScript (e non SQL o JSON)? */
export function sembraJs(code) {
  if (/^\s*[[{]/.test(String(code))) return false;
  return linguaQuery(code, '') === 'mongo' || (!linguaQuery(code, '') && /=>/.test(String(code)));
}

/**
 * Formatta il contenuto dell'editor scegliendo da sé il linguaggio.
 * In caso di dubbio (o di sintassi non analizzabile) restituisce il testo
 * ORIGINALE: una formattazione che corrompe il codice è molto peggio di una
 * formattazione mancata.
 */
export function formatCode(code, dbms = '') {
  const testo = String(code == null ? '' : code);
  const trimmed = testo.trim();
  if (!trimmed) return testo;

  try {
    if (dbms === 'mongosh') return reindentJs(testo);
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return formatJsonLike(trimmed);
    if (sembraJs(trimmed)) return reindentJs(testo);
    return formatSql(trimmed, dbms);
  } catch (_err) {
    return testo;
  }
}

/**
 * Indentazione di un filtro MQL o di una pipeline (Extended JSON compreso).
 *
 * Non passa più da `JSON.parse` + `JSON.stringify`: quel giro rifiuta la
 * sintassi della shell (`{ _id: ObjectId("…") }`, apici singoli, chiavi nude) e
 * soprattutto **perde cifre** sugli interi oltre i 53 bit, che tornerebbero
 * arrotondati senza un avviso. `formattaJsonBson` riemette i valori alla
 * lettera. Il vecchio giro resta come ripiego per il JSON stretto.
 */
export function formatJsonLike(text) {
  try {
    return formattaJsonBson(text, { indent: INDENT });
  } catch (err) {
    return JSON.stringify(JSON.parse(String(text)), null, 2);
  }
}

/**
 * L'inverso di `formatCode`: tutto su una riga, senza spazi superflui.
 *
 * Serve a incollare un filtro in un campo che non va a capo, in una riga di
 * log o in un comando della shell. Come per la formattazione, in caso di
 * dubbio si restituisce il testo ORIGINALE invece di rischiare di corromperlo:
 * gli script JavaScript, dove togliere gli a capo cambia il significato (ASI,
 * commenti di riga), non vengono minificati affatto.
 */
export function minifyCode(code, dbms = '') {
  const testo = String(code == null ? '' : code);
  const trimmed = testo.trim();
  if (!trimmed) return testo;
  if (dbms === 'mongosh') return testo;

  try {
    if (sembraJsonBson(trimmed)) return minificaJsonBson(trimmed);
    if (sembraJs(trimmed)) return testo;
    return minifySql(trimmed, dbms);
  } catch (_err) {
    return testo;
  }
}

/**
 * SQL su una riga sola. I commenti spariscono (un `--` su una riga sola
 * commenterebbe tutto il resto), stringhe e identificatori quotati restano
 * intatti perché il tokenizzatore li tratta come unità indivisibili.
 */
export function minifySql(sql, dbms = '') {
  const toks = tokenizzaSql(sql, dbms).filter((t) => t.t !== 'commento');
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const prec = toks[i - 1];
    if (!out) { out = tok.v; continue; }
    if (tok.saltoPrima) { out += `\n${tok.v}`; continue; }
    const attaccato = (tok.t === 'punt' && tok.v !== '(')
      || (tok.t === 'op' && (tok.v === '.' || tok.v === '::'))
      || (prec && prec.t === 'punt' && prec.v === '(')
      || (prec && prec.t === 'op' && (prec.v === '.' || prec.v === '::'))
      || (tok.t === 'punt' && tok.v === '(' && prec && (prec.t === 'fn' || prec.t === 'ident' || prec.t === 'tipo'));
    out += attaccato ? tok.v : ` ${tok.v}`;
  }
  return out;
}

/* ==========================================================================
 * SQL
 * ========================================================================== */

// Clausole che vanno a capo al livello esterno di parentesi.
const CLAUSOLE = new Set([
  'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'VALUES', 'SET',
  'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING', 'WITH', 'FETCH',
]);
// Clausole composte da due parole: vanno riconosciute insieme, altrimenti
// "GROUP" andrebbe a capo e "BY" resterebbe attaccato alla riga dopo.
const CLAUSOLE_DOPPIE = new Set(['GROUP BY', 'ORDER BY', 'UNION ALL', 'ON CONFLICT']);
// Parole che introducono una JOIN: la riga comincia da lì.
const PREFISSI_JOIN = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL']);

/**
 * Tokenizza l'SQL conservando stringhe, commenti e identificatori quotati come
 * unità indivisibili: sono l'unica parte che non va MAI toccata.
 */
function tokenizzaSql(sql, dbms = '') {
  dbms = dialettoDi(dbms);
  const tokens = tokenizzaQuery(sql, { dbms, lingua: 'sql' }).filter(t => t.tipo !== 'spazio');
  const dialetto = vocabolarioSql(dbms);
  const parole = new Set(dialetto.keywords.length ? dialetto.keywords : SQL_KEYWORDS);
  const funzioni = dialetto.nome ? new Set([...dialetto.funzioni, ...dialetto.estensioni].map(x => x.toUpperCase())) : SQL_FUNCTIONS;
  // Un literal incompleto non va riscritto mentre l'utente lo sta componendo.
  if (tokens.some(t => !t.chiuso && t.tipo !== 'commento')) throw new Error('Testo incompleto');
  const tipi = { stringa: 'stringa', identificatore: 'quotato', commento: 'commento', hint: 'hint',
    numero: 'numero', parametro: 'parametro', punteggiatura: 'punt', operatore: 'op' };
  let ddl = false;
  let precedenteSignificativo;
  return tokens.map((tok, i) => {
    const precedente = precedenteSignificativo;
    if (tok.tipo !== 'commento') precedenteSignificativo = tok;
    if (tok.testo === ';') ddl = false;
    if (tok.tipo !== 'parola') {
      const saltoPrima = dbms === 'postgresql' && tok.tipo === 'stringa' && precedente?.tipo === 'stringa'
        && /[\r\n]/.test(sql.slice(precedente.fine, tok.inizio));
      return { t: tipi[tok.tipo], v: tok.testo, saltoPrima };
    }
    const up = tok.testo.toUpperCase();
    if (up === 'CREATE' || up === 'ALTER') ddl = true;
    const tipo = funzioni.has(up) && tokens[i + 1]?.testo === '(' ? 'fn'
      : SQL_KEYWORDS.has(up) ? 'kw' : ddl && SQL_TYPES.has(up) ? 'tipo' : parole.has(up) ? 'kw' : 'ident';
    // Le keyword non riservate possono essere nomi di tabelle o colonne:
    // riconoscerle non autorizza a cambiare le maiuscole dell'identificatore.
    return { t: tipo, v: tipo === 'fn' || tipo === 'tipo' || SQL_KEYWORDS.has(up) ? up : tok.testo };
  });
}

/**
 * Formatta uno o più comandi SQL.
 *
 * Non riscrive la semantica: riordina soltanto spazi e a capo, e mette in
 * maiuscolo le parole riconosciute come SQL (mai gli identificatori, mai il
 * contenuto di stringhe e commenti).
 */
export function formatSql(sql, dbms = '') {
  const toks = tokenizzaSql(sql, dbms);
  if (!toks.length) return String(sql);

  const righe = [];
  let riga = '';
  let livelloParentesi = 0;
  let indentRiga = 0;
  // Sta formattando l'elenco di colonne di una CREATE TABLE?
  let colonneDdl = false;
  let profonditaColonne = 0;
  let statementIniziato = false;
  let primaParolaStatement = null;

  const chiudiRiga = () => {
    if (riga.trim()) righe.push(INDENT.repeat(indentRiga) + riga.trim());
    riga = '';
  };

  const vaACapo = (indent) => {
    chiudiRiga();
    indentRiga = indent;
  };

  const parolaDoppia = (idx) => {
    const a = toks[idx];
    const b = toks[idx + 1];
    if (!a || !b) return null;
    if (a.t !== 'kw' || (b.t !== 'kw' && b.t !== 'ident')) return null;
    const coppia = `${a.v} ${String(b.v).toUpperCase()}`;
    return CLAUSOLE_DOPPIE.has(coppia) ? coppia : null;
  };

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const prec = toks[i - 1];
    if (tok.saltoPrima) chiudiRiga();

    // Fine istruzione: `;` chiude la riga e separa i comandi con una riga vuota.
    if (tok.t === 'punt' && tok.v === ';') {
      riga = `${riga.trimEnd()};`;
      chiudiRiga();
      indentRiga = 0;
      livelloParentesi = 0;
      colonneDdl = false;
      statementIniziato = false;
      primaParolaStatement = null;
      righe.push('');
      continue;
    }

    if (tok.t === 'commento') {
      // Un commento a fine riga resta dov'è; uno isolato prende una riga sua.
      if (riga.trim()) riga += ` ${tok.v}`;
      else riga = tok.v;
      chiudiRiga();
      continue;
    }

    if (tok.t === 'punt' && tok.v === '(') {
      livelloParentesi++;
      // La parentesi di una CREATE TABLE apre un elenco, non una chiamata di
      // funzione: va staccata dal nome della tabella.
      const elencoDdl = colonneDdl && livelloParentesi === 1;
      const attaccata = !elencoDdl && prec && (prec.t === 'fn' || prec.t === 'ident' || prec.t === 'tipo');
      riga += attaccata ? '(' : (riga ? ' (' : '(');
      if (elencoDdl) {
        profonditaColonne = 1;
        vaACapo(1);
      }
      continue;
    }

    if (tok.t === 'punt' && tok.v === ')') {
      if (colonneDdl && livelloParentesi === profonditaColonne) {
        vaACapo(0);
        riga = ')';
        livelloParentesi--;
        colonneDdl = false;
        continue;
      }
      livelloParentesi = Math.max(0, livelloParentesi - 1);
      riga = `${riga.trimEnd()})`;
      continue;
    }

    if (tok.t === 'punt' && tok.v === ',') {
      riga = `${riga.trimEnd()},`;
      // Nelle definizioni di colonna ogni voce va a capo; altrove si resta in
      // linea, perché una lista di campi corta è più leggibile su una riga.
      if (colonneDdl && livelloParentesi === profonditaColonne) vaACapo(1);
      continue;
    }

    if (tok.t === 'kw') {
      const doppia = parolaDoppia(i);

      if (livelloParentesi === 0) {
        if (doppia) {
          vaACapo(0);
          riga = doppia;
          i++; // consuma la seconda parola
          continue;
        }
        if (CLAUSOLE.has(tok.v)) {
          // La prima clausola dell'istruzione non deve produrre una riga vuota.
          if (statementIniziato) vaACapo(0);
          riga += riga ? ` ${tok.v}` : tok.v;
          statementIniziato = true;
          if (!primaParolaStatement) primaParolaStatement = tok.v;
          continue;
        }
        if (tok.v === 'AND' || tok.v === 'OR') {
          vaACapo(1);
          riga = tok.v;
          continue;
        }
        // `INNER JOIN` è una cosa sola: se la riga è già stata aperta dal
        // prefisso (INNER/LEFT/…), `JOIN` deve restarci attaccato invece di
        // finire su una riga tutta sua.
        const dopoPrefissoJoin = prec && prec.t === 'kw'
          && (PREFISSI_JOIN.has(prec.v) || prec.v === 'OUTER');
        if (tok.v === 'JOIN' && dopoPrefissoJoin) {
          riga += ` ${tok.v}`;
          continue;
        }
        if (tok.v === 'JOIN' || (PREFISSI_JOIN.has(tok.v) && toks.slice(i + 1, i + 3).some((t) => t && t.v === 'JOIN'))) {
          vaACapo(0);
          riga = tok.v;
          continue;
        }
        if (tok.v === 'OUTER' && dopoPrefissoJoin) {
          riga += ` ${tok.v}`;
          continue;
        }
        if (tok.v === 'ON' && righe.length) {
          vaACapo(1);
          riga = tok.v;
          continue;
        }
      }
    }

    // Inizio di un'istruzione DDL con definizione di colonne.
    if (!statementIniziato && tok.t === 'kw') {
      primaParolaStatement = tok.v;
      statementIniziato = true;
    }
    if (primaParolaStatement === 'CREATE' && tok.t === 'kw' && tok.v === 'TABLE') {
      colonneDdl = true;
    }

    const testo = tok.v;
    if (!riga) riga = testo;
    else if (tok.t === 'punt') riga += testo;
    else if (prec && prec.t === 'punt' && prec.v === '(') riga += testo;
    else if (tok.t === 'op' && (testo === '.' || testo === '::')) riga = riga.trimEnd() + testo;
    else if (prec && prec.t === 'op' && (prec.v === '.' || prec.v === '::')) riga += testo;
    else riga += ` ${testo}`;
  }

  chiudiRiga();

  // Via le righe vuote in eccesso lasciate dai `;` finali.
  while (righe.length && !righe[righe.length - 1].trim()) righe.pop();
  return righe.join('\n');
}

/* ==========================================================================
 * Script JavaScript — soli rientri
 * ========================================================================== */

/**
 * Ricalcola l'indentazione di uno script in base alla profondità di parentesi
 * graffe/tonde/quadre. **Non tocca il contenuto delle righe**: stringhe,
 * template literal e commenti restano identici al carattere, e una riga che
 * comincia dentro un template multilinea non viene nemmeno reindentata (lo
 * spazio lì dentro fa parte del testo).
 */
export function reindentJs(code) {
  const righe = String(code == null ? '' : code).split('\n');
  const out = [];
  let profondita = 0;
  let stato = { inCommentoBlocco: false, inTemplate: false };

  for (const riga of righe) {
    const dentroTesto = stato.inTemplate || stato.inCommentoBlocco;
    const analisi = analizzaRiga(riga, stato);

    if (dentroTesto) {
      // Continuazione di un template literal o di un commento: riga intoccabile.
      out.push(riga);
      profondita += analisi.delta;
      stato = analisi.stato;
      continue;
    }

    const testo = riga.trim();
    if (!testo) {
      out.push('');
      profondita += analisi.delta;
      stato = analisi.stato;
      continue;
    }

    // Una riga che INIZIA con una chiusura si allinea al blocco che chiude,
    // non al suo contenuto.
    const livello = Math.max(0, profondita - analisi.chiusureIniziali);
    out.push(INDENT.repeat(livello) + testo);
    profondita = Math.max(0, profondita + analisi.delta);
    stato = analisi.stato;
  }

  return out.join('\n');
}

/**
 * Percorre una riga tenendo conto di stringhe, commenti e template literal, e
 * riporta quanto cambia la profondità e come si esce dalla riga.
 */
function analizzaRiga(riga, statoIniziale) {
  const s = String(riga);
  let i = 0;
  let delta = 0;
  let chiusureIniziali = 0;
  let vistoContenuto = false;
  let inCommentoBlocco = statoIniziale.inCommentoBlocco;
  let inTemplate = statoIniziale.inTemplate;

  while (i < s.length) {
    const c = s[i];

    if (inCommentoBlocco) {
      if (c === '*' && s[i + 1] === '/') { inCommentoBlocco = false; i += 2; continue; }
      i++;
      continue;
    }
    if (inTemplate) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { inTemplate = false; i++; continue; }
      i++;
      continue;
    }

    if (c === '/' && s[i + 1] === '/') break;            // commento fino a fine riga
    if (c === '/' && s[i + 1] === '*') { inCommentoBlocco = true; i += 2; continue; }
    if (c === '`') { inTemplate = true; i++; continue; }

    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) { i++; break; }
        i++;
      }
      vistoContenuto = true;
      continue;
    }

    if ('{(['.includes(c)) { delta++; vistoContenuto = true; i++; continue; }
    if ('})]'.includes(c)) {
      delta--;
      // Chiusure in testa alla riga: servono a calcolare il rientro di QUESTA
      // riga, non della successiva.
      if (!vistoContenuto) chiusureIniziali++;
      i++;
      continue;
    }

    if (!/\s/.test(c)) vistoContenuto = true;
    i++;
  }

  return { delta, chiusureIniziali, stato: { inCommentoBlocco, inTemplate } };
}
