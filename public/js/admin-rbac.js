'use strict';

/* ---------------------------------------------------------------------------
 * Pannello "Utenti & Permessi" (RBAC). Cruscotto dell'owner/admin per:
 *  - creare e gestire i sottoutenti del proprio account (con limite di piano);
 *  - assegnare permessi per connessione (ruolo + scope glob su db/collezioni);
 *  - generare/revocare API key per l'accesso via MCP (mostrate una sola volta).
 *
 * Tutto passa dagli eventi socket riservati a chi ha la capability `manage`
 * (users:*, grants:*, apikeys:*, roles:list); il server resta l'unica autorità.
 * Con RBAC spento il pulsante non compare (nessun utente da gestire).
 * ------------------------------------------------------------------------- */

import { $, emit, esc, showToast, chiediTesto } from './utils.js';
import { socket } from './socket.js';

// Cache locale dei dati caricati all'apertura della modale.
const data = { users: [], roles: [], conns: [], grants: [], keys: [], limits: null };

const modal = () => $('#modal-admin-rbac');

export function initAdminRbac() {
  const btn = $('#btn-admin-rbac');
  const dockBtn = $('#conn-dock-admin');
  if (btn) btn.addEventListener('click', open);
  if (dockBtn) dockBtn.addEventListener('click', open);

  const close = $('#btn-close-admin-rbac');
  if (close) close.addEventListener('click', hide);

  // Navigazione a schede all'interno della modale.
  document.querySelectorAll('#modal-admin-rbac .admin-tab').forEach((tab) => {
    tab.addEventListener('click', () => showPane(tab.dataset.pane));
  });

  wireForms();
  wireListActions();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal() && !modal().classList.contains('hidden')) hide();
  });

  // Il pulsante è visibile solo a owner/admin (capability `manage`) con RBAC
  // attivo: lo si ricalcola a ogni (ri)connessione del socket.
  socket.on('connect', refreshVisibility);
  refreshVisibility();
}

export async function refreshVisibility() {
  const btn = $('#btn-admin-rbac');
  if (!btn) return;
  const res = await emit('auth:me', {}).catch(() => null);
  const u = res && res.ok ? res.user : null;
  const canManage = !!(u && u.rbac && Array.isArray(u.capabilities) && u.capabilities.includes('manage'));
  btn.classList.toggle('hidden', !canManage);
}

/* --- Apertura e caricamento dati ------------------------------------------ */

async function open() {
  modal().classList.remove('hidden');
  showPane('subusers');
  await reload();
}

function hide() {
  modal().classList.add('hidden');
}

// Ricarica tutti i dati dal server e ridisegna. Le liste vuote non sono un
// errore (nessun sottoutente/grant/chiave ancora creati).
async function reload() {
  try {
    const [users, roles, conns, grants, keys] = await Promise.all([
      emit('users:list', {}),
      emit('roles:list', {}),
      emit('connections:list', {}),
      emit('grants:list', {}),
      emit('apikeys:list', {}),
    ]);
    data.users = users.users || [];
    data.limits = users.limits || null;
    data.roles = roles.roles || [];
    data.conns = conns.connections || [];
    data.grants = grants.grants || [];
    data.keys = keys.keys || [];
  } catch (err) {
    showToast(`Impossibile caricare i dati RBAC: ${err.message}`, 'error');
    return;
  }
  populateSelects();
  renderUsers();
  renderGrants();
  renderKeys();
}

function showPane(name) {
  document.querySelectorAll('#modal-admin-rbac .admin-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.pane === name);
  });
  document.querySelectorAll('#modal-admin-rbac .admin-pane').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.pane !== name);
  });
}

/* --- Select popolate dai dati --------------------------------------------- */

function emailOf(subjectId) {
  const u = data.users.find((x) => x.id === subjectId);
  return u ? u.email : subjectId;
}

function populateSelects() {
  // Soggetto dei grant: solo sottoutenti (l'owner ha già tutti i permessi).
  const subjOpts = data.users.map((u) => `<option value="${esc(u.id)}">${esc(u.email)}</option>`).join('');
  const grantSubject = $('#grant-subject');
  if (grantSubject) {
    grantSubject.innerHTML = data.users.length
      ? subjOpts
      : '<option value="">— nessun sottoutente: creane uno prima —</option>';
  }

  // Connessioni salvate (nome = chiave del grant).
  const connOpts = data.conns.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  const grantConn = $('#grant-conn');
  if (grantConn) grantConn.innerHTML = connOpts || '<option value="">— nessuna connessione salvata —</option>';

  // Ruoli (predefiniti + eventuali custom). Default sensato: viewer.
  const roleOpts = data.roles.map((r) => {
    const caps = (r.capabilities || []).join(', ');
    return `<option value="${esc(r.name)}"${r.name === 'viewer' ? ' selected' : ''}>${esc(r.name)}${caps ? ` (${esc(caps)})` : ''}</option>`;
  }).join('');
  const grantRole = $('#grant-role');
  if (grantRole) grantRole.innerHTML = roleOpts;

  // Soggetto dell'API key: l'owner stesso (valore vuoto) oppure un sottoutente.
  const apikeySubject = $('#apikey-subject');
  if (apikeySubject) {
    apikeySubject.innerHTML = `<option value="">Me (owner)</option>${subjOpts}`;
  }

  renderPillMultiselects();
}

function renderPillMultiselects() {
  // Pill per le connessioni consentite nell'API key
  const apikeyPills = $('#apikey-scope-pills');
  if (apikeyPills) {
    const connItems = data.conns.map((c) =>
      `<button type="button" class="pill-option" data-value="${esc(c.name)}">🔌 ${esc(c.name)}</button>`
    ).join('');
    apikeyPills.innerHTML = `<button type="button" class="pill-option active" data-value="">🌐 Tutte le connessioni concesse</button>${connItems}`;
    wirePillContainer(apikeyPills, $('#apikey-scope'));
  }

  // Pill per i database nei Grant (Permessi)
  const grantDbPills = $('#grant-dbs-pills');
  if (grantDbPills) {
    grantDbPills.innerHTML = `<button type="button" class="pill-option active" data-value="">🌐 Tutti i DB</button>`;
    wirePillContainer(grantDbPills, $('#grant-dbs'));
  }
}

function wirePillContainer(container, hiddenInput) {
  if (!container || container.dataset.wired) return;
  container.dataset.wired = 'true';

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.pill-option');
    if (!btn) return;

    const val = btn.dataset.value;
    const allBtn = container.querySelector('.pill-option[data-value=""]');

    if (val === '') {
      container.querySelectorAll('.pill-option').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
    } else {
      if (allBtn) allBtn.classList.remove('active');
      btn.classList.toggle('active');

      const activeSpecific = container.querySelectorAll('.pill-option:not([data-value=""]).active');
      if (activeSpecific.length === 0 && allBtn) {
        allBtn.classList.add('active');
      }
    }

    if (hiddenInput) {
      const selectedVals = Array.from(container.querySelectorAll('.pill-option.active'))
        .map((b) => b.dataset.value)
        .filter(Boolean);
      hiddenInput.value = selectedVals.join(',');
    }
  });
}

/* --- Rendering delle liste ------------------------------------------------- */

function statusBadge(status) {
  if (status === 'suspended') return '<span class="rbac-badge rbac-suspended">Sospeso</span>';
  return '<span class="rbac-badge rbac-active">Attivo</span>';
}

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? '—' : d.toLocaleString();
}

function renderUsers() {
  const limit = data.limits;
  const limitEl = $('#subuser-limit');
  if (limitEl) {
    if (limit && limit.maxSubUsers != null) {
      limitEl.textContent = `Sottoutenti: ${data.users.length} / ${limit.maxSubUsers}${limit.plan ? ` · piano "${limit.plan}"` : ''}`;
    } else {
      limitEl.textContent = `Sottoutenti: ${data.users.length}${limit && limit.plan ? ` · piano "${limit.plan}"` : ''}`;
    }
  }

  const container = $('#subuser-list');
  if (!data.users.length) {
    container.innerHTML = '<div class="empty-state">Nessun sottoutente. Creane uno con il modulo qui sopra.</div>';
    return;
  }
  const rows = data.users.map((u) => {
    const suspended = u.status === 'suspended';
    return `
      <tr>
        <td>${esc(u.email)}</td>
        <td>${esc(u.displayName || '')}</td>
        <td>${statusBadge(u.status)}</td>
        <td class="sub-text">${esc(fmtDate(u.createdAt))}</td>
        <td class="rbac-actions">
          <button class="btn btn-sm btn-secondary" data-action="toggle-user" data-id="${esc(u.id)}" data-status="${suspended ? 'active' : 'suspended'}">${suspended ? 'Riattiva' : 'Sospendi'}</button>
          <button class="btn btn-sm btn-secondary" data-action="reset-pwd" data-id="${esc(u.id)}">Reset password</button>
          <button class="btn btn-sm btn-danger" data-action="del-user" data-id="${esc(u.id)}" data-email="${esc(u.email)}">Elimina</button>
        </td>
      </tr>`;
  }).join('');
  container.innerHTML = `
    <table class="backup-table">
      <thead><tr><th>Email</th><th>Nome</th><th>Stato</th><th>Creato</th><th>Azioni</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function scopeText(scope) {
  if (!scope) return '<span class="sub-text">tutto</span>';
  const dbs = (scope.databases || []).join(', ') || 'tutti i db';
  const colls = (scope.collections || []).join(', ') || 'tutte';
  return `<span class="sub-text">db: ${esc(dbs)} · coll: ${esc(colls)}</span>`;
}

function renderGrants() {
  const container = $('#grant-list');
  if (!data.grants.length) {
    container.innerHTML = '<div class="empty-state">Nessun permesso assegnato. Concedi l\'accesso a una connessione con il modulo qui sopra.</div>';
    return;
  }
  const rows = data.grants.map((g) => `
    <tr>
      <td>${esc(emailOf(g.subjectId))}</td>
      <td>${esc(g.connName)}</td>
      <td><span class="rbac-badge rbac-role">${esc(g.role)}</span></td>
      <td>${scopeText(g.scope)}</td>
      <td class="rbac-actions">
        <button class="btn btn-sm btn-danger" data-action="revoke-grant" data-subject="${esc(g.subjectId)}" data-conn="${esc(g.connName)}">Revoca</button>
      </td>
    </tr>`).join('');
  container.innerHTML = `
    <table class="backup-table">
      <thead><tr><th>Sottoutente</th><th>Connessione</th><th>Ruolo</th><th>Scope</th><th>Azioni</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderKeys() {
  const container = $('#apikey-list');
  if (!data.keys.length) {
    container.innerHTML = '<div class="empty-state">Nessuna API key. Generane una per l\'accesso via MCP.</div>';
    return;
  }
  const rows = data.keys.map((k) => {
    const scope = Array.isArray(k.connScope) && k.connScope.length ? esc(k.connScope.join(', ')) : '<span class="sub-text">tutte le concesse</span>';
    return `
      <tr>
        <td>${esc(k.label || '(senza etichetta)')}</td>
        <td>${esc(emailOf(k.subjectId))}</td>
        <td><code>${esc(k.prefix || '')}…</code></td>
        <td>${scope}</td>
        <td class="sub-text">${esc(fmtDate(k.lastUsedAt))}</td>
        <td class="rbac-actions">
          <button class="btn btn-sm btn-danger" data-action="revoke-key" data-id="${esc(k.id)}">Revoca</button>
        </td>
      </tr>`;
  }).join('');
  container.innerHTML = `
    <table class="backup-table">
      <thead><tr><th>Etichetta</th><th>Soggetto</th><th>Prefisso</th><th>Connessioni</th><th>Ultimo uso</th><th>Azioni</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* --- Moduli di creazione --------------------------------------------------- */

function splitGlobs(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function wireForms() {
  const subForm = $('#subuser-form');
  if (subForm) subForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#subuser-email').value.trim();
    const password = $('#subuser-password').value;
    const displayName = $('#subuser-name').value.trim();
    if (!email || !password) return;
    try {
      await emit('users:create', { email, password, displayName });
      $('#subuser-email').value = '';
      $('#subuser-password').value = '';
      $('#subuser-name').value = '';
      showToast('Sottoutente creato.', 'success');
      await reload();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const grantForm = $('#grant-form');
  if (grantForm) grantForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const subjectId = $('#grant-subject').value;
    const connName = $('#grant-conn').value;
    const role = $('#grant-role').value;
    if (!subjectId || !connName || !role) {
      showToast('Seleziona sottoutente, connessione e ruolo.', 'error');
      return;
    }
    const databases = splitGlobs($('#grant-dbs').value);
    const collections = splitGlobs($('#grant-colls').value);
    const scope = (databases.length || collections.length) ? { databases, collections } : null;
    try {
      await emit('grants:set', { subjectId, connName, role, scope });
      $('#grant-dbs').value = '';
      $('#grant-colls').value = '';
      showToast('Permesso assegnato.', 'success');
      await reload();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const keyForm = $('#apikey-form');
  if (keyForm) keyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const subjectId = $('#apikey-subject').value; // '' = owner
    const label = $('#apikey-label').value.trim();
    const connScope = splitGlobs($('#apikey-scope').value);
    try {
      const res = await emit('apikeys:create', { subjectId, label, connScope: connScope.length ? connScope : null });
      $('#apikey-label').value = '';
      showNewKey(res.key);
      await reload();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// La chiave in chiaro esiste solo in questa risposta: la si mostra una volta,
// con pulsanti per copiare la chiave grezza e la configurazione JSON MCP.
function showNewKey(key) {
  const box = $('#apikey-new');
  if (!box || !key) return;

  const serverUrl = `${window.location.origin}/mcp`;
  const mcpConfigJson = JSON.stringify({
    mcpServers: {
      codedb: {
        url: serverUrl,
        headers: {
          Authorization: `Bearer ${key}`
        }
      }
    }
  }, null, 2);

  box.innerHTML = `
    <div class="apikey-new-head">🔑 Nuova API key generata (copiala ora, non sarà più mostrata!)</div>
    
    <div class="apikey-new-section">
      <span class="sub-text" style="display:block; margin-bottom:4px;">Chiave API grezza:</span>
      <div class="apikey-new-row">
        <code>${esc(key)}</code>
        <button type="button" class="btn btn-sm btn-primary" id="apikey-copy-raw">📋 Copia Chiave</button>
      </div>
    </div>

    <div class="apikey-new-section" style="margin-top: 10px;">
      <span class="sub-text" style="display:block; margin-bottom:4px;">Configurazione Client MCP (es. <code>claude_desktop_config.json</code>):</span>
      <pre class="apikey-config-code"><code>${esc(mcpConfigJson)}</code></pre>
      <div style="margin-top: 8px; display: flex; gap: 8px; justify-content: flex-end;">
        <button type="button" class="btn btn-sm btn-primary" id="apikey-copy-json">📋 Copia Configurazione JSON</button>
        <button type="button" class="btn btn-sm btn-secondary" id="apikey-dismiss">Chiudi</button>
      </div>
    </div>`;

  box.classList.remove('hidden');

  $('#apikey-copy-raw').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(key);
      showToast('API key copiata negli appunti.', 'success');
    } catch {
      showToast('Copia non riuscita: selezionala e copiala a mano.', 'error');
    }
  });

  $('#apikey-copy-json').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(mcpConfigJson);
      showToast('Configurazione JSON MCP copiata negli appunti!', 'success');
    } catch {
      showToast('Copia non riuscita: selezionala e copiala a mano.', 'error');
    }
  });

  $('#apikey-dismiss').addEventListener('click', () => box.classList.add('hidden'));
}

/* --- Azioni sulle liste (event delegation) --------------------------------- */

function wireListActions() {
  const m = modal();
  if (!m) return;
  m.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    try {
      if (action === 'toggle-user') {
        await emit('users:update', { id: btn.dataset.id, status: btn.dataset.status });
        showToast(btn.dataset.status === 'suspended' ? 'Sottoutente sospeso.' : 'Sottoutente riattivato.', 'success');
        await reload();
      } else if (action === 'reset-pwd') {
        const pwd = await chiediTesto({
          titolo: 'Reimposta password',
          sottotitolo: 'Le sessioni attive del sottoutente verranno chiuse.',
          etichetta: 'Nuova password',
          password: true,
          ok: 'Aggiorna',
        });
        if (!pwd) return;
        await emit('users:update', { id: btn.dataset.id, password: pwd });
        showToast('Password aggiornata (le sessioni attive del sottoutente sono state chiuse).', 'success');
      } else if (action === 'del-user') {
        if (!window.confirm(`Eliminare il sottoutente "${btn.dataset.email}"? I suoi permessi e le sue API key verranno rimossi.`)) return;
        await emit('users:delete', { id: btn.dataset.id });
        showToast('Sottoutente eliminato.', 'success');
        await reload();
      } else if (action === 'revoke-grant') {
        await emit('grants:revoke', { subjectId: btn.dataset.subject, connName: btn.dataset.conn });
        showToast('Permesso revocato.', 'success');
        await reload();
      } else if (action === 'revoke-key') {
        if (!window.confirm('Revocare questa API key? I client che la usano perderanno subito l\'accesso.')) return;
        await emit('apikeys:revoke', { id: btn.dataset.id });
        showToast('API key revocata.', 'success');
        await reload();
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}
