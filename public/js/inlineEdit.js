import { state } from './state.js';
import { $, emit, isPlainObject, valueType, displayValue, editValue, parseEdited, idOf, toast, openModal, closeModal } from './utils.js';
import { runQuery, renderGrid } from './grid.js';

export function buildEditor(current) {
  const type = valueType(current);

  if (type === 'date') {
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.step = '0.001';
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

export function startEdit(td, doc, field) {
  if (td.classList.contains('editing')) return;
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
    renderGrid();
  };

  const save = () => {
    if (finished) return;
    finished = true;
    if (input.value === original) {
      renderGrid();
      return;
    }
    let value;
    try {
      value = buildValue();
    } catch (err) {
      toast(err.message, true);
      renderGrid();
      return;
    }
    emit('doc:update', {
      db: state.db,
      coll: state.coll,
      id: idOf(doc),
      set: { [field]: value },
    }).then(() => {
      toast(`Campo "${field}" aggiornato`);
      runQuery();
    }).catch((err) => {
      toast(err.message, true);
      renderGrid();
    });
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', save);
  if (input.tagName === 'SELECT') input.addEventListener('change', save);
}

export function openEditDoc(doc) {
  state.editingDoc = doc;
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
    if (!state.editingDoc) return;
    emit('doc:replace', {
      db: state.db,
      coll: state.coll,
      id: idOf(state.editingDoc),
      doc: $('#editdoc-json').value,
    }).then(() => {
      closeModal('#editdoc-overlay');
      toast('Documento aggiornato');
      runQuery();
    }).catch((err) => {
      const errorEl = $('#editdoc-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });
}
