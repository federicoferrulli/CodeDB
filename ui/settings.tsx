import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Settings } from 'lucide-react';
import { DropdownMenu, type DropdownItem } from './components/arc/dropdown-menu/dropdown-menu';

export function initSettings() {
  const original = document.getElementById('conn-settings-btn');
  const commands = document.getElementById('settings-menu');
  if (!original || !commands) return;
  const host = document.createElement('div');
  host.className = 'arc-settings';
  original.replaceWith(host);
  // Gli ID dei comandi restano disponibili a RBAC, aggiornamenti e scorciatoie.
  // Il menu React legge da questa unica sorgente e invoca gli stessi listener.
  const root = createRoot(host);
  function render() {
    const items: DropdownItem[] = [];
    let separatorBefore = false;
    for (const node of commands!.children) {
      if (node.classList.contains('menu-divider')) { separatorBefore = true; continue; }
      if (!(node instanceof HTMLButtonElement) || node.classList.contains('hidden')) continue;
      items.push({ label: node.textContent!.trim(), disabled: node.disabled, separatorBefore,
        onSelect: () => { node.click(); } });
      separatorBefore = false;
    }
    flushSync(() => root.render(<DropdownMenu triggerId="conn-settings-btn" label="Impostazioni" icon={<Settings size={16} />} items={items} />));
  }
  new MutationObserver(render).observe(commands, { attributes: true, attributeFilter: ['class', 'disabled'], subtree: true, childList: true, characterData: true });
  render();
}
