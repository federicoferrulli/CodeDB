// Compatibilità per i chiamanti query: stesso feedback contestuale a ogni larghezza.
type ErrorFeedback = {
  source: string; title: string; message: string; description?: string; hint?: string;
  actionLabel?: string; onAction?: () => void;
};
function feedbackWindow() {
  return (window.frameElement as (Element & { codedbPanel?: unknown }) | null)?.codedbPanel ? window.parent : window;
}
export function isMobileFeedback() {
  return feedbackWindow().matchMedia('(max-width: 900px)').matches;
}
export function showMobileError(error: ErrorFeedback) {
  if ((window.frameElement as HTMLElement | null)?.hidden) return false;
  const box = document.getElementById('query-error-box');
  if (box) { box.dataset.errorInteractive = 'true'; box.classList.remove('hidden'); }
  feedbackWindow().document.dispatchEvent(new CustomEvent('codedb:feedback', {
    detail: { document, id: error.source, tipo: 'inline', target: '#query-error-box',
      titolo: error.title, message: error.message, hint: error.hint,
      actionLabel: error.actionLabel, onAction: error.onAction },
  }));
  return true;
}
export function clearMobileError(source: string) {
  feedbackWindow().document.dispatchEvent(new CustomEvent('codedb:feedback-close', { detail: { id: source, document } }));
}
