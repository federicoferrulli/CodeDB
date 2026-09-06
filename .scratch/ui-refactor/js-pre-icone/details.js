import { state } from './state.js';
import { $, emit, fmtBytes, esc, toast, isForActiveTab, conCaricamento, isSqlType, captureContext } from './utils.js';

let indexCreateContext = null;

function captureDetailsTarget() {
  return { ...captureContext(), db: state.db, coll: state.coll, dbType: state.dbType };
}

export function loadDetails() {
  if (!state.db || !state.coll) return;
  const origin = captureDetailsTarget();
  emit('collection:stats', {
    tabId: origin.tabId,
    db: origin.db,
    coll: origin.coll,
  }).then((res) => {
    // La vista Dettagli è un DOM unico: statistiche e indici di un tab non più
    // in primo piano descriverebbero una collection diversa da quella mostrata.
    if (!origin.isStillActive()) return;
    renderDetails(res, origin.dbType);
  }).catch((err) => { if (origin.isStillActive()) toast(err.message, true); });
}

export function renderDetails({ stats, indexes, fields, sampled }, dbType = state.dbType) {
  // Le stesse etichette e azioni colonna valgono per entrambi i DB SQL.
  const isMysql = isSqlType(dbType);
  const rows = [
    [isMysql ? 'Righe (stima)' : 'Documenti', stats.count == null ? '—' : stats.count],
    ['Dimensione dati', fmtBytes(stats.size)],
    ['Dimensione su disco', fmtBytes(stats.storageSize)],
    [isMysql ? 'Media per riga' : 'Media per documento', fmtBytes(stats.avgObjSize)],
    ['Dimensione indici', fmtBytes(stats.totalIndexSize)],
    ['Numero di indici', stats.nindexes == null ? indexes.length : stats.nindexes],
  ];
  $('#stats-table tbody').innerHTML = rows
    .map(([k, v]) => `<tr><td>${esc(String(k))}</td><td>${esc(String(v))}</td></tr>`)
    .join('');

  $('#index-table thead').innerHTML = '<tr><th>Nome</th><th>Chiavi</th><th>Unico</th><th></th></tr>';
  $('#index-table tbody').innerHTML = indexes.length
    ? indexes
        .map((i) => {
          const del = i.name === '_id_'
            ? ''
            : `<button type="button" class="del-btn idx-del" data-name="${esc(i.name)}" title="Elimina indice">✕</button>`;
          return `<tr><td>${esc(i.name)}</td><td class="mono">${esc(JSON.stringify(i.key))}</td>` +
                 `<td>${i.unique ? 'sì' : ''}</td><td class="row-actions">${del}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="4" class="dim">Nessun indice</td></tr>';

  $('#schema-title').textContent = isMysql ? 'Colonne' : 'Schema rilevato';
  $('#schema-note').textContent = isMysql ? '' : `(campione di ${sampled} documenti)`;
  $('#column-add-btn').classList.remove('hidden');
  $('#column-add-btn').title = isMysql ? 'Aggiungi colonna' : 'Aggiungi campo a tutti i documenti';
  $('#schema-table thead').innerHTML =
    `<tr><th>Campo</th><th>Tipi</th><th>${isMysql ? 'NULL' : 'Presenza'}</th><th></th></tr>`;
  $('#schema-table tbody').innerHTML = fields.length
    ? fields
        .map((f) => {
          const third = isMysql ? (f.nullable ? 'sì' : 'no') : `${f.presence}%`;
          const actions = (!isMysql && f.name === '_id')
            ? '<td class="row-actions"></td>'
            : `<td class="row-actions">` +
              `<button type="button" class="edit-btn col-edit" data-field="${esc(JSON.stringify(f))}" title="${isMysql ? 'Modifica colonna' : 'Rinomina/converti il campo in tutti i documenti'}">✎</button>` +
              `<button type="button" class="del-btn col-del" data-name="${esc(f.name)}" title="${isMysql ? 'Elimina colonna' : 'Rimuovi il campo da tutti i documenti'}">✕</button></td>`;
          return `<tr><td class="mono">${esc(f.name)}</td><td>${esc(f.types.join(', '))}</td><td>${third}</td>${actions}</tr>`;
        })
        .join('')
    : `<tr><td colspan="4" class="dim">${isMysql ? 'Nessuna colonna' : 'Collection vuota'}</td></tr>`;
}

export function initDetails() {
  $('#index-table').addEventListener('click', (e) => {
    const btn = e.target.closest('.idx-del');
    if (!btn) return;
    const origin = captureDetailsTarget();
    const name = btn.dataset.name;
    const extra = name.toUpperCase() === 'PRIMARY' ? '\nAttenzione: è la chiave primaria della tabella.' : '';
    if (!confirm(`Eliminare l'indice "${name}"?${extra}`)) return;
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
