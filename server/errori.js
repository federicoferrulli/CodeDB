'use strict';

// CodeDB — errori. Stato e dipendenze appartengono alla singola istanza.
const { spiegaErrore } = require('../db/errors');

function createModule() {
  /* ---------------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------------- */

  // Messaggio d'errore destinato all'utente. Passa da `spiegaErrore` (db/errors.js),
  // che riconosce gli errori tipici dei driver e li riscrive come "cosa è successo
  // + cosa fare", conservando in coda il testo originale. È il punto di uscita
  // unico degli ack socket (safeOn/delegate) e delle risposte HTTP di /auth:
  // spiegare qui vale per tutta l'applicazione. Un errore non riconosciuto — o già
  // spiegato — torna indietro immutato.
  function errMsg(err, ctx) {
    return spiegaErrore(err, ctx || (err && err._ctx) || {});
  }

  // Corsa contro un timeout: se `promise` non si risolve entro `ms`, rigetta con
  // un errore leggibile. Usato dal pannello di salute per non restare appeso su
  // una connessione morta (es. tunnel SSH caduto) oltre qualche secondo.
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label || 'Operazione'} scaduta dopo ${ms} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  return {
    errMsg,
    withTimeout
  };
}

module.exports = { createModule };
