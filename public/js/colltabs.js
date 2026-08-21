'use strict';

import { state } from './state.js';
import { activeTab } from './tabs.js';
import { $, emitFireAndForget, showContextMenu, makeDraggable, reorderById, safeUUID, isSqlType } from './utils.js';
import { exportImportMenuItems } from './exportimport.js';
import {
  runQuery, renderGrid, applyQueryPlaceholders, leggiStatoFiltro, applicaStatoFiltro,
} from './grid.js';
import { startWatch } from './live.js';
import { setView } from './main.js';
import { addOrSplitPane, renderSplitView, deactivateSplitView, closeSplitView, pareggiaPannelli, chiediNomeAreaSplit, chiudiPaneDove, aggiornaPaneDove } from './splitview.js';
import { markAbandonedByCollTab } from './pending-queries.js';
import { resetQueryView, updateEditorHighlight } from './query-tab.js';
import { chiudiPannelloFk } from './fk-vista.js';
import { segnaTraguardo } from './onboarding-stato.js';

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
//
// Con la Split-View attiva compare invece la tab "🔲 Affiancati": le altre
// restano cliccabili e agiscono sul pannello a fuoco (vedi `setView`). Prima il
// workspace veniva staccato dal DOM insieme alle sue tab, quindi per aprire
// Dettagli o Query & Aggregate bisognava chiudere l'area affiancata.
export function applyViewTabsFor(ct) {
  const soloQuery = !!(ct && ct.isDbTab);
  const split = !!(ct && ct.isSplitTab);
  document.querySelectorAll('.view-tab').forEach((el) => {
    const vista = el.dataset.view;
    if (vista === 'split') { el.classList.toggle('hidden', !split); return; }
    // In Split-View i pannelli SONO la vista dati: "Dati" mostrerebbe la griglia
    // singola con i risultati di prima, cioè dati vecchi sotto un'altra
    // etichetta. Al suo posto c'è "Affiancati".
    if (vista === 'data' && split) { el.classList.add('hidden'); return; }
    el.classList.toggle('hidden', soloQuery && vista !== 'query');
  });
}

// Righe conservate nello snapshot di un coll-tab in secondo piano (CDB-62).
//
// Lo snapshot serve a far ricomparire la vista com'era senza rifare la query:
// per questo conserva anche i risultati. Il costo però si moltiplica per il
// numero di tab aperti — dieci coll-tab con lo scroll infinito su documenti
// grandi tengono in memoria decine di migliaia di righe che nessuno sta
// guardando, e il browser rallenta senza una causa visibile. Oltre la soglia si
// conserva l'inizio (quello che si vede riattivando il tab) e si segna che
// mancano le altre: alla riattivazione `ensureActiveCollLoaded` rifà la query,
// cioè esattamente ciò che accade dopo un refresh della pagina.
const MAX_DOCS_SNAPSHOT = 500;

/**
 * Conserva il CODICE della tab ⚡ per il coll-tab indicato.
 *
 * Sta a parte da `saveActiveSnapshot` perché quello esce subito per i tab
 * split e per i tab a livello database — mentre il codice dell'editor ha senso
 * proprio anche lì: il tab-database è il coll-tab nato per la sola vista Query,
 * ed è quello in cui si scrive la prima CREATE TABLE.
 *
 * Il resto della vista (risultati, grafico, metriche, pannello script) NON si
 * conserva: descrive un'esecuzione, e un'esecuzione appartiene al momento in
 * cui è avvenuta. Il codice invece è lavoro dell'utente.
 */
export function salvaSnapshotQuery(ct) {
  if (!ct) return;
  const editor = $('#query-editor-input');
  if (!editor) return; // pagina non ancora montata
  ct.snapQuery = {
    code: editor.value || '',
    engine: $('#query-target-engine')?.value || 'auto',
  };
}

/** Vista ⚡ pulita e codice del coll-tab ripristinato (o editor vuoto). */
export function applicaSnapshotQuery(ct) {
  resetQueryView();
  const editor = $('#query-editor-input');
  if (!editor) return;
  const q = (ct && ct.snapQuery) || null;
  editor.value = q ? (q.code || '') : '';
  const engine = $('#query-target-engine');
  if (engine) engine.value = q ? (q.engine || 'auto') : 'auto';
  // Ridisegna evidenziazione, numeri di riga ed etichetta "Esegui Script (N)".
  updateEditorHighlight();
}

function saveActiveSnapshot() {
  const ct = currentCollTab();
  salvaSnapshotQuery(ct);
  if (!ct || ct.isSplitTab || ct.isDbTab) return;
  const docs = Array.isArray(state.docs) ? state.docs : [];
  const troppi = docs.length > MAX_DOCS_SNAPSHOT;
  const filtro = leggiStatoFiltro();
  ct.snap = {
    filter: $('#filter-input')?.value || '',
    filterMode: filtro.modo,
    quickSearch: filtro.rapido,
    advancedCondition: filtro.condizione,
    sort: $('#sort-input')?.value || '',
    queryMode: $('#query-mode')?.value || 'find',
    pageSize: $('#page-size')?.value || '50',
    infiniteScroll: state.infiniteScroll,
    skip: state.skip,
    limit: state.limit,
    total: state.total,
    docs: troppi ? docs.slice(0, MAX_DOCS_SNAPSHOT) : docs,
    docsParziali: troppi,
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
  // Il pannello di riferimento è ancorato a una cella di QUESTA griglia: dopo
  // il cambio di scheda parlerebbe di una tabella che non è più sotto.
  chiudiPannelloFk();

  if (ct.isSplitTab) {
    renderCollTabBar();
    markTreeSelection();
    applyViewTabsFor(ct);
    renderSplitView();
    // La vista attiva è "Affiancati": senza, tornando sul tab della Split-View
    // resterebbe evidenziata la tab della vista di prima.
    setView('split');
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
    $('#placeholder').classList.add('hidden');
    $('#workspace').classList.remove('hidden');
    renderCollTabBar();
    markTreeSelection();
    applyViewTabsFor(ct);
    applicaSnapshotQuery(ct);
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
  // Stesso principio, applicato al resto della vista ⚡: risultati, grafico,
  // metriche, box errore, riga rossa nel gutter e pannello script descrivono
  // un'esecuzione fatta sulla collection che si sta lasciando. Il codice
  // dell'editor invece è lavoro dell'utente e viene ripristinato da qui.
  applicaSnapshotQuery(ct);
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
  const datiSporchi = !!ct.dataDirty;
  // Input da ripristinare dopo un refresh (una tantum): presenti solo finché il
  // coll-tab non ha ancora uno snapshot proprio (vedi session-restore.js).
  const r = (!s && ct.restore) ? ct.restore : null;
  const sorgenteFiltro = s || r || {};
  applicaStatoFiltro({
    modo: sorgenteFiltro.filterMode || 'rapido',
    rapido: sorgenteFiltro.quickSearch != null
      ? sorgenteFiltro.quickSearch
      : (sorgenteFiltro.filter || ''),
    condizione: sorgenteFiltro.advancedCondition || '',
  });
  $('#sort-input').value = s ? s.sort : (r ? (r.sort || '') : '');
  $('#query-mode').value = 'find';
  if (s) $('#page-size').value = s.pageSize;
  else if (r && r.pageSize) $('#page-size').value = r.pageSize;
  state.infiniteScroll = s ? !!s.infiniteScroll : (r ? !!r.infiniteScroll : false);
  $('#infinite-toggle').checked = state.infiniteScroll;
  applyQueryPlaceholders();

  $('#placeholder').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  renderCollTabBar();
  markTreeSelection();

  if (fresh || !s || datiSporchi) {
    state.skip = 0;
    state.docs = [];
    state.columns = [];
    state.total = 0;
    setView(r && r.view ? r.view : 'data');
    // La riesecuzione della query in fase di ripristino (r) è automatica, non
    // un'azione dell'utente: marcata `auto` così l'audit non la registra
    // (coerente con polling/refresh post-scrittura). L'apertura "vera" di una
    // collection (r assente) resta invece tracciata come lettura utente.
    runQuery((r || datiSporchi) ? { auto: true } : undefined);
    if (r) ct.restore = null; // input ripristinati: da qui in poi vale lo snapshot
  } else if (s.docsParziali) {
    // Snapshot alleggerito (CDB-62): i risultati completi non sono stati
    // conservati, quindi si rifà la query invece di mostrarne una parte
    // spacciandola per tutta. È automatica, non un'azione dell'utente.
    state.skip = s.skip;
    state.limit = s.limit;
    state.total = s.total;
    state.docs = [];
    state.columns = s.columns;
    setView(s.view || 'data');
    runQuery({ auto: true });
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

// Anteprima (stile VS Code): un clic sulla collection nella sidebar la apre in
// un coll-tab PROVVISORIO, che il clic successivo su un'altra collection
// rimpiazza invece di affiancare — esplorare un database con venti tabelle non
// deve lasciare venti tab aperti. Il doppio clic (sulla sidebar o sul tab) lo
// fissa; lo fissano anche il trascinamento e qualunque modifica agli input di
// query, perché quel lavoro non deve poter sparire al clic successivo.
// Il tab in anteprima è al massimo UNO per tab di connessione.
export function pinCollTab(id, { render = true } = {}) {
  const t = activeTab();
  if (!t) return;
  const ct = t.state.collTabs.find((c) => c.id === id);
  if (!ct || !ct.preview) return;
  ct.preview = false;
  if (render) renderCollTabBar();
}

// Fissa il coll-tab attivo: lo chiamano le azioni che significano "sto
// lavorando qui" (modifica di filtro/ordinamento) da moduli che non conoscono
// gli id dei coll-tab.
export function pinActiveCollTab() {
  const t = activeTab();
  if (t && t.state.activeCollId) pinCollTab(t.state.activeCollId);
}

export function openCollTab(db, coll, { preview = false } = {}) {
  const t = activeTab();
  if (!t || !t.state.connected) return;
  segnaTraguardo('tabella'); // primi passi della guida (no-op se già fatto)
  saveActiveSnapshot();
  let ct = t.state.collTabs.find((c) => c.db === db && c.coll === coll && !c.isSplitTab);
  if (ct) {
    // Riapertura: il doppio clic fissa un tab già in anteprima, mentre il clic
    // singolo non declassa mai un tab già fissato.
    if (!preview) ct.preview = false;
    if (ct.id !== t.state.activeCollId) activate(ct, { fresh: false });
    else renderCollTabBar();
    return;
  }
  ct = { id: safeUUID(), db, coll, snap: null, preview };
  const i = preview ? t.state.collTabs.findIndex((c) => c.preview) : -1;
  if (i >= 0) {
    // Il nuovo tab prende il posto di quello in anteprima, nella stessa
    // posizione della barra: le query in sospeso del vecchio non hanno più un
    // tab a cui tornare.
    markAbandonedByCollTab(t.state.collTabs[i].id);
    t.state.collTabs.splice(i, 1, ct);
  } else {
    t.state.collTabs.push(ct);
  }
  activate(ct, { fresh: true });
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
    // Con più aree affiancate aperte va chiusa PROPRIO questa, che non è
    // necessariamente quella a schermo.
    closeSplitView({ collTabId: id });
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
  // I PANNELLI delle aree affiancate vanno chiusi a parte: il predicato guarda
  // `db`/`coll` del coll-tab, e per un'area valgono 'Split-View' — quindi non
  // corrispondeva mai e restavano riquadri puntati su un database eliminato.
  chiudiPaneDove(pred, st || (t ? t.state : null));
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
  // …e ai pannelli affiancati, per la stessa ragione: senza, dopo una rinomina
  // continuavano a interrogare il vecchio nome.
  aggiornaPaneDove(fn, st || (t ? t.state : null));
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

  // Il coll-tab È la breadcrumb (quella sotto la barra è stata rimossa: ripeteva
  // un contesto già evidenziato qui e nell'albero a sinistra). Il nome del
  // database compare però come prefisso attenuato SOLO quando i tab aperti
  // vengono da più database: con uno solo sarebbe la stessa parola ripetuta su
  // ogni tab, cioè rumore che ruba spazio ai nomi delle tabelle. Il contesto
  // completo resta sempre nel `title` al passaggio del mouse.
  const dbAperti = new Set(list.filter((c) => !c.isSplitTab).map((c) => c.db));
  const mostraDb = dbAperti.size > 1;

  for (const ct of list) {
    const el = document.createElement('div');
    el.className = 'coll-tab' + (t && ct.id === t.state.activeCollId ? ' active' : '') + (ct.preview ? ' preview' : '');
    el.title = (ct.isDbTab
      ? `${ct.db} — solo Query & Aggregate (nessuna ${parolaColl()})`
      : ct.isSplitTab
        // "Split-View ▸ 🔲 ordini + clienti" ripeterebbe due volte la stessa
        // cosa: qui il contesto utile è che è un'area, e cosa contiene.
        ? `Area affiancata: ${ct.coll}\nTasto destro per rinominarla`
        : `${ct.db} ▸ ${ct.coll}`)
      + (ct.preview ? '\nAnteprima: doppio clic per fissare il tab' : '');

    // Il tab-database mostra già il proprio database, quello di split-view non
    // ne ha uno solo: il prefisso riguarda i coll-tab normali.
    let dbEl = null;
    if (mostraDb && !ct.isDbTab && !ct.isSplitTab) {
      dbEl = document.createElement('span');
      dbEl.className = 'coll-tab-db';
      dbEl.textContent = `${ct.db} ▸`;
    }

    const name = document.createElement('span');
    name.className = 'coll-tab-name';
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
    el.addEventListener('dblclick', () => pinCollTab(ct.id));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) closeCollTab(ct.id);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Il tab-database non ha una collection: split-view ed export/import,
      // che lavorano su una collection, non hanno bersaglio.
      // Il tab dell'area affiancata non è una collection: le voci che lavorano
      // su una (split-view, export/import) puntavano al database inventato
      // "Split-View", cioè a nulla.
      showContextMenu(e.clientX, e.clientY, ct.isSplitTab ? [
        { label: '✏️ Rinomina area…', action: () => chiediNomeAreaSplit(ct.id) },
        { label: '⌗ Pareggia i pannelli', action: () => pareggiaPannelli(null, ct.id) },
        '---',
        { label: '✕ Chiudi Split-View', action: () => closeCollTab(ct.id) },
      ] : ct.isDbTab ? [
        { label: '✕ Chiudi tab', action: () => closeCollTab(ct.id) },
      ] : [
        { label: '🔲 Apri in Split-View (Affianca)', action: () => addOrSplitPane(null, 'right', { db: ct.db, coll: ct.coll, tabId: t.id }) },
        { label: '🔲 Affianca in una NUOVA area', action: () => addOrSplitPane(null, 'right', { db: ct.db, coll: ct.coll, tabId: t.id }, { nuovaArea: true }) },
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
      () => {
        // Trascinare un tab è già un modo di dire "questo lo tengo": lo fissa,
        // senza ridisegnare la barra (siamo dentro il dragstart, ricostruire i
        // nodi ora annullerebbe il trascinamento in corso).
        pinCollTab(ct.id, { render: false });
        // …e nemmeno il tab dell'area affiancata: il suo payload avrebbe creato
        // un pannello puntato su un database inesistente.
        return (ct.isDbTab || ct.isSplitTab) ? null : { db: ct.db, coll: ct.coll, tabId: t.id, collTabId: ct.id };
      }
    );

    if (dbEl) el.append(dbEl);
    el.append(name, close);
    bar.appendChild(el);
  }
}
