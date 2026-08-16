/**
 * CodeDB — Protocollo dei calcoli pesanti (thread principale ⇄ Web Worker)
 *
 * Le statistiche della selezione (`cell-stats.js`) e il precalcolo dei grafici
 * (`chart-option.js`) sono le due cose che scorrono TUTTE le righe. Su una
 * selezione di poche migliaia di celle non si notano; su una da centomila
 * bloccano il thread che disegna, e la finestra smette di rispondere proprio
 * mentre l'utente sta trascinando la selezione — cioè nel momento in cui
 * l'interfaccia deve essere più viva.
 *
 * Qui c'è la parte **pura** della soluzione: quali compiti esistono, come si
 * eseguono e quando conviene spostarli. È importata sia dal Worker
 * (`calcoli-worker.js`) sia dal thread principale (`calcoli.js`), che così
 * eseguono ESATTAMENTE lo stesso codice — la versione con e senza Worker non
 * possono divergere, e i test in Node provano entrambe.
 *
 * Un compito è spostabile solo se attraversa il confine fra i due thread:
 * entrano ed escono dati puri. L'option di ECharts, per esempio, non lo è —
 * contiene funzioni (`formatter`) — ed è il motivo per cui si sposta il
 * *precalcolo* e non il disegno.
 */

import { statistiche, statistichePerColonna } from './cell-stats.js';
import { campiDisponibili, precalcola } from './chart-option.js';

/**
 * Soglia oltre la quale conviene pagare il passaggio di consegne al Worker.
 *
 * Sotto, il costo della copia dei dati e del giro di messaggi supera il calcolo
 * stesso: il risultato arriverebbe DOPO, e per giunta un fotogramma più tardi.
 * Il numero è in "celle", cioè valori esaminati — righe × colonne coinvolte —
 * perché è quello il lavoro vero, non il numero di righe.
 */
export const SOGLIA_CELLE = 50000;

/** Conviene spostare su un altro thread un lavoro di `celle` valori? */
export function conviene(celle) {
  return Number(celle) >= SOGLIA_CELLE;
}

/** Celle esaminate da un precalcolo di grafico: una per riga per campo letto. */
export function celleGrafico(righe, cfg) {
  const n = Array.isArray(righe) ? righe.length : 0;
  if (!cfg || !Array.isArray(cfg.serie)) return n;
  const serie = cfg.serie.filter((s) => s && s.visibile !== false).length;
  // L'asse X si legge sempre; ogni serie legge la sua misura.
  return n * (1 + Math.max(serie, 1));
}

/**
 * Esegue un compito. È la stessa funzione da entrambe le parti del confine:
 * nel Worker la chiama `onmessage`, sul thread principale la chiama la via
 * sincrona (sotto soglia, o quando i Worker non sono disponibili).
 *
 * @param {{tipo: string}} compito
 * @returns {*} risultato serializzabile
 */
export function eseguiCompito(compito) {
  const c = compito || {};
  switch (c.tipo) {
    case 'statistiche':
      return statistiche(c.valori || []);
    case 'statistichePerColonna':
      return statistichePerColonna(c.colonne || []);
    case 'campiDisponibili':
      return campiDisponibili(c.righe || []);
    case 'precalcolaGrafico':
      return precalcola(c.righe || [], c.cfg);
    default:
      throw new Error(`Compito sconosciuto: ${String(c.tipo)}`);
  }
}
