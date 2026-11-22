'use strict';

const BSON = require('bson');
const { createHash } = require('node:crypto');
const { quotaSempre } = require('./identificatori');
const { deserializeClientObject, toSqlValue } = require('./sqlValori');
const raw = require('./mongoBson');

const q = name => quotaSempre(name, 'mysql');
const digest = value => value == null ? null : createHash('sha256').update(value).digest('hex');
const conflitto = name => new Error('La destinazione è cambiata durante il merge di "' + name + '". Le scritture concorrenti vengono conservate.');

function lettoreMongo(strategy, db, collection, session) {
  const c = strategy.client.db(db).collection(collection.name);
  return async doc => {
    const id = collection.encoding === raw.ENCODING ? raw.decodeId(doc) : BSON.serialize({ _id:BSON.EJSON.deserialize(doc, { relaxed:false })._id });
    const filter = BSON.deserialize(id, { promoteValues:false, bsonRegExp:true });
    if (id.equals(BSON.serialize(filter))) return c.findOne(filter, { raw:true, session });
    // Alcuni tag BSON storici non hanno rappresentazione JavaScript fedele.
    const cursor = c.find({}, { raw:true, session });
    try { for await (const item of cursor) if (raw.inspect(item).id.equals(id)) return item; }
    finally { await cursor.close(); }
    return null;
  };
}

async function lettoreMysql(strategy, db, collection, lock) {
  const info = await strategy.tableColumnsInfo(db, collection.name);
  const columns = new Map(info.columns.map(item => [item.name,item]));
  const projection = require('./sqlTransfer').projection(info, true);
  return async doc => {
    const row = deserializeClientObject(doc), params = [];
    const conditions = collection.identity.columns.map(name => {
      const ordinal = require('./mysql-ordinal').binding(row[name], columns.get(name));
      params.push(ordinal ? ordinal.param : toSqlValue(row[name]));
      return q(name) + ' = ' + (ordinal ? ordinal.sql : '?');
    });
    const sql = 'SELECT ' + projection + ' FROM ' + q(db) + '.' + q(collection.name)
      + ' WHERE ' + conditions.join(' AND ') + (lock ? ' FOR UPDATE' : '');
    const [[found]] = await strategy.pool.query(sql, params);
    return found ? require('./sqlTransfer').encodeRow(found, info.columns) : null;
  };
}

async function immaginiIniziali(strategy, type, plan, db) {
  const present = new Set((await strategy.listCollections(db, { includeCounts:false })).map(item => item.name));
  const immagini = new Map();
  for (const coll of plan.artifact.collections) {
    const hashes = [];
    if (present.has(coll.name)) {
      const read = type === 'mysql' ? await lettoreMysql(strategy, db, coll, false) : lettoreMongo(strategy, db, coll);
      for (const doc of coll.docs) hashes.push(digest(await read(doc)));
    }
    immagini.set(coll.name, hashes);
  }
  return immagini;
}

async function apriMerge(strategy, type) {
  let session, gestore, token, conn, isolated = strategy, commitIncerto = false, ddl = false;
  const journal = [];
  if (type === 'mysql') {
    conn = await strategy.pool.getConnection();
    try {
      await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await conn.beginTransaction();
    } catch (err) { conn.release(); throw err; }
    const lease = { query:conn.query.bind(conn), release() {} };
    isolated = Object.create(strategy);
    isolated.pool = { query:lease.query, getConnection:async () => lease };
  } else {
    const hello = await strategy.client.db('admin').command({ hello:1 });
    if (hello.setName || hello.msg === 'isdbgrid') {
      gestore = require('./mongoSessioneScript').gestore(strategy.client);
      token = gestore.start();
      session = gestore.run(token, () => require('./mongoSessioneScript').attiva());
      session.startTransaction({ readConcern:{ level:'snapshot' }, writeConcern:{ w:'majority' } });
    }
  }

  return {
    strategy:isolated, session,
    segnaDdl() { ddl = true; },
    async applica(plan, immagini, dbStaging, check) {
      const db = plan.targetDb;
      if (conn) {
        const [nonTransazionali] = await conn.query('SELECT t.TABLE_NAME FROM information_schema.TABLES t JOIN information_schema.ENGINES e ON e.ENGINE=t.ENGINE WHERE t.TABLE_SCHEMA=? AND e.TRANSACTIONS=\'NO\'', [db]);
        if (nonTransazionali.length) ddl = true;
      }
      for (const coll of plan.artifact.collections) {
        const read = conn ? await lettoreMysql(isolated, db, coll, true) : lettoreMongo(strategy, db, coll, session);
        const staged = !conn && !session && lettoreMongo(strategy, dbStaging, coll);
        const before = immagini.get(coll.name);
        for (let start = 0; start < coll.docs.length; start += 500) {
          check();
          const docs = coll.docs.slice(start, start + 500);
          for (const [i,doc] of docs.entries()) {
            const live = await read(doc);
            if (digest(live) !== (before[start + i] ?? null)) throw conflitto(coll.name);
            if (staged) {
              const dopo = await staged(doc);
              if (!dopo) throw new Error('Documento da promuovere assente nello staging.');
              if (live?.equals(dopo)) continue;
              const voce = { db:strategy.client.db(db), coll:coll.name, prima:live, dopo };
              // Una risposta persa può corrispondere a una scrittura già applicata.
              journal.push(voce);
              if (!await raw.sostituisciSeInvariato(voce.db, coll.name, live, dopo)) {
                journal.pop();
                throw conflitto(coll.name);
              }
            }
          }
          if (staged) continue;
          const apply = () => isolated.collectionImport(db, coll.name, { docs, upsert:true, encoding:coll.encoding,
            conflictColumns:coll.identity?.columns || ['_id'], timeZone:plan.artifact.sqlTimeZone });
          const result = await (session ? gestore.run(token, apply) : apply());
          if (result.failed || result.inserted !== docs.length) throw new Error('Merge incompleto di "' + coll.name + '": ' + (result.errors || []).join(', '));
        }
      }
    },
    async commit() {
      try { if (conn) await conn.commit(); else if (session) await session.commitTransaction(); }
      catch (err) { commitIncerto = true; throw err; }
      finally {
        if (conn) { if (commitIncerto) conn.destroy(); else conn.release(); }
        if (gestore) await gestore.close();
      }
      journal.length = 0;
    },
    async rollback() {
      if (commitIncerto) throw new Error('La conferma della transazione ha un esito incerto.');
      if (conn) {
        try { await conn.rollback(); } catch (err) { conn.destroy(); throw err; }
        conn.release();
      }
      if (session) {
        try { if (session.inTransaction()) await session.abortTransaction(); }
        finally { await gestore.close(); }
      }
      let incompleto = false;
      for (const voce of journal.reverse()) {
        try {
          if (!await raw.sostituisciSeInvariato(voce.db, voce.coll, voce.dopo, voce.prima)) incompleto = true;
        } catch { incompleto = true; }
      }
      if (ddl || incompleto) throw new Error('Verificare le modifiche già applicate e la copia di recupero. La destinazione è stata conservata.');
    },
  };
}

module.exports = { immaginiIniziali, apriMerge };
