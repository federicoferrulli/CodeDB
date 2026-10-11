import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ArrowRight, Search, Terminal, Table2, CircleAlert, Database } from 'lucide-react';
import { EmptyState } from './components/arc/empty-state/empty-state';
import { Button } from './components/arc/button/button';

type EmptyOptions = {
  title: string;
  description: string;
  kind?: 'data' | 'search' | 'query' | 'error' | 'connection';
  actionLabel?: string;
  onAction?: () => void;
};
const mounts = new Map<HTMLElement, { host: HTMLElement; root: Root }>();

// Il messaggio appartiene al viewport, non a una cella: resta centrato anche con colonne larghe.
export function renderDataEmpty(container: HTMLElement | null, options: EmptyOptions | null) {
  if (!container) return;
  let entry = mounts.get(container);
  if (!options || (entry && entry.host.parentElement !== container)) {
    entry?.root.unmount();
    entry?.host.remove();
    mounts.delete(container);
    container.classList.remove('data-empty-container');
    entry = undefined;
  }
  if (!options) return;
  if (!entry) {
    const host = document.createElement('div');
    host.className = 'data-empty-host';
    container.append(host);
    entry = { host, root: createRoot(host) };
    mounts.set(container, entry);
    container.classList.add('data-empty-container');
  }
  const Icon = { data: Table2, search: Search, query: Terminal, error: CircleAlert, connection: Database }[options.kind || 'data'];
  flushSync(() => entry!.root.render(<EmptyState className="data-empty" title={options.title} description={options.description} label={options.title}
    icon={<div className="data-empty-art"><div className="data-empty-table"><div className="data-empty-table-head"><i /><i /><i /></div>
      <div className="data-empty-table-rows">{Array.from({ length: 9 }, (_, i) => <span key={i} />)}</div></div>
      <span className="data-empty-symbol"><Icon size={22} strokeWidth={1.6} /></span></div>}
    action={options.onAction && options.actionLabel ? <Button type="button" variant={options.kind === 'connection' ? 'primary' : 'secondary'} size={options.kind === 'connection' ? 'md' : 'sm'} onClick={options.onAction}>
      {options.actionLabel}<ArrowRight size={14} aria-hidden="true" /></Button> : undefined} />));
}

// Split e viste dinamiche possono rimuovere il contenitore completo.
new MutationObserver(() => {
  for (const [container, entry] of mounts) if (!entry.host.isConnected) renderDataEmpty(container, null);
}).observe(document.body, { childList: true, subtree: true });
