'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { splitStatementsDetailed, stripSqlNoise } = require('./sqlText');
const contesto = new AsyncLocalStorage();
const stati = new Set();

function conSessioneSql(scope, esegui, persistente = false) { return contesto.run({ scope, persistente }, esegui); }

function rilasciaConnessione(stato, distruggi = false) {
  const conn = stato.conn;
  if (!conn) return;
  stato.conn = null;
  try {
    if (stato.strategy.type === 'mysql' && distruggi) conn.destroy();
    else conn.release(distruggi);
  } finally {
    conn.removeListener?.('error', stato.onErrore);
    stato.onErrore = null;
  }
}

// Una transazione appartiene al tab o allo script, mai al prossimo utilizzatore del pool.
async function prendiConnessioneSql(strategy, sql, apri) {
  const dialetto = { dbms: strategy.type, backslashEscape: strategy.type === 'mysql' };
  const corrente = contesto.getStore();
  const scope = corrente?.scope || strategy;
  let stato = [...stati].find(s => s.strategy === strategy && s.scope === scope);
  if (!stato) {
    stato = { strategy, scope, persistente: !!corrente?.persistente, coda: Promise.resolve(), conn: null, transazione: false, solaLettura: false };
    stati.add(stato);
  }
  const prima = stato.coda;
  let libera;
  stato.coda = new Promise(resolve => { libera = resolve; });
  await prima;
  if (stato.chiuso) { libera(); throw new Error('Sessione SQL chiusa.'); }
  if (stato.erroreConnessione) { libera(); throw stato.erroreConnessione; }
  if (stato.interrotta && !/^\s*(?:ROLLBACK|ABORT)(?:\s+(?:WORK|TRANSACTION))?\s*;?\s*$/i.test(stripSqlNoise(sql, dialetto))) {
    libera();
    throw new Error('Transazione interrotta: esegui ROLLBACK prima di iniziarne una nuova.');
  }
  stato.interrotta = false;
  try {
    if (!stato.conn) {
      const conn = stato.conn = await apri();
      // Il pool non gestisce gli errori dei client già assegnati a una sessione.
      stato.onErrore = err => {
        if (stato.conn !== conn) return;
        err.sqlConnectionLost = true;
        stato.erroreConnessione ||= err;
      };
      conn.on?.('error', stato.onErrore);
    }
  }
  catch (err) { libera(); throw err; }
  const conn = stato.conn;
  return {
    conn, transazione: stato.transazione, solaLettura: stato.solaLettura,
    persistente: stato.persistente,
    async termina(ok, distruggi = false, statoServer) {
      try {
        if (ok) {
          for (const stmt of splitStatementsDetailed(sql, dialetto)) {
            const testo = stripSqlNoise(stmt.sql, dialetto).trim();
            if (/^(?:BEGIN\b|START\s+TRANSACTION\b|SET\s+(?:SESSION\s+)?AUTOCOMMIT\s*=\s*0\b)/i.test(testo)) {
              stato.transazione = true;
              stato.solaLettura = /\bREAD\s+ONLY\b/i.test(testo);
            } else if (/^(?:COMMIT|END|ROLLBACK|ABORT)\b/i.test(testo) && !/^ROLLBACK\s+(?:WORK\s+|TRANSACTION\s+)?TO\b/i.test(testo)) {
              stato.transazione = /\bAND\s+CHAIN\b/i.test(testo);
            } else if (/^SET\s+(?:SESSION\s+)?AUTOCOMMIT\s*=\s*1\b/i.test(testo)) stato.transazione = false;
          }
        }
        // Il protocollo prevale sul testo: DDL, routine, autocommit e COMMIT
        // falliti possono iniziare o chiudere transazioni senza un BEGIN/END.
        if (statoServer) Object.assign(stato, statoServer);
        if (distruggi) {
          stato.interrotta = stato.transazione;
          stato.transazione = false;
          rilasciaConnessione(stato, true);
        } else if (!stato.transazione && !stato.persistente) {
          rilasciaConnessione(stato, this.transazione || !!stato.erroreConnessione);
        }
      } finally { libera(); }
    },
  };
}

async function chiudiStati(filtro) {
  let annullate = 0;
  for (const stato of [...stati].filter(filtro)) {
    stato.chiuso = true;
    await stato.coda;
    const conn = stato.conn;
    stati.delete(stato);
    if (!conn) continue;
    if (stato.transazione) annullate++;
    try {
      await conn.query('ROLLBACK');
    } catch { /* La connessione può essere già interrotta. */ }
    finally {
      // Elimina anche SET, tabelle temporanee e impostazioni di sessione lasciate dallo script.
      rilasciaConnessione(stato, true);
    }
  }
  return annullate;
}

const chiudiSessioneSql = scope => chiudiStati(s => s.scope === scope);
const chiudiStrategiaSql = strategy => chiudiStati(s => s.strategy === strategy);
module.exports = { conSessioneSql, prendiConnessioneSql, chiudiSessioneSql, chiudiStrategiaSql };
