// La selezione conserva la propria posizione anche quando la barra ricostruisce i nodi.
import { annullaRiordinoTab } from './tab-drag.js';
const barre = new WeakMap();
const ridotto = window.matchMedia('(prefers-reduced-motion: reduce)');
const easing = 'cubic-bezier(0.16, 1, 0.3, 1)';

export function preparaTransizioneTab(bar, contesto = '') {
  annullaRiordinoTab(bar);
  let stato = barre.get(bar);
  if (!stato) {
    const indicatore = document.createElement('span');
    indicatore.className = 'tab-selection';
    indicatore.setAttribute('aria-hidden', 'true');
    stato = { indicatore, animazioni: [], contesto, aggiorna: null };
    stato.observer = new ResizeObserver(() => stato.aggiorna?.());
    barre.set(bar, stato);
  }
  const prima = new Set([...bar.querySelectorAll('[role="tab"]')].map(el => el.dataset.tabId));
  const origine = stato.indicatore.isConnected ? stato.indicatore.getBoundingClientRect() : null;
  const precedente = bar.querySelector('[aria-selected="true"]')?.dataset.tabId;
  const stessoContesto = stato.contesto === contesto;
  const scroll = bar.scrollLeft;
  const focus = document.activeElement.closest?.('[role="tab"]');
  const focusQui = focus?.parentElement === bar;
  const chiusura = document.activeElement.matches('.conn-tab-close, .coll-tab-close');
  stato.observer.disconnect();
  stato.animazioni.forEach(a => a.cancel());
  stato.animazioni = [];
  stato.contesto = contesto;

  const anima = (el, frames, duration = 280) => {
    const a = el.animate(frames, { duration, easing });
    stato.animazioni.push(a);
    a.finished.then(() => a.cancel(), () => {});
  };

  return () => {
    const schede = [...bar.querySelectorAll('[role="tab"]')];
    const attiva = bar.querySelector('[aria-selected="true"]');
    const indicatore = stato.indicatore;
    bar.scrollLeft = stessoContesto ? scroll : 0;
    if (attiva && attiva.dataset.tabId !== precedente) {
      const r = attiva.getBoundingClientRect(), b = bar.getBoundingClientRect();
      if (r.left < b.left + 8) bar.scrollLeft -= b.left + 8 - r.left;
      else if (r.right > b.right - 8) bar.scrollLeft += r.right - b.right + 8;
    }
    const posiziona = () => {
      if (!attiva || !bar.clientHeight) { indicatore.remove(); return null; }
      const r = attiva.getBoundingClientRect();
      const x = attiva.offsetLeft, y = attiva.offsetTop;
      const geometria = `${x}:${y}:${attiva.offsetWidth}:${attiva.offsetHeight}`;
      if (indicatore.dataset.geometria !== geometria || !indicatore.isConnected) {
        indicatore.getAnimations().forEach(a => a.cancel());
        Object.assign(indicatore.style, { left: `${x}px`, top: `${y}px`, width: `${attiva.offsetWidth}px`, height: `${attiva.offsetHeight}px` });
        indicatore.dataset.geometria = geometria;
        bar.append(indicatore);
      }
      return r;
    };
    bar.classList.add('tab-motion-ready');
    const destinazione = posiziona();
    if (destinazione && !ridotto.matches && !bar.classList.contains('tab-reordering')) {
      if (origine?.width && stessoContesto) {
        const dx = origine.left - destinazione.left;
        const scala = origine.width / destinazione.width;
        if (Math.abs(dx) > .5 || Math.abs(scala - 1) > .005) {
          anima(indicatore, [{ transform: `translateX(${dx}px) scaleX(${scala})` }, { transform: 'none' }]);
        }
      } else if (prima.size) anima(indicatore, [{ opacity: .35 }, { opacity: 1 }], 180);
      // Le etichette restano nel flusso: spostarle con FLIP le sovrappone durante riordino e scroll.
      if (stessoContesto && prima.size) for (const el of schede) {
        if (!prima.has(el.dataset.tabId)) anima(el, [{ opacity: 0 }, { opacity: 1 }], 180);
      }
    }
    stato.aggiorna = posiziona;
    stato.observer.observe(bar);
    if (attiva) stato.observer.observe(attiva);
    if (focusQui) {
      const target = schede.find(el => el.dataset.tabId === focus.dataset.tabId) || attiva;
      (chiusura ? target?.querySelector('button[class$="-close"]') : target)?.focus({ preventScroll: true });
    }
  };
}

ridotto.addEventListener('change', () => {
  for (const bar of document.querySelectorAll('.tab-motion-ready')) {
    const stato = barre.get(bar);
    if (ridotto.matches) stato?.animazioni.forEach(a => a.cancel());
    stato?.aggiorna?.();
  }
});

export function fermaTransizioniTab(bar) {
  const stato = barre.get(bar);
  stato?.observer.disconnect();
  stato?.animazioni.forEach(a => a.cancel());
  barre.delete(bar);
}
