'use strict';

import { state } from './state.js';
import { onTabChange } from './tabs.js';
import { $, migraChiave, initToolbarDropdown } from './utils.js';
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
import { initGeoMap } from './geomap.js';
import { initGeoMulti } from './geomulti.js';
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
import { initAdminRbac } from './admin-rbac.js';
import { initPendingQueries } from './pending-queries.js';
import { initScriptRun } from './script-run.js';
import { initPassphrase } from './passphrase.js';
import { initOnboarding } from './onboarding.js';
import { initAbout } from './about.js';

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
  document.querySelectorAll('.view-menu-item').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  // Il pulsante "Visualizza" fa da tab per le due viste che ospita: quando una è
  // attiva ne prende il nome ed è evidenziato come gli altri tab, altrimenti chi
  // guarda l'UML non avrebbe alcun indizio di dove si trova.
  const menuBtn = $('#view-menu-btn');
  if (menuBtn) {
    const voce = document.querySelector(`.view-menu-item[data-view="${view}"]`);
    menuBtn.classList.toggle('active', !!voce);
    const full = $('#view-menu-label');
    const short = menuBtn.querySelector('.tab-label-short');
    if (full) full.textContent = voce ? voce.dataset.label : 'Visualizza';
    if (short) short.textContent = voce ? voce.dataset.short : 'Vista';
  }
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
  const tab = e.target.closest('.view-tab, .view-menu-item');
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
    // Prefisso unificato con recupero del valore precedente (CDB-64).
    const key = migraChiave(`width:${rz.dataset.resize}`, `gui-db:width:${rz.dataset.resize}`);
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

import { positionFixedDropdown, refreshLucideIcons } from './utils.js';

// Cambio del tab attivo (switch o chiusura): ri-render di barra e workspace.
// ensureActiveCollLoaded carica i dati del coll-tab attivo dei tab ripristinati
// da una sessione (sui tab normali non fa nulla: i dati sono già in memoria).
onTabChange(() => {
  renderTabBar();
  renderWorkspace();
  ensureActiveCollLoaded();
  refreshLucideIcons();
});

// Menu "Impostazioni" in fondo alla barra connessioni: unico ingresso a backup,
// storico, salute, utenti, passphrase, guida e informazioni. Ha preso il posto
// del menu ⋮ nell'header e dei bottoncini della dock, che ripetevano in parte
// gli stessi comandi in due punti diversi dello schermo.
function initSettingsMenu() {
  const btn = $('#conn-settings-btn');
  const menu = $('#settings-menu');
  if (!btn || !menu) return;

  // Chiusura ANIMATA: `.hidden` è `display: none`, quindi togliere e basta fa
  // sparire il menu di scatto mentre l'apertura è dissolta — l'asimmetria si
  // nota. Si passa da `.closing` (animazione in uscita) e solo alla fine si
  // mette `.hidden`; il timer di sicurezza serve perché `animationend` non
  // arriva se l'animazione è disattivata (prefers-reduced-motion) o se il
  // nodo viene nascosto da qualcun altro nel frattempo.
  let timerChiusura = null;
  const nascondi = () => {
    clearTimeout(timerChiusura);
    timerChiusura = null;
    menu.classList.remove('closing');
    menu.classList.add('hidden');
  };
  const senzaAnimazioni = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const chiudi = () => {
    btn.setAttribute('aria-expanded', 'false');
    if (menu.classList.contains('hidden') || menu.classList.contains('closing')) return;
    if (senzaAnimazioni()) { nascondi(); return; }
    menu.classList.add('closing');
    timerChiusura = setTimeout(nascondi, 200);
  };
  menu.addEventListener('animationend', (e) => {
    if (e.target === menu && menu.classList.contains('closing')) nascondi();
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Aperto (o in chiusura, cioè ancora visibile): il clic sul pulsante lo
    // richiude con la sua animazione.
    if (!menu.classList.contains('hidden') && !menu.classList.contains('closing')) {
      chiudi();
      return;
    }
    document.querySelectorAll('.toolbar-dropdown-menu').forEach((m) => m.classList.add('hidden'));
    clearTimeout(timerChiusura);
    menu.classList.remove('closing'); // riapertura durante la dissolvenza
    positionFixedDropdown(btn, menu);
    btn.setAttribute('aria-expanded', 'true');
  });

  menu.addEventListener('click', (e) => {
    if (e.target.closest('.menu-item')) chiudi();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#conn-settings-btn') && !e.target.closest('#settings-menu')) chiudi();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') chiudi();
  });

  window.addEventListener('resize', chiudi);
  window.addEventListener('scroll', chiudi, true);
}

// Per primo: con RBAC attivo la schermata di accesso deve comparire prima che
// gli altri moduli inizino a parlare col server.
initAuth();
initToolbarDropdown('#view-menu-btn', '#view-menu'); // menu "Visualizza" (UML, Grafo 3D)
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
initGeoMap();
initGeoMulti();
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
initAdminRbac();
initPendingQueries();
initScriptRun();
initPassphrase();
initSessionPersistence();
initSplitView();
initSettingsMenu();
initAbout();
// Per ultima: decide da sé se aprirsi (primo avvio o dopo un aggiornamento) e
// deve trovare il resto dell'interfaccia già montato, perché il tour indica
// elementi reali e salta quelli che non ci sono.
initOnboarding();

// Stato iniziale: nessun tab aperto, schermata di benvenuto.
renderTabBar();
renderWorkspace();
refreshLucideIcons();
