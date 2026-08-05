'use strict';

import { $ } from './utils.js';

// Modalità mobile/tablet (vedi media query in style.css): le due sidebar
// diventano drawer a scomparsa pilotati dagli hamburger nell'header.
// Sul desktop i pulsanti sono nascosti e questo modulo resta inerte.

const mq = window.matchMedia('(max-width: 900px)');

function closeDrawers() {
  $('#conn-sidebar')?.classList.remove('open');
  $('#sidebar')?.classList.remove('open');
  $('#query-schema-sidebar')?.classList.remove('open');
  $('#drawer-backdrop')?.classList.add('hidden');
}

function toggleDrawer(sel) {
  const el = $(sel);
  const willOpen = !el.classList.contains('open');
  closeDrawers(); // al massimo un drawer aperto alla volta
  if (willOpen) {
    el.classList.add('open');
    $('#drawer-backdrop').classList.remove('hidden');
  }
}

export function initResponsive() {
  $('#menu-conns-btn').addEventListener('click', () => toggleDrawer('#conn-sidebar'));
  $('#menu-dbs-btn').addEventListener('click', () => toggleDrawer('#sidebar'));
  $('#drawer-backdrop').addEventListener('click', closeDrawers);

  // Bottom Nav Mobile Listeners
  const mobConns = $('#mobile-nav-conns');
  const mobDbs = $('#mobile-nav-dbs');
  const mobQuery = $('#mobile-nav-query');
  const mobHealth = $('#mobile-nav-health');

  if (mobConns) mobConns.addEventListener('click', () => toggleDrawer('#conn-sidebar'));
  if (mobDbs) mobDbs.addEventListener('click', () => toggleDrawer('#sidebar'));
  if (mobQuery) mobQuery.addEventListener('click', () => {
    closeDrawers();
    const queryTabBtn = document.querySelector('.view-tab[data-view="query"]');
    if (queryTabBtn) queryTabBtn.click();
  });
  if (mobHealth) mobHealth.addEventListener('click', () => {
    closeDrawers();
    const healthBtn = $('#btn-health');
    if (healthBtn) healthBtn.click();
  });

  // Scegliere qualcosa dentro un drawer lo chiude: una collection/tabella
  // nel tree dei database, una connessione salvata o "＋ Aggiungi".
  $('#sidebar').addEventListener('click', (e) => {
    if (!mq.matches) return;
    if (e.target.closest('.coll .node-label')) closeDrawers();
  });
  $('#conn-sidebar').addEventListener('click', (e) => {
    if (!mq.matches) return;
    if (e.target.closest('.conn-item .node-label') || e.target.closest('#conn-add-btn')) closeDrawers();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawers();
  });

  // Tornando alla larghezza desktop i drawer si resettano.
  mq.addEventListener('change', closeDrawers);
}
