'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { splitStatementsDetailed, stripSqlNoise } = require('./sqlText');
const contesto = new AsyncLocalStorage();
const stati = new Set();

function conSessioneSql(scope, esegui, persistente = false) { return contesto.run({ scope, persistente }, esegui); }

// Una transazione appartiene al tab o allo script, mai al prossimo utilizzatore del pool.
async function prendiConnessioneSql(strategy, sql, apri) {
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
  if (stato.interrotta && !/^\s*(?:ROLLBACK|ABORT)\s*;?\s*$/i.test(sql)) {
    libera();
    throw new Error('Transazione interrotta: esegui ROLLBACK prima di iniziarne una nuova.');
  }
  stato.interrotta = false;
  try { if (!stato.conn) stato.conn = await apri(); }
  catch (err) { libera(); throw err; }
  const conn = stato.conn;
  return {
    conn, transazione: stato.transazione, solaLettura: stato.solaLettura,
    async termina(ok, distruggi = false) {
      try {
        if (ok) {
          for (const stmt of splitStatementsDetailed(sql)) {
            const testo = stripSqlNoise(stmt.sql).trim();
            if (/^(?:BEGIN\b|START\s+TRANSACTION\b|SET\s+(?:SESSION\s+)?AUTOCOMMIT\s*=\s*0\b)/i.test(testo)) {
              stato.transazione = true;
              stato.solaLettura = /\bREAD\s+ONLY\b/i.test(testo);
            } else if (/^(?:COMMIT|END|ROLLBACK|ABORT)\b/i.test(testo) && !/^ROLLBACK\s+(?:WORK\s+|TRANSACTION\s+)?TO\b/i.test(testo)) {
              stato.transazione = /\bAND\s+CHAIN\b/i.test(testo);
            } else if (/^SET\s+(?:SESSION\s+)?AUTOCOMMIT\s*=\s*1\b/i.test(testo)) stato.transazione = false;
          }
        }
        if (distruggi) {
          stato.conn = null;
          stato.interrotta = stato.transazione;
          stato.transazione = false;
          if (strategy.type === 'mysql') conn.destroy(); else conn.release(true);
        } else if (!stato.transazione && !stato.persistente) {
          stato.conn = null;
          if (this.transazione) {
            if (strategy.type === 'mysql') conn.destroy(); else conn.release(true);
          } else conn.release();
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
    stato.conn = null;
    stati.delete(stato);
    if (!conn) continue;
    if (stato.transazione) annullate++;
    try {
      await conn.query('ROLLBACK');
      // Elimina anche SET, tabelle temporanee e impostazioni di sessione lasciate dallo script.
      if (stato.strategy.type === 'mysql') conn.destroy(); else conn.release(true);
    } catch {
      if (stato.strategy.type === 'mysql') conn.destroy(); else conn.release(true);
    }
  }
  return annullate;
}

const chiudiSessioneSql = scope => chiudiStati(s => s.scope === scope);
const chiudiStrategiaSql = strategy => chiudiStati(s => s.strategy === strategy);
module.exports = { conSessioneSql, prendiConnessioneSql, chiudiSessioneSql, chiudiStrategiaSql };
