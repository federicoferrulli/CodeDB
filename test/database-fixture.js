'use strict';

const { createE2eTargetRegistry } = require('./e2e-harness');

// Un nome casuale identifica il candidato; solo un ack di creazione ne conferma la proprietà.
function createDatabaseFixture(prefix, emit) {
  const registry = createE2eTargetRegistry({ destructive: true, prefix });
  const created = new Map();

  async function acquire(db, tabId, action) {
    registry.assertOwned(db);
    const list = await emit('db:list', { tabId });
    if (!list.ok) throw new Error(list.error);
    if (list.databases.some(item => item.name.toLowerCase() === db.toLowerCase())) {
      throw new Error(`Database di prova già esistente: "${db}".`);
    }
    const result = await action();
    if (!result.ok) throw new Error(`Creazione di "${db}" non confermata: ${result.error}`);
    created.set(db, tabId);
    return result;
  }

  async function drop(db) {
    if (!created.has(db)) throw new Error(`Database non creato dalla prova: "${db}".`);
    const tabId = created.get(db);
    // Un ack perso può seguire un DROP riuscito: non ritentare su quel nome.
    created.delete(db);
    return registry.drop(db, async name => {
      const result = await emit('db:drop', { db: name, tabId });
      if (!result.ok) throw new Error(`Eliminazione di "${db}" non confermata: ${result.error}`);
      return result;
    });
  }

  return {
    target: label => registry.target(label),
    create: (db, coll, tabId) => acquire(db, tabId, () => emit('db:create', { db, coll, tabId })),
    copy(db, newName) {
      if (!created.has(db)) throw new Error(`Origine non creata dalla prova: "${db}".`);
      const tabId = created.get(db);
      return acquire(newName, tabId, () => emit('db:rename', { db, newName, tabId }));
    },
    drop,
    async cleanup() {
      const errors = [];
      for (const db of [...created.keys()].reverse()) {
        try { await drop(db); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
    },
  };
}

module.exports = { createDatabaseFixture };
