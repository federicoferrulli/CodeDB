import { showMobileError } from './mobile-error';

const pending = new Set<symbol>();
let progress: HTMLDivElement | undefined;

/** Il feedback segue la stessa nav anche quando viene spostata nel drawer. */
export function startMobileConnection(name: string) {
  if (!window.matchMedia('(max-width: 900px)').matches) return null;
  const nav = document.getElementById('mobile-bottom-nav');
  if (!nav) return null;
  const id = Symbol();
  pending.add(id);
  if (!progress) {
    progress = document.createElement('div');
    progress.className = 'mobile-connection-progress';
    progress.setAttribute('role', 'progressbar');
    nav.append(progress);
  }
  progress.setAttribute('aria-label', 'Connessione in corso');
  return (error?: string) => {
    if (!pending.delete(id)) return;
    if (!pending.size) { progress?.remove(); progress = undefined; }
    if (error) showMobileError({ source: 'connection', title: 'Connessione non riuscita',
      description: `Non è stato possibile aprire “${name}”.`, message: error,
      hint: 'Controlla la connessione e i parametri, poi riprova.' });
  };
}
