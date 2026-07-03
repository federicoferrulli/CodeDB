'use strict';

import { state } from './state.js';
import { activeTab } from './tabs.js';
import { $, dbTypeIcon } from './utils.js';
import { renderDbTree, refreshDbTree } from './dbtree.js';
import { renderGrid, applyDbTypeToWorkspace, applyQueryPlaceholders } from './grid.js';
import { renderCollTabBar } from './colltabs.js';
import { setView } from './main.js';

// Il DOM del workspace è unico e condiviso: al cambio tab viene ri-renderizzato
// dallo stato del tab attivo. Mentre un tab è attivo la verità per gli input è
// il DOM: lo snapshot nello stato avviene solo al momento di lasciare il tab.

export function saveWorkspaceInputs() {
  const tab = activeTab();
  if (!tab || !tab.state.connected) return;
  const s = tab.state;
  s.filter = $('#filter-input').value;
  s.sort = $('#sort-input').value;
  s.queryMode = $('#query-mode').value;
  s.pageSize = $('#page-size').value;
}

export function renderWorkspace() {
  const tab = activeTab();
  const connected = !!(tab && tab.state.connected);

  $('#welcome').classList.toggle('hidden', connected);
  $('#tab-body').classList.toggle('hidden', !connected);
  $('#disconnect-btn').classList.toggle('hidden', !connected);
  $('#conn-info').textContent = connected ? `${dbTypeIcon(state.dbType)} ${state.connLabel}` : '';
  if (!connected) {
    $('#live-badge').classList.add('hidden');
    $('#polling-toggle').classList.add('hidden');
    return;
  }

  applyDbTypeToWorkspace();
  renderDbTree(state.databases);
  // Lo schema è cambiato mentre il tab era in background: ricarica il tree.
  if (state.schemaDirty) {
    state.schemaDirty = false;
    refreshDbTree();
  }
  renderCollTabBar();

  $('#query-mode').value = state.queryMode || 'find';
  $('#filter-input').value = state.filter || '';
  $('#sort-input').value = state.sort || '';
  $('#page-size').value = state.pageSize || '50';
  applyQueryPlaceholders();

  $('#live-badge').classList.toggle('hidden', !state.watching);
  $('#polling-toggle').classList.toggle('hidden', !state.pollingShown);
  $('#polling-checkbox').checked = !!state.pollingInterval;

  if (state.db && state.coll) {
    $('#breadcrumb').textContent = `${state.db} ▸ ${state.coll}`;
    $('#placeholder').classList.add('hidden');
    $('#workspace').classList.remove('hidden');
    renderGrid(); // i dati sono già nello stato del tab: nessuna nuova query
    setView(state.view || 'data');
  } else {
    $('#workspace').classList.add('hidden');
    $('#placeholder').classList.remove('hidden');
  }
}
