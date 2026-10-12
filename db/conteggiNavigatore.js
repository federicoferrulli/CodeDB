'use strict';

const LIMITE_RIGHE = 1000;
const BUDGET_MS = 350;
const QUERY_MS = 100;

function stimaConteggio(value) {
  const n = Number(value);
  // Uno zero di catalogo può essere una statistica vecchia, non una tabella vuota.
  const noto = Number.isFinite(n) && n > 0;
  return { count: noto ? Math.round(n) : null, countApprox: noto };
}

function conteggioLimitato(value, stima) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || value == null) return stimaConteggio(stima);
  if (n <= LIMITE_RIGHE) return { count: n, countApprox: false };
  if (Number(stima) >= n) return stimaConteggio(stima);
  // Senza statistiche non inventiamo una stima: il campione prova solo un minimo.
  return { count: n, countApprox: false, countLowerBound: true };
}

async function completaConteggi(collections, leggi) {
  const scadenza = performance.now() + BUDGET_MS;
  let prossimo = 0;
  async function worker() {
    while (prossimo < collections.length && performance.now() < scadenza) {
      const coll = collections[prossimo++];
      if (coll.type === 'view' || coll.count > LIMITE_RIGHE) continue;
      const ms = Math.max(1, Math.min(QUERY_MS, Math.floor(scadenza - performance.now())));
      try { Object.assign(coll, await leggi(coll, LIMITE_RIGHE + 1, ms)); }
      catch { /* Timeout, permessi o tabella rimossa: resta la stima, mai uno zero fittizio. */ }
    }
  }
  // Niente Promise.all su migliaia di tabelle: due letture brevi alla volta.
  await Promise.all([worker(), worker()]);
  return collections;
}

module.exports = { LIMITE_RIGHE, stimaConteggio, conteggioLimitato, completaConteggi };
