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
 * Il vocabolario SQL è importato dall'evidenziatore: le parole messe in
 * maiuscolo sono esattamente quelle che vengono colorate come parole chiave, e
 * non possono divergere.
 */

import { SQL_KEYWORDS, SQL_TYPES, SQL_FUNCTIONS } from './query-highlighter.js';
import { formattaJsonBson, minificaJsonBson, sembraJsonBson } from './json-bson.js';

const INDENT = '  ';

/* ==========================================================================
 * Dispatcher
 * ========================================================================== */

/** Il testo è uno script JavaScript (e non SQL o JSON)? */
export function sembraJs(code) {
  const s = String(code || '');
  if (/^\s*[[{]/.test(s)) return false;
  return /\b(var|let|const|function|return|if|else|for|while|do|try|catch|throw|new)\b/.test(s)
    || /=>/.test(s);
}

/**
 * Formatta il contenuto dell'editor scegliendo da sé il linguaggio.
 * In caso di dubbio (o di sintassi non analizzabile) restituisce il testo
 * ORIGINALE: una formattazione che corrompe il codice è molto peggio di una
 * formattazione mancata.
 */
export function formatCode(code) {
  const testo = String(code == null ? '' : code);
  const trimmed = testo.trim();
  if (!trimmed) return testo;

  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return formatJsonLike(trimmed);
    if (sembraJs(trimmed)) return reindentJs(testo);
    return formatSql(trimmed);
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
export function minifyCode(code) {
  const testo = String(code == null ? '' : code);
  const trimmed = testo.trim();
  if (!trimmed) return testo;

  try {
    if (sembraJsonBson(trimmed)) return minificaJsonBson(trimmed);
    if (sembraJs(trimmed)) return testo;
    return minifySql(trimmed);
  } catch (_err) {
    return testo;
  }
}

/**
 * SQL su una riga sola. I commenti spariscono (un `--` su una riga sola
 * commenterebbe tutto il resto), stringhe e identificatori quotati restano
 * intatti perché il tokenizzatore li tratta come unità indivisibili.
 */
export function minifySql(sql) {
  const toks = tokenizzaSql(sql).filter((t) => t.t !== 'commento');
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const prec = toks[i - 1];
    if (!out) { out = tok.v; continue; }
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
function tokenizzaSql(sql) {
  const s = String(sql);
  const toks = [];
  let i = 0;
  const n = s.length;

  while (i < n) {
    const c = s[i];

    if (/\s/.test(c)) { i++; continue; }

    if (c === '-' && s[i + 1] === '-') {
      let fine = s.indexOf('\n', i);
      if (fine < 0) fine = n;
      toks.push({ t: 'commento', v: s.slice(i, fine) });
      i = fine;
      continue;
    }
    if (c === '#') {
      let fine = s.indexOf('\n', i);
      if (fine < 0) fine = n;
      toks.push({ t: 'commento', v: s.slice(i, fine) });
      i = fine;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      let fine = s.indexOf('*/', i + 2);
      fine = fine < 0 ? n : fine + 2;
      toks.push({ t: 'commento', v: s.slice(i, fine) });
      i = fine;
      continue;
    }

    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } j++; break; }
        j++;
      }
      toks.push({ t: 'stringa', v: s.slice(i, j) });
      i = j;
      continue;
    }

    if (c === '"' || c === '`') {
      const fineChar = c;
      let j = i + 1;
      while (j < n && s[j] !== fineChar) j++;
      toks.push({ t: 'quotato', v: s.slice(i, j + 1) });
      i = j + 1;
      continue;
    }

    // Dollar-quoting PostgreSQL: il corpo è codice altrui, si copia com'è.
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const fine = s.indexOf(tag, i + tag.length);
        const j = fine < 0 ? n : fine + tag.length;
        toks.push({ t: 'stringa', v: s.slice(i, j) });
        i = j;
        continue;
      }
    }

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      let v = '';
      while (i < n && /[0-9.]/.test(s[i])) { v += s[i]; i++; }
      toks.push({ t: 'numero', v });
      continue;
    }

    if (/[A-Za-z_@]/.test(c)) {
      let v = '';
      while (i < n && /[A-Za-z0-9_@$]/.test(s[i])) { v += s[i]; i++; }
      const up = v.toUpperCase();
      const tipo = SQL_KEYWORDS.has(up) ? 'kw' : (SQL_TYPES.has(up) ? 'tipo' : (SQL_FUNCTIONS.has(up) ? 'fn' : 'ident'));
      toks.push({ t: tipo, v: tipo === 'ident' ? v : up });
      continue;
    }

    if ('(),;'.includes(c)) {
      toks.push({ t: 'punt', v: c });
      i++;
      continue;
    }

    // Operatori, anche a due caratteri (<=, >=, <>, !=, ||, ::)
    const due = s.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '||', '::'].includes(due)) {
      toks.push({ t: 'op', v: due });
      i += 2;
      continue;
    }
    toks.push({ t: 'op', v: c });
    i++;
  }

  return toks;
}

/**
 * Formatta uno o più comandi SQL.
 *
 * Non riscrive la semantica: riordina soltanto spazi e a capo, e mette in
 * maiuscolo le parole riconosciute come SQL (mai gli identificatori, mai il
 * contenuto di stringhe e commenti).
 */
export function formatSql(sql) {
  const toks = tokenizzaSql(sql);
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
      else { riga = tok.v; chiudiRiga(); }
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
