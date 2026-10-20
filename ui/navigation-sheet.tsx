import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { cloneElement, useLayoutEffect, useRef, type ReactElement } from 'react';
import { BottomSheet, type BottomSheetProps } from './components/arc/bottom-sheet/bottom-sheet';

function Navigatore({ panel, tools, navigation }: { panel: HTMLElement; tools: boolean; navigation: boolean }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Stessi nodi e controller: il passaggio mobile non ricrea alberi o controlli Arc.
    const nodes = [panel, ...(tools ? [document.getElementById('navigator-tools')!] : []), ...(navigation ? [document.getElementById('mobile-bottom-nav')!] : []), document.getElementById('context-menu')!].map(node => ({ node, parent: node.parentNode!, next: node.nextSibling }));
    const scroll = [...panel.querySelectorAll<HTMLElement>('*')].filter(node => node.scrollTop).map(node => [node, node.scrollTop] as const);
    const body = panel.querySelector<HTMLElement>('.navigator-section-body') || panel;
    const collapsed = body.classList.contains('hidden');
    const hidden = panel.classList.contains('hidden');
    const width = panel.style.width;
    panel.style.removeProperty('width');
    panel.classList.remove('hidden');
    body.classList.remove('hidden');
    nodes.forEach(({ node }) => slot.current!.append(node));
    scroll.forEach(([node, top]) => { node.scrollTop = top; });
    return () => {
      const current = [...panel.querySelectorAll<HTMLElement>('*')].filter(node => node.scrollTop).map(node => [node, node.scrollTop] as const);
      nodes.forEach(({ node, parent, next }) => {
        if (node.parentNode === slot.current) (parent.isConnected ? parent : document.body).insertBefore(node, next?.parentNode === parent && parent.isConnected ? next : null);
      });
      panel.style.width = width;
      body.classList.toggle('hidden', collapsed);
      panel.classList.toggle('hidden', hidden);
      current.forEach(([node, top]) => { node.scrollTop = top; });
    };
  }, [panel, tools, navigation]);
  return <div ref={slot} className="arc-navigation-slot" />;
}

let root: ReturnType<typeof createRoot> | undefined;
let current: { element: ReactElement<BottomSheetProps>; notify: () => void; closing: boolean } | undefined;
export function closeNavigationSheet(immediate = false) {
  const entry = current;
  if (!entry) return;
  const finish = () => {
    if (current !== entry) return;
    current = undefined;
    flushSync(() => root!.render(null));
    entry.notify();
  };
  if (immediate) { finish(); return; }
  if (entry.closing) return;
  entry.closing = true;
  flushSync(() => root!.render(cloneElement(entry.element, { open: false, onExitComplete: () => queueMicrotask(finish) })));
}
export function openNavigationSheet(panel: HTMLElement, onClose: () => void, options: { title?: string; description?: string; tools?: boolean; navigation?: boolean; fitContent?: boolean } = {}) {
  closeNavigationSheet(true);
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  const connections = panel.id === 'conn-sidebar';
  const element = <BottomSheet open title={options.title ?? (connections ? 'Connessioni' : document.getElementById('explorer-title')!.textContent!.trim())}
    description={options.description ?? (connections ? 'Scegli una connessione o aggiungine una nuova.' : document.getElementById('explorer-context')?.textContent?.trim())}
    fitContent={options.fitContent} detents={[.7, .94]} initialDetent={(window.visualViewport?.height ?? window.innerHeight) < 600 ? 1 : 0} className="arc-navigation-sheet"
    onOpenChange={open => { if (!open) closeNavigationSheet(); }}
    onCloseAutoFocus={event => event.preventDefault()}
    onEscapeKeyDown={event => {
      // Escape chiude prima il menu e restituisce il fuoco al suo pulsante.
      if (document.querySelector('.toolbar-dropdown-menu:not(.hidden)')) {
        event.preventDefault();
        document.querySelectorAll<HTMLElement>('.toolbar-dropdown-menu:not(.hidden)').forEach(menu => {
          menu.classList.add('hidden');
          document.getElementById(menu.dataset.dropdownTrigger || '')?.focus({ preventScroll: true });
        });
        document.querySelectorAll('[aria-haspopup="true"][aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
      }
      else if (document.querySelector('.overlay:not(.hidden), #context-menu:not(.hidden), [data-state="open"][role="menu"]')) event.preventDefault();
      else event.stopImmediatePropagation(); // Escape appartiene al drawer, non alla selezione sul canvas sottostante.
    }}>
    <Navigatore panel={panel} tools={options.tools !== false} navigation={options.navigation !== false} />
  </BottomSheet>;
  current = { element, notify: onClose, closing: false };
  flushSync(() => root!.render(element));
}
