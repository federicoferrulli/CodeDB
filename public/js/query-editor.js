/**
 * CodeDB — Rifiniture dell'editor ⚡ Query & Aggregate
 *
 * Quattro cose che servono da quando nell'editor si scrivono SCRIPT e non più
 * solo query di una riga:
 *
 *  1. **Numeri di riga.** Gli errori del runner e dell'interprete dicono "riga
 *     N": senza una numerazione visibile quell'informazione è inutilizzabile.
 *  2. **Tab che indenta** invece di spostare il fuoco, con Shift+Tab che
 *     toglie il rientro e indentazione di un blocco selezionato.
 *  3. **Esegui la selezione**: con del testo selezionato, Ctrl+Invio esegue
 *     solo quello — il modo naturale di provare una riga di uno script lungo
 *     senza rieseguire tutto.
 *  4. **Riga in errore evidenziata**, così "riga 42" si vede invece di doverla
 *     cercare a mano.
 */

import { $ } from './utils.js';

const INDENT = '  ';
let rigaErrore = 0;
let erroreQuery = null;
const desktopErrore = (window.frameElement?.codedbPanel ? window.parent : window)
  .matchMedia('(min-width: 901px) and (hover: hover) and (pointer: fine)');
let tooltipErrore = null;
let chiusuraTooltip = null;

function nascondiSuggerimentoErrore() {
  clearTimeout(chiusuraTooltip);
  tooltipErrore?.remove();
  tooltipErrore = null;
}

function rinviaChiusuraTooltip() {
  if (!tooltipErrore) return;
  clearTimeout(chiusuraTooltip);
  chiusuraTooltip = setTimeout(nascondiSuggerimentoErrore, 120);
}

function mostraSuggerimentoErrore(message, anchor) {
  clearTimeout(chiusuraTooltip);
  if (!tooltipErrore) {
    tooltipErrore = document.createElement('div');
    tooltipErrore.className = 'query-error-tooltip';
    tooltipErrore.setAttribute('role', 'tooltip');
    tooltipErrore.addEventListener('pointerenter', () => clearTimeout(chiusuraTooltip));
    tooltipErrore.addEventListener('pointerleave', nascondiSuggerimentoErrore);
    document.body.append(tooltipErrore);
  }
  if (tooltipErrore.textContent !== message) tooltipErrore.textContent = message;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
  const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
  tooltipErrore.style.maxWidth = `${Math.max(0, Math.min(320, width - 24))}px`;
  tooltipErrore.style.maxHeight = `${Math.max(0, Math.min(180, height - 24))}px`;
  const bounds = tooltipErrore.getBoundingClientRect();
  const x = Math.max(left + 12, Math.min(anchor.left, left + width - bounds.width - 12));
  const below = anchor.bottom + 8;
  const y = below + bounds.height <= top + height - 12 ? below : anchor.top - bounds.height - 8;
  tooltipErrore.style.left = `${x}px`;
  tooltipErrore.style.top = `${Math.max(top + 12, Math.min(y, top + height - bounds.height - 12))}px`;
}

function suggerimentoErrore(event) {
  let anchor;
  // Il mouse incontra la textarea trasparente, sopra ai token sottolineati.
  const colpito = desktopErrore.matches && event.pointerType === 'mouse' && erroreQuery
    && [...document.querySelectorAll('#query-editor-code .query-error-mark')].some(mark =>
      [...mark.getClientRects()].some(rect => {
        const width = rect.width || parseFloat(getComputedStyle(mark).fontSize) * 0.6;
        const hit = event.clientX >= rect.left && event.clientX <= rect.left + width
          && event.clientY >= rect.top && event.clientY <= rect.bottom + 4;
        if (hit) anchor = rect;
        return hit;
      }));
  if (colpito) mostraSuggerimentoErrore(erroreQuery.messaggio, anchor);
  else if (event.pointerType === 'touch' || !desktopErrore.matches) nascondiSuggerimentoErrore();
  else rinviaChiusuraTooltip();
}

/* --------------------------------------------------------------------------
 * Numeri di riga
 * ------------------------------------------------------------------------ */

export function aggiornaNumeriRiga() {
  const editor = $('#query-editor-input');
  const gutter = $('#query-editor-gutter');
  if (!editor || !gutter) return;

  const totale = editor.value.split('\n').length;
  const attuali = gutter.childElementCount;
  if (attuali === totale && !rigaErrore) {
    sincronizzaScroll();
    return;
  }

  // Si ridisegna solo quando il numero di righe cambia: su uno script lungo
  // rifare il gutter a ogni tasto premuto costerebbe più della digitazione.
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= totale; i++) {
    const el = document.createElement('span');
    el.className = `gutter-line${i === rigaErrore ? ' gutter-line-error' : ''}`;
    el.textContent = String(i);
    frag.appendChild(el);
  }
  gutter.replaceChildren(frag);
  sincronizzaScroll();
}

function sincronizzaScroll() {
  const editor = $('#query-editor-input');
  nascondiSuggerimentoErrore();
  const gutter = $('#query-editor-gutter');
  if (editor && gutter) gutter.scrollTop = editor.scrollTop;
  const evidenziatore = $('#query-editor-highlight');
  if (editor && evidenziatore) {
    evidenziatore.scrollTop = editor.scrollTop;
    evidenziatore.scrollLeft = editor.scrollLeft;
  }
}

/* --------------------------------------------------------------------------
 * Riga in errore
 * ------------------------------------------------------------------------ */

/**
 * Evidenzia la riga indicata (1-based) e la porta in vista. `0`/null cancella
 * l'evidenziazione.
 */
export function segnalaRigaErrore(riga) {
  rigaErrore = Number(riga) > 0 ? Number(riga) : 0;
  const gutter = $('#query-editor-gutter');
  if (!gutter) return;

  [...gutter.children].forEach((el, i) => {
    el.classList.toggle('gutter-line-error', i + 1 === rigaErrore);
  });

  if (!rigaErrore) return;
  const editor = $('#query-editor-input');
  const target = gutter.children[rigaErrore - 1];
  if (editor && target) {
    // Porta la riga in vista senza rubare il fuoco: l'utente potrebbe stare
    // scrivendo altrove.
    const y = target.offsetTop - editor.clientHeight / 2;
    editor.scrollTop = Math.max(0, y);
    sincronizzaScroll();
  }
}

/** Estrae il numero di riga da un messaggio d'errore ("… (riga 12)"). */
export function rigaDaMessaggio(messaggio) {
  const m = /riga (\d+)/i.exec(String(messaggio || ''));
  return m ? parseInt(m[1], 10) : 0;
}

/** Segnala un intervallo UTF-16, con fine esclusiva, relativo al testo visibile. */
export function segnalaErroreQuery(range, messaggio = '', testoAtteso) {
  const editor = $('#query-editor-input');
  if (!editor) return;
  const testo = testoAtteso ?? editor.value;
  erroreQuery = range && testo === editor.value
    && Number.isInteger(range.start) && Number.isInteger(range.end)
    && range.start >= 0 && range.end >= range.start && range.end <= testo.length
    ? { start: range.start, end: range.end, testo, messaggio: String(messaggio || 'Errore nella query') }
    : null;
  aggiornaSegnalazioneErrore();
  segnalaRigaErrore(erroreQuery ? testo.slice(0, erroreQuery.start).split('\n').length : 0);
  if (!erroreQuery) return;

  // Anche un identificatore fuori dal margine destro deve restare raggiungibile.
  const target = $('#query-editor-code .query-error-mark');
  const rect = target?.getClientRects()[0];
  if (rect) {
    const campo = editor.getBoundingClientRect();
    const inizio = campo.left + parseFloat(getComputedStyle(editor).paddingLeft);
    if (rect.left < inizio) editor.scrollLeft += rect.left - inizio;
    else if (rect.right > campo.right - 16) editor.scrollLeft += rect.right - campo.right + 16;
    sincronizzaScroll();
  }
}

/** Riapplica il segno dopo il rendering dei token, senza alterarne testo e colori. */
export function aggiornaSegnalazioneErrore() {
  const editor = $('#query-editor-input');
  const code = $('#query-editor-code');
  if (!editor || !code) return;
  nascondiSuggerimentoErrore();
  code.querySelectorAll('.query-error-mark').forEach(el => el.replaceWith(...el.childNodes));
  if (erroreQuery && erroreQuery.testo !== editor.value) {
    erroreQuery = null;
    segnalaRigaErrore(0);
  }
  let descrizione = $('#query-editor-error-message');
  if (!erroreQuery) {
    editor.removeAttribute('aria-invalid');
    editor.removeAttribute('aria-errormessage');
    descrizione?.remove();
    return;
  }
  if (!descrizione) {
    descrizione = document.createElement('span');
    descrizione.id = 'query-editor-error-message';
    descrizione.className = 'visually-hidden';
    editor.parentElement.append(descrizione);
  }
  descrizione.textContent = erroreQuery.messaggio;
  editor.setAttribute('aria-invalid', 'true');
  editor.setAttribute('aria-errormessage', descrizione.id);

  // Il range può attraversare più token dell'evidenziatore (nomi quotati, stringhe).
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  const parti = [];
  let offset = 0;
  if (erroreQuery.start === erroreQuery.end) {
    const segno = document.createElement('span');
    segno.className = 'query-error-mark query-error-caret';
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (offset + node.length >= erroreQuery.start) {
        const range = document.createRange();
        range.setStart(node, erroreQuery.start - offset);
        range.collapse(true);
        range.insertNode(segno);
        return;
      }
      offset += node.length;
    }
    code.append(segno);
    return;
  }
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const start = Math.max(0, erroreQuery.start - offset);
    const end = Math.min(node.length, erroreQuery.end - offset);
    if (end > start) parti.push({ node, start, end });
    offset += node.length;
    if (offset >= erroreQuery.end) break;
  }
  for (const { node, start, end } of parti) {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const segno = document.createElement('span');
    segno.className = 'query-error-mark';
    range.surroundContents(segno);
  }
}

/* --------------------------------------------------------------------------
 * Selezione
 * ------------------------------------------------------------------------ */

/** Testo attualmente selezionato nell'editor (stringa vuota se non c'è). */
export function selezioneEditor() {
  const editor = $('#query-editor-input');
  if (!editor) return '';
  const { selectionStart: a, selectionEnd: b } = editor;
  return a != null && b != null && b > a ? editor.value.slice(a, b).trim() : '';
}

/* --------------------------------------------------------------------------
 * Indentazione con Tab
 * ------------------------------------------------------------------------ */

function gestisciTab(e, editor) {
  const inizio = editor.selectionStart;
  const fine = editor.selectionEnd;
  const testo = editor.value;

  // Selezione su più righe: si indenta (o si toglie il rientro a) tutto il blocco.
  if (fine > inizio && testo.slice(inizio, fine).includes('\n')) {
    const inizioRiga = testo.lastIndexOf('\n', inizio - 1) + 1;
    const blocco = testo.slice(inizioRiga, fine);
    const righe = blocco.split('\n');
    const nuove = righe.map((r) => (e.shiftKey
      ? r.replace(new RegExp(`^(${INDENT}| {1,2}|\t)`), '')
      : INDENT + r));
    const sostituito = nuove.join('\n');
    editor.value = testo.slice(0, inizioRiga) + sostituito + testo.slice(fine);
    editor.selectionStart = inizioRiga;
    editor.selectionEnd = inizioRiga + sostituito.length;
    return;
  }

  if (e.shiftKey) {
    const inizioRiga = testo.lastIndexOf('\n', inizio - 1) + 1;
    const prefisso = testo.slice(inizioRiga, inizio);
    const tolto = prefisso.replace(new RegExp(`(${INDENT}|\t| {1,2})$`), '');
    if (tolto === prefisso) return;
    editor.value = testo.slice(0, inizioRiga) + tolto + testo.slice(inizio);
    const delta = prefisso.length - tolto.length;
    editor.selectionStart = editor.selectionEnd = inizio - delta;
    return;
  }

  editor.value = testo.slice(0, inizio) + INDENT + testo.slice(fine);
  editor.selectionStart = editor.selectionEnd = inizio + INDENT.length;
}

/* --------------------------------------------------------------------------
 * Inizializzazione
 * ------------------------------------------------------------------------ */

/**
 * @param {object} deps
 * @param {() => void} deps.onCambio  ridisegno dell'evidenziazione (query-tab)
 */
export function initQueryEditor({ onCambio } = {}) {
  const editor = $('#query-editor-input');
  if (!editor) return;

  const notifica = () => {
    aggiornaNumeriRiga();
    if (typeof onCambio === 'function') onCambio();
  };

  // La numerazione è già aggiornata da `updateEditorHighlight` (che gira a ogni
  // `input`): qui serve solo invalidare la segnalazione d'errore, perché una
  // volta modificato il testo quella riga non vuol più dire nulla.
  editor.addEventListener('input', () => {
    if (erroreQuery || rigaErrore) segnalaErroreQuery(null);
  });
  editor.addEventListener('scroll', sincronizzaScroll);
  editor.addEventListener('pointermove', suggerimentoErrore);
  editor.addEventListener('pointerleave', rinviaChiusuraTooltip);
  window.addEventListener('resize', nascondiSuggerimentoErrore);
  window.addEventListener('blur', nascondiSuggerimentoErrore);
  window.visualViewport?.addEventListener('resize', nascondiSuggerimentoErrore);
  window.visualViewport?.addEventListener('scroll', nascondiSuggerimentoErrore);
  document.addEventListener('scroll', event => {
    if (!tooltipErrore?.contains(event.target)) nascondiSuggerimentoErrore();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') nascondiSuggerimentoErrore();
  });

  editor.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    gestisciTab(e, editor);
    if (erroreQuery || rigaErrore) segnalaErroreQuery(null);
    notifica();
  });

  aggiornaNumeriRiga();
}
