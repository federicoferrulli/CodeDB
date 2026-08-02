import { state } from './state.js';
import { $, emit, showContextMenu, toast, isSqlType, refreshLucideIcons, isForActiveTab } from './utils.js';
import { setView } from './main.js'; // or grid.js
import { selectCollection } from './grid.js';
import { openCreateColl, openCreateDb, renameDb, dropDb, renameColl, dropColl } from './schema-ops.js';
import { exportImportMenuItems, dbExportImportMenuItems, openDbImportModal } from './exportimport.js';
import { addOrSplitPane } from './splitview.js';
import { activeTab } from './tabs.js';
import { openDbTab } from './colltabs.js';

export function collWord(capital) {
  const w = isSqlType(state.dbType) ? 'tabella' : 'collection';
  return capital ? w[0].toUpperCase() + w.slice(1) : w;
}

// Nome del livello superiore della sidebar. Su PostgreSQL non sono database ma
// SCHEMI del database connesso (vedi la nota in PostgreSqlStrategy): chiamarli
// "database" farebbe credere di poter passare da un database all'altro, cosa
// che con un pool legato a cfg.database non è possibile.
export function dbWord(capital) {
  const t = state.dbType;
  const w = (t === 'postgresql' || t === 'postgres') ? 'schema' : 'database';
  return capital ? w[0].toUpperCase() + w.slice(1) : w;
}

export function renderDbTree(databases) {
  state.databases = databases; // cache per il ri-render al cambio tab
  const tree = $('#db-tree');
  tree.innerHTML = '';
  if (!databases || databases.length === 0) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'node-label loading';
    emptyLi.textContent = `Nessuno ${dbWord()} trovato.`;
    tree.appendChild(emptyLi);
    return;
  }
  for (const db of databases) {
    const li = document.createElement('li');
    li.className = 'db';
    const label = document.createElement('div');
    label.className = 'node-label';
    // Costruzione per NODI, non via innerHTML: il nome del database è un dato
    // non fidato (i DBMS accettano identificatori arbitrari se quotati, quindi
    // `CREATE DATABASE "<img src=x onerror=…>"` è legale) e qui finiva nel DOM
    // senza escape. Bastava che un utente con la sola capability `ddl` creasse
    // un database così: il payload si attivava per CHIUNQUE aprisse quella
    // connessione — token di sessione, credenziali in memoria e socket con i
    // privilegi della vittima. È lo stesso schema per nodi già usato da
    // renderCollectionsList poche righe più sotto.
    const dbIcon = document.createElement('i');
    dbIcon.dataset.lucide = 'database';
    dbIcon.className = 'icon-db';
    const dbName = document.createElement('span');
    dbName.textContent = db.name;
    label.append(dbIcon, ' ', dbName);
    li.appendChild(label);

    const sub = document.createElement('ul');
    sub.classList.add('hidden');
    li.appendChild(sub);

    label.addEventListener('click', () => {
      if (!sub.classList.contains('hidden')) {
        sub.classList.add('hidden');
        state.expandedDbs.delete(db.name);
        return;
      }
      sub.classList.remove('hidden');
      state.expandedDbs.add(db.name);
      if (sub.childElementCount === 0) loadCollections(db.name, sub);
    });

    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        // Utile soprattutto sui database vuoti, dove non c'è alcuna collection
        // da aprire e quindi nessun modo di raggiungere il Query Engine.
        { label: `⚡ Query & Aggregate su questo ${dbWord()}`, action: () => openDbTab(db.name) },
        '---',
        { label: `＋ Nuova ${collWord()}…`, action: () => openCreateColl(db.name) },
        { label: `＋ Nuovo ${dbWord()}…`, action: openCreateDb },
        { label: `✎ Rinomina ${dbWord()}…`, action: () => renameDb(db.name) },
        { label: '⟳ Aggiorna elenco', action: refreshDbTree },
        '---',
        ...dbExportImportMenuItems(db.name),
        '---',
        { label: `🗑 Elimina ${dbWord()}…`, danger: true, action: () => dropDb(db.name) },
      ]);
    });

    if (db.collections) {
      sub.classList.remove('hidden');
      state.expandedDbs.add(db.name);
      renderCollectionsList(db.name, sub, db.collections);
    } else {
      if (state.expandedDbs.has(db.name)) {
        sub.classList.remove('hidden');
        loadCollections(db.name, sub);
      }
    }

    tree.appendChild(li);
  }
  refreshLucideIcons(tree);
}

export function renderCollectionsList(dbName, container, collections) {
  container.innerHTML = '';
  // Database vuoto: prima non compariva NULLA sotto il nodo espanso, quindi non
  // si distingueva un database senza tabelle da uno ancora in caricamento, e
  // soprattutto non c'era niente da cliccare — nemmeno per creare la prima
  // tabella con una query. Ora lo si dice, e si offrono le due vie d'uscita.
  if (!collections || collections.length === 0) {
    const li = document.createElement('li');
    li.className = 'node-empty';

    const msg = document.createElement('div');
    msg.className = 'node-empty-msg';
    msg.textContent = `Nessuna ${collWord()} in questo ${dbWord()}.`;
    li.appendChild(msg);

    const query = document.createElement('button');
    query.type = 'button';
    query.className = 'node-empty-action';
    query.textContent = `⚡ Apri Query & Aggregate`;
    query.title = `Esegui query sul ${dbWord()} "${dbName}" senza aprire una ${collWord()}`;
    query.addEventListener('click', (e) => { e.stopPropagation(); openDbTab(dbName); });
    li.appendChild(query);

    const crea = document.createElement('button');
    crea.type = 'button';
    crea.className = 'node-empty-action';
    crea.textContent = `＋ Nuova ${collWord()}…`;
    crea.addEventListener('click', (e) => { e.stopPropagation(); openCreateColl(dbName); });
    li.appendChild(crea);

    container.appendChild(li);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const coll of collections) {
    const li = document.createElement('li');
    li.className = 'coll';
    const label = document.createElement('div');
    label.className = 'node-label';
    label.draggable = true;

    label.innerHTML = `<i data-lucide="table" class="icon-coll"></i> `;
    const name = document.createElement('span');
    name.textContent = coll.name;
    label.appendChild(name);
    label.dataset.db = dbName;
    label.dataset.coll = coll.name;
    if (dbName === state.db && coll.name === state.coll) label.classList.add('selected');

    if (coll.count !== null && coll.count !== undefined) {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = coll.count;
      label.appendChild(count);
    }

    label.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'copy';
      const t = activeTab();
      const payload = { db: dbName, coll: coll.name, tabId: t ? t.id : null };
      e.dataTransfer.setData('application/codedb-tab', JSON.stringify(payload));
      e.dataTransfer.setData('text/plain', coll.name);
      label.classList.add('dragging');
    });
    label.addEventListener('dragend', () => label.classList.remove('dragging'));

    label.addEventListener('click', () => selectCollection(dbName, coll.name, label));
    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: '▤ Apri dati', action: () => selectCollection(dbName, coll.name, label) },
        { label: '🔲 Affianca in Split-View', action: () => addOrSplitPane(null, 'right', { db: dbName, coll: coll.name, tabId: activeTab()?.id }) },
        { label: `ℹ Dettagli ${collWord()}`, action: () => { selectCollection(dbName, coll.name, label); setView('details'); } },
        { label: '◫ Diagramma UML', action: () => { selectCollection(dbName, coll.name, label); setView('uml'); } },
        '---',
        ...exportImportMenuItems(dbName, coll.name),
        '---',
        { label: `✎ Rinomina ${collWord()}…`, action: () => renameColl(dbName, coll.name) },
        { label: `🗑 Elimina ${collWord()}…`, danger: true, action: () => dropColl(dbName, coll.name) },
      ]);
    });
    li.appendChild(label);
    frag.appendChild(li);
  }
  container.appendChild(frag);
  refreshLucideIcons(container);
}

export function loadCollections(dbName, container) {
  container.innerHTML = '<li class="node-label loading">caricamento…</li>';
  emit('db:collections', { db: dbName }).then((res) => {
    // La sidebar è un DOM unico: se l'utente ha cambiato tab mentre la richiesta
    // era in volo, `container` appartiene ormai all'albero di un'altra
    // connessione e riempirlo mostrerebbe tabelle che non esistono lì.
    if (!isForActiveTab(res)) return;
    renderCollectionsList(dbName, container, res.collections);
  }).catch((err) => {
    if (!isForActiveTab(err)) return;
    container.innerHTML = '';
    toast(err.message, true);
  });
}

export function refreshDbTree() {
  emit('db:list', {}).then((res) => {
    // Elenco di un tab non più in primo piano: aggiorna solo la sua cache, che
    // verrà usata al ritorno; ridipingere sostituirebbe l'albero di un'altra
    // connessione con i database di questa.
    if (!isForActiveTab(res)) { res._state.databases = res.databases; return; }
    renderDbTree(res.databases);
  }).catch((err) => { if (isForActiveTab(err)) toast(err.message, true); });
}

export function initDbTree() {
  $('#sidebar').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.node-label') || e.target.closest('.sidebar-search')) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: `＋ Nuovo ${dbWord()}…`, action: openCreateDb },
      { label: `⤒ Importa ${dbWord()}…`, action: openDbImportModal },
      { label: '⟳ Aggiorna elenco', action: refreshDbTree },
    ]);
  });
  $('#new-db-btn').addEventListener('click', openCreateDb);

  let searchTimer = null;
  $('#db-search').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (!q) {
        refreshDbTree();
        return;
      }
      $('#db-tree').innerHTML = '<li class="node-label loading">ricerca in corso…</li>';
      emit('db:search', { query: q }).then((res) => {
        if (!isForActiveTab(res)) return; // risultati di un'altra connessione
        renderDbTree(res.databases);
      }).catch((err) => { if (isForActiveTab(err)) toast(err.message, true); });
    }, 300);
  });
}
