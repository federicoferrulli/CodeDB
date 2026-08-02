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
