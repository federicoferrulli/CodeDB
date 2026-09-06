// Storico query persistente in localStorage.
//
// Ogni voce registra modalità (find/aggregate), filtro e sort al momento
// dell'esecuzione. La chiave è per connessione salvata + database +
// collection, così lo storico "segue" la collection anche tra sessioni.
// Massimo MAX_ENTRIES voci per chiave; le esecuzioni identiche consecutive
// non vengono duplicate. Il click su una voce ripristina la query nei campi
// SENZA eseguirla: l'utente conferma con ▶ Esegui (o Invio).

import { state } from './state.js';
import { activeTab } from './tabs.js';
import { $, cut, toast } from './utils.js';
import { CHIAVE_QE } from './query-history-store.js';

const MAX_ENTRIES = 50;
// Prefisso unificato con il resto dell'applicazione (CDB-64): le chiavi di
// storage erano metà `codedb:` e metà residui del nome precedente, quindi non
// c'era modo di ripulirle in blocco — che è esattamente ciò che serve al logout.
const PREFIX = 'codedb:queryHistory:';
const PREFIX_STORICO = 'queryHistory:'; // chiavi scritte dalle versioni precedenti
// Tetto al NUMERO di chiavi (CDB-61): una per connessione+database+collection,
// quindi navigando un database con centinaia di tabelle lo storico cresceva
// senza alcun limite superiore e restava lì per sempre — anche dopo il logout,
// su un computer condiviso, con i filtri (cioè dei dati) di chi c'era prima.
const MAX_CHIAVI = 200;

/**
 * Porta le chiavi scritte dalle versioni precedenti sul prefisso nuovo (CDB-74).
 *
 * Senza questo passaggio il cambio di prefisso non "sposta" lo storico: lo rende
 * invisibile (`historyKey` cerca solo il nome nuovo) e poi lo fa cancellare dalla
 * potatura, che invece le chiavi vecchie le vede. Per l'utente sarebbe la
 * sparizione silenziosa della propria cronologia a un aggiornamento.
 *
 * Gira una volta sola, al caricamento del modulo: dopo, non esistono più chiavi
 * con il vecchio prefisso.
 */
function migraStoricoDaPrefissoVecchio() {
  try {
    const vecchie = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX_STORICO) && !k.startsWith(PREFIX)) vecchie.push(k);
    }
    for (const vecchia of vecchie) {
      const nuova = PREFIX + vecchia.slice(PREFIX_STORICO.length);
      // Se la chiave nuova esiste già (aggiornamento a metà, due schede aperte)
      // vince quella nuova: è la più recente.
      if (localStorage.getItem(nuova) === null) {
        const valore = localStorage.getItem(vecchia);
        if (valore !== null) localStorage.setItem(nuova, valore);
      }
      localStorage.removeItem(vecchia);
    }
  } catch { /* storage non disponibile: si riparte senza storico */ }
}

migraStoricoDaPrefissoVecchio();

// Chiave localStorage per la collection corrente del tab attivo.
function historyKey() {
  if (!state.db || !state.coll) return null;
  const tab = activeTab();
  const conn = (tab && (tab.connName || tab.label)) || 'anonima';
  return `${PREFIX}${conn}:${state.db}:${state.coll}`;
}

function loadHistory(key) {
  try {
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveHistory(key, entries) {
  try {
    localStorage.setItem(key, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
    potaChiavi();
  } catch {
    // localStorage pieno o non disponibile: lo storico è best-effort.
  }
}

// Elenco delle chiavi dello storico (formato attuale e precedente).
function chiaviStorico() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(PREFIX) || k.startsWith(PREFIX_STORICO))) out.push(k);
    }
  } catch { /* storage non disponibile */ }
  return out;
}

// Tiene il numero di chiavi sotto il tetto, buttando le meno recenti (CDB-61).
// "Meno recente" = la voce più nuova che contiene è la più vecchia fra tutte.
function potaChiavi() {
  const chiavi = chiaviStorico();
  if (chiavi.length <= MAX_CHIAVI) return;
  const conEta = chiavi.map((k) => {
    const voci = loadHistory(k);
    const ts = voci.reduce((max, v) => Math.max(max, Number(v && v.ts) || 0), 0);
    return { k, ts };
  }).sort((a, b) => a.ts - b.ts);
  for (const { k } of conEta.slice(0, chiavi.length - MAX_CHIAVI)) {
    try { localStorage.removeItem(k); } catch { /* ignora */ }
  }
}

/**
 * Cancella l'intero storico delle query (CDB-61). Chiamata al logout: i filtri
 * salvati contengono valori dei dati (email, codici, nomi), e su un computer
 * condiviso restavano leggibili al prossimo utente che apriva l'applicazione.
 */
export function clearAllHistory() {
  // Comprende la cronologia della tab ⚡ (`query-history-store.js`): questo
  // resta l'UNICO punto che ripulisce tutto. Una chiave dimenticata qui
  // lascerebbe leggibile al prossimo utente il testo delle query, che contiene
  // valori dei dati. Non entra invece in `chiaviStorico`, usata anche dalla
  // potatura per numero di chiavi: quella butta le più vecchie, e la cronologia
  // della tab ⚡ è una chiave sola che si pota da sé (MAX_VOCI).
  for (const k of [...chiaviStorico(), CHIAVE_QE]) {
    try { localStorage.removeItem(k); } catch { /* ignora */ }
  }
}

// Registra una query eseguita (chiamata da runQuery in grid.js).
// Le voci sono ordinate dalla più recente; niente dedup globale, solo
// delle esecuzioni identiche consecutive.
export function recordQuery({ mode, filter, sort, filterMode = 'rapido' }) {
  const key = historyKey();
  if (!key) return;
  const entry = { mode: 'find', filterMode, filter: filter || '', sort: sort || '', ts: Date.now() };
  // Query completamente vuota: inutile in uno storico.
  if (!entry.filter && !entry.sort) return;

  const entries = loadHistory(key);
  const last = entries[0];
  if (last && last.mode === entry.mode && last.filter === entry.filter && last.sort === entry.sort) {
    last.ts = entry.ts; // aggiorna solo il timestamp
  } else {
    entries.unshift(entry);
  }
  saveHistory(key, entries);
}

function fmtTs(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString('it-IT')} ${time}`;
}

function hidePanel() {
  const panel = $('#query-history-panel');
  if (panel) panel.classList.add('hidden');
}

// Ripristina una voce nei campi query (senza eseguirla).
function restoreEntry(entry) {
  const modo = entry.filterMode === 'condizione' ? 'condizione' : 'rapido';
  document.querySelector(`#filter-mode-switch [data-filter-mode="${modo}"]`)?.click();
  $('#filter-input').value = entry.filter;
  const gruppo = $('#filter-mode-switch');
  if (gruppo) gruppo.dataset[modo === 'rapido' ? 'testoRapido' : 'testoCondizione'] = entry.filter || '';
  $('#sort-input').value = entry.sort;
  hidePanel();
  $('#filter-input').focus();
  toast('Query ripristinata: premi ▶ Esegui per lanciarla');
}

function renderPanel() {
  const panel = $('#query-history-panel');
  panel.innerHTML = '';

  const key = historyKey();
  // Le vecchie voci aggregate/SQL Raw restano nel loro archivio ma non vengono
  // riproposte nella vista Dati: quelle operazioni vivono in Query & Aggregate.
  const entries = key ? loadHistory(key).filter((entry) => entry.mode !== 'aggregate') : [];

  const header = document.createElement('div');
  header.className = 'query-history-header';
  const title = document.createElement('span');
  title.textContent = state.coll ? `Query recenti — ${state.coll}` : 'Query recenti';
  header.appendChild(title);
  if (entries.length) {
    const clear = document.createElement('button');
    clear.textContent = 'Svuota';
    clear.title = 'Elimina lo storico di questa collection';
    clear.addEventListener('click', () => {
      localStorage.removeItem(key);
      renderPanel();
    });
    header.appendChild(clear);
  }
  panel.appendChild(header);

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'query-history-empty';
    empty.textContent = 'Nessuna query recente per questa collection.';
    panel.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'query-history-item';
    item.title = 'Clicca per ripristinare la query nei campi (senza eseguirla)';

    const top = document.createElement('div');
    top.className = 'query-history-item-top';
    const mode = document.createElement('span');
    mode.className = 'query-history-mode';
    mode.textContent = entry.filterMode === 'condizione' ? 'Condizione' : 'Cerca';
    const ts = document.createElement('span');
    ts.className = 'query-history-ts';
    ts.textContent = fmtTs(entry.ts);
    top.appendChild(mode);
    top.appendChild(ts);
    item.appendChild(top);

    const text = document.createElement('div');
    text.className = 'query-history-text';
    text.textContent = cut(entry.filter || '(nessun filtro)', 120);
    item.appendChild(text);

    if (entry.sort) {
      const sort = document.createElement('div');
      sort.className = 'query-history-sort';
      sort.textContent = `sort: ${cut(entry.sort, 60)}`;
      item.appendChild(sort);
    }

    item.addEventListener('click', () => restoreEntry(entry));
    panel.appendChild(item);
  }
}

export function initQueryHistory() {
  const btn = $('#query-history-btn');
  const panel = $('#query-history-panel');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.classList.contains('hidden')) {
      renderPanel();
      panel.classList.remove('hidden');
    } else {
      hidePanel();
    }
  });

  // Chiusura al click fuori dal pannello e con Escape.
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !panel.contains(e.target)) hidePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePanel();
  });
}
