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

function save() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pendingQueries));
  } catch (err) {
    console.warn('[PendingQueries] Errore nel salvataggio in sessionStorage:', err);
  }
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
  removePendingQuery(id);
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

export function renderPendingModalList() {
  const listEl = $('#pending-queries-list');
  if (!listEl) return;

  const items = listPending();
  if (items.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <p class="sub-text">Nessuna query in sospeso. Le query completate vengono rimosse automaticamente.</p>
      </div>
    `;
    return;
  }

  // Il primo elemento della lista è il punto di stop (la query più recente non completata)
  const firstUnresolvedIndex = 0;

  let html = '';
  items.forEach((item, index) => {
    const isStopPoint = index === firstUnresolvedIndex;
    const dateStr = item.startedAt ? new Date(item.startedAt).toLocaleTimeString() : '';
    const durationStr = item.elapsedMs != null
      ? `${item.elapsedMs} ms`
      : item.status === 'running'
        ? `in esecuzione da ${Math.round((Date.now() - item.startedAt) / 1000)}s`
        : '-';

    html += `
      <div class="pending-item ${isStopPoint ? 'pending-stop-point' : ''}" data-id="${esc(item.id)}">
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

        ${item.error ? `<div class="pending-error">⚠️ ${esc(item.error)}</div>` : ''}

        <div class="pending-code-wrap">
          <pre class="pending-code"><code>${esc(item.code)}</code></pre>
        </div>

        <div class="pending-actions">
          <button type="button" class="btn btn-sm btn-primary btn-resume-pending" data-id="${esc(item.id)}">▶ Riprendi</button>
          <button type="button" class="btn btn-sm btn-secondary btn-copy-pending" data-code="${esc(item.code)}">📋 Copia</button>
          <button type="button" class="btn btn-sm btn-secondary btn-resolve-pending" data-id="${esc(item.id)}">✔ Segna risolta</button>
          <button type="button" class="btn btn-sm btn-danger btn-remove-pending" data-id="${esc(item.id)}">🗑 Rimuovi</button>
        </div>
      </div>
    `;
  });

  listEl.innerHTML = html;

  // Binding eventi lista
  listEl.querySelectorAll('.btn-resume-pending').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      resumePendingQuery(id);
    });
  });

  listEl.querySelectorAll('.btn-copy-pending').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.getAttribute('data-code');
      if (code) {
        navigator.clipboard.writeText(code).then(() => {
          toast('Codice query copiato negli appunti');
        }).catch(() => {
          toast('Impossibile copiare negli appunti', true);
        });
      }
    });
  });

  listEl.querySelectorAll('.btn-resolve-pending').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      markResolvedPending(id);
    });
  });

  listEl.querySelectorAll('.btn-remove-pending').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      removePending(id);
    });
  });
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

  // Auto update listener per modale e badge
  onChange(() => {
    renderPendingModalList();
  });

  // Bottone topbar
  const btnTop = $('#btn-pending-queries');
  const modal = $('#modal-pending');
  const closeBtn = $('#btn-close-pending-modal');
  const clearResolvedBtn = $('#btn-clear-resolved-pending');

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

  updateBadge();
}
