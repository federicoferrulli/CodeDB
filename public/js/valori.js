'use strict';

/* ---------------------------------------------------------------------------
 * Helper PURI: riconoscimento delle forme Extended JSON, formattazione dei byte
 * e generazione di identificativi. Nessun DOM, nessun socket, nessun import.
 *
 * Perché stanno a parte invece che in utils.js, dove vivevano: `utils.js` fa
 * parte di un ciclo di import che tira dentro l'intera applicazione
 * (utils → tabs → pending-queries → query-tab → … → main.js, che al caricamento
 * registra gestori sul `document`). Chi ha bisogno solo di sapere se un valore è
 * un `$date` non può pagare quel prezzo — ed è esattamente il caso dello strato
 * puro dei grafici (`chart-option.js`), che così resta provabile in Node senza
 * un browser finto. È la stessa ragione per cui `geojson.js` sta separato da
 * `geomap.js`.
 *
 * `utils.js` li RI-ESPORTA: chi importava `ejsonKind` o `fmtBytes` da lì
 * continua a funzionare, e la definizione resta una sola.
 * ------------------------------------------------------------------------- */

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function ejsonKind(v) {
  if (isPlainObject(v)) {
    if ('$oid' in v) return 'oid';
    if ('$date' in v) return 'date';
    if ('$numberInt' in v || '$numberLong' in v || '$numberDouble' in v) return 'number';
    if ('$numberDecimal' in v) return 'decimal';
    if ('$binary' in v) return 'binary';
    return 'object';
  }
  return typeof v; // string, number, boolean, object (null/array)
}

/* ---------------------------------------------------------------------------
 * Serializzazione JSON con BUDGET di caratteri.
 *
 * Perché non basta `JSON.stringify(...).slice(0, n)`: la stringa intera viene
 * costruita comunque. Su un documento da 25 MB in una cella sono ~144 ms di
 * `simplify` + `stringify` per OGNI cella, e la griglia virtualizzata ridisegna
 * una ventina di righe a ogni fotogramma di scorrimento — cioè secondi di
 * blocco per mostrare i 60 caratteri che entrano nella colonna. Qui si smette
 * di scrivere appena il budget è esaurito: il costo dipende da `max`, non dalla
 * dimensione del valore.
 *
 * Serve SOLO per ciò che si mostra. Copia delle celle, modifica al volo ed
 * export devono continuare a passare da `displayValue`, che è esatto: un valore
 * troncato incollato in una query, o salvato da un editor, è perdita di dati.
 * ------------------------------------------------------------------------- */

/**
 * @param {*} v valore (Extended JSON)
 * @param {number} max caratteri massimi prodotti
 * @param {(foglia:any)=>string} [fmtFoglia] testo delle forme EJSON che vogliono
 *        una formattazione (date, binari): iniettato perché vive in `utils.js`,
 *        che questo modulo foglia non può importare.
 */
export function jsonBreve(v, max = 1000, fmtFoglia) {
  let out = '';
  let troncato = false;

  const scrivi = (s) => {
    if (troncato) return;
    if (out.length + s.length >= max) {
      out += s.slice(0, Math.max(0, max - out.length));
      troncato = true;
    } else {
      out += s;
    }
  };

  const vai = (x) => {
    if (troncato) return;

    if (Array.isArray(x)) {
      scrivi('[');
      for (let i = 0; i < x.length; i++) {
        if (troncato) break;
        if (i) scrivi(',');
        vai(x[i]);
      }
      scrivi(']');
      return;
    }

    if (isPlainObject(x)) {
      const kind = ejsonKind(x);
      // Numeri: senza virgolette, come li produrrebbe simplify + stringify.
      if (kind === 'number') { scrivi(String(x.$numberInt ?? x.$numberLong ?? x.$numberDouble)); return; }
      if (kind === 'decimal') { scrivi(String(x.$numberDecimal)); return; }
      if (kind === 'oid') { scrivi(JSON.stringify(String(x.$oid))); return; }
      if (kind !== 'object') {
        // date, binari: la forma leggibile la conosce solo il chiamante
        scrivi(JSON.stringify(typeof fmtFoglia === 'function' ? fmtFoglia(x) : x));
        return;
      }
      scrivi('{');
      let primo = true;
      for (const k of Object.keys(x)) {
        if (troncato) break;
        if (!primo) scrivi(',');
        primo = false;
        scrivi(JSON.stringify(k) + ':');
        vai(x[k]);
      }
      scrivi('}');
      return;
    }

    scrivi(JSON.stringify(x === undefined ? null : x));
  };

  vai(v);
  return troncato ? out + '…' : out;
}

/** Identificativo locale: `crypto.randomUUID` dove c'è, altrimenti un ripiego. */
export function safeUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID(); } catch { /* fallthrough */ }
  }
  return 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}
