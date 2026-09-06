'use strict';

// CodeDB — lock. Stato e dipendenze appartengono alla singola istanza.

function createModule() {
  /* ---------------------------------------------------------------------------
   * Serializzazione delle aperture di connessione per tab.
   *
   * `mongo:connect` è asincrono e lungo (TCP + eventuale tunnel SSH): fra il
   * controllo su `sessions` e la `sessions.set` finale c'è un await, quindi due
   * richieste concorrenti sullo stesso tabId aprivano due strategie e la seconda
   * sovrascriveva la prima, che restava aperta per sempre (client DB e tunnel SSH
   * orfani) mentre il budget globale veniva incrementato due volte e decrementato
   * una sola — deriva monotòna del contatore fino al blocco dell'intera istanza,
   * risolvibile solo col riavvio. Non è un caso di laboratorio: doppio click su
   * "Connetti", riconnessione automatica del socket e ripristino di sessione
   * possono facilmente sovrapporsi.
   *
   * `makeConnectLocks()` restituisce `withConnectLock(key, fn)`: le funzioni con
   * la stessa chiave vengono eseguite una alla volta, in ordine di arrivo. Si
   * accoda al massimo una richiesta oltre a quella in corso; oltre, si risponde
   * con un errore parlante invece di far crescere la coda (un client impazzito
   * non deve poter accumulare lavoro sul server).
   * ------------------------------------------------------------------------- */
  const MAX_INFLIGHT_CONNECTS = 2;

  // 1 in esecuzione + 1 in attesa

  function makeConnectLocks(maxInflight = MAX_INFLIGHT_CONNECTS) {
    /** @type {Map<string, { tail: Promise<void>, inflight: number }>} */
    const locks = new Map();

    return function withConnectLock(key, fn) {
      let lock = locks.get(key);
      if (!lock) {
        lock = { tail: Promise.resolve(), inflight: 0 };
        locks.set(key, lock);
      }
      if (lock.inflight >= maxInflight) {
        return Promise.reject(new Error('Una connessione è già in corso su questo tab: attendi che termini.'));
      }
      lock.inflight++;
      // La coda avanza qualunque sia l'esito del predecessore: un fallimento non
      // deve bloccare per sempre il tab.
      const result = lock.tail.then(fn, fn);
      lock.tail = result.then(() => {}, () => {}).then(() => {
        lock.inflight--;
        // Rimuovi il lock quando è scarico, così la mappa non cresce con i tab
        // effimeri (un socket può vedere passare molti tabId nel tempo).
        if (lock.inflight === 0 && locks.get(key) === lock) locks.delete(key);
      });
      return result;
    };
  }

  // Normalizza il tabId ricevuto dal client (input non fidato): è solo la chiave
  // della mappa di sessioni del proprio socket, mai usato per accedere ad altro.
  function normTabId(tabId) {
    const id = String(tabId == null ? '' : tabId).trim();
    return id || 'default';
  }

  return {
    makeConnectLocks,
    normTabId
  };
}

module.exports = { createModule };
