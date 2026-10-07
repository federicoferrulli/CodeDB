import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useState } from 'react';
import { Database, LayoutGrid } from 'lucide-react';
import { Button } from './components/arc/button/button';
import { EmptyState } from './components/arc/empty-state/empty-state';
import Toast from './components/arc/toast/toast';
import { initDialogs } from './dialogs';
import { initSettings } from './settings';
import { initPrompt } from './prompt';
import { initControls } from './controls';
import { initErrors } from './errors';
import './components/arc/foundation.css';
export { createArcInput, createArcButton, createArcSelect, createArcCheckbox, controlElement, updateArcSelect } from './editor-controls';
export { initControls as mountArcControls } from './controls';
import { initGridFields } from './editor-controls';
import { observeFields } from './fields';

initControls();
initGridFields();
observeFields();
initErrors();

// Le due viste vuote non hanno stato duplicato: visibilità e azioni restano
// quelle del workspace, i componenti Arc ne possiedono solo il contenuto.
for (const [id, title, description, Icon] of [
  ['welcome', 'Nessuna connessione aperta', 'Apri una connessione salvata dalla barra laterale oppure aggiungi un database per iniziare.', Database],
  ['placeholder', 'Esplora i dati', 'Seleziona una collection o tabella dalla barra laterale per visualizzare le righe o eseguire query avanzate.', LayoutGrid],
] as const) {
  const host = document.getElementById(id);
  if (host) flushSync(() => createRoot(host).render(<EmptyState title={title} description={description}
    icon={<Icon size={28} strokeWidth={1.75} />} label={title}
    action={id === 'welcome' ? <Button type="button" onClick={() => document.getElementById('conn-add-btn')?.click()}>Aggiungi connessione</Button> : undefined} />));
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
