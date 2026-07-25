'use strict';

import { state } from './state.js';
import { activeTab } from './tabs.js';
import { $, notify, showContextMenu, makeDraggable, reorderById } from './utils.js';
import { exportImportMenuItems } from './exportimport.js';
import { runQuery, renderGrid, applyQueryPlaceholders } from './grid.js';
import { startWatch } from './live.js';
import { setView } from './main.js';

// Tab di secondo livello: le collection/tabelle aperte dentro un tab di
// connessione (t.state.collTabs). Ogni coll-tab ha uno snapshot di query,
// risultati e vista, ripristinato quando lo si riattiva; mentre è attivo la
// verità è il DOM/stato piatto, lo snapshot si aggiorna al cambio.

function currentCollTab() {
  const t = activeTab();
  return t ? t.state.collTabs.find((c) => c.id === t.state.activeCollId) : null;
}

function saveActiveSnapshot() {
  const ct = currentCollTab();
  if (!ct) return;
  ct.snap = {
    filter: $('#filter-input').value,
    sort: $('#sort-input').value,
    queryMode: $('#query-mode').value,
    pageSize: $('#page-size').value,
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
  state.db = ct.db;
  state.coll = ct.coll;
  state.watching = false;
  // La selezione bulk è legata alla pagina corrente: un _id (es. PK intera
  // MySQL) potrebbe coincidere tra tabelle diverse, quindi si azzera.
  state.selectedDocs.clear();
  // Lo scroll infinito riparte pulito sulla collection attivata.
  state.loading = false;
  state.exhausted = false;
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
  let ct = t.state.collTabs.find((c) => c.db === db && c.coll === coll);
  if (!ct) {
    ct = { id: crypto.randomUUID(), db, coll, snap: null };
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
  const t = activeTab();
  if (!t) return;
  const list = t.state.collTabs;
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return;
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
export function closeCollTabsWhere(pred) {
  const t = activeTab();
  if (!t) return;
  for (const id of t.state.collTabs.filter(pred).map((c) => c.id)) closeCollTab(id);
}

// Applica una modifica a tutti i coll-tab (es. rename di db/collection).
export function updateCollTabs(fn) {
  const t = activeTab();
  if (!t) return;
  t.state.collTabs.forEach(fn);
  renderCollTabBar();
}

// Nessuna collection aperta: torna al placeholder del workspace.
function clearCollWorkspace() {
  const t = activeTab();
  if (t) t.state.activeCollId = null;
  notify('collection:unwatch');
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
  renderCollTabBar();
  markTreeSelection();
}

export function renderCollTabBar() {
  const bar = $('#coll-tab-bar');
  bar.innerHTML = '';
  const t = activeTab();
  const list = t && t.state.connected ? t.state.collTabs : [];
  bar.classList.toggle('hidden', !list.length);

  for (const ct of list) {
    const el = document.createElement('div');
    el.className = 'coll-tab' + (t && ct.id === t.state.activeCollId ? ' active' : '');
    el.title = `${ct.db} ▸ ${ct.coll}`;

    const name = document.createElement('span');
    name.textContent = ct.coll;

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
      showContextMenu(e.clientX, e.clientY, [
        ...exportImportMenuItems(ct.db, ct.coll),
        '---',
        { label: '✕ Chiudi tab', action: () => closeCollTab(ct.id) },
      ]);
    });

    makeDraggable(el, ct.id, (fromId, toId) => {
      if (reorderById(t.state.collTabs, fromId, toId)) renderCollTabBar();
    });

    el.append(name, close);
    bar.appendChild(el);
  }
}
