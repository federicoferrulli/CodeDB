'use strict';

import { $, emit, toast, dbTypeIcon, showContextMenu } from './utils.js';
import { connectAndOpenTab, startEditConn, openConnModal } from './connection.js';

// Sidebar sinistra: elenco delle connessioni salvate, raggruppate per cartella
// (campo `folder` in connections.ini). Click = apri in un nuovo tab.

let allConns = [];

const COLLAPSED_KEY = 'gui-db:collapsed-folders';
const collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'));

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
  name.textContent = `${dbTypeIcon(conn.dbType)} ${conn.name}`;
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
  $('#conn-empty').classList.toggle('hidden', !!allConns.length);
  $('#conn-export-btn').disabled = !allConns.length;

  const groups = new Map(); // folder ('' = senza cartella) -> connessioni
  for (const conn of allConns) {
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
    const isCollapsed = collapsed.has(folder);
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

export function initConnManager() {
  $('#conn-add-btn').addEventListener('click', () => openConnModal());
}
