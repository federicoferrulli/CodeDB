import { chiediConferma } from './conferma.js';
import { state } from './state.js';
import { mountArcControls } from '../arc/ui.js';
import { $, emit, fmtBytes, esc, toast, isForActiveTab, conCaricamento, isSqlType, captureContext, dbTypeIcon, refreshLucideIcons } from './utils.js';

let indexCreateContext = null;
let detailsRequest = 0;
const detailsMotion = new Set();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function stopDetailsMotion() {
  detailsMotion.forEach(animation => animation.cancel());
  detailsMotion.clear();
}
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) stopDetailsMotion(); });

function detailsIdentity(dbType) {
  $('#details-location').textContent = state.db || '';
  $('#details-name').textContent = state.coll || 'Dettagli';
  $('#details-db-icon').innerHTML = dbTypeIcon(dbType);
  $('#details-engine').textContent = isSqlType(dbType) ? dbType === 'mysql' ? 'MySQL' : 'PostgreSQL' : 'MongoDB';
}

function animateDetails() {
  stopDetailsMotion();
  if (reducedMotion.matches || !$('#view-details').getClientRects().length) return;
  const animate = (node, frames, duration, delay = 0) => {
    const animation = node.animate(frames, { duration, delay, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
    detailsMotion.add(animation);
    animation.finished.then(() => { animation.cancel(); detailsMotion.delete(animation); }, () => detailsMotion.delete(animation));
  };
  // La sequenza resta breve anche con centinaia di campi; nessuna animazione per riga fuori schermo.
  const bounds = $('#view-details').getBoundingClientRect();
  [...document.querySelectorAll('#schema-table tbody tr, #index-table tbody tr')].filter(row => {
    const box = row.getBoundingClientRect(); return box.top < bounds.bottom && box.bottom > bounds.top;
  }).slice(0, 14).forEach((row, i) => {
    animate(row, [{ opacity: .25, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 320, Math.min(i * 18, 108));
    const bar = row.querySelector('.details-presence-fill');
    if (bar) animate(bar, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], 440, Math.min(i * 18, 108));
  });
  animate($('.details-overview'), [{ opacity: .35, clipPath: 'inset(0 8% 0 0)' }, { opacity: 1, clipPath: 'inset(0)' }], 360);
}

function captureDetailsTarget() {
  return { ...captureContext(), db: state.db, coll: state.coll, dbType: state.dbType };
}

export function loadDetails() {
  if (!state.db || !state.coll) return;
  const origin = captureDetailsTarget();
  const request = ++detailsRequest;
  const current = () => request === detailsRequest && origin.isStillActive() && state.db === origin.db && state.coll === origin.coll;
  stopDetailsMotion();
  detailsIdentity(origin.dbType);
  $('#details-content').classList.add('hidden');
  $('#details-feedback').classList.remove('hidden');
  $('#details-feedback-text').textContent = 'Lettura dello schema e degli indici…';
  $('#details-retry').classList.add('hidden');
  $('#view-details').setAttribute('aria-busy', 'true');
  refreshLucideIcons($('#view-details'));
  emit('collection:stats', {
    tabId: origin.tabId,
    db: origin.db,
    coll: origin.coll,
  }).then((res) => {
    // La vista Dettagli è un DOM unico: statistiche e indici di un tab non più
    // in primo piano descriverebbero una collection diversa da quella mostrata.
    if (!current()) return;
    renderDetails(res, origin.dbType);
  }).catch((err) => {
    if (!current()) return;
    $('#view-details').setAttribute('aria-busy', 'false');
    $('#details-feedback-text').textContent = `Impossibile leggere i dettagli: ${err.message}`;
    $('#details-retry').classList.remove('hidden');
  });
}

export function renderDetails({ stats, indexes, fields, sampled }, dbType = state.dbType) {
  // Le stesse etichette e azioni colonna valgono per entrambi i DB SQL.
  const isMysql = isSqlType(dbType);
  detailsIdentity(dbType);
  $('#details-content').classList.remove('hidden');
  $('#details-feedback').classList.add('hidden');
  $('#view-details').setAttribute('aria-busy', 'false');
  const bytes = value => value == null ? '—' : fmtBytes(value);
  const rows = [
    [isMysql ? dbType === 'mysql' ? 'Righe (stima)' : 'Righe' : 'Documenti', stats.count == null ? '—' : stats.count.toLocaleString('it-IT')],
    ['Dimensione dati', bytes(stats.size)],
    ['Su disco', bytes(stats.storageSize)],
    [isMysql ? 'Media per riga' : 'Media per documento', bytes(stats.avgObjSize)],
    ['Dimensione indici', bytes(stats.totalIndexSize)],
    ['Numero di indici', stats.nindexes == null ? indexes.length : stats.nindexes],
  ];
  $('#stats-table tbody').innerHTML = rows
    .map(([k, v]) => `<tr><td>${esc(String(k))}</td><td>${esc(String(v))}</td></tr>`)
    .join('');

  $('#index-table thead').innerHTML = '<tr role="row"><th scope="col">Nome</th><th scope="col">Chiavi</th><th scope="col">Vincolo</th><th scope="col">Azioni</th></tr>';
  $('#index-table tbody').innerHTML = indexes.length
    ? indexes
        .map((i) => {
          const protectedIndex = !isMysql && i.name === '_id_';
          const del = protectedIndex
            ? '<span class="details-protected" title="Indice di sistema" aria-label="Indice di sistema"><i data-lucide="lock-keyhole" aria-hidden="true"></i></span>'
            : `<button type="button" class="del-btn idx-del" data-name="${esc(i.name)}" title="Elimina indice ${esc(i.name)}" aria-label="Elimina indice ${esc(i.name)}"><i data-lucide="trash-2" aria-hidden="true"></i></button>`;
          const keys = Object.entries(i.key || {}).map(([name, order]) => `<span class="details-index-key"><code>${esc(name)}</code><span title="${order === 1 ? 'Crescente' : order === -1 ? 'Decrescente' : 'Tipo di indice'}">${order === 1 ? '↑' : order === -1 ? '↓' : esc(typeof order === 'string' ? order : JSON.stringify(order))}</span></span>`).join('');
          return `<tr role="row"><td role="cell" class="details-index-name">${esc(i.name)}</td><td role="cell" class="details-index-keys">${keys || '—'}</td>` +
                 `<td role="cell" class="details-index-constraint"><span class="details-constraint">${i.unique || protectedIndex ? 'Unico' : 'Non univoco'}</span></td><td role="cell" class="row-actions">${del}</td></tr>`;
        })
        .join('')
    : '<tr class="details-empty-row"><td colspan="4"><div class="details-empty"><i data-lucide="fingerprint" aria-hidden="true"></i><strong>Nessun indice</strong><span>Crea un indice per supportare le ricerche sui tuoi dati.</span></div></td></tr>';

  $('#schema-title').textContent = isMysql ? 'Colonne' : 'Schema rilevato';
  $('#schema-count').textContent = fields.length;
  $('#schema-note').textContent = isMysql ? 'Tipi e vincoli definiti nel database' : sampled == null ? 'Tipi e presenza nei documenti campionati' : `Rilevato su ${sampled.toLocaleString('it-IT')} ${sampled === 1 ? 'documento' : 'documenti'}`;
  $('#column-add-btn').classList.remove('hidden');
  $('#column-add-btn').title = isMysql ? 'Aggiungi colonna' : 'Aggiungi campo a tutti i documenti';
  $('#column-add-btn').setAttribute('aria-label', isMysql ? 'Aggiungi colonna' : 'Aggiungi campo');
  $('#column-add-btn span').textContent = isMysql ? 'Colonna' : 'Campo';
  $('#schema-table thead').innerHTML =
    `<tr role="row"><th scope="col">${isMysql ? 'Colonna' : 'Campo'}</th><th scope="col">Tipo</th><th scope="col">${isMysql ? 'Valori nulli' : 'Presenza'}</th><th scope="col"><span class="visually-hidden">Azioni</span></th></tr>`;
  $('#schema-table tbody').innerHTML = fields.length
    ? fields
        .map((f) => {
          const presence = typeof f.presence === 'number' && Number.isFinite(f.presence) ? Math.max(0, Math.min(100, f.presence)) : null;
          const third = isMysql ? `<span class="details-nullable">${f.nullable ? 'Consentiti' : 'Non consentiti'}</span>`
            : presence == null ? '—' : `<span class="details-presence"><span class="details-presence-track" aria-hidden="true"><span class="details-presence-fill" style="width:${presence}%"></span></span><span>${presence}%</span></span>`;
          const actions = (!isMysql && f.name === '_id')
            ? '<td role="cell" class="row-actions"><span class="details-protected" title="Campo di sistema" aria-label="Campo di sistema"><i data-lucide="lock-keyhole" aria-hidden="true"></i></span></td>'
            : `<td role="cell" class="row-actions">` +
              `<button type="button" class="edit-btn col-edit" data-field="${esc(JSON.stringify(f))}" title="${isMysql ? 'Modifica colonna' : 'Rinomina/converti il campo in tutti i documenti'}" aria-label="Modifica ${esc(f.name)}"><i data-lucide="pencil" aria-hidden="true"></i></button>` +
              `<button type="button" class="del-btn col-del" data-name="${esc(f.name)}" title="${isMysql ? 'Elimina colonna' : 'Rimuovi il campo da tutti i documenti'}" aria-label="Elimina ${esc(f.name)}"><i data-lucide="trash-2" aria-hidden="true"></i></button></td>`;
          return `<tr role="row"><td role="cell" class="details-field-name">${esc(f.name)}</td><td role="cell" class="details-field-types">${f.types.map(type => `<code class="details-type">${esc(type)}</code>`).join('')}</td><td role="cell" class="details-field-presence">${third}</td>${actions}</tr>`;
        })
        .join('')
    : `<tr class="details-empty-row"><td colspan="4"><div class="details-empty"><i data-lucide="list-tree" aria-hidden="true"></i><strong>${isMysql ? 'Nessuna colonna' : 'Nessun campo rilevato'}</strong><span>${isMysql ? 'Aggiungi una colonna per definire la struttura.' : 'I campi appariranno quando la collezione conterrà documenti.'}</span></div></td></tr>`;
  mountArcControls($('#index-table'));
  mountArcControls($('#schema-table'));
  refreshLucideIcons($('#view-details'));
  animateDetails();
}

export function initDetails() {
  $('#details-retry').addEventListener('click', loadDetails);
  $('#index-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('.idx-del');
    if (!btn) return;
    const origin = captureDetailsTarget();
    const name = btn.dataset.name;
    const extra = name.toUpperCase() === 'PRIMARY' ? '\nAttenzione: è la chiave primaria della tabella.' : '';
    if (!await chiediConferma(`Eliminare l'indice "${name}"?${extra}`)) return;
    conCaricamento(btn, () => emit('index:drop', {
      tabId: origin.tabId, db: origin.db, coll: origin.coll, name,
    }), '').then((res) => {
      toast(`Indice "${name}" eliminato`);
      // loadDetails() rilegge db/coll dal Proxy: ha senso solo se il tab che ha
      // eliminato l'indice è ancora quello mostrato.
      if (isForActiveTab(res)) loadDetails();
    }).catch((err) => toast(err.message, true));
  });

  $('#index-add-btn').addEventListener('click', () => {
    indexCreateContext = captureDetailsTarget();
    $('#idxcreate-name').value = '';
    $('#idxcreate-fields').value = '';
    $('#idxcreate-unique').checked = false;
    $('#idxcreate-error').classList.add('hidden');
    $('#idxcreate-overlay').classList.remove('hidden');
    $('#idxcreate-fields').focus();
  });

  $('#idxcreate-cancel').addEventListener('click', () => {
    indexCreateContext = null;
    $('#idxcreate-overlay').classList.add('hidden');
  });

  $('#idxcreate-save').addEventListener('click', () => {
    const ctx = indexCreateContext;
    if (!ctx) return;
    // La creazione di un indice su una tabella grande può durare minuti.
    conCaricamento($('#idxcreate-save'), () => emit('index:create', {
      tabId: ctx.tabId,
      db: ctx.db,
      coll: ctx.coll,
      name: $('#idxcreate-name').value,
      fields: $('#idxcreate-fields').value,
      unique: $('#idxcreate-unique').checked,
    }), 'Creo…').then((res) => {
      $('#idxcreate-overlay').classList.add('hidden');
      indexCreateContext = null;
      toast(`Indice "${res.name}" creato`);
      if (isForActiveTab(res)) loadDetails();
    }).catch((err) => {
      const errorEl = $('#idxcreate-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });
}
