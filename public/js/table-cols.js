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

import { ejsonKind, isPlainObject, jsonBreve } from './valori.js';

/** Caratteri della chiave di confronto per i valori senza ordine naturale. */
const MAX_CHIAVE_TESTO = 200;

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
  // La chiave si ferma ai primi caratteri: un ordine "naturale" fra oggetti non
  // esiste comunque, e serializzarli per intero significherebbe, su una colonna
  // con dentro documenti da qualche MB, una stringa di quella dimensione per
  // OGNI riga solo per decidere chi viene prima.
  return { r: R_ALTRO, n: null, s: jsonBreve(v, MAX_CHIAVE_TESTO) };
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
  return ordinaRigheMultiple(righe, [{ col: colonna, dir: direzione }]);
}

/**
 * Ordina una copia delle righe secondo PIÙ colonne, in ordine di priorità:
 * `criteri` è un elenco di `{col, dir}` e a parità della prima colonna decide
 * la seconda, poi la terza. Stessa semantica di `ordinaRighe`: i vuoti restano
 * in fondo qualunque sia la direzione, l'ordinamento è stabile e l'array di
 * partenza non viene toccato. Con un elenco vuoto o senza criteri validi
 * restituisce le righe così come sono.
 */
export function ordinaRigheMultiple(righe, criteri) {
  const attivi = (Array.isArray(criteri) ? criteri : [])
    .map((c) => ({ col: c && c.col, dir: c && c.dir < 0 ? -1 : 1 }))
    .filter((c) => typeof c.col === 'string' && c.col);
  if (!attivi.length || !Array.isArray(righe)) return righe;

  // Decora-ordina-scarta, come sopra ma con una chiave PER criterio: calcolarle
  // una volta sola costa N×k chiavi; ricalcolarle a ogni confronto sarebbe
  // N·logN×k confronti pesanti.
  const decorata = righe.map((riga) => ({
    riga,
    k: attivi.map((c) => {
      const v = riga && typeof riga === 'object' ? riga[c.col] : undefined;
      return isVuoto(v) ? null : chiaveOrdinamento(v);
    }),
  }));

  decorata.sort((a, b) => {
    for (let i = 0; i < attivi.length; i++) {
      const ka = a.k[i];
      const kb = b.k[i];
      if (ka === null && kb === null) continue;      // vuoti su questa colonna: decide la successiva
      if (ka === null) return 1;                     // i vuoti restano in fondo, anche al contrario
      if (kb === null) return -1;
      const c = confrontaChiavi(ka, kb);
      if (c !== 0) return attivi[i].dir * c;
    }
    return 0;
  });

  return decorata.map((x) => x.riga);
}

/**
 * Le colonne di un result set: quelle DICHIARATE dal motore, poi quelle che
 * compaiono soltanto nelle righe.
 *
 * Perché non basta l'unione delle chiavi delle righe. Un result set con ZERO
 * righe ha comunque delle colonne — `SELECT id, addsa FROM vuota` è una
 * risposta con due colonne e nessuna riga — ma dedurle dalle righe significa
 * dedurle da un insieme vuoto: la tabella restava senza intestazioni e il
 * pannello diceva «Nessun risultato da mostrare», cioè la stessa cosa che dice
 * quando non è stata eseguita alcuna query. Le tre strategie dichiarano già
 * `columns` (da `fields` su SQL, dal catalogo dei campi su MongoDB) e
 * `ScriptResults` le conserva su file: era il frontend a buttarle via e a
 * ricalcolarle dalle righe.
 *
 * Le dichiarate vengono PRIMA e nel loro ordine, che è quello della `SELECT`:
 * l'unione delle chiavi darebbe l'ordine di comparsa nella prima riga. Ciò che
 * appare solo nelle righe si accoda invece di sparire — su MongoDB un documento
 * può avere campi che il catalogo campionato non ha visto, e una colonna
 * presente nei dati ma assente dall'intestazione sarebbe un valore invisibile.
 *
 * @param {string[]|null|undefined} dichiarate
 * @param {Array} righe
 * @returns {string[]}
 */
export function colonneRisultato(dichiarate, righe) {
  const viste = new Set();
  const out = [];
  const aggiungi = (nome) => {
    if (typeof nome !== 'string' || nome === '' || viste.has(nome)) return;
    viste.add(nome);
    out.push(nome);
  };

  if (Array.isArray(dichiarate)) dichiarate.forEach(aggiungi);
  if (Array.isArray(righe)) {
    righe.forEach((r) => {
      if (r && typeof r === 'object' && !Array.isArray(r)) Object.keys(r).forEach(aggiungi);
    });
  }
  return out;
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
