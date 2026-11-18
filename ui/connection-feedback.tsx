
const pending = new Map<symbol, string>();
let progress: HTMLDivElement | undefined;

// Su mobile segue la nav nel drawer; su desktop resta in cima alla finestra.
function positionProgress() {
  const host = window.matchMedia('(max-width: 900px)').matches
    ? document.getElementById('mobile-bottom-nav') : document.body;
  if (progress && host) host.append(progress);
}

export function startProgress(label: string) {
  const id = Symbol();
  pending.set(id, label);
  if (!progress) {
    progress = document.createElement('div');
    progress.className = 'connection-progress';
    progress.setAttribute('role', 'progressbar');
    positionProgress();
    window.addEventListener('resize', positionProgress);
  }
  const updateLabel = () => progress?.setAttribute('aria-label', [...new Set(pending.values())].join(' · '));
  updateLabel();
  return () => {
    if (!pending.delete(id)) return false;
    if (!pending.size) {
      progress?.remove(); progress = undefined;
      window.removeEventListener('resize', positionProgress);
    } else updateLabel();
    return true;
  };
}

export function startConnection(name: string, onEdit?: () => void, id?: string) {
  const finish = startProgress('Connessione in corso');
  return (error?: string) => {
    if (!finish()) return;
    if (error) {
      document.dispatchEvent(new CustomEvent('codedb:feedback', { detail: {
        tipo: 'errore', id,
        titolo: `Connessione a “${name}” non riuscita`, message: error,
        hint: error.includes('Cosa fare:') ? undefined : 'Controlla host, porta e credenziali della connessione.',
        actionLabel: 'Modifica connessione', onAction: onEdit,
      } }));
      return true;
    }
  };
}
