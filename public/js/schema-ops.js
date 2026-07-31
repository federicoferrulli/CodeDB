import { state } from './state.js';
import { socket } from './socket.js';
import { $, emit, toast, openModal, closeModal, colDone, isSqlType, isForActiveTab } from './utils.js';
import { refreshDbTree, collWord, dbWord } from './dbtree.js';
import { closeCollTabsWhere, updateCollTabs } from './colltabs.js';
import { loadDetails } from './details.js';

let creatingCollDb = null;
let colEditOldName = null;

export function openCreateDb() {
  const isSql = isSqlType(state.dbType);
  $('#dbcreate-subtitle').textContent = isSql
    ? 'Nei DB SQL la prima tabella è facoltativa (verrà creata con una colonna id auto-incrementale).'
    : 'In MongoDB un database esiste solo se contiene almeno una collection.';
  $('#dbcreate-coll-label').textContent = isSql ? 'Prima tabella' : 'Prima collection';
  $('#dbcreate-coll').placeholder = isSql ? '(opzionale)' : 'collection1';
  $('#dbcreate-name').value = '';
  $('#dbcreate-coll').value = '';
  $('#dbcreate-error').classList.add('hidden');
  openModal('#dbcreate-overlay');
  $('#dbcreate-name').focus();
}

export function renameDb(name) {
  // Su PostgreSQL il livello è lo SCHEMA e la rinomina è un ALTER SCHEMA
  // istantaneo: la nota sulla copia vale solo per MongoDB/MySQL.
  const isSchema = dbWord() === 'schema';
  const input = prompt(
    isSchema
      ? `Nuovo nome per lo schema "${name}":`
      : `Nuovo nome per il database "${name}":\n(le collection verranno copiate nel nuovo database)`,
    name
  );
  if (input == null) return;
  const newName = input.trim();
  if (!newName || newName === name) return;
  emit('db:rename', { db: name, newName }).then((res) => {
    // Lo stato da aggiornare è quello del tab che ha chiesto la rinomina, non di
    // quello attivo alla risposta: una rinomina copia le collection e può durare.
    const st = res._state;
    toast(`${dbWord(true)} rinominato in "${newName}"`);
    st.expandedDbs.delete(name);
    st.expandedDbs.add(newName);
    // I coll-tab aperti sul vecchio nome seguono la rinomina.
    updateCollTabs((ct) => { if (ct.db === name) ct.db = newName; }, st);
    if (st.db === name) {
      st.db = newName;
      st.dbSchema = null;
      st.dbSchemaFor = null;
    }
    // Breadcrumb, griglia e sidebar sono il workspace condiviso: si toccano solo
    // se questo tab è ancora quello in primo piano.
    if (!isForActiveTab(res)) return;
    if (st.db === newName) {
      $('#breadcrumb').textContent = `${newName} ▸ ${st.coll}`;
      import('./grid.js').then(({ runQuery }) => runQuery({ auto: true })); // refresh post-rename
      import('./live.js').then(({ startWatch }) => startWatch());
    }
    refreshDbTree();
  }).catch((err) => toast(err.message, true));
}

export function dropDb(name) {
  const what = dbWord() === 'schema'
    ? `lo schema "${name}" e TUTTE le tabelle che contiene`
    : `il database "${name}" e TUTTI i suoi dati`;
  if (!confirm(`Eliminare ${what}?
L'operazione non è reversibile.`)) return;
  emit('db:drop', { db: name }).then((res) => {
    toast(`${dbWord(true)} "${name}" eliminato`);
    res._state.expandedDbs.delete(name);
    closeCollTabsWhere((ct) => ct.db === name, res._state);
    if (isForActiveTab(res)) refreshDbTree();
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

  const typeListId = state.dbType === 'postgresql' ? 'postgres-types' : 'mysql-types';
  tr.append(
    cell(text('col-name', values.name, 'nome')),
    cell(text('col-type', values.type, 'es. VARCHAR(255)', typeListId)),
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
  const isSql = isSqlType(state.dbType);
  $('#collcreate-title').textContent = isSql ? 'Nuova tabella' : 'Nuova collection';
  $('#collcreate-subtitle').textContent = `Database: ${dbName}`;
  $('#collcreate-name').value = '';
  $('#collcreate-schema').classList.toggle('hidden', !isSql);
  $('#collcreate-cols tbody').innerHTML = '';
  if (isSql) addColRow({ name: 'id', type: 'INT', nullable: false, autoIncrement: true, primaryKey: true });
  $('#collcreate-error').classList.add('hidden');
  openModal('#collcreate-overlay');
  $('#collcreate-name').focus();
}

export function renameColl(dbName, collName) {
  const input = prompt(`Nuovo nome per la ${collWord()} "${collName}":`, collName);
  if (input == null) return;
  const newName = input.trim();
  if (!newName || newName === collName) return;
  emit('collection:rename', { db: dbName, coll: collName, newName }).then((res) => {
    const st = res._state;
    toast(`Rinominata in "${newName}"`);
    st.dbSchema = null;
    updateCollTabs((ct) => { if (ct.db === dbName && ct.coll === collName) ct.coll = newName; }, st);
    const wasOpen = st.db === dbName && st.coll === collName;
    if (wasOpen) st.coll = newName;
    if (!isForActiveTab(res)) return; // workspace condiviso: non toccarlo da un altro tab
    if (wasOpen) {
      $('#breadcrumb').textContent = `${dbName} ▸ ${newName}`;
      import('./grid.js').then(({ runQuery }) => runQuery({ auto: true })); // refresh post-rename
      import('./live.js').then(({ startWatch }) => startWatch());
    }
    refreshDbTree();
  }).catch((err) => toast(err.message, true));
}

export function dropColl(dbName, collName) {
  if (!confirm(`Eliminare la ${collWord()} "${collName}" e TUTTI i suoi dati?\nL'operazione non è reversibile.`)) return;
  emit('collection:drop', { db: dbName, coll: collName }).then((res) => {
    toast(`"${collName}" eliminata`);
    res._state.dbSchema = null;
    closeCollTabsWhere((ct) => ct.db === dbName && ct.coll === collName, res._state);
    if (isForActiveTab(res)) refreshDbTree();
  }).catch((err) => toast(err.message, true));
}

export function openColumnModal(field) {
  const isSql = isSqlType(state.dbType);
  colEditOldName = field ? field.name : null;
  $('#coledit-title').textContent = field ? `Modifica ${collWord(true)} "${field.name}"` : `Aggiungi ${collWord()}`;
  $('#coledit-name').value = field ? field.name : '';

  $('#coledit-type-row').classList.toggle('hidden', !isSql);
  $('#coledit-bsontype-row').classList.toggle('hidden', isSql || !field);
  $('#coledit-null-row').classList.toggle('hidden', !isSql);
  $('#coledit-default-row').classList.toggle('hidden', !isSql && !!field);
  $('#coledit-default-label').textContent = isSql ? 'Default' : 'Valore iniziale per i documenti esistenti';
  $('#coledit-default').placeholder = isSql
    ? '(nessuno; testo, numero o CURRENT_TIMESTAMP)'
    : '(vuoto = null; testo, numero o EJSON come {"$date": "..."})';

  const typeListId = state.dbType === 'postgresql' ? 'postgres-types' : 'mysql-types';
  $('#coledit-type').setAttribute('list', typeListId);
  $('#coledit-type').value = field && isSql ? field.types[0] : '';
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
    emit('db:create', { db, coll }).then((res) => {
      closeModal('#dbcreate-overlay');
      toast(`${dbWord(true)} "${db}" creato`);
      res._state.expandedDbs.add(db);
      if (isForActiveTab(res)) refreshDbTree();
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
    const isSql = isSqlType(state.dbType);
    if (isSql) payload.columns = readColRows();
    emit('collection:create', payload).then((res) => {
      closeModal('#collcreate-overlay');
      toast(`${isSql ? 'Tabella' : 'Collection'} "${name}" creata`);
      res._state.expandedDbs.add(creatingCollDb);
      res._state.dbSchema = null;
      if (isForActiveTab(res)) refreshDbTree();
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
    const isSql = isSqlType(state.dbType);
    const msg = isSql
      ? `Eliminare la colonna "${name}" e tutti i suoi dati?\nL'operazione non è reversibile.`
      : `Rimuovere il campo "${name}" da TUTTI i documenti della collection?\nL'operazione non è reversibile.`;
    if (!confirm(msg)) return;
    emit('column:drop', { db: state.db, coll: state.coll, name }).then((res) => {
      toast(`${collWord(true)} "${name}" ${colDone('eliminat')}` +
        (res.modified != null ? ` (${res.modified} documenti aggiornati)` : ''));
      res._state.dbSchema = null;
      if (isForActiveTab(res)) loadDetails();
    }).catch((err) => toast(err.message, true));
  });

  $('#coledit-save').addEventListener('click', () => {
    const isSql = isSqlType(state.dbType);
    const column = isSql
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
      res._state.dbSchema = null;
      if (isForActiveTab(res)) loadDetails();
    }).catch((err) => {
      const errorEl = $('#coledit-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });
}
