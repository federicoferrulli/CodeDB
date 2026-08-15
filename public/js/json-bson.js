/**
 * CodeDB — JSON / BSON: validazione, formattazione e minificazione
 *
 * `JSON.parse` non basta per quello che si scrive davvero in questa
 * applicazione. Un filtro MQL, un documento incollato dalla shell o una riga
 * copiata dai risultati contengono regolarmente cose che il parser standard
 * rifiuta:
 *
 *   { _id: ObjectId("64f0…"), creato: ISODate("2026-01-01"), nome: 'Anna' }
 *
 * Chiavi senza virgolette, apici singoli, costruttori BSON, espressioni
 * regolari, commenti. Passare quel testo a `JSON.parse` per validarlo
 * significherebbe segnalare come errore un documento perfettamente valido —
 * un linter che grida al lupo viene ignorato, e allora tanto vale non averlo.
 *
 * Qui c'è quindi un tokenizzatore e un parser tolleranti, che accettano la
 * sintassi della shell Mongo oltre al JSON stretto, e sopra di essi tre
 * funzioni:
 *
 *  - `analizzaJsonBson`  — dice se il testo è valido e, se non lo è, **dove**
 *    (riga e colonna) e **perché**, in italiano. È il linting in linea.
 *  - `formattaJsonBson`  — reindenta preservando i token **alla lettera**:
 *    `NumberLong("9007199254740993")` non passa da un `Number` che ne
 *    perderebbe le cifre, e `ObjectId(...)` resta un ObjectId. Questo è il
 *    motivo per cui la formattazione non è un `JSON.parse` + `stringify`.
 *  - `minificaJsonBson` — la stessa cosa senza spazi superflui.
 *
 * I commenti sopravvivono alla formattazione (vengono riemessi sulla riga che
 * precedono) ma **non** alla minificazione: su una riga sola un `//`
 * mangerebbe tutto il resto del documento, quindi lì vengono tolti.
 */

const INDENT_DEFAULT = '  ';
// Un documento annidato oltre questa soglia è quasi certamente generato male:
// il limite protegge la ricorsione del parser (che gira a ogni tasto premuto).
const MAX_PROFONDITA = 200;

// Le uniche parole che possono comparire nude al posto di un valore.
const LETTERALI = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'MinKey', 'MaxKey',
]);

export class ErroreJsonBson extends Error {
  constructor(messaggio, indice) {
    super(messaggio);
    this.name = 'ErroreJsonBson';
    this.indice = Math.max(0, Number(indice) || 0);
  }
}

/** Riga e colonna (1-based) dell'indice dato dentro il testo. */
export function posizioneDi(testo, indice) {
  const fino = String(testo == null ? '' : testo).slice(0, Math.max(0, indice));
  const righe = fino.split('\n');
  return { riga: righe.length, colonna: righe[righe.length - 1].length + 1 };
}

/* ==========================================================================
 * Tokenizzatore
 * ========================================================================== */

const PUNTEGGIATURA = '{}[],:';

function erroreStringaNonChiusa(i) {
  return new ErroreJsonBson('Stringa aperta e mai chiusa: manca la virgoletta finale.', i);
}

/**
 * Divide il testo in token conservando il testo GREZZO di ognuno: è quello che
 * verrà riemesso, e per questo la formattazione non può cambiare un valore.
 *
 * @returns {Array<{t: string, v: string, i: number}>}
 */
export function tokenizzaJsonBson(testo) {
  const s = String(testo == null ? '' : testo);
  const n = s.length;
  const toks = [];
  let i = 0;

  while (i < n) {
    const c = s[i];

    if (/\s/.test(c)) { i++; continue; }

    // Commenti (sintassi shell, non JSON: si conservano ma non sono valori).
    if (c === '/' && s[i + 1] === '/') {
      let fine = s.indexOf('\n', i);
      if (fine < 0) fine = n;
      toks.push({ t: 'commento', v: s.slice(i, fine), i });
      i = fine;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const fine = s.indexOf('*/', i + 2);
      if (fine < 0) throw new ErroreJsonBson('Commento /* … */ aperto e mai chiuso.', i);
      toks.push({ t: 'commento', v: s.slice(i, fine + 2), i });
      i = fine + 2;
      continue;
    }

    if (c === '"' || c === "'") {
      const inizio = i;
      const q = c;
      i++;
      let chiusa = false;
      while (i < n) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '\n') break; // una stringa non attraversa le righe
        if (s[i] === q) { i++; chiusa = true; break; }
        i++;
      }
      if (!chiusa) throw erroreStringaNonChiusa(inizio);
      toks.push({ t: 'stringa', v: s.slice(inizio, i), i: inizio });
      continue;
    }

    if (PUNTEGGIATURA.includes(c)) {
      toks.push({ t: 'punt', v: c, i });
      i++;
      continue;
    }

    // Espressione regolare: /abc/i — valore legittimo in un filtro Mongo.
    if (c === '/') {
      const inizio = i;
      i++;
      let inClasse = false;
      let chiusa = false;
      while (i < n) {
        const d = s[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClasse = true;
        else if (d === ']') inClasse = false;
        else if (d === '/' && !inClasse) { i++; chiusa = true; break; }
        i++;
      }
      if (!chiusa) throw new ErroreJsonBson('Espressione regolare aperta e mai chiusa.', inizio);
      while (i < n && /[a-z]/.test(s[i])) i++; // flag
      toks.push({ t: 'valore', v: s.slice(inizio, i), i: inizio });
      continue;
    }

    if (/[-+0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      const inizio = i;
      // `-Infinity` e `+NaN` sono numeri con il segno, non identificatori.
      const speciale = /^[-+](?:Infinity|NaN)\b/.exec(s.slice(i));
      if (speciale) {
        i += speciale[0].length;
        toks.push({ t: 'valore', v: speciale[0], i: inizio });
        continue;
      }
      i++;
      while (i < n && /[0-9a-fA-FxXoObBeE.+_-]/.test(s[i])) {
        // `+`/`-` fanno parte del numero solo dentro un esponente (1e-3).
        if ((s[i] === '+' || s[i] === '-') && !/[eE]/.test(s[i - 1])) break;
        i++;
      }
      const grezzo = s.slice(inizio, i);
      if (!/^[-+]?(?:0[xXbBoO][0-9a-fA-F_]+|(?:\d[\d_]*)?(?:\.\d[\d_]*|\d[\d_]*)?(?:[eE][-+]?\d+)?)$/.test(grezzo)
        || !/[0-9]/.test(grezzo)) {
        throw new ErroreJsonBson(`Numero scritto male: "${grezzo}".`, inizio);
      }
      toks.push({ t: 'valore', v: grezzo, i: inizio });
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      const inizio = i;
      // `new Date(…)`: il `new` fa parte del valore, non è un identificatore a sé.
      const conNew = /^new\s+[A-Za-z_$][\w$]*\s*\(/.exec(s.slice(i));
      if (conNew) {
        i += conNew[0].length - 1; // fermi sulla parentesi aperta
        i = fineChiamata(s, i, inizio);
        toks.push({ t: 'valore', v: s.slice(inizio, i), i: inizio });
        continue;
      }
      while (i < n && /[\w$]/.test(s[i])) i++;
      // Costruttore BSON: ObjectId("…"), NumberDecimal("…"), UUID("…")…
      let j = i;
      while (j < n && /\s/.test(s[j])) j++;
      if (s[j] === '(') {
        i = fineChiamata(s, j, inizio);
        toks.push({ t: 'valore', v: s.slice(inizio, i), i: inizio });
        continue;
      }
      toks.push({ t: 'ident', v: s.slice(inizio, i), i: inizio });
      continue;
    }

    throw new ErroreJsonBson(`Carattere inatteso: "${c}".`, i);
  }

  return toks;
}

/** Indice subito dopo la parentesi che chiude la chiamata aperta in `apertura`. */
function fineChiamata(s, apertura, inizioToken) {
  const n = s.length;
  let i = apertura;
  let livello = 0;
  while (i < n) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      let chiusa = false;
      while (i < n) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) { i++; chiusa = true; break; }
        i++;
      }
      if (!chiusa) throw erroreStringaNonChiusa(i);
      continue;
    }
    if (c === '(') { livello++; i++; continue; }
    if (c === ')') {
      livello--;
      i++;
      if (livello === 0) return i;
      continue;
    }
    i++;
  }
  throw new ErroreJsonBson('Parentesi tonda aperta e mai chiusa.', inizioToken);
}

/* ==========================================================================
 * Parser
 * ========================================================================== */

/* Il frammento citato in un messaggio d'errore va tra virgolette, ma se è
   GIÀ una stringa quotata le proprie bastano: `prima di ""eta""` si legge
   peggio di `prima di "eta"`. */
function mostra(v) {
  const s = String(v);
  return /^["']/.test(s) ? s : `"${s}"`;
}

/**
 * Costruisce l'albero del documento. I nodi conservano il testo grezzo dei
 * valori e i commenti che li precedono.
 */
function analizza(toks, testo) {
  let p = 0;

  const fineTesto = () => String(testo).length;
  const corrente = () => toks[p] || null;

  function raccogliCommenti() {
    const out = [];
    while (toks[p] && toks[p].t === 'commento') { out.push(toks[p].v); p++; }
    return out;
  }

  function atteso(cosa) {
    const tok = corrente();
    if (!tok) return new ErroreJsonBson(`Documento incompleto: manca ${cosa}.`, fineTesto());
    return new ErroreJsonBson(`Trovato ${mostra(tok.v)} dove serviva ${cosa}.`, tok.i);
  }

  function valore(profondita) {
    if (profondita > MAX_PROFONDITA) {
      const tok = corrente();
      throw new ErroreJsonBson(`Documento annidato troppo in profondità (oltre ${MAX_PROFONDITA} livelli).`, tok ? tok.i : fineTesto());
    }
    const tok = corrente();
    if (!tok) throw atteso('un valore');

    if (tok.t === 'punt' && tok.v === '{') return oggetto(profondita);
    if (tok.t === 'punt' && tok.v === '[') return array(profondita);
    if (tok.t === 'stringa' || tok.t === 'valore') {
      p++;
      return { tipo: 'scalare', grezzo: tok.v, commenti: [] };
    }
    if (tok.t === 'ident') {
      // Una parola nuda è un valore solo se è una delle costanti previste.
      // Tutto il resto è quasi sempre una stringa a cui mancano le virgolette:
      // segnalarlo è metà del valore di questo linter.
      if (!LETTERALI.has(tok.v)) {
        throw new ErroreJsonBson(`Valore non riconosciuto: ${tok.v}. Se è testo, va tra virgolette.`, tok.i);
      }
      p++;
      return { tipo: 'scalare', grezzo: tok.v, commenti: [] };
    }
    throw atteso('un valore');
  }

  function oggetto(profondita) {
    const apre = corrente();
    p++; // {
    const voci = [];
    let commentiFinali = raccogliCommenti();

    if (corrente() && corrente().t === 'punt' && corrente().v === '}') {
      p++;
      return { tipo: 'oggetto', voci, commentiFinali, commenti: [] };
    }

    for (;;) {
      const chiaveTok = corrente();
      if (!chiaveTok) throw new ErroreJsonBson('Graffa { aperta e mai chiusa.', apre.i);
      if (chiaveTok.t === 'punt' && chiaveTok.v === '}') { p++; break; } // virgola finale tollerata
      if (chiaveTok.t !== 'stringa' && chiaveTok.t !== 'ident' && chiaveTok.t !== 'valore') {
        throw atteso('il nome di un campo');
      }
      p++;

      // Anche i commenti fra il nome del campo e i due punti restano legati
      // alla voce: buttarli via sarebbe una perdita silenziosa di testo.
      const commentiChiave = [...commentiFinali, ...raccogliCommenti()];
      commentiFinali = [];

      const duePunti = corrente();
      if (!duePunti || duePunti.t !== 'punt' || duePunti.v !== ':') {
        throw new ErroreJsonBson(`Manca i due punti dopo il campo ${mostra(chiaveTok.v)}.`, duePunti ? duePunti.i : fineTesto());
      }
      p++;
      raccogliCommenti();

      const val = valore(profondita + 1);
      voci.push({ chiave: chiaveTok.v, valore: val, commenti: commentiChiave });

      const dopoCommenti = raccogliCommenti();
      const sep = corrente();
      if (sep && sep.t === 'punt' && sep.v === ',') {
        p++;
        commentiFinali = [...dopoCommenti, ...raccogliCommenti()];
        continue;
      }
      if (sep && sep.t === 'punt' && sep.v === '}') {
        p++;
        commentiFinali = dopoCommenti;
        break;
      }
      if (!sep) throw new ErroreJsonBson('Graffa { aperta e mai chiusa.', apre.i);
      throw new ErroreJsonBson(`Manca una virgola prima di ${mostra(sep.v)}.`, sep.i);
    }

    return { tipo: 'oggetto', voci, commentiFinali, commenti: [] };
  }

  function array(profondita) {
    const apre = corrente();
    p++; // [
    const elementi = [];
    let commentiPrima = raccogliCommenti();

    if (corrente() && corrente().t === 'punt' && corrente().v === ']') {
      p++;
      return { tipo: 'array', elementi, commentiFinali: commentiPrima, commenti: [] };
    }

    for (;;) {
      const tok = corrente();
      if (!tok) throw new ErroreJsonBson('Quadra [ aperta e mai chiusa.', apre.i);
      if (tok.t === 'punt' && tok.v === ']') { p++; return { tipo: 'array', elementi, commentiFinali: commentiPrima, commenti: [] }; }

      const val = valore(profondita + 1);
      val.commenti = commentiPrima;
      commentiPrima = [];
      elementi.push(val);

      const dopoCommenti = raccogliCommenti();
      const sep = corrente();
      if (sep && sep.t === 'punt' && sep.v === ',') {
        p++;
        commentiPrima = [...dopoCommenti, ...raccogliCommenti()];
        continue;
      }
      if (sep && sep.t === 'punt' && sep.v === ']') {
        p++;
        return { tipo: 'array', elementi, commentiFinali: dopoCommenti, commenti: [] };
      }
      if (!sep) throw new ErroreJsonBson('Quadra [ aperta e mai chiusa.', apre.i);
      throw new ErroreJsonBson(`Manca una virgola prima di ${mostra(sep.v)}.`, sep.i);
    }
  }

  const commentiTesta = raccogliCommenti();
  if (!corrente()) throw new ErroreJsonBson('Non c\'è niente da leggere: il documento è vuoto.', 0);
  const radice = valore(0);
  radice.commenti = commentiTesta;
  const coda = raccogliCommenti();

  const avanzo = corrente();
  if (avanzo) {
    throw new ErroreJsonBson(`C'è altro testo dopo la fine del documento: "${avanzo.v}".`, avanzo.i);
  }
  return { radice, coda };
}

/* ==========================================================================
 * API pubblica
 * ========================================================================== */

/**
 * Il testo somiglia a un documento JSON/BSON? Serve a decidere se ha senso
 * validarlo: su uno `SELECT` il linter JSON deve tacere.
 */
export function sembraJsonBson(testo) {
  return /^\s*[[{]/.test(String(testo == null ? '' : testo));
}

/**
 * Esito della validazione.
 * @returns {{ok: true} | {ok: false, messaggio: string, riga: number, colonna: number, indice: number}}
 */
export function analizzaJsonBson(testo) {
  const s = String(testo == null ? '' : testo);
  if (!s.trim()) {
    return { ok: false, messaggio: 'Il documento è vuoto.', riga: 1, colonna: 1, indice: 0 };
  }
  try {
    const toks = tokenizzaJsonBson(s);
    analizza(toks, s);
    return { ok: true };
  } catch (err) {
    if (err instanceof ErroreJsonBson) {
      const { riga, colonna } = posizioneDi(s, err.indice);
      return { ok: false, messaggio: err.message, riga, colonna, indice: err.indice };
    }
    throw err;
  }
}

function emetti(nodo, indent, livello, minifica) {
  const nl = minifica ? '' : '\n';
  const pad = minifica ? '' : indent.repeat(livello);
  const padInterno = minifica ? '' : indent.repeat(livello + 1);

  const commentiDi = (lista) => (minifica || !lista || !lista.length)
    ? ''
    : lista.map((c) => padInterno + normalizzaCommento(c) + nl).join('');

  if (nodo.tipo === 'oggetto') {
    if (!nodo.voci.length) return minifica || !nodo.commentiFinali.length ? '{}' : `{${nl}${commentiDi(nodo.commentiFinali)}${pad}}`;
    const corpo = nodo.voci.map((voce) => {
      const testa = commentiDi(voce.commenti);
      return `${testa}${padInterno}${voce.chiave}:${minifica ? '' : ' '}${emetti(voce.valore, indent, livello + 1, minifica)}`;
    }).join(`,${nl}`);
    return `{${nl}${corpo}${nl}${commentiDi(nodo.commentiFinali)}${pad}}`;
  }

  if (nodo.tipo === 'array') {
    if (!nodo.elementi.length) return minifica || !nodo.commentiFinali.length ? '[]' : `[${nl}${commentiDi(nodo.commentiFinali)}${pad}]`;
    const corpo = nodo.elementi.map((el) => `${commentiDi(el.commenti)}${padInterno}${emetti(el, indent, livello + 1, minifica)}`).join(`,${nl}`);
    return `[${nl}${corpo}${nl}${commentiDi(nodo.commentiFinali)}${pad}]`;
  }

  return nodo.grezzo;
}

/* Un commento di blocco su più righe non si può reindentare senza toccarne il
   contenuto: lo si lascia esattamente com'era. */
function normalizzaCommento(c) {
  return c.includes('\n') ? c : c.trim();
}

/**
 * Reindenta un documento JSON/BSON. Lancia `ErroreJsonBson` se il testo non è
 * valido: chi chiama decide se mostrarlo o lasciare il testo com'è.
 */
export function formattaJsonBson(testo, { indent = INDENT_DEFAULT } = {}) {
  const s = String(testo == null ? '' : testo);
  const { radice, coda } = analizza(tokenizzaJsonBson(s), s);
  const testa = radice.commenti.length ? `${radice.commenti.map(normalizzaCommento).join('\n')}\n` : '';
  const fondo = coda.length ? `\n${coda.map(normalizzaCommento).join('\n')}` : '';
  return testa + emetti(radice, indent, 0, false) + fondo;
}

/** Lo stesso documento su una riga sola, senza spazi superflui né commenti. */
export function minificaJsonBson(testo) {
  const s = String(testo == null ? '' : testo);
  const { radice } = analizza(tokenizzaJsonBson(s), s);
  return emetti(radice, '', 0, true);
}
