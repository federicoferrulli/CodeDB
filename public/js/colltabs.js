'use strict';

import { state } from './state.js';
import { activeTab } from './tabs.js';
import { $, emitFireAndForget, showContextMenu, makeDraggable, reorderById, safeUUID, isSqlType } from './utils.js';
import { exportImportMenuItems } from './exportimport.js';
import { runQuery, renderGrid, applyQueryPlaceholders } from './grid.js';
import { startWatch } from './live.js';
import { setView } from './main.js';
import { addOrSplitPane, renderSplitView, deactivateSplitView, closeSplitView } from './splitview.js';
import { markAbandonedByCollTab } from './pending-queries.js';

// Tab di secondo livello: le collection/tabelle aperte dentro un tab di
// connessione (t.state.collTabs). Ogni coll-tab ha uno snapshot di query,
// risultati e vista, ripristinato quando lo si riattiva; mentre è attivo la
// verità è il DOM/stato piatto, lo snapshot si aggiorna al cambio.

export function currentCollTab() {
  const t = activeTab();
  return t ? t.state.collTabs.find((c) => c.id === t.state.activeCollId) : null;
}

// Copia locale di `collWord()` (dbtree.js): importarla creerebbe il ciclo
// colltabs → dbtree → grid → colltabs solo per una parola.
function parolaColl() {
  return isSqlType(state.dbType) ? 'tabella' : 'collection';
}

// Un coll-tab "a livello database" (`isDbTab`) non ha una collection: serve ai
// database ancora VUOTI, dove prima non si poteva aprire nulla e quindi non si
// riusciva nemmeno a creare la prima tabella con una query. Ha la sola vista
// ⚡ Query & Aggregate: le altre (Dati, Dettagli, UML, Grafo 3D) descrivono una
// collection che qui non esiste.
export function applyViewTabsFor(ct) {
  const soloQuery = !!(ct && ct.isDbTab);
  document.querySelectorAll('.view-tab').forEach((el) => {
    el.classList.toggle('hidden', soloQuery && el.dataset.view !== 'query');
  });
}

function saveActiveSnapshot() {
  const ct = currentCollTab();
  if (!ct || ct.isSplitTab || ct.isDbTab) return;
  ct.snap = {
    filter: $('#filter-input')?.value || '',
    sort: $('#sort-input')?.value || '',
    queryMode: $('#query-mode')?.value || 'find',
    pageSize: $('#page-size')?.value || '50',
    infiniteScroll: state.infiniteScroll,
    skip: state.skip,
    limit: state.limit,
    total: state.total,
    docs: state.docs,
    columns: state.columns,
    view: state.view,
  };
}

// Evidenzia nel tree la collection attiva (la selezione segue il coll-tab).
function markTreeSelection() {
  document.querySelectorAll('#db-tree .node-label.selected').forEach((el) => el.classList.remove('selected'));
  for (const el of document.querySelectorAll('#db-tree .coll > .node-label')) {
    if (el.dataset.db === state.db && el.dataset.coll === state.coll) el.classList.add('selected');
  }
}

function activate(ct, { fresh }) {
  const t = activeTab();
  t.state.activeCollId = ct.id;

  if (ct.isSplitTab) {
    renderCollTabBar();
    markTreeSelection();
    applyViewTabsFor(ct);
    renderSplitView();
    return;
  }

  deactivateSplitView();

  // Tab a livello database (nessuna collection): niente griglia, niente watch,
  // niente snapshot — solo la tab Query & Aggregate puntata su questo database.
  if (ct.isDbTab) {
    state.db = ct.db;
    state.coll = null;
    state.queryDb = ct.db;
    state.queryColl = null;
    state.watching = false;
    state.selectedDocs.clear();
    // Il change stream e l'auto-refresh appartenevano alla collection lasciata:
    // qui non c'è nulla da aggiornare. Senza questo l'intervallo di polling
    // continuava a scattare ogni 5 s a vuoto (`runQuery` esce subito senza
    // `state.coll`) finché non si riapriva una collection. La casella NON viene
    // deselezionata: tornando sul suo coll-tab `startWatch` la rilegge e il
    // polling riparte da solo.
    emitFireAndForget('collection:unwatch');
    if (state.pollingInterval) {
      clearInterval(state.pollingInterval);
      state.pollingInterval = null;
    }
    $('#live-badge').classList.add('hidden');
    $('#polling-toggle').classList.add('hidden');
    $('#breadcrumb').textContent = `${ct.db} ▸ (nessuna ${parolaColl()})`;
    $('#placeholder').classList.add('hidden');
    $('#workspace').classList.remove('hidden');
    renderCollTabBar();
    markTreeSelection();
    applyViewTabsFor(ct);
    setView('query');
    return;
  }
  applyViewTabsFor(ct);

  state.db = ct.db;
  state.coll = ct.coll;
  // La tab ⚡ Query & Aggregate torna a seguire il contesto: un bersaglio scelto
  // a mano nello Schema Browser (o via `USE <db>`) vale finché si resta su
  // questa collection, non per sempre. Senza questo azzeramento la tab
  // continuava a interrogare il primo database toccato, anche dopo averne
  // aperto un altro.
  state.queryDb = null;
  state.queryColl = null;
  state.watching = false;
  // La selezione bulk è legata alla pagina corrente: un _id (es. PK intera
  // MySQL) potrebbe coincidere tra tabelle diverse, quindi si azzera.
  state.selectedDocs.clear();
  // Lo scroll infinito riparte pulito sulla collection attivata.
  state.loading = false;
  state.exhausted = false;
  // Il conteggio disaccoppiato è per-query: invalida quelli in volo del coll-tab
  // precedente (il token cambierà alla prossima runQuery) e azzera i flag footer.
  state.countPending = false;
  state.countTimedOut = false;

  $('#live-badge').classList.add('hidden');

  const s = ct.snap;
  // Input da ripristinare dopo un refresh (una tantum): presenti solo finché il
  // coll-tab non ha ancora uno snapshot proprio (vedi session-restore.js).
  const r = (!s && ct.restore) ? ct.restore : null;
  $('#filter-input').value = s ? s.filter : (r ? (r.filter || '') : '');
  $('#sort-input').value = s ? s.sort : (r ? (r.sort || '') : '');
  $('#query-mode').value = s ? s.queryMode : (r ? (r.queryMode || 'find') : 'find');
  if (s) $('#page-size').value = s.pageSize;
  else if (r && r.pageSize) $('#page-size').value = r.pageSize;
  state.infiniteScroll = s ? !!s.infiniteScroll : (r ? !!r.infiniteScroll : false);
  $('#infinite-toggle').checked = state.infiniteScroll;
  applyQueryPlaceholders();

  $('#breadcrumb').textContent = `${ct.db} ▸ ${ct.coll}`;
  $('#placeholder').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  renderCollTabBar();
  markTreeSelection();

  if (fresh || !s) {
    state.skip = 0;
    state.docs = [];
    state.columns = [];
    state.total = 0;
    setView(r && r.view ? r.view : 'data');
    // La riesecuzione della query in fase di ripristino (r) è automatica, non
    // un'azione dell'utente: marcata `auto` così l'audit non la registra
    // (coerente con polling/refresh post-scrittura). L'apertura "vera" di una
    // collection (r assente) resta invece tracciata come lettura utente.
    runQuery(r ? { auto: true } : undefined);
    if (r) ct.restore = null; // input ripristinati: da qui in poi vale lo snapshot
  } else {
    state.skip = s.skip;
    state.limit = s.limit;
    state.total = s.total;
    state.docs = s.docs;
    state.columns = s.columns;
    renderGrid(); // risultati dalla cache: nessuna nuova query
    setView(s.view || 'data');
  }
  // Il change stream della sessione è unico: segue la collection attiva.
  // L'eventuale auto-refresh (MySQL) si ferma e va riattivato sul nuovo tab.
  startWatch();
}

// Attiva il coll-tab attivo del tab corrente se i suoi dati non sono ancora
// stati caricati (state.db/coll non impostati): serve dopo il ripristino di una
// sessione, dove i coll-tab esistono ma la query non è stata ancora eseguita.
// Sui tab normali (dati già in stato) esce subito senza effetti.
export function ensureActiveCollLoaded() {
  const t = activeTab();
  if (!t || !t.state.connected) return;
  const id = t.state.activeCollId;
  if (!id) return;
  if (state.db && state.coll) return; // dati già presenti nello stato del tab
  const ct = t.state.collTabs.find((c) => c.id === id);
  if (ct) activate(ct, { fresh: false });
}

export function openCollTab(db, coll) {
  const t = activeTab();
  if (!t || !t.state.connected) return;
  saveActiveSnapshot();
  let ct = t.state.collTabs.find((c) => c.db === db && c.coll === coll && !c.isSplitTab);
  if (!ct) {
    ct = { id: safeUUID(), db, coll, snap: null };
    t.state.collTabs.push(ct);
    activate(ct, { fresh: true });
  } else if (ct.id !== t.state.activeCollId) {
    activate(ct, { fresh: false });
  }
}

// Apre (o riattiva) il tab a livello database: l'unico modo di lavorare su un
// database senza collection, dove non c'è niente da cliccare nella sidebar.
export function openDbTab(db) {
  const t = activeTab();
  if (!t || !t.state.connected) return;
  saveActiveSnapshot();
  let ct = t.state.collTabs.find((c) => c.isDbTab && c.db === db);
  if (!ct) {
    ct = { id: safeUUID(), db, coll: null, isDbTab: true, snap: null };
    t.state.collTabs.push(ct);
    activate(ct, { fresh: true });
  } else if (ct.id !== t.state.activeCollId) {
    activate(ct, { fresh: false });
  }
}

export function switchCollTab(id) {
  const t = activeTab();
  if (!t || id === t.state.activeCollId) return;
  const ct = t.state.collTabs.find((c) => c.id === id);
  if (!ct) return;
  saveActiveSnapshot();
  activate(ct, { fresh: false });
}

export function closeCollTab(id) {
  markAbandonedByCollTab(id);
  const t = activeTab();
  if (!t) return;
  const list = t.state.collTabs;
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return;

  if (list[i].isSplitTab) {
    closeSplitView();
    return;
  }

  const wasActive = list[i].id === t.state.activeCollId;
  list.splice(i, 1);
  if (!wasActive) {
    renderCollTabBar();
    return;
  }
  const next = list[i] || list[i - 1];
  if (next) activate(next, { fresh: false });
  else clearCollWorkspace();
}

// Chiude i coll-tab che soddisfano il predicato (es. db o collection eliminati).
// `st` esplicito: le operazioni DDL rispondono in modo asincrono e l'utente può
// aver cambiato tab nel frattempo — senza, si chiuderebbero i coll-tab del tab
// sbagliato. Su un tab non attivo si aggiorna solo la struttura, mai il DOM.
export function closeCollTabsWhere(pred, st = null) {
  const t = activeTab();
  if (st && (!t || t.state !== st)) {
    const list = st.collTabs;
    for (const c of list.filter(pred)) {
      markAbandonedByCollTab(c.id);
      const i = list.indexOf(c);
      if (i >= 0) list.splice(i, 1);
      if (st.activeCollId === c.id) st.activeCollId = (list[i] || list[i - 1] || {}).id || null;
    }
    return;
  }
  if (!t) return;
  for (const id of t.state.collTabs.filter(pred).map((c) => c.id)) closeCollTab(id);
}

// Applica una modifica a tutti i coll-tab (es. rename di db/collection).
export function updateCollTabs(fn, st = null) {
  const t = activeTab();
  if (st && (!t || t.state !== st)) {
    st.collTabs.forEach(fn);
    return; // tab in background: nessuna barra da ridisegnare
  }
  if (!t) return;
  t.state.collTabs.forEach(fn);
  renderCollTabBar();
}

// Nessuna collection aperta: torna al placeholder del workspace.
function clearCollWorkspace() {
  const t = activeTab();
  if (t) t.state.activeCollId = null;
  emitFireAndForget('collection:unwatch');
  state.db = null;
  state.coll = null;
  state.watching = false;
  state.pollingShown = false;
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval);
    state.pollingInterval = null;
  }
  $('#polling-checkbox').checked = false;
  $('#workspace').classList.add('hidden');
  $('#placeholder').classList.remove('hidden');
  $('#live-badge').classList.add('hidden');
  $('#polling-toggle').classList.add('hidden');
  applyViewTabsFor(null); // le viste nascoste da un eventuale tab-database tornano visibili
  renderCollTabBar();
  markTreeSelection();
}

export function renderCollTabBar() {
  const bar = $('#coll-tab-bar');
  bar.innerHTML = '';
  const t = activeTab();
  const list = t && t.state.connected ? t.state.collTabs : [];
  bar.classList.toggle('hidden', !list.length);

  // La barra è un nodo PERSISTENTE: svuotarne l'innerHTML scarta i figli e i
  // loro listener, ma non quelli registrati sulla barra stessa. Questa funzione
  // viene richiamata a ogni apertura/chiusura/cambio di coll-tab e a ogni
  // renderWorkspace, quindi senza guardia si accumulavano centinaia di coppie
  // dragover/drop identiche sullo stesso nodo — tutte eseguite a ogni evento di
  // trascinamento, con le rispettive closure mai raccolte.
  if (!bar.dataset.wired) {
    bar.dataset.wired = '1';
    bar.addEventListener('dragover', (e) => e.stopPropagation());
    bar.addEventListener('drop', (e) => e.stopPropagation());
  }

  for (const ct of list) {
    const el = document.createElement('div');
    el.className = 'coll-tab' + (t && ct.id === t.state.activeCollId ? ' active' : '');
    el.title = ct.isDbTab
      ? `${ct.db} — solo Query & Aggregate (nessuna ${parolaColl()})`
      : `${ct.db} ▸ ${ct.coll}`;

    const name = document.createElement('span');
    name.textContent = ct.isDbTab ? `⚡ ${ct.db}` : ct.coll;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'coll-tab-close';
    close.title = 'Chiudi';
    close.textContent = '✕';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCollTab(ct.id);
    });

    el.addEventListener('click', () => switchCollTab(ct.id));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) closeCollTab(ct.id);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Il tab-database non ha una collection: split-view ed export/import,
      // che lavorano su una collection, non hanno bersaglio.
      showContextMenu(e.clientX, e.clientY, ct.isDbTab ? [
        { label: '✕ Chiudi tab', action: () => closeCollTab(ct.id) },
      ] : [
        { label: '🔲 Apri in Split-View (Affianca)', action: () => addOrSplitPane(null, 'right', { db: ct.db, coll: ct.coll, tabId: t.id }) },
        '---',
        ...exportImportMenuItems(ct.db, ct.coll),
        '---',
        { label: '✕ Chiudi tab', action: () => closeCollTab(ct.id) },
      ]);
    });

    makeDraggable(
      el,
      ct.id,
      (fromId, toId) => {
        if (reorderById(t.state.collTabs, fromId, toId)) renderCollTabBar();
      },
      // Il payload serve a trascinare la collection in un pannello affiancato:
      // un tab-database non ne ha una, quindi resta solo riordinabile.
      () => (ct.isDbTab ? null : { db: ct.db, coll: ct.coll, tabId: t.id, collTabId: ct.id })
    );

    el.append(name, close);
    bar.appendChild(el);
  }
}
