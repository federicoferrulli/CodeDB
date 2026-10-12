'use strict';

import { $, migraChiave } from './utils.js';
import { notificaCambioLarghezza } from './splitview.js';
import { initViewport } from './viewport.js';
import { etichettaCombo, mappaAttiva } from './scorciatoie.js';
import { openNavigationSheet, closeNavigationSheet } from '../arc/ui.js';

// Su mobile/tablet connessioni e database usano il BottomSheet Arc;
// lo schema query mantiene il drawer. Il desktop conserva gli stessi nodi.

const mq = window.matchMedia('(max-width: 900px)');
const SIDEBAR_COLLAPSED_KEY = migraChiave('conn-sidebar-collapsed', 'gui-db:conn-sidebar-collapsed');
let drawerOpener;
const drawers = ['#conn-sidebar', '#sidebar', '#query-schema-sidebar'];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let panelAnimations = [];

function finishPanelMotion() {
  panelAnimations.forEach(animation => animation.cancel());
  panelAnimations = [];
  $('#navigator').classList.remove('navigator-departing');
  $('#navigator').style.removeProperty('--panel-motion-width');
}

function animatePanelChange(navigator, change) {
  const main = document.querySelector('.main-area');
  const before = main.getBoundingClientRect();
  const panelBefore = navigator.getBoundingClientRect();
  const wasVisible = !navigator.classList.contains('collapsed') || navigator.classList.contains('navigator-departing');
  finishPanelMotion();
  change();
  if (reducedMotion.matches || !navigator.animate) return;
  const collapsed = navigator.classList.contains('collapsed');
  const width = collapsed ? panelBefore.width : navigator.getBoundingClientRect().width;
  if (collapsed) {
    navigator.style.setProperty('--panel-motion-width', `${width}px`);
    navigator.classList.add('navigator-departing');
  }
  const panelAfter = navigator.getBoundingClientRect();
  const from = wasVisible ? panelBefore.left - panelAfter.left : -width;
  const timing = { duration: collapsed ? 240 : 360, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };
  // Il layout cambia una sola volta; durante il movimento scorrono gli stessi nodi.
  panelAnimations = [
    navigator.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${collapsed ? -width : 0}px)` }], timing),
    main.animate([{ transform: `translateX(${before.left - main.getBoundingClientRect().left}px)` }, { transform: 'none' }], timing),
  ];
  const current = panelAnimations;
  Promise.all(current.map(animation => animation.finished)).then(() => {
    if (panelAnimations === current) finishPanelMotion();
  }, () => {});
}

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
  const shortcut = etichettaCombo(mappaAttiva().sidebarConnessioni);
  button.querySelector('kbd').textContent = shortcut;
  const label = mq.matches ? 'Connessioni salvate' : `${action} sinistro`;
  button.title = `${label}${shortcut ? ` (${shortcut})` : ''}`;
  button.setAttribute('aria-label', label);
  if (!mq.matches) {
    button.setAttribute('aria-controls', 'navigator');
    button.setAttribute('aria-expanded', String(!collapsed));
  }
}

export function closeDrawers({ restoreFocus = false, immediate = false } = {}) {
  closeNavigationSheet(immediate);
  $('#conn-sidebar')?.classList.remove('open');
  $('#sidebar')?.classList.remove('open');
  $('#query-schema-sidebar')?.classList.remove('open');
  $('#query-toggle-schema-btn')?.setAttribute('aria-expanded', String(!mq.matches && !$('#query-schema-sidebar')?.classList.contains('collapsed')));
  $('#drawer-backdrop')?.classList.add('hidden');
  syncDrawers();
  if (restoreFocus && drawerOpener?.isConnected) (mq.matches ? drawerOpener : $('#menu-conns-btn')).focus({ preventScroll: true });
}

export function toggleDrawer(sel) {
  if (!mq.matches && sel === '#conn-sidebar') {
    const navigator = $('#navigator');
    animatePanelChange(navigator, () => {
      const collapsed = navigator.classList.toggle('collapsed');
      if (collapsed && navigator.contains(document.activeElement)) $('#menu-conns-btn').focus();
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
      syncDrawers();
    });
    return;
  }
  const el = $(sel);
  const willOpen = !el.classList.contains('open');
  drawerOpener = document.activeElement;
  closeDrawers({ immediate: true }); // il cambio pannello restituisce subito i nodi al loro controller
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
  document.addEventListener('codedb:scorciatoie', syncDrawers);
  reducedMotion.addEventListener('change', finishPanelMotion);
  window.addEventListener('resize', finishPanelMotion);
  $('#menu-conns-btn').addEventListener('click', () => toggleDrawer('#conn-sidebar'));
  $('#menu-dbs-btn').addEventListener('click', () => toggleDrawer('#sidebar'));
  $('#drawer-backdrop').addEventListener('click', () => { closeDrawers(); drawerOpener?.focus(); });

  $('#mobile-nav-conns').addEventListener('click', () => toggleDrawer('#conn-sidebar'));
  $('#mobile-nav-dbs').addEventListener('click', () => toggleDrawer('#sidebar'));

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
  mq.addEventListener('change', () => closeDrawers({ immediate: true }));
  // Su mobile lo split lascia il posto a una scheda singola.
  mq.addEventListener('change', notificaCambioLarghezza);
}
