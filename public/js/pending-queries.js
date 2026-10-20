import { chiediConferma } from './conferma.js';
import { mountArcControls, renderDataEmpty } from '../arc/ui.js';
import { $, esc, toast, lucideIconHtml as ICO, refreshLucideIcons } from './utils.js';
import { socket } from './socket.js';
import { tabs, switchTab, activeTab, allaChiusura } from './tabs.js';
import { switchCollTab, openCollTab, openDbTab } from './colltabs.js';
import { runQuery, updateEditorHighlight, setQueryTarget } from './query-tab.js';
import { queryDocument } from './query-document.js';
import { setView } from './main.js';
import { knowsScriptRun, focusScriptRun, resumeScript } from './script-run.js';

const STORAGE_KEY = 'codedb:pending';
const ospite = typeof window !== 'undefined' ? window.frameElement?.codedbPanel : null;

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

/**
 * Tetto alle voci conservate (CDB-73).
 *
 * Le query riuscite si tolgono da sole; quelle FALLITE restano — ed è voluto,
 * sono quelle che l'utente deve poter ritrovare — ma nulla le limitava. Ogni
 * voce porta con sé il testo della query e finisce in `sessionStorage`, che ha
 * un tetto di pochi MB: superato quello, il salvataggio falliva in silenzio (un
 * `console.warn` che nessuno legge) e il registro smetteva di sopravvivere ai
 * refresh. Si conservano le più recenti, che sono quelle che servono.
 */
const MAX_VOCI_REGISTRO = 100;

function potaRegistro() {
  if (pendingQueries.length <= MAX_VOCI_REGISTRO) return;
  // Le voci ancora in corso non si buttano MAI: sono lo stato di un'operazione
  // viva, non uno storico.
  const inCorso = pendingQueries.filter((q) => q.status === 'running');
  const concluse = pendingQueries.filter((q) => q.status !== 'running');
  const tenute = concluse.slice(0, Math.max(MAX_VOCI_REGISTRO - inCorso.length, 0));
  pendingQueries.length = 0;
  // Si ricompone rispettando l'ordine originale (le più recenti in testa).
  pendingQueries.push(...[...inCorso, ...tenute].sort((a, b) => b.startedAt - a.startedAt));
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
  if (ospite) return ospite.pending.trackPending({ ...meta, paneId: ospite.paneId, connName: ospite.label });
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
    paneId: meta.paneId || null,
    startedAt: Date.now(),
    endedAt: null,
    elapsedMs: null,
    status: 'running',
    error: null,
    // Uno SCRIPT è una query in sospeso come le altre, ma con un avanzamento:
    // `kind` distingue le due forme e i contatori alimentano la barra di
    // progresso nella scheda del registro.
    kind: meta.kind === 'script' ? 'script' : 'query',
    total: meta.total || 0,
    cursor: 0,
    eseguiti: 0,
    falliti: 0
  };

  pendingQueries.unshift(item);
  potaRegistro();
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

/**
 * Aggiorna la voce di uno SCRIPT con lo stato che arriva dal server
 * (`script:progress`). Uno script completato SENZA errori sparisce dal
 * registro come una query riuscita; se qualcosa è fallito resta, perché è
 * proprio quello che l'utente deve poter ritrovare.
 */
export function updateScriptProgress(runId, stato) {
  if (ospite) return ospite.pending.updateScriptProgress(runId, stato);
  const q = pendingQueries.find((x) => x.runId === runId || x.id === runId);
  if (!q || !stato) return;

  q.total = stato.total != null ? stato.total : q.total;
  q.cursor = stato.cursor != null ? stato.cursor : q.cursor;
  q.eseguiti = stato.eseguiti != null ? stato.eseguiti : q.eseguiti;
  q.falliti = stato.falliti != null ? stato.falliti : q.falliti;

  if (stato.status === 'running') {
    q.status = 'running';
  } else if (stato.status === 'paused') {
    q.status = 'paused';
  } else if (stato.status === 'aborted') {
    q.status = 'abbandonata';
    q.endedAt = Date.now();
    q.elapsedMs = q.endedAt - q.startedAt;
  } else if (stato.status === 'done') {
    q.endedAt = Date.now();
    q.elapsedMs = q.endedAt - q.startedAt;
    if (q.falliti) {
      q.status = 'error';
      const primo = (stato.results || []).find((r) => !r.ok && !r.interrupted);
      q.error = `${q.falliti} istruzioni fallite${primo ? ` — riga ${primo.line}: ${primo.error}` : ''}`;
    } else {
      const idx = pendingQueries.findIndex((x) => x.id === q.id);
      if (idx !== -1) pendingQueries.splice(idx, 1);
    }
  }

  save();
  notify();
}

export function markPaused(runId) {
  if (ospite) return ospite.pending.markPaused(runId);
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

// Chiudere un tab abbandona le sue query in corso. La registrazione sta qui e
// non in tabs.js perche' e' questo pannello ad avere qualcosa da chiudere: un
// modulo di base non deve conoscere i pannelli che lo osservano.
allaChiusura((tabId) => markAbandonedByTab(tabId));

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
  if (ospite) return ospite.pending.removePending(id);
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
      return `<span class="badge-status status-running">${ICO('hourglass')} In esecuzione</span>`;
    case 'error':
      return `<span class="badge-status status-error">${ICO('circle-x')} Errore</span>`;
    case 'paused':
      return `<span class="badge-status status-paused">${ICO('pause')} In pausa / Annullata</span>`;
    case 'disconnected':
      return `<span class="badge-status status-disconnected">${ICO('unplug')} Disconnessa</span>`;
    case 'abbandonata':
      return `<span class="badge-status status-abandoned">${ICO('log-out')} Abbandonata</span>`;
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
let selectedPendingId = null;
let pendingFilter = 'all';

function getItemHeight() {
  // Il registro mostra solo il riepilogo; codice ed errori hanno spazio nel dettaglio.
  return 106;
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

// Avanzamento di uno script: è l'informazione che rende utile la ripresa —
// senza, "riprendi" non direbbe da dove.
function buildScriptProgressHtml(item) {
  const total = item.total || 0;
  const eseguiti = Math.min(item.eseguiti || 0, total);
  const pct = total ? Math.round((eseguiti / total) * 100) : 0;
  const daDove = item.status === 'paused' && total
    ? ` — riprende dall'istruzione ${Math.min((item.cursor || 0) + 1, total)}`
    : '';
  return `
      <div class="pending-script-progress">
        <div class="pending-progress-track" role="progressbar" aria-label="Avanzamento script" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="pending-progress-fill" style="width:${pct}%"></div></div>
        <span class="pending-progress-text">${ICO('scroll-text')} ${eseguiti}/${total} istruzioni${item.falliti ? ` · ${item.falliti} errori` : ''}${daDove}</span>
      </div>`;
}

function buildPendingCard(item, index) {
  const itemH = getItemHeight(item);
  const card = document.createElement('div');
  card.className = 'pending-item';
  card.id = `pending-row-${index}`;
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', String(item.id === selectedPendingId));
  card.setAttribute('data-id', item.id);
  card.style.position = 'absolute';
  card.style.top = `${yPositions[index]}px`;
  card.style.left = '0';
  card.style.right = '0';
  card.style.height = `${itemH - 6}px`;
  card.innerHTML = `
      <div class="pending-row-top"><span class="pending-row-connection" title="${esc(item.connName || 'Connessione')}">${esc(item.connName || 'Connessione')}</span><time>${item.startedAt ? new Date(item.startedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '—'}</time></div>
      <strong class="pending-row-target" title="${esc([item.db, item.coll].filter(Boolean).join(' / '))}">${esc([item.db, item.coll].filter(Boolean).join(' / ') || 'Query senza database')}</strong>
      <span class="pending-row-code">${esc(item.code || 'Query vuota')}</span>
      <div class="pending-row-status">${getStatusBadgeHtml(item.status)}${item.kind === 'script' ? '<span>Script</span>' : ''}</div>`;
  return card;
}

function renderPendingDetail(animate = false) {
  const detail = $('#pending-detail');
  if (!detail) return;
  const restoreFocus = detail.contains(document.activeElement);
  renderDataEmpty(detail, null);
  const item = activeFilteredItems.find(q => q.id === selectedPendingId);
  if (!item) {
    const empty = !currentPendingItems.length;
    detail.replaceChildren();
    renderDataEmpty(detail, {
      kind: empty ? 'query' : 'search', title: empty ? 'Tutto in ordine' : 'Nessuna corrispondenza',
      description: empty ? 'Le query completate escono dal registro. Qui ritroverai quelle in corso o da riprendere.' : 'Prova un altro termine o scegli un filtro diverso.',
    });
    detail.querySelector('h3').tabIndex = -1;
  } else {
    const latest = currentPendingItems.find(q => q.status !== 'running')?.id === item.id;
    const editorOnly = item.status === 'running' || (item.kind === 'script' && !knowsScriptRun(item.runId));
    const date = item.startedAt ? new Date(item.startedAt).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    const duration = item.elapsedMs != null ? ` · ${item.elapsedMs} ms` : '';
    detail.innerHTML = `
      <div class="pending-detail-heading">
        <button type="button" class="ghost pending-back">${ICO('arrow-left')} Registro</button>
        <div class="pending-detail-status">${getStatusBadgeHtml(item.status)}${latest ? `<span class="pending-latest">${ICO('map-pin')} Ultima interruzione</span>` : ''}</div>
        <h3 tabindex="-1">${esc(item.coll || item.db || 'Query senza database')}</h3>
        <div class="pending-detail-context">${ICO('database')}<span>${esc(item.connName || 'Connessione')}<span aria-hidden="true"> / </span>${esc(item.db || '—')}</span><span class="pending-engine">${esc((item.engine || 'auto').toUpperCase())}</span></div>
        <p class="pending-time">${ICO('clock')} ${esc(date + duration)}</p>
      </div>
      ${item.error ? `<div class="pending-error">${ICO('circle-alert')}<div><strong>Da correggere prima di ripartire</strong><p>${esc(item.error)}</p></div></div>` : ''}
      ${item.kind === 'script' ? buildScriptProgressHtml(item) : ''}
      <div class="pending-code-panel">
        <div class="pending-code-label">${ICO(item.kind === 'script' ? 'scroll-text' : 'terminal')} ${item.kind === 'script' ? 'Script' : 'Query'}<span>${String(item.code || '').split('\n').length} righe</span></div>
        <pre class="pending-code" tabindex="0" aria-label="Codice della query"><code>${esc(item.code)}</code></pre>
      </div>
      <p class="pending-resume-hint">${editorOnly ? 'Il codice viene aperto nell’editor, senza avviare una nuova esecuzione.' : item.kind === 'script' ? 'Lo script riparte dal cursore conservato nella sessione.' : 'Riprendi esegue la query sulla connessione di origine.'}</p>
      <div class="pending-actions">
        <button type="button" class="ghost btn-sm btn-copy-pending" data-id="${esc(item.id)}">${ICO('copy')} Copia</button>
        <button type="button" class="ghost btn-sm btn-resolve-pending" data-id="${esc(item.id)}">${ICO('check')} Segna risolta</button>
        <button type="button" class="ghost btn-icon btn-remove-pending" data-id="${esc(item.id)}" aria-label="Rimuovi query dal registro" title="Rimuovi query dal registro">${ICO('trash-2')}</button>
        <button type="button" class="primary btn-resume-pending" data-id="${esc(item.id)}">${ICO(editorOnly ? 'arrow-up-right' : 'play')} ${editorOnly ? 'Apri nell’editor' : item.kind === 'script' && item.status === 'paused' ? 'Riprendi script' : 'Riprendi'}</button>
      </div>`;
  }
  mountArcControls(detail);
  refreshLucideIcons(detail);
  if (restoreFocus) detail.querySelector('h3')?.focus({ preventScroll: true });
  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) detail.animate(
    [{ opacity: .55, transform: 'translateX(6px)' }, { opacity: 1, transform: 'none' }],
    { duration: 220, easing: 'cubic-bezier(.16,1,.3,1)' });
}

function selectPending(id, animate = true) {
  if (id === selectedPendingId) return;
  selectedPendingId = id;
  for (const card of renderedCards.values()) card.setAttribute('aria-selected', String(card.dataset.id === id));
  const selected = [...renderedCards.values()].find(card => card.dataset.id === id);
  if (selected) $('#pending-queries-list')?.setAttribute('aria-activedescendant', selected.id);
  renderPendingDetail(animate);
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
    listEl.innerHTML = '<p class="pending-list-empty">Nessuna query da mostrare.</p>';
    listEl.removeAttribute('aria-activedescendant');
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
    refreshLucideIcons(card);
  }
  const selected = [...renderedCards.values()].find(card => card.dataset.id === selectedPendingId);
  if (selected) listEl.setAttribute('aria-activedescendant', selected.id);
  else listEl.removeAttribute('aria-activedescendant');
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

  activeFilteredItems = activeFilteredItems.filter(item => pendingFilter === 'all' || (pendingFilter === 'running' ? item.status === 'running' : item.status !== 'running'));
  if (!activeFilteredItems.some(item => item.id === selectedPendingId)) selectedPendingId = activeFilteredItems[0]?.id || null;
  const count = activeFilteredItems.length;
  $('#pending-list-count').textContent = `${count} query${term || pendingFilter !== 'all' ? ' corrispondenti' : ' nel registro'}`;
  computeYPositions(activeFilteredItems);
  forceResetVScroll();
  renderPendingVirtualWindow();
  renderPendingDetail();
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
  new ResizeObserver(() => renderPendingVirtualWindow()).observe(listEl);
  listEl.addEventListener('click', e => {
    const row = e.target.closest('.pending-item');
    if (!row) return;
    selectPending(row.dataset.id);
    if (matchMedia('(max-width: 650px)').matches) {
      $('#pending-detail').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      $('#pending-detail h3')?.focus({ preventScroll: true });
    } else listEl.focus({ preventScroll: true });
  });
  listEl.addEventListener('keydown', e => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) || !activeFilteredItems.length) return;
    e.preventDefault();
    const current = Math.max(0, activeFilteredItems.findIndex(item => item.id === selectedPendingId));
    const index = e.key === 'Home' ? 0 : e.key === 'End' ? activeFilteredItems.length - 1 : Math.max(0, Math.min(activeFilteredItems.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
    const top = yPositions[index], bottom = yPositions[index + 1];
    if (top < listEl.scrollTop) listEl.scrollTop = top;
    else if (bottom > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = bottom - listEl.clientHeight;
    renderPendingVirtualWindow(); selectPending(activeFilteredItems[index].id);
  });

  // Le azioni appartengono alla query selezionata, anche dopo un aggiornamento live.
  $('#pending-detail').addEventListener('click', (e) => {
    if (e.target.closest('.pending-back')) {
      listEl.scrollIntoView({ block: 'start' });
      listEl.focus({ preventScroll: true });
      return;
    }
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
  const counts = { all: currentPendingItems.length, running: currentPendingItems.filter(item => item.status === 'running').length };
  counts.review = counts.all - counts.running;
  $('#pending-count').textContent = `${counts.all} query`;
  document.querySelectorAll('[data-pending-count]').forEach(el => { el.textContent = counts[el.dataset.pendingCount]; });
  $('#btn-clear-resolved-pending').disabled = !counts.review;
  $('#btn-clear-all-pending').disabled = !counts.all;
  filterPendingModalList();
  attachPendingVScroll();
}

export async function resumePendingQuery(id) {
  const item = pendingQueries.find((x) => x.id === id);
  if (!item) return;
  if (item.paneId) {
    import('./splitview.js').then(m => m.riprendiQueryPane(item)).catch(err => toast(err.message, true));
    $('#modal-pending')?.classList.add('hidden');
    return;
  }
  const origine = tabs.list.find(t => t.id === item.tabId);
  if (!origine) {
    toast(`La sessione ${item.connName || 'di origine'} è stata chiusa. Riconnettila e copia il testo dal registro nel suo editor.`, true);
    return;
  }

  // Uno SCRIPT non si "rilancia": si RIPRENDE dal cursore che il server ha
  // conservato, altrimenti si rieseguirebbero istruzioni già applicate (per un
  // INSERT significa duplicare). La ripresa vale finché il run esiste ancora
  // lato server: dopo un F5 o una riconnessione la pagina non lo conosce più e
  // si ricade sul comportamento normale (ricaricare il codice nell'editor).
  if (item.kind === 'script' && item.status === 'paused' && knowsScriptRun(item.runId)) {
    const modaleScript = $('#modal-pending');
    if (modaleScript) modaleScript.classList.add('hidden');
    if (item.tabId && tabs.list.some((t) => t.id === item.tabId)) switchTab(item.tabId);
    if (item.collTabId) switchCollTab(item.collTabId);
    setView('query');
    focusScriptRun(item.runId);
    resumeScript(item.runId).catch(() => {});
    return;
  }
  if (item.kind === 'script' && !knowsScriptRun(item.runId)) {
    toast('Lo script non è più in esecuzione su questa sessione: il codice viene ricaricato nell\'editor.');
  }

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
    } else if (item.db) {
      openDbTab(item.db);
    }
  }

  // 3. Riempi l'editor della query
  const editorInput = $('#query-editor-input');
  if (queryDocument()?.dirty && editorInput?.value !== item.code
    && !await chiediConferma('Sostituire la query non salvata con quella del registro?')) return;
  if (editorInput) {
    editorInput.value = item.code;
    editorInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const engineSelect = $('#query-target-engine');
  if (engineSelect && item.engine) {
    engineSelect.value = item.engine;
  }

  // 4. Chiudi il modale
  const modal = $('#modal-pending');
  if (modal) modal.classList.add('hidden');

  // 5. Rilancia la query
  setView('query');
  setQueryTarget(item.db, item.coll);
  updateEditorHighlight();
  // Il cursore di uno script perduto non si può ricostruire: rieseguirlo
  // automaticamente potrebbe duplicare scritture già applicate.
  if (item.kind === 'script' || item.status === 'running') return;
  toast('Ripristino query nell\'editor ed esecuzione...');
  runQuery().catch(() => {});
}

export function initPendingQueries() {
  if (ospite) return;
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
  document.querySelectorAll('[data-pending-filter]').forEach(button => {
    button.addEventListener('click', () => {
      pendingFilter = button.dataset.pendingFilter;
      document.querySelectorAll('[data-pending-filter]').forEach(el => el.setAttribute('aria-pressed', String(el === button)));
      $('#pending-queries-list').scrollTop = 0;
      filterPendingModalList();
    });
  });

  if (btnTop && modal) {
    btnTop.addEventListener('click', () => {
      renderPendingModalList();
      modal.classList.remove('hidden');
      requestAnimationFrame(() => searchInput?.focus({ preventScroll: true }));
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
    clearResolvedBtn.addEventListener('click', async () => {
      if (!await chiediConferma('Rimuovere dal registro le query inattive, comprese quelle in pausa o in errore? Le query in esecuzione restano nel registro.')) return;
      clearResolvedPending();
      toast('Query inattive rimosse dal registro');
    });
  }

  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', async () => {
      if (!await chiediConferma('Svuotare il registro delle query? Le query in esecuzione continueranno a lavorare.')) return;
      clearAllPending();
      toast('Registro delle query svuotato');
    });
  }

  updateBadge();
}
