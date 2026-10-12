import { tabs, switchTab, closeTab } from './tabs.js';
import { switchCollTab, closeCollTab, pinCollTab, renderCollTabBar } from './colltabs.js';
import { renderTabBar } from './tabbar.js';
import { saveWorkspaceInputs, renderWorkspace } from './workspace.js';
import { $, showContextMenu, hideContextMenu, reorderById, refreshLucideIcons, toast } from './utils.js';
import { openConnModal } from './connection.js';
import { closeDrawers } from './responsive.js';
import { openNavigationSheet, closeNavigationSheet } from '../arc/ui.js';

// Legge il registro esistente: selezione, chiusura e riordino conservano le stesse guardie.
export function initDocumentSwitcher() {
  const opener = $('#documents-open');
  if (!opener) return;
  const panel = document.createElement('div');
  panel.id = 'documents-panel'; panel.className = 'documents-panel hidden';
  panel.innerHTML = `<div class="documents-list"></div><button type="button" id="documents-new-connection" class="ghost"><i data-lucide="plus"></i>Nuova connessione</button>`;
  document.body.append(panel);
  const mq = window.matchMedia('(max-width: 900px)');
  let open = false;
  opener.setAttribute('aria-controls', panel.id);
  opener.setAttribute('aria-expanded', 'false');
  const close = () => {
    if (!open) return;
    open = false;
    hideContextMenu();
    closeNavigationSheet();
    opener.setAttribute('aria-expanded', 'false');
    (mq.matches ? opener : $('#tab-bar [aria-selected="true"]') || $('#menu-conns-btn')).focus({ preventScroll: true });
  };
  mq.addEventListener('change', close);
  $('#documents-new-connection').addEventListener('click', () => { close(); openConnModal(); });
  const activate = (tab, doc) => {
    saveWorkspaceInputs(); switchTab(tab.id);
    if (doc) switchCollTab(doc.id);
    close();
  };
  const render = (focusId) => {
    const list = panel.querySelector('.documents-list'); list.replaceChildren();
    const connected = tabs.list.filter(t => t.state.connected);
    if (!connected.length) list.innerHTML = '<div class="documents-empty"><i data-lucide="panels-top-left" aria-hidden="true"></i><strong>Nessuna connessione aperta.</strong><p>Apri una connessione per lavorare con database e documenti.</p></div>';
    for (const tab of connected) {
      const documents = tab.state.collTabs.filter(doc => !doc.isSplitTab);
      const group = document.createElement('section');
      group.className = 'document-group'; group.setAttribute('aria-label', tab.label); list.append(group);
      for (const doc of [null, ...documents]) {
        const name = doc ? (doc.isDbTab ? doc.db : doc.coll) : tab.label;
        const context = doc ? `${tab.label} / ${doc.db}` : `${tab.dbType} · ${documents.length} documenti`;
        const dirty = doc?.snapQuery?.dirty || (doc && [...(tab.state.editDrafts?.keys() || [])].some(key => {
          const [db, coll] = JSON.parse(key); return db === doc.db && coll === doc.coll;
        }));
        const row = document.createElement('div'); row.className = 'document-row';
        row.classList.toggle('document-connection', !doc);
        const select = document.createElement('button'); select.type = 'button';
        const current = tab.id === tabs.activeId && (doc ? doc.id === tab.state.activeCollId : !tab.state.activeCollId);
        select.setAttribute('aria-current', String(current));
        const icon = document.createElement('i');
        icon.dataset.lucide = !doc ? 'server' : doc.isDbTab ? 'database' : 'table-2';
        icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span'); text.className = 'document-text';
        const title = document.createElement('span'); title.className = 'document-name'; title.textContent = name;
        const detail = document.createElement('small'); detail.textContent = context;
        text.append(title, detail);
        if (dirty || doc?.preview || current) {
          const status = document.createElement('small'); status.className = dirty ? 'document-status document-dirty' : 'document-status';
          status.textContent = [current && 'In uso', dirty && 'Modifiche non salvate', doc?.preview && 'Anteprima'].filter(Boolean).join(' · ');
          text.append(status);
        }
        select.append(icon, text);
        select.addEventListener('click', () => activate(tab, doc));
        const more = document.createElement('button'); more.type = 'button';
        more.dataset.documentId = (doc || tab).id;
        more.setAttribute('aria-label', `Azioni ${name}`); more.setAttribute('aria-haspopup', 'menu');
        more.innerHTML = '<i data-lucide="ellipsis" aria-hidden="true"></i>';
        more.addEventListener('click', () => {
          const items = [], source = doc ? tab.state.collTabs : tabs.list, target = doc || tab;
          const visible = doc ? documents : source;
          const index = visible.indexOf(target);
          const rerender = (focusId = target.id) => { renderTabBar(); renderCollTabBar(); render(focusId); };
          for (const [offset, label] of [[-1, 'Sposta prima'], [1, 'Sposta dopo']]) {
            if (visible[index + offset]) items.push({ label, action: () => { reorderById(source, target.id, visible[index + offset].id); rerender(); } });
          }
          if (doc?.preview) items.push({ label: 'Mantieni aperta la scheda', action: () => { saveWorkspaceInputs(); switchTab(tab.id); pinCollTab(doc.id); render(doc.id); } });
          items.push({ icona: 'copy', label: 'Copia nome completo', action: async () => {
            await navigator.clipboard.writeText(String(name)); toast('Nome completo copiato');
          } });
          items.push({ icona: 'x', label: doc ? 'Chiudi documento' : 'Disconnetti', action: async () => {
            saveWorkspaceInputs();
            if (doc) { switchTab(tab.id); await closeCollTab(doc.id); } else await closeTab(tab.id);
            renderWorkspace(); rerender(visible[index + 1]?.id || visible[index - 1]?.id || tab.id);
          } });
          const r = more.getBoundingClientRect(); showContextMenu(r.left, r.bottom, items);
        });
        row.append(select, more); group.append(row);
      }
    }
    refreshLucideIcons(panel);
    if (focusId) (list.querySelector(`[data-document-id="${CSS.escape(focusId)}"]`) || list.querySelector('button') || $('#documents-new-connection')).focus();
  };
  opener.addEventListener('click', () => {
    if (open) { close(); return; }
    closeDrawers({ immediate: true });
    saveWorkspaceInputs(); render();
    open = true;
    opener.setAttribute('aria-expanded', 'true');
    openNavigationSheet(panel, close, { title: 'Schede aperte', description: 'Scegli una connessione o un documento aperto.', tools: false });
    const current = panel.querySelector('.document-row:has([aria-current="true"])');
    const list = panel.querySelector('.documents-list');
    if (current) list.scrollTop += current.getBoundingClientRect().top - list.getBoundingClientRect().top;
  });
}
