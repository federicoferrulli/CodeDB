'use strict';

import { $, emit, esc, openModal, closeModal, dbTypeIcon, iniziaCaricamento, lucideIconHtml as ICO, refreshLucideIcons } from './utils.js';
import { closeNavigationSheet, renderDataEmpty } from '../arc/ui.js';

let autoTimer = null;
let richiesta = null;
let apertura = 0;
const REFRESH_MS = 4000;
const ridotto = window.matchMedia('(prefers-reduced-motion: reduce)');
const visibile = () => !$('#modal-health').classList.contains('hidden');

export function initHealth() {
  $('#btn-health')?.addEventListener('click', () => {
    closeNavigationSheet(true);
    apertura++;
    openModal('#modal-health');
    fetchHealth();
  });
  $('#btn-close-health-modal')?.addEventListener('click', () => {
    stopAuto();
    closeModal('#modal-health');
  });
  $('#btn-refresh-health')?.addEventListener('click', fetchHealth);
  $('#health-auto-refresh')?.addEventListener('change', startAuto);
  $('#modal-health').addEventListener('codedb:dialog-closed', () => {
    apertura++;
    stopAuto();
    $('#health-list').getAnimations({ subtree: true }).forEach(a => a.cancel());
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAuto();
    else if (visibile()) fetchHealth();
  });
  ridotto.addEventListener('change', () => {
    if (ridotto.matches) $('#health-list').getAnimations({ subtree: true }).forEach(a => a.cancel());
  });
}

function startAuto() {
  stopAuto();
  // Si attende la risposta prima dei quattro secondi: un ping lento non crea richieste sovrapposte.
  if (visibile() && !document.hidden && !richiesta && $('#health-auto-refresh').checked) {
    autoTimer = setTimeout(fetchHealth, REFRESH_MS);
  }
}

function stopAuto() {
  clearTimeout(autoTimer);
  autoTimer = null;
}

function fetchHealth() {
  if (!visibile() || document.hidden) return;
  if (richiesta) return richiesta;
  stopAuto();
  const ciclo = apertura;
  const container = $('#health-list');
  const fine = iniziaCaricamento($('#btn-refresh-health'), 'Verifica…');
  $('#modal-health').classList.add('health-checking');
  container.setAttribute('aria-busy', 'true');
  if (!container.dataset.loaded) {
    container.innerHTML = '<div class="loading-spinner" role="status">Verifica delle connessioni…</div>';
  }
  richiesta = (async () => {
    try {
      const res = await emit('health:connections', {});
      if (ciclo !== apertura || !visibile()) return;
      render(res.connections || []);
      container.dataset.loaded = '1';
      $('#health-error').classList.add('hidden');
      const orario = new Date().toLocaleTimeString('it-IT');
      $('#health-checked').dataset.orario = orario;
      $('#health-checked').textContent = `Ultima verifica · ${orario}`;
    } catch (err) {
      if (ciclo !== apertura || !visibile()) return;
      $('#health-error').textContent = `Verifica non riuscita: ${err.message}. Premi Aggiorna per riprovare.`;
      $('#health-error').classList.remove('hidden');
      impostaEsito('triangle-alert', 'Verifica non riuscita', 'health-err');
      if (container.dataset.loaded) $('#health-checked').textContent = `Ultima riuscita · ${$('#health-checked').dataset.orario}`;
      else container.innerHTML = '';
    } finally {
      richiesta = null;
      fine();
      container.removeAttribute('aria-busy');
      $('#modal-health').classList.remove('health-checking');
      // Una riapertura durante il ping scarta la vecchia risposta e avvia una verifica fresca.
      if (ciclo !== apertura && visibile()) fetchHealth();
      else startAuto();
    }
  })();
  return richiesta;
}

function impostaEsito(icon, label, classe = '') {
  const el = $('#health-summary');
  if (el.dataset.label === label) return;
  el.dataset.label = label;
  el.className = classe;
  el.innerHTML = `${ICO(icon)}<span>${esc(label)}</span>`;
  refreshLucideIcons(el);
}

function sshCell(ssh) {
  if (!ssh?.active) return '<span class="health-secondary">Connessione diretta</span>';
  if (ssh.alive) return `<span class="health-ok">${ICO('shield-check')} Attivo</span><small class="health-detail">${esc(ssh.host || '')}${ssh.port ? `:${esc(String(ssh.port))}` : ''}</small>`;
  return `<span class="health-err">${ICO('shield-alert')} Interrotto</span>${ssh.lastError ? `<small class="health-detail">${esc(ssh.lastError)}</small>` : ''}`;
}

function poolCell(c) {
  const p = c.pool;
  if (!p) {
    const n = c.extra?.servers;
    return n != null ? `<strong>${esc(String(n))} server</strong><small class="health-detail">Topologia MongoDB</small>` : '<span class="health-secondary">Non disponibile</span>';
  }
  const bits = [];
  if (p.idle != null) bits.push(`${esc(String(p.idle))} libere`);
  if (p.waiting) bits.push(`<span class="health-warn">${esc(String(p.waiting))} in coda</span>`);
  return `<strong>${esc(String(p.active ?? '—'))}<span class="health-secondary"> / ${esc(String(p.limit ?? '—'))}</span></strong> attive${bits.length ? `<small class="health-detail">${bits.join(' · ')}</small>` : ''}`;
}

function anima(el, nuova, ordine = 0) {
  el.getAnimations().forEach(a => a.cancel());
  if (ridotto.matches || !visibile()) return;
  const a = el.animate([
    { opacity: nuova ? 0 : .45, transform: `translateY(${nuova ? 8 : 4}px)` },
    { opacity: 1, transform: 'none' },
  ], { duration: nuova ? 280 : 200, delay: nuova ? Math.min(ordine * 35, 140) : 0, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
  a.finished.then(() => a.cancel(), () => {});
}

function render(connections) {
  const container = $('#health-list');
  if (!connections.length) {
    impostaEsito('unplug', 'Nessuna connessione aperta');
    if (!container.classList.contains('data-empty-container')) {
      container.innerHTML = '';
      renderDataEmpty(container, { kind: 'connection', title: 'Nessuna connessione da monitorare', description: 'Apri una connessione per vedere latenza, tunnel SSH e pool.' });
    }
    return;
  }
  const errore = connections.some(c => c.status !== 'ok' || (c.ssh?.active && !c.ssh.alive));
  const lenta = connections.some(c => c.latencyMs >= 200);
  const coda = connections.some(c => c.pool?.waiting > 0);
  impostaEsito(errore ? 'circle-alert' : lenta || coda ? 'triangle-alert' : 'circle-check', errore ? 'Connessioni da verificare' : coda ? 'Richieste in attesa' : lenta ? 'Latenza elevata' : 'Tutte raggiungibili', errore ? 'health-err' : lenta || coda ? 'health-warn' : 'health-ok');
  renderDataEmpty(container, null);
  let tbody = container.querySelector('tbody');
  if (!tbody) {
    container.innerHTML = `<table class="health-table" role="table" aria-label="Diagnostica delle connessioni">
      <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Connessione</th><th scope="col" role="columnheader">Ping</th><th scope="col" role="columnheader">Tunnel SSH</th><th scope="col" role="columnheader">Pool</th></tr></thead><tbody role="rowgroup"></tbody></table>`;
    tbody = container.querySelector('tbody');
  }
  const presenti = new Map([...tbody.children].map(row => [row.dataset.key, row]));
  connections.forEach((c, index) => {
    const key = String(c.tabId ?? index);
    let row = presenti.get(key);
    const nuova = !row;
    if (!row) {
      row = document.createElement('tr');
      row.dataset.key = key;
      row.setAttribute('role', 'row');
      row.innerHTML = `<th scope="row" role="rowheader"><div class="health-value"></div></th>${['Ping', 'Tunnel SSH', 'Pool'].map(label => `<td role="cell"><span class="health-mobile-label" aria-hidden="true">${label}</span><div class="health-value"></div></td>`).join('')}`;
    }
    presenti.delete(key);
    const ok = c.status === 'ok';
    const ms = Number.isFinite(c.latencyMs) && c.latencyMs >= 0 ? c.latencyMs : null;
    const classe = ms < 50 ? 'health-ok' : ms < 200 ? 'health-warn' : 'health-err';
    const qualita = ms < 50 ? 'Rapida' : ms < 200 ? 'Moderata' : 'Elevata';
    const tipo = { mongodb: 'MongoDB', mysql: 'MySQL', postgresql: 'PostgreSQL' }[c.dbType] || c.dbType || 'Database';
    const cells = [
      `<div class="health-identity">${dbTypeIcon(c.dbType)}<div><strong>${esc(c.connName || c.label || '(senza nome)')}</strong><div class="health-identity-meta"><span>${esc(tipo)}</span><span class="${ok ? 'health-ok' : 'health-err'}">${ICO(ok ? 'circle-check' : 'circle-x')} ${ok ? 'Attiva' : 'Errore'}</span></div></div></div>${!ok && c.error ? `<p class="health-connection-error">${esc(c.error)}</p>` : ''}`,
      ok && ms !== null ? `<span class="health-ping ${classe}">${esc(String(ms))}<small>ms</small></span><small class="health-detail">${qualita}</small>` : '<span class="health-ping health-secondary">—</span><small class="health-detail">Non disponibile</small>',
      sshCell(c.ssh), poolCell(c),
    ];
    cells.forEach((html, i) => {
      const cell = row.cells[i].querySelector('.health-value');
      if (cell._healthHtml === html) return;
      cell.innerHTML = html;
      cell._healthHtml = html;
      refreshLucideIcons(cell);
      if (!nuova) anima(cell, false);
    });
    if (tbody.children[index] !== row) tbody.insertBefore(row, tbody.children[index] || null);
    if (nuova) anima(row, true, index);
  });
  presenti.forEach(row => row.remove());
}
