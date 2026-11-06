import { $, emit as emitSocket, esc, refreshLucideIcons, scaricaFile, toast } from './utils.js';
import { socket } from './socket.js';
import { chiediConferma } from './conferma.js';
import { closeDrawers } from './responsive.js';
import { mountArcControls, renderDataEmpty, openNavigationSheet, closeNavigationSheet } from '../arc/ui.js';

// La sezione conserva il workspace montato: tornare ai dati non perde editor o selezioni.
const STATI = { running: 'In corso', pending: 'Conferma richiesta', confirmed: 'Conferma utilizzata', completed: 'Completata', rejected: 'Rifiutata', failed: 'Fallita', partial: 'Parzialmente applicata', rolled_back: 'Ripristinata dopo errore', expired: 'Scaduta', unknown: 'Esito non disponibile' };
const CATEGORIE = { read: 'Lettura', write: 'Scrittura', ddl: 'Struttura', admin: 'Configurazione', connection: 'Connessione', backup: 'Backup', import: 'Importazione', resource: 'Risorsa', prompt: 'Prompt' };
const CAMPI = [
  ['Servizio e operazioni', [
    ['enabled', 'Abilita MCP', 'Accetta nuove richieste. La disattivazione attende le operazioni già in corso.', 'boolean'],
    ['readOnly', 'Sola lettura per MCP', 'Restringe le operazioni MCP anche sulle connessioni che consentono scritture.', 'boolean'],
    ['allowDdl', 'Consenti modifiche alla struttura', 'Restano necessari permessi, connessione scrivibile e conferma.', 'boolean'],
    ['allowBackup', 'Consenti backup', 'Consente le operazioni MCP di backup.', 'boolean'],
    ['allowImport', 'Consenti importazioni', 'Consente le importazioni MCP nel rispetto dei permessi.', 'boolean'],
  ]],
  ['Sessioni', [
    ['maxSessions', 'Sessioni contemporanee', 'Il budget delle connessioni DB resta condiviso con CodeDB.', 'number', 1, 256],
    ['idleTimeoutMinutes', 'Scadenza per inattività', 'Minuti; una sessione impegnata non scade durante un’operazione.', 'number', 1, 1440],
    ['confirmTimeoutSeconds', 'Validità delle conferme', 'Secondi; si applica alle nuove richieste di conferma.', 'number', 30, 1800],
  ]],
  ['Conferme pendenti', [
    ['pendingPerPrincipal', 'Numero per soggetto', 'Richieste che un singolo soggetto può tenere in attesa.', 'number', 1, 1000],
    ['pendingGlobal', 'Numero complessivo', 'Limite condiviso da tutte le sessioni MCP.', 'number', 1, 10000],
    ['pendingBytesPerPrincipalMiB', 'Memoria per soggetto', 'MiB disponibili per i parametri in attesa di conferma.', 'number', 1, 1024],
    ['pendingBytesGlobalMiB', 'Memoria complessiva', 'MiB disponibili per tutte le conferme pendenti.', 'number', 1, 4096],
  ]],
  ['Conservazione attività', [
    ['auditMaxMiB', 'Dimensione di ogni registro', 'MiB; al raggiungimento del limite viene ruotato il file.', 'number', 1, 100],
    ['auditGenerations', 'Registri precedenti conservati', 'Oltre al registro corrente. Gli eventi più vecchi escono dallo storico.', 'number', 1, 20],
  ]],
];
let panel, pane = 'overview', generation = 0, timer, filterTimer, opener, status, settings, identity;
let activity = { entries: [], offset: 0, total: 0, limit: 50, snapshot: null };
let selectedId = null, paused = false, dirty = false, busy = false, creatingKey = false, latestId = null;
let requestSequence = 0, detailSequence = 0, detailScrollTop = 0;
let settingsSequence = 0, settingsEdits = 0, filterContent, filtersInSheet = false;
const fingerprint = entries => JSON.stringify(entries.map(e => [e.id, e.status, e.finishedAt, e.durationMs]));
const visible = () => !!panel && !panel.hidden;
const emit = (event, payload) => emitSocket(event, payload, { bindTab: false, reconnect: false, timeoutMs: 20000, rejectOnDisconnect: true });
const q = selector => panel.querySelector(selector) || filterContent?.querySelector(selector);
const date = value => { const d = new Date(value); return value && Number.isFinite(d.getTime()) ? d.toLocaleString('it-IT') : 'Non disponibile'; };
const client = value => typeof value === 'object' && value ? [value.name, value.version].filter(Boolean).join(' ') : value || 'Client non dichiarato';
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'Non disponibile';
const permissionsText = value => Object.entries({ read: 'lettura', write: 'scrittura', ddl: 'modifiche alla struttura' }).filter(([key]) => value[key]).map(([,label]) => label).join(', ') || 'nessuna operazione consentita';
const labelStatus = value => STATI[value] || value || STATI.unknown;
const badge = value => `<span class="mcp-status mcp-status-${esc(Object.hasOwn(STATI, value) ? value : 'unknown')}"><span class="mcp-status-dot" aria-hidden="true"></span>${esc(labelStatus(value))}</span>`;
function paint(node = panel) { mountArcControls(node); refreshLucideIcons(node); }
function error(err) { q('#mcp-message').textContent = err?.message || String(err); q('#mcp-message').hidden = false; }
function clearError() { q('#mcp-message').hidden = true; q('#mcp-message').textContent = ''; }
function emptyState(node, options) {
  if (options.kind === 'error') clearError();
  renderDataEmpty(node, null); node.replaceChildren();
  renderDataEmpty(node, { compact: true, ...options });
  const host = node.querySelector('.data-empty-host');
  if (host) { host.setAttribute('data-arc-owned', ''); host.dataset.kind = options.kind || 'data'; }
}
const hasPaneError = () => !!q(`#mcp-pane-${pane} .data-empty-host[data-kind="error"]`);
function paneError(name, err) {
  if (name === 'overview' && !status) { emptyState(q('#mcp-overview-content'), { kind: 'error', title: 'Servizio MCP non disponibile', description: err.message, actionLabel: 'Riprova', onAction: refreshAll }); return; }
  if (name === 'settings' && !q('#mcp-settings-form')) { emptyState(q('#mcp-settings-content'), { kind: 'error', title: 'Impostazioni non disponibili', description: err.message, actionLabel: 'Riprova', onAction: () => selectPane(name) }); return; }
  if (name === 'access' && !q('#mcp-connections table')) { q('#mcp-keys').replaceChildren(); emptyState(q('#mcp-connections'), { kind: 'error', title: 'Accessi non disponibili', description: err.message, actionLabel: 'Riprova', onAction: () => selectPane(name) }); return; }
  if (!hasPaneError()) error(err);
}
function resetSecret() { const box = q('#mcp-new-key'); if (box) { box.replaceChildren(); box.hidden = true; } }
function clearActivity() {
  activity = { entries: [], offset: 0, total: 0, limit: 50, snapshot: null }; selectedId = null; latestId = null;
  for (const id of ['mcp-overview-content','mcp-activity-list','mcp-detail','mcp-connections','mcp-keys']) q(`#${id}`).replaceChildren();
  q('#mcp-detail').hidden = true; q('.mcp-activity-layout').classList.remove('has-detail');
  q('#mcp-new-activity').hidden = true; q('#mcp-page-info').textContent = ''; q('.mcp-pager').hidden = true;
}

export function initMcpPanel() {
  const area = document.querySelector('.main-area');
  if (!area || panel) return;
  panel = document.createElement('section');
  panel.id = 'mcp-panel'; panel.hidden = true; panel.setAttribute('aria-labelledby', 'mcp-title');
  panel.innerHTML = `
    <header class="mcp-header">
      <div class="mcp-heading"><button type="button" data-action="close" class="mcp-back"><i data-lucide="arrow-left" aria-hidden="true"></i><span>Torna ai dati</span></button><h1 id="mcp-title" tabindex="-1">MCP</h1></div>
      <p>Accedi, configura e segui le attività dei tuoi client AI.</p>
    </header>
    <nav class="mcp-tabs" role="tablist" aria-label="Sezioni MCP">${[['overview','Panoramica','layout-dashboard'],['activity','Attività','activity'],['access','Connessioni e accessi','key-round'],['settings','Impostazioni','sliders-horizontal']].map(([id,label,icon])=>`<button type="button" id="mcp-tab-${id}" role="tab" aria-controls="mcp-pane-${id}" aria-selected="${id === pane}" tabindex="${id === pane ? 0 : -1}" data-pane="${id}"><i data-lucide="${icon}" aria-hidden="true"></i>${label}</button>`).join('')}</nav>
    <div id="mcp-message" class="mcp-message" role="alert" hidden></div>
    <p id="mcp-operation-status" class="mcp-operation-status" role="status" hidden>Operazione in corso…</p>
    <div class="mcp-content">
      <section id="mcp-pane-overview" role="tabpanel" aria-labelledby="mcp-tab-overview"><div id="mcp-overview-content" class="mcp-section-body"></div></section>
      <section id="mcp-pane-activity" role="tabpanel" aria-labelledby="mcp-tab-activity" hidden>
        <div class="mcp-activity-heading"><div><h2>Registro attività</h2><p class="mcp-muted">Ogni richiesta, dal primo contatto all’esito.</p></div><span id="mcp-live-state" class="mcp-live-state"><span class="mcp-status-dot" aria-hidden="true"></span>Aggiornamento attivo</span></div>
        <div class="mcp-filter-accordion"><button type="button" class="mcp-filter-toggle" data-action="toggle-filters" aria-expanded="false" aria-controls="mcp-filter-content"><i data-lucide="list-filter" aria-hidden="true"></i>Filtri<span id="mcp-filter-count">Nessun filtro attivo</span><i class="mcp-filter-chevron" data-lucide="chevron-down" aria-hidden="true"></i></button>
        <div id="mcp-filter-content" hidden><form id="mcp-filters" class="mcp-filters">
          <label class="mcp-search">Cerca<input name="search" type="search" placeholder="Azione, bersaglio, dettaglio…" autocomplete="off"></label>
          <label>Dal giorno<input id="mcp-filter-from" name="from" type="date" class="arc-inline-date-model"></label><label>Al giorno<input id="mcp-filter-to" name="to" type="date" class="arc-inline-date-model"></label>
          <label>Esito<select name="status"><option value="">Tutti gli esiti</option>${Object.entries(STATI).map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label>
          <div class="mcp-more-filters"><div>
          <label>Tool<input name="tool" placeholder="Es. execute_query" autocomplete="off"></label><label>Connessione<input name="connection" autocomplete="off"></label><label>Database<input name="db" autocomplete="off"></label><label>Autore<input name="user" autocomplete="off"></label>
          <label>Categoria<select name="category"><option value="">Tutte</option>${Object.entries(CATEGORIE).map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label></div></div>
        </form><div class="mcp-filter-actions"><button type="button" data-action="reset-filters" class="ghost">Azzera filtri</button><button type="button" data-action="close-filters">Mostra risultati</button></div></div></div>
        <div class="mcp-activity-toolbar"><div class="mcp-quick-filters"><button type="button" data-action="errors" aria-pressed="false"><i data-lucide="circle-alert" aria-hidden="true"></i>Fallimenti</button><button type="button" data-action="writes" aria-pressed="false"><i data-lucide="pencil-line" aria-hidden="true"></i>Scritture</button><button type="button" data-action="reset-filters" class="ghost">Azzera filtri</button></div><div><button type="button" data-action="live" aria-pressed="true"><i data-lucide="pause"></i> Pausa aggiornamenti</button><button type="button" data-action="refresh-activity" aria-label="Aggiorna attività"><i data-lucide="refresh-cw"></i></button><button type="button" data-action="export-json" aria-label="Esporta attività in JSON">JSON</button><button type="button" data-action="export-csv" aria-label="Esporta attività in CSV">CSV</button></div></div>
        <button type="button" id="mcp-new-activity" data-action="refresh-activity" class="mcp-new-activity" hidden>Nuove attività disponibili · Aggiorna elenco</button>
        <p id="mcp-activity-note" class="mcp-muted" role="status"></p>
        <div class="mcp-activity-layout"><div class="mcp-activity-list" id="mcp-activity-list" aria-label="Elenco attività"></div><aside id="mcp-detail" class="mcp-detail" aria-label="Dettaglio attività" hidden></aside></div>
        <footer class="mcp-pager" hidden><span id="mcp-page-info" role="status"></span><label>Per pagina<select id="mcp-page-size"><option>25</option><option selected>50</option><option>100</option><option>200</option></select></label><button type="button" data-action="prev">Precedenti</button><button type="button" data-action="next">Successivi</button></footer>
      </section>
      <section id="mcp-pane-access" role="tabpanel" aria-labelledby="mcp-tab-access" hidden><div class="mcp-section-body"><div id="mcp-connections"></div><div id="mcp-keys"></div><div id="mcp-new-key" class="mcp-key-reveal" hidden></div></div></section>
      <section id="mcp-pane-settings" role="tabpanel" aria-labelledby="mcp-tab-settings" hidden><div class="mcp-section-body" id="mcp-settings-content"></div></section>
    </div>`;
  area.appendChild(panel); paint();
  filterContent = q('#mcp-filter-content');
  // Il drawer sposta gli stessi controlli fuori dal pannello, conservandone lo stato.
  for (const [event, handler] of [['click', onClick], ['input', onInput], ['change', onChange], ['submit', onSubmit]]) filterContent.addEventListener(event, e => { e.stopPropagation(); handler(e); });
  matchMedia('(max-width: 700px)').addEventListener('change', () => { if (filtersInSheet) closeNavigationSheet(true); filterContent.hidden = true; q('[data-action="toggle-filters"]').setAttribute('aria-expanded', 'false'); });
  $('#btn-mcp')?.addEventListener('click', openMcpPanel);
  panel.addEventListener('click', onClick);
  panel.addEventListener('submit', onSubmit);
  panel.addEventListener('input', onInput);
  panel.addEventListener('change', onChange);
  panel.addEventListener('keydown', e => {
    if (e.target.matches('[role="tab"]') && ['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) {
      e.preventDefault(); const tabs = [...panel.querySelectorAll('[role="tab"]')]; const i = tabs.indexOf(e.target);
      const target = tabs[e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      selectPane(target.dataset.pane); target.focus();
    }
    if (e.key === 'Escape' && !q('#mcp-detail').hidden && pane === 'activity') { e.preventDefault(); closeDetail(); }
  });
  document.addEventListener('visibilitychange', schedule);
  socket.on('disconnect', () => { if (visible()) { resetSecret(); generation++; requestSequence++; detailSequence++; clearTimeout(timer); clearActivity(); status = null; const form = q('#mcp-settings-form'); if (form) form.inert = true; error('Connessione interrotta. Riconnessione in corso…'); } });
  socket.on('connect', () => { if (visible()) refreshAll(); });
  $('#btn-logout')?.addEventListener('click', e => { if (creatingKey) { e.preventDefault(); e.stopImmediatePropagation(); error('Attendi il completamento della creazione: la nuova chiave viene mostrata una sola volta.'); return; } resetSecret(); generation++; clearTimeout(timer); clearActivity(); settings = null; status = null; identity = null; dirty = false; q('#mcp-settings-content').replaceChildren(); panel.hidden = true; panel.parentElement.classList.remove('mcp-open'); }, true);
  window.addEventListener('beforeunload', e => { if (visible() && (dirty || creatingKey)) { e.preventDefault(); e.returnValue = ''; } });
}

export async function openMcpPanel() {
  if (!panel) initMcpPanel();
  if (!panel) return;
  if (visible()) { q('#mcp-title').focus(); return; }
  opener = document.activeElement;
  closeDrawers({ immediate: true });
  panel.hidden = false; panel.parentElement.classList.add('mcp-open');
  q('#mcp-title').focus();
  q('#mcp-overview-content').innerHTML = '<p class="mcp-empty" role="status">Caricamento del servizio MCP…</p>';
  await refreshAll();
}

async function close() {
  if (creatingKey) { error('Attendi il completamento della creazione: la nuova chiave viene mostrata una sola volta.'); return; }
  if (dirty && !await chiediConferma('Chiudere MCP e scartare le modifiche alle impostazioni non salvate?')) return;
  generation++; requestSequence++; detailSequence++; clearTimeout(timer); clearTimeout(filterTimer); resetSecret();
  dirty = false; settings = null; status = null; panel.hidden = true; panel.parentElement.classList.remove('mcp-open');
  clearActivity(); q('#mcp-settings-content').replaceChildren();
  if (opener?.isConnected && opener.getClientRects().length) opener.focus(); else $('#conn-settings-btn')?.focus();
}

async function refreshAll() {
  const token = ++generation; clearError();
  try {
    const [res, auth] = await Promise.all([emit('mcp:status', {}), emit('auth:me', {})]);
    if (token !== generation || !visible()) return;
    const nextIdentity = `${auth.user?.id}:${auth.user?.rbac}`;
    if ((identity && nextIdentity !== identity) || !res.permissions?.manageSettings) { dirty = false; settings = null; q('#mcp-settings-content').replaceChildren(); }
    identity = nextIdentity;
    const form = q('#mcp-settings-form'); if (form) form.inert = false;
    status = res; renderOverview();
    await loadPane(pane);
  } catch (err) { if (token === generation && visible()) { if (!status) emptyState(q('#mcp-overview-content'), { kind: 'error', title: 'Servizio MCP non disponibile', description: err.message, actionLabel: 'Riprova', onAction: refreshAll }); if (pane !== 'overview' || status) paneError(pane, err); } }
  finally { if (token === generation) schedule(); }
}

function endpoint() { return status?.endpoint || `${location.origin}/mcp`; }
function clientConfiguration() {
  return JSON.stringify({ mcpServers: { codedb: {
    command: 'npx',
    args: ['-y', 'mcp-remote', endpoint(), ...(status?.rbac ? ['--header', 'Authorization:${CODEDB_AUTH_HEADER}'] : [])],
    ...(status?.rbac ? { env: { CODEDB_AUTH_HEADER: 'Bearer INSERISCI_LA_TUA_API_KEY' } } : {}),
  } } }, null, 2);
}
function renderOverview() {
  renderDataEmpty(q('#mcp-overview-content'), null);
  const names = { active: 'Attivo', draining: 'Disattivazione in corso', disabled: 'Disattivato' };
  const sessions = status.sessions || [];
  q('#mcp-overview-content').innerHTML = `
    <div class="mcp-service-surface"><div class="mcp-service-line"><div><h2>Gateway MCP <span class="mcp-service-state" data-state="${esc(status.state)}"><span class="mcp-status-dot" aria-hidden="true"></span>${esc(names[status.state] || 'Non disponibile')}</span></h2><p class="mcp-muted">${status.state === 'draining' ? 'Le operazioni avviate stanno terminando. Le nuove richieste sono sospese.' : 'Streamable HTTP · Stesso server e stessa porta di CodeDB.'}</p></div><button type="button" data-pane="settings"><i data-lucide="settings"></i> Configura MCP</button></div>
    <div class="mcp-endpoint"><label for="mcp-endpoint-value">Endpoint per il client</label><div><input type="text" readonly id="mcp-endpoint-value" value="${esc(endpoint())}"><button type="button" data-action="copy-endpoint" aria-label="Copia configurazione JSON MCP"><i data-lucide="copy" aria-hidden="true"></i> Copia JSON</button></div><p class="mcp-muted">Configurazione pronta da incollare. Richiede Node.js e CodeDB avviato.${status.rbac ? ' Nel JSON sostituisci INSERISCI_LA_TUA_API_KEY con una chiave creata in Connessioni e accessi.' : ''}</p></div>
    <p class="mcp-audit-health ${status.auditHealth?.ok === false ? 'mcp-danger' : ''}"><i data-lucide="${status.auditHealth?.ok === false ? 'shield-alert' : 'shield-check'}" aria-hidden="true"></i><span>${status.auditHealth?.ok === false ? `Registrazione attività non disponibile: ${esc(status.auditHealth.lastError || 'errore di scrittura del registro')}. Lo storico può essere incompleto.` : 'Registrazione attività operativa.'} ${status.auditHealth?.pending ? `${Number(status.auditHealth.pending)} eventi in salvataggio.` : ''}</span></p></div>
    <div class="mcp-section-title"><h2>Sessioni attive <span class="mcp-count">${sessions.length}</span></h2><button type="button" data-action="refresh-status" class="ghost"><i data-lucide="refresh-cw"></i> Aggiorna</button></div>
    ${sessions.length ? `<div class="mcp-session-list">${sessions.map(s=>`<article class="mcp-session"><span class="mcp-session-icon" aria-hidden="true"><i data-lucide="terminal"></i></span><div><strong>${esc(client(s.client))}</strong><p>${esc(s.user || 'Utente locale')} · ${Number(s.activeRequests || 0)} operazioni in corso</p><p class="mcp-muted">${esc((s.connections || []).map(c=>`${c.name}${c.dbType ? ` (${c.dbType})` : ''}`).join(', ') || 'Nessuna connessione DB aperta')}</p><p class="mcp-muted">Ultima attività: ${esc(date(s.lastActivity))}</p><code title="Identificativo sessione">${esc(s.id)}</code></div>${s.canClose === false ? '' : `<button type="button" data-action="close-session" data-id="${esc(s.id)}" class="ghost">Chiudi sessione</button>`}</article>`).join('')}</div>` : '<div class="mcp-empty"><i data-lucide="unplug" aria-hidden="true"></i><h3>Nessun client collegato</h3><p>Usa l’endpoint nel tuo client MCP. Le sessioni compariranno qui alla connessione.</p></div>'}
    <div class="mcp-section-title"><h2>Ultimi fallimenti</h2><button type="button" data-action="overview-errors" class="ghost">Apri attività</button></div><div id="mcp-recent-errors"><p class="mcp-muted">Caricamento…</p></div>`;
  paint(q('#mcp-overview-content'));
  if (!sessions.length) emptyState(q('#mcp-overview-content .mcp-empty'), { kind: 'connection', title: 'Nessun client collegato', description: 'Usa l’endpoint nel tuo client MCP. Le sessioni compariranno qui alla connessione.' });
  loadRecentErrors();
}

async function loadRecentErrors() {
  const token = generation;
  try { const res = await emit('mcp:activity:list', { limit: 5, status: 'failed', transient: true });
    if (token !== generation || !visible() || pane !== 'overview') return;
    q('#mcp-recent-errors').innerHTML = res.entries?.length ? res.entries.map(e=>`<button type="button" class="mcp-error-entry" data-action="open-activity" data-id="${esc(e.id)}"><span>${esc(e.tool || e.summary || 'Operazione MCP')}</span><span>${esc(e.error || labelStatus(e.status))}</span><time>${esc(date(e.ts))}</time></button>`).join('') : '<p class="mcp-muted">Nessun fallimento nel registro disponibile.</p>';
    paint(q('#mcp-recent-errors'));
  } catch (err) { if (token === generation && visible() && pane === 'overview') q('#mcp-recent-errors').textContent = `Attività non disponibili: ${err.message}`; }
}

async function selectPane(name) {
  if (filtersInSheet) closeNavigationSheet(true);
  if (!['overview','activity','access','settings'].includes(name)) return;
  if (creatingKey) { error('Attendi il completamento della creazione: la nuova chiave viene mostrata una sola volta.'); return; }
  if (name !== 'access') resetSecret();
  if (pane !== name) q('.mcp-content').scrollTop = 0;
  pane = name; clearError();
  panel.querySelectorAll('[role="tab"]').forEach(t => { t.setAttribute('aria-selected', String(t.dataset.pane === name)); t.tabIndex = t.dataset.pane === name ? 0 : -1; });
  panel.querySelectorAll('[role="tabpanel"]').forEach(p => { p.hidden = p.id !== `mcp-pane-${name}`; });
  try { await loadPane(name); } catch (err) { if (visible() && pane === name) paneError(name, err); }
  schedule();
}
async function loadPane(name) {
  if (name === 'overview' && status) renderOverview();
  if (name === 'activity') await loadActivity(true);
  if (name === 'access') await loadAccess();
  if (name === 'settings' && !dirty) await loadSettings();
}

function toggleFilters() {
  const trigger = q('[data-action="toggle-filters"]');
  if (matchMedia('(max-width: 700px)').matches) {
    filterContent.hidden = false; filtersInSheet = true; trigger.setAttribute('aria-expanded', 'true');
    openNavigationSheet(filterContent, () => { filtersInSheet = false; filterContent.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (visible() && pane === 'activity') trigger.focus({ preventScroll: true }); }, { title: 'Filtri attività MCP', description: 'I risultati si aggiornano mentre modifichi i filtri.', tools: false, navigation: false });
  } else {
    filterContent.hidden = !filterContent.hidden;
    trigger.setAttribute('aria-expanded', String(!filterContent.hidden));
  }
}
function filters() {
  const f = new FormData(q('#mcp-filters')), result = {};
  for (const [key,value] of f) if (String(value).trim()) result[key] = ['from','to'].includes(key) ? new Date(`${value}T${key === 'from' ? '00:00:00.000' : '23:59:59.999'}`).toISOString() : String(value).trim();
  return result;
}
function resetFilters() {
  q('#mcp-filters').reset();
  q('#mcp-filters').querySelectorAll('input[name], select[name]').forEach(control => {
    const prototype = control.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(control, '');
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
  clearTimeout(filterTimer);
}
async function loadActivity(reset = false) {
  const count = Object.keys(filters()).length;
  q('#mcp-filter-count').textContent = count ? `${count} ${count === 1 ? 'filtro attivo' : 'filtri attivi'}` : 'Nessun filtro attivo';
  const seq = ++requestSequence, token = generation;
  if (reset) { activity.offset = 0; activity.snapshot = null; closeDetail(false); }
  q('#mcp-activity-list').setAttribute('aria-busy', 'true');
  const current = filters();
  q('[data-action="errors"]').setAttribute('aria-pressed', String(current.status === 'failed'));
  q('[data-action="writes"]').setAttribute('aria-pressed', String(current.category === 'write'));
  renderDataEmpty(q('#mcp-activity-list'), null);
  q('.mcp-pager').hidden = true;
  q('#mcp-activity-list').innerHTML = `<span class="visually-hidden" role="status">Caricamento attività…</span><table class="mcp-table mcp-events mcp-loading" aria-hidden="true"><thead><tr>${['Ora / Azione','Bersaglio','Autore / Client','Durata','Esito','Dettagli'].map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: 5 }, () => `<tr>${Array.from({ length: 6 }, () => '<td><div class="skeleton skeleton-text"></div></td>').join('')}</tr>`).join('')}</tbody></table>`;
  try {
    const result = await emit('mcp:activity:list', { ...filters(), limit: activity.limit, offset: activity.offset, ...(activity.snapshot ? { snapshot: activity.snapshot } : {}) });
    if (seq !== requestSequence || token !== generation || !visible()) return;
    activity = { ...activity, ...result, entries: result.entries || [] };
    latestId = fingerprint(activity.entries);
    if (reset) q('#mcp-new-activity').hidden = true;
    renderActivity();
  } catch (err) { if (seq === requestSequence && token === generation) { if (!activity.entries.length) { q('.mcp-pager').hidden = true; q('#mcp-page-info').textContent = ''; emptyState(q('#mcp-activity-list'), { kind: 'error', title: 'Attività non disponibili', description: err.message, actionLabel: 'Riprova', onAction: () => loadActivity(true) }); } else { renderActivity(); error(err); } } }
  finally { if (seq === requestSequence) q('#mcp-activity-list').setAttribute('aria-busy', 'false'); }
}
function renderActivity() {
  clearError();
  renderDataEmpty(q('#mcp-activity-list'), null);
  const current = filters();
  q('[data-action="errors"]').setAttribute('aria-pressed', String(current.status === 'failed'));
  q('[data-action="writes"]').setAttribute('aria-pressed', String(current.category === 'write'));
  q('#mcp-activity-list').innerHTML = activity.entries.length ? `<table class="mcp-table mcp-events"><thead><tr><th>Ora / Azione</th><th>Bersaglio</th><th>Autore / Client</th><th>Durata</th><th>Esito</th><th><span class="visually-hidden">Dettagli</span></th></tr></thead><tbody>${activity.entries.map(e=>`<tr${e.id === selectedId ? ' class="selected"' : ''}><td><button type="button" class="mcp-row-open" data-action="detail" data-id="${esc(e.id)}" aria-label="Dettaglio ${esc(e.tool || 'attività')} del ${esc(date(e.ts))}"><span class="mcp-muted">${esc(date(e.ts))}</span><strong>${esc(e.tool || e.summary || 'Attività MCP')}</strong></button></td><td data-label="Bersaglio">${esc(e.connection || '—')}<span class="mcp-subline">${esc([e.db,e.coll].filter(Boolean).join(' › '))}</span></td><td data-label="Autore / Client">${esc(e.user || 'Non attribuito')}<span class="mcp-subline">${esc(client(e.client))}</span></td><td class="mcp-duration" data-label="Durata">${e.durationMs == null ? '—' : `${Number(e.durationMs).toLocaleString('it-IT')} ms`}</td><td class="mcp-event-status">${badge(e.status)}</td><td class="mcp-event-info"><button type="button" data-action="detail" data-id="${esc(e.id)}" aria-label="Informazioni ${esc(e.tool || 'evento')} del ${esc(date(e.ts))}"><i data-lucide="info" aria-hidden="true"></i>Info</button></td></tr>`).join('')}</tbody></table>` : '<div class="mcp-empty"><i data-lucide="list-filter" aria-hidden="true"></i><h3>Nessuna attività con questi filtri</h3><p>Modifica i filtri oppure esegui un’operazione dal tuo client MCP.</p></div>';
  const hasEntries = activity.entries.length > 0, showPager = hasEntries || (activity.offset > 0 && activity.total > 0);
  q('.mcp-pager').hidden = !showPager;
  const total = Math.max(activity.total || 0, activity.offset + activity.entries.length);
  q('#mcp-page-info').textContent = hasEntries ? `${activity.offset + 1}–${activity.offset + activity.entries.length} di ${total}` : '';
  q('[data-action="prev"]').disabled = activity.offset === 0;
  q('[data-action="next"]').disabled = activity.offset + activity.entries.length >= total;
  q('#mcp-activity-note').textContent = activity.truncated ? 'Lo storico disponibile è limitato dalla conservazione del registro.' : 'Anteprime e conferme sono distinte dalle operazioni eseguite. I dati sensibili vengono mascherati.';
  paint(q('#mcp-activity-list'));
  if (!activity.entries.length) {
    const filtered = Object.keys(current).length > 0;
    emptyState(q('#mcp-activity-list'), { kind: filtered ? 'search' : 'data', title: filtered ? 'Nessuna attività con questi filtri' : 'Nessuna attività registrata', description: filtered ? 'Modifica i filtri per cercare altre attività.' : 'Esegui un’operazione dal tuo client MCP per visualizzarla qui.', ...(filtered ? { actionLabel: 'Azzera filtri', onAction: () => { resetFilters(); loadActivity(true); } } : {}) });
  }
}
async function openDetail(id) {
  const seq = ++detailSequence, token = generation; selectedId = id;
  panel.querySelectorAll('.mcp-activity-list tr').forEach(row => row.classList.toggle('selected', row.querySelector('[data-action="detail"]')?.dataset.id === id));
  detailScrollTop = q('.mcp-content').scrollTop;
  const aside = q('#mcp-detail'); aside.hidden = false; aside.innerHTML = '<p class="mcp-empty" role="status">Caricamento dettaglio…</p>';
  q('.mcp-activity-layout').classList.add('has-detail');
  if (matchMedia('(max-width: 700px)').matches) q('.mcp-content').scrollTop = 0;
  try { const { entry } = await emit('mcp:activity:get', { id });
    if (seq !== detailSequence || token !== generation || !visible()) return;
    if (!entry) throw new Error('Attività non più disponibile nel registro.');
    aside.innerHTML = `<div class="mcp-detail-head"><h2 tabindex="-1">${esc(entry.tool || 'Attività MCP')}</h2><button type="button" data-action="close-detail" class="ghost" aria-label="Chiudi dettaglio"><i data-lucide="x"></i></button></div>${badge(entry.status)}
      <dl class="mcp-metadata"><dt>Quando</dt><dd>${esc(date(entry.ts))}</dd><dt>Connessione</dt><dd>${esc(entry.connection || 'Non disponibile')}</dd><dt>Bersaglio</dt><dd>${esc([entry.db,entry.coll].filter(Boolean).join(' › ') || 'Non disponibile')}</dd><dt>Autore</dt><dd>${esc(entry.user || 'Storico non attribuibile')}</dd><dt>Client dichiarato</dt><dd>${esc(client(entry.client))}</dd><dt>Durata</dt><dd>${entry.durationMs == null ? 'Non disponibile' : `${Number(entry.durationMs).toLocaleString('it-IT')} ms`}</dd><dt>Invocazione</dt><dd><code>${esc(entry.invocationId || entry.id)}</code></dd>${entry.operationId ? `<dt>Operazione</dt><dd><code>${esc(entry.operationId)}</code></dd>` : ''}</dl>
      ${entry.summary ? `<p>${esc(pretty(entry.summary))}</p>` : ''}${entry.error ? `<p class="mcp-message">${esc(entry.error)}</p>` : ''}
      ${[['parameters','Parametri'],['result','Risultato sintetico'],['events','Sequenza degli eventi']].filter(([key])=>entry[key]!=null).map(([key,label])=>`<details open><summary>${label}</summary><pre>${esc(pretty(entry[key]))}</pre></details>`).join('')}`;
    paint(aside); aside.querySelector('h2').focus();
  } catch (err) { if (seq === detailSequence && token === generation) { aside.innerHTML = `<button type="button" data-action="close-detail">Torna all’elenco</button><p role="alert">${esc(err.message)}</p>`; paint(aside); } }
}
function closeDetail(focus = true) { detailSequence++; q('#mcp-detail').hidden = true; q('.mcp-activity-layout').classList.remove('has-detail'); panel.querySelectorAll('.mcp-activity-list tr.selected').forEach(row => row.classList.remove('selected')); if (focus && selectedId) { panel.querySelector(`[data-action="detail"][data-id="${CSS.escape(selectedId)}"]`)?.focus({ preventScroll: true }); q('.mcp-content').scrollTop = detailScrollTop; } selectedId = null; }

async function loadSettings() {
  const token = generation, seq = ++settingsSequence, edits = settingsEdits;
  const res = await emit('mcp:settings:get', {});
  if (token !== generation || seq !== settingsSequence || edits !== settingsEdits || !visible()) return;
  settings = res; dirty = false;
  clearError(); renderDataEmpty(q('#mcp-settings-content'), null);
  const canManage = !!status?.permissions?.manageSettings;
  const saveBar = '<div class="mcp-settings-footer"><span id="mcp-dirty" role="status">Impostazioni salvate</span><div><button type="button" data-action="discard-settings" disabled>Scarta modifiche</button><button type="submit" class="primary" id="mcp-save-settings" disabled>Salva impostazioni</button></div></div>';
  q('#mcp-settings-content').innerHTML = `<div class="mcp-section-title"><div><h2>Impostazioni del gateway</h2><p class="mcp-muted">Configurazione persistente dell’installazione. I cambiamenti salvati si applicano al servizio.</p></div></div>${canManage ? '' : '<p class="mcp-notice">Puoi consultare la configurazione. Le modifiche sono riservate all’amministratore dell’installazione.</p>'}
    <form id="mcp-settings-form">${saveBar}${CAMPI.map(([title, fields])=>`<fieldset class="mcp-settings-group"><legend>${title}</legend>${fields.map(([key,label,hint,type,min,max])=>{ const override = res.overrides?.[key]; const value = res.values[key]; return `<div class="mcp-setting-row"><div><label for="mcp-setting-${key}">${label}</label><p id="mcp-hint-${key}">${hint}${override ? ` <strong>Imposto da ${esc(override)}.</strong>` : ''}</p></div><input id="mcp-setting-${key}" name="${key}" type="${type === 'boolean' ? 'checkbox' : 'number'}" ${type === 'boolean' ? (value ? 'checked' : '') : `value="${esc(String(value))}" min="${min}" max="${max}" step="1" required`} aria-describedby="mcp-hint-${key}" ${!canManage || override ? 'disabled' : ''}></div>`; }).join('')}</fieldset>`).join('')}</form>`;
  paint(q('#mcp-settings-content'));
  if (res.applied === false) error(res.applyError || 'Impostazioni salvate, ma non applicate completamente al servizio.');
}
function readSettings() { return Object.fromEntries(CAMPI.flatMap(([,fields])=>fields.map(([key,,,type])=>[key,type === 'boolean' ? q(`#mcp-setting-${key}`).checked : Number(q(`#mcp-setting-${key}`).value)]))); }
function updateDirty() { if (!settings) return; const current = readSettings(); dirty = Object.keys(current).some(k => current[k] !== settings.values[k]); q('.mcp-settings-footer').dataset.dirty = String(dirty); q('#mcp-dirty').textContent = dirty ? 'Modifiche non salvate' : 'Impostazioni salvate'; q('#mcp-save-settings').disabled = !dirty || busy; q('[data-action="discard-settings"]').disabled = !dirty || busy; }

async function loadAccess() {
  const token = generation;
  const res = await emit('mcp:connections:list', {});
  if (token !== generation || !visible()) return;
  const connections = res.connections || [];
  clearError(); renderDataEmpty(q('#mcp-connections'), null);
  q('#mcp-connections').innerHTML = `<div class="mcp-section-title"><h2>Connessioni disponibili</h2><button type="button" data-action="refresh-access" class="ghost">Aggiorna</button></div><p class="mcp-muted">La sola lettura della connessione è condivisa con la UI. I permessi effettivi MCP includono anche le restrizioni del gateway e del soggetto.</p>${connections.length ? `<div class="mcp-table-scroll"><table class="mcp-table"><thead><tr><th>Connessione</th><th>Motore</th><th>Accesso</th><th>Gestione</th></tr></thead><tbody>${connections.map(c=>`<tr><td><strong>${esc(c.label || c.name)}</strong></td><td>${esc(c.dbType || '—')}</td><td>${c.readOnly ? 'Sola lettura' : 'Scrittura consentita dalla connessione'}${status?.settings?.readOnly || status?.readOnly ? '<span class="mcp-subline">MCP limitato alla lettura</span>' : ''}${c.permissions ? `<span class="mcp-subline">${esc(permissionsText(c.permissions))}</span>` : ''}</td><td>${c.canManage ? `<button type="button" data-action="readonly" data-name="${esc(c.name)}" data-value="${!c.readOnly}">${c.readOnly ? 'Consenti scritture' : 'Imposta sola lettura'}</button>` : 'Permessi gestiti dall’amministratore'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="mcp-empty">Nessuna connessione disponibile. Aggiungila da Connessioni o richiedi l’accesso all’amministratore.</div>'}`;
  paint(q('#mcp-connections'));
  if (!connections.length) emptyState(q('#mcp-connections .mcp-empty'), { kind: 'connection', title: 'Nessuna connessione disponibile', description: 'Aggiungila da Connessioni o richiedi l’accesso all’amministratore.' });
  if (!status?.rbac) { q('#mcp-keys').innerHTML = '<h2>Accesso dei client</h2><p class="mcp-notice">CodeDB è in modalità locale, con RBAC disattivato. Le API key sono disponibili quando l’autenticazione RBAC è attiva nell’installazione.</p>'; return; }
  if (!status.permissions?.manageAccess) { q('#mcp-keys').innerHTML = '<h2>API key</h2><p class="mcp-notice">Le chiavi di accesso sono gestite dall’amministratore del tuo account.</p>'; return; }
  const [keys, users] = await Promise.all([emit('apikeys:list', {}), emit('users:list', {})]);
  if (token !== generation || !visible()) return;
  const subjects = users.users || [];
  q('#mcp-keys').innerHTML = `<h2>API key</h2><p class="mcp-muted">Ogni chiave eredita i permessi del soggetto e può restringere le connessioni. Il segreto viene mostrato soltanto alla creazione.</p>
    <form id="mcp-key-form" class="mcp-key-form"><label>Nome della chiave<input name="label" required maxlength="120" placeholder="Es. Codex locale" autocomplete="off"></label><label>Soggetto<select name="subjectId"><option value="">Il mio account</option>${subjects.map(u=>`<option value="${esc(u.id)}">${esc(u.email || u.displayName || u.id)}</option>`).join('')}</select></label><fieldset><legend>Connessioni consentite</legend><label><input type="checkbox" id="mcp-key-all" checked> Tutte quelle concesse al soggetto</label><div id="mcp-key-scopes" hidden>${connections.map(c=>`<label><input type="checkbox" name="connScope" value="${esc(c.name)}"> ${esc(c.label || c.name)}</label>`).join('')}</div></fieldset><button type="submit" class="primary">Crea API key</button></form>
    ${keys.keys?.length ? `<div class="mcp-table-scroll"><table class="mcp-table"><thead><tr><th>Nome / Prefisso</th><th>Soggetto</th><th>Connessioni</th><th>Ultimo uso</th><th>Gestione</th></tr></thead><tbody>${keys.keys.map(k=>`<tr><td>${esc(k.label || 'Senza nome')}<code class="mcp-subline">${esc(k.prefix)}…</code></td><td>${esc(subjects.find(u=>u.id === k.subjectId)?.email || k.subjectId)}</td><td>${esc(k.connScope?.length ? k.connScope.join(', ') : 'Tutte le concesse')}</td><td>${esc(date(k.lastUsedAt))}</td><td><button type="button" data-action="revoke-key" data-id="${esc(k.id)}">Revoca</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="mcp-muted">Nessuna API key creata.</p>'}`;
  paint(q('#mcp-keys'));
}

function schedule() { clearTimeout(timer); if (visible() && !document.hidden && socket.connected) timer = setTimeout(poll, 5000); }
async function poll() {
  const token = generation;
  try {
    if (!visible() || document.hidden) return;
    const res = await emit('mcp:status', {});
    if (token !== generation || !visible()) return;
    status = res;
    if (pane === 'overview' && !q('#mcp-overview-content').contains(document.activeElement)) renderOverview();
    if (pane === 'activity' && !paused && latestId !== null) {
      const recent = await emit('mcp:activity:list', { ...filters(), limit: activity.limit, offset: activity.offset, transient: true });
      if (token !== generation || !visible() || pane !== 'activity') return;
      if (fingerprint(recent.entries || []) !== latestId) q('#mcp-new-activity').hidden = false;
    }
  } catch (err) { if (token === generation && visible() && !hasPaneError()) error(err); }
  finally { if (token === generation) schedule(); }
}

async function action(work) { if (busy) return; busy = true; clearError(); q('#mcp-operation-status').hidden = false; try { await work(); } catch (err) { if (visible()) error(err); } finally { busy = false; q('#mcp-operation-status').hidden = true; if (settings && q('#mcp-settings-form')) updateDirty(); } }
const copyTimers = new WeakMap();
async function copy(text, button) {
  if (!navigator.clipboard?.writeText) throw new Error('Copia automatica non disponibile: seleziona il testo e copialo con la tastiera.');
  await navigator.clipboard.writeText(text);
  clearTimeout(copyTimers.get(button));
  const label = button.dataset.action === 'copy-key' ? 'Copia chiave' : 'Copia JSON';
  button.innerHTML = '<i data-lucide="check" aria-hidden="true"></i> Copiato';
  refreshLucideIcons(button);
  copyTimers.set(button, setTimeout(() => { button.innerHTML = `<i data-lucide="copy" aria-hidden="true"></i> ${label}`; refreshLucideIcons(button); copyTimers.delete(button); }, 2000));
}
function onInput(e) { if (e.target.closest('#mcp-settings-form')) { settingsEdits++; updateDirty(); } if (e.target.closest('#mcp-filters')) { clearTimeout(filterTimer); filterTimer = setTimeout(()=>loadActivity(true), 400); } }
function onChange(e) { if (e.target.closest('#mcp-settings-form')) { settingsEdits++; updateDirty(); } if (e.target.closest('#mcp-filters') && e.target.matches('select')) { clearTimeout(filterTimer); loadActivity(true); } if (e.target.id === 'mcp-page-size') { activity.limit = Number(e.target.value); loadActivity(true); } if (e.target.id === 'mcp-key-all') q('#mcp-key-scopes').hidden = e.target.checked; }
function onClick(e) {
  const button = e.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.pane) { selectPane(button.dataset.pane); return; }
  const name = button.dataset.action;
  if (!name) return;
  if (name === 'toggle-filters') { toggleFilters(); return; }
  if (name === 'close-filters') { if (filtersInSheet) closeNavigationSheet(); else { filterContent.hidden = true; q('[data-action="toggle-filters"]').setAttribute('aria-expanded', 'false'); q('[data-action="toggle-filters"]').focus(); } return; }
  if (name === 'close') { close(); return; }
  if (name === 'close-detail') { closeDetail(); return; }
  if (name === 'detail') { openDetail(button.dataset.id); return; }
  if (name === 'refresh-activity') { loadActivity(true); return; }
  if (name === 'live') { paused = !paused; button.setAttribute('aria-pressed', String(!paused)); button.innerHTML = `<i data-lucide="${paused ? 'play' : 'pause'}"></i> ${paused ? 'Riprendi aggiornamenti' : 'Pausa aggiornamenti'}`; q('#mcp-live-state').dataset.paused = String(paused); q('#mcp-live-state').innerHTML = `<span class="mcp-status-dot" aria-hidden="true"></span>${paused ? 'Aggiornamento in pausa' : 'Aggiornamento attivo'}`; refreshLucideIcons(button); return; }
  if (name === 'prev' || name === 'next') { activity.offset = Math.max(0, activity.offset + (name === 'prev' ? -activity.limit : activity.limit)); loadActivity(); return; }
  if (['errors','writes','reset-filters','overview-errors'].includes(name)) { resetFilters(); if (name === 'errors' || name === 'overview-errors') q('[name="status"]').value = 'failed'; if (name === 'writes') q('[name="category"]').value = 'write'; if (name === 'overview-errors') selectPane('activity'); else loadActivity(true); return; }
  if (name === 'open-activity') { selectPane('activity').then(()=>openDetail(button.dataset.id)); return; }
  if (name === 'copy-endpoint' || name === 'copy-key') {
    clearError();
    copy(name === 'copy-endpoint' ? clientConfiguration() : q('#mcp-secret').value, button).catch(err => { if (visible()) error(err); });
    return;
  }
  action(async () => {
    if (name === 'refresh-status') await refreshAll();
    if (name === 'refresh-access') { try { await loadAccess(); } catch (err) { paneError('access', err); } }
    if (name === 'discard-settings') { if (await chiediConferma('Scartare le modifiche alle impostazioni?')) await loadSettings(); }
    if (name === 'close-session' && await chiediConferma('Chiudere questa sessione MCP? Le operazioni già avviate vengono attese; il client dovrà riconnettersi.')) { await emit('mcp:sessions:close', { id: button.dataset.id }); await refreshAll(); }
    if (name === 'readonly' && await chiediConferma(`Impostare “${button.dataset.name}” ${button.dataset.value === 'true' ? 'in sola lettura' : 'come scrivibile'}? La proprietà della connessione è condivisa con la UI.`)) { await emit('mcp:connections:readonly', { name: button.dataset.name, readOnly: button.dataset.value === 'true' }); await loadAccess(); }
    if (name === 'revoke-key' && await chiediConferma('Revocare questa API key? Le successive richieste del client saranno rifiutate.')) { await emit('apikeys:revoke', { id: button.dataset.id }); resetSecret(); await loadAccess(); }
    if (name === 'hide-key') resetSecret();
    if (name === 'export-json' || name === 'export-csv') { const res = await emit('mcp:activity:export', { ...filters(), format: name === 'export-csv' ? 'csv' : 'json', ...(activity.snapshot ? { snapshot: activity.snapshot } : {}) }); await scaricaFile(new Blob([res.content], { type: res.mimeType }), res.filename); if (res.truncated) error('Esportazione limitata al registro disponibile.'); }
  });
}
function onSubmit(e) {
  e.preventDefault();
  if (e.target.id === 'mcp-filters') { clearTimeout(filterTimer); loadActivity(true); return; }
  if (e.target.id === 'mcp-settings-form') action(async () => {
    const values = readSettings();
    const patch = Object.fromEntries(Object.entries(values).filter(([key,value])=>!settings.overrides?.[key] && value !== settings.values[key]));
    q('#mcp-save-settings').disabled = true;
    const form = e.target; form.inert = true;
    let result;
    try { result = await emit('mcp:settings:update', { values: patch, revision: settings.revision }); }
    finally { form.inert = false; }
    dirty = false; await loadSettings(); status = await emit('mcp:status', {});
    if (result.applied === false) error(result.applyError || 'Impostazioni salvate, ma non applicate completamente al servizio.');
    else toast('Impostazioni MCP salvate e applicate.');
  });
  if (e.target.id === 'mcp-key-form') action(async () => {
    const token = generation, form = new FormData(e.target), all = q('#mcp-key-all').checked;
    const connScope = all ? [] : form.getAll('connScope');
    if (!all && !connScope.length) throw new Error('Seleziona almeno una connessione oppure consenti tutte quelle del soggetto.');
    creatingKey = true;
    let res;
    try { res = await emit('apikeys:create', { label: form.get('label').trim(), subjectId: form.get('subjectId') || undefined, connScope }); }
    catch (err) { throw new Error(`Creazione della chiave non confermata: ${err.message} Verifica l’elenco delle chiavi prima di riprovare.`); }
    finally { creatingKey = false; }
    if (token !== generation || !visible() || pane !== 'access') return;
    const box = q('#mcp-new-key'); box.hidden = false;
    box.innerHTML = '<h3>API key creata</h3><p>Copiala ora nel tuo client. Alla chiusura di questa sezione il segreto non sarà più visibile.</p><label for="mcp-secret">Chiave segreta</label><textarea id="mcp-secret" readonly autocomplete="off" spellcheck="false"></textarea><div><button type="button" data-action="copy-key">Copia chiave</button><button type="button" data-action="hide-key" class="ghost">Ho salvato la chiave</button></div>';
    q('#mcp-secret').value = res.key; paint(box); q('#mcp-secret').focus(); box.scrollIntoView({ block: 'nearest' });
    await loadAccess();
  });
}
