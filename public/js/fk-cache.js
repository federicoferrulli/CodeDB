'use strict';

/* ---------------------------------------------------------------------------
 * Cache condivisa delle relazioni di una griglia.
 *
 * Vista Dati e Split-View sono chiamanti diversi dello stesso metadato. La
 * chiave comprende la sessione (`tabId`) oltre a motore, database e collection:
 * due riquadri con nomi uguali ma connessioni diverse non devono mai ereditare
 * le relazioni l'uno dall'altro.
 * ------------------------------------------------------------------------- */

import { emit } from './utils.js';
import { indicizzaRelazioni } from './fk-relazioni.js';

const cache = new Map();
const inCorso = new Map();
let generazione = 0;

function chiave({ tabId, dbType, db, coll } = {}) {
  if (!db || !coll) return null;
  return `${tabId || ''}\0${dbType || ''}\0${db}\0${coll}`;
}

/** Map campo → relazione già caricata, oppure null mentre manca il metadato. */
export function relazioniPer(contesto) {
  const k = chiave(contesto);
  return k && cache.has(k) ? cache.get(k) : null;
}

/**
 * Carica una volta le relazioni del bersaglio e condivide anche la richiesta in
 * volo. Una tabella senza relazioni viene memorizzata come Map vuota: `null`
 * significa soltanto «non ancora chiesto».
 *
 * Con `lancia: true` il fallimento viene propagato invece di diventare una Map
 * vuota: serve al form di inserimento, che deve distinguere «nessuna relazione»
 * da «lettura fallita» per mostrare un errore e riprovare. Griglia e Split-View
 * chiamano senza opzioni e conservano il silenzio di prima.
 */
export function caricaRelazioni(contesto, { lancia = false } = {}) {
  const k = chiave(contesto);
  if (!k) return Promise.resolve(new Map());
  if (cache.has(k)) return Promise.resolve(cache.get(k));
  // Una richiesta in volo nata silenziosa risolve con una Map vuota anche in
  // caso di errore e nasconderebbe il fallimento a chi chiede `lancia`: quel
  // chiamante usa una richiesta propria, senza toccare quella condivisa.
  if (inCorso.has(k) && !lancia) return inCorso.get(k);

  const versione = generazione;
  const richiesta = emit('collection:relations', {
    tabId: contesto.tabId,
    db: contesto.db,
    coll: contesto.coll,
  }).then((res) => {
    const indice = indicizzaRelazioni(res.relazioni);
    // Solo il successo si memorizza: un fallimento resta «non ancora chiesto»
    // (null), così un nuovo tentativo rilegge davvero invece di riusare una Map
    // vuota che sembrava «nessuna relazione». Il costo è una sola rilettura di
    // metadati alla prossima query, non un ciclo.
    if (versione === generazione) cache.set(k, indice);
    return indice;
  })
    // Il metadato è accessorio: se fallisce la griglia continua senza badge,
    // come prima — ma senza memorizzare nulla (vedi sopra).
    .catch((err) => {
      if (lancia) throw err;
      return new Map();
    })
    .finally(() => {
      if (!lancia && inCorso.get(k) === richiesta) inCorso.delete(k);
    });

  if (!lancia) inCorso.set(k, richiesta);
  return richiesta;
}

/** Una DDL rende obsolete tutte le relazioni, comprese richieste già in volo. */
export function svuotaRelazioni() {
  generazione += 1;
  cache.clear();
  inCorso.clear();
}
