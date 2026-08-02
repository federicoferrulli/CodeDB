'use strict';

import { socket } from './socket.js';
import { safeUUID } from './utils.js';
import { markAbandonedByTab } from './pending-queries.js';

// Registro dei tab di connessione. Ogni tab ha un proprio `state` (la forma
// storica dell'oggetto globale) e una sessione dedicata lato server, indicata
// dal suo `id` (il tabId che viaggia in ogni payload, vedi emit in utils.js).

// Stato "vergine" di un tab.
export function freshState() {
  return {
    connected: false,
    connLabel: '',
    dbType: 'mongodb',     // 'mongodb' | 'mysql'
    db: null,
    coll: null,
    skip: 0,
    limit: 50,
    total: 0,           // conteggio totale; null = sconosciuto (conteggio disaccoppiato)
    countToken: 0,      // scarta le risposte di conteggio obsolete
    countKey: null,     // firma (db|coll|filtro) già conteggiata: la paginazione la riusa
    countApprox: false, // totale stimato dai metadati (footer con "≈", non esatto per la navigazione)
    gridRunId: null,    // runId della find/aggregate della griglia in volo (single-flight + annullamento)
    countPending: false, // conteggio totale in corso (footer mostra '…')
    countTimedOut: false, // conteggio andato in timeout lato server (footer mostra '?')
    docs: [],
    columns: [],
    infiniteScroll: false,  // scroll infinito attivo (carica a blocchi allo scroll)
    loading: false,         // fetch di un blocco in corso (scroll infinito)
    exhausted: false,       // tutti i documenti caricati: niente altri blocchi
    liveTimer: null,
    pollingInterval: null,
    view: 'data',
    expandedDbs: new Set(), // db espansi nella sidebar
    editingDoc: null,       // documento aperto nella modale di modifica riga
    dbSchema: null,         // cache dello schema per la vista UML
    dbSchemaFor: null,      // db a cui si riferisce la cache
    databases: [],          // elenco db per la sidebar del tab
    // Snapshot degli input del workspace, salvato al cambio tab (mentre il
    // tab è attivo la verità è il DOM; vedi saveWorkspaceInputs in workspace.js).
    filter: '',
    sort: '',
    queryMode: 'find',
    pageSize: '50',
    watching: false,        // change stream attivo (badge LIVE)
    pollingShown: false,    // watch non disponibile: mostra il toggle auto-refresh
    collTabs: [],           // collection/tabelle aperte in questo tab (vedi colltabs.js)
    activeCollId: null,     // coll-tab attivo
    selectedDocs: new Set(), // _id dei documenti selezionati per la delete multipla
    cellSel: { anchor: null, focus: null, cells: new Set() }, // selezione celle stile Excel (vedi cellselect.js)
    schemaPolling: false,   // watch dello schema non disponibile: polling della sidebar
    schemaDirty: false,     // schema cambiato mentre il tab era in background
    // Bersaglio scelto a mano nella tab ⚡ Query & Aggregate (click nello Schema
    // Browser o comando USE). null = segue il contesto del workspace
    // (state.db/state.coll). Vive QUI, non in una variabile di modulo, perché
    // altrimenti sarebbe condiviso da tutti i tab di connessione: la scelta
    // fatta in un tab dirottava le query di tutti gli altri.
    queryDb: null,
    queryColl: null,
    // Configurazione della vista Grafici della tab ⚡ Query & Aggregate (serie,
    // assi, legenda, tavolozza; vedi charts.js). Sta qui per la stessa ragione
    // di queryDb: due tab su due connessioni diverse mostrano due grafici
    // diversi, e passando dall'uno all'altro ognuno ritrova il suo. null =
    // ancora mai aperta (la costruisce charts.js alla prima richiesta).
    chartCfg: null,
  };
}

export const tabs = {
  /** @type {{ id: string, connName: string|null, label: string, dbType: string, state: object }[]} */
  list: [],
  activeId: null,
};

export function activeTab() {
  return tabs.list.find((t) => t.id === tabs.activeId) || null;
}

// Callback invocate quando cambia il tab attivo (ri-render del workspace).
const listeners = new Set();
export function onTabChange(fn) {
  listeners.add(fn);
}

// `id` esplicito: il flusso di connessione genera prima il tabId (per la
// sessione server) e crea il tab solo a connessione riuscita.
export function createTab({ id, connName } = {}) {
  // Un tabId identifica UNA sessione lato server: se esiste già un tab con
  // quell'id va riusato, non duplicato. Senza questo controllo un doppio
  // ripristino di sessione (socket riconnesso due volte di seguito) produceva
  // due tab omonimi nella barra, entrambi legati alla stessa sessione.
  if (id) {
    const existing = tabs.list.find((t) => t.id === id);
    if (existing) {
      if (connName) {
        existing.connName = connName;
        existing.label = connName;
      }
      return existing;
    }
  }
  const tab = {
    id: id || safeUUID(),
    connName: connName || null,
    label: connName || '',
    dbType: 'mongodb',
    state: freshState(),
  };
  tabs.list.push(tab);
  if (!tabs.activeId) tabs.activeId = tab.id;
  return tab;
}

export function switchTab(id) {
  if (tabs.activeId === id || !tabs.list.some((t) => t.id === id)) return;
  tabs.activeId = id;
  listeners.forEach((fn) => fn(activeTab()));
}

export function closeTab(id) {
  markAbandonedByTab(id);
  const i = tabs.list.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [tab] = tabs.list.splice(i, 1);
  // Niente timer orfani: il polling e il debounce live appartengono al tab.
  clearInterval(tab.state.pollingInterval);
  clearTimeout(tab.state.liveTimer);
  // Chiude la sessione dedicata (strategia + eventuale tunnel) lato server.
  socket.emit('mongo:disconnect', { tabId: tab.id }, () => {});
  if (tabs.activeId === id) {
    const next = tabs.list[i] || tabs.list[i - 1];
    tabs.activeId = next ? next.id : null;
    listeners.forEach((fn) => fn(activeTab()));
  }
}

// Chiude tutti i tab (es. sessione socket persa): lo stato torna "nessuna
// connessione aperta". Le sessioni server sono già state chiuse dal server.
export function closeAllTabs() {
  for (const tab of tabs.list) {
    clearInterval(tab.state.pollingInterval);
    clearTimeout(tab.state.liveTimer);
  }
  tabs.list.length = 0;
  tabs.activeId = null;
  listeners.forEach((fn) => fn(null));
}
