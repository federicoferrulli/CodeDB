import { state } from './state.js';
import { $, emit, displayValue, displayValueBreve, idOf, toast, showQueryError, isSqlType, buildJsonNode, showSkeletonGrid, isForActiveTab, captureContext, marcaDatiSporchi, emitFireAndForget, eseguiAOndate, initToolbarDropdown, conCaricamento, refreshLucideIcons } from './utils.js';
import { openCollTab, pinActiveCollTab } from './colltabs.js';
import { startEdit } from './inlineEdit.js';
import { attachAutocomplete } from './autocomplete.js';
import { applyCellSelection, clearCellSelection } from './cellselect.js';
import { recordQuery, initQueryHistory } from './queryhistory.js';
import { VINCOLO } from './fk-relazioni.js';
import { relazioniPer, caricaRelazioni as caricaRelazioniCache, svuotaRelazioni } from './fk-cache.js';
import { rendiCellaGeometrica, aperturaCella } from './cella-geometria.js';
import { activeTab } from './tabs.js';
// Le due modalità della casella del filtro: rapida (cerca in tutte le
// colonne) e condizione (WHERE/MQL scritti a mano). Vedi filtro-rapido.js.
import { MODI, payloadFiltro } from './filtro-rapido.js';
// Il modulo unico della griglia: quali righe stanno nella finestra visibile,
// come si scrive il corpo della tabella, e che cosa questa griglia sa fare.
// Il disegno della singola riga resta qui, perche' e' cio' che cambia fra le
// tre viste (vedi la nota in testa a griglia.js).
import {
  capacita, finestraVirtuale, vaVirtualizzata, disegnaCorpo, scorrimentoPerRiga,
  SOGLIA_VIRTUALE,
} from './griglia.js';

export function applyDbTypeToWorkspace() {
  const isSql = isSqlType(state.dbType);
  $('#uml-hint').innerHTML = isSql
    ? 'Relazioni dalle <b>foreign key</b> dichiarate, più quelle dedotte dai nomi delle colonne (es. <code>user_id</code> → tabella <code>users</code>).'
    : 'Associazioni dedotte dai nomi dei campi (es. <code>user_id</code> → collection <code>users</code>) e dai tipi ObjectId su un campione di documenti.';
  applyQueryPlaceholders();
}

export function applyQueryPlaceholders() {
  const isSql = isSqlType(state.dbType);
  const rapido = modoFiltro() === 'rapido';
  $('#filter-input').placeholder = rapido
    ? MODI.rapido.segnaposto
    : (isSql ? 'Condizione WHERE, es. age > 30' : 'Documento MQL, es. { "age": { "$gt": 30 } }');
  $('#filter-input').setAttribute('aria-label', rapido
    ? 'Testo da cercare in tutti i campi rilevati'
    : (isSql ? 'Condizione WHERE' : 'Documento filtro MQL'));
  $('#sort-input').placeholder = isSql
    ? 'Ordinamento, es. name ASC oppure {"name":1}'
    : 'Sort, es. { "name": 1 }';
  $('#sort-input').classList.remove('hidden');
}

// La vista Dati esegue una sola lettura tabellare. Pipeline e SQL Raw vivono
// nell'editor Query & Aggregate; `find` resta un dettaglio del protocollo.
function modoEffettivo() {
  return 'find';
}

function sortCorrente() {
  return $('#sort-input').value;
}

// Apre la collection in un coll-tab (o attiva quello già aperto).
// `preview: true` = coll-tab provvisorio (un clic nella sidebar), rimpiazzato
// dalla prossima anteprima finché non lo si fissa; vedi colltabs.js.
export function selectCollection(dbName, collName, opts = {}) {
  openCollTab(dbName, collName, opts);
}

/* --------------------- Relazioni (chiavi esterne) ------------------------- *
 * Quali colonne della tabella aperta puntano a un'altra tabella: serve alla
 * griglia per marcare le celle collegate (🔗) e all'editor inline per offrire
 * il pannello di riferimento.
 *
 * La cache sta QUI, in una Map di modulo, e non nello stato del tab. Due
 * motivi. Primo: `buildRow` deve interrogarla in modo SINCRONO mentre costruisce
 * le righe visibili, quindi non può essere una promessa. Secondo: le chiavi
 * esterne di `shop.ordini` non cambiano perché si è passati a un altro tab, e
 * tenendole nello stato andrebbero ricaricate a ogni cambio di coll-tab e
 * ripulite a mano a ogni cambio di collection — due occasioni per lasciarsi
 * dietro le relazioni della tabella sbagliata, che è esattamente il modo di
 * accendere il 🔗 su una colonna che non c'entra nulla.
 * ------------------------------------------------------------------------- */

function contestoRelazioni(st = state, tabId = activeTab()?.id) {
  return { tabId, dbType: st.dbType, db: st.db, coll: st.coll };
}

/** Map campo → relazione per la collection mostrata ora, o null. */
export function relazioniCorrenti() {
  return relazioniPer(contestoRelazioni());
}

/** Relazione di un singolo campo della collection corrente, o null. */
export function relazioneDiCampo(campo) {
  const rel = relazioniCorrenti();
  return (rel && rel.get(campo)) || null;
}

/**
 * Svuota la cache: le chiavi esterne sono metadati di schema, quindi una DDL
 * (colonna aggiunta, vincolo creato o eliminato) le rende obsolete. Senza,
 * l'indicatore resterebbe acceso su una colonna il cui vincolo non c'è più
 * fino al prossimo ricaricamento della pagina.
 */
export { svuotaRelazioni };

// Chiede le relazioni della collection appena caricata, una volta sola. Il
// fallimento è silenzioso di proposito: senza relazioni la griglia funziona
// esattamente come prima, e un errore su una lettura di metadati non deve
// coprire i dati che l'utente ha appena chiesto.
function caricaRelazioni(st, originColl, originTabId) {
  const contesto = contestoRelazioni(st, originTabId);
  if (relazioniPer(contesto) !== null) return;
  caricaRelazioniCache(contesto)
    .then((indice) => {
      if (!indice.size) return; // niente da marcare: nessun ridisegno
      // Ridisegna solo se, nel frattempo, si guarda ancora quella collection.
      const ancoraCorrente = state.activeCollId === originColl
        && relazioniPer(contestoRelazioni()) === indice;
      if (activeTab()?.id === originTabId && ancoraCorrente) {
        renderGrid({ preserveScroll: true });
      }
    })
    .catch(() => { /* nessuna relazione: la griglia resta quella di prima */ });
}

// opts.auto = lettura automatica (polling, live change stream, refresh dopo una
// scrittura): marcata `_bg` così l'audit del server la ignora e non intasa lo
// storico con le riletture non avviate dall'utente.
export function runQuery(opts = {}) {
  if (!state.db || !state.coll) return;
  showQueryError(null);
  const mode = modoEffettivo();

  // Single-flight: annulla la find/aggregate precedente ancora in volo per
  // questo tab prima di lanciarne un'altra. Cambiare pagina in fretta non
  // accumula più query pesanti che saturano il pool: la vecchia lettura viene
  // fermata lato server (killOp / KILL QUERY / pg_cancel_backend).
  cancelInFlightFind();
  const runId = (state.gridRunId = newRunId());
  // Una nuova combinazione di filtro/ordinamento rende obsoleto anche il count
  // disaccoppiato precedente, che altrimenti può aggiornare il footer mentre la
  // nuova find è ancora in volo. La paginazione mantiene invece lo stesso count.
  if (!opts.keepCount) {
    state.countToken = (state.countToken || 0) + 1;
    state.countPending = false;
  }
  // Coll-tab di origine: il `runId` da solo non basta a proteggere la risposta.
  // Passando a un altro coll-tab lo stato piatto (docs/columns/skip) viene
  // riusato per la nuova collection, quindi una risposta in ritardo scriverebbe
  // i documenti della collection precedente sotto le colonne di quella nuova.
  const originColl = state.activeCollId;

  const payload = {
    db: state.db,
    coll: state.coll,
    ...filtroCorrente(),
    sort: sortCorrente(),
    limit: $('#page-size').value,
    skip: state.skip,
    // Conteggio disaccoppiato: la find torna subito coi soli documenti (su
    // collection enormi il conteggio esatto è una scansione che bloccherebbe
    // la griglia); il totale arriva dopo via `collection:count`.
    deferCount: true,
    // Keyset (seek) pagination: con ordinamento di default paginiamo per
    // chiave (pk/_id) invece che per OFFSET, così le pagine profonde sono
    // veloci. Il server ricade su OFFSET (usa `skip`) quando non applicabile.
    keyset: keysetDescriptor(opts),
    runId,
  };
  if (opts.auto) payload._bg = true;

  // Storico query: registra ciò che l'utente sta eseguendo (best-effort,
  // anche se poi il server risponde con errore la voce resta utile).
  recordQuery({
    mode,
    filterMode: modoFiltro(),
    filter: $('#filter-input').value.trim(),
    sort: sortCorrente().trim(),
  });

  if (!opts.auto) {
    showSkeletonGrid('#grid');
  }

  emit('collection:find', payload).then((res) => {
    // `st` = stato del tab CHE HA FATTO la richiesta, non di quello attivo ora
    // (vedi emit in utils.js): scrivere sul Proxy `state` significherebbe
    // riversare i risultati di questo tab in un altro.
    const st = res._state;
    // Risposta di una find superata da una più recente (o annullata): scartala,
    // così un cambio pagina veloce non fa "tornare indietro" la griglia.
    if (runId !== st.gridRunId) return;
    // Risposta che appartiene a un coll-tab non più mostrato: lo stato piatto
    // ora descrive un'altra collection, applicarla la corromperebbe.
    if (st.activeCollId !== originColl) return;
    // Una lettura valida è il solo momento in cui il marker può essere
    // consumato: azzerarlo prima della richiesta farebbe perdere il retry se il
    // database risponde con errore o timeout.
    st.dataDirty = false;
    const originCt = st.collTabs.find((ct) => ct.id === originColl);
    if (originCt) originCt.dataDirty = false;
    st.docs = res.docs;
    st.columns = res.columns;
    st.skip = res.skip;
    st.limit = res.limit;
    // Il server ha interrotto la lettura per non esaurire la memoria (poche
    // righe molto grandi): dirlo, invece di far credere che siano tutte.
    if (res.truncated && isForActiveTab(res)) {
      toast(`Risultati troncati: la pagina supera il limite di memoria del server. Usa una proiezione o riduci la dimensione pagina.`, true);
    }

    // Riuso del conteggio in paginazione: cambiare pagina non cambia il totale
    // (dipende solo da db/coll/filtro). Ricontare a ogni pagina su collection/
    // tabelle enormi è una scansione (COUNT(*)/countDocuments) che, ripetuta,
    // satura il pool di connessioni e lascia la find in attesa "per sempre".
    // La paginazione (prev/next) passa `keepCount`; ogni altra esecuzione
    // (run/refresh/sort/filtro) ricontrolla come prima.
    const key = countKeyFor(payload);
    const reuseCount = mode !== 'aggregate' && opts.keepCount && key === st.countKey;
    if (!reuseCount) {
      st.total = res.total;   // può essere null: conteggio in corso (vedi sotto)
      // Totale inline già noto (es. Mongo senza filtro): memorizza la firma così
      // la paginazione successiva lo riusa senza un nuovo conteggio.
      if (mode !== 'aggregate' && res.total != null) {
        st.countKey = key;
        st.countTimedOut = false;
        st.countApprox = !!res.approx; // stima dai metadati → footer con "≈"
      }
    }
    // Scroll infinito: dopo il primo blocco stabilisce se c'è altro da caricare.
    st.exhausted = computeExhausted({ docs: res.docs, limit: res.limit, total: st.total }, st);
    // Mantiene selezionati solo i documenti ancora presenti nella pagina:
    // la selezione sopravvive ai refresh (live/polling) ma si svuota al
    // cambio di pagina o di filtro.
    const visible = new Set(res.docs.filter((d) => '_id' in d).map(idOf));
    for (const id of [...st.selectedDocs]) {
      if (!visible.has(id)) st.selectedDocs.delete(id);
    }
    // Il workspace è un DOM unico condiviso: si ridipinge solo se questo tab è
    // ancora quello in primo piano. Altrimenti i dati restano nel suo stato e
    // compariranno quando l'utente ci tornerà.
    if (isForActiveTab(res)) renderGrid();
    // Chiavi esterne della tabella appena letta: dopo i dati, mai prima. È una
    // lettura di metadati che non deve ritardare di un istante la griglia.
    caricaRelazioni(st, originColl, res._tab ? res._tab.id : undefined);
    // Totale sconosciuto (find con filtro su collection grande): lo chiediamo a
    // parte, così la griglia è già utilizzabile mentre il conteggio gira. In
    // paginazione con totale già noto (reuseCount) non ripetiamo la scansione.
    if (mode !== 'aggregate' && !reuseCount && res.total == null) {
      requestTotalCount(payload, st, originColl, res._tab ? res._tab.id : undefined);
    }
  }).catch((err) => {
    // Errore di una find annullata/superata: non disturbare l'utente, la
    // richiesta più recente sta già gestendo la vista.
    const st = (err && err._state) || state;
    if (runId !== st.gridRunId || st.activeCollId !== originColl) return;
    if (isForActiveTab(err)) {
      // Una richiesta esplicita fallita non deve lasciare a schermo le righe
      // della query precedente: sembrerebbero risultati del nuovo filtro.
      // I refresh automatici conservano invece l'ultima vista valida.
      if (!opts.auto) {
        st.docs = [];
        st.total = 0;
        st.countPending = false;
        st.selectedDocs.clear();
        renderGrid();
        updateFooter();
      }
      showQueryError(err.message);
    }
  });
}

// Firma della combinazione che determina il totale: pagina e ordinamento non
// la influenzano, solo database, collection/tabella e filtro.
function countKeyFor(p) {
  return `${p.db}\u0000${p.coll}\u0000${p.filter || ''}`
    + `\u0000${JSON.stringify(p.filtro || null)}\u0000${JSON.stringify(p.cercaOvunque || null)}`;
}

// Il totale è "esatto" solo se noto e NON stimato dai metadati: solo un totale
// esatto può decidere la fine dei dati o disabilitare "avanti". Una stima serve
// solo a mostrare l'ordine di grandezza nel footer.
// `st` esplicito per i callback asincroni, che devono ragionare sullo stato del
// proprio tab e non su quello attivo (vedi emit/_state in utils.js).
function hasExactTotal(st = state) {
  return st.total != null && !st.countApprox;
}

// Identificatore univoco di una find/aggregate della griglia, usato per il
// single-flight (superamento) e per l'annullamento lato server via query:cancel.
let _gridRunSeq = 0;
function newRunId() {
  return `grid-${Date.now().toString(36)}-${++_gridRunSeq}`;
}

// Annulla la find/aggregate corrente ancora in volo (se presente) e ne dimentica
// il runId. Fire-and-forget: il server ferma la lettura (killOp/KILL QUERY/
// pg_cancel_backend) e la sua eventuale risposta viene scartata dalla guardia
// sul runId.
function cancelInFlightFind() {
  const prev = state.gridRunId;
  state.gridRunId = null;
  // `_bg`: housekeeping del single-flight, escluso dall'audit dello Storico Azioni.
  if (prev) emitFireAndForget('query:cancel', { runId: prev, _bg: true });
}

// _id (stringa EJSON) della prima/ultima riga con _id nella pagina corrente,
// usato come cursore keyset per prev/next/refresh.
function firstRowId() {
  const d = state.docs.find((x) => x && '_id' in x);
  return d ? idOf(d) : null;
}
function lastRowId() {
  for (let i = state.docs.length - 1; i >= 0; i--) {
    if (state.docs[i] && '_id' in state.docs[i]) return idOf(state.docs[i]);
  }
  return null;
}

// Descrittore del cursore keyset per il server, in base alla direzione della
// navigazione. `null` con ordinamento personalizzato → il server usa OFFSET.
// `{after}`/`{before}` = pagina succ./prec.; `{from}` = refresh in place a
// partire (incluso) dal primo _id mostrato; `{first}` = prima pagina.
function keysetDescriptor(opts) {
  if ($('#sort-input').value.trim()) return null; // sort personalizzato → OFFSET
  if (opts.pageDir === 'next') { const l = lastRowId(); return l != null ? { after: l } : { first: true }; }
  if (opts.pageDir === 'prev') { const f = firstRowId(); return f != null ? { before: f } : { first: true }; }
  if (opts.auto || opts.refresh) { const f = firstRowId(); return f != null ? { from: f } : { first: true }; }
  return { first: true }; // esecuzione fresca (run/filtro/sort/page-size) → prima pagina
}

// Fine dei dati raggiunta? Con totale noto ci si ferma quando i documenti
// caricati lo raggiungono; con totale sconosciuto (conteggio disaccoppiato in
// corso) ci si basa sul blocco: se non è pieno non c'è altro da caricare.
function computeExhausted(res, st = state) {
  if (!res.docs.length) return true;
  if (res.docs.length < (res.limit || st.limit)) return true;
  // Solo un totale ESATTO chiude i dati: una stima dai metadati potrebbe essere
  // inferiore al reale e nasconderebbe righe non ancora caricate.
  if (hasExactTotal(st) && res.total != null && st.docs.length >= res.total) return true;
  return false;
}

// Conteggio totale disaccoppiato dalla find. Un token scarta le risposte
// obsolete se nel frattempo l'utente rilancia la query, cambia coll-tab o
// collection. Best-effort: un errore non deve rompere la griglia già mostrata.
function requestTotalCount(payload, origin = state, originColl = state.activeCollId, originTabId) {
  const token = (origin.countToken = (origin.countToken || 0) + 1);
  const db = origin.db, coll = origin.coll;
  // Registra la firma conteggiata: le pagine successive (keepCount) la
  // riconoscono e riusano il risultato invece di rilanciare la scansione.
  origin.countKey = countKeyFor(payload);
  origin.countPending = true;
  origin.countTimedOut = false;
  if (origin === state) updateFooter();
  emit('collection:count', {
    // Lo stesso filtro della find, qualunque forma abbia: mandare `filter`
    // quando la find ha usato `filtro` darebbe un totale che non descrive le
    // righe mostrate.
    tabId: originTabId, db: payload.db, coll: payload.coll,
    filter: payload.filter, filtro: payload.filtro, cercaOvunque: payload.cercaOvunque, _bg: true,
  })
    .then((res) => {
      // Lo stato da aggiornare è quello del tab che ha chiesto il conteggio
      // (`origin`), non quello attivo alla risposta.
      const st = res._state;
      if (st !== origin) return; // il tab è cambiato sotto: conteggio non pertinente
      if (token !== st.countToken || st.db !== db || st.coll !== coll || st.activeCollId !== originColl) return;
      st.countPending = false;
      if (res.total == null) {
        st.countTimedOut = true; // timeout lato server: totale non calcolabile
      } else {
        st.total = res.total;
        st.countApprox = !!res.approx; // stima dai metadati → footer con "≈"
        st.exhausted = st.docs.length >= st.total;
      }
      if (!isForActiveTab(res)) return; // footer e toolbar sono del workspace attivo
      updateFooter();
      updateInfiniteUI();
      updateBulkDeleteUI(); // il totale appena arrivato abilita/disabilita "Elimina tutto"
    })
    .catch((err) => {
      const st = (err && err._state) || state;
      if (st === origin && token === st.countToken) st.countPending = false;
    });
}

// Piano di esecuzione (EXPLAIN) della query corrente: stessi parametri di
// runQuery più la modalità. Un filtro vuoto è valido (explain del find pieno).
export function explainQuery() {
  if (!state.db || !state.coll) return;
  showQueryError(null);
  const mode = modoEffettivo();

  const payload = {
    db: state.db,
    coll: state.coll,
    mode,
    // Lo stesso filtro della query: un piano calcolato su un'altra
    // condizione spiega un'altra query.
    ...filtroCorrente(),
    sort: sortCorrente(),
    limit: $('#page-size').value,
    skip: state.skip,
  };

  $('#explain-query').textContent = `${state.db}.${state.coll}`;
  $('#explain-body').innerHTML = '<div class="loading-spinner" style="padding:20px; text-align:center; color:var(--accent);">Analisi del piano di esecuzione in corso...</div>';
  $('#explain-overlay').classList.remove('hidden');

  emit('collection:explain', payload)
    .then((res) => {
      // La modale è unica per tutta l'app: se nel frattempo l'utente è passato a
      // un altro tab, mostrare qui il piano di un'altra connessione sarebbe
      // fuorviante. Meglio chiuderla che riempirla di dati non pertinenti.
      if (!isForActiveTab(res)) { $('#explain-overlay').classList.add('hidden'); return; }
      showExplainResult(res);
    })
    .catch((err) => {
      $('#explain-overlay').classList.add('hidden');
      if (isForActiveTab(err)) showQueryError(err.message);
    });
}

// Mostra il piano nella modale: albero JSON interattivo con rendering pigro
// oppure tabella (EXPLAIN classico MySQL).
function showExplainResult(res) {
  const body = $('#explain-body');
  body.innerHTML = '';
  $('#explain-query').textContent = res.query || `${state.db}.${state.coll}`;

  if (res.format === 'table') {
    const table = document.createElement('table');
    table.className = 'explain-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const col of res.columns || []) {
      const th = document.createElement('th');
      th.textContent = col;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    const frag = document.createDocumentFragment();
    for (const row of res.rows || []) {
      const tr = document.createElement('tr');
      for (const col of res.columns || []) {
        const td = document.createElement('td');
        const { text, cls } = displayValueBreve(row[col]);
        if (cls) td.className = cls;
        td.textContent = row[col] === undefined ? '' : text;
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    table.appendChild(tbody);
    body.appendChild(table);
  } else {
    const treeContainer = document.createElement('div');
    treeContainer.className = 'json-tree-container';
    const tree = buildJsonNode(res.plan, 'Plan', true);
    treeContainer.appendChild(tree);
    body.appendChild(treeContainer);
  }
  $('#explain-overlay').classList.remove('hidden');
}

// --- Virtual Scrolling ------------------------------------------------------
// Con dataset grandi renderizzare migliaia di <tr> rallenta il browser: sopra
// VIRTUAL_THRESHOLD righe si passa alla virtualizzazione, tenendo in DOM solo
// la finestra visibile più un margine (OVERSCAN) e simulando l'altezza totale
// con due righe "spacer". Sotto la soglia il render resta quello classico (così
// le larghezze automatiche delle colonne non "ballano" sui piccoli dataset).
const VIRTUAL_THRESHOLD = SOGLIA_VIRTUALE;
const OVERSCAN = 8;

// Che cosa la griglia della vista Dati sa fare, DICHIARATO. E' l'inventario che
// prima non esisteva da nessuna parte: le tre copie della griglia avevano
// capacita' diverse e per sapere quali bisognava usarle.
/* ---------------------------------------------------------------------------
 * La modalità del filtro.
 *
 * Vive nel DOM (`data-modo` sul pulsante) e non in una variabile di modulo,
 * per la stessa ragione per cui ci vive il testo del filtro: il workspace è
 * unico e condiviso da tutti i tab, e una variabile di modulo descriverebbe
 * l'ultimo tab guardato invece di quello che si sta guardando.
 * ------------------------------------------------------------------------- */

function modoFiltro() {
  const gruppo = $('#filter-mode-switch');
  return (gruppo && gruppo.dataset.modo) === 'condizione' ? 'condizione' : 'rapido';
}

/** Il pezzo di payload che descrive il filtro, secondo la modalità corrente. */
function filtroCorrente() {
  return payloadFiltro(modoFiltro(), $('#filter-input').value);
}

/** Applica al DOM la modalità scelta: icona, segnaposto, testo d'aiuto. */
function applicaModoFiltro(modo) {
  const gruppo = $('#filter-mode-switch');
  const input = $('#filter-input');
  if (!gruppo || !input) return;
  const spec = MODI[modo] || MODI.rapido;
  gruppo.dataset.modo = modo;
  gruppo.querySelectorAll('[data-filter-mode]').forEach((btn) => {
    const attivo = btn.dataset.filterMode === modo;
    btn.classList.toggle('active', attivo);
    btn.setAttribute('aria-checked', String(attivo));
    btn.tabIndex = attivo ? 0 : -1;
  });
  input.placeholder = spec.segnaposto;
  applyQueryPlaceholders();
}

export function leggiStatoFiltro() {
  const gruppo = $('#filter-mode-switch');
  const modo = modoFiltro();
  const corrente = $('#filter-input')?.value || '';
  const rapido = modo === 'rapido' ? corrente : (gruppo?.dataset.testoRapido || '');
  const condizione = modo === 'condizione' ? corrente : (gruppo?.dataset.testoCondizione || '');
  return { modo, rapido, condizione };
}

export function applicaStatoFiltro(stato = {}) {
  const gruppo = $('#filter-mode-switch');
  if (!gruppo) return;
  const modo = stato.modo === 'condizione' ? 'condizione' : 'rapido';
  gruppo.dataset.testoRapido = stato.rapido || '';
  gruppo.dataset.testoCondizione = stato.condizione || '';
  applicaModoFiltro(modo);
  $('#filter-input').value = modo === 'rapido'
    ? gruppo.dataset.testoRapido
    : gruppo.dataset.testoCondizione;
}

const CAPACITA_DATI = capacita({
  virtualizzazione: true,
  selezioneRighe: true,
  selezioneCelle: true,
  scorrimentoAiBordi: true,
  modificaInline: true,
  paginazioneAChiave: true,
  chiaviEsterne: true,
  geometrie: true,
});
// Contesto della virtualizzazione attiva; null quando la griglia è renderizzata
// per intero. Contiene altezza riga, larghezze colonne congelate e finestra.
let vctx = null;
let scrollRaf = 0;

// Costruisce l'header (thead). In virtualizzazione riapplica le larghezze
// congelate, così le colonne restano allineate anche ricostruendo il thead.
function buildHead(thead, canSelect) {
  const headRow = document.createElement('tr');
  const selectTh = document.createElement('th');
  selectTh.className = 'grid-select-col';
  if (canSelect && state.docs.some((d) => '_id' in d)) {
    const checkAll = document.createElement('input');
    checkAll.type = 'checkbox';
    checkAll.title = 'Seleziona/deseleziona tutti i documenti della pagina';

    // Sincronizza lo stato del checkbox con le selezioni attuali
    const docsWithId = state.docs.filter(d => '_id' in d);
    checkAll.checked = docsWithId.length > 0 && docsWithId.every(doc => state.selectedDocs.has(idOf(doc)));
    checkAll.indeterminate = !checkAll.checked && docsWithId.some(doc => state.selectedDocs.has(idOf(doc)));

    checkAll.addEventListener('change', () => {
      checkAll.indeterminate = false;
      if (checkAll.checked) {
        state.docs.forEach((doc) => {
          if ('_id' in doc) state.selectedDocs.add(idOf(doc));
        });
      } else {
        state.docs.forEach((doc) => {
          if ('_id' in doc) state.selectedDocs.delete(idOf(doc));
        });
      }
      document.querySelectorAll('#grid tbody tr td.grid-select-col input[type="checkbox"]').forEach(cb => {
        cb.checked = checkAll.checked;
      });
      updateBulkDeleteUI();
    });
    selectTh.appendChild(checkAll);
  }
  headRow.appendChild(selectTh);

  // Nessuna colonna azioni: modifica ed eliminazione della riga stanno nel menu
  // contestuale (tasto destro), vedi cellselect.js.

  let currentSort = {};
  try { currentSort = JSON.parse($('#sort-input').value || '{}'); } catch { /* ignore */ }

  state.columns.forEach((col, colIdx) => {
    const th = document.createElement('th');
    th.dataset.c = colIdx; // per la selezione di colonna (cellselect.js)
    const dir = currentSort[col];
    th.textContent = col + (dir === 1 ? ' ▲' : dir === -1 ? ' ▼' : '');
    th.title = "Clicca per ordinare, Shift+clic per aggiungere la colonna all'ordinamento (multi-colonna), Ctrl+clic per selezionare la colonna";
    th.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) return; // selezione colonna, non sort
      let nuovoSort;
      if (e.shiftKey) {
        // Multi-colonna: la colonna entra nell'ordinamento esistente invece di
        // sostituirlo. L'ordine di inserimento dell'oggetto è la priorità della
        // clausola ORDER BY / del documento sort, quindi le colonne già presenti
        // conservano il loro posto e la nuova arriva in coda.
        nuovoSort = { ...currentSort };
        const attuale = currentSort[col];
        if (attuale === 1) nuovoSort[col] = -1;
        else if (attuale === -1) delete nuovoSort[col]; // terzo stato: esce dall'ordinamento
        else nuovoSort[col] = 1;
      } else {
        nuovoSort = { [col]: dir === 1 ? -1 : 1 };
      }
      $('#sort-input').value = JSON.stringify(nuovoSort);
      state.skip = 0;
      runQuery();
    });
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  if (vctx && vctx.widths) applyFrozenWidths(headRow);
}

// Costruisce una singola riga (tr) per il documento all'indice `rowIdx` in
// state.docs. Estratta per essere riusata dal render classico e da quello
// virtualizzato.
function buildRow(doc, rowIdx, canSelect) {
  const tr = document.createElement('tr');
  // Letto una volta per riga e non per cella: è una Map, ma la ricerca avviene
  // dentro il ciclo di rendering delle righe visibili, a ogni fotogramma.
  const relazioni = relazioniCorrenti();

  const selectTd = document.createElement('td');
  selectTd.className = 'grid-select-col';
  if (canSelect && '_id' in doc) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const docId = idOf(doc);
    checkbox.checked = state.selectedDocs.has(docId);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        state.selectedDocs.add(docId);
      } else {
        state.selectedDocs.delete(docId);
      }
      // Sincronizza il checkbox "select all"
      const docsWithId = state.docs.filter(d => '_id' in d);
      const allSelected = docsWithId.length > 0 && docsWithId.every(d => state.selectedDocs.has(idOf(d)));
      const selectAllCheckbox = document.querySelector('#grid thead th.grid-select-col input[type="checkbox"]');
      if (selectAllCheckbox) {
        selectAllCheckbox.checked = allSelected;
        selectAllCheckbox.indeterminate = !allSelected && docsWithId.some((d) => state.selectedDocs.has(idOf(d)));
      }
      updateBulkDeleteUI();
    });
    selectTd.appendChild(checkbox);
  }
  tr.appendChild(selectTd);

  // Le azioni sulla riga (modifica / elimina) vivono nel menu contestuale.

  state.columns.forEach((col, colIdx) => {
    const td = document.createElement('td');
    // Coordinate per la selezione celle stile Excel (vedi cellselect.js).
    td.dataset.r = rowIdx;
    td.dataset.c = colIdx;
    // Testo LIMITATO: quello che si vede in cella, non il valore intero. La
    // griglia è virtualizzata e ridisegna le righe visibili a ogni fotogramma
    // di scorrimento; con un documento da 25 MB in una colonna, serializzarlo
    // per intero costava ~144 ms per cella. Copia (cellselect.js) e modifica
    // al volo (inlineEdit.js) continuano a passare da `displayValue`, che è
    // esatto: lì un valore troncato sarebbe perdita di dati.
    const valore = doc[col];
    const { text, cls, dataVal } = displayValueBreve(valore);
    // Quando la cella e' scrivibile lo dice la vista, con il proprio criterio
    // (qui: non la colonna dell'identita', e una riga che ne ha una). La
    // conseguenza — mappa in modifica o in sola lettura — la decide il modulo.
    const modificabile = col !== '_id' && '_id' in doc;
    const geometrica = rendiCellaGeometrica(td, valore, aperturaCella({
      valore, campo: col, modificabile, onModifica: () => startEdit(td, doc, col),
    }));
    if (!geometrica) {
      const span = document.createElement('span');
      if (cls) span.className = cls;
      if (dataVal !== undefined) span.dataset.val = dataVal;
      span.textContent = valore === undefined ? '' : text;
      td.title = text;
      td.appendChild(span);
    }

    if (modificabile) {
      td.classList.add('editable');
      if (!geometrica) td.addEventListener('dblclick', () => startEdit(td, doc, col));
    }
    // Colonna collegata a un'altra tabella: l'indicatore è uno pseudo-elemento
    // CSS su una classe, non un nodo in più. Con la griglia virtualizzata una
    // `<span>` per cella si paga a ogni fotogramma di scorrimento (è la stessa
    // ragione per cui qui si usa `displayValueBreve` e non `displayValue`).
    const rel = relazioni && relazioni.get(col);
    if (rel) {
      td.classList.add('fk-cella');
      if (rel.origine !== VINCOLO) td.classList.add('fk-ipotesi');
      td.title = `${text}\n🔗 ${rel.tabella}.${rel.colonna}`;
    }
    tr.appendChild(td);
  });
  return tr;
}

/* --------------------------- Gesti tattili (mobile) ------------------------ *
 * Col dito la griglia si poteva leggere ma non usare: la modifica si apre col
 * doppio clic, e `dblclick` non è il doppio tocco — i browser mobili lo
 * riservano allo zoom, quando lo consegnano lo fanno in ritardo e su molte
 * configurazioni non lo consegnano affatto. Qui i tre gesti sono riconosciuti a
 * mano, dagli eventi puntatore.
 *
 *   doppio tocco                    → modifica la cella
 *   pressione lunga FUORI selezione → modifica la cella
 *   pressione lunga DENTRO selezione→ menu contestuale
 *   trascinamento DA una selezione  → allarga la selezione (in cellselect.js)
 *   trascinamento altrove           → scorre la griglia, come sempre
 *
 * Le due regole che sembrano arbitrarie e non lo sono, entrambe figlie dello
 * stesso vincolo — su un telefono c'è un solo dito e i gesti sono pochi:
 *
 * 1. LA PRESSIONE LUNGA SULLA SELEZIONE RESTA IL MENU. Oggi è l'unico modo di
 *    aprirlo col dito (copia, statistiche, grafico, mappa, elimina):
 *    prendendogliela senza restituire nulla, quelle funzioni sparirebbero tutte
 *    dal mobile. E il menu agisce sulla SELEZIONE, quindi tenerlo lì è il
 *    significato che aveva già.
 *
 * 2. IL TRASCINAMENTO SELEZIONA SOLO PARTENDO DALLA SELEZIONE. In una griglia
 *    di dati il trascinamento è il modo con cui si scorre: darlo alla selezione
 *    ovunque renderebbe la tabella immobile, molto peggio del problema risolto.
 *
 * In entrambe, la selezione è lo stato "armato": si tocca una cella per
 * sceglierla, e da lì la si allarga o ci si agisce sopra.
 *
 * Il puntatore fine resta invariato: col mouse il doppio clic, il trascinamento
 * e il tasto destro funzionano già.
 * ------------------------------------------------------------------------- */

const ATTESA_TOCCO_MS = 500;
// Oltre questo spostamento non è più una pressione: è uno scorrimento della
// griglia, e far comparire un editor mentre si scorre è il modo più rapido di
// rendere una tabella inutilizzabile col dito.
const TOLLERANZA_TOCCO_PX = 10;
// Finestra del doppio tocco. `dblclick` NON si può usare col dito: i browser
// mobili lo riservano allo zoom, quando lo consegnano lo fanno con ritardo e su
// molte configurazioni non lo consegnano affatto. Si riconosce quindi a mano,
// dai due tocchi ravvicinati sulla stessa cella.
const DOPPIO_TOCCO_MS = 300;
const DOPPIO_TOCCO_PX = 24;

function collegaGestiTattili() {
  const tbody = $('#grid tbody');
  if (!tbody) return;

  let timer = null;
  let partenza = null;
  // Il tocco prolungato ha già fatto il suo: gli eventi che il browser emette
  // DOPO (il `contextmenu` nativo, il clic emulato) vanno ignorati, altrimenti
  // si aprirebbe anche il menu sopra l'editor appena comparso.
  let consumato = false;
  // Ultimo tocco concluso, per riconoscere il doppio: cella, istante e punto.
  let ultimo = null;

  const annulla = () => {
    clearTimeout(timer);
    timer = null;
    partenza = null;
  };

  // Apre la modifica se la cella è modificabile. Condivisa dal doppio tocco e
  // dalla pressione lunga: due percorsi separati divergerebbero sulla domanda
  // "questa cella si può modificare?", e una delle due finirebbe per aprire un
  // editor su `_id` o su una riga senza chiave.
  const modifica = (td) => {
    const doc = state.docs[Number(td.dataset.r)];
    const col = state.columns[Number(td.dataset.c)];
    if (!doc || col === '_id' || !('_id' in doc)) return false;
    startEdit(td, doc, col);
    return true;
  };

  tbody.addEventListener('pointerdown', (e) => {
    // Solo dito e penna: col mouse il doppio clic e il tasto destro ci sono già,
    // e una pressione lunga del mouse è di solito l'inizio di un trascinamento
    // di selezione.
    if (e.pointerType === 'mouse') return;
    const td = e.target.closest('td[data-c]');
    if (!td || td.classList.contains('editing')) return;
    annulla();
    consumato = false;

    // Doppio tocco: secondo tocco ravvicinato sulla stessa cella → modifica.
    const ora = Date.now();
    if (ultimo && ultimo.td === td
      && ora - ultimo.t < DOPPIO_TOCCO_MS
      && Math.abs(e.clientX - ultimo.x) < DOPPIO_TOCCO_PX
      && Math.abs(e.clientY - ultimo.y) < DOPPIO_TOCCO_PX) {
      ultimo = null;
      if (modifica(td)) {
        // Senza, il browser interpreta i due tocchi come "zoom sul contenuto" e
        // ingrandisce la tabella sopra l'editor appena aperto.
        e.preventDefault();
        consumato = true;
        return;
      }
    }
    ultimo = { td, t: ora, x: e.clientX, y: e.clientY };

    partenza = { x: e.clientX, y: e.clientY, td };
    timer = setTimeout(() => {
      timer = null;
      if (!partenza || !document.contains(td)) return;
      consumato = true;
      // Sulla selezione il tocco prolungato resta il menu: lo apre il gestore
      // `contextmenu` di cellselect.js, che il browser emette da sé al termine
      // della pressione. Qui non si fa nulla e soprattutto non si segna
      // l'evento come consumato. Idem dove non c'è nulla da modificare.
      if (cellaNellaSelezione(td) || !modifica(td)) consumato = false;
      // Una pressione lunga non deve poi valere come primo tocco di un doppio.
      ultimo = null;
    }, ATTESA_TOCCO_MS);
  });

  tbody.addEventListener('pointermove', (e) => {
    if (!partenza) return;
    if (Math.abs(e.clientX - partenza.x) > TOLLERANZA_TOCCO_PX
      || Math.abs(e.clientY - partenza.y) > TOLLERANZA_TOCCO_PX) annulla();
  });
  tbody.addEventListener('pointerup', annulla);
  tbody.addEventListener('pointercancel', annulla);

  // In cattura e prima di cellselect.js: quando la pressione ha già aperto
  // l'editor, il `contextmenu` nativo che segue non deve aprirci sopra il menu.
  tbody.addEventListener('contextmenu', (e) => {
    if (!consumato) return;
    consumato = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

// La cella fa parte della selezione corrente? Legge le stesse coordinate che
// `cellselect.js` scrive sui `td` e la stessa forma di chiave (`riga:colonna`).
function cellaNellaSelezione(td) {
  const cells = state.cellSel && state.cellSel.cells;
  return !!(cells && cells.size && cells.has(`${td.dataset.r}:${td.dataset.c}`));
}

function applyFrozenWidths(headRow) {
  [...headRow.children].forEach((th, i) => {
    if (vctx.widths[i] != null) th.style.width = `${vctx.widths[i]}px`;
  });
}

function clearFrozenWidths() {
  document.querySelectorAll('#grid thead th').forEach((th) => { th.style.width = ''; });
}

export function renderGrid(opts = {}) {
  const preserveScroll = !!opts.preserveScroll;
  const grid = $('#grid');
  const wrap = $('.grid-wrap');
  const thead = $('#grid thead');
  const tbody = $('#grid tbody');
  const savedScroll = wrap ? wrap.scrollTop : 0;

  // In aggregate/SQL Raw i risultati non sono documenti reali (es. output di
  // $group): niente selezione né bulk delete, gli _id sarebbero fuorvianti.
  const canSelect = $('#query-mode').value !== 'aggregate';

  thead.innerHTML = '';
  buildHead(thead, canSelect);

  const virtual = vaVirtualizzata(state.docs.length, CAPACITA_DATI, VIRTUAL_THRESHOLD);
  if (!virtual) {
    vctx = null;
    grid.classList.remove('virtual');
    grid.style.width = '';
    clearFrozenWidths();
    disegnaCorpo({
      tbody,
      righe: state.docs,
      disegnaRiga: (doc, i) => buildRow(doc, i, canSelect),
      finestra: null,
      colonneTotali: 1 + state.columns.length,
    });
    applyCellSelection();
    if (preserveScroll && wrap) wrap.scrollTop = savedScroll;
  } else {
    renderVirtualized(preserveScroll, savedScroll, canSelect);
  }

  updateFooter();
  updateInfiniteUI();
  updateBulkDeleteUI();
  // Dopo il render, se lo scroll infinito è attivo e la finestra non è piena,
  // carica subito il blocco successivo.
  maybeLoadMore();
}

// Prepara la virtualizzazione: alla prima chiamata (o dopo un cambio dataset)
// misura l'altezza di riga e congela le larghezze delle colonne con un render
// campione a layout automatico, poi passa a table-layout fixed e renderizza la
// sola finestra visibile.
function renderVirtualized(preserveScroll, savedScroll, canSelect) {
  const grid = $('#grid');
  const wrap = $('.grid-wrap');
  const tbody = $('#grid tbody');

  if (!preserveScroll || !vctx) {
    grid.classList.remove('virtual');
    grid.style.width = '';
    clearFrozenWidths();
    tbody.innerHTML = '';
    // Render campione a layout automatico per misurare altezza e larghezze.
    const sample = Math.min(state.docs.length, 60);
    for (let i = 0; i < sample; i++) tbody.appendChild(buildRow(state.docs[i], i, canSelect));
    const firstRow = tbody.querySelector('tr');
    const rowH = firstRow ? Math.round(firstRow.getBoundingClientRect().height) : 28;
    const headCells = [...$('#grid thead tr').children];
    const widths = headCells.map((th) => Math.ceil(th.getBoundingClientRect().width));
    const totalWidth = widths.reduce((a, b) => a + b, 0);
    vctx = { rowH: rowH || 28, widths, totalWidth, start: 0, end: 0 };
    // Congela: larghezze esplicite + table-layout fixed (box-sizing border-box
    // via .virtual in CSS, così width == larghezza misurata coi bordi).
    applyFrozenWidths($('#grid thead tr'));
    grid.style.width = `${totalWidth}px`;
    grid.classList.add('virtual');
  }
  vctx.canSelect = canSelect;
  if (wrap) wrap.scrollTop = preserveScroll ? savedScroll : 0;
  renderVirtualWindow();
}

// Renderizza la sola finestra di righe visibili (più OVERSCAN) con gli spacer.
function renderVirtualWindow() {
  if (!vctx) return;
  const wrap = $('.grid-wrap');
  const tbody = $('#grid tbody');
  // L'aritmetica della finestra sta nel modulo comune: era scritta due volte,
  // qui e in query-tab.js, con le stesse operazioni e nomi diversi.
  const finestra = finestraVirtuale({
    scrollTop: wrap ? wrap.scrollTop : 0,
    altezzaViewport: (wrap && wrap.clientHeight) || 400,
    altezzaRiga: vctx.rowH,
    righeTotali: state.docs.length,
    overscan: OVERSCAN,
  });
  vctx.start = finestra.inizio;
  vctx.end = finestra.fine;

  disegnaCorpo({
    tbody,
    righe: state.docs,
    disegnaRiga: (doc, i) => buildRow(doc, i, vctx.canSelect),
    finestra,
    colonneTotali: 1 + state.columns.length, // colonna dei checkbox + colonne dati
  });
  applyCellSelection();
}

// Assicura che la riga `r` sia renderizzata e visibile (usata dalla navigazione
// con le frecce in cellselect.js, che altrimenti non troverebbe la cella nel
// DOM quando è fuori dalla finestra virtualizzata).
export function ensureRowRendered(r) {
  if (!vctx) return;
  const wrap = $('.grid-wrap');
  if (!wrap) return;
  const dove = scorrimentoPerRiga({
    indice: r,
    altezzaRiga: vctx.rowH,
    scrollTop: wrap.scrollTop,
    altezzaViewport: wrap.clientHeight,
  });
  // `null` = la riga e' gia' visibile: toccare lo scorrimento farebbe
  // sobbalzare la griglia a ogni freccia.
  if (dove !== null) wrap.scrollTop = dove;
  renderVirtualWindow();
}

function updateFooter() {
  const docWord = isSqlType(state.dbType) ? 'righe' : 'documenti';
  // Totale sconosciuto: '…' mentre il conteggio gira, '?' se è andato in timeout.
  // Totale stimato dai metadati (approx): mostrato con "≈" e trattato come NON
  // esatto per la navigazione, così una stima imprecisa non nasconde righe reali.
  const known = state.total != null;
  const exact = hasExactTotal();
  const totalDisplay = known ? `${state.countApprox ? '≈ ' : ''}${state.total}` : (state.countTimedOut ? '?' : '…');
  if (state.infiniteScroll && $('#query-mode').value !== 'aggregate') {
    $('#result-info').textContent = `${totalDisplay} ${docWord} — ${state.docs.length} caricati`;
    $('#page-info').textContent = (exact && state.docs.length >= state.total)
      ? 'tutti'
      : `${state.docs.length}${known ? ` / ${totalDisplay}` : ''}`;
    $('#prev-btn').disabled = true;
    $('#next-btn').disabled = true;
  } else {
    const from = state.docs.length === 0 ? 0 : state.skip + 1;
    const to = Math.min(state.skip + state.docs.length, state.skip + state.limit);
    $('#result-info').textContent = `${totalDisplay} ${docWord} — ${state.docs.length} mostrati`;
    // Con totale esatto clampiamo l'intervallo al totale; con stima o totale
    // sconosciuto mostriamo l'intervallo grezzo (la stima potrebbe essere < reale).
    $('#page-info').textContent = exact
      ? `${state.total === 0 ? 0 : from}–${Math.min(to, state.total) || state.docs.length}`
      : `${from}–${to}`;
    $('#prev-btn').disabled = state.skip === 0;
    // Totale esatto: disabilita "avanti" sull'ultima pagina. Totale stimato o
    // sconosciuto: resta attivo finché l'ultima pagina è piena (potrebbe
    // esserci altro), così una stima imprecisa non blocca l'accesso ai dati.
    $('#next-btn').disabled = exact
      ? (state.skip + state.limit >= state.total)
      : (state.docs.length < state.limit);
  }
  updatePagerCollapse(exact);
}

// Footer comprimibile. Quando il risultato sta tutto in una pagina non c'è
// nulla da impaginare, e i cinque controlli (∞ Scroll, Prec, intervallo, Succ,
// righe per pagina) occupano metà barra per non fare niente: si riducono a una
// sola scritta "1–1 di 1 documenti", che li riapre con un clic. L'intervallo
// resta cliccabile per richiuderli, e la scelta vive nello stato del tab —
// vale finché si guarda questo risultato, non per sempre.
function updatePagerCollapse(exact) {
  const pager = $('#pager');
  const chip = $('#pager-compact');
  const info = $('#result-info');
  if (!pager || !chip) return;

  // Comprimibile solo con la certezza che non ci sia altro: con un totale
  // stimato o ancora in corso nascondere "Succ ›" significherebbe nascondere
  // righe reali.
  const unaPagina = !state.infiniteScroll
    && state.skip === 0
    && exact
    && state.docs.length >= state.total;
  const compresso = unaPagina && !state.pagerExpanded;

  pager.classList.toggle('hidden', compresso);
  chip.classList.toggle('hidden', !compresso);
  // Da compresso il chip dice già tutto: "1 documenti — 1 mostrati" sarebbe la
  // stessa frase due volte.
  if (info) info.classList.toggle('hidden', compresso);

  if (compresso) {
    const uno = state.total === 1;
    const parola = isSqlType(state.dbType)
      ? (uno ? 'riga' : 'righe')
      : (uno ? 'documento' : 'documenti');
    // Solo il testo: l'icona ↔ accanto dice che il riassunto si può aprire, e
    // scrivere sul pulsante la cancellerebbe.
    const testo = $('#pager-compact-text') || chip;
    testo.textContent = state.total === 0
      ? `nessun${isSqlType(state.dbType) ? 'a riga' : ' documento'}`
      : `1–${state.docs.length} di ${state.total} ${parola}`;
  }

  // Comprimibile ma espanso: l'intervallo fa da maniglia per richiudere.
  const pageInfo = $('#page-info');
  if (pageInfo) {
    const richiudibile = unaPagina && !!state.pagerExpanded;
    pageInfo.classList.toggle('pager-toggle', richiudibile);
    pageInfo.title = richiudibile ? 'Nascondi i controlli di impaginazione' : '';
  }
}

function updateInfiniteUI() {
  const li = $('#loading-info');
  if (li) li.textContent = state.loading ? 'Caricamento…' : '';
  const cb = $('#infinite-toggle');
  if (cb) cb.checked = !!state.infiniteScroll;
}

// Scroll infinito: se siamo vicini al fondo, carica il blocco successivo.
function maybeLoadMore() {
  if (!state.infiniteScroll || state.loading || state.exhausted) return;
  if ($('#query-mode').value === 'aggregate') return;
  // Con totale noto ci si ferma al suo raggiungimento; se è sconosciuto
  // (conteggio disaccoppiato in corso) è `state.exhausted`, già impostato dalla
  // pienezza dell'ultimo blocco, a dire se c'è altro da caricare.
  if (hasExactTotal() && state.docs.length >= state.total) { state.exhausted = true; return; }
  const wrap = $('.grid-wrap');
  if (!wrap) return;
  const margin = (vctx ? vctx.rowH : 32) * OVERSCAN;
  if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - margin) fetchMore();
}

// Carica e accoda il blocco successivo (solo modalità find).
function fetchMore() {
  const origin = captureContext();
  state.loading = true;
  updateInfiniteUI();
  const chunk = $('#page-size').value;
  const originColl = origin.collId;
  emit('collection:find', {
    db: state.db,
    coll: state.coll,
    // Le pagine successive filtrano come la prima: altrimenti scorrendo
    // comparirebbero righe che il filtro escludeva.
    ...filtroCorrente(),
    sort: $('#sort-input').value,
    limit: chunk,
    skip: state.docs.length,
    // Keyset: continua dall'ultimo _id caricato (con sort di default), così anche
    // lo scroll infinito profondo resta O(blocco) invece di OFFSET crescente.
    keyset: keysetDescriptor({ pageDir: 'next' }),
    deferCount: true, // il totale è già noto (o in arrivo): non riscansionare qui
    _bg: true, // continuazione dello scroll infinito: non una nuova lettura utente
  }).then((res) => {
    // Stato del tab che ha chiesto il blocco (vedi emit/_state in utils.js):
    // accodare le righe al Proxy significherebbe appenderle alla collection di
    // un altro tab, con colonne e _id di un'altra tabella.
    const st = res._state;
    if (st.activeCollId !== originColl) { st.loading = false; return; }
    // Unione colonne (blocchi successivi possono avere campi nuovi) e append.
    for (const c of res.columns) if (!st.columns.includes(c)) st.columns.push(c);
    st.docs = st.docs.concat(res.docs);
    if (res.total != null) st.total = res.total; // non sovrascrivere un totale noto con null
    // Fine dati: blocco non pieno, oppure raggiunto un totale ESATTO (una stima
    // dai metadati non è affidabile per fermarsi: potrebbe essere < reale).
    if (!res.docs.length || res.docs.length < (res.limit || st.limit)
        || (hasExactTotal(st) && st.docs.length >= st.total)) {
      st.exhausted = true;
    }
    st.loading = false;
    if (isForActiveTab(res)) renderGrid({ preserveScroll: true });
  }).catch((err) => {
    // TAB_CLOSED porta intenzionalmente _state: null: il fallback al Proxy
    // globale toccherebbe il nuovo tab attivo. Lo stato catturato appartiene
    // sempre alla richiesta, anche dopo la chiusura del tab.
    const st = (err && err._state) || origin.st;
    st.loading = false;
    if (!isForActiveTab(err)) return;
    updateInfiniteUI();
    showQueryError(err.message);
  });
}

export function deleteDoc(doc) {
  const { text } = displayValue(doc._id);
  if (!confirm(`Eliminare il documento con _id = ${text}?`)) return;
  const origin = captureContext();
  const bersaglio = { tabId: origin.tabId, db: origin.st.db, coll: origin.st.coll };
  emit('doc:delete', {
    ...bersaglio,
    id: idOf(doc),
  }).then((res) => {
    toast('Documento eliminato');
    // `runQuery` legge gli input del workspace (DOM unico): rilanciarla mentre è
    // attivo un altro tab rileggerebbe la collection sbagliata. Se il tab non è
    // più in primo piano la scrittura è comunque avvenuta e i dati verranno
    // riletti al ritorno.
    if (origin.isStillActive()) runQuery({ auto: true }); // refresh post-scrittura: non è una lettura utente
    else marcaDatiSporchi(origin, bersaglio.db, bersaglio.coll);
  }).catch((err) => toast(err.message, true));
}

// Elimina i documenti passati (righe della selezione celle, non i checkbox):
// una sola conferma per tutti, poi le stesse ondate di `deleteSelectedDocs`.
export function deleteDocs(docs) {
  const ids = docs.filter((d) => d && '_id' in d).map(idOf);
  if (ids.length === 0) { toast('Nessuna riga da eliminare', true); return; }
  if (ids.length === 1) { deleteDoc(docs.find((d) => d && '_id' in d)); return; }
  const isSql = isSqlType(state.dbType);
  const cosa = isSql ? 'righe' : 'documenti';
  if (!confirm(`Eliminare ${ids.length} ${cosa}? Questa azione non si può annullare.`)) return;

  const origin = captureContext();
  // Bersaglio congelato, non riletto a ogni richiesta: vedi deleteSelectedDocs.
  const bersaglio = { tabId: origin.tabId, db: origin.st.db, coll: origin.st.coll };
  eseguiAOndate(ids, 8, (id) => emit('doc:delete', { ...bersaglio, id }))
    .then((results) => {
      const failed = results.filter((r) => r.status === 'rejected');
      const ok = results.length - failed.length;
      if (failed.length) toast(`${ok} eliminati, ${failed.length} non eliminati: ${failed[0].reason.message}`, true);
      else toast(`${ok} ${cosa} eliminati`);
      if (origin.isStillActive()) runQuery({ auto: true }); // refresh post-scrittura
      else marcaDatiSporchi(origin, bersaglio.db, bersaglio.coll);
    });
}

export function deleteSelectedDocs() {
  // Elimina solo i documenti realmente presenti in pagina: protegge da
  // selezioni rimaste orfane dopo un refresh o un cambio di risultati.
  const visible = new Set(state.docs.filter((d) => '_id' in d).map(idOf));
  const ids = [...state.selectedDocs].filter((id) => visible.has(id));
  if (ids.length === 0) {
    toast('Nessun documento selezionato', true);
    return;
  }
  if (!confirm(`Eliminare i ${ids.length} documenti selezionati? Questa azione non si può annullare.`)) return;

  // Tab e collection d'origine catturati prima di partire: le risposte arrivano
  // a operazione lunga conclusa, quando l'utente può essere altrove.
  const origin = captureContext();
  // E il BERSAGLIO va congelato con loro (CDB-A18). `state` è un Proxy sul tab
  // ATTIVO ed `emit()` inietta il tab attivo AL MOMENTO DELLA CHIAMATA: siccome
  // le ondate distribuiscono le cancellazioni nel tempo, passare a un altro tab
  // mentre l'operazione gira mandava le rimanenti su un'altra connessione, con
  // gli id presi però dalle righe di questa — su MongoDB un `_id` presente
  // anche là veniva cancellato là, e su SQL l'`_id` virtuale `{colonna: valore}`
  // colpiva la riga omonima della tabella sbagliata. Il punto non è fermarsi
  // (le scritture vanno completate) ma indirizzarle: `isStillActive()` decide
  // solo se ridipingere.
  const bersaglio = { tabId: origin.tabId, db: origin.st.db, coll: origin.st.coll };
  // A ondate, non tutte insieme (CDB-51): una cancellazione multipla di
  // centinaia di righe riempirebbe la coda del socket e il pool della sessione,
  // lasciando in attesa ogni altra operazione dell'utente.
  // A ondate significa che l'operazione dura: il pulsante deve dirlo, e
  // soprattutto non deve poter partire una seconda volta sugli stessi id.
  conCaricamento($('#delete-selected-btn'), () => eseguiAOndate(ids, 8, (id) =>
    emit('doc:delete', { ...bersaglio, id })
  ), 'Elimino…').then((results) => {
    const failed = results.filter((r) => r.status === 'rejected');
    const ok = results.length - failed.length;
    origin.st.selectedDocs.clear();
    if (failed.length) toast(`${ok} eliminati, ${failed.length} non eliminati: ${failed[0].reason.message}`, true);
    else toast(`${ok} documenti eliminati`);
    if (origin.isStillActive()) runQuery({ auto: true }); // refresh post-scrittura
    else marcaDatiSporchi(origin, bersaglio.db, bersaglio.coll);
  });
}

export function deleteAllWithFilter() {
  if ($('#query-mode').value === 'aggregate') return; // solo in modalità find
  // Il filtro con cui si cancella dev'essere lo STESSO che ha prodotto le
  // righe a schermo. Mandare il testo grezzo mentre la griglia filtra in
  // modalità rapida — dove quel testo è una parola da cercare, non una
  // clausola — significherebbe cancellare in base a qualcosa che l'utente non
  // ha mai visto.
  const condizione = filtroCorrente();
  const filter = String($('#filter-input').value).trim();
  const total = state.total;
  const isSql = isSqlType(state.dbType);
  if (total === 0) {
    toast(isSql ? 'Nessuna riga da eliminare' : 'Nessun documento da eliminare', true);
    return;
  }
  // Il totale può essere sconosciuto (conteggio disaccoppiato ancora in corso o
  // in timeout): in tal caso non lo citiamo nel messaggio di conferma.
  const count = total != null ? `${total} ` : '';
  const msg = filter
    ? `Eliminare ${isSql ? `le ${count}righe` : `i ${count}documenti`} che soddisfano questo filtro? Questa azione non si può annullare.`
    : `Nessun filtro impostato: eliminare ${isSql ? `TUTTE le ${count}righe` : `TUTTI i ${count}documenti`} di "${state.coll}"? Questa azione non si può annullare.`;
  if (!confirm(msg)) return;

  // Una sola richiesta, e la `confirm()` blocca il thread — ma il bersaglio si
  // congela lo stesso: la regola "una scrittura non legge il Proxy `state`" vale
  // qui come altrove, ed è verificata da test/unit-scritture-bersaglio.js.
  const origin = captureContext();
  const bersaglio = { tabId: origin.tabId, db: origin.st.db, coll: origin.st.coll };
  conCaricamento($('#delete-all-btn'), () => emit('collection:deleteMany', {
    ...bersaglio,
    ...condizione,
  }), 'Elimino…').then((res) => {
    res._state.selectedDocs.clear();
    toast(isSql ? `${res.deleted} righe eliminate` : `${res.deleted} documenti eliminati`);
    if (origin.isStillActive()) runQuery({ auto: true }); // refresh post-scrittura
    else marcaDatiSporchi(origin, bersaglio.db, bersaglio.coll);
  }).catch((err) => toast(err.message, true));
}

// Azzera la selezione multipla e ridisegna le caselle di spunta della pagina
// (la selezione vive in `state`, le caselle sono nel DOM già renderizzato).
function clearDocSelection() {
  state.selectedDocs.clear();
  document.querySelectorAll('#grid .grid-select-col input[type="checkbox"]').forEach((cb) => {
    cb.checked = false;
    cb.indeterminate = false;
  });
  updateBulkDeleteUI();
}

// La barra delle azioni sulla selezione è CONTESTUALE: esiste solo finché c'è
// qualcosa di selezionato. Prima era sempre in mezzo ai dati con "Elimina (0)"
// disabilitata, cioè un'azione distruttiva perennemente sotto il cursore e
// perennemente inutile. "Elimina tutto" non dipende dalla selezione e sta ora
// nel menu ⋯ della toolbar, dove resta raggiungibile senza stare in vista.
export function updateBulkDeleteUI() {
  const selected = state.selectedDocs.size;
  const bar = document.querySelector('.bulk-delete-toolbar');
  const deleteAllBtn = $('#delete-all-btn');

  if (bar) bar.classList.toggle('hidden', selected === 0);

  const count = $('#bulk-count');
  if (count) {
    const word = isSqlType(state.dbType)
      ? (selected === 1 ? 'riga selezionata' : 'righe selezionate')
      : (selected === 1 ? 'documento selezionato' : 'documenti selezionati');
    count.textContent = `${selected} ${word}`;
  }

  if (deleteAllBtn) {
    deleteAllBtn.disabled = state.total === 0 || $('#query-mode').value === 'aggregate';
  }
}

export function initGrid() {
  collegaGestiTattili();

  // Due scelte visibili, due testi conservati: cambiare modalità non distrugge
  // ciò che l'utente aveva scritto nell'altra.
  document.querySelectorAll('#filter-mode-switch [data-filter-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const gruppo = $('#filter-mode-switch');
      const chiavePrima = modoFiltro() === 'rapido' ? 'testoRapido' : 'testoCondizione';
      gruppo.dataset[chiavePrima] = $('#filter-input').value;
      const nuovo = btn.dataset.filterMode === 'condizione' ? 'condizione' : 'rapido';
      applicaModoFiltro(nuovo);
      const chiaveDopo = nuovo === 'rapido' ? 'testoRapido' : 'testoCondizione';
      $('#filter-input').value = gruppo.dataset[chiaveDopo] || '';
      $('#filter-input').focus();
    });
  });
  $('#filter-mode-switch')?.addEventListener('keydown', (e) => {
    const opzioni = [...document.querySelectorAll('#filter-mode-switch [data-filter-mode]')];
    const corrente = opzioni.indexOf(document.activeElement);
    if (corrente < 0) return;
    let prossimo = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') prossimo = (corrente + 1) % opzioni.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') prossimo = (corrente - 1 + opzioni.length) % opzioni.length;
    if (e.key === 'Home') prossimo = 0;
    if (e.key === 'End') prossimo = opzioni.length - 1;
    if (prossimo == null) return;
    e.preventDefault();
    opzioni[prossimo].click();
    opzioni[prossimo].focus();
  });
  $('#filter-input')?.addEventListener('input', () => {
    const gruppo = $('#filter-mode-switch');
    if (!gruppo) return;
    const chiave = modoFiltro() === 'rapido' ? 'testoRapido' : 'testoCondizione';
    gruppo.dataset[chiave] = $('#filter-input').value;
  });
  applicaModoFiltro(modoFiltro());

  $('#run-btn').addEventListener('click', () => { state.skip = 0; clearCellSelection(); runQuery(); });
  // Refresh manuale = lettura utente, in place: keyset `from` ricarica la pagina
  // corrente senza tornare all'inizio (niente OFFSET profondo).
  $('#refresh-btn').addEventListener('click', () => runQuery({ refresh: true }));
  $('#explain-btn').addEventListener('click', explainQuery);
  $('#explain-close').addEventListener('click', () => $('#explain-overlay').classList.add('hidden'));
  $('#explain-overlay').addEventListener('click', (e) => {
    if (e.target === $('#explain-overlay')) $('#explain-overlay').classList.add('hidden');
  });

  // Virtual scrolling: al variare dello scroll ricalcola la finestra visibile
  // (throttle con requestAnimationFrame) e, se attivo, alimenta lo scroll
  // infinito. Salta il re-render della finestra mentre si sta editando una
  // cella, per non distruggere l'input a fuoco.
  $('.grid-wrap').addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const wrap = $('.grid-wrap');
      if (vctx && !wrap.querySelector('td.editing')) {
        const start = Math.max(0, Math.floor(wrap.scrollTop / vctx.rowH) - OVERSCAN);
        if (start !== vctx.start) renderVirtualWindow();
      }
      maybeLoadMore();
    });
  });

  $('#infinite-toggle').addEventListener('change', (e) => {
    state.infiniteScroll = e.target.checked;
    state.skip = 0;
    state.exhausted = false;
    clearCellSelection();
    runQuery();
  });

  attachAutocomplete($('#filter-input'));
  attachAutocomplete($('#sort-input'), { keywords: false });

  for (const sel of ['#filter-input', '#sort-input']) {
    $(sel).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        state.skip = 0;
        runQuery();
      }
    });
    // Scrivere un filtro è lavoro: fissa il coll-tab in anteprima, altrimenti
    // il clic successivo nella sidebar lo rimpiazzerebbe portandoselo via.
    $(sel).addEventListener('input', () => pinActiveCollTab());
  }

  $('#query-mode').addEventListener('change', applyQueryPlaceholders);

  $('#prev-btn').addEventListener('click', () => {
    state.skip = Math.max(0, state.skip - state.limit);
    state.selectedDocs.clear(); // reset selezione al cambio pagina
    clearCellSelection();
    // keepCount: riusa il totale (stesso filtro). pageDir: cursore keyset indietro.
    runQuery({ keepCount: true, pageDir: 'prev' });
  });

  $('#next-btn').addEventListener('click', () => {
    // Con totale esatto avanza finché non è l'ultima pagina; con totale stimato
    // o sconosciuto avanza se la pagina è piena, quindi potrebbe esserci
    // un'altra pagina (coerente con updateFooter).
    const canNext = hasExactTotal()
      ? (state.skip + state.limit < state.total)
      : (state.docs.length >= state.limit);
    if (canNext) {
      state.skip += state.limit;
      state.selectedDocs.clear(); // reset selezione al cambio pagina
      clearCellSelection();
      // keepCount: riusa il totale (stesso filtro). pageDir: cursore keyset avanti.
      runQuery({ keepCount: true, pageDir: 'next' });
    }
  });

  $('#page-size').addEventListener('change', () => {
    state.skip = 0;
    clearCellSelection();
    runQuery();
  });

  // Footer comprimibile: il chip riapre i controlli, l'intervallo li richiude.
  $('#pager-compact').addEventListener('click', () => {
    state.pagerExpanded = true;
    updateFooter();
  });
  $('#page-info').addEventListener('click', () => {
    if (!state.pagerExpanded) return;
    state.pagerExpanded = false;
    updateFooter();
  });

  initQueryHistory();

  initToolbarDropdown('#data-more-btn', '#data-more-menu');
  $('#delete-selected-btn').addEventListener('click', deleteSelectedDocs);
  $('#delete-all-btn').addEventListener('click', deleteAllWithFilter);
  $('#bulk-clear-btn').addEventListener('click', clearDocSelection);
}
