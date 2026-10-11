'use strict';

import { $, migraChiave } from './utils.js';
import { notificaCambioLarghezza } from './splitview.js';
import { initViewport } from './viewport.js';
import { openNavigationSheet, closeNavigationSheet } from '../arc/ui.js';

// Su mobile/tablet connessioni e database usano il BottomSheet Arc;
// lo schema query mantiene il drawer. Il desktop conserva gli stessi nodi.

const mq = window.matchMedia('(max-width: 900px)');
const SIDEBAR_COLLAPSED_KEY = migraChiave('conn-sidebar-collapsed', 'gui-db:conn-sidebar-collapsed');
let drawerOpener;
const drawers = ['#conn-sidebar', '#sidebar', '#query-schema-sidebar'];

function syncDrawers() {
  for (const [selector, triggers] of [['#conn-sidebar', ['#menu-conns-btn', '#mobile-nav-conns']], ['#sidebar', ['#menu-dbs-btn', '#mobile-nav-dbs']], ['#query-schema-sidebar', ['#query-toggle-schema-btn']]]) {
    const el = $(selector), open = el.classList.contains('open');
    el.inert = mq.matches && !open;
    for (const id of triggers) {
      $(id)?.setAttribute('aria-controls', el.id);
      $(id)?.setAttribute('aria-expanded', String(selector === '#query-schema-sidebar' && !mq.matches ? !el.classList.contains('collapsed') : open));
    }
  }
  const navigator = $('#navigator');
  const collapsed = navigator.classList.contains('collapsed');
  navigator.inert = !mq.matches && collapsed;
  const button = $('#menu-conns-btn');
  const action = collapsed ? 'Mostra pannello' : 'Nascondi pannello';
  button.querySelector('.menu-conns-label').textContent = action;
  const label = mq.matches ? 'Connessioni salvate' : `${action} sinistro`;
  button.title = label;
  button.setAttribute('aria-label', label);
  if (!mq.matches) {
    button.setAttribute('aria-controls', 'navigator');
    button.setAttribute('aria-expanded', String(!collapsed));
  }
}

export function closeDrawers({ restoreFocus = false } = {}) {
  closeNavigationSheet();
  $('#conn-sidebar')?.classList.remove('open');
  $('#sidebar')?.classList.remove('open');
  $('#query-schema-sidebar')?.classList.remove('open');
  $('#query-toggle-schema-btn')?.setAttribute('aria-expanded', String(!mq.matches && !$('#query-schema-sidebar')?.classList.contains('collapsed')));
  $('#drawer-backdrop')?.classList.add('hidden');
  syncDrawers();
  if (restoreFocus && drawerOpener?.isConnected) drawerOpener.focus({ preventScroll: true });
}

export function toggleDrawer(sel) {
  if (!mq.matches && sel === '#conn-sidebar') {
    const navigator = $('#navigator');
    const collapsed = navigator.classList.toggle('collapsed');
    if (collapsed && navigator.contains(document.activeElement)) $('#menu-conns-btn').focus();
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
    syncDrawers();
    return;
  }
  const el = $(sel);
  const willOpen = !el.classList.contains('open');
  drawerOpener = document.activeElement;
  closeDrawers(); // al massimo un drawer aperto alla volta
  if (!drawerOpener?.isConnected) drawerOpener = document.activeElement;
  if (willOpen) {
    el.classList.add('open');
    syncDrawers();
    if (mq.matches && sel !== '#query-schema-sidebar') {
      openNavigationSheet(el, () => closeDrawers({ restoreFocus: true }));
    } else {
      $('#drawer-backdrop').classList.remove('hidden');
      el.querySelector('input, button, [tabindex="0"]')?.focus();
    }
  }
}

export function initResponsive() {
  initViewport();
  $('#navigator').classList.toggle('collapsed', localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true');
  syncDrawers();
  $('#menu-conns-btn').addEventListener('click', () => toggleDrawer('#conn-sidebar'));
  $('#menu-dbs-btn').addEventListener('click', () => toggleDrawer('#sidebar'));
  $('#drawer-backdrop').addEventListener('click', () => { closeDrawers(); drawerOpener?.focus(); });

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
    if (e.target.closest('.coll .node-label')) closeDrawers({ restoreFocus: true });
  });
  $('#conn-sidebar').addEventListener('click', (e) => {
    if (!mq.matches) return;
    if (e.target.closest('.conn-item .node-label') || e.target.closest('#conn-add-btn')) closeDrawers({ restoreFocus: true });
  });

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.arc-navigation-sheet')) return; // Focus ed Escape appartengono a Radix.
    const active = drawers.map(sel => $(sel)).find(el => el.classList.contains('open'));
    if (e.key === 'Escape') {
      closeDrawers();
      if (active) { e.preventDefault(); drawerOpener?.focus(); }
    }
    if (e.key === 'Tab' && mq.matches && active && !document.querySelector('.overlay:not(.hidden), #context-menu:not(.hidden)')) {
      const controls = [...active.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && (document.activeElement === first || !active.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && (document.activeElement === last || !active.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
    }
  });

  // Tornando alla larghezza desktop i drawer si resettano.
  mq.addEventListener('change', closeDrawers);
  // …e i pannelli affiancati si riadattano: sotto i 900px il CSS li impila,
  // quindi le quote vanno riapplicate sull'asse nuovo e un eventuale pannello
  // massimizzato va ripristinato (a schermo stretto sarebbe una schermata da
  // cui non si capisce come uscire).
  mq.addEventListener('change', notificaCambioLarghezza);
}
