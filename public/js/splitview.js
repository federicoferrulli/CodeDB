'use strict';

import { state } from './state.js';
import { activeTab, tabs } from './tabs.js';
import { $, emit, displayValue, esc, isSqlType, dbTypeIcon } from './utils.js';

const splitState = {
  active: false,
  focusedPaneId: null,
  panes: new Map(),
  layout: null,
  splitCollTabId: null,
};

let paneCounter = 0;
function nextPaneId() {
  return 'pane_' + (++paneCounter);
}

export function isSplitActive() {
  return splitState.active && splitState.panes.size > 1;
}

export function getSplitState() {
  return splitState;
}

export function getSplitStateSnapshot() {
  if (!splitState.active || !splitState.panes.size) return null;
  return {
    active: splitState.active,
    layout: splitState.layout,
    focusedPaneId: splitState.focusedPaneId,
    panes: Array.from(splitState.panes.entries()).map(([pId, p]) => [
      pId,
      {
        id: p.id,
        tabId: p.tabId,
        db: p.db,
        coll: p.coll,
        filter: p.filter || '',
        sort: p.sort || '',
        queryMode: p.queryMode || 'find',
      },
    ]),
  };
}

export function restoreSplitStateSnapshot(snap) {
  if (!snap || !snap.panes || !snap.panes.length) return;
  splitState.active = !!snap.active;
  splitState.layout = snap.layout || null;
  splitState.focusedPaneId = snap.focusedPaneId || null;
  splitState.panes.clear();
  for (const [pId, p] of snap.panes) {
    splitState.panes.set(pId, {
      id: p.id,
      tabId: p.tabId,
      db: p.db,
      coll: p.coll,
      filter: p.filter || '',
      sort: p.sort || '',
      queryMode: p.queryMode || 'find',
      skip: 0,
      limit: 50,
      total: 0,
      docs: [],
      columns: [],
      loading: false,
      error: null,
    });
  }
}

export function getFocusedPaneId() {
  if (splitState.focusedPaneId && splitState.panes.has(splitState.focusedPaneId)) {
    return splitState.focusedPaneId;
  }
  const first = Array.from(splitState.panes.keys())[0];
  splitState.focusedPaneId = first || null;
  return splitState.focusedPaneId;
}

export function setFocusedPane(paneId) {
  if (splitState.panes.has(paneId)) {
    splitState.focusedPaneId = paneId;
    document.querySelectorAll('.split-pane').forEach((el) => {
      el.classList.toggle('focused', el.dataset.paneId === paneId);
    });
  }
}

export function initSplitView() {
  const ws = $('#workspace');
  if (!ws) return;

  const tabContainer = $('#coll-tab-bar') || $('#tab-bar');
  if (tabContainer) {
    tabContainer.addEventListener('dragover', (e) => e.stopPropagation());
    tabContainer.addEventListener('drop', (e) => e.stopPropagation());
  }

  let dropOverlay = $('#drop-zone-overlay');
  if (!dropOverlay) {
    dropOverlay = document.createElement('div');
    dropOverlay.id = 'drop-zone-overlay';
    dropOverlay.className = 'drop-zone-overlay hidden';
    dropOverlay.innerHTML = '<div class="drop-zone-label"></div>';
    document.body.appendChild(dropOverlay);
  }

  ws.addEventListener('dragover', handleWorkspaceDragOver);
  ws.addEventListener('dragleave', handleWorkspaceDragLeave);
  ws.addEventListener('drop', handleWorkspaceDrop);
}

function removeSingleCollTab(db, coll) {
  const t = activeTab();
  if (!t) return;
  const idx = t.state.collTabs.findIndex((c) => !c.isSplitTab && c.db === db && c.coll === coll);
  if (idx >= 0) {
    t.state.collTabs.splice(idx, 1);
  }
}

function ensureSplitCollTab() {
  const t = activeTab();
  if (!t) return null;

  let splitCt = t.state.collTabs.find((c) => c.isSplitTab);
  if (!splitCt) {
    splitCt = {
      id: 'splitview_' + crypto.randomUUID(),
      isSplitTab: true,
      db: 'Split-View',
      coll: '🔲 Area Split-View',
      snap: null,
    };
    t.state.collTabs.push(splitCt);
  }
  t.state.activeCollId = splitCt.id;
  splitState.splitCollTabId = splitCt.id;
  return splitCt;
}

export function deactivateSplitView() {
  const ws = $('#workspace');
  if (ws && ws.classList.contains('split-active')) {
    ws.classList.remove('split-active');
    ws.innerHTML = getOriginalWorkspaceHTML();
  }
}

function handleWorkspaceDragOver(e) {
  if (e.target.closest('#coll-tab-bar') || e.target.closest('#tab-bar') || e.target.closest('#sidebar') || e.target.closest('#conn-sidebar')) {
    hideDropPreview();
    return;
  }

  if (!e.dataTransfer.types.includes('application/codedb-tab') && !e.dataTransfer.types.includes('text/plain')) return;

  const targetPaneEl = e.target.closest('.split-pane') || $('#workspace');
  if (!targetPaneEl) return;

  const rect = targetPaneEl.getBoundingClientRect();
  const relX = (e.clientX - rect.left) / rect.width;
  const relY = (e.clientY - rect.top) / rect.height;

  let dir = 'center';
  if (relX > 0.75) dir = 'right';
  else if (relX < 0.25) dir = 'left';
  else if (relY > 0.75) dir = 'bottom';
  else if (relY < 0.25) dir = 'top';

  if (!splitState.active && dir === 'center') {
    hideDropPreview();
    return;
  }

  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  showDropPreview(targetPaneEl, dir);
}

function handleWorkspaceDragLeave(e) {
  const overlay = $('#drop-zone-overlay');
  if (!overlay) return;
  if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
    overlay.classList.add('hidden');
  }
}

function showDropPreview(targetEl, dir) {
  const overlay = $('#drop-zone-overlay');
  if (!overlay) return;

  const rect = targetEl.getBoundingClientRect();
  const label = overlay.querySelector('.drop-zone-label');

  overlay.classList.remove('hidden');

  let top = rect.top;
  let left = rect.left;
  let width = rect.width;
  let height = rect.height;

  if (dir === 'right') {
    left = rect.left + rect.width * 0.5;
    width = rect.width * 0.5;
    if (label) label.textContent = 'Affianca a destra ➔';
  } else if (dir === 'left') {
    width = rect.width * 0.5;
    if (label) label.textContent = '◄ Affianca a sinistra';
  } else if (dir === 'bottom') {
    top = rect.top + rect.height * 0.5;
    height = rect.height * 0.5;
    if (label) label.textContent = 'Affianca sotto ⬇';
  } else if (dir === 'top') {
    height = rect.height * 0.5;
    if (label) label.textContent = '⬆ Affianca sopra';
  } else {
    if (label) label.textContent = 'Apri in questo pannello';
  }

  overlay.style.top = `${top}px`;
  overlay.style.left = `${left}px`;
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
}

function hideDropPreview() {
  const overlay = $('#drop-zone-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function handleWorkspaceDrop(e) {
  hideDropPreview();

  if (e.target.closest('#coll-tab-bar') || e.target.closest('#tab-bar')) {
    return;
  }

  const dataRaw = e.dataTransfer.getData('application/codedb-tab') || e.dataTransfer.getData('text/plain');
  if (!dataRaw) return;

  let item = null;
  try {
    item = JSON.parse(dataRaw);
  } catch {
    return;
  }

  if (!item || !item.db || !item.coll) return;

  const targetPaneEl = e.target.closest('.split-pane');
  const targetPaneId = targetPaneEl ? targetPaneEl.dataset.paneId : null;

  const rect = (targetPaneEl || $('#workspace')).getBoundingClientRect();
  const relX = (e.clientX - rect.left) / rect.width;
  const relY = (e.clientY - rect.top) / rect.height;

  let dir = 'center';
  if (relX > 0.75) dir = 'right';
  else if (relX < 0.25) dir = 'left';
  else if (relY > 0.75) dir = 'bottom';
  else if (relY < 0.25) dir = 'top';

  if (!splitState.active && dir === 'center') {
    return;
  }

  e.preventDefault();
  addOrSplitPane(targetPaneId, dir, item);
}

export function addOrSplitPane(targetPaneId, dir, item) {
  const t = activeTab();
  const tabId = item.tabId || (t ? t.id : null);
  if (!tabId) return;

  const pId = nextPaneId();
  const newPane = {
    id: pId,
    tabId,
    db: item.db,
    coll: item.coll,
    filter: item.filter || '',
    sort: item.sort || '',
    queryMode: item.queryMode || 'find',
    skip: 0,
    limit: 50,
    total: 0,
    docs: [],
    columns: [],
    loading: false,
    error: null,
  };

  removeSingleCollTab(item.db, item.coll);

  splitState.panes.set(pId, newPane);

  if (!splitState.active || splitState.panes.size === 1 || !splitState.layout) {
    if (splitState.panes.size === 1 && state.db && state.coll) {
      const firstExistingId = nextPaneId();
      const firstPane = {
        id: firstExistingId,
        tabId: t ? t.id : tabId,
        db: state.db,
        coll: state.coll,
        filter: $('#filter-input')?.value || '',
        sort: $('#sort-input')?.value || '',
        queryMode: $('#query-mode')?.value || 'find',
        skip: state.skip || 0,
        limit: state.limit || 50,
        total: state.total || 0,
        docs: state.docs || [],
        columns: state.columns || [],
        loading: false,
        error: null,
      };

      removeSingleCollTab(firstPane.db, firstPane.coll);

      splitState.panes.set(firstExistingId, firstPane);
      splitState.panes.delete(pId);

      const pId2 = nextPaneId();
      newPane.id = pId2;
      splitState.panes.set(pId2, newPane);

      splitState.layout = createSplitTree(firstExistingId, pId2, dir);
      splitState.focusedPaneId = pId2;
    } else {
      splitState.layout = { type: 'pane', paneId: pId };
      splitState.focusedPaneId = pId;
    }
  } else if (targetPaneId && splitState.panes.has(targetPaneId)) {
    if (dir === 'center') {
      splitState.panes.set(targetPaneId, newPane);
      splitState.panes.delete(pId);
      splitState.focusedPaneId = targetPaneId;
      runPaneQuery(targetPaneId);
      renderSplitView();
      return;
    } else {
      splitState.layout = insertIntoTree(splitState.layout, targetPaneId, pId, dir);
      splitState.focusedPaneId = pId;
    }
  } else {
    const rootPaneId = Array.from(splitState.panes.keys())[0];
    splitState.layout = insertIntoTree(splitState.layout, rootPaneId, pId, 'right');
    splitState.focusedPaneId = pId;
  }

  splitState.active = splitState.panes.size > 1;

  ensureSplitCollTab();

  runPaneQuery(newPane.id);
  renderSplitView();

  import('./colltabs.js').then((m) => m.renderCollTabBar());
}

function createSplitTree(existingPaneId, newPaneId, dir) {
  const isHoriz = dir === 'right' || dir === 'left';
  const first = dir === 'left' || dir === 'top' ? newPaneId : existingPaneId;
  const second = dir === 'left' || dir === 'top' ? existingPaneId : newPaneId;

  return {
    type: isHoriz ? 'row' : 'col',
    children: [
      { type: 'pane', paneId: first },
      { type: 'pane', paneId: second },
    ],
  };
}

function insertIntoTree(node, targetPaneId, newPaneId, dir) {
  if (node.type === 'pane') {
    if (node.paneId === targetPaneId) {
      return createSplitTree(targetPaneId, newPaneId, dir);
    }
    return node;
  }

  if (node.children) {
    node.children = node.children.map((child) => insertIntoTree(child, targetPaneId, newPaneId, dir));
  }
  return node;
}

function removeFromTree(node, paneId) {
  if (node.type === 'pane') {
    return node.paneId === paneId ? null : node;
  }

  if (node.children) {
    node.children = node.children.map((child) => removeFromTree(child, paneId)).filter(Boolean);
    if (node.children.length === 1) {
      return node.children[0];
    }
  }
  return node;
}

export function closePane(paneId) {
  if (!splitState.panes.has(paneId)) return;
  splitState.panes.delete(paneId);

  if (splitState.panes.size <= 1) {
    closeSplitView();
    return;
  }

  splitState.layout = removeFromTree(splitState.layout, paneId);
  splitState.focusedPaneId = Array.from(splitState.panes.keys())[0] || null;
  renderSplitView();
}

export function closeSplitView() {
  splitState.active = false;
  splitState.layout = null;

  const t = activeTab();
  if (t) {
    const idx = t.state.collTabs.findIndex((c) => c.isSplitTab);
    if (idx >= 0) t.state.collTabs.splice(idx, 1);
  }

  splitState.panes.clear();
  splitState.focusedPaneId = null;

  deactivateSplitView();

  if (t && t.state.collTabs.length > 0) {
    const nextCt = t.state.collTabs[t.state.collTabs.length - 1];
    import('./colltabs.js').then((m) => m.switchCollTab(nextCt.id));
  } else {
    state.db = null;
    state.coll = null;
    if (t) t.state.activeCollId = null;
    import('./workspace.js').then((m) => m.renderWorkspace());
  }
}

let cachedWorkspaceHTML = '';
function getOriginalWorkspaceHTML() {
  if (!cachedWorkspaceHTML) {
    const ws = $('#workspace');
    if (ws) cachedWorkspaceHTML = ws.innerHTML;
  }
  return cachedWorkspaceHTML;
}

export function runPaneQuery(paneId, opts = {}) {
  const p = splitState.panes.get(paneId);
  if (!p || !p.db || !p.coll) return;

  p.loading = true;
  p.error = null;
  updatePaneUI(paneId);

  const connTab = tabs.list.find((t) => t.id === p.tabId) || activeTab();
  const payload = p.queryMode === 'aggregate'
    ? { db: p.db, coll: p.coll, pipeline: p.filter || '[]' }
    : { db: p.db, coll: p.coll, filter: p.filter, sort: p.sort, limit: p.limit, skip: p.skip };

  if (opts.auto) payload._bg = true;

  emitPaneQuery(p.tabId, `collection:${p.queryMode}`, payload)
    .then((res) => {
      p.docs = res.docs || [];
      p.columns = res.columns || [];
      p.total = res.total || 0;
      p.skip = res.skip || 0;
      p.limit = res.limit || 50;
      p.loading = false;
      updatePaneUI(paneId);
    })
    .catch((err) => {
      p.loading = false;
      p.error = err.message;
      updatePaneUI(paneId);
    });
}

function emitPaneQuery(tabId, event, payload) {
  return emit(event, { tabId, ...(payload || {}) });
}

export function renderSplitView() {
  const ws = $('#workspace');
  if (!ws) return;

  getOriginalWorkspaceHTML();
  ws.classList.add('split-active');
  $('#placeholder')?.classList.add('hidden');
  ws.classList.remove('hidden');
  ws.innerHTML = '';

  const headBar = document.createElement('div');
  headBar.className = 'split-global-header';
  headBar.innerHTML = `
    <div class="split-info">
      <span>🔲 <b>Area Split-View</b> (${splitState.panes.size} pannelli)</span>
    </div>
    <div class="split-global-actions">
      <button type="button" id="btn-compare-schemas" class="ghost" title="Confronta gli schemi delle tabelle tra i primi due pannelli">🔍 Confronta Schema</button>
      <button type="button" id="btn-close-split" class="ghost" title="Chiudi la vista affiancata e torna alla vista singola">✕ Chiudi Split-View</button>
    </div>
  `;
  ws.appendChild(headBar);

  headBar.querySelector('#btn-close-split').addEventListener('click', closeSplitView);
  headBar.querySelector('#btn-compare-schemas').addEventListener('click', comparePaneSchemas);

  const container = document.createElement('div');
  container.className = 'split-container';
  ws.appendChild(container);

  if (splitState.layout) {
    const layoutNode = renderLayoutNode(splitState.layout);
    container.appendChild(layoutNode);
  }

  splitState.panes.forEach((_, pId) => updatePaneUI(pId));
}

function renderLayoutNode(node) {
  if (node.type === 'pane') {
    return createPaneElement(node.paneId);
  }

  const el = document.createElement('div');
  el.className = node.type === 'row' ? 'split-layout-row' : 'split-layout-col';

  node.children.forEach((child, idx) => {
    if (idx > 0) {
      const resizer = document.createElement('div');
      resizer.className = node.type === 'row' ? 'split-resizer-v' : 'split-resizer-h';
      initResizerDrag(resizer, node.type);
      el.appendChild(resizer);
    }
    el.appendChild(renderLayoutNode(child));
  });

  return el;
}

function createPaneElement(paneId) {
  const p = splitState.panes.get(paneId);
  const connTab = tabs.list.find((t) => t.id === p.tabId);
  const connLabel = connTab ? connTab.label : 'Connessione';
  const dbType = connTab ? connTab.dbType : 'mongodb';
  const isSql = isSqlType(dbType);

  const paneEl = document.createElement('div');
  paneEl.className = 'split-pane' + (paneId === getFocusedPaneId() ? ' focused' : '');
  paneEl.dataset.paneId = paneId;

  paneEl.addEventListener('click', () => setFocusedPane(paneId));

  paneEl.innerHTML = `
    <div class="split-pane-head">
      <div class="split-pane-title">
        <span class="db-icon">${dbTypeIcon(dbType)}</span>
        <span class="conn-name" title="${esc(connLabel)}">${esc(connLabel)}</span>
        <span class="sep">▸</span>
        <select class="pane-db-select" title="Seleziona Database"></select>
        <span class="sep">▸</span>
        <select class="pane-coll-select" title="Seleziona Tabella/Collezione"></select>
      </div>
      <div class="split-pane-tools">
        <button type="button" class="pane-refresh-btn ghost" title="Ricarica">⟳</button>
        <button type="button" class="pane-close-btn ghost" title="Chiudi pannello">✕</button>
      </div>
    </div>

    <div class="split-pane-toolbar">
      <select class="pane-mode-select">
        <option value="find">find</option>
        <option value="aggregate">${isSql ? 'SQL Raw' : 'aggregate'}</option>
      </select>
      <input type="text" class="pane-filter-input" placeholder="${isSql ? 'Clausola WHERE...' : 'Filtro JSON...'}" value="${esc(p.filter)}" spellcheck="false" />
      <input type="text" class="pane-sort-input ${p.queryMode === 'aggregate' ? 'hidden' : ''}" placeholder="Sort..." value="${esc(p.sort)}" spellcheck="false" />
      <button type="button" class="pane-run-btn primary">▶ Esegui</button>
    </div>

    <div class="pane-error-banner hidden"></div>

    <div class="split-pane-body">
      <div class="pane-grid-wrap">
        <table class="pane-grid">
          <thead></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <div class="split-pane-statusbar">
      <span class="pane-result-info">0 righe</span>
      <span class="spacer"></span>
      <button type="button" class="pane-prev-btn ghost">‹ Prec</button>
      <span class="pane-page-info">1</span>
      <button type="button" class="pane-next-btn ghost">Succ ›</button>
    </div>
  `;

  const dbSelect = paneEl.querySelector('.pane-db-select');
  const collSelect = paneEl.querySelector('.pane-coll-select');

  if (connTab && connTab.state.databases) {
    dbSelect.innerHTML = connTab.state.databases
      .map((db) => `<option value="${esc(db.name)}" ${db.name === p.db ? 'selected' : ''}>${esc(db.name)}</option>`)
      .join('');
  } else {
    dbSelect.innerHTML = `<option value="${esc(p.db)}">${esc(p.db)}</option>`;
  }

  dbSelect.addEventListener('change', () => {
    p.db = dbSelect.value;
    p.skip = 0;
    fetchCollectionsForPane(paneId, p.db).then((colls) => {
      collSelect.innerHTML = colls
        .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`)
        .join('');
      if (colls.length > 0) {
        p.coll = colls[0];
        runPaneQuery(paneId);
      }
    });
  });

  fetchCollectionsForPane(paneId, p.db).then((colls) => {
    collSelect.innerHTML = colls
      .map((c) => `<option value="${esc(c)}" ${c === p.coll ? 'selected' : ''}>${esc(c)}</option>`)
      .join('');
  });

  collSelect.addEventListener('change', () => {
    p.coll = collSelect.value;
    p.skip = 0;
    runPaneQuery(paneId);
  });

  paneEl.querySelector('.pane-refresh-btn').addEventListener('click', () => runPaneQuery(paneId));
  paneEl.querySelector('.pane-close-btn').addEventListener('click', () => closePane(paneId));

  const filterInput = paneEl.querySelector('.pane-filter-input');
  const sortInput = paneEl.querySelector('.pane-sort-input');
  const modeSelect = paneEl.querySelector('.pane-mode-select');

  modeSelect.value = p.queryMode;
  modeSelect.addEventListener('change', () => {
    p.queryMode = modeSelect.value;
    sortInput.classList.toggle('hidden', p.queryMode === 'aggregate');
    runPaneQuery(paneId);
  });

  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      p.filter = filterInput.value;
      p.sort = sortInput.value;
      p.skip = 0;
      runPaneQuery(paneId);
    }
  });

  sortInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      p.filter = filterInput.value;
      p.sort = sortInput.value;
      p.skip = 0;
      runPaneQuery(paneId);
    }
  });

  paneEl.querySelector('.pane-run-btn').addEventListener('click', () => {
    p.filter = filterInput.value;
    p.sort = sortInput.value;
    p.skip = 0;
    runPaneQuery(paneId);
  });

  paneEl.querySelector('.pane-prev-btn').addEventListener('click', () => {
    if (p.skip >= p.limit) {
      p.skip -= p.limit;
      runPaneQuery(paneId);
    }
  });

  paneEl.querySelector('.pane-next-btn').addEventListener('click', () => {
    if (p.skip + p.limit < p.total) {
      p.skip += p.limit;
      runPaneQuery(paneId);
    }
  });

  return paneEl;
}

function fetchCollectionsForPane(paneId, dbName) {
  const p = splitState.panes.get(paneId);
  if (!p) return Promise.resolve([]);
  return emitPaneQuery(p.tabId, 'db:collections', { db: dbName })
    .then((res) => (res.collections || []).map((c) => (typeof c === 'string' ? c : c.name)))
    .catch(() => []);
}

function updatePaneUI(paneId) {
  const paneEl = document.querySelector(`.split-pane[data-pane-id="${paneId}"]`);
  if (!paneEl) return;

  const p = splitState.panes.get(paneId);
  if (!p) return;

  const errBanner = paneEl.querySelector('.pane-error-banner');
  if (p.error) {
    errBanner.textContent = p.error;
    errBanner.classList.remove('hidden');
  } else {
    errBanner.classList.add('hidden');
  }

  const thead = paneEl.querySelector('.pane-grid thead');
  const tbody = paneEl.querySelector('.pane-grid tbody');

  thead.innerHTML = '';
  tbody.innerHTML = '';

  if (p.loading) {
    tbody.innerHTML = '<tr><td colspan="100" class="pane-loading">Caricamento in corso...</td></tr>';
    return;
  }

  if (!p.docs || p.docs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="100" class="pane-empty">Nessun documento o riga trovata.</td></tr>';
  } else {
    const cols = p.columns && p.columns.length ? p.columns : Array.from(new Set(p.docs.flatMap(Object.keys)));
    
    const trHead = document.createElement('tr');
    trHead.innerHTML = '<th class="row-num-col">#</th>' + cols.map((c) => `<th>${esc(c)}</th>`).join('');
    thead.appendChild(trHead);

    p.docs.forEach((doc, idx) => {
      const tr = document.createElement('tr');
      let rowHtml = `<td class="row-num-col">${p.skip + idx + 1}</td>`;

      cols.forEach((col) => {
        const val = doc[col];
        const disp = displayValue(val);
        rowHtml += `<td class="${disp.cls}">${esc(disp.text)}</td>`;
      });

      tr.innerHTML = rowHtml;
      tbody.appendChild(tr);
    });
  }

  const pageInfo = paneEl.querySelector('.pane-page-info');
  const resultInfo = paneEl.querySelector('.pane-result-info');
  const prevBtn = paneEl.querySelector('.pane-prev-btn');
  const nextBtn = paneEl.querySelector('.pane-next-btn');

  const currPage = Math.floor(p.skip / p.limit) + 1;
  const totalPages = Math.ceil(p.total / p.limit) || 1;

  if (pageInfo) pageInfo.textContent = `${currPage} / ${totalPages}`;
  if (resultInfo) resultInfo.textContent = `${p.total} ${p.total === 1 ? 'riga' : 'righe'}`;
  if (prevBtn) prevBtn.disabled = p.skip <= 0;
  if (nextBtn) nextBtn.disabled = p.skip + p.limit >= p.total;
}

function initResizerDrag(resizer, layoutType) {
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const prevEl = resizer.previousElementSibling;
    const nextEl = resizer.nextElementSibling;
    if (!prevEl || !nextEl) return;

    const isRow = layoutType === 'row';
    const startPos = isRow ? e.clientX : e.clientY;
    const prevSize = isRow ? prevEl.getBoundingClientRect().width : prevEl.getBoundingClientRect().height;

    resizer.classList.add('dragging');

    const onMove = (ev) => {
      const delta = (isRow ? ev.clientX : ev.clientY) - startPos;
      const newSize = Math.max(100, prevSize + delta);
      if (isRow) prevEl.style.width = `${newSize}px`;
      else prevEl.style.height = `${newSize}px`;
    };

    const onUp = () => {
      resizer.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function comparePaneSchemas() {
  const panes = Array.from(splitState.panes.values());
  if (panes.length < 2) {
    alert('Apri almeno due pannelli nello Split View per confrontare i loro schemi.');
    return;
  }

  const p1 = panes[0];
  const p2 = panes[1];

  const cols1 = p1.columns && p1.columns.length ? p1.columns : Array.from(new Set(p1.docs.flatMap(Object.keys)));
  const cols2 = p2.columns && p2.columns.length ? p2.columns : Array.from(new Set(p2.docs.flatMap(Object.keys)));

  const set1 = new Set(cols1);
  const set2 = new Set(cols2);

  const common = cols1.filter((c) => set2.has(c));
  const onlyP1 = cols1.filter((c) => !set2.has(c));
  const onlyP2 = cols2.filter((c) => !set1.has(c));

  let modal = $('#compare-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'compare-modal';
    modal.className = 'overlay';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div class="modal compare-dialog">
      <h2>🔍 Confronto Schema Tabelle</h2>
      <p class="subtitle">Confronto dei campi tra <b>${esc(p1.db)} ▸ ${esc(p1.coll)}</b> e <b>${esc(p2.db)} ▸ ${esc(p2.coll)}</b></p>
      
      <div class="compare-stats">
        <div class="stat-card common">
          <div class="stat-num">${common.length}</div>
          <div class="stat-lbl">Campi In Comune</div>
        </div>
        <div class="stat-card p1">
          <div class="stat-num">${onlyP1.length}</div>
          <div class="stat-lbl">Solo in ${esc(p1.coll)}</div>
        </div>
        <div class="stat-card p2">
          <div class="stat-num">${onlyP2.length}</div>
          <div class="stat-lbl">Solo in ${esc(p2.coll)}</div>
        </div>
      </div>

      <div class="compare-tables">
        <h3>Campi in Comune (${common.length})</h3>
        <ul class="field-list common-list">
          ${common.map((f) => `<li><span class="badge match">✓</span> ${esc(f)}</li>`).join('') || '<li>Nessun campo in comune</li>'}
        </ul>

        <div class="diff-flex">
          <div class="diff-col">
            <h3>Solo in ${esc(p1.coll)} (${onlyP1.length})</h3>
            <ul class="field-list p1-list">
              ${onlyP1.map((f) => `<li><span class="badge diff">−</span> ${esc(f)}</li>`).join('') || '<li>Nessun campo esclusivo</li>'}
            </ul>
          </div>

          <div class="diff-col">
            <h3>Solo in ${esc(p2.coll)} (${onlyP2.length})</h3>
            <ul class="field-list p2-list">
              ${onlyP2.map((f) => `<li><span class="badge diff">+</span> ${esc(f)}</li>`).join('') || '<li>Nessun campo esclusivo</li>'}
            </ul>
          </div>
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="primary close-compare-btn">Chiudi</button>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');
  modal.querySelector('.close-compare-btn').addEventListener('click', () => modal.classList.add('hidden'));
}
