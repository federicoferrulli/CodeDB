import { socket } from './socket.js';
import { state } from './state.js';
import { tabs, activeTab } from './tabs.js';

export const $ = (sel) => document.querySelector(sel);

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function ejsonKind(v) {
  if (isPlainObject(v)) {
    if ('$oid' in v) return 'oid';
    if ('$date' in v) return 'date';
    if ('$numberInt' in v || '$numberLong' in v || '$numberDouble' in v) return 'number';
    if ('$numberDecimal' in v) return 'decimal';
    if ('$binary' in v) return 'binary';
    return 'object';
  }
  return typeof v; // string, number, boolean, object (null/array)
}

export function displayValue(v) {
  if (v === null || v === undefined) return { text: 'null', cls: 'type-null' };
  if (Array.isArray(v)) return { text: JSON.stringify(v.map(simplify)), cls: 'type-obj' };

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
  if (kind === 'boolean') return { text: String(v), cls: 'type-bool' };
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

export function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}

let toastTimer = null;
export function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
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
// la query è in volo). La risposta porta il tab di origine in `_tab`; se nel
// frattempo il tab è stato chiuso, la risposta viene scartata.
export function emit(event, payload) {
  const tab = activeTab();
  return new Promise((resolve, reject) => {
    socket.emit(event, { tabId: tab ? tab.id : undefined, ...(payload || {}) }, (res) => {
      if (tab && !tabs.list.includes(tab)) return; // tab chiuso: risposta orfana
      if (res && res.ok) {
        resolve(Object.assign(res, { _tab: tab }));
      } else {
        const errMsg = String((res && res.error) || '');
        const isNoSession = errMsg.includes('Nessuna connessione attiva');
        if (isNoSession && tab && (tab.connCfg || tab.connName) && (!payload || !payload._reconnected)) {
          const cfg = tab.connCfg || { saved: tab.connName };
          socket.emit('mongo:connect', { ...cfg, tabId: tab.id }, (connRes) => {
            if (connRes && connRes.ok) {
              tab.state.connected = true;
              toast(`Riconnessione al database riuscita per "${tab.label || 'Tab'}"`);
              socket.emit(event, { tabId: tab.id, ...(payload || {}), _reconnected: true }, (retryRes) => {
                if (retryRes && retryRes.ok) {
                  resolve(Object.assign(retryRes, { _tab: tab }));
                } else {
                  reject(new Error(retryRes ? retryRes.error : 'Errore dopo la riconnessione'));
                }
              });
            } else {
              toast(`Impossibile riconnettersi al database: ${connRes ? connRes.error : 'Errore sconosciuto'}`, true);
              reject(new Error(res ? res.error : 'Connessione assente'));
            }
          });
        } else {
          reject(new Error(res ? res.error : 'Errore sconosciuto'));
        }
      }
    });
  });
}

// Evento senza risposta (fire-and-forget), sempre col tabId del tab attivo.
export function notify(event, payload) {
  const tab = activeTab();
  socket.emit(event, { tabId: tab ? tab.id : undefined, ...(payload || {}) });
}

export function invalidateSchema() {
  state.dbSchema = null;
}

export function colDone(verb) {
  return verb + 'a';
}

export function dbTypeIcon(dbType) {
  if (dbType === 'postgresql' || dbType === 'postgres') return '🐘';
  if (dbType === 'mysql') return '🐬';
  return '🍃';
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


