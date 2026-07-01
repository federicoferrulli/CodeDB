import { state } from './state.js';
import { socket } from './socket.js';
import { $, emit, toast, openModal, closeModal, invalidateSchema, colDone } from './utils.js';
import { refreshDbTree, collWord } from './dbtree.js';
import { closeCollTabsWhere, updateCollTabs } from './colltabs.js';
import { loadDetails } from './details.js';

let creatingCollDb = null;
let colEditOldName = null;

export function openCreateDb() {
  const isMysql = state.dbType === 'mysql';
  $('#dbcreate-subtitle').textContent = isMysql
    ? 'In MySQL la prima tabella è facoltativa (verrà creata con una colonna id auto-incrementale).'
    : 'In MongoDB un database esiste solo se contiene almeno una collection.';
  $('#dbcreate-coll-label').textContent = isMysql ? 'Prima tabella' : 'Prima collection';
  $('#dbcreate-coll').placeholder = isMysql ? '(opzionale)' : 'collection1';
  $('#dbcreate-name').value = '';
  $('#dbcreate-coll').value = '';
  $('#dbcreate-error').classList.add('hidden');
  openModal('#dbcreate-overlay');
  $('#dbcreate-name').focus();
}

export function renameDb(name) {
  const input = prompt(`Nuovo nome per il database "${name}":\n(le collection verranno copiate nel nuovo database)`, name);
  if (input == null) return;
  const newName = input.trim();
  if (!newName || newName === name) return;
  emit('db:rename', { db: name, newName }).then(() => {
    toast(`Database rinominato in "${newName}"`);
    state.expandedDbs.delete(name);
    state.expandedDbs.add(newName);
    // I coll-tab aperti sul vecchio nome seguono la rinomina.
    updateCollTabs((ct) => { if (ct.db === name) ct.db = newName; });
    if (state.db === name) {
      state.db = newName;
      invalidateSchema();
      state.dbSchemaFor = null;
      $('#breadcrumb').textContent = `${newName} ▸ ${state.coll}`;
      import('./grid.js').then(({ runQuery }) => runQuery());
      import('./live.js').then(({ startWatch }) => startWatch());
    }
    refreshDbTree();
  }).catch((err) => toast(err.message, true));
}

export function dropDb(name) {
  if (!confirm(`Eliminare il database "${name}" e TUTTI i suoi dati?\nL'operazione non è reversibile.`)) return;
  emit('db:drop', { db: name }).then(() => {
    toast(`Database "${name}" eliminato`);
    state.expandedDbs.delete(name);
    closeCollTabsWhere((ct) => ct.db === name);
    refreshDbTree();
  }).catch((err) => toast(err.message, true));
}

function addColRow(values = {}) {
  const tr = document.createElement('tr');
  const cell = (el) => {
    const td = document.createElement('td');
    td.appendChild(el);
    return td;
  };
  const text = (cls, value, placeholder, list) => {
    const i = document.createElement('input');
    i.type = 'text';
    i.className = cls;
    i.value = value || '';
    if (placeholder) i.placeholder = placeholder;
    if (list) i.setAttribute('list', list);
    i.spellcheck = false;
    return i;
  };
  const check = (cls, checked) => {
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.className = cls;
    i.checked = !!checked;
    return i;
  };
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'del-btn';
  del.textContent = '✕';
  del.title = 'Rimuovi colonna';
  del.addEventListener('click', () => tr.remove());

  tr.append(
    cell(text('col-name', values.name, 'nome')),
    cell(text('col-type', values.type, 'es. VARCHAR(255)', 'mysql-types')),
    cell(check('col-null', values.nullable !== false)),
    cell(text('col-default', values.default, '')),
    cell(check('col-ai', values.autoIncrement)),
    cell(check('col-pk', values.primaryKey)),
    cell(del)
  );
  $('#collcreate-cols tbody').appendChild(tr);
}

function readColRows() {
  return [...$('#collcreate-cols tbody').querySelectorAll('tr')]
    .map((tr) => ({
      name: tr.querySelector('.col-name').value.trim(),
      type: tr.querySelector('.col-type').value.trim(),
      nullable: tr.querySelector('.col-null').checked,
      default: tr.querySelector('.col-default').value,
      autoIncrement: tr.querySelector('.col-ai').checked,
      primaryKey: tr.querySelector('.col-pk').checked,
    }))
    .filter((c) => c.name || c.type);
}

export function openCreateColl(dbName) {
  creatingCollDb = dbName;
  const isMysql = state.dbType === 'mysql';
  $('#collcreate-title').textContent = isMysql ? 'Nuova tabella' : 'Nuova collection';
  $('#collcreate-subtitle').textContent = `Database: ${dbName}`;
  $('#collcreate-name').value = '';
  $('#collcreate-schema').classList.toggle('hidden', !isMysql);
  $('#collcreate-cols tbody').innerHTML = '';
  if (isMysql) addColRow({ name: 'id', type: 'INT UNSIGNED', nullable: false, autoIncrement: true, primaryKey: true });
  $('#collcreate-error').classList.add('hidden');
  openModal('#collcreate-overlay');
  $('#collcreate-name').focus();
}

export function renameColl(dbName, collName) {
  const input = prompt(`Nuovo nome per la ${collWord()} "${collName}":`, collName);
  if (input == null) return;
  const newName = input.trim();
  if (!newName || newName === collName) return;
  emit('collection:rename', { db: dbName, coll: collName, newName }).then(() => {
    toast(`Rinominata in "${newName}"`);
    invalidateSchema();
    updateCollTabs((ct) => { if (ct.db === dbName && ct.coll === collName) ct.coll = newName; });
    if (state.db === dbName && state.coll === collName) {
      state.coll = newName;
      $('#breadcrumb').textContent = `${dbName} ▸ ${newName}`;
      import('./grid.js').then(({ runQuery }) => runQuery());
      import('./live.js').then(({ startWatch }) => startWatch());
    }
    refreshDbTree();
  }).catch((err) => toast(err.message, true));
}

export function dropColl(dbName, collName) {
  if (!confirm(`Eliminare la ${collWord()} "${collName}" e TUTTI i suoi dati?\nL'operazione non è reversibile.`)) return;
  emit('collection:drop', { db: dbName, coll: collName }).then(() => {
    toast(`"${collName}" eliminata`);
    invalidateSchema();
    closeCollTabsWhere((ct) => ct.db === dbName && ct.coll === collName);
    refreshDbTree();
  }).catch((err) => toast(err.message, true));
}

export function openColumnModal(field) {
  const isMysql = state.dbType === 'mysql';
  colEditOldName = field ? field.name : null;
  $('#coledit-title').textContent = field ? `Modifica ${collWord(true)} "${field.name}"` : `Aggiungi ${collWord()}`;
  $('#coledit-name').value = field ? field.name : '';

  $('#coledit-type-row').classList.toggle('hidden', !isMysql);
  $('#coledit-bsontype-row').classList.toggle('hidden', isMysql || !field);
  $('#coledit-null-row').classList.toggle('hidden', !isMysql);
  $('#coledit-default-row').classList.toggle('hidden', !isMysql && !!field);
  $('#coledit-default-label').textContent = isMysql ? 'Default' : 'Valore iniziale per i documenti esistenti';
  $('#coledit-default').placeholder = isMysql
    ? '(nessuno; testo, numero o CURRENT_TIMESTAMP)'
    : '(vuoto = null; testo, numero o EJSON come {"$date": "..."})';

  $('#coledit-type').value = field && isMysql ? field.types[0] : '';
  $('#coledit-bsontype').value = '';
  $('#coledit-null').checked = field ? !!field.nullable : true;
  $('#coledit-default').value = field && field.default != null ? field.default : '';
  $('#coledit-error').classList.add('hidden');
  openModal('#coledit-overlay');
  $('#coledit-name').focus();
}

export function initSchemaOps() {
  $('#dbcreate-cancel').addEventListener('click', () => closeModal('#dbcreate-overlay'));
  
  $('#dbcreate-save').addEventListener('click', () => {
    const db = $('#dbcreate-name').value.trim();
    const coll = $('#dbcreate-coll').value.trim();
    emit('db:create', { db, coll }).then(() => {
      closeModal('#dbcreate-overlay');
      toast(`Database "${db}" creato`);
      state.expandedDbs.add(db);
      refreshDbTree();
    }).catch((err) => {
      const errorEl = $('#dbcreate-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });

  for (const sel of ['#dbcreate-name', '#dbcreate-coll']) {
    $(sel).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#dbcreate-save').click();
    });
  }

  $('#collcreate-addcol').addEventListener('click', () => addColRow());
  $('#collcreate-cancel').addEventListener('click', () => closeModal('#collcreate-overlay'));

  $('#collcreate-save').addEventListener('click', () => {
    const name = $('#collcreate-name').value.trim();
    const payload = { db: creatingCollDb, name };
    if (state.dbType === 'mysql') payload.columns = readColRows();
    emit('collection:create', payload).then(() => {
      closeModal('#collcreate-overlay');
      toast(`${state.dbType === 'mysql' ? 'Tabella' : 'Collection'} "${name}" creata`);
      state.expandedDbs.add(creatingCollDb);
      invalidateSchema();
      refreshDbTree();
    }).catch((err) => {
      const errorEl = $('#collcreate-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });

  $('#collcreate-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#collcreate-save').click();
  });

  $('#column-add-btn').addEventListener('click', () => openColumnModal(null));
  $('#coledit-cancel').addEventListener('click', () => closeModal('#coledit-overlay'));

  $('#schema-table').addEventListener('click', (e) => {
    const editBtn = e.target.closest('.col-edit');
    if (editBtn) return openColumnModal(JSON.parse(editBtn.dataset.field));
    const delBtn = e.target.closest('.col-del');
    if (!delBtn) return;
    const name = delBtn.dataset.name;
    const msg = state.dbType === 'mysql'
      ? `Eliminare la colonna "${name}" e tutti i suoi dati?\nL'operazione non è reversibile.`
      : `Rimuovere il campo "${name}" da TUTTI i documenti della collection?\nL'operazione non è reversibile.`;
    if (!confirm(msg)) return;
    emit('column:drop', { db: state.db, coll: state.coll, name }).then((res) => {
      toast(`${collWord(true)} "${name}" ${colDone('eliminat')}` +
        (res.modified != null ? ` (${res.modified} documenti aggiornati)` : ''));
      invalidateSchema();
      loadDetails();
    }).catch((err) => toast(err.message, true));
  });

  $('#coledit-save').addEventListener('click', () => {
    const isMysql = state.dbType === 'mysql';
    const column = isMysql
      ? {
          name: $('#coledit-name').value.trim(),
          type: $('#coledit-type').value.trim(),
          nullable: $('#coledit-null').checked,
          default: $('#coledit-default').value,
        }
      : colEditOldName
        ? { name: $('#coledit-name').value.trim(), type: $('#coledit-bsontype').value }
        : { name: $('#coledit-name').value.trim(), default: $('#coledit-default').value };
    const event = colEditOldName ? 'column:alter' : 'column:add';
    const payload = colEditOldName
      ? { db: state.db, coll: state.coll, oldName: colEditOldName, column }
      : { db: state.db, coll: state.coll, column };
    emit(event, payload).then((res) => {
      closeModal('#coledit-overlay');
      const verb = colEditOldName ? 'modificat' : 'aggiunt';
      const done = `${collWord(true)} "${column.name}" ${colDone(verb)}`;
      toast(done + (res.modified != null ? ` (${res.modified} documenti aggiornati)` : ''));
      invalidateSchema();
      loadDetails();
    }).catch((err) => {
      const errorEl = $('#coledit-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });
}
