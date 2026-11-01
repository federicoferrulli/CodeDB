import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useId } from 'react';
import { ArrowRight, Search, Terminal, Table2, CircleAlert, Database } from 'lucide-react';
import connectionLostArt from '../public/images/collegamento-interrotto.webp';
import { EmptyState } from './components/arc/empty-state/empty-state';
import { Button } from './components/arc/button/button';

type EmptyKind = 'data' | 'search' | 'query' | 'error' | 'connection' | 'schema';
type EmptyOptions = {
  title: string;
  description: string;
  kind?: EmptyKind;
  compact?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  secondaryAction?: { label: string; onAction: () => void };
};
const mounts = new Map<HTMLElement, { host: HTMLElement; root: Root }>();

export function ConnectionLostArt() {
  const id = useId().replaceAll(':', '');
  // I ritagli conservano il disegno originale; il cavo si estende dal punto di attacco.
  return <svg className="connection-lost-art" viewBox="0 0 960 400" width={960} height={400} aria-hidden="true">
    <defs>
      <clipPath id={`${id}-base`}><path clipRule="evenodd" d="M0 0H960V400H0Z M451 298H527V351H451Z M546 298H634V351H546Z" /></clipPath>
      <clipPath id={`${id}-left`}><rect x="451" y="298" width="76" height="53" /></clipPath>
      <clipPath id={`${id}-right`}><rect x="546" y="298" width="88" height="53" /></clipPath>
    </defs>
    <image className="connection-lost-base" href={connectionLostArt} width="960" height="400" clipPath={`url(#${id}-base)`} />
    <g className="connection-cable connection-cable-left"><image href={connectionLostArt} width="960" height="400" clipPath={`url(#${id}-left)`} /></g>
    <g className="connection-cable connection-cable-right"><image href={connectionLostArt} width="960" height="400" clipPath={`url(#${id}-right)`} /></g>
  </svg>;
}

// La stessa tabella illustrata accompagna tutti gli stati vuoti; cambia solo il simbolo del contesto.
export function DataEmptyArt({ kind = 'data' }: { kind?: EmptyKind }) {
  const Icon = { data: Table2, search: Search, query: Terminal, error: CircleAlert, connection: Database, schema: Database }[kind];
  return <div className="data-empty-art" aria-hidden="true"><div className="data-empty-table"><div className="data-empty-table-head"><i /><i /><i /></div>
    <div className="data-empty-table-rows">{Array.from({ length: 9 }, (_, i) => <span key={i} />)}</div></div>
    <span className="data-empty-symbol"><Icon size={22} strokeWidth={1.6} /></span></div>;
}

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
  entry.host.classList.toggle('data-empty-compact-host', !!options.compact);
  flushSync(() => entry!.root.render(<EmptyState className={`data-empty${options.compact ? ' data-empty-compact' : ''}`} title={options.title} description={options.description} label={options.title}
    icon={<DataEmptyArt kind={options.kind} />}
    action={options.onAction && options.actionLabel ? <div className="data-empty-actions"><Button type="button" variant={options.kind === 'connection' ? 'primary' : 'secondary'} size={options.kind === 'connection' ? 'md' : 'sm'} onClick={options.onAction}>
      {options.actionLabel}<ArrowRight size={14} aria-hidden="true" /></Button>
      {options.secondaryAction && <Button type="button" variant="ghost" size="sm" onClick={options.secondaryAction.onAction}>{options.secondaryAction.label}</Button>}</div> : undefined} />));
}

// Split e viste dinamiche possono rimuovere il contenitore completo.
new MutationObserver(() => {
  for (const [container, entry] of mounts) if (!entry.host.isConnected) renderDataEmpty(container, null);
}).observe(document.body, { childList: true, subtree: true });
