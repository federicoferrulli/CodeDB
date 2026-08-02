'use strict';

import { state } from './state.js';
import { activeTab } from './tabs.js';
import { $, dbTypeIcon, esc, refreshLucideIcons } from './utils.js';
import { renderDbTree, refreshDbTree, collWord } from './dbtree.js';
import { renderGrid, applyDbTypeToWorkspace, applyQueryPlaceholders } from './grid.js';
import { renderCollTabBar, applyViewTabsFor } from './colltabs.js';
import { deactivateSplitView, renderSplitView, discardSplitViewIfOrphan } from './splitview.js';
import { setView } from './main.js';

// Il DOM del workspace è unico e condiviso: al cambio tab viene ri-renderizzato
// dallo stato del tab attivo. Mentre un tab è attivo la verità per gli input è
// il DOM: lo snapshot nello stato avviene solo al momento di lasciare il tab.

// La Split-View stacca dal DOM tutti i figli di #workspace (toolbar e viste
// comprese) e li conserva finché non la si chiude: mentre è attiva gli id della
// toolbar NON esistono e ogni $('#…') qui dentro sarebbe null.
function splitDomDetached() {
  const ws = $('#workspace');
  return !!ws && ws.classList.contains('split-active');
}

export function saveWorkspaceInputs() {
  const tab = activeTab();
  if (!tab || !tab.state.connected) return;
  // Con la Split-View attiva gli input non sono nel DOM: lo snapshot del
  // coll-tab precedente è già stato preso quando si è passati all'area affiancata.
  if (splitDomDetached()) return;
  const s = tab.state;
  s.filter = $('#filter-input').value;
  s.sort = $('#sort-input').value;
  s.queryMode = $('#query-mode').value;
  s.pageSize = $('#page-size').value;
  s.infiniteScroll = $('#infinite-toggle').checked;
}

export function renderWorkspace() {
  const tab = activeTab();
  const connected = !!(tab && tab.state.connected);

  // Il tab che ospitava l'area affiancata è stato chiuso: lo stato dei pannelli
  // è orfano, va buttato (altrimenti resterebbe agganciato a sessioni morte).
  discardSplitViewIfOrphan();
  // La Split-View è del tab attivo solo se il suo coll-tab è quello attivo:
  // in ogni altro caso (cambio tab, chiusura, disconnessione) i figli di
  // #workspace vanno RIMESSI prima di toccarne gli id, altrimenti sono null.
  const splitCt = connected && tab.state.collTabs.find((c) => c.isSplitTab);
  const splitActive = !!(splitCt && splitCt.id === tab.state.activeCollId);
  if (!splitActive) deactivateSplitView();

  $('#welcome').classList.toggle('hidden', connected);
  $('#tab-body').classList.toggle('hidden', !connected);
  $('#disconnect-btn').classList.toggle('hidden', !connected);
  // Hamburger dei database (drawer mobile): ha senso solo con un tab connesso.
  $('#menu-dbs-btn').classList.toggle('hidden', !connected);
  $('#conn-info').classList.toggle('hidden', !connected);
  $('#conn-info').innerHTML = connected ? `${dbTypeIcon(state.dbType)} <span>${esc(state.connLabel)}</span>` : '';
  refreshLucideIcons($('#conn-info'));
  if (!connected) {
    $('#live-badge').classList.add('hidden');
    $('#polling-toggle').classList.add('hidden');
    return;
  }

  renderDbTree(state.databases);
  // Lo schema è cambiato mentre il tab era in background: ricarica il tree.
  if (state.schemaDirty) {
    state.schemaDirty = false;
    refreshDbTree();
  }
  renderCollTabBar();

  // Area Split-View attiva: la toolbar e le viste normali non sono nel DOM,
  // si ridisegnano i pannelli affiancati e si esce.
  if (splitActive) {
    renderSplitView();
    return;
  }

  applyDbTypeToWorkspace();
  $('#query-mode').value = state.queryMode || 'find';
  $('#filter-input').value = state.filter || '';
  $('#sort-input').value = state.sort || '';
  $('#page-size').value = state.pageSize || '50';
  $('#infinite-toggle').checked = !!state.infiniteScroll;
  applyQueryPlaceholders();

  $('#live-badge').classList.toggle('hidden', !state.watching);
  $('#polling-toggle').classList.toggle('hidden', !state.pollingShown);
  $('#polling-checkbox').checked = !!state.pollingInterval;

  // Tab a livello database (database senza collection): il workspace va
  // mostrato lo stesso, con la sola tab ⚡ Query & Aggregate.
  const activeCt = tab.state.collTabs.find((c) => c.id === tab.state.activeCollId);
  applyViewTabsFor(activeCt);
  if (activeCt && activeCt.isDbTab) {
    // Lo stato di norma è già quello lasciato da `activate()`, ma dopo un
    // ripristino di sessione questo render precede la prima attivazione: senza
    // il bersaglio la tab Query direbbe "nessun database selezionato".
    state.db = activeCt.db;
    state.coll = null;
    if (!state.queryDb) state.queryDb = activeCt.db;
    $('#breadcrumb').textContent = `${activeCt.db} ▸ (nessuna ${collWord()})`;
    $('#placeholder').classList.add('hidden');
    $('#workspace').classList.remove('hidden');
    setView('query');
    return;
  }

  if (state.db && state.coll) {
    $('#breadcrumb').textContent = `${state.db} ▸ ${state.coll}`;
    $('#placeholder').classList.add('hidden');
    $('#workspace').classList.remove('hidden');
    renderGrid(); // i dati sono già nello stato del tab: nessuna nuova query
    setView(state.view || 'data');
  } else {
    $('#workspace').classList.add('hidden');
    $('#placeholder').classList.remove('hidden');
  }
}
