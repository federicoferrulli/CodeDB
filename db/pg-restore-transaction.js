'use strict';

const { EventEmitter } = require('node:events');

// Una connessione dedicata: il pool della sessione utente non viene sostituito.
// Le transazioni dei singoli batch diventano savepoint dentro la promozione.
async function apriTransazioneRipristino(strategy) {
  const client = await strategy.pool.connect();
  let state = 'apertura', queue = Promise.resolve(), sequence = 0;
  const nested = [];
  const lease = new EventEmitter();
  lease.release = () => {};
  const onError = error => { if (lease.listenerCount('error')) lease.emit('error', error); };
  client.on?.('error', onError);
  const release = error => { client.removeListener?.('error', onError); client.release(error); };
  try { await client.query('BEGIN'); state = 'aperta'; }
  catch (error) { release(error); throw error; }

  async function execute(sql, params) {
    if (state !== 'aperta') throw new Error('Transazione del ripristino non più aperta.');
    const text = typeof sql === 'string' ? sql : sql.text;
    const command = text.trim().replace(/;\s*$/, '');
    if (/^(?:BEGIN|START TRANSACTION)(?:\s+(?:WORK|TRANSACTION|READ ONLY|READ WRITE))?$/i.test(command)) {
      const name = `codedb_batch_${++sequence}`;
      const result = await client.query(`SAVEPOINT ${name}`); nested.push(name); return result;
    }
    if (/^(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?$/i.test(command)) {
      const name = nested.pop();
      if (!name) throw new Error('Commit di batch senza savepoint: la promozione deve essere confermata dal piano.');
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (/^(?:ROLLBACK|ABORT)(?:\s+(?:WORK|TRANSACTION))?$/i.test(command)) {
      const name = nested.pop();
      if (!name) throw new Error('Rollback di batch senza savepoint.');
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    // Il motore dei batch gestisce già i propri savepoint di recupero.
    if (/^(?:SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK\s+TO(?:\s+SAVEPOINT)?)\s/i.test(command)) return client.query(sql, params);
    const name = `codedb_query_${++sequence}`;
    await client.query(`SAVEPOINT ${name}`);
    try {
      const result = await client.query(sql, params);
      await client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      // Errori DDL recuperabili (ad esempio un oggetto già presente) non
      // devono abortire l'intera transazione prima del controllo del chiamante.
      try { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); await client.query(`RELEASE SAVEPOINT ${name}`); }
      catch (rollbackError) { error.rollbackError = rollbackError.message; }
      throw error;
    }
  }
  const query = (sql, params) => {
    const pending = queue.then(() => execute(sql, params));
    queue = pending.catch(() => {}); return pending;
  };
  lease.query = query;
  const isolated = new (require('./PostgreSqlStrategy'))({ env: strategy.env });
  isolated.pool = { query, connect: async () => lease, end: async () => {} };
  return {
    strategy: isolated,
    get state() { return state; },
    async commit() {
      await queue;
      await require('./sqlSessione').chiudiStrategiaSql(isolated);
      if (state !== 'aperta') throw new Error('Promozione non confermabile: transazione non aperta.');
      if (nested.length) throw new Error('Promozione non confermabile: batch ancora aperto.');
      state = 'conferma';
      try { await client.query('COMMIT'); state = 'confermata'; release(); }
      catch (error) {
        state = 'incerta'; release(error);
        // Una risposta persa al COMMIT non prova che il server abbia annullato.
        error.commitUncertain = true; throw error;
      }
    },
    async rollback() {
      await queue;
      await require('./sqlSessione').chiudiStrategiaSql(isolated);
      if (state === 'annullata') return;
      if (state !== 'aperta') throw new Error('Esito della conferma incerto o già confermato: conservare la copia di recupero.');
      try { await client.query('ROLLBACK'); state = 'annullata'; release(); }
      catch (error) { state = 'incerta'; release(error); throw error; }
    },
  };
}

module.exports = { apriTransazioneRipristino };
