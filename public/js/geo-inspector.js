'use strict';

import { preparaTransizioneTab } from './tab-motion.js';

// Le due mappe condividono navigazione e movimento, mantenendo istanze indipendenti.
export function creaIspettoreGeo(prefisso, ridimensiona) {
  const el = nome => document.getElementById(`${prefisso}-${nome}`);
  const corpo = el('body'), tabs = el('tabs'), mappa = el('map-panel');
  const pannelli = [mappa, el('list-panel'), el('summary-panel')];
  const ridotto = matchMedia('(prefers-reduced-motion: reduce)');
  const compatto = () => getComputedStyle(el('tab-mappa')).display !== 'none';
  let eraCompatto;

  function ferma() { pannelli.forEach(p => p.getAnimations().forEach(a => a.cancel())); }

  function cambia(modo, anima = true) {
    const stretto = compatto();
    if (!stretto && modo === 'mappa') modo = 'elenco';
    const completa = preparaTransizioneTab(tabs);
    const precedente = corpo.dataset.mode;
    corpo.dataset.mode = modo;
    mappa.setAttribute('role', stretto ? 'tabpanel' : 'region');
    if (stretto) mappa.setAttribute('aria-labelledby', el('tab-mappa').id);
    else mappa.removeAttribute('aria-labelledby');
    for (const tab of tabs.querySelectorAll('[role="tab"]')) {
      const attiva = tab.dataset.tabId === modo;
      tab.setAttribute('aria-selected', String(attiva));
      tab.tabIndex = attiva ? 0 : -1;
    }
    ferma();
    el('list-panel').classList.toggle('hidden', modo !== 'elenco');
    el('summary-panel').classList.toggle('hidden', modo !== 'riepilogo');
    if (anima && precedente !== modo && !ridotto.matches) {
      const panel = modo === 'mappa' ? mappa : el(modo === 'elenco' ? 'list-panel' : 'summary-panel');
      panel.animate([
        { opacity: .4, clipPath: 'inset(0 0 10px 0)' },
        { opacity: 1, clipPath: 'inset(0)' },
      ], { duration: 240, easing: 'cubic-bezier(.16, 1, .3, 1)' });
    }
    completa();
    ridimensiona();
  }

  function aggiorna(reset = false) {
    if (!corpo.getBoundingClientRect().width) return;
    const stretto = compatto();
    if (reset || stretto !== eraCompatto) {
      const focusNascosto = document.activeElement === el('tab-mappa') && !stretto;
      eraCompatto = stretto;
      cambia(stretto ? 'mappa' : 'elenco', false);
      if (focusNascosto) el('tab-elenco').focus({ preventScroll: true });
    }
  }

  function selezione(g) {
    el('selection').textContent = g
      ? `${g.colonna || g.tipo}${g.riga === null ? '' : ` · Riga ${g.riga + 1}`} · ${g.tipo} · ${g.vertici.toLocaleString('it-IT')} ${g.vertici === 1 ? 'vertice' : 'vertici'}`
      : 'Scegli una geometria sulla mappa o nell’elenco.';
    if (g && compatto()) {
      const focusNellElenco = el('list').contains(document.activeElement);
      cambia('mappa');
      if (focusNellElenco) el('tab-mappa').focus({ preventScroll: true });
    }
  }

  tabs.addEventListener('click', e => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) cambia(tab.dataset.tabId);
  });
  tabs.addEventListener('keydown', e => {
    const visibili = [...tabs.querySelectorAll('[role="tab"]')].filter(t => t.offsetWidth);
    const index = visibili.indexOf(e.target.closest('[role="tab"]'));
    if (index < 0) return;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? visibili.length - 1
      : e.key === 'ArrowRight' ? (index + 1) % visibili.length
        : e.key === 'ArrowLeft' ? (index + visibili.length - 1) % visibili.length : -1;
    if (next >= 0) { e.preventDefault(); cambia(visibili[next].dataset.tabId); visibili[next].focus(); }
  });
  new ResizeObserver(() => aggiorna()).observe(corpo);
  ridotto.addEventListener('change', () => { if (ridotto.matches) ferma(); });
  return { aggiorna, selezione, ferma };
}
