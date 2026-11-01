// Riordino locale alla barra; il payload nativo resta disponibile per la split view.
let corrente = null;
const ridotto = window.matchMedia('(prefers-reduced-motion: reduce)');

export function annullaRiordinoTab(bar) {
  if (corrente?.bar === bar) corrente.annulla();
}

export function makeDraggable(el, id, onReorder, getPayload) {
  el.draggable = true;
  el.addEventListener('dragstart', event => {
    corrente?.annulla();
    const bar = el.parentElement;
    const schede = [...bar.querySelectorAll('[role="tab"]')];
    const origine = schede.indexOf(el);
    const bordo = bar.getBoundingClientRect();
    const rects = schede.map(n => n.getBoundingClientRect());
    const posizioni = rects.map(r => ({ x: r.left - bordo.left + bar.scrollLeft, width: r.width }));
    const presa = event.clientX - rects[origine].left;
    const larghezza = posizioni[origine].width;
    const passo = larghezza + (parseFloat(getComputedStyle(bar).columnGap) || 0);
    const controllo = new AbortController();
    const signal = controllo.signal;
    let x = event.clientX, y = event.clientY, destinazione = origine, frame = 0, ultimoTempo = 0;
    let dentro = true;
    const anteprima = document.createElement('canvas');
    anteprima.width = anteprima.height = 1;
    event.dataTransfer.setDragImage(anteprima, 0, 0);
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', String(id));
    const payload = typeof getPayload === 'function' ? getPayload() : getPayload;
    if (payload) event.dataTransfer.setData('application/codedb-tab', JSON.stringify(payload));
    el.classList.add('dragging');
    bar.classList.add('tab-reordering');

    const annulla = () => {
      controllo.abort();
      cancelAnimationFrame(frame);
      schede.forEach(n => { n.style.removeProperty('transform'); n.classList.remove('dragging'); });
      bar.classList.remove('tab-reordering');
      document.body.classList.remove('split-dragging');
      if (corrente?.annulla === annulla) corrente = null;
    };
    corrente = { bar, annulla };

    const aggiorna = (tempo = performance.now()) => {
      frame = 0;
      if (!el.isConnected) { annulla(); return; }
      const r = bar.getBoundingClientRect();
      dentro = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      bar.classList.toggle('tab-reordering', dentro);
      if (!dentro) {
        schede.forEach(n => n.style.removeProperty('transform'));
        destinazione = origine;
        return;
      }
      // Scorrimento ai bordi anche quando il puntatore rimane fermo.
      const velocita = x < r.left + 32 ? -Math.min(1, (r.left + 32 - x) / 32)
        : x > r.right - 32 ? Math.min(1, (x - r.right + 32) / 32) : 0;
      bar.scrollLeft += velocita * Math.min(32, ultimoTempo ? tempo - ultimoTempo : 16) * .65;
      ultimoTempo = tempo;
      const left = Math.max(posizioni[0].x, Math.min(posizioni.at(-1).x + posizioni.at(-1).width - larghezza,
        x - r.left + bar.scrollLeft - presa));
      destinazione = origine;
      posizioni.forEach((p, i) => {
        if (i > origine && left + larghezza > p.x + p.width / 2) destinazione = i;
        if (i < origine && left < p.x + p.width / 2) destinazione = Math.min(destinazione, i);
      });
      schede.forEach((n, i) => {
        const dx = i === origine ? left - posizioni[i].x
          : i > origine && i <= destinazione ? -passo : i < origine && i >= destinazione ? passo : 0;
        n.style.transform = `translateX(${dx}px)`;
      });
      // Due frame ravvicinati possono produrre uno spostamento inferiore al
      // pixel, arrotondato dal browser. Non è il bordo: il gesto deve proseguire.
      const spazio = velocita < 0 ? bar.scrollLeft > 0 : bar.scrollLeft < bar.scrollWidth - bar.clientWidth;
      if (velocita && spazio) frame = requestAnimationFrame(aggiorna);
    };

    document.addEventListener('dragover', e => {
      x = e.clientX; y = e.clientY;
      if (bar.contains(e.target)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
      if (!frame) frame = requestAnimationFrame(aggiorna);
    }, { capture: true, signal });

    document.addEventListener('drop', e => {
      x = e.clientX; y = e.clientY;
      cancelAnimationFrame(frame);
      aggiorna();
      if (!dentro || !bar.contains(e.target)) { annulla(); return; }
      e.preventDefault();
      e.stopPropagation();
      const prima = new Map(schede.map(n => [n.dataset.tabId, n.getBoundingClientRect().left]));
      const target = schede[destinazione].dataset.tabId;
      annulla();
      bar.classList.add('tab-reordering');
      // Si conferma una sola volta, dopo l'anteprima: nessun editor viene rimontato durante il gesto.
      try { if (target !== String(id)) onReorder(id, target); }
      catch (error) { bar.classList.remove('tab-reordering'); throw error; }
      const nuove = [...bar.querySelectorAll('[role="tab"]')];
      const trascinata = nuove.find(n => n.dataset.tabId === String(id));
      trascinata?.classList.add('dragging');
      const animazioni = [];
      if (!ridotto.matches) for (const n of nuove) {
        const dx = (prima.get(n.dataset.tabId) ?? n.getBoundingClientRect().left) - n.getBoundingClientRect().left;
        if (Math.abs(dx) > .5) animazioni.push(n.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], {
          duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        }));
      }
      const termina = () => {
        animazioni.forEach(a => a.cancel());
        trascinata?.classList.remove('dragging');
        bar.classList.remove('tab-reordering');
        if (corrente?.annulla === termina) corrente = null;
      };
      corrente = { bar, annulla: termina };
      Promise.allSettled(animazioni.map(a => a.finished)).then(() => {
        if (corrente?.annulla === termina) termina();
      });
    }, { capture: true, signal });
    document.addEventListener('dragend', annulla, { signal });
    window.addEventListener('blur', annulla, { signal });
    window.addEventListener('resize', annulla, { signal });
  });
}

ridotto.addEventListener('change', () => { if (ridotto.matches) corrente?.annulla(); });
