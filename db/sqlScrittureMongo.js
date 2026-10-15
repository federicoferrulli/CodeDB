'use strict';

// SQL, shell, griglia e import condividono la stessa transazione referenziale.
async function esegui(client, db, coll, payload, env, work) {
  const ctx = require('./MongoSqlRuntime').contesto(env, payload);
  // MongoDB vieta listCollections nelle transazioni. Il catalogo viene letto
  // prima; controlli, lock referenziali e mutazioni usano lo snapshot attivo.
  const refs = await require('./mongoSessioneScript').senza(() => require('./sqlVincoliReferenziali').prepara(client.db(db), coll, payload, env, ctx));
  const collection = client.db(db).collection(coll);
  const sessioneScript = require('./mongoSessioneScript').attiva();
  if (!refs) return work(ctx.opzioni(sessioneScript), collection, null);
  const hello = await client.db(db).command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    if (refs.hasForeign) throw new Error('Le scritture con vincoli referenziali richiedono un replica set MongoDB.');
    return work({ bypassDocumentValidation: false }, collection, null);
  }
  const session = sessioneScript || client.startSession();
  try {
    const eseguiMutazione = async () => {
      const options = { ...ctx.opzioni(session), bypassDocumentValidation: false }, before = await refs.prima(options);
      const api = require('./sqlTriggerMongo');
      const triggers = await api.prepara(client, db, coll, payload, env, ctx, session);
      const result = await work(options, api.mutazioni(collection, triggers), triggers);
      await refs.dopo(before, options, async name => api.mutazioni(client.db(db).collection(name),
        await api.prepara(client, db, name, payload, env, ctx, session))); ctx.verifica();
      return result;
    };
    if (session.inTransaction()) return await eseguiMutazione();
    return await session.withTransaction(eseguiMutazione, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 30000 });
  } catch (err) {
    // Un conteggio intermedio non descrive una transazione annullata.
    if (err.auditResult && !err.hasErrorLabel?.('UnknownTransactionCommitResult')) err.auditResult = { insertedCount: 0, insertedIds: [] };
    throw err;
  } finally { if (!sessioneScript) await session.endSession(); }
}

module.exports = { esegui };
