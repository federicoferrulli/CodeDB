import { showMobileError } from './mobile-error';

const pending = new Set<symbol>();
let progress: HTMLDivElement | undefined;

// Su mobile segue la nav nel drawer; su desktop resta in cima alla finestra.
function positionProgress() {
  const host = window.matchMedia('(max-width: 900px)').matches
    ? document.getElementById('mobile-bottom-nav') : document.body;
  if (progress && host) host.append(progress);
}

export function startConnection(name: string) {
  const id = Symbol();
  pending.add(id);
  if (!progress) {
    progress = document.createElement('div');
    progress.className = 'connection-progress';
    progress.setAttribute('role', 'progressbar');
    positionProgress();
    window.addEventListener('resize', positionProgress);
  }
  progress.setAttribute('aria-label', 'Connessione in corso');
  return (error?: string) => {
    if (!pending.delete(id)) return;
    if (!pending.size) {
      progress?.remove(); progress = undefined;
      window.removeEventListener('resize', positionProgress);
    }
    if (error) return showMobileError({ source: 'connection', title: 'Connessione non riuscita',
      description: `Non è stato possibile aprire “${name}”.`, message: error,
      hint: 'Controlla la connessione e i parametri, poi riprova.' });
  };
}
