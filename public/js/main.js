'use strict';

import { state } from './state.js';
import { onTabChange } from './tabs.js';
import { $ } from './utils.js';
import { initUml, loadUml } from './uml.js';
import { initGraph3d, loadGraph3d } from './graph3d.js';
import { initConnection } from './connection.js';
import { initConnManager } from './connmanager.js';
import { renderTabBar } from './tabbar.js';
import { renderWorkspace } from './workspace.js';
import { initDbTree } from './dbtree.js';
import { initSchemaOps } from './schema-ops.js';
import { initGrid } from './grid.js';
import { initCellSelect } from './cellselect.js';
import { initInlineEdit } from './inlineEdit.js';
import { initInsert } from './insert.js';
import { initDetails, loadDetails } from './details.js';
import { initLive } from './live.js';
import { initResponsive } from './responsive.js';
import { initExportImport } from './exportimport.js';
import { initVault } from './vault.js';
import { initAuth } from './auth.js';
import { initQueryTab, loadQueryTab } from './query-tab.js';
import { initBackupManager } from './backupmanager.js';
import { initAuditLog } from './auditlog.js';
import { initHealth } from './health.js';
import { initSessionPersistence } from './session-restore.js';
import { ensureActiveCollLoaded } from './colltabs.js';
import { initSplitView } from './splitview.js';
import { initPendingQueries } from './pending-queries.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Registrazione Service Worker fallita:', err);
    });
  });
}


export function setView(view) {
  state.view = view;
  document.querySelectorAll('.view-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#view-data').classList.toggle('hidden', view !== 'data');
  $('#view-details').classList.toggle('hidden', view !== 'details');
  $('#view-uml').classList.toggle('hidden', view !== 'uml');
  $('#view-graph3d').classList.toggle('hidden', view !== 'graph3d');
  $('#view-query').classList.toggle('hidden', view !== 'query');
  if (view === 'details') loadDetails();
  if (view === 'uml') loadUml(false);
  if (view === 'graph3d') loadGraph3d(false);
  if (view === 'query') loadQueryTab();
}

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.view-tab');
  if (tab && tab.dataset.view) {
    setView(tab.dataset.view);
  }
});

// Maniglie di ridimensionamento orizzontale: ogni .resizer ridimensiona
// l'elemento indicato da data-resize; la larghezza è ricordata in localStorage.
function initResizers() {
  document.querySelectorAll('.resizer[data-resize]').forEach((rz) => {
    const el = document.getElementById(rz.dataset.resize);
    if (!el) return;
    const key = `gui-db:width:${rz.dataset.resize}`;
    const saved = localStorage.getItem(key);
    if (saved) el.style.width = saved;
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = el.getBoundingClientRect().width;
      rz.classList.add('dragging');
      const move = (ev) => {
        el.style.width = Math.min(Math.max(150, startW + ev.clientX - startX), window.innerWidth * 0.45) + 'px';
      };
      const up = () => {
        rz.classList.remove('dragging');
        localStorage.setItem(key, el.style.width);
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  });
}

// Cambio del tab attivo (switch o chiusura): ri-render di barra e workspace.
// ensureActiveCollLoaded carica i dati del coll-tab attivo dei tab ripristinati
// da una sessione (sui tab normali non fa nulla: i dati sono già in memoria).
onTabChange(() => {
  renderTabBar();
  renderWorkspace();
  ensureActiveCollLoaded();
});

import { positionFixedDropdown } from './utils.js';

function initHeaderMoreMenu() {
  const btn = $('#header-more-btn');
  const menu = $('#header-more-menu');
  if (!btn || !menu) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = menu.classList.contains('hidden');
    document.querySelectorAll('.header-more-menu, .toolbar-dropdown-menu').forEach((m) => m.classList.add('hidden'));

    if (isHidden) {
      positionFixedDropdown(btn, menu);
    }
  });

  menu.addEventListener('click', (e) => {
    if (e.target.closest('.menu-item')) {
      menu.classList.add('hidden');
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#header-more-btn') && !e.target.closest('#header-more-menu')) {
      menu.classList.add('hidden');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.classList.add('hidden');
  });

  window.addEventListener('resize', () => menu.classList.add('hidden'));
  window.addEventListener('scroll', () => menu.classList.add('hidden'), true);
}

// Per primo: con RBAC attivo la schermata di accesso deve comparire prima che
// gli altri moduli inizino a parlare col server.
initAuth();
initUml();
initGraph3d();
initConnection();
initConnManager();
initDbTree();
initSchemaOps();
initGrid();
initCellSelect();
initInlineEdit();
initInsert();
initDetails();
initLive();
initResizers();
initResponsive();
initExportImport();
initVault();
initQueryTab();
initBackupManager();
initAuditLog();
initHealth();
initPendingQueries();
initSessionPersistence();
initSplitView();
initHeaderMoreMenu();

// Stato iniziale: nessun tab aperto, schermata di benvenuto.
renderTabBar();
renderWorkspace();
