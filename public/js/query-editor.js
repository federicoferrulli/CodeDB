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
  const gutter = $('#query-editor-gutter');
  if (editor && gutter) gutter.scrollTop = editor.scrollTop;
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
    if (rigaErrore) segnalaRigaErrore(0);
  });
  editor.addEventListener('scroll', sincronizzaScroll);

  editor.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    gestisciTab(e, editor);
    notifica();
  });

  aggiornaNumeriRiga();
}
