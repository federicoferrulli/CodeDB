'use strict';

/* ---------------------------------------------------------------------------
 * Colonne della tabella dei risultati: LARGHEZZE e ORDINAMENTO.
 *
 * Perché esiste. La tabella dei risultati di ⚡ Query & Aggregate nasceva con
 * `table-layout: fixed; width: 100%`: ogni colonna prendeva la stessa frazione
 * della larghezza disponibile e la tabella non poteva sforare il pannello,
 * quindi con quindici colonne si ottenevano quindici strisce da sessanta pixel
 * piene di "…" e nessun modo di scorrere in orizzontale per leggerle. Il
 * rimedio non è `table-layout: auto`: sotto virtualizzazione il browser calcola
 * le larghezze sulle sole righe presenti nel DOM, e quelle cambiano a ogni
 * scorrimento — le colonne ballerebbero sotto il cursore. Si misura quindi il
 * contenuto UNA VOLTA su un campione, si scrivono le larghezze in un
 * `<colgroup>` e si tiene `fixed`: stabile durante lo scorrimento, e la tabella
 * può essere più larga del pannello (da cui la barra orizzontale).
 *
 * Modulo FOGLIA e PURO (importa solo `valori.js`, che a sua volta non importa
 * nulla): niente DOM, niente `utils.js` — la misura del testo e la conversione
 * valore→testo arrivano iniettate. È la stessa ragione di `cell-stats.js`: un
 * ordinamento sbagliato non produce una tabella rotta, produce una tabella
 * plausibile e in ordine sbagliato, cioè un difetto che si porta via chi legge.
 * Provato da `test/unit-table-cols.js` (in `npm test`, nessun browser).
 * ------------------------------------------------------------------------- */

import { ejsonKind, isPlainObject } from './valori.js';

/* Ranghi di tipo: righe di tipi diversi nella stessa colonna (capita con
 * MongoDB, che non ha schema) devono comunque avere un ordine totale, altrimenti
 * il confronto è incoerente e il risultato dipende dall'algoritmo di sort. */
const R_NUM = 0;
const R_DATE = 1;
const R_BOOL = 2;
const R_STR = 3;
const R_ALTRO = 4;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Il valore è "vuoto"? I vuoti restano in fondo in ENTRAMBE le direzioni. */
export function isVuoto(v) {
  return v === null || v === undefined;
}

/**
 * Chiave di confronto di un valore EJSON: `{ r, n, s }` — rango di tipo, più un
 * numero oppure una stringa. Le stringhe interamente numeriche contano come
 * numeri: un DECIMAL di MySQL arriva come `"12.50"` e ordinarlo per testo
 * metterebbe `"100"` prima di `"9"`.
 */
export function chiaveOrdinamento(v) {
  if (isVuoto(v)) return { r: R_ALTRO, n: null, s: '' };

  const kind = ejsonKind(v);

  if (kind === 'number') {
    const n = isPlainObject(v)
      ? Number(v.$numberInt ?? v.$numberLong ?? v.$numberDouble)
      : Number(v);
    return { r: R_NUM, n: Number.isNaN(n) ? 0 : n, s: null };
  }
  if (kind === 'decimal') {
    const n = Number(v.$numberDecimal);
    return { r: R_NUM, n: Number.isNaN(n) ? 0 : n, s: null };
  }
  if (kind === 'date') {
    const raw = isPlainObject(v.$date) ? Number(v.$date.$numberLong) : v.$date;
    const ms = typeof raw === 'number' ? raw : Date.parse(raw);
    return { r: R_DATE, n: Number.isNaN(ms) ? 0 : ms, s: null };
  }
  // Un ObjectId è esadecimale e il suo prefisso è il timestamp di creazione:
  // ordinarlo per testo è anche ordinarlo per data, gratis.
  if (kind === 'oid') return { r: R_STR, n: null, s: String(v.$oid) };
  if (kind === 'boolean') return { r: R_BOOL, n: v ? 1 : 0, s: null };

  if (typeof v === 'string') {
    const t = v.trim();
    if (t !== '' && Number.isFinite(Number(t))) return { r: R_NUM, n: Number(t), s: null };
    return { r: R_STR, n: null, s: v };
  }

  // Oggetti, array, binari: nessun ordine naturale, ma un ordine STABILE sì.
  try { return { r: R_ALTRO, n: null, s: JSON.stringify(v) }; } catch { return { r: R_ALTRO, n: null, s: String(v) }; }
}

/** Confronto crescente fra due chiavi di `chiaveOrdinamento`. */
export function confrontaChiavi(a, b) {
  if (a.r !== b.r) return a.r - b.r;
  if (a.n !== null && b.n !== null) return a.n < b.n ? -1 : (a.n > b.n ? 1 : 0);
  return collator.compare(a.s ?? '', b.s ?? '');
}

/**
 * Ordina una copia delle righe per `colonna`. `direzione` è 1 (crescente) o -1.
 * L'array di partenza non viene toccato: i risultati originali restano quelli
 * restituiti dal database, e chi li usa per altro (grafici) non se ne accorge.
 */
export function ordinaRighe(righe, colonna, direzione) {
  const dir = direzione < 0 ? -1 : 1;
  const piene = [];
  const vuote = [];

  for (const riga of righe) {
    const v = riga && typeof riga === 'object' ? riga[colonna] : undefined;
    if (isVuoto(v)) vuote.push(riga);
    else piene.push({ riga, k: chiaveOrdinamento(v) });
  }

  // Decora-ordina-scarta: la chiave si calcola una volta per riga e non a ogni
  // confronto (su 10.000 righe sono ~130.000 confronti).
  piene.sort((a, b) => dir * confrontaChiavi(a.k, b.k));

  return piene.map((x) => x.riga).concat(vuote);
}

export const LARGH_MIN = 80;
export const LARGH_MAX = 420;
export const CAMPIONE_RIGHE = 200;

/**
 * Larghezza in pixel di ogni colonna, misurata su un CAMPIONE di righe.
 *
 * Il campione (200 righe) non è pigrizia: misurare 10.000 righe × 20 colonne
 * sarebbe 200.000 misurazioni di testo a ogni query, e la colonna larga il
 * doppio del previsto la si allarga trascinando. Il tetto `max` esiste perché
 * una singola cella con dentro un documento JSON intero renderebbe la tabella
 * larga diecimila pixel, cioè inservibile: quel valore si legge dal tooltip,
 * dalla vista JSON Tree o allargando la colonna a mano.
 *
 * @param {Array} righe
 * @param {string[]} colonne
 * @param {{misura:(t:string)=>number, testo:(v:any)=>string, min?:number, max?:number, padding?:number, campione?:number}} opts
 *        `misura` restituisce la larghezza in px di un testo (nel browser è
 *        `measureText` su canvas), `testo` converte il valore in ciò che si
 *        vede in cella. Entrambe iniettate: qui dentro non esiste un DOM.
 * @returns {Map<string, number>}
 */
export function larghezzeColonne(righe, colonne, opts) {
  const {
    misura, testo,
    min = LARGH_MIN, max = LARGH_MAX, padding = 24, campione = CAMPIONE_RIGHE,
  } = opts || {};

  const out = new Map();
  if (!Array.isArray(colonne) || typeof misura !== 'function') return out;

  const n = Math.min(Array.isArray(righe) ? righe.length : 0, campione);

  for (const col of colonne) {
    // L'intestazione fa parte della misura: una colonna `data_registrazione`
    // con dentro solo `1` non deve avere il titolo troncato.
    let larg = misura(String(col)) + 18; // 18px: spazio per la freccia di ordinamento
    for (let i = 0; i < n; i++) {
      const riga = righe[i];
      const v = riga && typeof riga === 'object' ? riga[col] : undefined;
      const t = typeof testo === 'function' ? testo(v) : String(v ?? '');
      const w = misura(t);
      if (w > larg) larg = w;
      if (larg >= max) break; // già oltre il tetto: le altre righe non cambiano nulla
    }
    out.set(col, Math.round(Math.min(max, Math.max(min, larg + padding))));
  }

  return out;
}
