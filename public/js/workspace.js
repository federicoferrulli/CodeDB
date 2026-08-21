'use strict';

import { state } from './state.js';
import { activeTab } from './tabs.js';
import { $, dbTypeIcon, esc, refreshLucideIcons } from './utils.js';
import { renderDbTree, refreshDbTree } from './dbtree.js';
import {
  renderGrid, runQuery, applyDbTypeToWorkspace, applyQueryPlaceholders,
  leggiStatoFiltro, applicaStatoFiltro,
} from './grid.js';
import {
  renderCollTabBar, applyViewTabsFor, currentCollTab, salvaSnapshotQuery, applicaSnapshotQuery,
} from './colltabs.js';
import { deactivateSplitView, renderSplitView, discardSplitViewIfOrphan } from './splitview.js';
import { setView } from './main.js';

// Il DOM del workspace è unico e condiviso: al cambio tab viene ri-renderizzato
// dallo stato del tab attivo. Mentre un tab è attivo la verità per gli input è
// il DOM: lo snapshot nello stato avviene solo al momento di lasciare il tab.

// La Split-View non stacca più i figli di #workspace (li nasconde il CSS),
// quindi gli id della toolbar esistono sempre. Resta però vero che i loro valori
// appartengono al coll-tab lasciato entrando nell'area affiancata: sovrascrivere
// lo snapshot con quelli significherebbe congelare il filtro di un altro
// momento.
function splitAttiva() {
  const ws = $('#workspace');
  return !!ws && ws.classList.contains('split-active');
}

export function saveWorkspaceInputs() {
  const tab = activeTab();
  if (!tab || !tab.state.connected) return;
  // Lo snapshot del coll-tab precedente è già stato preso quando si è passati
  // all'area affiancata: gli input a schermo ora non descrivono alcun coll-tab.
  if (splitAttiva()) return;
  // Il codice della tab ⚡ segue il coll-tab come già filtro e sort: questa è
  // la funzione che significa "sto lasciando questo tab", quindi è qui che va
  // conservato (`activate` non viene richiamata al cambio di tab di connessione).
  salvaSnapshotQuery(currentCollTab());
  const s = tab.state;
  const filtro = leggiStatoFiltro();
  s.filter = $('#filter-input').value;
  s.filterMode = filtro.modo;
  s.quickSearch = filtro.rapido;
  s.advancedCondition = filtro.condizione;
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
  // La Split-View è del tab attivo solo se il suo coll-tab è quello attivo: in
  // ogni altro caso (cambio tab, chiusura, disconnessione) i pannelli vanno
  // tolti di mezzo, altrimenti resterebbero a schermo sopra un'altra connessione.
  // Le aree affiancate possono essere più d'una: quella da disegnare è quella
  // del coll-tab ATTIVO, non la prima che si trova nell'elenco.
  const attivoCt = connected && tab.state.collTabs.find((c) => c.id === tab.state.activeCollId);
  const splitActive = !!(attivoCt && attivoCt.isSplitTab);
  if (!splitActive) deactivateSplitView();

  $('#welcome').classList.toggle('hidden', connected);
  $('#tab-body').classList.toggle('hidden', !connected);
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

  // Area Split-View attiva: si ridisegnano i pannelli affiancati e si esce
  // (toolbar e viste normali restano in pagina, nascoste dal CSS).
  if (splitActive) {
    renderSplitView();
    return;
  }

  // Cambio di TAB DI CONNESSIONE: `activate` non viene richiamata, quindi la
  // pulizia della vista ⚡ passa da qui. Senza, risultati, grafico, metriche e
  // pannello script di un server restavano a schermo sotto il nome di un altro.
  applicaSnapshotQuery(currentCollTab());

  applyDbTypeToWorkspace();
  $('#query-mode').value = 'find';
  applicaStatoFiltro({
    modo: state.filterMode || 'rapido',
    rapido: state.quickSearch != null ? state.quickSearch : (state.filter || ''),
    condizione: state.advancedCondition || '',
  });
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
    $('#placeholder').classList.add('hidden');
    $('#workspace').classList.remove('hidden');
    setView('query');
    return;
  }

  if (state.db && state.coll) {
    $('#placeholder').classList.add('hidden');
    $('#workspace').classList.remove('hidden');
    if (state.dataDirty || (activeCt && activeCt.dataDirty)) {
      // Un change stream può aver segnalato modifiche mentre questa connessione
      // era in background: non mostrare come aggiornati i documenti in cache.
      // I marker vengono consumati da grid.runQuery solo dopo una risposta
      // valida; se la lettura fallisce devono provocare un nuovo tentativo.
      runQuery({ auto: true });
    } else {
      renderGrid(); // i dati sono già nello stato del tab: nessuna nuova query
    }
    setView(state.view || 'data');
  } else {
    $('#workspace').classList.add('hidden');
    $('#placeholder').classList.remove('hidden');
  }
}
