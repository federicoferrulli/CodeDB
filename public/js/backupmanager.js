'use strict';

import { state } from './state.js';
import { $, emit, toast, openModal, closeModal, esc, fmtBytes, iniziaCaricamento } from './utils.js';
import { activeTab } from './tabs.js';
import { socket } from './socket.js';
import { refreshDbTree } from './dbtree.js';
import { segnaTraguardo } from './onboarding-stato.js';

let currentTabMode = 'new'; // 'new' | 'catalog'

// Ultimo catalogo letto dal server e gruppi con lo storico aperto: il filtro
// ridisegna dai dati già in mano invece di richiedere di nuovo l'elenco.
let catalogoGruppi = {};
const storiciAperti = new Set();

// Sotto questa soglia il campo di filtro sarebbe solo un controllo in più da
// leggere: con tre gruppi si trova a occhio.
const MIN_GRUPPI_PER_FILTRO = 4;

export function initBackupManager() {
  const btnOpen = $('#btn-backup-manager');
  if (btnOpen) btnOpen.addEventListener('click', () => openBackupModal());

  const btnClose = $('#btn-close-backup-modal');
  if (btnClose) {
    btnClose.addEventListener('click', () => closeModal('#modal-backup-manager'));
  }

  // Navigazione schede (Nuovo Backup vs Catalogo & Ripristino)
  const tabNew = $('#tab-btn-backup-new');
  const tabCatalog = $('#tab-btn-backup-catalog');
  if (tabNew && tabCatalog) {
    tabNew.addEventListener('click', () => switchBackupTab('new'));
    tabCatalog.addEventListener('click', () => switchBackupTab('catalog'));
  }

  // Form invio backup
  const formBackup = $('#form-run-backup');
  if (formBackup) {
    formBackup.addEventListener('submit', async (e) => {
      e.preventDefault();
      await executeBackup();
    });
  }

  // Refresh catalogo
  const btnRefresh = $('#btn-refresh-backups');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      // Il catalogo ha già il suo segnaposto nella lista, ma il pulsante deve
      // dire che il clic è arrivato — ed è quello che si ripreme.
      const fine = iniziaCaricamento(btnRefresh, '');
      fetchBackupCatalog().finally(fine);
    });
  }

  const filtro = $('#backup-catalog-filter');
  if (filtro) filtro.addEventListener('input', () => renderCatalogo());

  // Avanzamento del ripristino. L'evento porta il tabId della sessione che sta
  // ripristinando: i push di un altro tab non devono scrivere in questo pannello,
  // che è unico come tutto il resto del workspace.
  if (socket) {
    socket.on('backup:progress', (ev) => {
      const tab = activeTab();
      if (!tab || (ev.tabId && ev.tabId !== tab.id)) return;
      aggiungiRigaProgresso(ev.riga, ev.errore);
    });
  }
}

/* ---------- Pannello di avanzamento del ripristino ---------- */

const MAX_RIGHE_PROGRESSO = 200;

function apriProgresso(titolo) {
  const box = $('#restore-progress');
  if (!box) return;
  $('#restore-progress-title').textContent = titolo;
  $('#restore-progress-log').innerHTML = '';
  box.classList.remove('hidden', 'esito-ok', 'esito-ko');
}

function aggiungiRigaProgresso(riga, errore) {
  const log = $('#restore-progress-log');
  if (!log || $('#restore-progress').classList.contains('hidden')) return;
  const div = document.createElement('div');
  div.className = errore ? 'riga-ko' : '';
  div.textContent = riga;
  log.appendChild(div);
  // Un ripristino selettivo su decine di tabelle produce centinaia di righe:
  // le più vecchie non le rilegge nessuno e il DOM non deve crescere all'infinito.
  while (log.children.length > MAX_RIGHE_PROGRESSO) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function chiudiProgresso(titolo, ok) {
  const box = $('#restore-progress');
  if (!box) return;
  $('#restore-progress-title').textContent = titolo;
  box.classList.add(ok ? 'esito-ok' : 'esito-ko');
}

export function openBackupModal() {
  populateDatabaseDropdown();
  openModal('#modal-backup-manager');
  switchBackupTab('new');
  fetchBackupCatalog();
}

function switchBackupTab(mode) {
  currentTabMode = mode;
  const tabNew = $('#tab-btn-backup-new');
  const tabCatalog = $('#tab-btn-backup-catalog');
  const secNew = $('#section-backup-new');
  const secCatalog = $('#section-backup-catalog');

  if (mode === 'new') {
    tabNew.classList.add('active');
    tabCatalog.classList.remove('active');
    secNew.classList.remove('hidden');
    secCatalog.classList.add('hidden');
  } else {
    tabCatalog.classList.add('active');
    tabNew.classList.remove('active');
    secCatalog.classList.remove('hidden');
    secNew.classList.add('hidden');
    fetchBackupCatalog();
  }
}

function populateDatabaseDropdown() {
  const select = $('#backup-db');
  if (!select) return;
  select.innerHTML = '';

  const tab = activeTab();
  const dbs = tab && tab.databases ? tab.databases : (state.databases || []);
  if (!dbs.length && tab && tab.db) dbs.push({ name: tab.db });

  if (!dbs.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- Connettiti prima a un database --';
    select.appendChild(opt);
    return;
  }

  dbs.forEach((d) => {
    const dbName = typeof d === 'string' ? d : d.name;
    const opt = document.createElement('option');
    opt.value = dbName;
    opt.textContent = dbName;
    if (tab && tab.db === dbName) opt.selected = true;
    select.appendChild(opt);
  });
}

async function executeBackup() {
  const tab = activeTab();
  if (!tab || !tab.dbType) {
    toast('Nessuna connessione attiva. Connettiti a un database.', true);
    return;
  }

  const db = $('#backup-db').value;
  if (!db) {
    toast('Seleziona un database su cui effettuare il backup.', true);
    return;
  }

  const type = $('#backup-type').value;
  const collections = $('#backup-collections').value.trim();
  const sinceField = $('#backup-since').value.trim();
  const noCompress = $('#backup-no-compress').checked;
  const compressLevel = parseInt($('#backup-compress-level').value, 10) || 6;
  const storage = $('#backup-storage').value.trim();
  const slackWebhook = $('#backup-slack').value.trim();

  const btnSubmit = $('#btn-submit-backup');
  const statusEl = $('#backup-status-msg');
  // Un backup dura da secondi a minuti: senza segnale sul pulsante l'unico
  // indizio è la riga di stato sotto, che si legge solo se la si sta cercando.
  const fineCaricamento = iniziaCaricamento(btnSubmit, 'Backup in corso…');
  if (statusEl) {
    statusEl.classList.remove('hidden', 'error');
    statusEl.textContent = `Esecuzione del backup (${type}) in corso...`;
  }

  try {
    const res = await emit('backup:run', {
      db,
      type,
      collections: collections || undefined,
      sinceField: sinceField || undefined,
      noCompress,
      compressLevel,
      storage: storage || undefined,
      slackWebhook: slackWebhook || undefined,
      connName: tab.label || tab.savedName || 'UI Session',
    });

    toast(`✅ Backup completato con successo: ${res.summary.id}`);
    segnaTraguardo('backup'); // primi passi della guida (no-op se già fatto)
    if (statusEl) {
      statusEl.textContent = `✅ Backup completato: ${res.summary.totalDocs} elementi salvati (${fmtBytes(res.summary.totalBytes)}).`;
    }
    setTimeout(() => {
      switchBackupTab('catalog');
    }, 1200);
  } catch (err) {
    toast(`❌ Backup fallito: ${err.message}`, true);
    if (statusEl) {
      statusEl.classList.add('error');
      statusEl.textContent = `Errore: ${err.message}`;
    }
  } finally {
    fineCaricamento();
  }
}

async function fetchBackupCatalog() {
  const container = $('#backup-catalog-list');
  if (!container) return;

  container.innerHTML = '<div class="loading-spinner">Caricamento catalogo backup in corso...</div>';

  try {
    const res = await emit('backup:list', {});
    catalogoGruppi = res.groups || {};
    renderCatalogo();
  } catch (err) {
    catalogoGruppi = {};
    container.innerHTML = `<div class="error-box">Errore nel caricamento del catalogo: ${esc(err.message)}</div>`;
  }
}

/**
 * Disegna il catalogo secondo la legge di Pareto: nel pannello di ripristino
 * il gesto che si compie quasi sempre è UNO — riportare l'**ultimo** backup di
 * un gruppo — mentre risalire a una copia di tre settimane fa è l'eccezione.
 * Prima erano indistinguibili: ogni backup una riga identica alle altre, con
 * "Verifica" e "Ripristina" allo stesso peso, e su un server che fa una copia
 * al giorno la riga che serve stava in fondo a un muro di trenta righe uguali.
 * Ora ogni gruppo mostra il suo ultimo backup con l'unica azione primaria, e lo
 * storico sta dietro un "Altri N backup" chiuso: resta a un clic, ma non occupa
 * più lo schermo di chi non lo sta cercando.
 */
function renderCatalogo() {
  const container = $('#backup-catalog-list');
  if (!container) return;

  const nomi = Object.keys(catalogoGruppi).sort((a, b) => a.localeCompare(b));

  // Il filtro compare solo quando c'è davvero qualcosa da filtrare.
  const campoFiltro = $('#backup-catalog-filter');
  const hint = $('#backup-catalog-hint');
  const filtroUtile = nomi.length >= MIN_GRUPPI_PER_FILTRO;
  if (campoFiltro) campoFiltro.classList.toggle('hidden', !filtroUtile);
  if (hint) hint.classList.toggle('hidden', filtroUtile);
  const q = (filtroUtile && campoFiltro ? campoFiltro.value : '').trim().toLowerCase();

  if (!nomi.length) {
    container.innerHTML = '<div class="empty-state">Nessun backup trovato nella cartella del server.</div>';
    return;
  }

  const visibili = nomi.filter((g) => {
    if (!q) return true;
    const db = (catalogoGruppi[g][0] || {}).db || '';
    return g.toLowerCase().includes(q) || String(db).toLowerCase().includes(q);
  });

  if (!visibili.length) {
    container.innerHTML = `<div class="empty-state">Nessun gruppo corrisponde a "${esc(q)}".</div>`;
    return;
  }

  // I gruppi della connessione aperta vengono PRIMA e sono marcati. Il
  // ripristino scrive sulla connessione attiva (CDB-60), quindi in un elenco
  // alfabetico il backup di "produzione" sta accanto a quello di "collaudo"
  // mentre si è connessi a uno dei due, con lo stesso identico aspetto: la
  // distinzione che conta non era rappresentata da nulla.
  const conn = connessioneAttiva();
  const miei = visibili.filter((g) => gruppoDellaConnessione(g, conn));
  const altri = visibili.filter((g) => !gruppoDellaConnessione(g, conn));

  let html = miei.map((g) => schedaGruppo(g, false)).join('');
  if (altri.length) {
    if (miei.length || conn) {
      html += `<div class="backup-altri-sep">Backup di altre connessioni${conn ? ` (sei connesso a <strong>${esc(conn)}</strong>)` : ''}</div>`;
    }
    html += altri.map((g) => schedaGruppo(g, Boolean(conn))).join('');
  }
  container.innerHTML = html;

  container.querySelectorAll('.btn-verify-backup').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const g = e.currentTarget.getAttribute('data-group');
      const id = e.currentTarget.getAttribute('data-id');
      verifyBackupIntegrity(g, id, e.currentTarget);
    });
  });

  container.querySelectorAll('.btn-restore-backup').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const g = e.currentTarget.getAttribute('data-group');
      const id = e.currentTarget.getAttribute('data-id');
      const origDb = e.currentTarget.getAttribute('data-db');
      promptRestoreBackup(g, id, origDb, e.currentTarget);
    });
  });

  container.querySelectorAll('.backup-history-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const g = e.currentTarget.getAttribute('data-group');
      if (storiciAperti.has(g)) storiciAperti.delete(g);
      else storiciAperti.add(g);
      renderCatalogo();
    });
  });
}

function schedaGruppo(gName, estranea) {
  // Il catalogo è in ordine di scrittura, ma l'ordine dei backup è l'unica cosa
  // su cui questa vista si regge: lo si impone invece di darlo per buono.
  const list = catalogoGruppi[gName].slice().sort(
    (a, b) => String(b.startedAt || b.id).localeCompare(String(a.startedAt || a.id))
  );
  const ultimo = list[0];
  const storico = list.slice(1);
  const aperto = storiciAperti.has(gName);

  const testata = `
    <div class="backup-group-title">
      📂 <strong>${esc(gName)}</strong>
      <span class="sub-text">${esc(ultimo.db || '')} (${esc(ultimo.dbType || '')}) · ${list.length} backup</span>
    </div>`;

  const evidenza = `
    <div class="backup-latest">
      <div class="backup-latest-info">
        ${badgeTipo(ultimo)}
        <span class="backup-latest-when" title="${esc(ultimo.startedAt || '')}">${esc(daQuando(ultimo.startedAt))}</span>
        <span class="backup-id">${esc(ultimo.id)}</span>
        ${notaCatena(gName, ultimo)}
      </div>
      <div class="backup-actions">
        <button class="btn btn-sm btn-ghost btn-verify-backup" data-group="${esc(gName)}" data-id="${esc(ultimo.id)}">🔍 Verifica</button>
        ${bottoneRipristino(gName, ultimo, 'btn-primary')}
      </div>
    </div>
    <div id="${idVerifica(gName, ultimo.id)}" class="verify-result-cell ${esitoDi(gName, ultimo.id) ? '' : 'hidden'}">${esitoDi(gName, ultimo.id)}</div>`;

  const cls = `backup-group-card${estranea ? ' backup-group-estranea' : ''}`;
  if (!storico.length) {
    return `<div class="${cls}">${testata}${evidenza}</div>`;
  }

  const righe = storico.map((b) => `
    <tr data-group="${esc(gName)}" data-id="${esc(b.id)}">
      <td>
        <div class="backup-id">${esc(b.id)}</div>
        <div class="backup-date">${esc(daQuando(b.startedAt))} · ${esc(b.startedAt || '')}</div>
      </td>
      <td>${badgeTipo(b)}${notaCatena(gName, b)}</td>
      <td class="backup-actions">
        <button class="btn btn-sm btn-ghost btn-verify-backup" data-group="${esc(gName)}" data-id="${esc(b.id)}">🔍 Verifica</button>
        ${bottoneRipristino(gName, b, 'btn-secondary')}
      </td>
    </tr>
    <tr class="verify-result-row ${esitoDi(gName, b.id) ? '' : 'hidden'}">
      <td colspan="3" id="${idVerifica(gName, b.id)}" class="verify-result-cell">${esitoDi(gName, b.id)}</td>
    </tr>
  `).join('');

  return `
    <div class="${cls}">
      ${testata}
      ${evidenza}
      <button type="button" class="backup-history-toggle" data-group="${esc(gName)}" aria-expanded="${aperto}">
        ${aperto ? '▾' : '▸'} Altri ${storico.length} backup
      </button>
      <div class="backup-history ${aperto ? '' : 'hidden'}">
        <table class="backup-table">
          <thead><tr><th>ID / Data</th><th>Tipo</th><th>Azioni</th></tr></thead>
          <tbody>${righe}</tbody>
        </table>
      </div>
    </div>`;
}

function badgeTipo(b) {
  const tipo = String(b.type || '');
  const cls = tipo === 'full' ? 'badge-full' : (tipo === 'incremental' ? 'badge-inc' : 'badge-diff');
  return `<span class="backup-badge ${cls}">${esc(tipo.toUpperCase())}</span>`;
}

function notaCatena(gName, b) {
  const catena = analizzaCatena(gName, b);
  if (catena.rotta) {
    return `<span class="backup-chain rotta" title="${esc(catena.motivo)}">⚠ catena incompleta</span>`;
  }
  if (catena.layer <= 1) return '';
  return `<span class="backup-chain" title="Il ripristino applica in ordine ${catena.layer} backup, dal full fino a questo.">🔗 catena di ${catena.layer}</span>`;
}

function bottoneRipristino(gName, b, classe) {
  const catena = analizzaCatena(gName, b);
  const attr = `data-group="${esc(gName)}" data-id="${esc(b.id)}" data-db="${esc(b.db || '')}"`;
  if (catena.rotta) {
    // Meglio negare qui che a metà scrittura: `risolviCatena` in
    // backup/lib/restore.js scopre l'anello mancante DOPO la conferma, con il
    // ripristino già avviato. Il catalogo che il client ha già in mano contiene
    // id e baseId di ogni voce, quindi la stessa catena si ricostruisce prima
    // del clic.
    return `<button class="btn btn-sm ${classe}" disabled title="${esc(catena.motivo)}">⚡ Ripristina</button>`;
  }
  return `<button class="btn btn-sm ${classe} btn-restore-backup" ${attr}>⚡ Ripristina</button>`;
}

/**
 * Ricostruisce la catena di un backup risalendo i `baseId` fino al full, come
 * fa `risolviCatena()` lato server ma sui dati del catalogo: ritorna quanti
 * backup verranno applicati e, se un anello manca, quale.
 */
function analizzaCatena(gName, b) {
  const perId = new Map((catalogoGruppi[gName] || []).map((x) => [x.id, x]));
  const visti = new Set();
  let cur = b;
  let layer = 1;
  for (;;) {
    if (String(cur.type) === 'full') return { layer, rotta: false };
    if (visti.has(cur.id)) {
      return { layer, rotta: true, motivo: `Catena circolare nel gruppo ${gName}: controlla i baseId dei manifest.` };
    }
    visti.add(cur.id);
    const base = cur.baseId;
    if (!base) {
      return { layer, rotta: true, motivo: `Il backup ${cur.id} è ${cur.type} ma non dichiara un backup di base.` };
    }
    const prossimo = perId.get(base);
    if (!prossimo) {
      return { layer, rotta: true, motivo: `Catena incompleta: manca il backup di base "${base}", richiesto da ${cur.id}.` };
    }
    cur = prossimo;
    layer += 1;
  }
}

function connessioneAttiva() {
  const tab = activeTab();
  if (!tab) return null;
  return tab.label || tab.savedName || null;
}

/**
 * Il nome della cartella di gruppo è `safeName(connessione)_safeName(db)`
 * (`backup/lib/engine.js`), quindi porta con sé la connessione d'origine. La
 * regola di `safeName` è duplicata qui: se un giorno divergesse, il gruppo
 * smetterebbe di essere riconosciuto come "della connessione aperta" e si
 * tornerebbe all'elenco alfabetico di prima — nessun ripristino cambierebbe
 * bersaglio, che resta comunque la connessione attiva.
 */
const safeName = (s) => String(s).replace(/[^\w.-]+/g, '_');

function gruppoDellaConnessione(gName, conn) {
  if (!conn) return false;
  const primo = (catalogoGruppi[gName] || [])[0] || {};
  return gName === `${safeName(conn)}_${safeName(primo.db || '')}`;
}

const idVerifica = (group, backupId) => `verify-res-${group}-${backupId}`;

// Gli esiti delle verifiche sopravvivono al ridisegno: aprire lo storico di un
// gruppo ricostruisce l'intero catalogo, e senza questa memoria cancellerebbe
// il risultato di un checksum appena calcolato altrove.
const esitiVerifica = new Map();
const chiaveVerifica = (group, backupId) => `${group}\u0000${backupId}`;
const esitoDi = (group, backupId) => esitiVerifica.get(chiaveVerifica(group, backupId)) || '';

/**
 * "2 ore fa" invece di "20260807T101500Z": la domanda che ci si pone davanti a
 * un catalogo è quanto è VECCHIA la copia, e un timestamp compatto va convertito
 * a mente. La data esatta resta, nel `title` e nello storico.
 */
function daQuando(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = Date.now() - t;
  if (d < 0 || d < 60000) return 'pochi istanti fa';
  if (d < 3600000) { const n = Math.round(d / 60000); return `${n} minut${n === 1 ? 'o' : 'i'} fa`; }
  if (d < 86400000) { const n = Math.round(d / 3600000); return `${n} or${n === 1 ? 'a' : 'e'} fa`; }
  const n = Math.round(d / 86400000);
  return `${n} giorn${n === 1 ? 'o' : 'i'} fa`;
}

async function verifyBackupIntegrity(group, backupId, bottone) {
  const cell = document.getElementById(idVerifica(group, backupId));
  if (!cell) return;

  cell.classList.remove('hidden');
  const row = cell.closest('.verify-result-row');
  if (row) row.classList.remove('hidden');
  cell.innerHTML = '<em>Calcolo checksum SHA-256 in corso...</em>';

  const fineCaricamento = iniziaCaricamento(bottone, '');
  let esito;
  try {
    const res = await emit('backup:verify', { group, backupId });
    if (res.valid) {
      esito = `<div class="status-pass">✅ Verifica SHA-256 SUPERATA: tutti i ${res.okCount} file di dati sono integri.</div>`;
    } else {
      const detailsHtml = res.details.map(d => `<li>${esc(d.file)}: <strong>${esc(d.status)}</strong></li>`).join('');
      esito = `<div class="status-fail">❌ Verifica FALLITA: ${res.failedCount} file corrotti o mancanti su ${res.okCount + res.failedCount}.<ul>${detailsHtml}</ul></div>`;
    }
  } catch (err) {
    esito = `<div class="status-fail">Errore durante la verifica: ${esc(err.message)}</div>`;
  } finally {
    fineCaricamento();
  }
  esitiVerifica.set(chiaveVerifica(group, backupId), esito);
  cell.innerHTML = esito;
}

async function promptRestoreBackup(group, backupId, origDb, bottone) {
  // Il ripristino scrive sulla CONNESSIONE ATTIVA, non su quella da cui il
  // backup è stato preso (CDB-60): il pannello elenca i backup di tutti i
  // gruppi, quindi si può benissimo star guardando il backup di "produzione"
  // mentre si è connessi a "collaudo" — o viceversa. Prima nulla lo diceva e la
  // sola domanda era il nome del database: un ripristino sull'ambiente sbagliato
  // era a un clic di distanza. Ora la destinazione è scritta nella conferma.
  const tab = activeTab();
  if (!tab || !tab.dbType) {
    toast('Connettiti prima a un database: il ripristino scrive sulla connessione attiva.', true);
    return;
  }
  const conn = tab.label || tab.savedName || 'connessione attiva';

  const voce = (catalogoGruppi[group] || []).find((b) => b.id === backupId) || { id: backupId, type: 'full' };
  const catena = analizzaCatena(group, voce);
  if (catena.rotta) {
    // Il pulsante è già disabilitato, ma il ripristino può arrivare qui anche
    // da un catalogo diventato obsoleto tra il disegno e il clic.
    toast(catena.motivo, true);
    return;
  }

  // Una sola domanda al posto di tre: destinazione già compilata col database
  // d'origine e DROP spento sono le risposte dell'80% dei ripristini, e restano
  // entrambe visibili insieme alla connessione su cui si scriverà.
  const scelta = await chiediRipristino({
    backupId,
    conn,
    dbSuggerito: origDb || '',
    layer: catena.layer,
    gruppoEstraneo: gruppoDellaConnessione(group, conn) ? null : group,
  });
  if (!scelta) return;

  executeRestore(group, backupId, scelta.targetDb, scelta.drop, bottone);
}

/**
 * Modale di conferma del ripristino. Risolve con `{ targetDb, drop }` oppure
 * `null` se si annulla — stesso contratto di `chiediTesto()`, di cui condivide
 * anche il motivo di esistere: `confirm()`/`prompt()` in fila non possono
 * mostrare insieme destinazione e opzioni, e in Electron `prompt()` non c'è.
 */
function chiediRipristino({ backupId, conn, dbSuggerito, layer = 1, gruppoEstraneo = null }) {
  const overlay = $('#restore-overlay');
  if (!overlay) return Promise.resolve(null);

  $('#restore-subtitle').textContent = 'I dati esistenti in destinazione verranno sovrascritti.';
  $('#restore-backup-id').textContent = backupId;
  $('#restore-conn').textContent = conn;

  // Un incrementale non si applica da solo: il ripristino risale al full e
  // riapplica tutti i layer. Dirlo qui evita la sorpresa di un'operazione molto
  // più lunga (e più ampia) di quella che si crede di aver chiesto.
  const chainRow = $('#restore-chain-row');
  chainRow.classList.toggle('hidden', layer <= 1);
  $('#restore-chain').textContent = layer > 1 ? `${layer} (dal full fino a questo)` : '';

  const warn = $('#restore-warning');
  warn.classList.toggle('hidden', !gruppoEstraneo);
  warn.innerHTML = gruppoEstraneo
    ? `⚠️ Questo backup viene dal gruppo <strong>${esc(gruppoEstraneo)}</strong>, non dalla connessione aperta: verrà comunque scritto su <strong>${esc(conn)}</strong>.`
    : '';

  const input = $('#restore-target-db');
  const drop = $('#restore-drop');
  input.value = dbSuggerito;
  drop.checked = false;

  const ok = $('#restore-ok');
  const cancel = $('#restore-cancel');

  return new Promise((resolve) => {
    let chiuso = false;
    const finish = (res) => {
      if (chiuso) return;
      chiuso = true;
      document.removeEventListener('keydown', onEsc, true);
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onEnter);
      closeModal(overlay);
      resolve(res);
    };
    const onOk = () => {
      const targetDb = input.value.trim();
      if (!targetDb) {
        // Prima si ricadeva in silenzio sul database del backup: se il campo
        // viene svuotato, di solito è perché si sta ripensandoci.
        toast('Indica il database di destinazione.', true);
        input.focus();
        return;
      }
      finish({ targetDb, drop: drop.checked });
    };
    const onCancel = () => finish(null);
    const onEnter = (e) => { if (e.key === 'Enter') { e.preventDefault(); onOk(); } };
    const onEsc = (e) => { if (e.key === 'Escape') finish(null); };

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', onEnter);
    document.addEventListener('keydown', onEsc, true);
    openModal(overlay);
    input.focus();
    input.select();
  });
}

async function executeRestore(group, backupId, targetDb, drop, bottone) {
  const tab = activeTab();
  if (!tab || !tab.dbType) {
    toast('Connettiti prima a un database per eseguire il ripristino.', true);
    return;
  }

  toast(`Ripristino di ${backupId} su "${targetDb}" in corso...`);
  apriProgresso(`⏳ Ripristino di ${backupId} su "${targetDb}" in corso…`);
  const fineCaricamento = iniziaCaricamento(bottone, '');
  try {
    const res = await emit('backup:restore', {
      group,
      backupId,
      targetDb,
      drop,
      connName: tab.label || tab.savedName || 'UI Session',
    });

    const msg = `✅ Ripristino completato su "${res.summary.targetDb}": ${res.summary.totalDocs} elementi ripristinati da ${res.summary.layers} layer!`;
    toast(msg);
    chiudiProgresso(msg, true);
    // Un ripristino crea collection e tabelle che nell'albero non ci sono: senza
    // questa ricarica la sidebar continua a mostrare lo schema di prima, e
    // l'unico modo di vedere i dati appena riportati è ricaricare la pagina.
    refreshDbTree();
  } catch (err) {
    toast(`❌ Ripristino fallito: ${err.message}`, true);
    chiudiProgresso(`❌ Ripristino fallito: ${err.message}`, false);
    // Anche un ripristino fallito può aver applicato una parte dei layer: lo
    // schema a sinistra va riletto comunque, non è più quello di prima.
    refreshDbTree();
  } finally {
    fineCaricamento();
  }
}
