'use strict';

const sessioni = require('./sessioni');
const { definisciMetodi } = require('./prototipoStrategia');

function installaSessioniStreamMongo(prototipo, { serialize }) {
  definisciMetodi(prototipo, {
    async cancelQuery(opHandle) {
      if (!opHandle || !opHandle.runId || !this.client) return { cancelled: false };
      try {
        const admin = this.client.db('admin');
        const ops = await admin.aggregate([
          { $currentOp: { allUsers: true, idleConnections: false } },
          {
            $match: {
              $or: [
                { 'command.comment': opHandle.runId },
                { comment: opHandle.runId },
                { 'command.comment.codedbRunId': opHandle.runId },
                { 'comment.codedbRunId': opHandle.runId },
              ],
            },
          },
        ]).toArray();

        if (!ops || ops.length === 0) return { cancelled: false };

        let cancelled = false;
        for (const op of ops) {
          if (op.opid !== undefined) {
            await admin.command({ killOp: 1, op: op.opid }).catch(() => {});
            cancelled = true;
          }
        }
        return { cancelled };
      } catch {
        return { cancelled: false };
      }
    },

    async listSessions() {
      const client = this.requireClient();
      const admin = client.db('admin');

      let ops;
      let nota = null;
      try {
        ops = await admin.aggregate([
          { $currentOp: { allUsers: true, idleConnections: false, idleSessions: false } },
        ]).toArray();
      } catch {
        ops = await admin.aggregate([
          { $currentOp: { allUsers: false, idleConnections: false, idleSessions: false } },
        ]).toArray();
        nota = 'Vengono mostrate solo le operazioni dell\'utente collegato: al ruolo manca il privilegio "inprog" sul cluster, necessario per vedere quelle degli altri utenti.';
      }

      const tutte = sessioni.ordina(sessioni.normalizzaMongo(ops));
      const troncato = tutte.length > sessioni.MAX_SESSIONI;
      const lista = tutte.slice(0, sessioni.MAX_SESSIONI);
      return {
        sessioni: lista,
        capacita: { annullaQuery: true, terminaConnessione: false, saBloccanti: false },
        troncato,
        nota,
      };
    },

    async killSession(id, modo, identitaOsservata) {
      const client = this.requireClient();
      if (modo === 'connessione') {
        throw new Error('MongoDB non permette di chiudere la connessione di un altro client: si può solo annullare l\'operazione in corso.');
      }
      const raw = String(id);
      const op = /^\d+$/.test(raw) ? Number(raw) : raw;
      const correnti = await client.db('admin').aggregate([
        { $currentOp: { allUsers: true, idleConnections: false, idleSessions: false } },
        { $match: { opid: op } },
      ]).toArray();
      const corrente = sessioni.normalizzaMongo(correnti)[0];
      sessioni.assertIdentitaSessione(identitaOsservata, corrente && corrente.identita);
      const res = await client.db('admin').command({ killOp: 1, op });
      return { terminata: !!(res && res.ok), modo: 'query' };
    },

    watch(db, coll, { onChange, onUnavailable, watchId = 'default' }) {
      const client = this.requireClient();
      this.unwatch(watchId);
      const stream = client.db(db).collection(coll).watch([], { fullDocument: 'updateLookup' });
      this.changeStreams.set(watchId, stream);
      stream.on('change', (change) => {
        if (this.changeStreams.get(watchId) !== stream) return;
        onChange({
          operationType: change.operationType,
          documentKey: change.documentKey ? serialize(change.documentKey) : null,
        });
      });
      stream.on('error', () => {
        if (this.changeStreams.get(watchId) !== stream) return;
        this.unwatch(watchId);
        onUnavailable();
      });
    },

    unwatch(watchId) {
      const ids = watchId === undefined ? [...this.changeStreams.keys()] : [watchId];
      for (const id of ids) {
        this.changeStreams.get(id)?.close().catch(() => {});
        this.changeStreams.delete(id);
      }
    },

    watchSchema({ onChange, onUnavailable }) {
      const client = this.requireClient();
      this.unwatchSchema();
      const pipeline = [{ $match: { operationType: { $in: ['create', 'drop', 'rename', 'dropDatabase'] } } }];
      const open = (expanded) => {
        const stream = client.watch(pipeline, expanded ? { showExpandedEvents: true } : {});
        stream.on('change', (change) => {
          onChange({
            operationType: change.operationType,
            db: change.ns ? change.ns.db : null,
            coll: (change.ns && change.ns.coll) || null,
          });
        });
        stream.on('error', () => {
          stream.close().catch(() => {});
          if (this.schemaStream !== stream) return;
          this.schemaStream = null;
          if (expanded) this.schemaStream = open(false);
          else onUnavailable();
        });
        return stream;
      };
      this.schemaStream = open(true);
    },

    unwatchSchema() {
      if (this.schemaStream) {
        this.schemaStream.close().catch(() => {});
        this.schemaStream = null;
      }
    },
  });
}

module.exports = { installaSessioniStreamMongo };
