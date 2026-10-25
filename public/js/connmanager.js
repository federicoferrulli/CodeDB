import { chiediConferma } from './conferma.js';
'use strict';

import { $, emit, toast, dbTypeIcon, esc, showContextMenu, refreshLucideIcons, migraChiave, aggiungiMenuNodo, lucideIconHtml as ICO } from './utils.js';
import { connectAndOpenTab, startEditConn, openConnModal } from './connection.js';
import { tabs, switchTab, activeTab } from './tabs.js';
import { saveWorkspaceInputs } from './workspace.js';
import { preparaTransizioneAlbero } from './navigator-motion.js';

// Sidebar sinistra: elenco delle connessioni salvate, raggruppate per cartella
// (campo `folder` in connections.ini). Il clic riprende una sessione già aperta.

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

function openConn(conn, nuova = false) {
  const esistenti = tabs.list.filter(t => t.connName === conn.name && t.state.connected);
  const aperta = esistenti.find(t => t.id === activeTab()?.id) || esistenti[0];
  if (!nuova && aperta) { saveWorkspaceInputs(); switchTab(aperta.id); return; }
  connectAndOpenTab({ saved: conn.name }).catch(() => {}); // Feedback gestito dal flusso di connessione.
}

function testConn(conn) {
  toast(`Test di "${conn.name}" in corso…`);
  emit('connections:test', { saved: conn.name })
    .then((res) => toast(`✓ "${conn.name}" raggiungibile (${res.databases} db)`))
    .catch((err) => toast(`✗ "${conn.name}": ${err.message}`, true));
}

async function deleteConn(conn) {
  if (!await chiediConferma(`Eliminare la connessione salvata "${conn.name}"?`)) return;
  emit('connections:delete', { name: conn.name })
    .then(() => loadSavedConnections())
    .catch((err) => toast(err.message, true));
}

function connMenu(e, conn) {
  e.preventDefault();
  e.stopPropagation();
  showContextMenu(e.clientX, e.clientY, [
    { icona: 'play', label: 'Apri un’altra sessione', action: () => openConn(conn, true) },
    { icona: 'zap', label: 'Testa connessione', action: () => testConn(conn) },
    '---',
    { icona: 'square-pen', label: 'Modifica…', action: () => startEditConn(conn.name) },
    { icona: 'trash-2', label: 'Elimina…', danger: true, action: () => deleteConn(conn) },
  ]);
}

function connItem(conn) {
  const li = document.createElement('li');
  li.className = 'conn-item';
  li.dataset.connName = conn.name;
  const label = document.createElement('div');
  label.className = 'node-label';
  label.tabIndex = 0;
  label.setAttribute('role', 'button');
  label.title = `${conn.label}\nApri o riprendi la connessione. Il menu consente una nuova sessione.`;

  const name = document.createElement('span');
  name.className = 'conn-name';
  name.textContent = conn.name;
  const detail = document.createElement('span');
  detail.className = 'conn-detail';
  detail.textContent = conn.label;

  const icon = document.createElement('span');
  icon.className = 'conn-engine-icon';
  icon.innerHTML = dbTypeIcon(conn.dbType);
  const text = document.createElement('span');
  text.className = 'conn-text';
  text.append(name, detail);
  const status = document.createElement('span');
  status.className = 'conn-status';
  status.setAttribute('aria-hidden', 'true');
  label.append(icon, text, status);
  label.addEventListener('click', () => openConn(conn));
  label.addEventListener('contextmenu', (e) => connMenu(e, conn));
  label.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); label.click(); }
  });
  li.appendChild(label);
  aggiungiMenuNodo(label, conn.name);
  return li;
}

function renderConnTree() {
  const tree = $('#conn-tree');
  const completaTransizione = preparaTransizioneAlbero(tree);
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
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    const isCollapsed = query ? false : collapsed.has(folder);
    head.setAttribute('aria-expanded', String(!isCollapsed));
    head.innerHTML = `${ICO(isCollapsed ? 'chevron-right' : 'chevron-down')}${ICO(isCollapsed ? 'folder' : 'folder-open')}<span>${esc(folder)}</span>`;
    refreshLucideIcons(head);

    const sub = document.createElement('ul');
    sub.classList.toggle('hidden', isCollapsed);
    for (const conn of groups.get(folder)) sub.appendChild(connItem(conn));

    head.addEventListener('click', () => {
      if (collapsed.has(folder)) collapsed.delete(folder); else collapsed.add(folder);
      persistCollapsed();
      renderConnTree();
      [...tree.querySelectorAll('.folder-label')].find(el => el.textContent === folder)?.focus();
    });
    head.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); }
    });

    li.append(head, sub);
    tree.appendChild(li);
  }
  for (const conn of groups.get('') || []) tree.appendChild(connItem(conn));
  refreshLucideIcons(tree);
  marcaConnessioneAttiva();
  completaTransizione();
}

function marcaConnessioneAttiva() {
  const attiva = activeTab();
  const aperte = new Set(tabs.list.filter(tab => tab.state.connected).map(tab => tab.connName));
  for (const item of document.querySelectorAll('#conn-tree .conn-item')) {
    const nome = item.dataset.connName;
    const selected = !!attiva?.state.connected && attiva.connName === nome;
    const aperta = aperte.has(nome);
    const label = item.querySelector('.node-label');
    label.classList.toggle('selected', selected);
    label.setAttribute('aria-current', selected ? 'true' : 'false');
    const stato = selected ? 'Connessione attiva' : aperta ? 'Connessione aperta' : 'Connessione salvata';
    label.setAttribute('aria-label', `${nome}, ${item.querySelector('.conn-detail').textContent}. ${stato}`);
    item.classList.toggle('connected', aperta);
    item.querySelector('.conn-status').title = stato;
  }
}

export function aggiornaConnessioneAttiva() {
  const completaTransizione = preparaTransizioneAlbero($('#conn-tree'));
  marcaConnessioneAttiva();
  completaTransizione();
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

function impostaSezione(sidebar, button, collapse) {
  sidebar.classList.toggle('section-collapsed', collapse);
  document.getElementById(button.getAttribute('aria-controls')).classList.toggle('hidden', collapse);
  button.setAttribute('aria-expanded', String(!collapse));
}

export function initConnManager() {
  window.addEventListener('codedb:tab-closed', () => queueMicrotask(aggiornaConnessioneAttiva));
  $('#conn-add-btn').addEventListener('click', () => openConnModal());
  const searchInput = $('#conn-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => renderConnTree());
  }

  const explorerKey = migraChiave('explorer-collapsed', 'gui-db:explorer-collapsed');
  const explorerToggle = $('#explorer-toggle-btn');
  const toggleExplorer = collapse => {
    impostaSezione($('#sidebar'), explorerToggle, collapse);
    localStorage.setItem(explorerKey, String(collapse));
  };
  explorerToggle.addEventListener('click', () => toggleExplorer(explorerToggle.getAttribute('aria-expanded') === 'true'));
  if (localStorage.getItem(explorerKey) === 'true') toggleExplorer(true);

}
