'use strict';
const { EJSON } = require('bson');

async function indiciConflitto(collection, conflict, options, schema) {
  const indexes = (await collection.listIndexes(options).toArray()).filter(i => i.unique || i.name === '_id_');
  const scelti = conflict.columns ? indexes.filter(i => Object.keys(i.key).length === conflict.columns.length && conflict.columns.every(c => Object.hasOwn(i.key, c))) : indexes;
  if (!scelti.length) throw new Error('ON CONFLICT richiede un indice univoco sulle colonne indicate.');
  const sqlIndexes = schema ? require('./sqlSchemaMongo').indici(schema) : [];
  for (const index of scelti) index.sqlNullable = !!sqlIndexes.find(i => i.name === index.name && i.partialFilterExpression
    && EJSON.stringify(i.partialFilterExpression) === EJSON.stringify(index.partialFilterExpression));
  if (scelti.some(i => (i.partialFilterExpression && !i.sqlNullable) || i.sparse || Object.values(i.key).some(v => v !== 1 && v !== -1))) {
    throw new Error('Il vincolo SQL richiede un indice univoco completo, senza filtro parziale o chiavi speciali.');
  }
  return scelti;
}

async function inserisciConConflitti(collection, plan, indexes, options, verifica, applyUpdate, applyInsert, beforeInsert) {
  const ids = [], touched = new Set();
  for (const doc of plan.docs) {
    verifica();
    if (beforeInsert) await beforeInsert(doc);
    let found;
    for (const index of indexes) {
      // _id omesso sarà generato dal driver, quindi non può entrare in conflitto.
      if (index.name === '_id_' && !Object.hasOwn(doc, '_id')) continue;
      if (index.sqlNullable && Object.keys(index.key).some(k => doc[k] == null)) continue;
      const filter = Object.fromEntries(Object.keys(index.key).map(k => {
        const value = k.split('.').reduce((v, key) => v?.[key], doc) ?? null;
        if (Array.isArray(value)) throw new Error('Un vincolo SQL non può usare un indice MongoDB multikey.');
        return [k, { $eq: value }];
      }));
      found = await collection.findOne(filter, { ...options, projection: { _id: 1 }, ...(index.collation ? { collation: index.collation } : {}) });
      if (found) break;
    }
    let id;
    if (!found) {
      id = (await (applyInsert || collection.insertOne.bind(collection))({ ...doc }, options)).insertedId;
    } else {
      if (plan.conflict.nothing) continue;
      id = found._id;
      if (plan.conflict.dialect === 'postgresql' && touched.has(EJSON.stringify(id))) throw new Error('ON CONFLICT DO UPDATE non può modificare la stessa riga due volte nella stessa istruzione.');
      const updated = await (applyUpdate || collection.updateOne.bind(collection))({ $and: [{ _id: id }, plan.conflict.where] }, plan.conflict.update,
        { ...options, let: { excluded: { $literal: doc } } });
      if (!updated.matchedCount) continue;
    }
    touched.add(EJSON.stringify(id)); ids.push(id);
  }
  return ids;
}

module.exports = { indiciConflitto, inserisciConConflitti };
