import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Dialog, DialogContent } from './components/arc/dialog/dialog';
import { Button } from './components/arc/button/button';
import { DataEmptyArt } from './data-empty';

type MobileError = {
  source: string;
  title: string;
  message: string;
  description?: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
};

// Un pannello affiancato usa la finestra principale per viewport e snackbar.
function feedbackWindow() {
  return (window.frameElement as (Element & { codedbPanel?: unknown }) | null)?.codedbPanel ? window.parent : window;
}

export function isMobileFeedback() {
  return feedbackWindow().matchMedia('(max-width: 900px)').matches;
}

let root: ReturnType<typeof createRoot> | undefined;
let currentSource: string | undefined;
function close() {
  currentSource = undefined;
  root?.render(null);
}

window.addEventListener('codedb:mobile-error', event => {
  const { source, error } = (event as CustomEvent<{ source: string; error?: MobileError }>).detail;
  if (!error) { if (source === currentSource) close(); return; }
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  currentSource = source;
  flushSync(() => root!.render(<Dialog open modal={false} onOpenChange={open => { if (!open) close(); }}>
    <DialogContent embedded className={`illustrated-error-snackbar ${source === 'connection' ? 'connection-error-snackbar' : 'query-error-snackbar'}`} title={error.title}>
      <DataEmptyArt kind="error" />
      <div className="illustrated-error-copy">
        <h2>{error.title}</h2>
        {error.description && <p>{error.description}</p>}
        <p>{error.message}</p>
        {error.hint && <p>{error.hint}</p>}
      </div>
      <div className="illustrated-error-actions">
        <Button type="button" variant="secondary" onClick={close}>Ho capito</Button>
        {error.onAction && <Button type="button" onClick={() => { close(); error.onAction?.(); }}>{error.actionLabel || 'Riprova'}</Button>}
      </div>
    </DialogContent>
  </Dialog>));
});

export function showMobileError(error: MobileError) {
  if (!isMobileFeedback() || (window.frameElement as HTMLElement | null)?.hidden) return false;
  const target = feedbackWindow();
  target.dispatchEvent(new CustomEvent('codedb:mobile-error', { detail: { source: error.source, error } }));
  return true;
}

export function clearMobileError(source: string) {
  if ((window.frameElement as HTMLElement | null)?.hidden) return;
  feedbackWindow().dispatchEvent(new CustomEvent('codedb:mobile-error', { detail: { source } }));
}
