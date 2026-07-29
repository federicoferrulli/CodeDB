import { $, esc, toast } from './utils.js';
import { socket } from './socket.js';
import { tabs, switchTab, activeTab } from './tabs.js';
import { switchCollTab, openCollTab } from './colltabs.js';
import { runQuery } from './query-tab.js';

const STORAGE_KEY = 'codedb:pending';

let pendingQueries = [];
const listeners = [];

function load() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Al reload/F5 le query in volo diventano 'disconnected'
        pendingQueries = parsed.map((q) => {
          if (q.status === 'running') {
            return {
              ...q,
              status: 'disconnected',
              endedAt: q.endedAt || Date.now(),
              elapsedMs: q.elapsedMs || (Date.now() - (q.startedAt || Date.now()))
            };
          }
          return q;
        });
      }
    }
  } catch (err) {
    console.warn('[PendingQueries] Errore nel caricamento da sessionStorage:', err);
    pendingQueries = [];
  }
}

let saveTimer = 0;
function flushSave() {
  saveTimer = 0;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pendingQueries));
  } catch (err) {
    console.warn('[PendingQueries] Errore nel salvataggio in sessionStorage:', err);
  }
}

function save() {
  // Coalesce le scritture ravvicinate: sessionStorage è sincrono e serializza
  // l'intero array a ogni evento di query, meglio non farlo sul percorso critico.
  if (saveTimer) return;
  saveTimer = setTimeout(flushSave, 200);
}

// Il modale è pesante da ridisegnare: quando è chiuso non serve toccarne il DOM.
function isPendingModalOpen() {
  const modal = $('#modal-pending');
  return !!modal && !modal.classList.contains('hidden');
}

function notify() {
  updateBadge();
  listeners.forEach((fn) => {
    try {
      fn(pendingQueries);
    } catch (e) {
      console.error('[PendingQueries] Errore callback listener:', e);
    }
  });
}

export function onChange(cb) {
  if (typeof cb === 'function') listeners.push(cb);
}

export function listPending() {
  return [...pendingQueries].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export function getPendingCount() {
  return pendingQueries.length;
}

export function trackPending(meta) {
  const id = meta.runId || (Date.now() + '-' + Math.random().toString(36).slice(2));
  const item = {
    id,
    runId: id,
    code: String(meta.code || '').trim(),
    engine: meta.engine || 'auto',
    db: meta.db || '',
    coll: meta.coll || '',
    connName: meta.connName || '',
    tabId: meta.tabId || null,
    collTabId: meta.collTabId || null,
    startedAt: Date.now(),
    endedAt: null,
    elapsedMs: null,
    status: 'running',
    error: null
  };

  pendingQueries.unshift(item);
  save();
  notify();

  return {
    id,
    done(_res, _elapsedMs) {
      // Query completata con successo: rimossa automaticamente dal registro.
      const idx = pendingQueries.findIndex((x) => x.id === id);
      if (idx !== -1 && pendingQueries[idx].status === 'running') {
        pendingQueries.splice(idx, 1);
        save();
        notify();
      }
    },
    fail(err, elapsedMs) {
      const q = pendingQueries.find((x) => x.id === id);
      if (q && q.status === 'running') {
        q.status = 'error';
        q.error = (err && err.message) || String(err || 'Errore durante l\'esecuzione');
        q.endedAt = Date.now();
        q.elapsedMs = elapsedMs != null ? elapsedMs : (q.endedAt - q.startedAt);
        save();
        notify();
      }
    }
  };
}

export function markPaused(runId) {
  const q = pendingQueries.find((x) => x.runId === runId || x.id === runId);
  if (q && q.status === 'running') {
    q.status = 'paused';
    q.endedAt = Date.now();
    q.elapsedMs = q.endedAt - q.startedAt;
    save();
    notify();
  }
}

export function markDisconnectedAllRunning() {
  let changed = false;
  const now = Date.now();
  for (const q of pendingQueries) {
    if (q.status === 'running') {
      q.status = 'disconnected';
      q.endedAt = now;
      q.elapsedMs = now - q.startedAt;
      changed = true;
    }
  }
  if (changed) {
    save();
    notify();
  }
}

export function markAbandonedByTab(tabId) {
  let changed = false;
  const now = Date.now();
  for (const q of pendingQueries) {
    if (q.tabId === tabId && q.status === 'running') {
      q.status = 'abbandonata';
      q.endedAt = now;
      q.elapsedMs = now - q.startedAt;
      changed = true;
    }
  }
  if (changed) {
    save();
    notify();
  }
}

export function markAbandonedByCollTab(collTabId) {
  let changed = false;
  const now = Date.now();
  for (const q of pendingQueries) {
    if (q.collTabId === collTabId && q.status === 'running') {
      q.status = 'abbandonata';
      q.endedAt = now;
      q.elapsedMs = now - q.startedAt;
      changed = true;
    }
  }
  if (changed) {
    save();
    notify();
  }
}

export function removePending(id) {
  const idx = pendingQueries.findIndex((x) => x.id === id);
  if (idx >= 0) {
    pendingQueries.splice(idx, 1);
    save();
    notify();
  }
}

export function clearResolvedPending() {
  // Le completate non sono mai nel registro; rimuove le abbandonata/errore/disconnected/paused già viste.
  const before = pendingQueries.length;
  pendingQueries = pendingQueries.filter((q) => q.status === 'running');
  if (pendingQueries.length !== before) {
    save();
    notify();
  }
}

export function markResolvedPending(id) {
  // "Segna risolta" rimuove la voce dal registro.
  removePending(id);
}

export function updateBadge() {
  const btn = $('#btn-pending-queries');
  const badge = $('#pending-queries-badge');
  const count = getPendingCount();

  if (badge) {
    badge.textContent = count;
    if (count > 0) {
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  if (btn) {
    btn.classList.remove('hidden');
  }
}

function getStatusBadgeHtml(status) {
  switch (status) {
    case 'running':
      return `<span class="badge-status status-running">⏳ In esecuzione</span>`;
    case 'error':
      return `<span class="badge-status status-error">❌ Errore</span>`;
    case 'paused':
      return `<span class="badge-status status-paused">🛑 In pausa / Annullata</span>`;
    case 'disconnected':
      return `<span class="badge-status status-disconnected">🔌 Disconnessa</span>`;
    case 'abbandonata':
      return `<span class="badge-status status-abandoned">🚪 Abbandonata</span>`;
    default:
      return `<span class="badge-status">${esc(status)}</span>`;
  }
}

export function clearAllPending() {
  pendingQueries = [];
  save();
  notify();
}

const PENDING_OVERSCAN = 3;
let currentPendingItems = [];
let activeFilteredItems = [];
let yPositions = [];
let pendingVScrollAttached = false;
let lastRenderedStart = -1;
let lastRenderedEnd = -1;

function getItemHeight(item) {
  // Se la scheda contiene un banner di errore, richiede maggiore altezza (185px vs 145px)
  return item && item.error ? 185 : 145;
}

function computeYPositions(items) {
  const N = items.length;
  yPositions = new Array(N + 1);
  yPositions[0] = 0;
  for (let i = 0; i < N; i++) {
    yPositions[i + 1] = yPositions[i] + getItemHeight(items[i]);
  }
}

function findStartIndex(scrollTop) {
  let low = 0;
  let high = activeFilteredItems.length - 1;
  let ans = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (yPositions[mid + 1] > scrollTop) {
      ans = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return ans;
}

function findEndIndex(bottomY) {
  let low = 0;
  let high = activeFilteredItems.length - 1;
  let ans = activeFilteredItems.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (yPositions[mid] < bottomY) {
      ans = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return ans;
}

// Nodi riciclati durante lo scroll: teniamo un container persistente e una
// mappa index→card, così scrollando ricicliamo (aggiungiamo/togliamo solo il
// delta) invece di riparsare l'innerHTML di tutte le card visibili ogni frame.
let vContentEl = null;
const renderedCards = new Map();

export function forceResetVScroll() {
  lastRenderedStart = -1;
  lastRenderedEnd = -1;
  // Il set di dati è cambiato: scarta i nodi riciclati e ricostruisci il container.
  vContentEl = null;
  renderedCards.clear();
}

function buildPendingCard(item, index) {
  const isStopPoint = index === 0 && !$('#pending-search-input')?.value.trim();
  const dateStr = item.startedAt ? new Date(item.startedAt).toLocaleTimeString() : '';
  const durationStr = item.elapsedMs != null
    ? `${item.elapsedMs} ms`
    : item.status === 'running'
      ? `in esecuzione da ${Math.round((Date.now() - item.startedAt) / 1000)}s`
      : '-';

  const itemH = getItemHeight(item);
  const topY = yPositions[index] || (index * 150);

  const card = document.createElement('div');
  card.className = `pending-item ${isStopPoint ? 'pending-stop-point' : ''}`;
  card.style.position = 'absolute';
  card.style.top = `${topY}px`;
  card.style.left = '0';
  card.style.right = '0';
  card.style.height = `${itemH - 10}px`;
  card.setAttribute('data-id', item.id);

  card.innerHTML = `
      <div class="pending-item-header">
        <div class="pending-item-title">
          ${isStopPoint ? '<span class="badge-stop-point" title="Punto in cui l\'esecuzione si è fermata">📍 DA QUI CI SI È FERMATI</span>' : ''}
          <span class="pending-engine">${esc((item.engine || 'auto').toUpperCase())}</span>
          <span class="pending-target">${esc(item.connName || 'Connessione')} → ${esc(item.db || '-')}${item.coll ? '.' + esc(item.coll) : ''}</span>
        </div>
        <div class="pending-item-meta">
          ${getStatusBadgeHtml(item.status)}
          <span class="pending-time">⏱ ${dateStr} (${durationStr})</span>
        </div>
      </div>

      ${item.error ? `<div class="pending-error" title="${esc(item.error)}">⚠️ ${esc(item.error)}</div>` : ''}

      <div class="pending-code-wrap">
        <pre class="pending-code"><code>${esc(item.code)}</code></pre>
      </div>

      <div class="pending-actions">
        <button type="button" class="btn btn-sm btn-primary btn-resume-pending" data-id="${esc(item.id)}">▶ Riprendi</button>
        <button type="button" class="btn btn-sm btn-secondary btn-copy-pending" data-id="${esc(item.id)}">📋 Copia</button>
        <button type="button" class="btn btn-sm btn-secondary btn-resolve-pending" data-id="${esc(item.id)}">✔ Segna risolta</button>
        <button type="button" class="btn btn-sm btn-danger btn-remove-pending" data-id="${esc(item.id)}">🗑 Rimuovi</button>
      </div>
    `;

  return card;
}

export function renderPendingVirtualWindow() {
  const listEl = $('#pending-queries-list');
  if (!listEl) return;

  const items = activeFilteredItems;
  const N = items.length;

  if (N === 0) {
    lastRenderedStart = -1;
    lastRenderedEnd = -1;
    vContentEl = null;
    renderedCards.clear();
    listEl.innerHTML = `
      <div class="empty-state">
        <p class="sub-text">Nessuna query in sospeso o corrispondente alla ricerca.</p>
      </div>
    `;
    return;
  }

  const viewport = listEl.clientHeight || 450;
  const scrollTop = listEl.scrollTop || 0;
  const rawStart = findStartIndex(scrollTop);
  const rawEnd = findEndIndex(scrollTop + viewport);

  const start = Math.max(0, rawStart - PENDING_OVERSCAN);
  const end = Math.min(N, rawEnd + 1 + PENDING_OVERSCAN);

  // Ottimizzazione 60fps: se la finestra visibile non è cambiata, salta il re-render DOM (0 ms di lavoro)
  if (start === lastRenderedStart && end === lastRenderedEnd && vContentEl && vContentEl.isConnected) {
    return;
  }

  lastRenderedStart = start;
  lastRenderedEnd = end;

  const totalHeight = yPositions[N] || (N * 150);

  // Crea il container spacer una sola volta e riusalo tra i frame.
  if (!vContentEl || !vContentEl.isConnected) {
    vContentEl = document.createElement('div');
    vContentEl.className = 'pending-vscroll-content';
    vContentEl.style.position = 'relative';
    vContentEl.style.width = '100%';
    renderedCards.clear();
    listEl.innerHTML = '';
    listEl.appendChild(vContentEl);
  }
  vContentEl.style.height = `${totalHeight}px`;

  // Rimuovi solo le card uscite dalla finestra visibile.
  for (const [index, card] of renderedCards) {
    if (index < start || index >= end) {
      card.remove();
      renderedCards.delete(index);
    }
  }

  // Aggiungi solo le card entrate: quelle già presenti restano intatte (0 reparse).
  for (let index = start; index < end; index++) {
    if (renderedCards.has(index)) continue;
    const card = buildPendingCard(items[index], index);
    renderedCards.set(index, card);
    vContentEl.appendChild(card);
  }
}

export function filterPendingModalList() {
  const input = $('#pending-search-input');
  const term = input ? input.value.trim().toLowerCase() : '';

  if (!term) {
    activeFilteredItems = currentPendingItems;
  } else {
    activeFilteredItems = currentPendingItems.filter((item) => {
      const codeMatch = (item.code || '').toLowerCase().includes(term);
      const dbMatch = (item.db || '').toLowerCase().includes(term);
      const collMatch = (item.coll || '').toLowerCase().includes(term);
      const connMatch = (item.connName || '').toLowerCase().includes(term);
      const engineMatch = (item.engine || '').toLowerCase().includes(term);
      const statusMatch = (item.status || '').toLowerCase().includes(term);
      const errorMatch = (item.error || '').toLowerCase().includes(term);
      return codeMatch || dbMatch || collMatch || connMatch || engineMatch || statusMatch || errorMatch;
    });
  }

  computeYPositions(activeFilteredItems);
  forceResetVScroll();
  renderPendingVirtualWindow();
}

function attachPendingVScroll() {
  const listEl = $('#pending-queries-list');
  if (!listEl || pendingVScrollAttached) return;
  pendingVScrollAttached = true;

  let raf = 0;
  listEl.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(renderPendingVirtualWindow);
  });

  // Event Delegation per i pulsanti di azione nella lista virtualizzata
  listEl.addEventListener('click', (e) => {
    const resumeBtn = e.target.closest('.btn-resume-pending');
    if (resumeBtn) {
      const id = resumeBtn.getAttribute('data-id');
      if (id) resumePendingQuery(id);
      return;
    }

    const copyBtn = e.target.closest('.btn-copy-pending');
    if (copyBtn) {
      const id = copyBtn.getAttribute('data-id');
      const item = currentPendingItems.find((x) => x.id === id);
      if (item && item.code) {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(item.code).then(() => {
            toast('Codice query copiato negli appunti');
          }).catch(() => {
            toast('Impossibile copiare negli appunti', true);
          });
        }
      }
      return;
    }

    const resolveBtn = e.target.closest('.btn-resolve-pending');
    if (resolveBtn) {
      const id = resolveBtn.getAttribute('data-id');
      if (id) markResolvedPending(id);
      return;
    }

    const removeBtn = e.target.closest('.btn-remove-pending');
    if (removeBtn) {
      const id = removeBtn.getAttribute('data-id');
      if (id) removePending(id);
      return;
    }
  });
}

export function renderPendingModalList() {
  const listEl = $('#pending-queries-list');
  if (!listEl) return;

  currentPendingItems = listPending();
  filterPendingModalList();
  attachPendingVScroll();
}

export function resumePendingQuery(id) {
  const item = pendingQueries.find((x) => x.id === id);
  if (!item) return;

  // 1. Attiva il tab di connessione se esiste
  if (item.tabId && tabs.list.some((t) => t.id === item.tabId)) {
    switchTab(item.tabId);
  }

  // 2. Se c'è un collTabId o db/coll, caricalo se esiste
  const curTab = activeTab();
  if (curTab) {
    if (item.collTabId && curTab.state.collTabs.some((c) => c.id === item.collTabId)) {
      switchCollTab(item.collTabId);
    } else if (item.db && item.coll) {
      openCollTab(item.db, item.coll);
    }
  }

  // 3. Riempi l'editor della query
  const editorInput = $('#query-editor-input');
  if (editorInput) {
    editorInput.value = item.code;
  }

  const engineSelect = $('#query-target-engine');
  if (engineSelect && item.engine) {
    engineSelect.value = item.engine;
  }

  // 4. Chiudi il modale
  const modal = $('#modal-pending');
  if (modal) modal.classList.add('hidden');

  // 5. Rilancia la query
  toast('Ripristino query nell\'editor ed esecuzione...');
  setTimeout(() => {
    runQuery();
  }, 100);
}

export function initPendingQueries() {
  load();

  // Socket disconnect hook
  if (socket) {
    socket.on('disconnect', () => {
      markDisconnectedAllRunning();
    });
  }

  // Auto update listener: il badge è già aggiornato da notify().
  // Ridisegniamo la lista solo se il modale è aperto (a modale chiuso
  // il DOM virtualizzato non è visibile: ridisegnarlo è puro spreco).
  onChange(() => {
    if (isPendingModalOpen()) renderPendingModalList();
  });

  // Non perdere lo stato in sospeso se la scrittura è ancora in coda al reload.
  window.addEventListener('pagehide', flushSave);
  window.addEventListener('beforeunload', flushSave);

  // Bottone topbar & modale
  const btnTop = $('#btn-pending-queries');
  const modal = $('#modal-pending');
  const closeBtn = $('#btn-close-pending-modal');
  const clearResolvedBtn = $('#btn-clear-resolved-pending');
  const clearAllBtn = $('#btn-clear-all-pending');
  const searchInput = $('#pending-search-input');

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      filterPendingModalList();
    });
  }

  if (btnTop && modal) {
    btnTop.addEventListener('click', () => {
      renderPendingModalList();
      modal.classList.remove('hidden');
    });
  }

  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
    });
  }

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  }

  if (clearResolvedBtn) {
    clearResolvedBtn.addEventListener('click', () => {
      clearResolvedPending();
      toast('Query completate rimosse dallo storico recente');
    });
  }

  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
      clearAllPending();
      toast('Tutte le query in sospeso e lo storico sono stati svuotati');
    });
  }

  updateBadge();
}
