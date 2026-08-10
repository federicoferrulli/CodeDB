import { state } from './state.js';
import { $, emit, isPlainObject, valueType, displayValue, editValue, parseEdited, idOf, toast, openModal, closeModal, isForActiveTab, captureContext, conCaricamento } from './utils.js';
import { runQuery, renderGrid } from './grid.js';
import { isGeometry, openGeoEditor } from './geomap.js';

export function buildEditor(current) {
  const type = valueType(current);

  if (type === 'date') {
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.step = '0.001';
    // ORA UTC, non locale (CDB-15). Il controllo `datetime-local` è per
    // definizione ora locale, e qui invece si mostra e si rilegge UTC: la scelta
    // è voluta — la griglia stampa `toISOString()`, l'export e l'EJSON parlano
    // UTC, e mostrare l'ora locale solo nell'editor significherebbe vedere due
    // orari diversi per lo stesso istante (e un valore che cambia in viaggio).
    // Quello che mancava era DIRLO: senza, chi scrive "10:00" crede di indicare
    // le 10:00 di casa propria e ne salva altre.
    input.title = 'Ora UTC, come nella griglia (non l\'ora locale del computer)';
    input.setAttribute('aria-label', 'Data e ora in UTC');
    input.classList.add('input-utc');
    const raw = isPlainObject(current.$date) ? Number(current.$date.$numberLong) : current.$date;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) input.value = d.toISOString().slice(0, 23);
    return {
      input,
      original: input.value,
      buildValue: () => {
        const d2 = new Date(input.value + 'Z');
        if (input.value === '' || Number.isNaN(d2.getTime())) throw new Error('Data non valida');
        return { $date: d2.toISOString() };
      },
    };
  }

  if (type === 'bool') {
    const input = document.createElement('select');
    for (const v of ['true', 'false']) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      input.appendChild(opt);
    }
    input.value = String(current);
    return { input, original: input.value, buildValue: () => input.value === 'true' };
  }

  if (type === 'number') {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = displayValue(current).text;
    return {
      input,
      original: input.value,
      buildValue: () => {
        const n = Number(input.value);
        if (input.value.trim() === '' || Number.isNaN(n)) throw new Error('Numero non valido');
        return n;
      },
    };
  }

  if (type === 'decimal') {
    const input = document.createElement('input');
    input.value = current.$numberDecimal;
    return {
      input,
      original: input.value,
      buildValue: () => ({ $numberDecimal: input.value.trim() }),
    };
  }

  if (type === 'oid') {
    const input = document.createElement('input');
    input.value = current.$oid;
    return {
      input,
      original: input.value,
      buildValue: () => {
        const t = input.value.trim();
        if (!/^[0-9a-fA-F]{24}$/.test(t)) throw new Error('ObjectId non valido: servono 24 caratteri esadecimali');
        return { $oid: t };
      },
    };
  }

  const input = document.createElement('input');
  input.value = editValue(current);
  return { input, original: input.value, buildValue: () => parseEdited(input.value) };
}

/**
 * Scrive un singolo campo della riga. Estratta dal salvataggio inline perché la
 * usa anche l'editor su mappa, che risponde molto DOPO l'apertura: il contesto
 * (tab e collection) va quindi congelato all'inizio, altrimenti una geometria
 * confermata dopo un cambio di tab finirebbe nella tabella sbagliata.
 */
function salvaCampo(doc, field, value, ctx) {
  // `contestoScrittura()` e non `captureContext()`: quest'ultima non porta
  // db/coll, quindi il ripiego avrebbe scritto con un bersaglio indefinito.
  // Oggi entrambi i chiamanti passano `ctx`, ma il ripiego non deve essere
  // una trappola per il prossimo.
  const c = ctx || contestoScrittura();
  return emit('doc:update', {
    tabId: c.tabId,
    db: c.db,
    coll: c.coll,
    id: idOf(doc),
    set: { [field]: value },
  }).then((res) => {
    toast(`Campo "${field}" aggiornato`);
    // Il refresh rilegge dagli input del workspace, che appartengono al tab
    // mostrato: se l'utente si è spostato altrove, rileggerebbe la collection
    // sbagliata. La scrittura è comunque andata a buon fine.
    if (isForActiveTab(res) && c.isStillActive()) runQuery({ auto: true }); // refresh post-scrittura
  }).catch((err) => {
    toast(err.message, true);
    if (isForActiveTab(err)) renderGrid({ preserveScroll: true });
  });
}

// Contesto di scrittura completo: tab, coll-tab e bersaglio db/collection.
function contestoScrittura() {
  const c = captureContext();
  return Object.assign(c, { db: state.db, coll: state.coll });
}

export function startEdit(td, doc, field) {
  if (td.classList.contains('editing')) return;

  // Geometrie: non c'è un `input` sensato in cui scriverle a mano. Si apre
  // l'editor su mappa, che è anche l'unico modo di CAPIRE cosa si sta
  // modificando; il salvataggio è lo stesso `doc:update` degli altri campi.
  if (isGeometry(doc[field])) {
    const ctx = contestoScrittura();
    openGeoEditor({
      value: doc[field],
      campo: field,
      onSave: (geo) => salvaCampo(doc, field, geo, ctx),
    });
    return;
  }

  const { input, original, buildValue } = buildEditor(doc[field]);

  td.classList.add('editing');
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  if (input.select) input.select();

  let finished = false;

  const cancel = () => {
    if (finished) return;
    finished = true;
    renderGrid({ preserveScroll: true });
  };

  const save = () => {
    if (finished) return;
    finished = true;
    if (input.value === original) {
      renderGrid({ preserveScroll: true });
      return;
    }
    let value;
    try {
      value = buildValue();
    } catch (err) {
      toast(err.message, true);
      renderGrid({ preserveScroll: true });
      return;
    }
    salvaCampo(doc, field, value, contestoScrittura());
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', save);
  if (input.tagName === 'SELECT') input.addEventListener('change', save);
}

let editDocContext = null;
// Documento in modifica (CDB-52). Stava in `state.editingDoc`, cioè nel Proxy
// che punta SEMPRE al tab attivo: aprendo la modale e passando a un altro tab
// prima di salvare, `state.editingDoc` era quello dell'ALTRO tab — nel migliore
// dei casi il salvataggio non faceva nulla (nessun documento in modifica lì),
// nel peggiore scriveva su un `_id` che appartiene a un'altra connessione.
// La modale è una sola e globale: il documento vive qui, accanto al suo
// contesto, e non in uno stato che cambia sotto i piedi.
let editingDoc = null;

export function openEditDoc(doc, context = null) {
  editingDoc = doc;
  editDocContext = context;
  const copy = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k !== '_id') copy[k] = v;
  }
  $('#editdoc-id').textContent = `_id: ${displayValue(doc._id).text} (non modificabile)`;
  $('#editdoc-json').value = JSON.stringify(copy, null, 2);
  $('#editdoc-error').classList.add('hidden');
  openModal('#editdoc-overlay');
  $('#editdoc-json').focus();
}

export function initInlineEdit() {
  $('#editdoc-cancel').addEventListener('click', () => closeModal('#editdoc-overlay'));

  $('#editdoc-save').addEventListener('click', () => {
    if (!editingDoc) return;
    const tabId = editDocContext ? editDocContext.tabId : undefined;
    const db = editDocContext ? editDocContext.db : state.db;
    const coll = editDocContext ? editDocContext.coll : state.coll;

    conCaricamento($('#editdoc-save'), () => emit('doc:replace', {
      tabId,
      db,
      coll,
      id: idOf(editingDoc),
      doc: $('#editdoc-json').value,
    }), 'Salvo…').then((res) => {
      closeModal('#editdoc-overlay');
      toast('Documento aggiornato');
      if (editDocContext && editDocContext.onSaveSuccess) {
        editDocContext.onSaveSuccess();
      } else if (isForActiveTab(res)) {
        runQuery({ auto: true }); // refresh post-scrittura
      }
    }).catch((err) => {
      const errorEl = $('#editdoc-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });
}

