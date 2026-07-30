'use strict';

// Pannello "Salute delle Connessioni": stato in tempo reale delle connessioni
// attive (una per tab aperto sul socket). Mostra latenza del ping, stato del
// tunnel SSH e statistiche del pool, con auto-refresh mentre la modale è aperta.
//
// I dati arrivano dall'evento socket `health:connections`, che pinga ogni
// sessione lato server (in parallelo, con timeout) e legge lo stato del tunnel.

import { $, emit, esc } from './utils.js';

let autoTimer = null;
const REFRESH_MS = 4000;

export function initHealth() {
  const btn = $('#btn-health');
  const dockBtn = $('#conn-dock-health');
  if (btn) btn.addEventListener('click', openHealthModal);
  if (dockBtn) dockBtn.addEventListener('click', openHealthModal);

  const close = $('#btn-close-health-modal');
  if (close) close.addEventListener('click', closeHealthModal);

  const refresh = $('#btn-refresh-health');
  if (refresh) refresh.addEventListener('click', fetchHealth);

  const auto = $('#health-auto-refresh');
  if (auto) auto.addEventListener('change', () => {
    if (auto.checked) startAuto(); else stopAuto();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal-health').classList.contains('hidden')) closeHealthModal();
  });
}

function openHealthModal() {
  $('#modal-health').classList.remove('hidden');
  fetchHealth();
  if ($('#health-auto-refresh').checked) startAuto();
}

function closeHealthModal() {
  $('#modal-health').classList.add('hidden');
  stopAuto(); // niente polling quando la modale è chiusa
}

function startAuto() {
  stopAuto();
  autoTimer = setInterval(fetchHealth, REFRESH_MS);
}

function stopAuto() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}

async function fetchHealth() {
  const container = $('#health-list');
  if (!container) return;
  // Al primo caricamento mostra lo spinner; ai refresh successivi non svuota
  // la tabella (evita lo sfarfallio), la sostituisce quando arrivano i dati.
  if (!container.dataset.loaded) {
    container.innerHTML = '<div class="loading-spinner">Verifica delle connessioni in corso...</div>';
  }
  try {
    const res = await emit('health:connections', {});
    render(res.connections || []);
    container.dataset.loaded = '1';
  } catch (err) {
    container.innerHTML = `<div class="error-box">Errore nel recupero dello stato: ${esc(err.message)}</div>`;
  }
}

// Classe di latenza per la colorazione: verde < 50ms, ambra < 200ms, rosso oltre.
function latencyClass(ms) {
  if (ms < 50) return 'health-lat-good';
  if (ms < 200) return 'health-lat-warn';
  return 'health-lat-bad';
}

function sshCell(ssh) {
  if (!ssh || !ssh.active) return '<span class="sub-text">—</span>';
  if (ssh.alive) {
    return `<span class="health-ok">🟢 Attivo</span> <span class="sub-text">${esc(ssh.host || '')}:${esc(String(ssh.port || ''))}</span>`;
  }
  const err = ssh.lastError ? ` <span class="sub-text">(${esc(ssh.lastError)})</span>` : '';
  return `<span class="health-err">🔴 Caduto</span>${err}`;
}

function poolCell(c) {
  const p = c.pool;
  if (!p) {
    // MongoDB non espone il pool: eventuale numero di server della topology.
    if (c.extra && c.extra.servers != null) return `<span class="sub-text">${esc(String(c.extra.servers))} server (topology)</span>`;
    return '<span class="sub-text">n/d</span>';
  }
  const active = p.active != null ? p.active : '?';
  const limit = p.limit != null ? p.limit : '?';
  const bits = [`<strong>${esc(String(active))}</strong>/${esc(String(limit))} attive`];
  if (p.idle != null) bits.push(`${esc(String(p.idle))} idle`);
  if (p.waiting) bits.push(`<span class="health-err">${esc(String(p.waiting))} in coda</span>`);
  return bits.join(' · ');
}

function render(connections) {
  const container = $('#health-list');
  if (!connections.length) {
    container.innerHTML = '<div class="empty-state">Nessuna connessione attiva. Apri una connessione in un tab per monitorarla.</div>';
    return;
  }

  let rows = '';
  for (const c of connections) {
    const ok = c.status === 'ok';
    const name = esc(c.connName || c.label || '(senza nome)');
    const dbType = c.dbType ? `<span class="sub-text">${esc(c.dbType)}</span>` : '';
    const latency = ok
      ? `<span class="health-lat ${latencyClass(c.latencyMs)}">${esc(String(c.latencyMs))} ms</span>`
      : '<span class="sub-text">—</span>';
    const status = ok
      ? '<span class="health-ok">🟢 Attiva</span>'
      : `<span class="health-err">🔴 Errore</span><div class="sub-text">${esc(c.error || '')}</div>`;

    rows += `
      <tr class="${ok ? '' : 'audit-row-err'}">
        <td>${name}<div>${dbType}</div></td>
        <td>${latency}</td>
        <td>${sshCell(c.ssh)}</td>
        <td>${poolCell(c)}</td>
        <td>${status}</td>
      </tr>
    `;
  }

  container.innerHTML = `
    <table class="backup-table health-table">
      <thead>
        <tr>
          <th>Connessione</th>
          <th>Ping</th>
          <th>Tunnel SSH</th>
          <th>Pool</th>
          <th>Stato</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
