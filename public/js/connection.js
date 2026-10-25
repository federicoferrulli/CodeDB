import { socket } from './socket.js';
import { tabs, activeTab, createTab, closeAllTabs } from './tabs.js';
import { $, emit, toast, safeUUID, openModal, closeModal, showError, conCaricamento, esc, dbTypeIcon, lucideIconHtml as ICO, refreshLucideIcons, chiediTesto, scaricaFile } from './utils.js';
import { loadSavedConnections, elencoConnessioni } from './connmanager.js';
import { renderTabBar } from './tabbar.js';
import { renderWorkspace, saveWorkspaceInputs } from './workspace.js';
import { startSchemaWatch } from './live.js';
import { restoreSession, persistSession, restoreInProgress } from './session-restore.js';
import { segnaTraguardo } from './onboarding-stato.js';
import { riepilogoUri } from './riepilogo-uri.mjs';
import { chiediConferma } from './conferma.js';
import { startMobileConnection } from '../arc/ui.js';

// Modale di connessione (nuova connessione o modifica di una salvata).
// L'elenco delle connessioni salvate vive nella sidebar (connmanager.js).

let editingConn = null;
let savedSecrets = {};
let savedUriPreview = '';
let savedSshKeyName = '';
let savedSshAuth = '';
let savedSshKeyFile = '';
let uploadedSshKey = null;
let sshKeyRead = 0;
let sshKeyLoading = false;
let sshKeyError = '';
let currentStep = 1;

export function setWizardStep(step) {
  const sshOn = $('#conn-ssh-toggle')?.checked;
  // Se SSH è disattivato e si cerca di andare al passo 2, salta al 3 o 1
  if (step === 2 && !sshOn) {
    step = currentStep === 1 ? 3 : 1;
  }
  currentStep = Math.max(1, Math.min(3, step));

  document.querySelectorAll('.wizard-panel').forEach((panel) => {
    panel.classList.toggle('hidden', parseInt(panel.dataset.step, 10) !== currentStep);
  });

  document.querySelectorAll('.wizard-step-badge').forEach((badge) => {
    const s = parseInt(badge.dataset.step, 10);
    badge.classList.toggle('active', s === currentStep);
    badge.classList.toggle('completed', s < currentStep);
    badge.classList.toggle('disabled', s === 2 && !sshOn);
  });

  const subtitles = {
    1: 'Passo 1: Parametri di connessione',
    2: 'Passo 2: Configurazione Tunnel SSH',
    3: 'Passo 3: Riepilogo e conferma',
  };
  const subtitleEl = $('#wizard-subtitle');
  if (subtitleEl) subtitleEl.textContent = subtitles[currentStep] || '';

  updateWizardActions();

  $('#connect-error')?.classList.add('hidden');
  $('#connect-test-msg')?.classList.add('hidden');

  if (currentStep === 3) {
    updateWizardSummary();
  }
}

function updateWizardActions() {
  $('#wizard-prev-btn').classList.toggle('hidden', currentStep === 1);
  // Il riepilogo ha già il proprio comando: il secondo percorso serve solo per configurare SSH.
  $('#wizard-next-btn').classList.toggle('hidden', currentStep !== 1 || !$('#conn-ssh-toggle').checked);
  const confirm = currentStep === 3;
  const btn = $('#connect-btn');
  btn.innerHTML = `<span>${confirm ? 'Conferma e connetti' : 'Rivedi connessione'}</span>${ICO(confirm ? 'plug-zap' : 'arrow-right', 'connection-action-icon')}`;
  refreshLucideIcons(btn);
}

function updateWizardSummary() {
  const cfg = readConnForm();
  const summaryBox = $('#wizard-summary-box');
  if (!summaryBox) return;
  const dbIcon = dbTypeIcon(cfg.dbType);
  const dbTypeName = { mongodb: 'MongoDB', mysql: 'MySQL', postgresql: 'PostgreSQL', postgres: 'PostgreSQL' }[cfg.dbType] || cfg.dbType;
  const secret = field => {
    const retained = savedSecrets[field] && (field === 'sshPassphrase' ? sameSavedSshKey(cfg) : field !== 'sshPassword' || cfg.sshAuth === savedSshAuth);
    return cfg[field] ? '•••••• · Inserita' : retained ? 'Invariata · Già salvata' : 'Non impostata';
  };
  const rows = [];
  if (cfg.connectionMode === 'uri') {
    rows.push(['Modalità', 'URI completa'], ['URI', cfg.uri.trim() ? riepilogoUri(cfg.uri) : savedUriPreview || secret('uri')]);
  } else {
    rows.push(['Host', cfg.host.trim() || 'localhost'],
      ['Porta', cfg.port || { mongodb: '27017', mysql: '3306', postgresql: '5432' }[cfg.dbType]],
      ['Utente', cfg.username || 'Non impostato'], ['Password', secret('password')],
      cfg.dbType === 'mongodb' ? ['Auth source', cfg.authSource || 'admin'] : ['Database', cfg.database || 'Non specificato']);
  }
  rows.push(['Tunnel SSH', cfg.ssh === 'true' ? 'Attivo' : 'Disattivato']);
  if (cfg.ssh === 'true') {
    rows.push(['Host SSH', cfg.sshHost || 'Non impostato'], ['Porta SSH', cfg.sshPort || '22'],
      ['Utente SSH', cfg.sshUser || 'Non impostato'],
      ['Autenticazione SSH', { password: 'Password', upload: 'File dal dispositivo', path: 'Percorso sul server CodeDB' }[cfg.sshAuth]]);
    if (cfg.sshAuth === 'password') rows.push(['Password SSH', secret('sshPassword')]);
    else rows.push(['Chiave privata', cfg.sshAuth === 'path' ? cfg.sshKeyFile || 'Non impostata'
      : cfg.sshKeyName ? `${cfg.sshKeyName} · ${uploadedSshKey ? 'Caricata' : 'Già salvata'}` : savedSecrets.sshPrivateKey ? 'Già salvata' : 'Non selezionata'],
    ['Passphrase chiave', secret('sshPassphrase')]);
    rows.push(['Impronta host SSH', cfg.sshHostKey || 'Da rilevare e confermare al collegamento']);
    rows.push(['Forwarding locale', cfg.sshLocalPort ? `127.0.0.1:${cfg.sshLocalPort} → ${cfg.host || 'localhost'}:${cfg.port || { mongodb: '27017', mysql: '3306', postgresql: '5432' }[cfg.dbType]}` : 'Disattivato']);
  }
  summaryBox.innerHTML = `<strong class="connection-summary-engine">${dbIcon} ${esc(dbTypeName)}</strong>
    <dl class="connection-summary-fields">${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
  const saved = cfg.saveAs && (cfg.saveAs === editingConn || elencoConnessioni().some(conn => conn.name === cfg.saveAs));
  $('#conn-save-status').textContent = cfg.saveAs
    ? `${saved ? 'La connessione salvata verrà aggiornata' : 'La connessione verrà salvata'} come “${cfg.saveAs}”${cfg.folder ? ` nella cartella “${cfg.folder}”` : ''}, solo se il collegamento riesce.`
    : 'La connessione non verrà salvata. Sarà disponibile solo per questa sessione.';
  refreshLucideIcons(summaryBox);
}

function selectConnTab(name) {
  document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#tab-fields').classList.toggle('hidden', name !== 'fields');
  $('#tab-uri').classList.toggle('hidden', name !== 'uri');
}

export function syncConnForm(updatePort = false) {
  const form = $('#connect-form');
  const type = form.elements.dbType.value;
  const isSql = type === 'mysql' || type === 'postgresql' || type === 'postgres';
  const sshOn = form.elements.ssh.checked;
  form.elements.sshLocalPort.disabled = !sshOn;

  $('#row-authsource').classList.toggle('hidden', isSql);
  $('#row-database').classList.toggle('hidden', !isSql);

  const sshBadge = $('#wizard-badge-ssh');
  if (sshBadge) sshBadge.classList.toggle('disabled', !sshOn);

  $('#tab-uri-btn').classList.toggle('hidden', isSql || sshOn);

  if ((isSql || sshOn) && !$('#tab-uri').classList.contains('hidden')) {
    selectConnTab('fields');
  }

  const port = form.elements.port;
  if (updatePort && (type === 'postgresql' || type === 'postgres')) {
    if (port.value === '27017' || port.value === '3306') port.value = '5432';
  } else if (updatePort && type === 'mysql') {
    if (port.value === '27017' || port.value === '5432') port.value = '3306';
  } else if (updatePort) {
    if (port.value === '3306' || port.value === '5432') port.value = '27017';
  }
  syncSshAuth();
  updateWizardActions();
}

function sameSavedSshKey(cfg) {
  return cfg.sshAuth === savedSshAuth && (cfg.sshAuth === 'upload' ? !uploadedSshKey : cfg.sshKeyFile === savedSshKeyFile);
}

function syncSshAuth() {
  const mode = $('#connect-form').elements.sshAuth.value;
  $('#connect-form').elements.sshPassphrase.placeholder = savedSecrets.sshPassphrase && sameSavedSshKey(readConnForm())
    ? '(invariata se lasciata vuota)' : '(se la chiave è protetta)';
  $('#conn-ssh-password-row').classList.toggle('hidden', mode !== 'password');
  $('#conn-ssh-upload-row').classList.toggle('hidden', mode !== 'upload');
  $('#conn-ssh-path-row').classList.toggle('hidden', mode !== 'path');
  $('#conn-ssh-passphrase-row').classList.toggle('hidden', mode === 'password');
  $('#conn-ssh-key-status').textContent = sshKeyError || (sshKeyLoading ? 'Lettura del file…' : uploadedSshKey
    ? `Chiave caricata: ${uploadedSshKey.name}. Verrà conservata nel vault solo se salvi la connessione.`
    : savedSecrets.sshPrivateKey ? `Chiave già salvata: ${savedSshKeyName || 'chiave privata'}. Scegli un file solo per sostituirla.`
      : 'Scegli la chiave privata, non il file .pub. Massimo 64 KB.');
}

async function readSshKeyFile() {
  const read = ++sshKeyRead;
  const file = $('#conn-ssh-key-upload').files[0];
  uploadedSshKey = null;
  sshKeyError = '';
  sshKeyLoading = !!file;
  syncSshAuth();
  try {
    if (!file) return;
    if (!file.size || file.size > 64 * 1024) throw new Error('Scegli un file non vuoto di massimo 64 KB.');
    const text = await file.text();
    if (read !== sshKeyRead) return;
    if (!text.trim()) throw new Error('Il file di chiave privata è vuoto.');
    if (/^(ssh-|ecdsa-|sk-)|BEGIN (?:RSA )?PUBLIC KEY/.test(text.trim())) throw new Error('Hai selezionato una chiave pubblica. Scegli la chiave privata, non il file .pub.');
    uploadedSshKey = { name: file.name, text };
  } catch (error) {
    if (read === sshKeyRead) sshKeyError = error.message || 'Impossibile leggere il file selezionato.';
  } finally {
    if (read === sshKeyRead) {
      sshKeyLoading = false;
      syncSshAuth();
      if (currentStep === 3) updateWizardSummary();
    }
  }
}

function validateSshKey(cfg) {
  if (cfg.ssh !== 'true' || cfg.sshAuth !== 'upload') return true;
  const message = sshKeyLoading ? 'Attendi la lettura della chiave privata.' : sshKeyError
    || (!uploadedSshKey && !savedSecrets.sshPrivateKey ? 'Scegli il file di chiave privata dal tuo dispositivo.' : '');
  if (!message) return true;
  setWizardStep(2);
  showError('#connect-error', message);
  $('#conn-ssh-key-select').focus();
  return false;
}

function readConnForm() {
  const form = $('#connect-form');
  const type = form.elements.dbType.value;
  const isSql = type === 'mysql' || type === 'postgresql' || type === 'postgres';
  const usingUri = !isSql && !$('#tab-uri').classList.contains('hidden');
  const cfg = usingUri
    ? { uri: form.elements.uri.value }
    : {
      host: form.elements.host.value,
      port: form.elements.port.value,
      username: form.elements.username.value,
      password: form.elements.password.value,
    };
  cfg.connectionMode = usingUri ? 'uri' : 'fields';
  if (!usingUri) {
    if (isSql) cfg.database = form.elements.database.value;
    else cfg.authSource = form.elements.authSource.value;
  }
  cfg.dbType = form.elements.dbType.value;
  cfg.saveAs = form.elements.saveAs.value.trim();
  cfg.folder = form.elements.folder.value.trim();
  const sshOn = form.elements.ssh.checked;
  cfg.ssh = sshOn ? 'true' : '';
  if (sshOn) {
    cfg.sshHost = form.elements.sshHost.value;
    cfg.sshPort = form.elements.sshPort.value;
    cfg.sshLocalPort = form.elements.sshLocalPort.value.trim();
    cfg.sshUser = form.elements.sshUser.value;
    cfg.sshAuth = form.elements.sshAuth.value;
    if (cfg.sshAuth === 'password') cfg.sshPassword = form.elements.sshPassword.value;
    else {
      if (cfg.sshAuth === 'path') cfg.sshKeyFile = form.elements.sshKeyFile.value;
      else {
        cfg.sshPrivateKey = uploadedSshKey?.text || '';
        cfg.sshKeyName = uploadedSshKey?.name || savedSshKeyName;
      }
      cfg.sshPassphrase = form.elements.sshPassphrase.value;
    }
    // Impronta della host key: non è un segreto, viaggia in chiaro col resto
    // della configurazione ed è registrata al primo collegamento riuscito.
    cfg.sshHostKey = form.elements.sshHostKey.value.trim();
  }
  return cfg;
}

export function openConnModal() {
  cancelEditConn();
  setWizardStep(1);
  $('#connect-error').classList.add('hidden');
  $('#connect-test-msg').classList.add('hidden');
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
// Campi che non devono sopravvivere alla richiesta di connessione (CDB-22).
//
// `uri` è nell'elenco perché in modalità "URI completa" le credenziali stanno
// DENTRO la stringa (`mongodb://utente:segreto@host/`): togliere il campo
// `password` e lasciare l'URI significava dichiarare chiuso un buco che restava
// aperto per metà degli utenti (CDB-70).
const CAMPI_SEGRETI = ['password', 'sshPassword', 'sshPassphrase', 'sshPrivateKey', 'uri'];

/**
 * Configurazione conservabile sul tab: per una connessione salvata resta il
 * solo nome (il server ha tutto il resto), per una non salvata i parametri
 * senza i segreti — così ciò che rimane in memoria non basta comunque a
 * collegarsi al database.
 */
function senzaSegreti(cfg) {
  if (cfg.saved || cfg.saveAs) return { saved: cfg.saved || cfg.saveAs };
  const copia = { ...cfg };
  for (const f of CAMPI_SEGRETI) delete copia[f];
  return copia;
}

async function conImprontaSsh(cfg, invia) {
  try { return await invia(); }
  catch (error) {
    if (error.code !== 'SSH_HOST_KEY_UNKNOWN' || cfg.sshHostKey || cfg.saved) throw error;
    const form = $('#connect-form');
    const verificaForm = () => {
      if ($('#connect-overlay').classList.contains('hidden')
        || !form.elements.ssh.checked
        || form.elements.sshHost.value !== cfg.sshHost || form.elements.sshPort.value !== cfg.sshPort
        || form.elements.sshHostKey.value.trim()) throw new Error('Verifica SSH annullata: la connessione è stata chiusa o modificata. Riprova.');
    };
    verificaForm();
    const accepted = await chiediConferma(`Prima connessione SSH a ${cfg.sshHost}:${cfg.sshPort || '22'}.\n\n`
      + `Impronta rilevata:\n${error.sshHostKey}\n\n`
      + 'Confrontala con quella fornita dall’amministratore del server. Nessuna credenziale è stata inviata al server SSH.\n\n'
      + 'Vuoi fidarti di questa chiave e continuare?');
    if (!accepted) throw new Error('Chiave SSH non approvata. Nessuna credenziale è stata inviata al server SSH.');
    verificaForm();
    cfg.sshHostKey = error.sshHostKey;
    form.elements.sshHostKey.value = error.sshHostKey;
    if (currentStep === 3) updateWizardSummary();
    // Un solo nuovo tentativo con l’impronta approvata: una variazione resta bloccata.
    return invia();
  }
}

export function connectAndOpenTab(cfg) {
  const current = activeTab();
  const reuse = current && !current.state.connected ? current : null;
  const tabId = reuse ? reuse.id : safeUUID();
  saveWorkspaceInputs(); // snapshot del tab che (forse) si lascia
  const request = { ...cfg, tabId };
  const feedbackMobile = startMobileConnection(cfg.saved || cfg.saveAs || cfg.host || 'database');
  if (!feedbackMobile && cfg.saved) toast(`Connessione a "${cfg.saved}"…`);
  return conImprontaSsh(request, () => new Promise((resolve, reject) => {
    socket.emit('mongo:connect', request, res => res.ok ? resolve(res)
      : reject(Object.assign(new Error(res.error), { code: res.code, sshHostKey: res.sshHostKey })));
  })).then((res) => {
    const tab = reuse || createTab({ id: tabId });
    tab.connName = cfg.saved || cfg.saveAs || null;
    // MAI i segreti in memoria nel browser (CDB-22). Prima qui restava l'intera
    // configurazione — password del database, password e passphrase SSH — per
    // tutta la durata della sessione, a disposizione di qualunque codice giri
    // nella pagina. Serviva alla riconnessione automatica, ma per una
    // connessione SALVATA basta il nome: i segreti li ha il server e non li
    // manda mai al client. Per una connessione non salvata la riconnessione
    // automatica non è più possibile — ed è lo stesso limite, già dichiarato,
    // del ripristino di sessione dopo un F5.
    tab.connCfg = senzaSegreti({ ...cfg, sshHostKey: res.sshHostKey || cfg.sshHostKey });
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
    startSchemaWatch(); // auto-update della sidebar (db/collection) per questo tab
    segnaTraguardo('connessione'); // primi passi della guida (no-op se già fatto)
    if (cfg.saveAs) loadSavedConnections();
    if (!feedbackMobile && cfg.saved) toast(`Connesso a "${cfg.saved}"`);
    return res;
  }).catch(err => {
    if (feedbackMobile) {
      feedbackMobile(err.message);
      err.mobileConnectionFeedback = true;
    } else if (cfg.saved) toast(err.message, true);
    throw err;
  }).finally(() => {
    feedbackMobile?.();
  });
}

export function startEditConn(name) {
  emit('connections:get', { name }).then((res) => {
    const f = res.fields;
    clearSshKey();
    savedSecrets = { password: res.hasPassword, uri: res.hasUri, sshPassword: res.hasSshPassword, sshPassphrase: res.hasSshPassphrase, sshPrivateKey: res.hasSshPrivateKey };
    savedUriPreview = res.uriPreview || '';
    $('#conn-uri-saved').textContent = savedUriPreview;
    $('#conn-uri-saved-info').classList.toggle('hidden', !savedUriPreview);
    savedSshKeyName = f.sshKeyName || '';
    const form = $('#connect-form');
    const dbType = (f.dbType || 'mongodb').trim().toLowerCase().replace(/^postgres$/, 'postgresql');
    const isSql = dbType === 'mysql' || dbType === 'postgresql' || dbType.includes('postgres');
    const defaultPort = dbType === 'mysql' ? '3306' : (dbType.includes('postgres') ? '5432' : '27017');
    form.elements.dbType.value = dbType;
    selectConnTab(res.hasUri && !isSql ? 'uri' : 'fields');
    form.elements.uri.value = '';
    form.elements.uri.placeholder = res.hasUri ? '(invariata se lasciata vuota)' : '';
    form.elements.host.value = f.host || 'localhost';
    form.elements.port.value = f.port || defaultPort;
    form.elements.username.value = f.username || '';
    form.elements.password.value = '';
    form.elements.password.placeholder = res.hasPassword ? '(invariata se lasciata vuota)' : '';
    form.elements.authSource.value = f.authSource || 'admin';
    form.elements.database.value = f.database || '';
    form.elements.folder.value = f.folder || '';
    form.elements.ssh.checked = (f.ssh || '').toLowerCase() === 'true';
    form.elements.sshHost.value = f.sshHost || '';
    form.elements.sshPort.value = f.sshPort || '22';
    form.elements.sshLocalPort.value = f.sshLocalPort || '';
    form.elements.sshUser.value = f.sshUser || '';
    form.elements.sshAuth.value = f.sshAuth || (res.hasSshPrivateKey ? 'upload' : f.sshKeyFile ? 'path' : 'password');
    savedSshAuth = form.elements.sshAuth.value;
    savedSshKeyFile = f.sshKeyFile || '';
    form.elements.sshPassword.value = '';
    form.elements.sshPassword.placeholder = res.hasSshPassword ? '(invariata se lasciata vuota)' : '';
    form.elements.sshKeyFile.value = f.sshKeyFile || '';
    form.elements.sshHostKey.value = f.sshHostKey || '';
    form.elements.sshPassphrase.value = '';
    form.elements.sshPassphrase.placeholder = res.hasSshPassphrase ? '(invariata se lasciata vuota)' : '(se la chiave è protetta)';
    form.elements.saveAs.value = name;
    syncConnForm();
    editingConn = name;
    setWizardStep(1);
    $('#conn-edit-name').textContent = name;
    $('#conn-edit-banner').classList.remove('hidden');
    $('#conn-edit-hint').classList.remove('hidden');
    $('#conn-save-btn').classList.remove('hidden');
    $('#connect-error').classList.add('hidden');
    $('#connect-test-msg').classList.add('hidden');
    $('#connect-overlay').classList.remove('hidden');
  }).catch((err) => toast(err.message, true));
}

function clearSshKey() {
  sshKeyRead++;
  uploadedSshKey = null;
  savedSshKeyName = '';
  savedSshAuth = '';
  savedSshKeyFile = '';
  sshKeyLoading = false;
  sshKeyError = '';
  $('#conn-ssh-key-upload').value = '';
}

function cancelEditConn() {
  editingConn = null;
  savedSecrets = {};
  savedUriPreview = '';
  $('#conn-uri-saved').textContent = '';
  $('#conn-uri-saved-info').classList.add('hidden');
  $('#conn-edit-hint').classList.add('hidden');
  clearSshKey();
  const form = $('#connect-form');
  form.reset();
  form.elements.password.placeholder = '';
  form.elements.uri.placeholder = '';
  form.elements.sshPassword.placeholder = '';
  form.elements.sshPassphrase.placeholder = '(se la chiave è protetta)';
  syncConnForm();
  setWizardStep(1);
  $('#conn-edit-banner').classList.add('hidden');
  $('#conn-save-btn').classList.add('hidden');
}

export function initConnection() {
  document.querySelectorAll('.tab[data-tab]').forEach((tab) =>
    tab.addEventListener('click', () => selectConnTab(tab.dataset.tab))
  );

  document.querySelectorAll('.wizard-step-badge').forEach((badge) => {
    badge.addEventListener('click', () => {
      const step = parseInt(badge.dataset.step, 10);
      setWizardStep(step);
    });
  });

  $('#wizard-prev-btn')?.addEventListener('click', () => setWizardStep(currentStep - 1));
  $('#wizard-next-btn')?.addEventListener('click', () => setWizardStep(currentStep + 1));

  $('#conn-dbtype').addEventListener('change', () => syncConnForm(true));
  $('#conn-ssh-toggle').addEventListener('change', () => syncConnForm());
  $('#conn-ssh-auth').addEventListener('change', syncSshAuth);
  $('#conn-ssh-key-select').addEventListener('click', () => $('#conn-ssh-key-upload').click());
  $('#conn-ssh-key-upload').addEventListener('change', readSshKeyFile);
  $('#connect-form').addEventListener('input', event => {
    if (event.target.name === 'sshKeyFile') syncSshAuth();
    if (currentStep === 3) updateWizardSummary();
  });

  $('#conn-test-btn')?.addEventListener('click', () => {
    const cfg = readConnForm();
    if (!validateSshKey(cfg)) return;
    if (editingConn) cfg.keepPasswordFrom = editingConn;
    const btn = $('#conn-test-btn');
    $('#connect-error').classList.add('hidden');
    $('#connect-test-msg').classList.add('hidden');

    // Etichetta salvata e ripristinata da `conCaricamento`: prima "⚡ Testa
    // Connessione" era una stringa letterale ripetuta in tre punti, e bastava
    // rinominare il pulsante nell'HTML perché al primo clic cambiasse nome.
    conCaricamento(btn, () => conImprontaSsh(cfg, () => emit('connections:test', cfg)), 'Verifica…')
      .then((res) => {
        const msg = $('#connect-test-msg');
        msg.textContent = `✓ Connessione riuscita! (${res.dbType.toUpperCase()}, ${res.databases} DB trovati)`;
        msg.classList.remove('hidden');
      })
      .catch((err) => {
        const errorEl = $('#connect-error');
        errorEl.textContent = `Errore di connessione: ${err.message}`;
        errorEl.classList.remove('hidden');
      });
  });

  $('#connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (currentStep !== 3) {
      setWizardStep(3);
      $('#wizard-summary-title').focus();
      return;
    }
    const cfg = readConnForm();
    if (!validateSshKey(cfg)) return;
    if (editingConn) cfg.keepPasswordFrom = editingConn;
    const btn = $('#connect-btn');
    $('#connect-error').classList.add('hidden');
    conCaricamento(btn, () => connectAndOpenTab(cfg), 'Connessione…').then(() => {
      cancelEditConn();
      closeConnModal();
    }).catch((err) => {
      if (err.mobileConnectionFeedback) return;
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
    if (!validateSshKey(cfg)) return;
    const name = (cfg.saveAs || '').trim();
    if (!name) {
      const err = $('#connect-error');
      err.textContent = 'Indica un nome nel campo "Salva come".';
      err.classList.remove('hidden');
      return;
    }
    conCaricamento($('#conn-save-btn'), () => emit('connections:save', { name, oldName: editingConn, cfg }), 'Salvo…').then(() => {
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

  // L'export apre una modale: si può indicare la passphrase con cui cifrare i
  // segreti (es. quella dell'installazione di destinazione), oppure lasciarla
  // vuota per usare quella di questa installazione (comportamento storico).
  $('#conn-export-btn').addEventListener('click', () => {
    $('#connexport-pass').value = '';
    showError('#connexport-error', '');
    openModal('connexport-overlay');
  });

  $('#connexport-cancel').addEventListener('click', () => closeModal('connexport-overlay'));

  $('#connexport-run').addEventListener('click', () => {
    const passphrase = $('#connexport-pass').value;
    conCaricamento($('#connexport-run'), () => emit('connections:export', { passphrase }), 'Esporto…').then(async (res) => {
      const blob = new Blob([res.ini], { type: 'text/plain' });
      if (!await scaricaFile(blob, 'connections.ini')) return;
      closeModal('connexport-overlay');
      toast(passphrase
        ? 'Download connessioni avviato (segreti cifrati con la passphrase indicata)'
        : 'Download connessioni avviato (segreti cifrati)');
    }).catch((err) => showError('#connexport-error', err.message));
  });

  $('#conn-import-btn').addEventListener('click', () => $('#conn-import-file').click());

  $('#conn-import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    // Il pulsante visibile è "Importa", non il campo file nascosto che ha
    // appena aperto il selettore: è quello che deve mostrare l'attesa.
    conCaricamento($('#conn-import-btn'), () => file.text().then(async (ini) => {
      // Un file esportato con una passphrase scelta porta un'intestazione che
      // lo dichiara: la si riconosce qui per chiedere la passphrase PRIMA di
      // mandare il file, invece di far tornare un errore dal server.
      const conPassphrase = /^\s*\[__codedb_export__\]/m.test(ini);
      const passphrase = conPassphrase
        ? await chiediTesto({ titolo: 'Importa connessioni cifrate', sottotitolo: 'Inserisci la passphrase scelta quando hai esportato questo file.', etichetta: 'Passphrase', password: true, ok: 'Importa' })
        : '';
      if (conPassphrase && !passphrase) {
        toast('Import annullato: senza la passphrase i segreti non sono leggibili.', true);
        return null;
      }
      return emit('connections:import', { ini, passphrase }).then((res) => {
        const parts = [];
        if (res.imported) parts.push(`${res.imported} importate`);
        if (res.overwritten) parts.push(`${res.overwritten} sovrascritte`);
        toast(`Connessioni: ${parts.join(', ')}`);
        loadSavedConnections();
      }).catch((err) => toast(err.message, true));
    }), 'Importo…').catch(err => toast(`Impossibile importare il file: ${err.message}`, true));
  });

  // Nessun pulsante "Disconnetti": chiudere la connessione significa chiudere
  // il suo tab, e la ✕ del tab (o il clic centrale) fa gia' esattamente questo.

  let hadSession = false;
  socket.on('connect', async () => {
    loadSavedConnections();
    if (!hadSession) {
      // Primo collegamento dopo il caricamento della pagina (incluso un F5):
      // ripristina la sessione salvata in sessionStorage (riconnette le
      // connessioni salvate, il tab attivo e il database/collection selezionati).
      hadSession = true;
      await restoreSession();
      return;
    }
    // Riconnessione del socket a runtime: le sessioni server sono andate perse.
    // Si cattura il layout attuale, si svuotano i tab (sessioni morte) e si
    // riapre tutto riconnettendosi — l'utente resta operativo senza fare nulla.
    //
    // Se un ripristino è GIÀ in corso non si riparte da capo: su rete instabile
    // Socket.IO può riconnettersi più volte a pochi secondi di distanza, e il
    // ciclo "persist → closeAllTabs → restore" a metà di un altro ripristino
    // salverebbe un layout parziale e chiuderebbe i tab appena riaperti. Le
    // riconnessioni in volo del ripristino corrente viaggiano comunque sul
    // socket nuovo.
    if (restoreInProgress()) return;
    if (tabs.list.length) {
      persistSession();
      closeAllTabs();
      renderTabBar();
      renderWorkspace();
      await restoreSession();
    }
  });

  socket.on('disconnect', () => {
    if (tabs.list.some((t) => t.state.connected)) {
      toast('Connessione al server persa, riconnessione…', true);
    }
  });

  initConnErrorOverlay();
}

/* ---------------------------------------------------------------------------
 * Handshake rifiutato o server irraggiungibile
 *
 * Il server ha già un motivo esplicito per ogni rifiuto (gate sull'Origin,
 * header Host su istanza in loopback) e lo manda al client come `connect_error`,
 * ma nessuno lo mostrava: l'unico gestore era quello di `auth.js`, limitato a
 * `auth_required`. Il risultato, in beta, sarebbe stato il peggior errore
 * possibile — una pagina aperta che non fa nulla, senza dire perché.
 *
 * Non è un toast: finché la causa non è risolta non c'è niente da fare
 * nell'applicazione, quindi l'avviso resta finché il collegamento non riesce.
 * ------------------------------------------------------------------------- */
function initConnErrorOverlay() {
  const overlay = $('#conn-error-overlay');
  if (!overlay) return;
  const msgEl = $('#conn-error-msg');
  const hintEl = $('#conn-error-hint');
  const retryBtn = $('#conn-error-retry');

  // Errori di trasporto: il server non risponde affatto. Sono gli unici per cui
  // ha senso ritentare da soli, e capitano di continuo durante un riavvio del
  // server — mostrarli subito trasformerebbe un riavvio di due secondi in un
  // avviso a schermo intero. Si attende qualche tentativo prima di allarmare.
  const TRASPORTO = /websocket error|xhr poll error|transport error|transport close|timeout/i;
  const TENTATIVI_PRIMA_DI_ALLARMARE = 3;
  let tentativiTrasporto = 0;

  function mostra(testo, suggerimento) {
    msgEl.textContent = testo;
    hintEl.textContent = suggerimento || '';
    hintEl.classList.toggle('hidden', !suggerimento);
    overlay.classList.remove('hidden');
    if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
  }

  function nascondi() {
    overlay.classList.add('hidden');
    tentativiTrasporto = 0;
  }

  // Chiede al server perché l'handshake non passa. Ritorna il motivo del
  // rifiuto, oppure null se il server non risponde (allora è davvero
  // irraggiungibile) o se non ha nulla da obiettare.
  async function diagnostica() {
    try {
      const res = await fetch('handshake-check', { cache: 'no-store' });
      const dati = await res.json().catch(() => null);
      if (dati && dati.ok === false && dati.reason) return dati.reason;
      return null;
    } catch {
      return null; // server irraggiungibile: lo dice il messaggio di ripiego
    }
  }

  socket.on('connect', nascondi);

  socket.on('connect_error', (err) => {
    const motivo = (err && err.message) || 'motivo sconosciuto';
    // Il login ha il suo percorso (auth.js): qui non c'entra nulla.
    if (motivo === 'auth_required') return;

    if (TRASPORTO.test(motivo)) {
      tentativiTrasporto++;
      if (tentativiTrasporto < TENTATIVI_PRIMA_DI_ALLARMARE) return;
      // "xhr poll error" è ambiguo: è quello che si vede sia quando il server è
      // spento sia quando ha RIFIUTATO l'handshake (il motivo del rifiuto non
      // viaggia sul canale Socket.IO). Lo si chiede al server, che risponde
      // sulla stessa origine della pagina: se risponde, il problema non è la
      // raggiungibilità ed è lui a dire quale sia.
      diagnostica().then((rifiuto) => {
        if (rifiuto) mostra(`Il server ha rifiutato il collegamento: ${rifiuto}`);
        else mostra(
          'Il server CodeDB non risponde. Il tentativo di riconnessione continua automaticamente.',
          'Se hai avviato CodeDB da un launcher o dal terminale, controlla che il processo sia ancora attivo (su Windows: CodeDB.cmd stop e poi riavvia).'
        );
      });
      return;
    }

    // Rifiuto con messaggio esplicito (middleware Socket.IO): si mostra così.
    mostra(`Il server ha rifiutato il collegamento: ${motivo}`);
  });

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      nascondi();
      // `connect()` su un socket che sta già ritentando è innocuo: forza solo
      // il tentativo immediato invece di attendere il backoff.
      try { socket.connect(); } catch { /* il gestore di connect_error riaprirà l'avviso */ }
    });
  }
}
