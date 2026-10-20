import { tabs, switchTab, closeTab } from './tabs.js';
import { switchCollTab, closeCollTab, pinCollTab, renderCollTabBar } from './colltabs.js';
import { renderTabBar } from './tabbar.js';
import { saveWorkspaceInputs, renderWorkspace } from './workspace.js';
import { $, showContextMenu, hideContextMenu, reorderById, refreshLucideIcons, toast } from './utils.js';
import { openConnModal } from './connection.js';
import { closeDrawers } from './responsive.js';
import { openNavigationSheet, closeNavigationSheet, renderDataEmpty, mountArcControls } from '../arc/ui.js';

// Legge il registro esistente: selezione, chiusura e riordino conservano le stesse guardie.
export function initDocumentSwitcher() {
  const opener = $('#documents-open');
  if (!opener) return;
  const panel = document.createElement('div');
  panel.id = 'documents-panel'; panel.className = 'documents-panel hidden';
  panel.innerHTML = `<div class="sidebar-title"><div class="navigator-actions">
    <button type="button" id="documents-new-connection" title="Nuova connessione" aria-label="Nuova connessione"><i data-lucide="plus" aria-hidden="true"></i></button>
    </div></div>
    <div class="navigator-section-body">
      <div class="sidebar-search navigator-search"><i data-lucide="search" aria-hidden="true"></i><input type="text" id="documents-search" aria-label="Cerca schede aperte" placeholder="Cerca schede aperte…" autocomplete="off" spellcheck="false" /></div>
      <div class="documents-list"></div>
    </div>`;
  document.body.append(panel);
  mountArcControls(panel);
  const search = $('#documents-search');
  const mq = window.matchMedia('(max-width: 900px)');
  let open = false;
  let listResize;
  opener.setAttribute('aria-controls', panel.id);
  opener.setAttribute('aria-expanded', 'false');
  const close = () => {
    if (!open) return;
    open = false;
    listResize?.disconnect();
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
    const list = panel.querySelector('.documents-list');
    renderDataEmpty(list, null);
    list.replaceChildren();
    const connected = tabs.list.filter(t => t.state.connected);
    const query = search.value.trim().toLocaleLowerCase('it');
    if (!connected.length) renderDataEmpty(list, {
      kind: 'connection', compact: true, title: 'Nessuna connessione aperta',
      description: 'Apri una connessione per lavorare con database e documenti.',
    });
    for (const tab of connected) {
      const documents = tab.state.collTabs.filter(doc => !doc.isSplitTab);
      const connectionMatches = `${tab.label} ${tab.dbType}`.toLocaleLowerCase('it').includes(query);
      const matching = connectionMatches ? documents : documents.filter(doc => `${doc.db} ${doc.coll || ''}`.toLocaleLowerCase('it').includes(query));
      if (!connectionMatches && !matching.length) continue;
      const group = document.createElement('section');
      group.className = 'document-group'; group.setAttribute('aria-label', tab.label); list.append(group);
      const children = document.createElement('div'); children.className = 'document-children';
      for (const doc of [null, ...matching]) {
        const name = doc ? (doc.isDbTab ? doc.db : doc.coll) : tab.label;
        const context = doc ? `${tab.label} / ${doc.db}` : `${tab.dbType} · ${documents.length} documenti`;
        const dirty = doc?.snapQuery?.dirty || (doc && [...(tab.state.editDrafts?.keys() || [])].some(key => {
          const [db, coll] = JSON.parse(key); return db === doc.db && coll === doc.coll;
        }));
        const row = document.createElement('div'); row.className = 'document-row';
        row.classList.toggle('document-connection', !doc);
        const select = document.createElement('button'); select.type = 'button'; select.className = 'node-label';
        const current = tab.id === tabs.activeId && (doc ? doc.id === tab.state.activeCollId : !tab.state.activeCollId);
        select.setAttribute('aria-current', String(current));
        select.classList.toggle('selected', current);
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
        const more = document.createElement('button'); more.type = 'button'; more.className = 'node-actions';
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
        row.append(select, more); (doc ? children : group).append(row);
      }
      if (matching.length) group.append(children);
    }
    if (query && connected.length && !list.children.length) renderDataEmpty(list, {
      kind: 'search', compact: true, title: 'Nessuna scheda trovata',
      description: 'Prova il nome della scheda, del database o della connessione.',
      actionLabel: 'Azzera ricerca', onAction: () => { search.value = ''; render(); search.focus(); },
    });
    refreshLucideIcons(panel);
    if (focusId) (list.querySelector(`[data-document-id="${CSS.escape(focusId)}"]`) || list.querySelector('button') || $('#documents-new-connection')).focus();
  };
  search.addEventListener('input', () => render());
  opener.addEventListener('click', () => {
    if (open) { close(); return; }
    closeDrawers({ immediate: true });
    saveWorkspaceInputs(); search.value = ''; render();
    open = true;
    opener.setAttribute('aria-expanded', 'true');
    openNavigationSheet(panel, close, { title: 'Schede aperte', description: 'Scegli una connessione o un documento aperto.' });
    const list = panel.querySelector('.documents-list');
    const revealCurrent = () => {
      const current = panel.querySelector('.document-row:has([aria-current="true"])');
      if (!open || !current) return;
      const row = current.getBoundingClientRect(), viewport = list.getBoundingClientRect();
      if (row.top < viewport.top || row.bottom > viewport.bottom) list.scrollTop += row.top - viewport.top;
    };
    // Il detent riduce l'altezza utile dopo il primo layout: lo scroll iniziale
    // può essere stato limitato quando la lista era ancora più alta.
    listResize = new ResizeObserver(revealCurrent);
    listResize.observe(list);
    revealCurrent();
  });
}
