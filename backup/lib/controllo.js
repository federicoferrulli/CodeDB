'use strict';

// Un solo controllo per letture, attese del driver e avanzamento del backup.
function creaControllo({ signal, onProgress } = {}) {
  const verifica = () => signal?.throwIfAborted();
  let ultimoInvio = 0;
  function avanza(collection, count = 0, phase = 'dati', forza = false) {
    verifica();
    if (!forza && count % 1000) return;
    const now = Date.now();
    if (forza || count <= 1000 || now - ultimoInvio >= 250) {
      onProgress?.({ collection, count, phase });
      ultimoInvio = now;
    }
    // Anche cursori già bufferizzati devono lasciare spazio a socket e annullamento.
    return new Promise(resolve => setImmediate(resolve)).then(verifica);
  }
  function attendi(promise) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
  function osservaStream(stream) {
    const abort = () => stream.destroy(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    return () => signal?.removeEventListener('abort', abort);
  }
  function collegaSql(originale, mysql) {
    const abort = () => {
      // La connessione appartiene solo a questo dump: le altre query restano vive.
      if (mysql) originale.destroy();
      else Promise.resolve(originale.end()).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const conn = new Proxy(originale, { get(target, prop) {
      if (prop === 'query') return (...args) => { verifica(); return attendi(target.query(...args)); };
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { conn, libera() {
      signal?.removeEventListener('abort', abort);
      if (!mysql) originale.release(!!signal?.aborted);
      else if (!signal?.aborted) originale.release();
    } };
  }
  function acquisisciSql(promise, mysql) {
    // Un pool saturo può consegnare la connessione dopo l'annullamento.
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      promise.then(conn => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) { conn.release(); reject(signal.reason); return; }
        resolve(collegaSql(conn, mysql));
      }, err => { signal?.removeEventListener('abort', abort); reject(err); });
      if (signal?.aborted) abort();
    });
  }
  return { signal, verifica, avanza, attendi, osservaStream, acquisisciSql };
}

module.exports = { creaControllo };
