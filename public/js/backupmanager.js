'use strict';

import { state } from './state.js';
import { $, emit, toast, openModal, closeModal, esc, fmtBytes, chiediTesto } from './utils.js';
import { activeTab } from './tabs.js';
import { segnaTraguardo } from './onboarding-stato.js';

let currentTabMode = 'new'; // 'new' | 'catalog'

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
    btnRefresh.addEventListener('click', () => fetchBackupCatalog());
  }
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
  if (btnSubmit) btnSubmit.disabled = true;
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
    if (btnSubmit) btnSubmit.disabled = false;
  }
}

async function fetchBackupCatalog() {
  const container = $('#backup-catalog-list');
  if (!container) return;

  container.innerHTML = '<div class="loading-spinner">Caricamento catalogo backup in corso...</div>';

  try {
    const res = await emit('backup:list', {});
    const groups = res.groups || {};
    const groupNames = Object.keys(groups);

    if (!groupNames.length) {
      container.innerHTML = '<div class="empty-state">Nessun backup trovato nella cartella del server.</div>';
      return;
    }

    let html = '';
    for (const gName of groupNames) {
      const list = groups[gName];
      html += `
        <div class="backup-group-card">
          <div class="backup-group-title">📂 Gruppo: <strong>${esc(gName)}</strong> (${list.length} backup)</div>
          <table class="backup-table">
            <thead>
              <tr>
                <th>ID / Data</th>
                <th>Tipo</th>
                <th>Database</th>
                <th>Elementi / Dim.</th>
                <th>Azioni</th>
              </tr>
            </thead>
            <tbody>
      `;

      for (const b of list) {
        const typeBadge = b.type === 'full' ? 'badge-full' : (b.type === 'incremental' ? 'badge-inc' : 'badge-diff');
        html += `
          <tr data-group="${esc(gName)}" data-id="${esc(b.id)}">
            <td>
              <div class="backup-id">${esc(b.id)}</div>
              <div class="backup-date">${esc(b.startedAt || '')}</div>
            </td>
            <td><span class="backup-badge ${typeBadge}">${esc(b.type.toUpperCase())}</span></td>
            <td>${esc(b.db)} <span class="sub-text">(${esc(b.dbType)})</span></td>
            <td>
              <div>${b.totalDocs ?? '-'} doc</div>
              <div class="sub-text">${b.totalBytes != null ? fmtBytes(b.totalBytes) : ''}</div>
            </td>
            <td class="backup-actions">
              <button class="btn btn-sm btn-secondary btn-verify-backup" data-group="${esc(gName)}" data-id="${esc(b.id)}">
                🔍 Verifica
              </button>
              <button class="btn btn-sm btn-primary btn-restore-backup" data-group="${esc(gName)}" data-id="${esc(b.id)}" data-db="${esc(b.db)}">
                ⚡ Ripristina
              </button>
            </td>
          </tr>
          <tr id="verify-res-${esc(gName)}-${esc(b.id)}" class="verify-result-row hidden">
            <td colspan="5" class="verify-result-cell"></td>
          </tr>
        `;
      }

      html += `
            </tbody>
          </table>
        </div>
      `;
    }

    container.innerHTML = html;

    container.querySelectorAll('.btn-verify-backup').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const g = e.currentTarget.getAttribute('data-group');
        const id = e.currentTarget.getAttribute('data-id');
        verifyBackupIntegrity(g, id);
      });
    });

    container.querySelectorAll('.btn-restore-backup').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const g = e.currentTarget.getAttribute('data-group');
        const id = e.currentTarget.getAttribute('data-id');
        const origDb = e.currentTarget.getAttribute('data-db');
        promptRestoreBackup(g, id, origDb);
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="error-box">Errore nel caricamento del catalogo: ${esc(err.message)}</div>`;
  }
}

async function verifyBackupIntegrity(group, backupId) {
  const safeId = `verify-res-${group}-${backupId}`;
  const row = document.getElementById(safeId);
  if (!row) return;

  const cell = row.querySelector('.verify-result-cell');
  row.classList.remove('hidden');
  cell.innerHTML = '<em>Calcolo checksum SHA-256 in corso...</em>';

  try {
    const res = await emit('backup:verify', { group, backupId });
    if (res.valid) {
      cell.innerHTML = `<div class="status-pass">✅ Verifica SHA-256 SUPERATA: tutti i ${res.okCount} file di dati sono integri.</div>`;
    } else {
      let detailsHtml = res.details.map(d => `<li>${esc(d.file)}: <strong>${esc(d.status)}</strong></li>`).join('');
      cell.innerHTML = `<div class="status-fail">❌ Verifica FALLITA: ${res.failedCount} file corrotti o mancanti su ${res.okCount + res.failedCount}.<ul>${detailsHtml}</ul></div>`;
    }
  } catch (err) {
    cell.innerHTML = `<div class="status-fail">Errore durante la verifica: ${esc(err.message)}</div>`;
  }
}

async function promptRestoreBackup(group, backupId, origDb) {
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

  const targetDb = await chiediTesto({
    titolo: `Ripristino del backup "${backupId}"`,
    sottotitolo: `DESTINAZIONE: ${conn}`,
    etichetta: 'Database di destinazione',
    valore: origDb || '',
    ok: 'Continua',
  });
  if (targetDb === null) return;
  const dbScelto = targetDb.trim();
  if (!dbScelto) {
    // Prima si ricadeva in silenzio sul database del backup: se l'utente
    // cancella il campo, di solito è perché sta ripensandoci.
    toast('Ripristino annullato: nessun database di destinazione indicato.', true);
    return;
  }

  if (!confirm(
    `Confermi il ripristino?\n\n`
    + `Backup:      ${backupId}\n`
    + `Connessione: ${conn}\n`
    + `Database:    ${dbScelto}\n\n`
    + 'I dati esistenti verranno sovrascritti.'
  )) return;

  const dropConfirm = confirm(
    `Vuoi ELIMINARE (DROP) le collection/tabelle di destinazione in "${dbScelto}" prima di applicare il ripristino?\n\n`
    + '- OK: Elimina ed applica il ripristino\n- Annulla: Applica il ripristino senza eliminare (upsert)'
  );

  executeRestore(group, backupId, dbScelto, dropConfirm);
}

async function executeRestore(group, backupId, targetDb, drop) {
  const tab = activeTab();
  if (!tab || !tab.dbType) {
    toast('Connettiti prima a un database per eseguire il ripristino.', true);
    return;
  }

  toast(`Ripristino di ${backupId} su "${targetDb}" in corso...`);
  try {
    const res = await emit('backup:restore', {
      group,
      backupId,
      targetDb,
      drop,
      connName: tab.label || tab.savedName || 'UI Session',
    });

    toast(`✅ Ripristino completato su "${res.summary.targetDb}": ${res.summary.totalDocs} elementi ripristinati da ${res.summary.layers} layer!`);
  } catch (err) {
    toast(`❌ Ripristino fallito: ${err.message}`, true);
  }
}
