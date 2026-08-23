'use strict';

import { $, emit, toast, dbTypeIcon, esc, showContextMenu, refreshLucideIcons, migraChiave } from './utils.js';
import { connectAndOpenTab, startEditConn, openConnModal } from './connection.js';

// Sidebar sinistra: elenco delle connessioni salvate, raggruppate per cartella
// (campo `folder` in connections.ini). Click = apri in un nuovo tab.

let allConns = [];

// Prefisso unificato, con recupero del valore scritto dalle versioni
// precedenti (CDB-64).
const COLLAPSED_KEY = migraChiave('collapsed-folders', 'gui-db:collapsed-folders');
// Lettura difensiva come in `migraChiave`: fuori dal browser `localStorage` non
// esiste, e questa riga girava all'IMPORT — bastava a rendere non caricabile in
// prova ogni modulo che risalisse fin qui, cioe' quasi tutto il frontend.
const collapsed = new Set(leggiCartelleChiuse());
function leggiCartelleChiuse() {
  try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'); } catch { return []; }
}

function persistCollapsed() {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
}

export function loadSavedConnections() {
  emit('connections:list', {}).then((res) => {
    allConns = res.connections;
    renderConnTree();
    fillFolderDatalist();
  }).catch((err) => toast(err.message, true));
}

/** L'elenco delle connessioni salvate già in memoria (per la palette ⌘/Ctrl+P). */
export function elencoConnessioni() {
  return Array.isArray(allConns) ? allConns : [];
}

function openConn(conn) {
  toast(`Connessione a "${conn.name}"…`);
  connectAndOpenTab({ saved: conn.name })
    .then(() => toast(`Connesso a "${conn.name}"`))
    .catch((err) => toast(err.message, true));
}

function testConn(conn) {
  toast(`Test di "${conn.name}" in corso…`);
  emit('connections:test', { saved: conn.name })
    .then((res) => toast(`✓ "${conn.name}" raggiungibile (${res.databases} db)`))
    .catch((err) => toast(`✗ "${conn.name}": ${err.message}`, true));
}

function deleteConn(conn) {
  if (!confirm(`Eliminare la connessione salvata "${conn.name}"?`)) return;
  emit('connections:delete', { name: conn.name })
    .then(() => loadSavedConnections())
    .catch((err) => toast(err.message, true));
}

function connMenu(e, conn) {
  e.preventDefault();
  e.stopPropagation();
  showContextMenu(e.clientX, e.clientY, [
    { label: '▶ Apri in nuovo tab', action: () => openConn(conn) },
    { label: '⚡ Testa connessione', action: () => testConn(conn) },
    '---',
    { label: '✎ Modifica…', action: () => startEditConn(conn.name) },
    { label: '🗑 Elimina…', danger: true, action: () => deleteConn(conn) },
  ]);
}

function connItem(conn) {
  const li = document.createElement('li');
  li.className = 'conn-item';
  const label = document.createElement('div');
  label.className = 'node-label';
  label.title = `${conn.label}\nClick: apri in un nuovo tab — tasto destro: altre azioni`;

  const name = document.createElement('span');
  name.className = 'conn-name';
  name.innerHTML = `${dbTypeIcon(conn.dbType)} <span>${esc(conn.name)}</span>`;
  const detail = document.createElement('span');
  detail.className = 'conn-detail';
  detail.textContent = conn.label;

  label.append(name, detail);
  label.addEventListener('click', () => openConn(conn));
  label.addEventListener('contextmenu', (e) => connMenu(e, conn));
  li.appendChild(label);
  return li;
}

function renderConnTree() {
  const tree = $('#conn-tree');
  tree.innerHTML = '';
  const searchInput = $('#conn-search');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const filteredConns = allConns.filter((conn) => {
    if (!query) return true;
    const name = (conn.name || '').toLowerCase();
    const label = (conn.label || '').toLowerCase();
    const folder = (conn.folder || '').toLowerCase();
    const dbType = (conn.dbType || '').toLowerCase();
    return name.includes(query) || label.includes(query) || folder.includes(query) || dbType.includes(query);
  });

  const connEmpty = $('#conn-empty');
  if (query && !filteredConns.length && allConns.length > 0) {
    connEmpty.textContent = 'Nessuna connessione corrisponde alla ricerca.';
    connEmpty.classList.remove('hidden');
  } else if (!allConns.length) {
    connEmpty.textContent = 'Nessuna connessione salvata.';
    connEmpty.classList.remove('hidden');
  } else {
    connEmpty.classList.add('hidden');
  }

  $('#conn-export-btn').disabled = !allConns.length;

  const groups = new Map(); // folder ('' = senza cartella) -> connessioni
  for (const conn of filteredConns) {
    const folder = (conn.folder || '').trim();
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(conn);
  }

  const folders = [...groups.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
  for (const folder of folders) {
    const li = document.createElement('li');
    li.className = 'conn-folder';
    const head = document.createElement('div');
    head.className = 'node-label folder-label';
    const isCollapsed = query ? false : collapsed.has(folder);
    head.textContent = `${isCollapsed ? '▸' : '▾'} 📁 ${folder}`;

    const sub = document.createElement('ul');
    sub.classList.toggle('hidden', isCollapsed);
    for (const conn of groups.get(folder)) sub.appendChild(connItem(conn));

    head.addEventListener('click', () => {
      if (collapsed.has(folder)) collapsed.delete(folder); else collapsed.add(folder);
      persistCollapsed();
      renderConnTree();
    });

    li.append(head, sub);
    tree.appendChild(li);
  }
  for (const conn of groups.get('') || []) tree.appendChild(connItem(conn));
  refreshLucideIcons(tree);
}

// Suggerisce le cartelle esistenti nel campo "Cartella" del form.
function fillFolderDatalist() {
  const dl = $('#conn-folders');
  dl.innerHTML = '';
  for (const folder of [...new Set(allConns.map((c) => (c.folder || '').trim()).filter(Boolean))].sort()) {
    const opt = document.createElement('option');
    opt.value = folder;
    dl.appendChild(opt);
  }
}

const SIDEBAR_COLLAPSED_KEY = migraChiave('conn-sidebar-collapsed', 'gui-db:conn-sidebar-collapsed');

export function toggleConnSidebar(forceCollapsed) {
  const sidebar = $('#conn-sidebar');
  const resizer = document.querySelector('.resizer[data-resize="conn-sidebar"]');
  const expandBtn = $('#conn-sidebar-expand-btn');
  const toggleBtn = $('#conn-sidebar-toggle-btn');
  if (!sidebar) return;

  const isCurrentlyCollapsed = sidebar.classList.contains('collapsed');
  const collapse = typeof forceCollapsed === 'boolean' ? forceCollapsed : !isCurrentlyCollapsed;

  sidebar.classList.toggle('collapsed', collapse);
  if (resizer) resizer.classList.toggle('collapsed', collapse);
  if (expandBtn) expandBtn.classList.toggle('hidden', !collapse);

  if (toggleBtn) {
    toggleBtn.title = collapse ? 'Espandi barra connessioni' : 'Comprimi barra connessioni';
    toggleBtn.setAttribute('aria-label', toggleBtn.title);
    toggleBtn.innerHTML = collapse ? `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
        <polyline points="14 10 17 12 14 14"/>
      </svg>` : `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
        <polyline points="16 10 13 12 16 14"/>
      </svg>`;
  }

  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapse ? 'true' : 'false');
}

export function initConnManager() {
  $('#conn-add-btn').addEventListener('click', () => openConnModal());
  const searchInput = $('#conn-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => renderConnTree());
  }

  const toggleBtn = $('#conn-sidebar-toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => toggleConnSidebar());
  }

  const expandBtn = $('#conn-sidebar-expand-btn');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => toggleConnSidebar(false));
  }

  if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true') {
    toggleConnSidebar(true);
  }
}
