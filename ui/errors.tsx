import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Alert } from './components/arc/alert/alert';

export function initErrors() {
  const roots = new WeakMap<HTMLElement, { host: HTMLElement; root: Root }>();
  function render(element: HTMLElement, message: string) {
    let entry = roots.get(element);
    // Alcuni moduli ricreano il contenuto del contenitore al cambio di tab.
    if (entry && entry.host.parentElement !== element) { entry.root.unmount(); entry = undefined; }
    if (!entry) {
      const host = document.createElement('div');
      element.replaceChildren(host);
      entry = { host, root: createRoot(host) };
      roots.set(element, entry);
    }
    element.classList.add('arc-inline-alert');
    flushSync(() => entry.root.render(message ? <Alert tone="danger" title={message} /> : null));
  }
  document.addEventListener('codedb:field-error', event => {
    const { element, message } = (event as CustomEvent<{ element: HTMLElement; message: string }>).detail;
    render(element, message);
  });
  // Anche i form che aggiornano direttamente textContent usano lo stesso Alert.
  // Si osserva il solo contenitore, mai i figli React durante le animazioni.
  document.querySelectorAll<HTMLElement>('.error').forEach(element => {
    new MutationObserver(() => {
      if (element.firstChild === roots.get(element)?.host) return;
      render(element, element.textContent || '');
    }).observe(element, { childList: true });
    if (element.textContent?.trim()) render(element, element.textContent);
  });
}
