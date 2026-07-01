import { socket } from './socket.js';
import { tabs, activeTab, createTab, closeTab, closeAllTabs } from './tabs.js';
import { $, emit, toast } from './utils.js';
import { loadSavedConnections } from './connmanager.js';
import { renderTabBar } from './tabbar.js';
import { renderWorkspace, saveWorkspaceInputs } from './workspace.js';

// Modale di connessione (nuova connessione o modifica di una salvata).
// L'elenco delle connessioni salvate vive nella sidebar (connmanager.js).

let editingConn = null;

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
  cfg.folder = form.elements.folder.value;
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

export function openConnModal() {
  cancelEditConn();
  $('#connect-error').classList.add('hidden');
  $('#connect-overlay').classList.remove('hidden');
}

function closeConnModal() {
  $('#connect-overlay').classList.add('hidden');
}

// Connette e apre un tab: il tabId viene generato prima (è la chiave della
// sessione server) ma il tab compare solo a connessione riuscita. Se il tab
// attivo non è connesso (stato iniziale) viene riusato il suo posto.
// Socket diretta e non emit(): la risposta va gestita anche se nel frattempo
// l'utente ha chiuso il tab attivo (emit la scarterebbe).
export function connectAndOpenTab(cfg) {
  const current = activeTab();
  const reuse = current && !current.state.connected ? current : null;
  const tabId = reuse ? reuse.id : crypto.randomUUID();
  saveWorkspaceInputs(); // snapshot del tab che (forse) si lascia
  return new Promise((resolve, reject) => {
    socket.emit('mongo:connect', { ...cfg, tabId }, (res) =>
      res.ok ? resolve(res) : reject(new Error(res.error))
    );
  }).then((res) => {
    const tab = reuse || createTab({ id: tabId });
    tab.connName = cfg.saved || cfg.saveAs || null;
    tab.dbType = res.dbType || 'mongodb';
    tab.label = tab.connName || res.label || 'Connessione';
    Object.assign(tab.state, {
      connected: true,
      connLabel: res.label || '',
      dbType: tab.dbType,
      databases: res.databases || [],
    });
    tabs.activeId = tab.id;
    renderTabBar();
    renderWorkspace();
    if (cfg.saveAs) loadSavedConnections();
    return res;
  });
}

export function startEditConn(name) {
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
    form.elements.folder.value = f.folder || '';
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
    $('#connect-overlay').classList.remove('hidden');
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
    const btn = $('#connect-btn');
    btn.disabled = true;
    btn.textContent = 'Connessione…';
    $('#connect-error').classList.add('hidden');
    connectAndOpenTab(cfg).then(() => {
      btn.disabled = false;
      btn.textContent = 'Connetti';
      cancelEditConn();
      closeConnModal();
    }).catch((err) => {
      btn.disabled = false;
      btn.textContent = 'Connetti';
      const errorEl = $('#connect-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });

  $('#conn-edit-cancel').addEventListener('click', cancelEditConn);

  $('#conn-cancel-btn').addEventListener('click', () => {
    cancelEditConn();
    closeConnModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#connect-overlay').classList.contains('hidden')) {
      cancelEditConn();
      closeConnModal();
    }
  });

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
      closeConnModal();
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
      toast('Connessioni esportate (segreti cifrati)');
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

  // "Disconnetti" = chiudi il tab attivo (la sessione server viene chiusa).
  $('#disconnect-btn').addEventListener('click', () => {
    const tab = activeTab();
    if (!tab) return;
    closeTab(tab.id);
    renderTabBar();
    renderWorkspace();
  });

  let hadSession = false;
  socket.on('connect', () => {
    loadSavedConnections();
    // Riconnessione del socket: le sessioni server sono andate perse, i tab
    // aperti non sono più validi.
    if (hadSession && tabs.list.length) {
      closeAllTabs();
      renderTabBar();
      renderWorkspace();
      toast('Sessione persa: i tab sono stati chiusi, riconnettiti.', true);
    }
    hadSession = true;
  });

  socket.on('disconnect', () => {
    if (tabs.list.some((t) => t.state.connected)) {
      toast('Connessione al server persa, riconnessione…', true);
    }
  });
}
