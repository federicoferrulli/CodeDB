'use strict';

/* ---------------------------------------------------------------------------
 * Storico delle query della tab ⚡ Query & Aggregate — strato PURO.
 *
 * Nessun DOM, storage iniettato: come `onboarding-stato.js` e `cell-stats.js`,
 * perché è la parte che sbagliata non si vede subito. Una cronologia che perde
 * voci, che ne duplica una a ogni riesecuzione o che riempie il `localStorage`
 * fino a farlo fallire è un difetto che si scopre settimane dopo, sulla
 * macchina di qualcun altro — quindi va provata in Node
 * (`test/unit-query-history.js`).
 *
 * Perché una chiave SOLA e globale, al contrario dello storico della vista Dati
 * (`queryhistory.js`, chiave per connessione+database+collection): una query
 * della tab ⚡ cita spesso più database (JOIN, `USE <db>`, Virtual JOIN) e non
 * appartiene a una collection. Legarla a `db+coll` la renderebbe irreperibile
 * proprio nel caso in cui serve ritrovarla. La provenienza resta nella voce
 * (`conn`/`db`/`coll`) e il pannello filtra.
 * ------------------------------------------------------------------------- */

// Prefisso unificato con il resto dell'applicazione (vedi PREFIX in
// queryhistory.js): `clearAllHistory()` al logout raccoglie le chiavi per
// prefisso, quindi una chiave fuori convenzione resterebbe leggibile al
// prossimo utente su un computer condiviso.
export const CHIAVE_QE = 'codedb:queryHistoryQE';

export const MAX_VOCI = 200;

// Oltre questa lunghezza il testo non viene registrato. Non è un limite
// estetico: i blocchi del chunker di file SQL (`runScriptAndWait`) passano
// dallo stesso `runQuery` e pesano megabyte l'uno — riempirebbero da soli la
// quota del `localStorage`, facendo sparire tutto il resto della cronologia.
// Quel testo sta già su disco, ed è il file che l'utente ha aperto.
export const MAX_CODE = 20000;

function ora() {
  return Date.now();
}

/** Testo normalizzato per il confronto di due esecuzioni "uguali". */
function chiaveDedup(v) {
  return [
    String(v.code || '').trim(),
    v.engine || 'auto',
    v.conn || '',
    v.db || '',
    v.coll || '',
  ].join('\0');
}

export function leggiVoci(storage) {
  try {
    const grezzo = storage.getItem(CHIAVE_QE);
    const arr = JSON.parse(grezzo || '[]');
    return Array.isArray(arr) ? arr.filter((v) => v && typeof v.code === 'string') : [];
  } catch {
    // Storage assente, disabilitato dal browser o contenuto manomesso: la
    // cronologia è un comodo, non deve poter impedire di eseguire una query.
    return [];
  }
}

export function scriviVoci(storage, voci) {
  try {
    storage.setItem(CHIAVE_QE, JSON.stringify(voci.slice(0, MAX_VOCI)));
    return true;
  } catch {
    // Quota superata o storage in sola lettura: best-effort, come saveHistory.
    return false;
  }
}

export function svuota(storage) {
  try { storage.removeItem(CHIAVE_QE); } catch { /* ignora */ }
}

/**
 * Registra un'esecuzione APPENA LANCIATA e restituisce il suo id (o `null` se
 * non è stata registrata).
 *
 * Si registra al lancio e non alla risposta: una query annullata, andata in
 * timeout o interrotta da un F5 è esattamente quella che si vuole ritrovare,
 * e alla risposta non ci arriverebbe mai. L'esito si aggiunge dopo con
 * `aggiornaEsito`.
 *
 * Dedup GLOBALE (non solo consecutiva come nella vista Dati): l'elenco è unico
 * e lungo 200 voci, quindi la stessa query rilanciata dieci volte in mezz'ora
 * lo consumerebbe tutto. La voce esistente risale in testa e riparte senza
 * esito, che verrà riscritto dall'esecuzione in corso.
 */
export function registra(storage, meta = {}) {
  const code = String(meta.code || '');
  if (!code.trim()) return null;
  if (code.length > MAX_CODE) return null;

  const voce = {
    id: `${ora().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    code,
    engine: meta.engine || 'auto',
    conn: meta.conn || '',
    db: meta.db || '',
    coll: meta.coll || '',
    dbType: meta.dbType || '',
    script: !!meta.script,
    ts: ora(),
    esito: null,
    ms: null,
    righe: null,
  };

  const voci = leggiVoci(storage);
  const chiave = chiaveDedup(voce);
  const resto = voci.filter((v) => chiaveDedup(v) !== chiave);
  resto.unshift(voce);
  scriviVoci(storage, resto);
  return voce.id;
}

/** Completa una voce con l'esito dell'esecuzione. No-op su un id sconosciuto. */
export function aggiornaEsito(storage, id, { esito = null, ms = null, righe = null } = {}) {
  if (!id) return false;
  const voci = leggiVoci(storage);
  const v = voci.find((x) => x && x.id === id);
  if (!v) return false;
  v.esito = esito;
  v.ms = ms;
  v.righe = righe;
  scriviVoci(storage, voci);
  return true;
}

/** Filtro del pannello: testo libero + connessione. Entrambi facoltativi. */
export function filtra(voci, { testo = '', conn = '' } = {}) {
  const q = String(testo || '').trim().toLowerCase();
  const c = String(conn || '');
  return (Array.isArray(voci) ? voci : []).filter((v) => {
    if (!v) return false;
    if (c && v.conn !== c) return false;
    if (!q) return true;
    const campi = `${v.code || ''} ${v.db || ''} ${v.coll || ''} ${v.conn || ''}`.toLowerCase();
    return campi.includes(q);
  });
}

/** Connessioni citate dalle voci, in ordine alfabetico (per la select). */
export function connessioniPresenti(voci) {
  const set = new Set();
  for (const v of (Array.isArray(voci) ? voci : [])) {
    if (v && v.conn) set.add(v.conn);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'it'));
}
