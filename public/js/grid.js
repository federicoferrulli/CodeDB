import { state } from './state.js';
import { $, emit, displayValue, idOf, toast, showQueryError, isSqlType, buildJsonNode } from './utils.js';
import { openCollTab } from './colltabs.js';
import { startEdit, openEditDoc } from './inlineEdit.js';
import { attachAutocomplete } from './autocomplete.js';
import { applyCellSelection, clearCellSelection } from './cellselect.js';
import { recordQuery, initQueryHistory } from './queryhistory.js';

export function applyDbTypeToWorkspace() {
  const isSql = isSqlType(state.dbType);
  // Fix per non usare l'indice magico
  const aggOpt = $('#query-mode').querySelector('option[value="aggregate"]');
  if (aggOpt) aggOpt.textContent = isSql ? 'SQL Raw' : 'aggregate';
  
  $('#uml-hint').innerHTML = isSql
    ? 'Relazioni dalle <b>foreign key</b> dichiarate, più quelle dedotte dai nomi delle colonne (es. <code>user_id</code> → tabella <code>users</code>).'
    : 'Associazioni dedotte dai nomi dei campi (es. <code>user_id</code> → collection <code>users</code>) e dai tipi ObjectId su un campione di documenti.';
  applyQueryPlaceholders();
}

export function applyQueryPlaceholders() {
  const isSql = isSqlType(state.dbType);
  const aggregate = $('#query-mode').value === 'aggregate';
  if (isSql) {
    $('#filter-input').placeholder = aggregate
      ? 'Query SQL, es. SELECT city, COUNT(*) AS n FROM users GROUP BY city'
      : 'Clausola WHERE, es. age > 30';
    $('#sort-input').placeholder = 'Ordinamento, es. name ASC oppure {"name":1}';
  } else {
    $('#filter-input').placeholder = aggregate
      ? 'Pipeline, es. [ { "$group": { "_id": "$city", "n": { "$sum": 1 } } } ]'
      : 'Filtro, es. { "age": { "$gt": 30 } }';
    $('#sort-input').placeholder = 'Sort, es. { "name": 1 }';
  }
  $('#sort-input').classList.toggle('hidden', aggregate);
  // Lo scroll infinito ha senso solo con find (l'aggregate non è paginabile
  // con skip/limit in modo affidabile).
  const inf = $('#infinite-toggle');
  if (inf) {
    inf.disabled = aggregate;
    $('#infinite-toggle-label').classList.toggle('disabled', aggregate);
  }
}

// Apre la collection in un coll-tab (o attiva quello già aperto).
export function selectCollection(dbName, collName) {
  openCollTab(dbName, collName);
}

// opts.auto = lettura automatica (polling, live change stream, refresh dopo una
// scrittura): marcata `_bg` così l'audit del server la ignora e non intasa lo
// storico con le riletture non avviate dall'utente.
export function runQuery(opts = {}) {
  if (!state.db || !state.coll) return;
  showQueryError(null);
  const mode = $('#query-mode').value;

  const payload = mode === 'aggregate'
    ? {
        db: state.db,
        coll: state.coll,
        pipeline: $('#filter-input').value || '[]',
      }
    : {
        db: state.db,
        coll: state.coll,
        filter: $('#filter-input').value,
        sort: $('#sort-input').value,
        limit: $('#page-size').value,
        skip: state.skip,
      };
  if (opts.auto) payload._bg = true;

  // Storico query: registra ciò che l'utente sta eseguendo (best-effort,
  // anche se poi il server risponde con errore la voce resta utile).
  recordQuery({
    mode,
    filter: $('#filter-input').value.trim(),
    sort: mode === 'aggregate' ? '' : $('#sort-input').value.trim(),
  });

  emit(`collection:${mode}`, payload).then((res) => {
    state.docs = res.docs;
    state.columns = res.columns;
    state.total = res.total;
    state.skip = res.skip;
    state.limit = res.limit;
    // Scroll infinito: dopo il primo blocco stabilisce se c'è altro da caricare.
    state.exhausted = state.docs.length >= state.total;
    // Mantiene selezionati solo i documenti ancora presenti nella pagina:
    // la selezione sopravvive ai refresh (live/polling) ma si svuota al
    // cambio di pagina o di filtro.
    const visible = new Set(res.docs.filter((d) => '_id' in d).map(idOf));
    for (const id of [...state.selectedDocs]) {
      if (!visible.has(id)) state.selectedDocs.delete(id);
    }
    renderGrid();
  }).catch((err) => showQueryError(err.message));
}

// Piano di esecuzione (EXPLAIN) della query corrente: stessi parametri di
// runQuery più la modalità. Un filtro vuoto è valido (explain del find pieno).
export function explainQuery() {
  if (!state.db || !state.coll) return;
  showQueryError(null);
  const mode = $('#query-mode').value;

  const payload = mode === 'aggregate'
    ? {
        db: state.db,
        coll: state.coll,
        mode,
        pipeline: $('#filter-input').value || '[]',
      }
    : {
        db: state.db,
        coll: state.coll,
        mode,
        filter: $('#filter-input').value,
        sort: $('#sort-input').value,
        limit: $('#page-size').value,
        skip: state.skip,
      };

  $('#explain-query').textContent = `${state.db}.${state.coll}`;
  $('#explain-body').innerHTML = '<div class="loading-spinner" style="padding:20px; text-align:center; color:var(--accent);">Analisi del piano di esecuzione in corso...</div>';
  $('#explain-overlay').classList.remove('hidden');

  emit('collection:explain', payload)
    .then(showExplainResult)
    .catch((err) => {
      $('#explain-overlay').classList.add('hidden');
      showQueryError(err.message);
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
        const { text, cls } = displayValue(row[col]);
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
const VIRTUAL_THRESHOLD = 200;
const OVERSCAN = 8;
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

  const actionsTh = document.createElement('th');
  actionsTh.className = 'grid-actions-col';
  headRow.appendChild(actionsTh);

  let currentSort = {};
  try { currentSort = JSON.parse($('#sort-input').value || '{}'); } catch { /* ignore */ }

  state.columns.forEach((col, colIdx) => {
    const th = document.createElement('th');
    th.dataset.c = colIdx; // per la selezione di colonna (cellselect.js)
    const dir = currentSort[col];
    th.textContent = col + (dir === 1 ? ' ▲' : dir === -1 ? ' ▼' : '');
    th.title = 'Clicca per ordinare, Ctrl+clic per selezionare la colonna';
    th.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return; // selezione colonna, non sort
      const next = dir === 1 ? -1 : 1;
      $('#sort-input').value = JSON.stringify({ [col]: next });
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

  const actions = document.createElement('td');
  actions.className = 'row-actions';
  if ('_id' in doc) {
    const edit = document.createElement('button');
    edit.className = 'edit-btn';
    edit.textContent = '✎';
    edit.title = 'Modifica documento (riga intera)';
    edit.addEventListener('click', () => openEditDoc(doc));
    actions.appendChild(edit);

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.textContent = '✕';
    del.title = 'Elimina documento';
    del.addEventListener('click', () => deleteDoc(doc));
    actions.appendChild(del);
  }
  tr.appendChild(actions);

  state.columns.forEach((col, colIdx) => {
    const td = document.createElement('td');
    // Coordinate per la selezione celle stile Excel (vedi cellselect.js).
    td.dataset.r = rowIdx;
    td.dataset.c = colIdx;
    const { text, cls } = displayValue(doc[col]);
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = doc[col] === undefined ? '' : text;
    td.title = text;
    td.appendChild(span);

    if (col !== '_id' && '_id' in doc) {
      td.classList.add('editable');
      td.addEventListener('dblclick', () => startEdit(td, doc, col));
    }
    tr.appendChild(td);
  });
  return tr;
}

// Riga "spacer" invisibile che occupa `h` px: simula le righe non renderizzate
// sopra/sotto la finestra visibile, così la scrollbar riflette il totale.
function spacer(h, cols) {
  const tr = document.createElement('tr');
  tr.className = 'v-spacer';
  tr.setAttribute('aria-hidden', 'true');
  const td = document.createElement('td');
  td.colSpan = cols;
  td.style.height = `${h}px`;
  tr.appendChild(td);
  return tr;
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

  const virtual = state.docs.length > VIRTUAL_THRESHOLD;
  if (!virtual) {
    vctx = null;
    grid.classList.remove('virtual');
    grid.style.width = '';
    clearFrozenWidths();
    tbody.innerHTML = '';
    state.docs.forEach((doc, i) => tbody.appendChild(buildRow(doc, i, canSelect)));
    applyCellSelection();
    if (preserveScroll && wrap) wrap.scrollTop = savedScroll;
  } else {
    renderVirtualized(preserveScroll, savedScroll, canSelect);
  }

  updateFooter();
  updateInfiniteUI();
  $('.bulk-delete-toolbar').classList.toggle('hidden', !canSelect || state.total === 0);
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
  const { rowH } = vctx;
  const N = state.docs.length;
  const viewport = (wrap && wrap.clientHeight) || 400;
  const scrollTop = wrap ? wrap.scrollTop : 0;
  const start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const visible = Math.ceil(viewport / rowH);
  const end = Math.min(N, start + visible + OVERSCAN * 2);
  vctx.start = start;
  vctx.end = end;

  tbody.innerHTML = '';
  const totalCols = 2 + state.columns.length;
  if (start > 0) tbody.appendChild(spacer(start * rowH, totalCols));
  for (let i = start; i < end; i++) tbody.appendChild(buildRow(state.docs[i], i, vctx.canSelect));
  if (end < N) tbody.appendChild(spacer((N - end) * rowH, totalCols));
  applyCellSelection();
}

// Assicura che la riga `r` sia renderizzata e visibile (usata dalla navigazione
// con le frecce in cellselect.js, che altrimenti non troverebbe la cella nel
// DOM quando è fuori dalla finestra virtualizzata).
export function ensureRowRendered(r) {
  if (!vctx) return;
  const wrap = $('.grid-wrap');
  if (!wrap) return;
  const { rowH } = vctx;
  const top = r * rowH;
  const bottom = top + rowH;
  const viewTop = wrap.scrollTop;
  const viewBottom = viewTop + wrap.clientHeight;
  if (top < viewTop) wrap.scrollTop = top;
  else if (bottom > viewBottom) wrap.scrollTop = bottom - wrap.clientHeight;
  renderVirtualWindow();
}

function updateFooter() {
  const docWord = isSqlType(state.dbType) ? 'righe' : 'documenti';
  if (state.infiniteScroll && $('#query-mode').value !== 'aggregate') {
    $('#result-info').textContent = `${state.total} ${docWord} — ${state.docs.length} caricati`;
    $('#page-info').textContent = state.docs.length >= state.total ? 'tutti' : `${state.docs.length} / ${state.total}`;
    $('#prev-btn').disabled = true;
    $('#next-btn').disabled = true;
  } else {
    const from = state.total === 0 ? 0 : state.skip + 1;
    const to = Math.min(state.skip + state.docs.length, state.skip + state.limit);
    $('#result-info').textContent = `${state.total} ${docWord} — ${state.docs.length} mostrati`;
    $('#page-info').textContent = `${from}–${Math.min(to, state.total) || state.docs.length}`;
    $('#prev-btn').disabled = state.skip === 0;
    $('#next-btn').disabled = state.skip + state.limit >= state.total;
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
  if (state.docs.length >= state.total) { state.exhausted = true; return; }
  const wrap = $('.grid-wrap');
  if (!wrap) return;
  const margin = (vctx ? vctx.rowH : 32) * OVERSCAN;
  if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - margin) fetchMore();
}

// Carica e accoda il blocco successivo (solo modalità find).
function fetchMore() {
  state.loading = true;
  updateInfiniteUI();
  const chunk = $('#page-size').value;
  emit('collection:find', {
    db: state.db,
    coll: state.coll,
    filter: $('#filter-input').value,
    sort: $('#sort-input').value,
    limit: chunk,
    skip: state.docs.length,
    _bg: true, // continuazione dello scroll infinito: non una nuova lettura utente
  }).then((res) => {
    // Unione colonne (blocchi successivi possono avere campi nuovi) e append.
    for (const c of res.columns) if (!state.columns.includes(c)) state.columns.push(c);
    state.docs = state.docs.concat(res.docs);
    state.total = res.total;
    if (!res.docs.length || state.docs.length >= state.total) state.exhausted = true;
    state.loading = false;
    renderGrid({ preserveScroll: true });
  }).catch((err) => {
    state.loading = false;
    updateInfiniteUI();
    showQueryError(err.message);
  });
}

export function deleteDoc(doc) {
  const { text } = displayValue(doc._id);
  if (!confirm(`Eliminare il documento con _id = ${text}?`)) return;
  emit('doc:delete', {
    db: state.db,
    coll: state.coll,
    id: idOf(doc),
  }).then(() => {
    toast('Documento eliminato');
    runQuery({ auto: true }); // refresh post-scrittura: non è una lettura utente
  }).catch((err) => toast(err.message, true));
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

  Promise.allSettled(ids.map((id) =>
    emit('doc:delete', {
      db: state.db,
      coll: state.coll,
      id,
    })
  )).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected');
    const ok = results.length - failed.length;
    state.selectedDocs.clear();
    if (failed.length) toast(`${ok} eliminati, ${failed.length} non eliminati: ${failed[0].reason.message}`, true);
    else toast(`${ok} documenti eliminati`);
    runQuery({ auto: true }); // refresh post-scrittura
  });
}

export function deleteAllWithFilter() {
  if ($('#query-mode').value === 'aggregate') return; // solo in modalità find
  const filter = $('#filter-input').value.trim();
  const total = state.total;
  const isSql = isSqlType(state.dbType);
  if (total === 0) {
    toast(isSql ? 'Nessuna riga da eliminare' : 'Nessun documento da eliminare', true);
    return;
  }
  const msg = filter
    ? `Eliminare ${isSql ? `le ${total} righe` : `i ${total} documenti`} con questo filtro? Questa azione non si può annullare.`
    : `Nessun filtro impostato: eliminare ${isSql ? `TUTTE le ${total} righe` : `TUTTI i ${total} documenti`} di "${state.coll}"? Questa azione non si può annullare.`;
  if (!confirm(msg)) return;

  emit('collection:deleteMany', {
    db: state.db,
    coll: state.coll,
    filter,
  }).then((res) => {
    state.selectedDocs.clear();
    toast(isSql ? `${res.deleted} righe eliminate` : `${res.deleted} documenti eliminati`);
    runQuery({ auto: true }); // refresh post-scrittura
  }).catch((err) => toast(err.message, true));
}

export function updateBulkDeleteUI() {
  const selected = state.selectedDocs.size;
  const deleteSelectedBtn = $('#delete-selected-btn');
  const deleteAllBtn = $('#delete-all-btn');

  if (deleteSelectedBtn) {
    deleteSelectedBtn.disabled = selected === 0;
    deleteSelectedBtn.textContent = `🗑 Elimina (${selected})`;
  }

  if (deleteAllBtn) {
    deleteAllBtn.disabled = state.total === 0;
  }
}

export function initGrid() {
  $('#run-btn').addEventListener('click', () => { state.skip = 0; clearCellSelection(); runQuery(); });
  $('#refresh-btn').addEventListener('click', () => runQuery()); // refresh manuale = lettura utente
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
  }

  $('#query-mode').addEventListener('change', applyQueryPlaceholders);

  $('#prev-btn').addEventListener('click', () => {
    state.skip = Math.max(0, state.skip - state.limit);
    state.selectedDocs.clear(); // reset selezione al cambio pagina
    clearCellSelection();
    runQuery();
  });

  $('#next-btn').addEventListener('click', () => {
    if (state.skip + state.limit < state.total) {
      state.skip += state.limit;
      state.selectedDocs.clear(); // reset selezione al cambio pagina
      clearCellSelection();
      runQuery();
    }
  });

  $('#page-size').addEventListener('change', () => {
    state.skip = 0;
    clearCellSelection();
    runQuery();
  });

  initQueryHistory();

  $('#delete-selected-btn').addEventListener('click', deleteSelectedDocs);
  $('#delete-all-btn').addEventListener('click', deleteAllWithFilter);
}
