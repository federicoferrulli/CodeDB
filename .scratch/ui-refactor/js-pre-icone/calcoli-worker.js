/**
 * CodeDB — Web Worker dei calcoli pesanti
 *
 * Vive su un thread suo: qui non esistono `window`, `document` né le funzioni
 * dell'interfaccia, e va bene così — questo file non deve fare altro che
 * ricevere dati, chiamare `eseguiCompito` e restituire il risultato.
 *
 * Tutta la logica sta in `calcoli-protocollo.js`, condiviso col thread
 * principale: se il Worker non è disponibile lo stesso calcolo gira lì, con lo
 * stesso codice e quindi con lo stesso risultato.
 *
 * È un **module worker** (`new Worker(url, { type: 'module' })`), perché deve
 * importare i moduli ES dell'applicazione senza duplicarli.
 */

import { eseguiCompito } from './calcoli-protocollo.js';

self.onmessage = (e) => {
  const { id, ...compito } = e.data || {};
  try {
    self.postMessage({ id, ok: true, risultato: eseguiCompito(compito) });
  } catch (err) {
    // L'errore non può attraversare il confine come oggetto Error: si manda il
    // messaggio, che è l'unica parte che serve a chi lo mostrerà.
    self.postMessage({ id, ok: false, errore: (err && err.message) || String(err) });
  }
};
