'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { EJSON } = require('bson');
const contesto = new AsyncLocalStorage();
const attiva = () => contesto.getStore();

// Il token appartiene a una sola esecuzione. Nessun lsid fornito dal browser
// può selezionare la sessione di un altro script o di un altro utente.
function gestore(client) {
  const sessioni = new Map();
  const cursori = new Map();
  const trova = id => {
    const session = sessioni.get(id);
    if (!session) throw new Error('Sessione MongoDB sconosciuta o già chiusa.');
    return session;
  };
  return {
    start(options = {}) {
      const id = randomUUID(); sessioni.set(id, client.startSession(options)); return id;
    },
    run(id, fn) {
      const session = trova(id);
      if (session.hasEnded) throw new Error('La sessione MongoDB è già chiusa.');
      return contesto.run(session, fn);
    },
    async operation(id, method, args = []) {
      const session = trova(id);
      switch (method) {
        case 'hasEnded': return session.hasEnded;
        case 'getSessionId': return session.id;
        case 'getClusterTime': return session.clusterTime;
        case 'getOperationTime': return session.operationTime;
        case 'startTransaction': return session.startTransaction(args[0]);
        case 'commitTransaction': return session.commitTransaction();
        case 'abortTransaction': return session.abortTransaction();
        case 'endSession': return session.endSession();
        case 'advanceClusterTime': return session.advanceClusterTime(args[0]);
        case 'advanceOperationTime': return session.advanceOperationTime(args[0]);
        default: throw new Error(`Metodo di sessione MongoDB sconosciuto: ${method}.`);
      }
    },
    transaction(id, fn, options) { return trova(id).withTransaction(fn, options); },
    track(cursor) {
      if (!cursor?.ns || !cursor.id || String(cursor.id.$numberLong ?? cursor.id) === '0') return;
      cursori.set(`${cursor.ns}:${JSON.stringify(cursor.id)}`, { ns: cursor.ns, id: cursor.id, session: attiva() });
    },
    async close() {
      try {
        for (const cursor of cursori.values()) {
          const dot = cursor.ns.indexOf('.');
          if (dot < 0 || cursor.session?.hasEnded) continue;
          await client.db(cursor.ns.slice(0, dot)).command({ killCursors: cursor.ns.slice(dot + 1),
            cursors: [EJSON.deserialize(cursor.id, { relaxed: false })] }, { session: cursor.session }).catch(() => {});
        }
        await Promise.all([...sessioni.values()].map(s => s.endSession()));
      }
      finally { sessioni.clear(); }
    },
  };
}
module.exports = { attiva, gestore, senza: fn => contesto.run(undefined, fn) };
