import { state } from './state.js';
import { $, emit, showContextMenu, toast, isSqlType, refreshLucideIcons, isForActiveTab, aggiungiMenuNodo } from './utils.js';
import { setView } from './main.js'; // or grid.js
import { selectCollection } from './grid.js';
import { openCreateColl, openCreateDb, renameDb, dropDb, renameColl, dropColl } from './schema-ops.js';
import { exportImportMenuItems, dbExportImportMenuItems, openDbImportModal } from './exportimport.js';
import { addOrSplitPane, splitDisponibile } from './splitview.js';
import { activeTab, tabs } from './tabs.js';
import { openDbTab } from './colltabs.js';
import { preparaTransizioneAlbero } from './navigator-motion.js';

function renderCount(label, coll) {
  if (coll.type === 'view') { label.querySelector('.count')?.remove(); return; }
  const count = label.querySelector('.count') || document.createElement('span');
  count.className = 'count';
  const noto = coll.count != null && Number.isFinite(Number(coll.count)) && Number(coll.count) >= 0;
  const numero = noto ? Number(coll.count).toLocaleString('it-IT') : '';
  const breve = noto && coll.countApprox ? Number(coll.count).toLocaleString('it-IT', { notation: 'compact', maximumSignificantDigits: 3 }) : numero;
  const prefisso = coll.countLowerBound ? '≥ ' : coll.countApprox ? '≈ ' : '';
  count.textContent = noto ? prefisso + breve : '—';
  count.title = !noto ? 'Conteggio non disponibile entro il limite di tempo'
    : coll.countLowerBound ? `Almeno ${numero} righe; statistiche non disponibili`
      : coll.countApprox ? `Circa ${numero} righe · stima del database` : `${numero} righe · conteggio esatto`;
  count.setAttribute('aria-label', count.title);
  if (!count.parentNode) label.appendChild(count);
}

const refreshConteggi = new Map();
export function aggiornaConteggiNavigatore(db, tabId) {
  const tab = tabs.list.find(t => t.id === tabId);
  if (!tab || !db || window.frameElement?.codedbPanel) return;
  const key = JSON.stringify([tabId, db]);
  clearTimeout(refreshConteggi.get(key)?.timer);
  const job = {};
  refreshConteggi.set(key, job);
  job.timer = setTimeout(async () => {
    try {
      if (activeTab()?.id !== tabId || !tab.state.expandedDbs.has(db)) return;
      const res = await emit('db:collections', { db, tabId, _bg: true });
      if (refreshConteggi.get(key) !== job || !tabs.list.includes(tab)) return;
      const cached = tab.state.databases.find(d => d.name === db);
      if (cached) cached.collections = res.collections;
      if (activeTab()?.id !== tabId) return;
      const counts = new Map(res.collections.map(c => [c.name, c]));
      for (const label of document.querySelectorAll('#db-tree .node-label[data-coll]')) {
        if (label.dataset.db === db && counts.has(label.dataset.coll)) renderCount(label, counts.get(label.dataset.coll));
      }
    } catch { /* Il refresh dei numeri non interrompe il lavoro sulla griglia. */ }
    finally { if (refreshConteggi.get(key) === job) refreshConteggi.delete(key); }
  }, 300);
}

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
  const completaTransizione = preparaTransizioneAlbero(tree, activeTab()?.id);
  tree.innerHTML = '';
  if (!databases || databases.length === 0) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'node-label loading';
    emptyLi.textContent = `Nessuno ${dbWord()} trovato.`;
    tree.appendChild(emptyLi);
    completaTransizione();
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
    const chevron = document.createElement('i');
    chevron.dataset.lucide = 'chevron-right';
    chevron.className = 'node-chevron';
    label.append(chevron, dbIcon, dbName);
    // Il nodo del database si deve poter RITROVARE da fuori (la palette Ctrl+P
    // porta l'utente qui): senza questo attributo l'unico `[data-db]` in pagina
    // era quello delle collection, e cercare il database ne apriva una a caso.
    label.dataset.db = db.name;
    label.title = db.name;
    label.tabIndex = 0;
    label.setAttribute('role', 'button');
    li.appendChild(label);

    const sub = document.createElement('ul');
    sub.classList.add('hidden');
    li.appendChild(sub);

    label.addEventListener('click', () => {
      const completaTransizione = preparaTransizioneAlbero(tree, activeTab()?.id);
      if (!sub.classList.contains('hidden')) {
        sub.classList.add('hidden');
        state.expandedDbs.delete(db.name);
        label.setAttribute('aria-expanded', 'false');
        completaTransizione();
        return;
      }
      sub.classList.remove('hidden');
      state.expandedDbs.add(db.name);
      label.setAttribute('aria-expanded', 'true');
      if (sub.childElementCount === 0) loadCollections(db.name, sub);
      completaTransizione();
    });

    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        // Utile soprattutto sui database vuoti, dove non c'è alcuna collection
        // da aprire e quindi nessun modo di raggiungere il Query Engine.
        { icona: 'zap', label: `Query & Aggregate su questo ${dbWord()}`, action: () => openDbTab(db.name) },
        // La panoramica UML dell'intero database: prima si poteva aprire solo
        // da una tabella, cioe' partendo dal contesto sbagliato.
        { icona: 'network', label: `Diagramma UML del ${dbWord()}`, action: () => { openDbTab(db.name); setView('uml'); } },
        '---',
        { label: `＋ Nuova ${collWord()}…`, action: () => openCreateColl(db.name) },
        { label: `＋ Nuovo ${dbWord()}…`, action: openCreateDb },
        { icona: 'square-pen', label: `Rinomina ${dbWord()}…`, action: () => renameDb(db.name) },
        { label: '⟳ Aggiorna elenco', action: refreshDbTree },
        '---',
        ...dbExportImportMenuItems(db.name),
        '---',
        { icona: 'trash-2', label: `Elimina ${dbWord()}…`, danger: true, action: () => dropDb(db.name) },
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

    label.setAttribute('aria-expanded', String(!sub.classList.contains('hidden')));
    label.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); label.click(); }
    });
    aggiungiMenuNodo(label, db.name);
    tree.appendChild(li);
  }
  refreshLucideIcons(tree);
  completaTransizione();
}

export function renderCollectionsList(dbName, container, collections) {
  const completaTransizione = preparaTransizioneAlbero($('#db-tree'), activeTab()?.id);
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
    query.textContent = 'Apri Query & Aggregate';
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
    completaTransizione();
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
    label.title = `${dbName} / ${coll.name}`;
    label.tabIndex = 0;
    label.setAttribute('role', 'button');
    label.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); label.click(); }
    });
    const selected = dbName === state.db && coll.name === state.coll;
    label.classList.toggle('selected', selected);
    label.setAttribute('aria-current', selected ? 'true' : 'false');

    renderCount(label, coll);

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

    // Un clic apre in ANTEPRIMA (tab provvisorio, rimpiazzato dal clic
    // successivo su un'altra collection), il doppio clic fissa il tab.
    label.addEventListener('click', () => selectCollection(dbName, coll.name, { preview: true }));
    label.addEventListener('dblclick', () => selectCollection(dbName, coll.name));
    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: '▤ Apri dati', action: () => selectCollection(dbName, coll.name) },
        ...(splitDisponibile() ? [
          { icona: 'columns-2', label: 'Affianca in Split-View', action: () => addOrSplitPane(null, 'right', { db: dbName, coll: coll.name, tabId: activeTab()?.id }) },
          // La prima voce aggiunge qui; la seconda crea un'altra area.
          { icona: 'square-split-horizontal', label: 'Affianca in una NUOVA area', action: () => addOrSplitPane(null, 'right', { db: dbName, coll: coll.name, tabId: activeTab()?.id }, { nuovaArea: true }) },
        ] : []),
        { icona: 'info', label: `Dettagli ${collWord()}`, action: () => { selectCollection(dbName, coll.name); setView('details'); } },
        { label: '◫ Diagramma UML', action: () => { selectCollection(dbName, coll.name); setView('uml'); } },
        '---',
        ...exportImportMenuItems(dbName, coll.name),
        '---',
        { icona: 'square-pen', label: `Rinomina ${collWord()}…`, action: () => renameColl(dbName, coll.name) },
        { icona: 'trash-2', label: `Elimina ${collWord()}…`, danger: true, action: () => dropColl(dbName, coll.name) },
      ]);
    });
    li.appendChild(label);
    aggiungiMenuNodo(label, coll.name);
    frag.appendChild(li);
  }
  container.appendChild(frag);
  refreshLucideIcons(container);
  completaTransizione();
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
  window.addEventListener('codedb:conteggi-sporchi', e => aggiornaConteggiNavigatore(e.detail.db, e.detail.tabId));
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
    const originTab = activeTab();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      // Il timer appartiene al tab in cui è stato digitato il filtro.
      if (!originTab || activeTab() !== originTab) return;
      if (!q) {
        refreshDbTree();
        return;
      }
      $('#db-tree').innerHTML = '<li class="node-label loading">ricerca in corso…</li>';
      emit('db:search', { tabId: originTab.id, query: q }).then((res) => {
        if (!isForActiveTab(res)) return; // risultati di un'altra connessione
        renderDbTree(res.databases);
      }).catch((err) => { if (isForActiveTab(err)) toast(err.message, true); });
    }, 300);
  });
}
