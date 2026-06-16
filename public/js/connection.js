import { state } from './state.js';
import { socket } from './socket.js';
import { $, emit, toast } from './utils.js';
import { renderDbTree } from './dbtree.js';
import { applyDbTypeToWorkspace } from './grid.js';

let editingConn = null;

function dbTypeIcon(dbType) {
  return dbType === 'mysql' ? '🐬' : '🍃';
}

function selectConnTab(name) {
  document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#tab-fields').classList.toggle('hidden', name !== 'fields');
  $('#tab-uri').classList.toggle('hidden', name !== 'uri');
}

export function syncConnForm() {
  const form = $('#connect-form');
  const isMysql = form.elements.dbType.value === 'mysql';
  const sshOn = form.elements.ssh.checked;

  $('#row-authsource').classList.toggle('hidden', isMysql);
  $('#row-database').classList.toggle('hidden', !isMysql);
  
  // SSH fields
  $('#ssh-fields').classList.toggle('hidden', !sshOn);
  $('#tab-uri-btn').classList.toggle('hidden', isMysql || sshOn);
  
  if ((isMysql || sshOn) && !$('#tab-uri').classList.contains('hidden')) {
    selectConnTab('fields');
  }

  const port = form.elements.port;
  if (isMysql && port.value === '27017') port.value = '3306';
  if (!isMysql && port.value === '3306') port.value = '27017';
}

function readConnForm() {
  const form = $('#connect-form');
  const isMysql = form.elements.dbType.value === 'mysql';
  const usingUri = !isMysql && !$('#tab-uri').classList.contains('hidden');
  const cfg = usingUri
    ? { uri: form.elements.uri.value }
    : {
        host: form.elements.host.value,
        port: form.elements.port.value,
        username: form.elements.username.value,
        password: form.elements.password.value,
      };
  if (!usingUri) {
    if (isMysql) cfg.database = form.elements.database.value;
    else cfg.authSource = form.elements.authSource.value;
  }
  cfg.dbType = form.elements.dbType.value;
  cfg.saveAs = form.elements.saveAs.value;
  const sshOn = form.elements.ssh.checked;
  cfg.ssh = sshOn ? 'true' : '';
  if (sshOn) {
    cfg.sshHost = form.elements.sshHost.value;
    cfg.sshPort = form.elements.sshPort.value;
    cfg.sshUser = form.elements.sshUser.value;
    cfg.sshPassword = form.elements.sshPassword.value;
    cfg.sshKeyFile = form.elements.sshKeyFile.value;
    cfg.sshPassphrase = form.elements.sshPassphrase.value;
  }
  return cfg;
}

function doConnect(cfg) {
  const btn = $('#connect-btn');
  btn.disabled = true;
  btn.textContent = 'Connessione…';
  $('#connect-error').classList.add('hidden');

  emit('mongo:connect', cfg).then((res) => {
    btn.disabled = false;
    btn.textContent = 'Connetti';
    state.connected = true;
    state.connLabel = res.label || '';
    state.dbType = res.dbType || 'mongodb';
    $('#conn-info').textContent = `${dbTypeIcon(state.dbType)} ${state.connLabel}`;
    $('#connect-overlay').classList.add('hidden');
    $('#app').classList.remove('hidden');
    applyDbTypeToWorkspace();
    if (cfg.saveAs) loadSavedConnections();
    renderDbTree(res.databases);
  }).catch((err) => {
    btn.disabled = false;
    btn.textContent = 'Connetti';
    const errorEl = $('#connect-error');
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  });
}

export function loadSavedConnections() {
  emit('connections:list', {}).then((res) => {
    renderSavedConnections(res.connections);
  }).catch((err) => toast(err.message, true));
}

function renderSavedConnections(connections) {
  const list = $('#saved-conns');
  list.innerHTML = '';
  list.classList.toggle('hidden', !connections.length);
  $('#saved-conns-empty').classList.toggle('hidden', !!connections.length);
  $('#conn-export-btn').disabled = !connections.length;
  for (const conn of connections) {
    const li = document.createElement('li');
    li.title = `Connetti a "${conn.name}"`;

    const name = document.createElement('span');
    name.className = 'saved-conn-name';
    name.textContent = `${dbTypeIcon(conn.dbType)} ${conn.name}`;

    const label = document.createElement('span');
    label.className = 'saved-conn-label';
    label.textContent = conn.label;

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'edit-btn';
    edit.title = 'Modifica la connessione salvata';
    edit.textContent = '✎';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      startEditConn(conn.name);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del-btn';
    del.title = 'Elimina la connessione salvata';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Eliminare la connessione salvata "${conn.name}"?`)) return;
      emit('connections:delete', { name: conn.name }).then(() => {
        if (editingConn === conn.name) cancelEditConn();
        loadSavedConnections();
      }).catch((err) => toast(err.message, true));
    });

    li.append(name, label, edit, del);
    li.addEventListener('click', () => doConnect({ saved: conn.name }));
    list.appendChild(li);
  }
}

function startEditConn(name) {
  emit('connections:get', { name }).then((res) => {
    const f = res.fields;
    const form = $('#connect-form');
    const isMysql = (f.dbType || 'mongodb') === 'mysql';
    form.elements.dbType.value = f.dbType || 'mongodb';
    selectConnTab(f.uri && !isMysql ? 'uri' : 'fields');
    form.elements.uri.value = f.uri || '';
    form.elements.host.value = f.host || 'localhost';
    form.elements.port.value = f.port || (isMysql ? '3306' : '27017');
    form.elements.username.value = f.username || '';
    form.elements.password.value = '';
    form.elements.password.placeholder = res.hasPassword ? '(invariata se lasciata vuota)' : '';
    form.elements.authSource.value = f.authSource || 'admin';
    form.elements.database.value = f.database || '';
    form.elements.ssh.checked = (f.ssh || '').toLowerCase() === 'true';
    form.elements.sshHost.value = f.sshHost || '';
    form.elements.sshPort.value = f.sshPort || '22';
    form.elements.sshUser.value = f.sshUser || '';
    form.elements.sshPassword.value = '';
    form.elements.sshPassword.placeholder = res.hasSshPassword ? '(invariata se lasciata vuota)' : '(vuoto se usi una chiave)';
    form.elements.sshKeyFile.value = f.sshKeyFile || '';
    form.elements.sshPassphrase.value = '';
    form.elements.sshPassphrase.placeholder = res.hasSshPassphrase ? '(invariata se lasciata vuota)' : '(se la chiave è protetta)';
    form.elements.saveAs.value = name;
    syncConnForm();
    editingConn = name;
    $('#conn-edit-name').textContent = name;
    $('#conn-edit-banner').classList.remove('hidden');
    $('#conn-save-btn').classList.remove('hidden');
    $('#connect-error').classList.add('hidden');
  }).catch((err) => toast(err.message, true));
}

function cancelEditConn() {
  editingConn = null;
  const form = $('#connect-form');
  form.reset();
  form.elements.password.placeholder = '';
  form.elements.sshPassword.placeholder = '(vuoto se usi una chiave)';
  form.elements.sshPassphrase.placeholder = '(se la chiave è protetta)';
  syncConnForm();
  $('#conn-edit-banner').classList.add('hidden');
  $('#conn-save-btn').classList.add('hidden');
}

export function initConnection() {
  document.querySelectorAll('.tab[data-tab]').forEach((tab) =>
    tab.addEventListener('click', () => selectConnTab(tab.dataset.tab))
  );

  $('#conn-dbtype').addEventListener('change', syncConnForm);
  $('#conn-ssh-toggle').addEventListener('change', syncConnForm);

  $('#connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const cfg = readConnForm();
    if (editingConn) cfg.keepPasswordFrom = editingConn;
    doConnect(cfg);
  });

  $('#conn-edit-cancel').addEventListener('click', cancelEditConn);

  $('#conn-save-btn').addEventListener('click', () => {
    const cfg = readConnForm();
    const name = (cfg.saveAs || '').trim();
    if (!name) {
      const err = $('#connect-error');
      err.textContent = 'Indica un nome nel campo "Salva come".';
      err.classList.remove('hidden');
      return;
    }
    emit('connections:save', { name, oldName: editingConn, cfg }).then(() => {
      toast(`Connessione "${name}" salvata`);
      cancelEditConn();
      loadSavedConnections();
    }).catch((err) => {
      const errorEl = $('#connect-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });

  $('#conn-export-btn').addEventListener('click', () => {
    emit('connections:export', {}).then((res) => {
      const blob = new Blob([res.ini], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'connections.ini';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Connessioni esportate: il file contiene le password in chiaro');
    }).catch((err) => toast(err.message, true));
  });

  $('#conn-import-btn').addEventListener('click', () => $('#conn-import-file').click());

  $('#conn-import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    file.text().then((ini) => {
      emit('connections:import', { ini }).then((res) => {
        const parts = [];
        if (res.imported) parts.push(`${res.imported} importate`);
        if (res.overwritten) parts.push(`${res.overwritten} sovrascritte`);
        toast(`Connessioni: ${parts.join(', ')}`);
        loadSavedConnections();
      }).catch((err) => toast(err.message, true));
    });
  });

  $('#disconnect-btn').addEventListener('click', () => {
    socket.emit('mongo:disconnect', {}, () => {});
    location.reload();
  });

  socket.on('connect', () => {
    if (!state.connected) loadSavedConnections();
  });

  socket.on('disconnect', () => {
    if (state.connected) toast('Connessione al server persa, riconnessione…', true);
  });
}
