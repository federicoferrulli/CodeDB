import { toast } from './avvisi.js';

const CHIAVE = 'codedb:feedback-aptico';
const ridotto = window.matchMedia('(prefers-reduced-motion: reduce)');
let abilitato = true;
let ultimoImpulso = -Infinity;
let inizializzato = false;
const animazioni = new WeakMap();

function leggiPreferenza() {
  try { abilitato = localStorage.getItem(CHIAVE) !== 'off'; } catch { /* Conserva la scelta in memoria. */ }
}
leggiPreferenza();

// I pannelli incorporati passano dal frame principale, l'unico autorizzato dal contenitore.
export function feedbackAptico(tipo = 'pressione') {
  if (document.hidden) return;
  if (window.frameElement?.codedbPanel) {
    window.parent.__codedbFeedbackAptico?.(tipo);
    return;
  }
  if (!abilitato || typeof window.CodeDBShell?.postMessage !== 'function') return;
  const ora = performance.now();
  if (ora - ultimoImpulso < (tipo === 'selezione' ? 120 : 70)) return;
  try {
    window.CodeDBShell.postMessage(JSON.stringify({ op: 'haptic', kind: tipo }));
    ultimoImpulso = ora;
  } catch { /* Il feedback non deve interrompere l'operazione. */ }
}

function anima(elemento, fotogrammi) {
  if (!elemento || ridotto.matches || document.hidden) return;
  animazioni.get(elemento)?.cancel();
  const animazione = elemento.animate(fotogrammi, { duration: 140, easing: 'ease-out' });
  animazioni.set(elemento, animazione);
}

// Chiamato soltanto dal percorso di esecuzione, mai dal ripristino di una scheda.
export function feedbackQuery(stato) {
  const badge = document.getElementById('query-status-badge');
  if (!badge?.getClientRects().length) return;
  anima(badge, [{ transform: 'translateY(2px)' }, { transform: 'translateY(0)' }]);
  feedbackAptico(stato === 'success' ? 'conferma' : stato === 'error' ? 'errore' : 'pressione');
}

export function annunciaFeedback(testo) {
  const live = document.getElementById('feedback-live');
  if (live && !document.hidden) live.textContent = testo;
}

export function initFeedback() {
  if (inizializzato) return;
  inizializzato = true;
  window.__codedbFeedbackAptico = feedbackAptico;
  const live = document.createElement('span');
  live.id = 'feedback-live';
  live.className = 'visually-hidden';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-atomic', 'true');
  document.body.append(live);
  const opzione = document.getElementById('btn-feedback-aptico');
  const aggiorna = () => {
    if (!opzione) return;
    opzione.classList.toggle('hidden', typeof window.CodeDBShell?.postMessage !== 'function');
    opzione.querySelector('span').textContent = `Feedback aptico: ${abilitato ? 'di sistema' : 'disattivato'}`;
  };
  opzione?.addEventListener('click', () => {
    abilitato = !abilitato;
    let salvata = true;
    try { localStorage.setItem(CHIAVE, abilitato ? 'on' : 'off'); } catch { salvata = false; }
    aggiorna();
    toast((abilitato ? 'Feedback aptico secondo le preferenze Android.' : 'Feedback aptico disattivato.')
      + (salvata ? '' : ' Scelta valida solo per questa sessione.'));
  });
  window.addEventListener('storage', e => {
    if (e.key === CHIAVE || e.key === null) { leggiPreferenza(); aggiorna(); }
  });
  aggiorna();

  document.addEventListener('click', e => {
    if (!e.isTrusted) return;
    const pulsante = e.target.closest?.('button, [role="button"], [role="menuitem"], [role="tab"]');
    if (!pulsante || pulsante.matches(':disabled, [aria-disabled="true"]') || !pulsante.getClientRects().length) return;
    anima(pulsante, [{ scale: '.98' }, { scale: '1' }]);
    // La scelta «disattivato» non deve produrre un ultimo impulso.
    if (pulsante.id !== 'btn-feedback-aptico' && !pulsante.textContent.includes('Feedback aptico:')) feedbackAptico();
  }, true);
  ridotto.addEventListener('change', () => {
    if (ridotto.matches) document.getAnimations().filter(a => animazioni.get(a.effect?.target) === a).forEach(a => a.cancel());
  });
}
