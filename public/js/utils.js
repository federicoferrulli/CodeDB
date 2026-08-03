import { socket } from './socket.js';
import { state } from './state.js';
import { tabs, activeTab } from './tabs.js';
import { isGeometry, geometryLabel } from './geojson.js';
import { isPlainObject, ejsonKind, fmtBytes, safeUUID } from './valori.js';

export const $ = (sel) => document.querySelector(sel);

// Definiti in valori.js (modulo foglia, senza import) e ri-esportati qui: chi
// li importava da utils.js continua a funzionare, ma chi ha bisogno solo di
// questi non è costretto a caricare l'intera applicazione (vedi la nota in
// testa a valori.js).
export { isPlainObject, ejsonKind, fmtBytes, safeUUID };

export function displayValue(v) {
  if (v === null || v === undefined) return { text: '–', cls: 'type-null' };
  if (Array.isArray(v)) return { text: JSON.stringify(v.map(simplify)), cls: 'type-obj' };
  // Geometrie: in cella l'elenco delle coordinate non dice nulla e rompe il
  // layout. Si mostra tipo e numero di vertici; il contenuto vero si apre con
  // un doppio clic (editor su mappa). La copia delle celle non passa di qui:
  // legge `state.docs`, quindi continua a copiare il GeoJSON completo.
  if (isGeometry(v)) return { text: geometryLabel(v), cls: 'type-geo' };

  const kind = ejsonKind(v);
  if (kind === 'oid') return { text: v.$oid, cls: 'type-oid' };
  if (kind === 'date') {
    const d = isPlainObject(v.$date) ? Number(v.$date.$numberLong) : v.$date;
    const date = new Date(d);
    // Data invalida (es. DATETIME azzerati): non deve far saltare il render
    // dell'intera griglia con il RangeError di toISOString().
    if (isNaN(date.getTime())) return { text: String(d), cls: 'type-date' };
    return { text: date.toISOString(), cls: 'type-date' };
  }
  if (kind === 'number') {
    // 'number' copre sia le forme EJSON canoniche ({"$numberLong": "..."})
    // sia i numeri JS puri (il server serializza relaxed): vanno distinti.
    const text = isPlainObject(v)
      ? String(v.$numberInt ?? v.$numberLong ?? v.$numberDouble)
      : String(v);
    return { text, cls: 'type-num' };
  }
  if (kind === 'decimal') return { text: String(v.$numberDecimal), cls: 'type-num' };
  if (kind === 'binary') {
    const b64 = v.$binary.base64 || '';
    const size = Math.max(0, Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0));
    let hex = '';
    if (size > 0) {
      const header = atob(b64.slice(0, 16)).substring(0, 8);
      for (let i = 0; i < Math.min(header.length, 8); i++) {
        hex += header.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase() + ' ';
      }
      if (size > 8) hex += '...';
    }
    return { text: `[BLOB ${fmtBytes(size)}] ${hex.trim()}`, cls: 'type-obj' };
  }
  if (kind === 'object') return { text: JSON.stringify(simplify(v)), cls: 'type-obj' };
  if (kind === 'boolean') return { text: String(v), cls: 'type-bool', dataVal: String(v) };
  return { text: String(v), cls: '' };
}

export function simplify(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(simplify);
  const kind = ejsonKind(v);
  if (kind === 'oid') return v.$oid;
  if (kind === 'date') return displayValue(v).text;
  if (kind === 'number') return isPlainObject(v) ? Number(Object.values(v)[0]) : v;
  if (kind === 'decimal') return Number(v.$numberDecimal);
  if (kind === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = simplify(val);
    return out;
  }
  return v;
}

export function valueType(v) {
  const kind = ejsonKind(v);
  if (kind === 'oid' || kind === 'date' || kind === 'number' || kind === 'decimal') return kind;
  if (kind === 'string' || kind === 'boolean') return kind === 'boolean' ? 'bool' : kind;
  return 'json';
}

export function editValue(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function parseEdited(text) {
  const t = text.trim();
  if (t === '') return '';
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

export function idOf(doc) {
  return JSON.stringify(doc._id);
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

export function cut(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

let toastTimer = null;
export function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  // La durata segue la lunghezza: gli errori ora sono frasi con causa e rimedio
  // (db/errors.js) e in 3 secondi fissi non si leggevano — sparivano prima della
  // parte che dice cosa fare. ~55 ms per carattere, fra 3 e 12 secondi.
  const durata = Math.min(Math.max(3000, String(msg).length * 55), 12000);
  toastTimer = setTimeout(() => el.classList.add('hidden'), durata);
}

export function showQueryError(msg) {
  const el = $('#query-error');
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

export function showContextMenu(x, y, items) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    if (item === '---') {
      li.className = 'separator';
    } else {
      li.textContent = item.label;
      if (item.danger) li.classList.add('danger');
      li.addEventListener('click', () => {
        hideContextMenu();
        item.action();
      });
    }
    menu.appendChild(li);
  }
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
}

export function hideContextMenu() {
  $('#context-menu').classList.add('hidden');
}

document.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
});

// Riordino via drag & drop di una barra di tab. `el` è l'elemento tab, `id` la
// sua chiave stabile (il tabId o l'id del coll-tab) e `onReorder(fromId, toId)`
// riordina l'array sottostante e ri-renderizza. Si lavora per id, non per
// indice: la barra di connessione salta i tab non connessi, quindi la posizione
// visiva non coincide con l'indice nell'array.
export function makeDraggable(el, id, onReorder, getPayload) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', typeof id === 'string' ? id : JSON.stringify(id));
    if (getPayload) {
      const payload = typeof getPayload === 'function' ? getPayload() : getPayload;
      if (payload) {
        e.dataTransfer.setData('application/codedb-tab', JSON.stringify(payload));
      }
    }
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!el.classList.contains('dragging')) el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const fromId = e.dataTransfer.getData('text/plain');
    if (fromId && fromId !== id) onReorder(fromId, id);
  });
}

// Sposta l'elemento con `fromId` nella posizione di quello con `toId`.
// Ritorna true se qualcosa è cambiato.
export function reorderById(list, fromId, toId, key = 'id') {
  const from = list.findIndex((x) => x[key] === fromId);
  const to = list.findIndex((x) => x[key] === toId);
  if (from < 0 || to < 0 || from === to) return false;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return true;
}



export function showError(id, msg) {
  const el = $(id);
  if (el) {
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }
}

// Richiesta con acknowledgment: inietta il tabId del tab attivo, catturato al
// momento della chiamata (non alla risposta: l'utente può cambiare tab mentre
// la query è in volo). La risposta porta il tab di origine in `_tab` e il suo
// stato in `_state`; se nel frattempo il tab è stato chiuso, la risposta viene
// scartata.
//
// IMPORTANTE — `_state` non è un di più: `state` (state.js) è un Proxy che punta
// SEMPRE al tab attivo, quindi un callback che scrive `state.docs = …` scrive nel
// tab che è attivo AL MOMENTO DELLA RISPOSTA, non in quello che ha fatto la
// richiesta. Cambiando tab mentre una find è in volo, i risultati del tab A
// finivano nello stato del tab B (griglia, colonne e footer sbagliati, e da lì
// scritture sul documento sbagliato). Ogni callback che modifica lo stato deve
// quindi usare `res._state`, mai il Proxy; e deve ridipingere solo se il proprio
// tab è ancora quello attivo (`res._tab === activeTab()`).
export function emit(event, payload) {
  // Il tabId del payload, quando c'è, ha la precedenza (split view, modali con
  // contesto esplicito): `_tab`/`_state` devono descrivere il tab REALMENTE
  // interrogato, altrimenti il callback scriverebbe nello stato di un altro.
  const pinned = payload && payload.tabId;
  // NB: il tabId va scritto DOPO lo spread del payload. Diverse modali passano
  // `tabId` esplicito ma indefinito quando non hanno un contesto (es. insert.js
  // con `insertContext = null`): con lo spread per ultimo quell'`undefined`
  // cancellava il tabId iniettato, il server ripiegava sulla sessione "default"
  // e rispondeva "Nessuna connessione attiva al database.".
  const tab = pinned ? (tabs.list.find((t) => t.id === pinned) || null) : activeTab();
  const withTab = (extra) => {
    const out = { ...(payload || {}), ...(extra || {}) };
    out.tabId = tab ? tab.id : pinned;
    return out;
  };
  const stamp = (res) => Object.assign(res, { _tab: tab, _state: tab ? tab.state : state });
  return new Promise((resolve, reject) => {
    // Anche gli errori portano l'origine: i callback di errore devono poter
    // decidere allo stesso modo se lo stato da toccare è ancora il proprio.
    const fail = (msg) => reject(stamp(new Error(msg)));
    socket.emit(event, withTab(), (res) => {
      if (tab && !tabs.list.includes(tab)) return; // tab chiuso: risposta orfana
      if (res && res.ok) {
        resolve(stamp(res));
      } else {
        const errMsg = String((res && res.error) || '');
        const isNoSession = errMsg.includes('Nessuna connessione attiva');
        if (isNoSession && tab && (tab.connCfg || tab.connName) && (!payload || !payload._reconnected)) {
          const cfg = tab.connCfg || { saved: tab.connName };
          socket.emit('mongo:connect', { ...cfg, tabId: tab.id }, (connRes) => {
            if (connRes && connRes.ok) {
              tab.state.connected = true;
              toast(`Riconnessione al database riuscita per "${tab.label || 'Tab'}"`);
              socket.emit(event, withTab({ _reconnected: true }), (retryRes) => {
                if (retryRes && retryRes.ok) {
                  resolve(stamp(retryRes));
                } else {
                  fail(retryRes ? retryRes.error : 'Errore dopo la riconnessione');
                }
              });
            } else {
              toast(`Impossibile riconnettersi al database: ${connRes ? connRes.error : 'Errore sconosciuto'}`, true);
              fail(res ? res.error : 'Connessione assente');
            }
          });
        } else {
          fail(res ? res.error : 'Errore sconosciuto');
        }
      }
    });
  });
}

// La risposta riguarda ancora ciò che l'utente sta guardando? Solo in questo
// caso il workspace (DOM unico, condiviso da tutti i tab) va ridipinto: i dati
// di un tab in background si scrivono nel suo stato e basta, verranno mostrati
// quando l'utente ci tornerà.
export function isForActiveTab(res) {
  return !res || !res._tab || res._tab === activeTab();
}

// Contesto (tab + coll-tab) al momento in cui parte un'operazione asincrona
// lunga — import a blocchi, scritture multiple, refresh post-scrittura. `st` è
// lo stato su cui scrivere; `isStillActive()` dice se il workspace mostra ancora
// quel contesto, cioè se ha senso ridipingere o rieseguire la query (che legge
// gli input del DOM, condivisi da tutti i tab).
export function captureContext() {
  const tab = activeTab();
  const st = tab ? tab.state : state;
  const collId = st.activeCollId;
  return {
    tab,
    st,
    collId,
    tabId: tab ? tab.id : undefined,
    isStillActive: () => activeTab() === tab && st.activeCollId === collId,
  };
}

// Evento socket senza risposta (fire-and-forget), sempre col tabId del tab
// attivo. Si chiamava `notify`, nome indistinguibile da una notifica all'utente:
// in graph3d.js era stato usato per ~27 messaggi UI, che quindi non comparivano
// mai (errori compresi) mentre il testo italiano finiva sul socket come nome di
// evento. Per i messaggi all'utente si usa `toast()`.
export function emitFireAndForget(event, payload) {
  const tab = activeTab();
  // Il tabId dopo lo spread, per lo stesso motivo di `emit()`: un `tabId`
  // esplicito ma indefinito nel payload non deve cancellare quello iniettato.
  const msg = { ...(payload || {}) };
  msg.tabId = (payload && payload.tabId) || (tab ? tab.id : undefined);
  socket.emit(event, msg);
}

// (rimossa `invalidateSchema()`: azzerava la cache dello schema attraverso il
// Proxy `state`, quindi quella del tab ATTIVO alla risposta invece di quella del
// tab che aveva eseguito la DDL. I chiamanti ora scrivono `res._state.dbSchema`.)

export function colDone(verb) {
  return verb + 'a';
}

export function dbTypeIcon(dbType) {
  if (dbType === 'postgresql' || dbType === 'postgres') {
    return '<span class="db-type-badge db-type-pg" title="PostgreSQL"><i data-lucide="database"></i></span>';
  }
  if (dbType === 'mysql') {
    return '<span class="db-type-badge db-type-mysql" title="MySQL"><i data-lucide="database"></i></span>';
  }
  // mongodb (default)
  return '<span class="db-type-badge db-type-mongo" title="MongoDB"><i data-lucide="leaf"></i></span>';
}

export function isSqlType(dbType) {
  return dbType === 'mysql' || dbType === 'postgresql' || dbType === 'postgres';
}

export function positionFixedDropdown(btn, menu) {
  if (!btn || !menu) return;
  menu.classList.remove('hidden');
  const rect = btn.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 220;
  const menuHeight = menu.offsetHeight || 180;
  const screenWidth = window.innerWidth;
  const screenHeight = window.innerHeight;

  menu.style.position = 'fixed';
  menu.style.zIndex = '100000';

  // Posizionamento verticale: sotto il bottone, oppure sopra se in basso non c'è spazio sufficiente
  let top = rect.bottom + 6;
  if (top + menuHeight > screenHeight - 8 && rect.top - menuHeight - 6 > 0) {
    top = Math.max(8, rect.top - menuHeight - 6);
  }
  menu.style.top = `${top}px`;

  // Posizionamento orizzontale: allinea a destra col bottone, garantendo che sia sempre compreso nello schermo (8px dal bordo)
  let left = rect.right - menuWidth;
  if (left < 8) left = 8;
  if (left + menuWidth > screenWidth - 8) left = Math.max(8, screenWidth - menuWidth - 8);

  menu.style.left = `${left}px`;
  menu.style.right = 'auto';
}

// Costruttore albero JSON interattivo con rendering pigro dei figli
export function buildJsonNode(val, key = null, isRoot = false) {
  const node = document.createElement('div');
  node.className = 'json-node';

  const type = typeof val;

  if (val === null) {
    node.innerHTML = `${key ? `<span class="json-key">${esc(key)}</span>: ` : ''}<span class="json-null">null</span>`;
    return node;
  }

  if (type === 'object') {
    const isArray = Array.isArray(val);
    const keys = Object.keys(val);

    const header = document.createElement('div');
    header.className = 'json-header';
    header.style.cursor = 'pointer';

    const toggle = document.createElement('span');
    toggle.className = 'json-toggle';
    toggle.textContent = isRoot ? '▼ ' : '▶ ';

    const keySpan = key ? `<span class="json-key">${esc(key)}</span>: ` : '';
    const bracketOpen = isArray ? '[' : '{';
    const countText = `<span class="json-count">(${keys.length} ${isArray ? 'elementi' : 'chiavi'})</span>`;

    header.innerHTML = `${keySpan}${bracketOpen} ${countText}`;
    header.prepend(toggle);
    node.appendChild(header);

    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'json-children';
    if (!isRoot) childrenWrap.classList.add('hidden');
    node.appendChild(childrenWrap);

    let rendered = false;
    const renderChildren = () => {
      if (rendered) return;
      rendered = true;
      const frag = document.createDocumentFragment();
      for (const k of keys) {
        frag.appendChild(buildJsonNode(val[k], isArray ? null : k, false));
      }
      childrenWrap.appendChild(frag);
    };

    if (isRoot) renderChildren();

    header.addEventListener('click', (e) => {
      e.stopPropagation();
      renderChildren();
      const isHidden = childrenWrap.classList.toggle('hidden');
      toggle.textContent = isHidden ? '▶ ' : '▼ ';
    });

    return node;
  }

  let valClass = 'json-string';
  let formattedVal = `"${esc(String(val))}"`;

  if (type === 'number') {
    valClass = 'json-number';
    formattedVal = String(val);
  } else if (type === 'boolean') {
    valClass = 'json-boolean';
    formattedVal = String(val);
  }

  node.innerHTML = `${key ? `<span class="json-key">${esc(key)}</span>: ` : ''}<span class="${valClass}">${formattedVal}</span>`;
  return node;
}

/* ---------- Gestione Modali & Overlay Centralizzata ---------- */
const activeModals = new Set();

function handleModalEsc(e) {
  if (e.key === 'Escape' && activeModals.size > 0) {
    const lastModal = Array.from(activeModals).pop();
    closeModal(lastModal);
  }
}

export function openModal(elOrId) {
  const el = typeof elOrId === 'string'
    ? (elOrId.startsWith('#') || elOrId.startsWith('.') ? document.querySelector(elOrId) : (document.getElementById(elOrId) || document.querySelector(elOrId)))
    : elOrId;
  if (!el) return;
  el.classList.remove('hidden');
  activeModals.add(el);
  if (activeModals.size === 1) {
    document.addEventListener('keydown', handleModalEsc);
  }
  const focusable = el.querySelector('input:not([type="hidden"]), button, select, textarea');
  if (focusable) focusable.focus();
}

export function closeModal(elOrId) {
  const el = typeof elOrId === 'string'
    ? (elOrId.startsWith('#') || elOrId.startsWith('.') ? document.querySelector(elOrId) : (document.getElementById(elOrId) || document.querySelector(elOrId)))
    : elOrId;
  if (!el) return;
  el.classList.add('hidden');
  activeModals.delete(el);
  if (activeModals.size === 0) {
    document.removeEventListener('keydown', handleModalEsc);
  }
}

/* ---------- Gestione Notifiche Toast ---------- */
export function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.role = 'status';

  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️'
  };

  const iconSpan = document.createElement('span');
  iconSpan.textContent = icons[type] || 'ℹ️';

  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  textSpan.style.flex = '1';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn-close';
  closeBtn.textContent = '✕';
  closeBtn.ariaLabel = 'Chiudi notifica';
  closeBtn.onclick = () => toast.remove();

  toast.appendChild(iconSpan);
  toast.appendChild(textSpan);
  toast.appendChild(closeBtn);
  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.2s ease';
        setTimeout(() => toast.remove(), 200);
      }
    }, duration);
  }
}

/* ---------- Rendering Skeleton Pending States ---------- */
export function showSkeletonGrid(targetEl, rows = 6, cols = 5) {
  const el = typeof targetEl === 'string' ? document.querySelector(targetEl) : targetEl;
  if (!el) return;

  // Rimuove eventuali tabelle skeleton temporanee precedentemente create
  el.querySelectorAll('.skeleton-grid-table').forEach((t) => t.remove());

  const targetTable = el.tagName === 'TABLE' ? el : el.querySelector('table');

  if (targetTable) {
    let thead = targetTable.querySelector('thead');
    let tbody = targetTable.querySelector('tbody');
    if (!thead) {
      thead = document.createElement('thead');
      targetTable.appendChild(thead);
    }
    if (!tbody) {
      tbody = document.createElement('tbody');
      targetTable.appendChild(tbody);
    }
    thead.innerHTML = '';
    tbody.innerHTML = '';

    const trH = document.createElement('tr');
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th');
      th.style.padding = '8px 12px';
      th.innerHTML = `<div class="skeleton skeleton-text" style="width: ${50 + ((c + 1) * 17) % 40}%;"></div>`;
      trH.appendChild(th);
    }
    thead.appendChild(trH);

    for (let r = 0; r < rows; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td');
        td.style.padding = '8px 12px';
        td.innerHTML = `<div class="skeleton skeleton-text" style="width: ${35 + ((r + c) * 19) % 55}%;"></div>`;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  } else {
    const table = document.createElement('table');
    table.className = 'data-table skeleton-grid-table';
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';

    const thead = document.createElement('thead');
    const trH = document.createElement('tr');
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th');
      th.style.padding = '8px 12px';
      th.innerHTML = `<div class="skeleton skeleton-text" style="width: ${50 + ((c + 1) * 17) % 40}%;"></div>`;
      trH.appendChild(th);
    }
    thead.appendChild(trH);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let r = 0; r < rows; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td');
        td.style.padding = '8px 12px';
        td.innerHTML = `<div class="skeleton skeleton-text" style="width: ${35 + ((r + c) * 19) % 55}%;"></div>`;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    el.appendChild(table);
  }
}

export function refreshLucideIcons(targetElement = null) {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    try {
      window.lucide.createIcons({
        attrs: {
          'stroke-width': 2
        },
        nameAttr: 'data-lucide',
        ...(targetElement ? { root: targetElement } : {})
      });
    } catch (e) {
      console.warn('Lucide icon refresh warning:', e);
    }
  }
}

export function lucideIconHtml(iconName, extraClasses = '') {
  return `<i data-lucide="${iconName}" class="lucide-icon ${extraClasses}"></i>`;
}
