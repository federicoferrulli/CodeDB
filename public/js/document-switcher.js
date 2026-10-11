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
  panel.innerHTML = `<button type="button" id="documents-new-connection"><i data-lucide="plus"></i>Nuova connessione</button><div class="documents-list"></div>`;
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
    if (!connected.length) list.textContent = 'Nessuna connessione aperta.';
    for (const tab of connected) {
      const heading = document.createElement('h3');
      heading.textContent = tab.label; list.append(heading);
      for (const doc of [null, ...tab.state.collTabs]) {
        const name = doc ? (doc.isDbTab ? doc.db : doc.coll) : tab.label;
        const context = doc ? `${tab.label} / ${doc.isSplitTab ? 'Area affiancata' : doc.db}` : tab.dbType;
        const dirty = doc?.snapQuery?.dirty || (doc && [...(tab.state.editDrafts?.keys() || [])].some(key => {
          const [db, coll] = JSON.parse(key); return db === doc.db && coll === doc.coll;
        }));
        const row = document.createElement('div'); row.className = 'document-row';
        const select = document.createElement('button'); select.type = 'button';
        select.textContent = `${name}${dirty ? ' · Modifiche non salvate' : ''}${doc?.preview ? ' · Anteprima' : ''}`;
        select.setAttribute('aria-current', String(tab.id === tabs.activeId && (!doc || doc.id === tab.state.activeCollId)));
        const detail = document.createElement('small'); detail.textContent = context; select.append(detail);
        select.addEventListener('click', () => activate(tab, doc));
        const more = document.createElement('button'); more.type = 'button';
        more.dataset.documentId = (doc || tab).id;
        more.setAttribute('aria-label', `Azioni ${name}`); more.setAttribute('aria-haspopup', 'menu');
        more.innerHTML = '<i data-lucide="ellipsis" aria-hidden="true"></i>';
        more.addEventListener('click', () => {
          const items = [], source = doc ? tab.state.collTabs : tabs.list, target = doc || tab;
          const index = source.indexOf(target);
          const rerender = (focusId = target.id) => { renderTabBar(); renderCollTabBar(); render(focusId); };
          for (const [offset, label] of [[-1, 'Sposta prima'], [1, 'Sposta dopo']]) {
            if (source[index + offset]) items.push({ label, action: () => { reorderById(source, target.id, source[index + offset].id); rerender(); } });
          }
          if (doc?.preview) items.push({ label: 'Mantieni aperta la scheda', action: () => { saveWorkspaceInputs(); switchTab(tab.id); pinCollTab(doc.id); render(doc.id); } });
          items.push({ icona: 'copy', label: 'Copia nome completo', action: async () => {
            await navigator.clipboard.writeText(String(name)); toast('Nome completo copiato');
          } });
          items.push({ icona: 'x', label: doc ? 'Chiudi documento' : 'Disconnetti', action: () => {
            saveWorkspaceInputs();
            if (doc) { switchTab(tab.id); closeCollTab(doc.id); } else closeTab(tab.id);
            renderWorkspace(); rerender(source[Math.min(index, source.length - 1)]?.id || tab.id);
          } });
          const r = more.getBoundingClientRect(); showContextMenu(r.left, r.bottom, items);
        });
        row.append(select, more); list.append(row);
      }
    }
    refreshLucideIcons(panel);
    if (focusId) (list.querySelector(`[data-document-id="${CSS.escape(focusId)}"]`) || list.querySelector('button') || $('#documents-new-connection')).focus();
  };
  opener.addEventListener('click', () => {
    closeDrawers();
    saveWorkspaceInputs(); render();
    open = true;
    opener.setAttribute('aria-expanded', 'true');
    openNavigationSheet(panel, close, { title: 'Schede aperte', description: 'Scegli una connessione o un documento aperto.', tools: false });
  });
}
