import { larghezzeColonne } from './table-cols.js';
import { displayValueBreve, showContextMenu, chiediTesto, toast } from './utils.js';
import { rendiTrascinabile } from './maniglia.js';

// Lo stato delle larghezze appartiene al documento o al pannello chiamante.
export function configuraColonne(table, { nomi, righe, larghezze, modificata = () => {} }) {
  const headers = [...table.tHead.rows[0].cells];
  const canvas = document.createElement('canvas').getContext('2d');
  const css = getComputedStyle(headers.find((_, i) => nomi[i] != null) || table);
  if (canvas) canvas.font = `600 ${css.fontSize} ${css.fontFamily}`;
  const misura = testo => canvas ? canvas.measureText(String(testo)).width : String(testo).length * 8;
  const automatiche = cols => larghezzeColonne(righe, cols, { misura, testo: v => displayValueBreve(v, 120).text, padding: 44, max: 560 });
  const mancanti = automatiche(nomi.filter(n => n != null && !larghezze.has(n)));
  const widths = nomi.map(nome => nome == null ? 48 : larghezze.get(nome) || mancanti.get(nome));
  let cg = table.querySelector('colgroup');
  if (!cg) { cg = document.createElement('colgroup'); table.prepend(cg); }
  cg.replaceChildren(...widths.map(w => { const col = document.createElement('col'); col.style.width = `${w}px`; return col; }));
  table.classList.add('resizable-grid');
  const aggiornaTotale = () => { table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`; };
  aggiornaTotale();
  headers.forEach((th, i) => {
    th.style.width = '';
    const nome = nomi[i];
    if (nome == null) return;
    th.scope = 'col';
    th.title = `${nome} — ${th.title || 'Bordo destro: larghezza e nome completo'}`;
    const handle = document.createElement('span');
    handle.className = 'qt-col-resizer'; handle.dataset.col = nome; handle.tabIndex = 0;
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `Larghezza colonna ${nome}`);
    handle.setAttribute('aria-valuemin', '64'); handle.setAttribute('aria-valuemax', '1600');
    handle.title = 'Trascina per ridimensionare. Clic o Invio: opzioni. Frecce: larghezza.';
    const aria = () => handle.setAttribute('aria-valuenow', String(Math.round(widths[i])));
    const scrivi = value => {
      widths[i] = Math.max(64, Math.min(1600, Math.round(value)));
      larghezze.set(nome, widths[i]); modificata(nome);
      cg.children[i].style.width = `${widths[i]}px`; aggiornaTotale(); aria();
    };
    const adatta = () => scrivi(automatiche([nome]).get(nome));
    const menu = () => {
      const r = handle.getBoundingClientRect();
      showContextMenu(r.left, r.bottom, [
        { label: `Colonna: ${nome}`, disabled: true },
        { label: 'Adatta al contenuto', action: adatta },
        { label: 'Imposta larghezza…', action: async () => {
          const value = await chiediTesto({ titolo: 'Larghezza colonna', sottotitolo: nome, etichetta: 'Pixel (64–1600)', valore: widths[i], ok: 'Applica' });
          if (value === null) return;
          const n = Number(value);
          if (!Number.isFinite(n) || n < 64 || n > 1600) { toast('Inserisci una larghezza fra 64 e 1600 pixel.', true); return; }
          scrivi(n);
        } },
        { label: 'Copia nome completo', action: () => navigator.clipboard.writeText(nome) },
      ]);
    };
    let spostato = false;
    rendiTrascinabile(handle, {
      inizio: () => { spostato = false; return widths[i]; },
      sposta: (delta, prima) => { if (Math.abs(delta) > 2) spostato = true; if (spostato) scrivi(prima + delta); },
    });
    handle.addEventListener('click', e => { e.stopPropagation(); if (!spostato) menu(); });
    handle.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); adatta(); });
    handle.addEventListener('keydown', e => {
      const delta = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : null;
      if (delta != null) { e.preventDefault(); e.stopPropagation(); scrivi(widths[i] + delta); }
      else if (['Enter', ' '].includes(e.key)) { e.preventDefault(); e.stopPropagation(); menu(); }
      else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); e.stopPropagation(); scrivi(e.key === 'Home' ? 64 : 1600); }
    });
    aria(); th.append(handle);
  });
}
