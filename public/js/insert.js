import { state } from './state.js';
import { socket } from './socket.js';
import { $, emit, esc, toast, openModal, closeModal, isSqlType } from './utils.js';
import { runQuery } from './grid.js';

let insertRows = [];
let insertJsonTouched = false;

export function insertKindOf(typeName) {
  const t = String(typeName || '').toLowerCase();
  if (isSqlType(state.dbType)) {
    if (/^tinyint\(1\)|^bool/.test(t)) return 'bool';
    if (/^decimal|^numeric/.test(t)) return 'decimal';
    if (/int|float|double|year|serial/.test(t)) return 'number';
    if (/^datetime|^timestamp/.test(t)) return 'datetime';
    if (/^date$/.test(t)) return 'date';
    if (/^json/.test(t)) return 'json';
    return 'text';
  }
  if (t === 'int' || t === 'double' || t === 'long') return 'number';
  if (t === 'decimal') return 'decimal';
  if (t === 'date') return 'datetime';
  if (t === 'boolean') return 'bool';
  if (t === 'objectid') return 'oid';
  if (t === 'array' || t === 'object') return 'json';
  return 'text';
}

export function insertInputFor(kind) {
  if (kind === 'bool') {
    const s = document.createElement('select');
    for (const v of ['', 'true', 'false']) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === '' ? '(vuoto)' : v;
      s.appendChild(o);
    }
    return s;
  }
  const i = document.createElement('input');
  if (kind === 'number') { i.type = 'number'; i.step = 'any'; }
  else if (kind === 'datetime') { i.type = 'datetime-local'; i.step = '0.001'; }
  else if (kind === 'date') { i.type = 'date'; }
  else {
    i.type = 'text';
    if (kind === 'oid') i.placeholder = '24 caratteri esadecimali';
    if (kind === 'json') i.placeholder = 'JSON, es. {"a": 1} oppure [1, 2]';
  }
  i.spellcheck = false;
  return i;
}

export function addInsertRow(opts) {
  const tr = document.createElement('tr');
  const row = {
    tr,
    kind: opts.kind || 'text',
    input: null,
    nameInput: null,
    fixedName: opts.name || null,
    auto: !!opts.auto,
    required: !!opts.required,
  };

  const nameTd = document.createElement('td');
  if (opts.nameEditable) {
    row.nameInput = document.createElement('input');
    row.nameInput.type = 'text';
    row.nameInput.placeholder = 'nome campo';
    row.nameInput.spellcheck = false;
    nameTd.appendChild(row.nameInput);
  } else {
    nameTd.innerHTML = `<span class="mono">${esc(opts.name)}</span>` +
      (opts.required ? '<span class="req" title="Obbligatorio: NOT NULL senza default"> *</span>' : '');
  }
  tr.appendChild(nameTd);

  const typeTd = document.createElement('td');
  typeTd.className = 'insert-type';
  if (opts.nameEditable) {
    const sel = document.createElement('select');
    const kinds = [['text', 'testo'], ['number', 'numero'], ['bool', 'booleano'],
                   ['datetime', 'data'], ['oid', 'ObjectId'], ['json', 'JSON']];
    for (const [v, label] of kinds) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      row.kind = sel.value;
      const fresh = insertInputFor(row.kind);
      row.input.replaceWith(fresh);
      row.input = fresh;
    });
    typeTd.appendChild(sel);
  } else {
    typeTd.innerHTML = `<span class="dim">${esc(opts.typeLabel || '')}</span>`;
  }
  tr.appendChild(typeTd);

  const valTd = document.createElement('td');
  valTd.className = 'insert-value';
  if (row.auto) {
    const i = document.createElement('input');
    i.type = 'text';
    i.disabled = true;
    i.placeholder = '(auto)';
    row.input = i;
  } else {
    row.input = insertInputFor(row.kind);
  }
  valTd.appendChild(row.input);
  tr.appendChild(valTd);

  const delTd = document.createElement('td');
  delTd.className = 'row-actions';
  if (opts.removable) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del-btn';
    del.textContent = '✕';
    del.title = 'Rimuovi campo';
    del.addEventListener('click', () => {
      tr.remove();
      insertRows = insertRows.filter((r) => r !== row);
    });
    delTd.appendChild(del);
  }
  tr.appendChild(delTd);

  $('#insert-form tbody').appendChild(tr);
  insertRows.push(row);
  return row;
}

export function insertRowValue(row) {
  const raw = row.input.value;
  const t = String(raw == null ? '' : raw).trim();
  if (t === '') return undefined;
  switch (row.kind) {
    case 'number': {
      const n = Number(t);
      if (Number.isNaN(n)) throw new Error('numero non valido');
      return n;
    }
    case 'decimal':
      return state.dbType === 'mysql' ? t : { $numberDecimal: t };
    case 'bool':
      return t === 'true';
    case 'datetime': {
      const d = new Date(t + 'Z');
      if (Number.isNaN(d.getTime())) throw new Error('data non valida');
      return { $date: d.toISOString() };
    }
    case 'date':
      return t;
    case 'oid':
      if (!/^[0-9a-fA-F]{24}$/.test(t)) throw new Error('ObjectId non valido (24 caratteri esadecimali)');
      return { $oid: t };
    case 'json':
      try { return JSON.parse(t); } catch { throw new Error('JSON non valido'); }
    default:
      return raw;
  }
}

export function buildInsertDoc() {
  const doc = {};
  for (const row of insertRows) {
    if (row.auto) continue;
    const name = row.nameInput ? row.nameInput.value.trim() : row.fixedName;
    if (!name) {
      if (String(row.input.value).trim() !== '') throw new Error('C\'è un campo con un valore ma senza nome.');
      continue;
    }
    let value;
    try {
      value = insertRowValue(row);
    } catch (err) {
      throw new Error(`Campo "${name}": ${err.message}`);
    }
    if (value === undefined) {
      if (row.required) throw new Error(`Il campo "${name}" è obbligatorio (NOT NULL senza default).`);
      continue;
    }
    if (name in doc) throw new Error(`Campo duplicato: "${name}".`);
    doc[name] = value;
  }
  return doc;
}

export function selectInsertTab(name) {
  if (name === 'json' && !insertJsonTouched && !$('#insert-tab-form').classList.contains('hidden')) {
    try {
      $('#insert-json').value = JSON.stringify(buildInsertDoc(), null, 2);
    } catch { /* ignore */ }
  }
  document.querySelectorAll('[data-instab]').forEach((t) => t.classList.toggle('active', t.dataset.instab === name));
  $('#insert-tab-form').classList.toggle('hidden', name !== 'form');
  $('#insert-tab-json').classList.toggle('hidden', name !== 'json');
}

export function initInsert() {
  document.querySelectorAll('[data-instab]').forEach((tab) =>
    tab.addEventListener('click', () => selectInsertTab(tab.dataset.instab))
  );

  $('#insert-json').addEventListener('input', () => { insertJsonTouched = true; });

  $('#insert-addfield').addEventListener('click', () => {
    $('#insert-form-empty').classList.add('hidden');
    const row = addInsertRow({ nameEditable: true, kind: 'text', removable: true });
    row.nameInput.focus();
  });

  $('#insert-btn').addEventListener('click', () => {
    const isSql = isSqlType(state.dbType);
    $('#insert-title').textContent = isSql ? 'Nuova riga' : 'Nuovo documento';
    $('#insert-json').value = '{\n  \n}';
    insertJsonTouched = false;
    insertRows = [];
    $('#insert-form tbody').innerHTML = '';
    $('#insert-form-empty').classList.add('hidden');
    $('#insert-addfield').classList.toggle('hidden', isSql);
    $('#insert-error').classList.add('hidden');
    selectInsertTab('form');
    openModal('#insert-overlay');

    emit('collection:stats', { db: state.db, coll: state.coll }).then((res) => {
      for (const f of res.fields) {
        if (f.name === '_id' && !isSql) continue;
        const mainType = f.types.find((t) => t !== 'null') || 'null';
        addInsertRow({
          name: f.name,
          typeLabel: f.types.join(', '),
          kind: insertKindOf(mainType),
          auto: !!f.autoIncrement,
          required: isSql && !f.nullable && f.default == null && !f.autoIncrement,
        });
      }
      if (!insertRows.length) $('#insert-form-empty').classList.remove('hidden');
      const first = insertRows.find((r) => !r.auto);
      if (first) first.input.focus();
    }).catch((err) => toast(err.message, true));
  });

  $('#insert-cancel').addEventListener('click', () => closeModal('#insert-overlay'));

  $('#insert-save').addEventListener('click', () => {
    const usingForm = !$('#insert-tab-form').classList.contains('hidden');
    let docText;
    if (usingForm) {
      try {
        docText = JSON.stringify(buildInsertDoc());
      } catch (err) {
        const el = $('#insert-error');
        el.textContent = err.message;
        el.classList.remove('hidden');
        return;
      }
    } else {
      docText = $('#insert-json').value;
    }
    emit('doc:insert', {
      db: state.db,
      coll: state.coll,
      doc: docText,
    }).then(() => {
      closeModal('#insert-overlay');
      toast(isSqlType(state.dbType) ? 'Riga inserita' : 'Documento inserito');
      runQuery();
    }).catch((err) => {
      const errorEl = $('#insert-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });
}
