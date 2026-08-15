import { state } from './state.js';
import { $, emit, toast, openModal, closeModal, isSqlType, isForActiveTab, chiediTesto, conCaricamento, captureContext } from './utils.js';
import { refreshDbTree, collWord, dbWord } from './dbtree.js';
import { closeCollTabsWhere, updateCollTabs } from './colltabs.js';
import { loadDetails } from './details.js';

let dbCreateContext = null;
let collCreateContext = null;
let columnEditContext = null;
let colEditOldName = null;
let colEditOriginal = null;

// Le modali sono DOM globali e possono restare aperte mentre cambia il tab di
// connessione o il coll-tab. Il bersaglio va quindi copiato per valore quando la
// modale nasce: `ctx.st.db` da solo non basta, perché lo stesso oggetto state
// cambia db/coll all'attivazione di un'altra scheda.
function captureSchemaTarget(extra = {}) {
  return {
    ...captureContext(),
    db: state.db,
    coll: state.coll,
    dbType: state.dbType,
    ...extra,
  };
}

function aggiornaAlberoDopoDdl(res) {
  const st = res._state;
  st.schemaDirty = true;
  if (isForActiveTab(res)) {
    st.schemaDirty = false;
    refreshDbTree();
  }
}

function fieldWord(dbType, capital = false) {
  const word = isSqlType(dbType) ? 'colonna' : 'campo';
  return capital ? word[0].toUpperCase() + word.slice(1) : word;
}

function fieldDone(dbType, verb) {
  return verb + (isSqlType(dbType) ? 'a' : 'o');
}

export function openCreateDb() {
  dbCreateContext = captureSchemaTarget({ word: dbWord(), wordCap: dbWord(true) });
  const isSql = isSqlType(dbCreateContext.dbType);
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

export async function renameDb(name) {
  const origin = captureSchemaTarget({ word: dbWord(), wordCap: dbWord(true) });
  // Su PostgreSQL il livello è lo SCHEMA e la rinomina è un ALTER SCHEMA
  // istantaneo. Su MongoDB e MySQL non esiste un comando equivalente: il server
  // copia il database (dump → verifica → restore) e l'originale resta al suo
  // posto se non si chiede diversamente. Sono due operazioni molto diverse per
  // durata e conseguenze, e la modale deve dirlo invece di chiamarle entrambe
  // "rinomina" e basta.
  const nativa = origin.dbType === 'postgresql' || origin.dbType === 'postgres';
  const input = await chiediTesto({
    titolo: `Rinomina ${origin.word}`,
    sottotitolo: nativa
      ? ''
      : `Il ${origin.word} verrà copiato — dati, indici, view, vincoli e opzioni — `
        + 'e verificato prima di concludere. Su un database grande può richiedere tempo.',
    etichetta: `Nuovo nome per "${name}"`,
    valore: name,
    ok: 'Rinomina',
    spunta: nativa ? null : {
      etichetta: `Elimina "${name}" al termine (solo se la copia risulta completa)`,
      valore: false,
    },
  });
  if (input == null) return;
  const testo = nativa ? input : input.testo;
  const eliminaOrigine = nativa ? false : !!input.spunta;
  const newName = String(testo || '').trim();
  if (!newName || newName === name) return;
  emit('db:rename', { tabId: origin.tabId, db: name, newName, eliminaOrigine }).then((res) => {
    // Lo stato da aggiornare è quello del tab che ha chiesto la rinomina, non di
    // quello attivo alla risposta: una rinomina copia le collection e può durare.
    const st = res._state;
    // L'originale sopravvive quando la rinomina è stata una COPIA e non si è
    // chiesto di eliminarlo. In quel caso esistono due database, e spostare i
    // coll-tab sul nuovo nome sarebbe una bugia: l'utente stava guardando
    // l'originale, che è ancora lì.
    const origineSparita = res.modo !== 'dump-restore' || res.origineEliminata === true;
    toast(origineSparita
      ? `${origin.wordCap} rinominato in "${newName}"`
      : `${origin.wordCap} copiato in "${newName}" (${res.documenti} documenti/righe verificati). `
        + `"${name}" è ancora presente: eliminalo tu quando hai controllato.`);
    if (origineSparita) {
      st.expandedDbs.delete(name);
      // I coll-tab aperti sul vecchio nome seguono la rinomina.
      updateCollTabs((ct) => { if (ct.db === name) ct.db = newName; }, st);
      if (st.db === name) {
        st.db = newName;
        st.dbSchema = null;
        st.dbSchemaFor = null;
      }
    }
    st.expandedDbs.add(newName);
    aggiornaAlberoDopoDdl(res);
    // Griglia e sidebar sono il workspace condiviso: si toccano solo se questo
    // tab è ancora quello in primo piano. Il nuovo nome nella barra dei coll-tab
    // l'ha già scritto `updateCollTabs`, che ridisegna la barra.
    if (!isForActiveTab(res)) return;
    if (st.db === newName) {
      import('./grid.js').then(({ runQuery }) => runQuery({ auto: true })); // refresh post-rename
      import('./live.js').then(({ startWatch }) => startWatch());
    }
  }).catch((err) => toast(err.message, true));
}

export function dropDb(name) {
  const origin = captureSchemaTarget({ word: dbWord(), wordCap: dbWord(true) });
  const what = origin.word === 'schema'
    ? `lo schema "${name}" e TUTTE le tabelle che contiene`
    : `il database "${name}" e TUTTI i suoi dati`;
  if (!confirm(`Eliminare ${what}?
L'operazione non è reversibile.`)) return;
  emit('db:drop', { tabId: origin.tabId, db: name }).then((res) => {
    toast(`${origin.wordCap} "${name}" eliminato`);
    res._state.expandedDbs.delete(name);
    closeCollTabsWhere((ct) => ct.db === name, res._state);
    aggiornaAlberoDopoDdl(res);
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

  const typeListId = collCreateContext && (collCreateContext.dbType === 'postgresql' || collCreateContext.dbType === 'postgres')
    ? 'postgres-types'
    : 'mysql-types';
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
  collCreateContext = captureSchemaTarget({ db: dbName, word: collWord(), wordCap: collWord(true) });
  const isSql = isSqlType(collCreateContext.dbType);
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

export async function renameColl(dbName, collName) {
  const origin = captureSchemaTarget({ db: dbName, coll: collName, word: collWord(), wordCap: collWord(true) });
  const input = await chiediTesto({
    titolo: `Rinomina ${origin.word}`,
    etichetta: `Nuovo nome per "${collName}"`,
    valore: collName,
    ok: 'Rinomina',
  });
  if (input == null) return;
  const newName = input.trim();
  if (!newName || newName === collName) return;
  emit('collection:rename', { tabId: origin.tabId, db: dbName, coll: collName, newName }).then((res) => {
    const st = res._state;
    toast(`Rinominata in "${newName}"`);
    st.dbSchema = null;
    updateCollTabs((ct) => { if (ct.db === dbName && ct.coll === collName) ct.coll = newName; }, st);
    const wasOpen = st.db === dbName && st.coll === collName;
    if (wasOpen) st.coll = newName;
    aggiornaAlberoDopoDdl(res);
    if (!isForActiveTab(res)) return; // workspace condiviso: non toccarlo da un altro tab
    if (wasOpen) {
      // Il nome nel coll-tab è già aggiornato da `updateCollTabs`.
      import('./grid.js').then(({ runQuery }) => runQuery({ auto: true })); // refresh post-rename
      import('./live.js').then(({ startWatch }) => startWatch());
    }
  }).catch((err) => toast(err.message, true));
}

export function dropColl(dbName, collName) {
  const origin = captureSchemaTarget({ db: dbName, coll: collName, word: collWord(), wordCap: collWord(true) });
  if (!confirm(`Eliminare la ${origin.word} "${collName}" e TUTTI i suoi dati?\nL'operazione non è reversibile.`)) return;
  emit('collection:drop', { tabId: origin.tabId, db: dbName, coll: collName }).then((res) => {
    toast(`"${collName}" eliminata`);
    res._state.dbSchema = null;
    closeCollTabsWhere((ct) => ct.db === dbName && ct.coll === collName, res._state);
    aggiornaAlberoDopoDdl(res);
  }).catch((err) => toast(err.message, true));
}

export function openColumnModal(field) {
  columnEditContext = captureSchemaTarget({ word: collWord(), wordCap: collWord(true) });
  const isSql = isSqlType(columnEditContext.dbType);
  colEditOldName = field ? field.name : null;
  // MySQL ricostruisce l'intera definizione con CHANGE COLUMN: gli attributi
  // non esposti dal form vanno quindi conservati dal metadato aperto.
  colEditOriginal = field ? Object.freeze({
    ...field,
    types: Array.isArray(field.types) ? Object.freeze([...field.types]) : field.types,
  }) : null;
  const word = fieldWord(columnEditContext.dbType);
  $('#coledit-title').textContent = field ? `Modifica ${word} "${field.name}"` : `Aggiungi ${word}`;
  $('#coledit-name').value = field ? field.name : '';

  $('#coledit-type-row').classList.toggle('hidden', !isSql);
  $('#coledit-bsontype-row').classList.toggle('hidden', isSql || !field);
  $('#coledit-null-row').classList.toggle('hidden', !isSql);
  $('#coledit-default-row').classList.toggle('hidden', !isSql && !!field);
  $('#coledit-default-label').textContent = isSql ? 'Default' : 'Valore iniziale per i documenti esistenti';
  $('#coledit-default').placeholder = isSql
    ? '(nessuno; testo, numero o CURRENT_TIMESTAMP)'
    : '(vuoto = null; testo, numero o EJSON come {"$date": "..."})';

  const typeListId = columnEditContext.dbType === 'postgresql' || columnEditContext.dbType === 'postgres'
    ? 'postgres-types'
    : 'mysql-types';
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
  $('#dbcreate-cancel').addEventListener('click', () => {
    dbCreateContext = null;
    closeModal('#dbcreate-overlay');
  });
  
  $('#dbcreate-save').addEventListener('click', () => {
    const ctx = dbCreateContext;
    if (!ctx) return;
    const db = $('#dbcreate-name').value.trim();
    const coll = $('#dbcreate-coll').value.trim();
    conCaricamento($('#dbcreate-save'), () => emit('db:create', { tabId: ctx.tabId, db, coll }), 'Creo…').then((res) => {
      closeModal('#dbcreate-overlay');
      dbCreateContext = null;
      toast(`${ctx.wordCap} "${db}" creato`);
      res._state.expandedDbs.add(db);
      aggiornaAlberoDopoDdl(res);
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
  $('#collcreate-cancel').addEventListener('click', () => {
    collCreateContext = null;
    closeModal('#collcreate-overlay');
  });

  $('#collcreate-save').addEventListener('click', () => {
    const ctx = collCreateContext;
    if (!ctx) return;
    const name = $('#collcreate-name').value.trim();
    const payload = { tabId: ctx.tabId, db: ctx.db, name };
    const isSql = isSqlType(ctx.dbType);
    if (isSql) payload.columns = readColRows();
    conCaricamento($('#collcreate-save'), () => emit('collection:create', payload), 'Creo…').then((res) => {
      closeModal('#collcreate-overlay');
      collCreateContext = null;
      toast(`${isSql ? 'Tabella' : 'Collection'} "${name}" creata`);
      res._state.expandedDbs.add(ctx.db);
      res._state.dbSchema = null;
      aggiornaAlberoDopoDdl(res);
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
  $('#coledit-cancel').addEventListener('click', () => {
    columnEditContext = null;
    colEditOldName = null;
    colEditOriginal = null;
    closeModal('#coledit-overlay');
  });

  $('#schema-table').addEventListener('click', (e) => {
    const editBtn = e.target.closest('.col-edit');
    if (editBtn) return openColumnModal(JSON.parse(editBtn.dataset.field));
    const delBtn = e.target.closest('.col-del');
    if (!delBtn) return;
    const origin = captureSchemaTarget({ word: collWord(), wordCap: collWord(true) });
    const name = delBtn.dataset.name;
    const isSql = isSqlType(origin.dbType);
    const msg = isSql
      ? `Eliminare la colonna "${name}" e tutti i suoi dati?\nL'operazione non è reversibile.`
      : `Rimuovere il campo "${name}" da TUTTI i documenti della collection?\nL'operazione non è reversibile.`;
    if (!confirm(msg)) return;
    conCaricamento(delBtn, () => emit('column:drop', {
      tabId: origin.tabId, db: origin.db, coll: origin.coll, name,
    }), '').then((res) => {
      toast(`${fieldWord(origin.dbType, true)} "${name}" ${fieldDone(origin.dbType, 'eliminat')}` +
        (res.modified != null ? ` (${res.modified} documenti aggiornati)` : ''));
      res._state.dbSchema = null;
      if (isForActiveTab(res)) loadDetails();
    }).catch((err) => toast(err.message, true));
  });

  $('#coledit-save').addEventListener('click', () => {
    const ctx = columnEditContext;
    if (!ctx) return;
    const oldName = colEditOldName;
    const isSql = isSqlType(ctx.dbType);
    const column = isSql
      ? {
          name: $('#coledit-name').value.trim(),
          type: $('#coledit-type').value.trim(),
          nullable: $('#coledit-null').checked,
          default: $('#coledit-default').value,
        }
      : oldName
        ? { name: $('#coledit-name').value.trim(), type: $('#coledit-bsontype').value }
        : { name: $('#coledit-name').value.trim(), default: $('#coledit-default').value };
    // Solo MySQL usa CHANGE COLUMN e richiede la definizione completa. In
    // particolare, omettere AUTO_INCREMENT lo rimuove anche se il form non
    // offriva alcun controllo per cambiarlo. PostgreSQL segue ALTER COLUMN
    // incrementali e non deve ricevere questa estensione.
    if (ctx.dbType === 'mysql' && oldName && colEditOriginal) {
      column.autoIncrement = !!colEditOriginal.autoIncrement;
      // La chiave primaria è un vincolo/indice di tabella e alterColumn non
      // legge primaryKey: CHANGE COLUMN la conserva anche in caso di rinomina.
    }
    const event = oldName ? 'column:alter' : 'column:add';
    const payload = oldName
      ? { tabId: ctx.tabId, db: ctx.db, coll: ctx.coll, oldName, column }
      : { tabId: ctx.tabId, db: ctx.db, coll: ctx.coll, column };
    conCaricamento($('#coledit-save'), () => emit(event, payload), 'Salvo…').then((res) => {
      closeModal('#coledit-overlay');
      columnEditContext = null;
      colEditOldName = null;
      colEditOriginal = null;
      const verb = oldName ? 'modificat' : 'aggiunt';
      const done = `${fieldWord(ctx.dbType, true)} "${column.name}" ${fieldDone(ctx.dbType, verb)}`;
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
