import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useEffect, useState } from 'react';
import { ChevronDown, CircleAlert, TriangleAlert, X } from 'lucide-react';
import { Button } from './components/arc/button/button';
import { Dialog, DialogContent } from './components/arc/dialog/dialog';
import { ConnectionLostArt } from './data-empty';
import { PulsanteCopiaErrore } from './copia-errore';

type Feedback = {
  message: string;
  tipo?: 'errore' | 'avviso' | 'inline' | 'banner' | 'vista' | 'collegamento';
  tono?: 'avviso';
  titolo?: string;
  target?: string | HTMLElement;
  campo?: string;
  id?: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => unknown;
  onDismiss?: () => void;
  document?: Document;
};
type Entry = { host: HTMLElement; root: Root; close: (dismissed?: boolean) => void };

function Messaggio({ feedback: f, close }: { feedback: Feedback; close: () => void }) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [paused, setPaused] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const warning = f.tipo === 'avviso' || f.tono === 'avviso';
  useEffect(() => {
    // Gli avvisi locali restano fino alla correzione; quelli passeggeri si possono leggere in pausa.
    if (f.tipo !== 'avviso' || paused) return;
    const timer = window.setTimeout(close, 8000);
    return () => window.clearTimeout(timer);
  }, [f.tipo, paused, close]);
  const technical = f.message.indexOf('(dettaglio tecnico:');
  const message = technical >= 0 ? f.message.slice(0, technical).trim() : f.message;
  const details = technical >= 0 ? f.message.slice(technical).replace(/^\(dettaglio tecnico:\s*/, '').replace(/\)\s*$/, '') : '';
  const Icon = warning ? TriangleAlert : CircleAlert;
  return <section className="feedback-message" data-tipo={f.tipo || 'errore'} data-tone={warning ? 'warning' : 'error'} role={warning ? 'status' : 'alert'} aria-atomic="true"
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocusCapture={() => setPaused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}>
    {f.tipo === 'collegamento'
      ? <ConnectionLostArt />
      : <Icon size={20} aria-hidden="true" />}
    <div className="feedback-copy">
      {f.titolo && <strong>{f.titolo}</strong>}
      <p>{message}</p>
      {f.hint && <p className="feedback-hint">{f.hint}</p>}
      {details && <details className="feedback-details" onToggle={event => setDetailsOpen(event.currentTarget.open)}>
        <summary>{detailsOpen ? 'Mostra meno' : 'Mostra altro'}<ChevronDown size={14} aria-hidden="true" /></summary>
        <pre>{details}</pre>
      </details>}
      {actionError && <p role="alert">{actionError}</p>}
      {(f.onAction || !warning) && <div className="feedback-copy-action">
        {f.onAction && <Button type="button" disabled={busy} onClick={async () => {
        setBusy(true); setActionError('');
        try { await f.onAction?.(); if (f.tipo !== 'banner' && f.tipo !== 'collegamento') close(); }
        catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
      }}>{busy ? 'Attendere…' : f.actionLabel || 'Riprova'}</Button>}
        {!warning && <PulsanteCopiaErrore text={[f.titolo, f.message, f.hint].filter(Boolean).join('\n\n')} showLabel={!f.onAction} />}
        {f.tipo === 'collegamento' && <Button type="button" variant="ghost" className="connection-lost-continue" onClick={close}>Continua a lavorare</Button>}
      </div>}
    </div>
    <button type="button" className="feedback-close" aria-label="Chiudi messaggio" onClick={close}><X size={18} aria-hidden="true" /></button>
  </section>;
}

export function initNotifiche() {
  const entries = new Map<string, Entry>();
  const documents = new WeakMap<Document, number>();
  const targets = new WeakMap<HTMLElement, string>();
  let serial = 0;
  const documentId = (owner: Document) => {
    if (!documents.has(owner)) documents.set(owner, ++serial);
    return documents.get(owner);
  };
  const snackbar = document.createElement('div');
  snackbar.id = 'feedback-container';
  snackbar.setAttribute('aria-label', 'Messaggi delle operazioni');
  snackbar.setAttribute('aria-live', 'polite');
  const toasts = document.getElementById('toast-container');
  if (toasts) snackbar.append(toasts);
  document.body.append(snackbar);
  document.addEventListener('codedb:feedback-close', event => {
    const { id, document: owner = document } = (event as CustomEvent<{ id: string; document?: Document }>).detail;
    entries.get(`${documentId(owner)}:${id}`)?.close();
  });
  document.addEventListener('codedb:feedback', event => {
    const f = (event as CustomEvent<Feedback>).detail;
    const owner = f.document || document;
    const target = typeof f.target === 'string' ? owner.querySelector<HTMLElement>(f.target) : f.target;
    const arcHost = target?.hasAttribute('data-arc-model') ? target.nextElementSibling as HTMLElement | null : null;
    const surface = arcHost?.querySelector<HTMLElement>('button, input, textarea') || target;
    const local = ['inline', 'vista'].includes(f.tipo || '') && target?.isConnected && surface?.getClientRects().length;
    // Il documento proprietario distingue anche i pannelli affiancati con gli stessi ID.
    if (local && target && !targets.has(target)) targets.set(target, String(++serial));
    const id = `${documentId(owner)}:${f.id || (local && target ? targets.get(target) : `${f.tipo}:${f.titolo}:${f.message}`)}`;
    const previous = entries.get(id);
    previous?.close();
    const focusedBefore = owner.activeElement as HTMLElement | null;
    const host = owner.createElement(local && target?.matches('ul, ol') ? 'li' : 'div');
    host.className = 'feedback-host';
    host.dataset.feedbackId = id;
    let cleanup = () => {};
    if (local && target) {
      host.classList.add('feedback-local');
      if (target.matches('input, textarea, select')) (arcHost || target).insertAdjacentElement('afterend', host);
      else target.prepend(host);
      const field = f.campo ? owner.querySelector<HTMLElement>(f.campo) : target.matches('input, textarea, select') ? surface : null;
      const before = field?.getAttribute('aria-describedby');
      const invalidBefore = field?.getAttribute('aria-invalid');
      host.id = `feedback-field-${serial++}`;
      field?.setAttribute('aria-invalid', 'true');
      field?.setAttribute('aria-describedby', [before, host.id].filter(Boolean).join(' '));
      const clear = () => close();
      target.addEventListener('input', clear, { once: true });
      target.addEventListener('change', clear, { once: true });
      cleanup = () => {
        target.removeEventListener('input', clear); target.removeEventListener('change', clear);
        if (invalidBefore) field?.setAttribute('aria-invalid', invalidBefore); else field?.removeAttribute('aria-invalid');
        if (before) field?.setAttribute('aria-describedby', before); else field?.removeAttribute('aria-describedby');
      };
    } else if (f.tipo === 'collegamento') {
      host.classList.add('connection-lost-layer');
      document.body.append(host);
    } else if (f.tipo === 'banner') {
      host.classList.add('feedback-banner');
      (document.querySelector('#app') || document.body).prepend(host);
    } else snackbar.append(host);
    const root = createRoot(host);
    let closed = false;
    const close = (dismissed = false) => {
      if (closed) return;
      closed = true; cleanup(); observer.disconnect(); owner.defaultView?.removeEventListener('pagehide', pagehide);
      if (dismissed) f.onDismiss?.();
      if (f.tipo === 'collegamento' && host.contains(owner.activeElement) && focusedBefore?.isConnected) focusedBefore.focus({ preventScroll: true });
      entries.delete(id); root.unmount(); host.remove();
    };
    // Un ridisegno può staccare un errore locale: conserva il messaggio finché viene letto.
    const observer = new MutationObserver(() => {
      if (!host.isConnected) { cleanup(); cleanup = () => {}; snackbar.append(host); observer.disconnect(); }
    });
    if (local) observer.observe(owner, { subtree: true, childList: true });
    const pagehide = () => close();
    owner.defaultView?.addEventListener('pagehide', pagehide, { once: true });
    entries.set(id, { host, root, close });
    const message = <Messaggio feedback={f} close={() => close(true)} />;
    flushSync(() => root.render(f.tipo === 'collegamento'
      ? <Dialog open modal={false} onOpenChange={open => { if (!open) close(true); }}>
          <DialogContent embedded container={host} className="connection-lost-panel" title={f.titolo || 'Collegamento a CodeDB interrotto'}
            onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
            onFocusOutside={event => event.preventDefault()}>{message}</DialogContent>
        </Dialog>
      : message));
  });
}
