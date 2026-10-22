import { mountArcControls, closeNavigationSheet, renderDataEmpty } from '../arc/ui.js';
'use strict';

import { state } from './state.js';
import { $, emit, toast, openModal, closeModal, esc, fmtBytes, iniziaCaricamento, captureContext, refreshLucideIcons, safeUUID, dbTypeIcon } from './utils.js';
import { activeTab, tabs, onTabChange } from './tabs.js';
import { preparaTransizioneTab } from './tab-motion.js';
import { socket } from './socket.js';
import { refreshDbTree } from './dbtree.js';
import { segnaTraguardo } from './onboarding-stato.js';

let currentTabMode = 'new'; // 'new' | 'catalog'
const ripristini = new Map();
let backupAttivo = null;

// Ultimo catalogo letto dal server e gruppi con lo storico aperto: il filtro
// ridisegna dai dati già in mano invece di richiedere di nuovo l'elenco.
let catalogoGruppi = {};
const storiciAperti = new Set();
const movimentoRidotto = window.matchMedia('(prefers-reduced-motion: reduce)');
let richiestaCatalogo = 0;
let catalogoCaricato = false;
let fineCaricamentoCatalogo = null;
let origineSelezione = '';
let richiestaCollezioni = 0;
let elencoCaricato = false;
const collezioniSelezionate = new Set();

// Sotto questa soglia il campo di filtro sarebbe solo un controllo in più da
// leggere: con tre gruppi si trova a occhio.
const MIN_GRUPPI_PER_FILTRO = 4;

export function initBackupManager() {
  $('#btn-background-backup').addEventListener('click', () => closeModal('#modal-backup-manager'));
  $('#btn-cancel-backup').addEventListener('click', async () => {
    const backup = backupAttivo;
    if (!backup) return;
    const fine = iniziaCaricamento($('#btn-cancel-backup'), 'Annullamento…');
    try {
      const res = await emit('backup:cancel', { tabId: backup.tabId, operationId: backup.id });
      if (backupAttivo === backup && res.cancelled) $('#backup-status-msg').textContent = 'Annullamento del backup e pulizia dei file parziali…';
    } catch (err) { toast(`Annullamento non riuscito: ${err.message}`, true); }
    finally { fine(); }
  });
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
    $('.backup-tabs').addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const mode = e.key === 'Home' ? 'new' : e.key === 'End' ? 'catalog' : currentTabMode === 'new' ? 'catalog' : 'new';
      switchBackupTab(mode);
      $(`#tab-btn-backup-${mode}`).focus();
    });
  }

  // Form invio backup
  const formBackup = $('#form-run-backup');
  if (formBackup) {
    formBackup.addEventListener('input', aggiornaRiepilogoBackup);
    formBackup.addEventListener('change', aggiornaRiepilogoBackup);
    formBackup.addEventListener('invalid', e => {
      const details = e.target.closest('details');
      if (details) details.open = true;
    }, true);
    formBackup.addEventListener('submit', async (e) => {
      e.preventDefault();
      await executeBackup();
    });
  }

  $('#backup-db').addEventListener('change', () => caricaCollezioniBackup());
  $('#backup-scope-search').addEventListener('input', filtraCollezioniBackup);
  $('#backup-scope-retry').addEventListener('click', () => caricaCollezioniBackup());
  $('#backup-scope-list').addEventListener('change', e => {
    if (!e.target.matches('input[type="checkbox"]')) return;
    if (e.target.checked) collezioniSelezionate.add(e.target.value);
    else collezioniSelezionate.delete(e.target.value);
    aggiornaSelezioneBackup();
  });
  $('#backup-scope-clear').addEventListener('click', () => {
    collezioniSelezionate.clear();
    $('#backup-scope-list').querySelectorAll('input').forEach(input => { input.checked = false; });
    aggiornaSelezioneBackup();
  });
  $('#backup-collections').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'backup-scope-search') e.preventDefault();
    if (e.key !== 'Escape' || !e.currentTarget.open) return;
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.open = false;
    e.currentTarget.querySelector('summary').focus();
  });

  onTabChange(() => {
    if (!$('#modal-backup-manager').classList.contains('hidden')) {
      populateDatabaseDropdown();
      renderCatalogo();
    }
  });
  $('#modal-backup-manager').addEventListener('codedb:dialog-closed', () => {
    $('#modal-backup-manager').getAnimations({ subtree: true }).forEach(a => a.cancel());
  });
  movimentoRidotto.addEventListener('change', () => {
    if (movimentoRidotto.matches) $('#backup-catalog-list').getAnimations({ subtree: true }).filter(a => a.effect?.getTiming().iterations !== Infinity).forEach(a => a.finish());
  });

  // Refresh catalogo
  const btnRefresh = $('#btn-refresh-backups');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', fetchBackupCatalog);
  }

  const filtro = $('#backup-catalog-filter');
  if (filtro) filtro.addEventListener('input', () => renderCatalogo());

  // Avanzamento del ripristino. L'evento porta il tabId della sessione che sta
  // ripristinando: i push di un altro tab non devono scrivere in questo pannello,
  // che è unico come tutto il resto del workspace.
  if (socket) {
    socket.on('backup:progress', (ev) => {
      if (ev.tipo === 'backup') {
        if (!backupAttivo || ev.operationId !== backupAttivo.id || ev.tabId !== backupAttivo.tabId) return;
        const fasi = { preparazione: 'Preparazione', dati: 'Copia dei dati', struttura: 'Struttura e indici',
          verifica: 'Verifica dei conteggi', identita: 'Verifica delle identità', cancellazioni: 'Confronto delle cancellazioni',
          catalogo: 'Salvataggio nel catalogo', oggetti: 'Copia degli oggetti', upload: 'Invio al cloud' };
        $('#backup-status-msg').textContent = `${backupAttivo.label} · ${fasi[ev.phase] || ev.phase}${ev.collection ? ` · ${ev.collection}` : ''}${ev.count ? ` · ${ev.count.toLocaleString('it-IT')} elementi` : ''}. Puoi continuare a lavorare.`;
        return;
      }
      const progresso = ripristini.get(ev.operationId);
      if (!progresso || ev.tabId !== progresso.tabId) return;
      aggiungiRigaProgresso(progresso.log, ev.riga, ev.errore);
    });
  }
}

/* ---------- Pannello di avanzamento del ripristino ---------- */

const MAX_RIGHE_PROGRESSO = 200;

function apriProgresso(titolo, tabId) {
  const box = $('#restore-progress');
  const section = document.createElement('section'); section.className = 'restore-progress';
  const head = document.createElement('div'); head.className = 'restore-progress-head'; head.textContent = titolo;
  const log = document.createElement('div'); log.className = 'restore-progress-log'; log.setAttribute('role', 'log');
  section.append(head, log); box.prepend(section); box.classList.remove('hidden');
  const progresso = { id: safeUUID(), tabId, section, head, log };
  ripristini.set(progresso.id, progresso);
  return progresso;
}

function aggiungiRigaProgresso(log, riga, errore) {
  const div = document.createElement('div');
  div.className = errore ? 'riga-ko' : '';
  div.textContent = riga;
  log.appendChild(div);
  // Un ripristino selettivo su decine di tabelle produce centinaia di righe:
  // le più vecchie non le rilegge nessuno e il DOM non deve crescere all'infinito.
  while (log.children.length > MAX_RIGHE_PROGRESSO) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function chiudiProgresso(progresso, titolo, ok) {
  progresso.head.textContent = titolo;
  progresso.section.classList.add(ok ? 'esito-ok' : 'esito-ko');
  ripristini.delete(progresso.id);
  // Mantiene gli esiti recenti senza rimuovere mai un'attività ancora in corso.
  [...$('#restore-progress').querySelectorAll('.esito-ok, .esito-ko')].slice(10).forEach(el => el.remove());
}

export function openBackupModal() {
  closeNavigationSheet(true);
  populateDatabaseDropdown();
  aggiornaRiepilogoBackup();
  openModal('#modal-backup-manager');
  switchBackupTab(currentTabMode);
}

function switchBackupTab(mode) {
  const cambiata = currentTabMode !== mode;
  const completaTransizione = preparaTransizioneTab($('.backup-tabs'));
  currentTabMode = mode;
  const tabNew = $('#tab-btn-backup-new');
  const tabCatalog = $('#tab-btn-backup-catalog');
  const secNew = $('#section-backup-new');
  const secCatalog = $('#section-backup-catalog');
  for (const button of [tabNew, tabCatalog]) {
    const attiva = button.dataset.tabId === mode;
    button.setAttribute('aria-selected', String(attiva));
    button.tabIndex = attiva ? 0 : -1;
  }
  for (const panel of [secNew, secCatalog]) panel.getAnimations().forEach(a => a.cancel());

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
  completaTransizione();
  if (cambiata && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const panel = mode === 'new' ? secNew : secCatalog;
    const movimento = panel.animate([{ opacity: .5, transform: `translateX(${mode === 'new' ? -8 : 8}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 200, easing: 'cubic-bezier(.16,1,.3,1)' });
    movimento.finished.then(() => movimento.cancel(), () => {});
  }
}

function aggiornaRiepilogoBackup() {
  const type = $('#backup-type').value;
  const descrizioni = {
    full: ['Completo', 'Una copia completa dei dati selezionati.'],
    incremental: ['Incrementale', 'Le modifiche successive all’ultimo backup.'],
    differential: ['Differenziale', 'Le modifiche successive all’ultimo backup completo.'],
  };
  const [nome, descrizione] = descrizioni[type] || descrizioni.full;
  $('#backup-type-hint').textContent = descrizione;
  const senzaCompressione = $('#backup-no-compress').checked;
  $('#backup-compress-level').disabled = senzaCompressione;
  const destinazione = $('#backup-storage').value.trim();
  $('#backup-summary').textContent = `${nome} · ${senzaCompressione ? 'Senza compressione' : `gzip ${$('#backup-compress-level').value}`} · ${destinazione ? `Cloud: ${destinazione}` : 'Sul server'}`;
}

function populateDatabaseDropdown() {
  const select = $('#backup-db');
  if (!select) return;
  const precedente = select.value;
  select.innerHTML = '';

  const tab = activeTab();
  const dbs = [...(tab && tab.databases ? tab.databases : (state.databases || []))];
  $('#backup-source-hint').textContent = tab?.dbType ? `Connessione: ${tab.label || tab.savedName || tab.dbType}` : 'Apri una connessione per scegliere il database.';
  if (!dbs.length && tab && tab.db) dbs.push({ name: tab.db });

  if (!dbs.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- Connettiti prima a un database --';
    select.appendChild(opt);
    caricaCollezioniBackup();
    return;
  }

  dbs.forEach((d) => {
    const dbName = typeof d === 'string' ? d : d.name;
    const opt = document.createElement('option');
    opt.value = dbName;
    opt.textContent = dbName;
    const mantenuta = origineSelezione === JSON.stringify([tab?.id, precedente]);
    if (dbName === (mantenuta ? precedente : tab?.db)) opt.selected = true;
    select.appendChild(opt);
  });
  caricaCollezioniBackup();
}

function aggiornaSelezioneBackup() {
  const nomi = [...collezioniSelezionate];
  const summary = $('#backup-scope-selection');
  summary.textContent = nomi.length === 1 ? nomi[0] : nomi.length ? `${nomi.length} selezionate` : 'Tutto il database';
  summary.title = nomi.join(', ');
  $('#backup-scope-clear').disabled = !nomi.length;
  $('#backup-scope-hint').textContent = nomi.length ? 'Il backup includerà solo le voci selezionate.' : 'Nessuna selezione: includi tutto il database.';
}

function filtraCollezioniBackup() {
  const ricerca = $('#backup-scope-search').value.trim().toLocaleLowerCase();
  let visibili = 0;
  const scelte = $('#backup-scope-list').querySelectorAll('.backup-scope-choice');
  for (const scelta of scelte) {
    scelta.hidden = !scelta.querySelector('input').value.toLocaleLowerCase().includes(ricerca);
    if (!scelta.hidden) visibili++;
  }
  if (elencoCaricato) $('#backup-scope-status').textContent = !scelte.length ? 'Questo database non contiene tabelle o collezioni.' : !visibili ? 'Nessuna corrispondenza. Prova un altro nome.' : '';
}

async function caricaCollezioniBackup() {
  const tab = activeTab(), db = $('#backup-db').value;
  const origine = JSON.stringify([tab?.id, db]);
  if (origine === origineSelezione && elencoCaricato) return;
  const richiesta = ++richiestaCollezioni;
  origineSelezione = origine;
  elencoCaricato = false;
  collezioniSelezionate.clear();
  aggiornaSelezioneBackup();
  $('#backup-scope-list').replaceChildren();
  $('#backup-scope-search').value = '';
  $('#backup-scope-search').disabled = true;
  $('#backup-scope-retry').classList.add('hidden');
  const status = $('#backup-scope-status');
  status.textContent = !tab?.dbType || !db ? 'Scegli prima un database.' : 'Caricamento delle tabelle e collezioni…';
  if (!tab?.dbType || !db) return;
  try {
    const res = await emit('db:collections', { tabId: tab.id, db, includeCounts: false, _bg: true });
    if (richiesta !== richiestaCollezioni) return;
    const nomi = [...new Set(res.collections.map(c => typeof c === 'string' ? c : c.name))].sort((a, b) => a.localeCompare(b));
    $('#backup-scope-list').innerHTML = nomi.map(nome => `<label class="backup-scope-choice"><input type="checkbox" value="${esc(nome)}"><span>${esc(nome)}</span></label>`).join('');
    mountArcControls($('#backup-scope-list'));
    elencoCaricato = true;
    $('#backup-scope-search').disabled = !nomi.length;
    filtraCollezioniBackup();
  } catch (err) {
    if (richiesta !== richiestaCollezioni) return;
    status.textContent = `Impossibile caricare l’elenco: ${err.message}`;
    $('#backup-scope-retry').classList.remove('hidden');
  }
}

async function executeBackup() {
  if (backupAttivo) return;
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
  const collections = [...collezioniSelezionate];
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
  backupAttivo = { id: safeUUID(), tabId: tab.id, label: `${tab.label} / ${db}` };
  $('#btn-background-backup').classList.remove('hidden');
  $('#btn-cancel-backup').classList.remove('hidden');
  if (statusEl) {
    statusEl.classList.remove('hidden', 'error');
    statusEl.textContent = `Backup ${type} di ${tab.label} / ${db} in corso… Chiudere questo pannello non interrompe il backup.`;
  }

  try {
    const res = await emit('backup:run', {
      tabId: tab.id,
      operationId: backupAttivo.id,
      db,
      type,
      collections: collections.length ? collections : undefined,
      sinceField: sinceField || undefined,
      noCompress,
      compressLevel,
      storage: storage || undefined,
      slackWebhook: slackWebhook || undefined,
      connName: tab.label || tab.savedName || 'UI Session',
    });

    if (res.cancelled) {
      const messaggio = res.summary ? 'Invio al cloud annullato. La copia locale completa è conservata nel catalogo.' : 'Backup annullato. I file parziali sono stati rimossi.';
      if (statusEl) statusEl.textContent = messaggio;
      toast(messaggio);
      return;
    }
    toast(`Backup completato con successo: ${res.summary.id}`);
    segnaTraguardo('backup'); // primi passi della guida (no-op se già fatto)
    if (statusEl) {
      statusEl.textContent = `Backup completato di ${tab.label} / ${db}: ${res.summary.totalDocs} elementi salvati (${fmtBytes(res.summary.totalBytes)}).`;
    }
    setTimeout(() => {
      if (!$('#modal-backup-manager').classList.contains('hidden') && activeTab() === tab) switchBackupTab('catalog');
    }, 1200);
  } catch (err) {
    toast(`Backup fallito: ${err.message}`, true);
    if (statusEl) {
      statusEl.classList.add('error');
      statusEl.textContent = `Errore: ${err.message}`;
    }
  } finally {
    backupAttivo = null;
    $('#btn-background-backup').classList.add('hidden');
    $('#btn-cancel-backup').classList.add('hidden');
    fineCaricamento();
  }
}

async function fetchBackupCatalog() {
  const container = $('#backup-catalog-list');
  if (!container) return;
  const richiesta = ++richiestaCatalogo;
  fineCaricamentoCatalogo ||= iniziaCaricamento($('#btn-refresh-backups'), 'Aggiorna');
  $('#backup-catalog-error').classList.add('hidden');
  $('#backup-catalog-status').textContent = 'Caricamento del catalogo…';
  // Le righe restano montate: lo skeleton ne conserva misure, scroll e storici aperti.
  container.setAttribute('aria-busy', 'true');
  container.inert = true;
  if (!container.childElementCount) {
    container.innerHTML = Array.from({ length: 3 }, () => `
      <section class="backup-group-card" aria-hidden="true"><div class="backup-group-main">
        <div class="backup-group-title"><div><strong style="width: 12ch">&nbsp;</strong><span class="backup-group-meta" style="width: 18ch">&nbsp;</span><span class="backup-group-name" style="width: 15ch">&nbsp;</span></div></div>
        <div class="backup-latest-info"><span class="backup-copy-label" style="width: 10ch">&nbsp;</span><span class="backup-copy-date" style="width: 20ch">&nbsp;</span><code class="backup-id" style="width: 24ch">&nbsp;</code></div>
        <div class="backup-actions"><span class="backup-copy-date" style="width: 14ch">&nbsp;</span></div>
      </div></section>`).join('');
  }

  try {
    const res = await emit('backup:list', {});
    if (richiesta !== richiestaCatalogo) return;
    catalogoGruppi = res.groups || {};
    catalogoCaricato = true;
  } catch (err) {
    if (richiesta !== richiestaCatalogo) return;
    const error = $('#backup-catalog-error');
    error.textContent = `Errore nel caricamento del catalogo: ${err.message}`;
    error.classList.remove('hidden');
  } finally {
    if (richiesta === richiestaCatalogo) {
      container.setAttribute('aria-busy', 'false');
      container.inert = false;
      $('#backup-catalog-status').textContent = '';
      if (catalogoCaricato) renderCatalogo();
      else container.replaceChildren();
      fineCaricamentoCatalogo?.();
      fineCaricamentoCatalogo = null;
    }
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
  if (!container || container.getAttribute('aria-busy') === 'true') return;
  renderDataEmpty(container, null);

  const nomi = Object.keys(catalogoGruppi).filter(g => catalogoGruppi[g]?.length).sort((a, b) => a.localeCompare(b));

  // Il filtro compare solo quando c'è davvero qualcosa da filtrare.
  const campoFiltro = $('#backup-catalog-filter');
  const hint = $('#backup-catalog-hint');
  const filtroUtile = nomi.length >= MIN_GRUPPI_PER_FILTRO;
  if (campoFiltro) campoFiltro.classList.toggle('hidden', !filtroUtile);
  if (hint) hint.classList.toggle('hidden', filtroUtile);
  const q = (filtroUtile && campoFiltro ? campoFiltro.value : '').trim().toLowerCase();

  if (!nomi.length) {
    container.innerHTML = '';
    renderDataEmpty(container, { title: 'La prima copia parte da qui', description: 'Non ci sono ancora backup nel catalogo del server.', actionLabel: 'Crea un backup', onAction: () => switchBackupTab('new') });
    return;
  }

  const visibili = nomi.filter((g) => {
    if (!q) return true;
    const db = (catalogoGruppi[g][0] || {}).db || '';
    return g.toLowerCase().includes(q) || String(db).toLowerCase().includes(q);
  });

  if (!visibili.length) {
    container.innerHTML = '';
    renderDataEmpty(container, { kind: 'search', title: 'Nessuna copia corrispondente', description: `Nessun gruppo corrisponde a “${q}”.`, actionLabel: 'Azzera filtro', onAction: () => { campoFiltro.value = ''; renderCatalogo(); campoFiltro.focus(); } });
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

  let html = miei.length ? `<div class="backup-catalog-section"><span>Connessione attiva</span><strong>${esc(conn)}</strong></div>${miei.map((g) => schedaGruppo(g, false)).join('')}` : '';
  if (altri.length) {
    if (miei.length || conn) {
      html += `<div class="backup-altri-sep backup-catalog-section"><span>Altre origini</span>${conn ? `<span>Connessione attiva: <strong>${esc(conn)}</strong></span>` : ''}</div>`;
    }
    html += altri.map((g) => schedaGruppo(g, Boolean(conn))).join('');
  }
  // Il contenuto si riempie a modale GIA' aperta, quindi il disegno che
  // `openModal` fa in apertura e' gia' passato: le icone vanno disegnate qui.
  container.innerHTML = html;
  mountArcControls(container);
  refreshLucideIcons(container);

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
    btn.addEventListener('click', () => alternaStorico(btn));
  });
}

function posizioniCatalogo() {
  const limite = $('#modal-backup-manager .modal').getBoundingClientRect();
  return new Map([...$('#backup-catalog-list').children].map(el => [el, el.getBoundingClientRect()])
    .filter(([, r]) => r.bottom > limite.top && r.top < limite.bottom));
}

function animaCatalogo(el, fotogrammi, durata) {
  const animazione = el.animate(fotogrammi, { duration: durata, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
  animazione.finished.then(() => animazione.cancel(), () => {});
  return animazione;
}

function ricomponiCatalogo(prima) {
  if (movimentoRidotto.matches) return;
  const spostamenti = [...prima].map(([el, r]) => [el, r.top - el.getBoundingClientRect().top]);
  for (const [el, dy] of spostamenti) {
    el.getAnimations().forEach(a => a.cancel());
    if (Math.abs(dy) > 1) animaCatalogo(el, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], 240);
  }
}

function alternaStorico(btn) {
  const gruppo = btn.dataset.group, storico = document.getElementById(btn.getAttribute('aria-controls'));
  const apri = !storiciAperti.has(gruppo);
  const nascosto = storico.classList.contains('hidden');
  const corrente = getComputedStyle(storico);
  const da = { opacity: corrente.opacity, clipPath: corrente.clipPath, transform: corrente.transform };
  storico.getAnimations().forEach(a => a.cancel());
  if (apri) storiciAperti.add(gruppo); else storiciAperti.delete(gruppo);
  btn.setAttribute('aria-expanded', String(apri));
  storico.inert = !apri;
  if (apri) {
    const prima = posizioniCatalogo();
    storico.classList.remove('hidden');
    ricomponiCatalogo(prima);
    if (!movimentoRidotto.matches) animaCatalogo(storico, [nascosto ? { opacity: 0, clipPath: 'inset(0 0 100% 0)', transform: 'translateY(-6px)' } : da,
      { opacity: 1, clipPath: 'inset(0 0 0% 0)', transform: 'none' }], 280);
  } else {
    const chiudi = () => {
      if (storiciAperti.has(gruppo) || !storico.isConnected) return;
      const prima = posizioniCatalogo();
      storico.classList.add('hidden');
      ricomponiCatalogo(prima);
    };
    if (movimentoRidotto.matches) chiudi();
    else animaCatalogo(storico, [da, { opacity: 0, clipPath: 'inset(0 0 100% 0)', transform: 'translateY(-4px)' }], 150).finished.then(chiudi, () => {});
  }
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
      ${dbTypeIcon(ultimo.dbType)}<div><strong>${esc(ultimo.db || gName)}</strong>
      <span class="backup-group-meta">${esc({ mongodb: 'MongoDB', mysql: 'MySQL', postgresql: 'PostgreSQL' }[ultimo.dbType] || ultimo.dbType || 'Database')} · ${list.length} ${list.length === 1 ? 'copia' : 'copie'}</span>
      <span class="backup-group-name" title="${esc(gName)}">${esc(gName)}</span></div>
    </div>`;

  const evidenza = `
    <div class="backup-group-main">
      ${testata}
      <div class="backup-latest-info">
        <span class="backup-copy-label">Ultima copia</span>
        ${dataBackup(ultimo)}
        <div class="backup-copy-meta">${badgeTipo(ultimo)}<span>${esc(daQuando(ultimo.startedAt))}</span></div>
        <code class="backup-id" title="${esc(ultimo.id)}">${esc(ultimo.id)}</code>
        ${notaCatena(gName, ultimo)}
      </div>
      <div class="backup-actions">
        <button class="btn btn-sm btn-ghost btn-verify-backup" data-group="${esc(gName)}" data-id="${esc(ultimo.id)}"><i data-lucide="file-search"></i> Verifica</button>
        ${bottoneRipristino(gName, ultimo, 'btn-secondary')}
      </div>
    </div>
    <div id="${esc(idVerifica(gName, ultimo.id))}" role="status" class="verify-result-cell ${esitoDi(gName, ultimo.id) ? '' : 'hidden'}">${esitoDi(gName, ultimo.id)}</div>`;

  const cls = `backup-group-card${estranea ? ' backup-group-estranea' : ''}`;
  if (!storico.length) {
    return `<section class="${cls}">${evidenza}</section>`;
  }

  const righe = storico.map((b) => `
    <li class="backup-history-entry" data-group="${esc(gName)}" data-id="${esc(b.id)}">
      <div class="backup-history-info">
        ${dataBackup(b)}
        <div class="backup-copy-meta">${badgeTipo(b)}<span>${esc(daQuando(b.startedAt))}</span>${notaCatena(gName, b)}</div>
        <code class="backup-id">${esc(b.id)}</code>
      </div>
      <div class="backup-actions">
        <button class="btn btn-sm btn-ghost btn-verify-backup" data-group="${esc(gName)}" data-id="${esc(b.id)}"><i data-lucide="file-search"></i> Verifica</button>
        ${bottoneRipristino(gName, b, 'btn-secondary')}
      </div>
      <div role="status" id="${esc(idVerifica(gName, b.id))}" class="verify-result-cell ${esitoDi(gName, b.id) ? '' : 'hidden'}">${esitoDi(gName, b.id)}</div>
    </li>
  `).join('');

  return `
    <section class="${cls}">
      ${evidenza}
      <button type="button" class="backup-history-toggle" data-group="${esc(gName)}" aria-expanded="${aperto}" aria-controls="${esc(`history-${encodeURIComponent(gName)}`)}">
        <i data-lucide="chevron-right"></i> Versioni precedenti <span class="backup-history-count">${storico.length}</span>
      </button>
      <div id="${esc(`history-${encodeURIComponent(gName)}`)}" class="backup-history ${aperto ? '' : 'hidden'}" ${aperto ? '' : 'inert'}>
        <ol aria-label="Versioni precedenti di ${esc(ultimo.db || gName)}">${righe}</ol>
      </div>
    </section>`;
}

const dataCopia = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function dataBackup(b) {
  const data = new Date(b.startedAt || '');
  return Number.isFinite(data.getTime())
    ? `<time class="backup-copy-date" datetime="${esc(data.toISOString())}" title="${esc(b.startedAt)}">${esc(dataCopia.format(data))}</time>`
    : '<span class="backup-copy-date">Data non disponibile</span>';
}

function badgeTipo(b) {
  const tipo = String(b.type || '');
  const cls = tipo === 'full' ? 'badge-full' : (tipo === 'incremental' ? 'badge-inc' : 'badge-diff');
  return `<span class="backup-badge ${cls}">${esc({ full: 'Completo', incremental: 'Incrementale', differential: 'Differenziale' }[tipo] || tipo || 'Tipo non indicato')}</span>`;
}

function notaCatena(gName, b) {
  const catena = analizzaCatena(gName, b);
  if (catena.rotta) {
    return `<span class="backup-chain rotta" title="${esc(catena.motivo)}"><i data-lucide="triangle-alert"></i> catena incompleta</span>`;
  }
  if (catena.layer <= 1) return '';
  return `<span class="backup-chain" title="Il ripristino applica in ordine ${catena.layer} backup, dal full fino a questo."><i data-lucide="link"></i> catena di ${catena.layer}</span>`;
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
    return `<button class="btn btn-sm ${classe}" disabled title="${esc(catena.motivo)}"><i data-lucide="rotate-ccw"></i> Ripristina</button>`;
  }
  return `<button class="btn btn-sm ${classe} btn-restore-backup" ${attr}><i data-lucide="rotate-ccw"></i> Ripristina</button>`;
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

// Gli esiti delle verifiche sopravvivono ai filtri e al ricaricamento del catalogo.
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
      esito = `<div class="status-pass"><i data-lucide="circle-check"></i> Verifica SHA-256 SUPERATA: tutti i ${res.okCount} file di dati sono integri.</div>`;
    } else {
      const failed = Number(res.failedCount) || 0;
      const unverifiable = Number(res.unverifiableCount) || 0;
      const extra = Number(res.extraCount) || 0;
      const problemi = [
        failed ? `${failed} ${failed === 1 ? 'file corrotto o mancante' : 'file corrotti o mancanti'}` : '',
        unverifiable ? `${unverifiable} ${unverifiable === 1 ? 'file senza checksum verificabile' : 'file senza checksum verificabile'}` : '',
        extra ? `${extra} ${extra === 1 ? 'file extra non dichiarato nel manifest' : 'file extra non dichiarati nel manifest'}` : '',
      ].filter(Boolean);
      if (!problemi.length) problemi.push('il contenuto non corrisponde al manifest');
      const detailsHtml = (res.details || [])
        .map((d) => `<li>${esc(d.file)}: <strong>${esc(d.status)}</strong></li>`)
        .join('');
      const dettagli = detailsHtml ? `<ul>${detailsHtml}</ul>` : '';
      esito = `<div class="status-fail"><i data-lucide="circle-x"></i> Verifica FALLITA: ${problemi.join(', ')}. `
        + `${Number(res.okCount) || 0} file verificati correttamente.${dettagli}</div>`;
    }
  } catch (err) {
    esito = `<div class="status-fail">Errore durante la verifica: ${esc(err.message)}</div>`;
  } finally {
    fineCaricamento();
  }
  esitiVerifica.set(chiaveVerifica(group, backupId), esito);
  const attuale = document.getElementById(idVerifica(group, backupId));
  if (attuale) {
    attuale.innerHTML = esito;
    attuale.classList.remove('hidden');
    refreshLucideIcons(attuale);
  }
}

async function promptRestoreBackup(group, backupId, origDb, bottone) {
  // Il ripristino scrive sulla CONNESSIONE ATTIVA, non su quella da cui il
  // backup è stato preso (CDB-60): il pannello elenca i backup di tutti i
  // gruppi, quindi si può benissimo star guardando il backup di "produzione"
  // mentre si è connessi a "collaudo" — o viceversa. Prima nulla lo diceva e la
  // sola domanda era il nome del database: un ripristino sull'ambiente sbagliato
  // era a un clic di distanza. Ora la destinazione è scritta nella conferma.
  // Connessione e tab sono parte della conferma: vanno congelati PRIMA di
  // attendere la risposta della modale. L'header resta utilizzabile sopra gli
  // overlay e la ripresa di una query sospesa può cambiare tab nel frattempo.
  const origin = captureContext();
  const tab = origin.tab;
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

  await executeRestore(group, backupId, scelta.targetDb, scelta.drop, bottone, origin);
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
    ? `<i data-lucide="triangle-alert"></i> Questo backup viene dal gruppo <strong>${esc(gruppoEstraneo)}</strong>, non dalla connessione aperta: verrà comunque scritto su <strong>${esc(conn)}</strong>.`
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

async function executeRestore(group, backupId, targetDb, drop, bottone, origin) {
  const tab = origin && origin.tab;
  if (!tab || !tabs.list.includes(tab) || !tab.dbType) {
    toast('La connessione scelta per il ripristino non è più aperta. Riaprila e conferma di nuovo.', true);
    return;
  }

  toast(`Ripristino di ${backupId} su "${targetDb}" in corso...`);
  const destinatario = `${tab.label} / ${targetDb}`;
  const progresso = apriProgresso(`Ripristino di ${backupId} su ${destinatario} in corso… Chiudere la finestra non interrompe il ripristino.`, origin.tabId);
  const fineCaricamento = iniziaCaricamento(bottone, '');
  try {
    const res = await emit('backup:restore', {
      tabId: origin.tabId,
      operationId: progresso.id,
      group,
      backupId,
      targetDb,
      drop,
      connName: tab.label || tab.savedName || 'UI Session',
    });

    if (res.summary.status !== 'completato') {
      const retained = [
        res.summary.recovery && `recupero ${res.summary.recovery.id || 'disponibile'}`,
        res.summary.staging && `staging ${res.summary.staging.db || 'disponibile'}`,
      ].filter(Boolean).join(', ');
      throw new Error(`${res.summary.status}: ${res.summary.error || 'restore non completato'}${retained ? ` (${retained})` : ''}`);
    }

    const msg = `Ripristino completato su ${destinatario}: ${res.summary.totalDocs} elementi ripristinati da ${res.summary.layers} layer.`;
    toast(msg);
    chiudiProgresso(progresso, msg, true);
    // Un ripristino crea collection e tabelle che nell'albero non ci sono: senza
    // questa ricarica la sidebar continua a mostrare lo schema di prima, e
    // l'unico modo di vedere i dati appena riportati è ricaricare la pagina.
    tab.state.schemaDirty = true;
    if (!origin.tabId || tabs.activeId === origin.tabId) {
      tab.state.schemaDirty = false;
      refreshDbTree();
    }
  } catch (err) {
    toast(`Ripristino fallito: ${err.message}`, true);
    chiudiProgresso(progresso, `Ripristino fallito su ${destinatario}: ${err.message}`, false);
    // Anche un ripristino fallito può aver applicato una parte dei layer: lo
    // schema a sinistra va riletto comunque, non è più quello di prima.
    tab.state.schemaDirty = true;
    if (!origin.tabId || tabs.activeId === origin.tabId) {
      tab.state.schemaDirty = false;
      refreshDbTree();
    }
  } finally {
    fineCaricamento();
  }
}
