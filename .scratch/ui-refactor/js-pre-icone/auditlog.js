'use strict';

// Storico delle azioni critiche/di scrittura eseguite dalla Web UI.
//
// Consulta il file di audit lato server (ui-audit.log) via l'evento socket
// `audit:list`, con filtri per tipo di operazione, esito e database. È il
// gemello, per la UI, dell'audit log del gateway MCP: una riga per ogni
// scrittura (drop, delete, query di scrittura, backup...) su qualunque DBMS.

import { $, emit, esc, iniziaCaricamento } from './utils.js';
// Il modulo unico della griglia: stessa finestra virtuale della vista Dati e
// della tab ⚡ (vedi griglia.js).
import { capacita, finestraVirtuale, vaVirtualizzata, disegnaCorpo } from './griglia.js';

// Etichette italiane degli eventi tracciati (fallback: l'evento grezzo).
const EVENT_LABELS = {
  'db:create': 'Creazione database',
  'db:rename': 'Rinomina database',
  'db:drop': 'Eliminazione database',
  'collection:create': 'Creazione collection/tabella',
  'collection:rename': 'Rinomina collection/tabella',
  'collection:drop': 'Eliminazione collection/tabella',
  'column:add': 'Aggiunta colonna',
  'column:alter': 'Modifica colonna',
  'column:drop': 'Eliminazione colonna',
  'index:create': 'Creazione indice',
  'index:drop': 'Eliminazione indice',
  'doc:insert': 'Inserimento',
  'doc:update': 'Aggiornamento',
  'doc:replace': 'Sostituzione',
  'doc:delete': 'Eliminazione documento/riga',
  'collection:deleteMany': 'Eliminazione massiva',
  'collection:import': 'Import batch',
  'query:execute': 'Query Engine',
  'collection:find': 'Lettura documenti/righe',
  'collection:aggregate': 'Aggregazione',
  'collection:explain': 'Piano di esecuzione',
  'collection:export': 'Export',
  'backup:run': 'Backup',
  'backup:restore': 'Ripristino backup',
};

// Contatori "quante righe" da mostrare in Dettagli, con etichetta.
const COUNT_LABELS = [
  ['deletedCount', 'eliminati'],
  ['modifiedCount', 'modificati'],
  ['matchedCount', 'trovati'],
  ['insertedCount', 'inseriti'],
  ['upsertedCount', 'upsert'],
  ['inserted', 'inseriti'],
  ['imported', 'importati'],
  ['affectedRows', 'righe'],
  ['rows', 'risultati'],
  ['count', 'n'],
];

let debounceTimer = null;

// Stato di paginazione: offset (voci saltate dalla più recente), dimensione
// pagina e totale delle voci che soddisfano i filtri (dal server).
let offset = 0;
let total = 0;

function pageSize() {
  return parseInt($('#audit-page-size').value, 10) || 50;
}

export function initAuditLog() {
  const btn = $('#btn-audit-log');
  if (btn) btn.addEventListener('click', openAuditModal);

  const close = $('#btn-close-audit-modal');
  if (close) close.addEventListener('click', () => $('#modal-audit-log').classList.add('hidden'));

  // Aggiorna resta sulla pagina corrente; cambio filtri/dimensione riparte da capo.
  const refresh = $('#btn-refresh-audit');
  if (refresh) refresh.addEventListener('click', () => {
    const fine = iniziaCaricamento(refresh, '');
    Promise.resolve(fetchAudit()).finally(fine);
  });

  ['#audit-filter-event', '#audit-filter-status', '#audit-filter-category'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('change', resetAndFetch);
  });

  const sizeSel = $('#audit-page-size');
  if (sizeSel) sizeSel.addEventListener('change', resetAndFetch);

  const prev = $('#audit-prev');
  if (prev) prev.addEventListener('click', () => {
    offset = Math.max(0, offset - pageSize());
    fetchAudit();
  });
  const next = $('#audit-next');
  if (next) next.addEventListener('click', () => {
    if (offset + pageSize() < total) {
      offset += pageSize();
      fetchAudit();
    }
  });

  const dbFilter = $('#audit-filter-db');
  if (dbFilter) {
    dbFilter.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(resetAndFetch, 400);
    });
  }

  // Chiusura con Escape quando la modale è aperta.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal-audit-log').classList.contains('hidden')) {
      $('#modal-audit-log').classList.add('hidden');
    }
  });
}

function openAuditModal() {
  $('#modal-audit-log').classList.remove('hidden');
  resetAndFetch();
}

// Torna alla prima pagina e ricarica (cambio filtri o dimensione pagina).
function resetAndFetch() {
  offset = 0;
  fetchAudit();
}

async function fetchAudit() {
  const container = $('#audit-log-list');
  if (!container) return;

  if (!container.querySelector('table.audit-table')) {
    container.innerHTML = '<div class="loading-spinner" style="padding:24px; text-align:center; color:var(--accent);">Caricamento storico in corso...</div>';
  } else {
    container.classList.add('loading-state');
  }

  try {
    const res = await emit('audit:list', {
      limit: pageSize(),
      offset,
      event: $('#audit-filter-event').value || undefined,
      status: $('#audit-filter-status').value || undefined,
      category: $('#audit-filter-category').value || undefined,
      db: $('#audit-filter-db').value.trim() || undefined,
    });
    total = res.total || 0;
    // Il server può aver ricalcolato l'offset (es. totale calato): allineati.
    if (typeof res.offset === 'number') offset = res.offset;
    render(res.entries || []);
    updatePager(res.entries ? res.entries.length : 0);
  } catch (err) {
    container.classList.remove('loading-state');
    container.innerHTML = `<div class="error-box" style="margin:16px;">Errore nel caricamento dello storico: ${esc(err.message)}</div>`;
    updatePager(0);
  }
}

// Aggiorna testo "da–a di N" e abilitazione dei pulsanti pagina.
function updatePager(shown) {
  const info = $('#audit-page-info');
  const prev = $('#audit-prev');
  const next = $('#audit-next');
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + shown;
  if (info) info.textContent = total === 0 ? 'Nessuna voce' : `${from}–${to} di ${total}`;
  if (prev) prev.disabled = offset === 0;
  if (next) next.disabled = offset + pageSize() >= total;
}

function fmtTs(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return esc(String(ts || ''));
  return d.toLocaleString('it-IT');
}

// Compone la colonna "Dettagli" a partire dai campi opzionali della voce.
function detailsOf(e) {
  const bits = [];
  if (e.newName) bits.push(`→ ${e.newName}`);
  if (e.column) bits.push(`colonna: ${e.column}`);
  if (e.index) bits.push(`indice: ${e.index}`);
  if (e.docId) bits.push(`id: ${e.docId}`);
  if (e.filter) bits.push(`filtro: ${e.filter}`);
  if (e.sort) bits.push(`sort: ${e.sort}`);
  if (e.pipeline) bits.push(`pipeline: ${e.pipeline}`);
  if (e.query) bits.push(`query: ${e.query}`);
  if (e.backupType) bits.push(`tipo: ${e.backupType}`);
  if (e.backupId) bits.push(`backup: ${e.backupId}`);

  const counts = [];
  for (const [k, label] of COUNT_LABELS) {
    if (e[k] != null) counts.push(`${e[k]} ${label}`);
  }
  if (counts.length) bits.push(counts.join(', '));

  if (e.error) bits.push(`⚠ ${e.error}`);
  return bits.join(' · ');
}

let currentEntries = [];
let vscrollAttached = false;
// La colonna "Utente" ha senso solo con RBAC attivo: senza, ogni voce è
// dell'unico utente locale e la colonna sarebbe una fila di trattini. Si decide
// dai dati (presenza dell'attore) invece che da un flag, così la tabella resta
// corretta anche mescolando voci scritte prima dell'introduzione dell'attore.
let showUserCol = false;
const AUDIT_ROW_H = 44;
const AUDIT_OVERSCAN = 5;

// Lo Storico Azioni e' la QUARTA griglia del frontend, e nessuno lo aveva
// contato: rifaceva l'aritmetica della finestra virtuale come le altre tre.
// Qui le capacita' sono poche e non per dimenticanza — e' un registro in sola
// lettura.
const CAPACITA_AUDIT = capacita({ virtualizzazione: true });

function renderAuditVirtualWindow() {
  const container = $('#audit-log-list');
  if (!container) return;
  const table = container.querySelector('table.audit-table');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  if (currentEntries.length === 0) {
    tbody.innerHTML = '';
    return;
  }

  disegnaCorpo({
    tbody,
    righe: currentEntries,
    disegnaRiga: disegnaVoceAudit,
    finestra: vaVirtualizzata(currentEntries.length, CAPACITA_AUDIT)
      ? finestraVirtuale({
        scrollTop: container.scrollTop || 0,
        altezzaViewport: container.clientHeight || 420,
        altezzaRiga: AUDIT_ROW_H,
        righeTotali: currentEntries.length,
        overscan: AUDIT_OVERSCAN,
      })
      : null,
    colonneTotali: showUserCol ? 8 : 7,
  });
}

/** Una voce dello Storico Azioni. */
function disegnaVoceAudit(e) {
    const label = EVENT_LABELS[e.event] || e.op || e.event || '?';
    const detail = e.op && e.op !== label ? e.op : '';
    const ok = e.status !== 'error';
    const statusHtml = ok
      ? '<span class="audit-status audit-status-ok">✅ OK</span>'
      : '<span class="audit-status audit-status-err">❌ Errore</span>';
    const catHtml = e.category === 'read'
      ? '<span class="audit-cat audit-cat-read">👁 Lettura</span>'
      : '<span class="audit-cat audit-cat-write">✏️ Scrittura</span>';
    const target = [e.db, e.coll].filter(Boolean).map(esc).join(' › ') || '<span class="sub-text">—</span>';
    const conn = e.connection ? esc(e.connection) : '<span class="sub-text">—</span>';
    const dbType = e.dbType ? `<span class="sub-text">${esc(e.dbType)}</span>` : '';
    const action = detail
      ? `${esc(label)}<div class="sub-text">${esc(detail)}</div>`
      : esc(label);

    const tr = document.createElement('tr');
    if (!ok) tr.className = 'audit-row-err';
    tr.style.height = `${AUDIT_ROW_H}px`;
    const userCell = showUserCol
      ? `<td>${e.user ? esc(e.user) : '<span class="sub-text">—</span>'}</td>`
      : '';

    tr.innerHTML = `
      <td class="audit-ts">${fmtTs(e.ts)}</td>
      <td>${catHtml}</td>
      <td>${action}</td>
      <td>${target} ${dbType}</td>
      <td>${conn}</td>
      ${userCell}
      <td class="audit-details" title="${esc(detailsOf(e))}">${esc(detailsOf(e))}</td>
      <td>${statusHtml}</td>
    `;
  return tr;
}

function attachAuditVScroll() {
  const container = $('#audit-log-list');
  if (!container || vscrollAttached) return;
  vscrollAttached = true;
  let raf = 0;
  container.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(renderAuditVirtualWindow);
  });
}

function render(entries) {
  const container = $('#audit-log-list');
  if (!container) return;

  currentEntries = entries || [];

  if (!currentEntries.length) {
    container.innerHTML = '<div class="empty-state" style="padding:24px; text-align:center; color:var(--fg-dim);">Nessuna azione registrata con questi filtri.</div>';
    return;
  }

  const wantUserCol = currentEntries.some((e) => e.user);
  const table = container.querySelector('table.audit-table');
  // L'intestazione va ricostruita anche quando la tabella esiste già ma il
  // numero di colonne cambia (es. prima pagina senza attore, seconda con).
  if (!table || wantUserCol !== showUserCol) {
    showUserCol = wantUserCol;
    container.innerHTML = `
      <table class="backup-table audit-table">
        <thead>
          <tr>
            <th>Data / Ora</th>
            <th>Categoria</th>
            <th>Azione</th>
            <th>Database › Coll.</th>
            <th>Connessione</th>
            ${showUserCol ? '<th>Utente</th>' : ''}
            <th>Dettagli</th>
            <th>Esito</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    `;
  }

  attachAuditVScroll();
  container.scrollTop = 0;
  renderAuditVirtualWindow();
  container.classList.remove('loading-state');
}
