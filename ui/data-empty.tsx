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
    icon={options.kind === 'query' ? <svg className="query-empty-art" width="248" height="112" viewBox="0 0 248 112" fill="none" aria-hidden="true">
      <g className="query-art-source">
        <rect x="9" y="13" width="94" height="74" rx="9" fill="var(--surface)" stroke="var(--border-strong)" />
        <path d="M9 33h94" stroke="var(--border)" /><circle cx="21" cy="23" r="2" fill="var(--accent-fg)" /><path d="M29 23h22" stroke="var(--text-secondary)" strokeLinecap="round" />
        <path d="m23 46 7 6-7 6m14 0h16" stroke="var(--accent-fg)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M23 71h40m7 0h17" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" />
      </g>
      <path className="query-art-flow" d="M108 52h29m-5-5 5 5-5 5" pathLength="1" stroke="var(--accent-fg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <g className="query-art-result">
        <rect x="145" y="25" width="94" height="74" rx="9" fill="var(--surface)" stroke="var(--accent-line)" />
        <path d="M154 25h76a9 9 0 0 1 9 9v13h-94V34a9 9 0 0 1 9-9Z" fill="var(--accent-soft)" />
        <path d="M145 47h94m-65 0v52m33-52v52" stroke="var(--border)" />
        <path d="M156 36h9m19 0h14m18 0h12" stroke="var(--accent-fg)" strokeWidth="2" strokeLinecap="round" />
        <g className="query-art-rows" stroke="var(--text-secondary)" strokeLinecap="round"><path d="M156 61h7m21 0h13m19 0h11" /><path d="M156 75h7m21 0h13m19 0h11" /><path d="M156 89h7m21 0h13m19 0h11" /></g>
      </g>
    </svg> : <div className="data-empty-art"><div className="data-empty-table"><div className="data-empty-table-head"><i /><i /><i /></div>
      <div className="data-empty-table-rows">{Array.from({ length: 9 }, (_, i) => <span key={i} />)}</div></div>
      <span className="data-empty-symbol"><Icon size={22} strokeWidth={1.6} /></span></div>}
    action={options.onAction && options.actionLabel ? <Button type="button" variant={options.kind === 'connection' ? 'primary' : 'secondary'} size={options.kind === 'connection' ? 'md' : 'sm'} onClick={options.onAction}>
      {options.actionLabel}<ArrowRight size={14} aria-hidden="true" /></Button> : undefined} />));
}

// Split e viste dinamiche possono rimuovere il contenitore completo.
new MutationObserver(() => {
  for (const [container, entry] of mounts) if (!entry.host.isConnected) renderDataEmpty(container, null);
}).observe(document.body, { childList: true, subtree: true });
