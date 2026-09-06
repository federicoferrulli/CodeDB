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
 */
export function caricaRelazioni(contesto) {
  const k = chiave(contesto);
  if (!k) return Promise.resolve(new Map());
  if (cache.has(k)) return Promise.resolve(cache.get(k));
  if (inCorso.has(k)) return inCorso.get(k);

  const versione = generazione;
  const richiesta = emit('collection:relations', {
    tabId: contesto.tabId,
    db: contesto.db,
    coll: contesto.coll,
  }).then((res) => indicizzaRelazioni(res.relazioni))
    // Il metadato è accessorio: se fallisce la griglia continua senza badge,
    // come prima. La Map vuota evita una nuova richiesta a ogni ridisegno.
    .catch(() => new Map())
    .then((indice) => {
      if (versione === generazione) cache.set(k, indice);
      return indice;
    })
    .finally(() => {
      if (inCorso.get(k) === richiesta) inCorso.delete(k);
    });

  inCorso.set(k, richiesta);
  return richiesta;
}

/** Una DDL rende obsolete tutte le relazioni, comprese richieste già in volo. */
export function svuotaRelazioni() {
  generazione += 1;
  cache.clear();
  inCorso.clear();
}
