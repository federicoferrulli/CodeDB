// Come le tab, la selezione si muove senza ricostruire o rallentare il contenuto.
const alberi = new WeakMap();
const ridotto = window.matchMedia('(prefers-reduced-motion: reduce)');
const easing = 'cubic-bezier(0.16, 1, 0.3, 1)';

export function preparaTransizioneAlbero(tree, contesto = '', { selettore = '.node-label.selected', durata = 260 } = {}) {
  let stato = alberi.get(tree);
  if (!stato) {
    const indicatore = document.createElement('li');
    indicatore.className = 'navigator-selection';
    indicatore.setAttribute('aria-hidden', 'true');
    stato = { indicatore, contesto, aggiorna: null };
    stato.observer = new ResizeObserver(() => stato.aggiorna?.());
    alberi.set(tree, stato);
  }
  const origine = stato.indicatore.isConnected ? stato.indicatore.getBoundingClientRect() : null;
  const stessoContesto = stato.contesto === contesto;
  const scroll = tree.scrollTop;
  stato.observer.disconnect();
  stato.indicatore.getAnimations().forEach(a => a.cancel());
  tree.getAnimations().forEach(a => a.cancel());
  stato.contesto = contesto;

  return () => {
    tree.scrollTop = stessoContesto ? scroll : 0;
    const attiva = tree.querySelector(selettore);
    const indicatore = stato.indicatore;
    const posiziona = () => {
      if (!attiva?.isConnected || !attiva.getClientRects().length || !tree.clientHeight) {
        indicatore.remove(); return null;
      }
      const r = attiva.getBoundingClientRect(), b = tree.getBoundingClientRect();
      const sx = b.width / tree.offsetWidth || 1, sy = b.height / tree.offsetHeight || 1;
      const x = (r.left - b.left) / sx + tree.scrollLeft, y = (r.top - b.top) / sy + tree.scrollTop;
      const geometria = `${x}:${y}:${attiva.offsetWidth}:${attiva.offsetHeight}`;
      if (indicatore.dataset.geometria !== geometria || !indicatore.isConnected) {
        indicatore.getAnimations().forEach(a => a.cancel());
        Object.assign(indicatore.style, { left: `${x}px`, top: `${y}px`, width: `${attiva.offsetWidth}px`, height: `${attiva.offsetHeight}px` });
        indicatore.dataset.geometria = geometria;
        tree.append(indicatore);
      }
      return r;
    };
    tree.classList.add('navigator-motion-ready');
    const destinazione = posiziona();
    const anima = (el, frames, duration) => {
      const a = el.animate(frames, { duration, easing });
      a.finished.then(() => a.cancel(), () => {});
    };
    if (!ridotto.matches) {
      if (destinazione && origine?.height && stessoContesto) {
        const dx = origine.left - destinazione.left, dy = origine.top - destinazione.top;
        if (Math.abs(dx) > .5 || Math.abs(dy) > .5) anima(indicatore, [
          { transform: `translate(${dx}px, ${dy}px) scale(${origine.width / destinazione.width}, ${origine.height / destinazione.height})` },
          { transform: 'none' },
        ], durata);
      }
      if (!stessoContesto && tree.clientHeight) anima(tree, [
        { opacity: .65, transform: 'translateX(6px)' }, { opacity: 1, transform: 'none' },
      ], 180);
    }
    stato.aggiorna = posiziona;
    stato.observer.observe(tree);
    if (attiva) stato.observer.observe(attiva);
  };
}

ridotto.addEventListener('change', () => {
  for (const tree of document.querySelectorAll('#conn-tree, #db-tree, #palette-lista')) {
    if (ridotto.matches) tree.getAnimations({ subtree: true }).forEach(a => a.cancel());
    alberi.get(tree)?.aggiorna?.();
  }
});

export function fermaTransizioniAlbero(tree) {
  alberi.get(tree)?.observer.disconnect();
  tree.getAnimations({ subtree: true }).forEach(a => a.cancel());
  alberi.delete(tree);
}
