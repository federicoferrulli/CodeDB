import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useState } from 'react';
import { EmptyState } from './components/arc/empty-state/empty-state';
import Toast from './components/arc/toast/toast';
import { initDialogs } from './dialogs';
import { initSettings } from './settings';
import { initPrompt } from './prompt';
import { initControls } from './controls';
import { initErrors } from './errors';
import './components/arc/foundation.css';
export { createArcInput, createArcTextarea, createArcButton, createArcSelect, createArcCheckbox, controlElement, updateArcSelect, mountArcEditActions } from './editor-controls';
export { initControls as mountArcControls } from './controls';
export { openNavigationSheet, closeNavigationSheet } from './navigation-sheet';
export { removeDialog } from './dialogs';
import { DataEmptyArt, renderDataEmpty } from './data-empty';
export { renderDataEmpty };
import { initGridFields } from './editor-controls';
import { observeFields } from './fields';
import { Button } from './components/arc/button/button';
import { Database } from 'lucide-react';

initControls();
initGridFields();
observeFields();
initErrors();

// Le due viste vuote non hanno stato duplicato: visibilità e azioni restano
// quelle del workspace, i componenti Arc ne possiedono solo il contenuto.
const welcome = document.getElementById('welcome');
if (welcome) {
  welcome.replaceChildren();
  renderDataEmpty(welcome, {
    title: 'Nessuna connessione aperta',
    description: 'Apri una connessione salvata da Connessioni oppure aggiungine una nuova.',
    kind: 'connection', actionLabel: 'Aggiungi connessione',
    onAction: () => document.getElementById('conn-add-btn')?.click(),
  });
}
const placeholder = document.getElementById('placeholder');
if (placeholder) {
  const root = createRoot(placeholder);
  const mobile = window.matchMedia('(max-width: 900px)');
  const render = () => flushSync(() => root.render(<EmptyState className="explore-empty" title="Esplora i dati"
    description={mobile.matches
      ? 'Apri lo schema e scegli una tabella o collezione. Lo ritrovi sempre in Database nella barra in basso.'
      : 'Seleziona una tabella o collezione dalla barra laterale per visualizzare le righe o eseguire query avanzate.'}
    action={mobile.matches ? <Button id="explore-schema-open" type="button" variant="primary" size="md" aria-controls="sidebar" aria-expanded="false"
      onClick={() => document.getElementById('mobile-nav-dbs')?.click()}><Database size={18} aria-hidden="true" />Apri schema database</Button> : undefined}
    icon={<DataEmptyArt kind="schema" />} label="Esplora i dati" />));
  render();
  mobile.addEventListener('change', render);
}

initPrompt();

type Notice = { id: number; message: string; type: 'info' | 'success' | 'error' | 'warning'; duration: number; replace?: boolean };
let notify: (notice: Omit<Notice, 'id'>) => void;
function Notifications() {
  const [items, setItems] = useState<Notice[]>([]);
  notify = notice => setItems(current => [...(notice.replace ? current.filter(i => !i.replace) : current), { ...notice, id: ++noticeId }]);
  return <>{items.map(item => <div key={item.id} id={item.replace ? 'toast' : undefined}><Toast title={item.message} tone={item.type}
    duration={item.duration} onOpenChange={open => { if (!open) setItems(current => current.filter(i => i.id !== item.id)); }} /></div>)}</>;
}
let noticeId = 0;
const notifications = document.getElementById('toast-container');
if (notifications) {
  document.getElementById('toast')?.remove();
  notifications.className = 'arc-notifications';
  // Radix conserva le regioni live anche quando una finestra protegge il focus.
  notifications.setAttribute('aria-live', 'polite');
  notifications.removeAttribute('aria-atomic');
  flushSync(() => createRoot(notifications).render(<Notifications />));
  document.addEventListener('codedb:toast', event => notify((event as CustomEvent<Omit<Notice, 'id'>>).detail));
}
initDialogs();
document.addEventListener('codedb:settings-ready', initSettings, { once: true });
document.documentElement.dataset.arcReady = 'true';
