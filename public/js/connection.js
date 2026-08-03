import { socket } from './socket.js';
import { tabs, activeTab, createTab, closeTab, closeAllTabs } from './tabs.js';
import { $, emit, toast, safeUUID, openModal, closeModal, showError } from './utils.js';
import { loadSavedConnections } from './connmanager.js';
import { renderTabBar } from './tabbar.js';
import { renderWorkspace, saveWorkspaceInputs } from './workspace.js';
import { startSchemaWatch } from './live.js';
import { restoreSession, persistSession, restoreInProgress } from './session-restore.js';

// Modale di connessione (nuova connessione o modifica di una salvata).
// L'elenco delle connessioni salvate vive nella sidebar (connmanager.js).

let editingConn = null;
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
    3: 'Passo 3: Salvataggio & Connessione',
  };
  const subtitleEl = $('#wizard-subtitle');
  if (subtitleEl) subtitleEl.textContent = subtitles[currentStep] || '';

  $('#wizard-prev-btn')?.classList.toggle('hidden', currentStep === 1);
  $('#wizard-next-btn')?.classList.toggle('hidden', currentStep === 3);

  $('#connect-error')?.classList.add('hidden');
  $('#connect-test-msg')?.classList.add('hidden');

  if (currentStep === 3) {
    updateWizardSummary();
  }
}

function updateWizardSummary() {
  const cfg = readConnForm();
  const summaryBox = $('#wizard-summary-box');
  if (!summaryBox) return;

  const dbIcon = { mongodb: '🍃', mysql: '🐬', postgresql: '🐘', postgres: '🐘' }[cfg.dbType] || '🗄';
  const dbTypeName = { mongodb: 'MongoDB', mysql: 'MySQL', postgresql: 'PostgreSQL', postgres: 'PostgreSQL' }[cfg.dbType] || cfg.dbType;

  let html = `<div><strong>${dbIcon} ${dbTypeName}</strong> — `;
  if (cfg.uri) {
    html += `URI: <code>${cfg.uri}</code>`;
  } else {
    html += `Host: <strong>${cfg.host || 'localhost'}:${cfg.port || ''}</strong>`;
    if (cfg.username) html += ` | User: <strong>${cfg.username}</strong>`;
    if (cfg.database) html += ` | DB: <strong>${cfg.database}</strong>`;
    if (cfg.authSource) html += ` | Auth: <strong>${cfg.authSource}</strong>`;
  }
  if (cfg.ssh === 'true') {
    html += `<br>🔒 <strong>Tunnel SSH attivo</strong>: <code>${cfg.sshUser || 'user'}@${cfg.sshHost || 'bastion'}:${cfg.sshPort || '22'}</code>`;
  }
  html += `</div>`;
  summaryBox.innerHTML = html;
}

function selectConnTab(name) {
  document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#tab-fields').classList.toggle('hidden', name !== 'fields');
  $('#tab-uri').classList.toggle('hidden', name !== 'uri');
}

export function syncConnForm() {
  const form = $('#connect-form');
  const type = form.elements.dbType.value;
  const isSql = type === 'mysql' || type === 'postgresql' || type === 'postgres';
  const sshOn = form.elements.ssh.checked;

  $('#row-authsource').classList.toggle('hidden', isSql);
  $('#row-database').classList.toggle('hidden', !isSql);

  const sshBadge = $('#wizard-badge-ssh');
  if (sshBadge) sshBadge.classList.toggle('disabled', !sshOn);

  $('#tab-uri-btn').classList.toggle('hidden', isSql || sshOn);

  if ((isSql || sshOn) && !$('#tab-uri').classList.contains('hidden')) {
    selectConnTab('fields');
  }

  const port = form.elements.port;
  if (type === 'postgresql' || type === 'postgres') {
    if (port.value === '27017' || port.value === '3306') port.value = '5432';
  } else if (type === 'mysql') {
    if (port.value === '27017' || port.value === '5432') port.value = '3306';
  } else {
    if (port.value === '3306' || port.value === '5432') port.value = '27017';
  }
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
  if (!usingUri) {
    if (isSql) cfg.database = form.elements.database.value;
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
    // Impronta della host key: non è un segreto, viaggia in chiaro col resto
    // della configurazione ed è registrata al primo collegamento riuscito.
    cfg.sshHostKey = form.elements.sshHostKey.value.trim();
    cfg.sshPassphrase = form.elements.sshPassphrase.value;
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
const CAMPI_SEGRETI = ['password', 'sshPassword', 'sshPassphrase'];

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

export function connectAndOpenTab(cfg) {
  const current = activeTab();
  const reuse = current && !current.state.connected ? current : null;
  const tabId = reuse ? reuse.id : safeUUID();
  saveWorkspaceInputs(); // snapshot del tab che (forse) si lascia
  return new Promise((resolve, reject) => {
    socket.emit('mongo:connect', { ...cfg, tabId }, (res) =>
      res.ok ? resolve(res) : reject(new Error(res.error))
    );
  }).then((res) => {
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
    tab.connCfg = senzaSegreti(cfg);
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
    if (cfg.saveAs) loadSavedConnections();
    return res;
  });
}

export function startEditConn(name) {
  emit('connections:get', { name }).then((res) => {
    const f = res.fields;
    const form = $('#connect-form');
    const dbType = f.dbType || 'mongodb';
    const isSql = dbType === 'mysql' || dbType === 'postgresql' || dbType.includes('postgres');
    const defaultPort = dbType === 'mysql' ? '3306' : (dbType.includes('postgres') ? '5432' : '27017');
    form.elements.dbType.value = dbType;
    selectConnTab(f.uri && !isSql ? 'uri' : 'fields');
    form.elements.uri.value = f.uri || '';
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
    form.elements.sshUser.value = f.sshUser || '';
    form.elements.sshPassword.value = '';
    form.elements.sshPassword.placeholder = res.hasSshPassword ? '(invariata se lasciata vuota)' : '(vuoto se usi una chiave)';
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
    $('#conn-save-btn').classList.remove('hidden');
    $('#connect-error').classList.add('hidden');
    $('#connect-test-msg').classList.add('hidden');
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

  $('#conn-dbtype').addEventListener('change', syncConnForm);
  $('#conn-ssh-toggle').addEventListener('change', syncConnForm);

  $('#conn-test-btn')?.addEventListener('click', () => {
    const cfg = readConnForm();
    const btn = $('#conn-test-btn');
    btn.disabled = true;
    btn.textContent = 'Verifica…';
    $('#connect-error').classList.add('hidden');
    $('#connect-test-msg').classList.add('hidden');

    emit('connections:test', cfg)
      .then((res) => {
        btn.disabled = false;
        btn.textContent = '⚡ Testa Connessione';
        const msg = $('#connect-test-msg');
        msg.textContent = `✓ Connessione riuscita! (${res.dbType.toUpperCase()}, ${res.databases} DB trovati)`;
        msg.classList.remove('hidden');
      })
      .catch((err) => {
        btn.disabled = false;
        btn.textContent = '⚡ Testa Connessione';
        const errorEl = $('#connect-error');
        errorEl.textContent = `Errore di connessione: ${err.message}`;
        errorEl.classList.remove('hidden');
      });
  });

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
    emit('connections:export', { passphrase }).then((res) => {
      const blob = new Blob([res.ini], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'connections.ini';
      a.click();
      URL.revokeObjectURL(a.href);
      closeModal('connexport-overlay');
      toast(passphrase
        ? 'Connessioni esportate (segreti cifrati con la passphrase indicata)'
        : 'Connessioni esportate (segreti cifrati)');
    }).catch((err) => showError('#connexport-error', err.message));
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
