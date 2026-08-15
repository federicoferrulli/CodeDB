/**
 * CodeDB — Linting JSON/BSON in linea, formatta e minifica
 *
 * Lo strato di DOM sopra `json-bson.js`. Serve nei tre posti in cui si scrive
 * un documento a mano — l'editor ⚡ Query & Aggregate, la modale di
 * inserimento e quella di modifica — e in tutti e tre il problema era lo
 * stesso: l'errore di sintassi si scopriva solo premendo "Salva", e il
 * messaggio del driver ("Unexpected token }") non diceva dove guardare.
 *
 * Qui l'errore compare **mentre si scrive**, con riga e colonna, e cliccandolo
 * il cursore ci va sopra.
 *
 * Il controllo è ritardato di un attimo (`ATTESA_MS`): un documento è
 * incompleto per quasi tutta la durata della digitazione, e segnalarlo a ogni
 * tasto premuto vorrebbe dire tenere una scritta rossa fissa sotto gli occhi
 * di chi sta semplicemente scrivendo.
 */

import {
  analizzaJsonBson, sembraJsonBson, formattaJsonBson, minificaJsonBson,
} from './json-bson.js';

const ATTESA_MS = 350;

/**
 * Scrive l'esito nella barra di stato.
 *
 * @param {HTMLTextAreaElement} campo
 * @param {HTMLElement} barra
 * @param {object} [opts]
 * @param {boolean} [opts.soloSeJson]  tace se il testo non è un documento
 * @param {(riga: number) => void} [opts.onRiga]  evidenziazione esterna (gutter)
 * @returns {{ok: boolean} | null} l'esito, o null se non si è controllato nulla
 */
export function aggiornaLint(campo, barra, opts = {}) {
  if (!campo || !barra) return null;
  const testo = campo.value;

  const daControllare = opts.soloSeJson ? sembraJsonBson(testo) : testo.trim() !== '';
  if (!daControllare) {
    barra.classList.add('hidden');
    barra.textContent = '';
    if (typeof opts.onRiga === 'function') opts.onRiga(0);
    return null;
  }

  const esito = analizzaJsonBson(testo);
  barra.classList.remove('hidden');
  barra.classList.toggle('lint-ko', !esito.ok);
  barra.classList.toggle('lint-ok', esito.ok);

  if (esito.ok) {
    barra.textContent = '✓ Documento valido';
    barra.removeAttribute('title');
    barra.removeAttribute('role');
    if (typeof opts.onRiga === 'function') opts.onRiga(0);
    return esito;
  }

  barra.textContent = `✕ Riga ${esito.riga}, colonna ${esito.colonna}: ${esito.messaggio}`;
  barra.title = 'Clicca per andare al punto';
  barra.setAttribute('role', 'button');
  barra.onclick = () => {
    campo.focus();
    campo.setSelectionRange(esito.indice, esito.indice);
    portaInVista(campo, esito.riga);
  };
  if (typeof opts.onRiga === 'function') opts.onRiga(esito.riga);
  return esito;
}

/* Porta la riga indicata al centro dell'area di testo: mettere il cursore
   dove non si vede non serve a niente. */
function portaInVista(campo, riga) {
  const stile = window.getComputedStyle(campo);
  const alto = parseFloat(stile.lineHeight) || parseFloat(stile.fontSize) * 1.2 || 16;
  campo.scrollTop = Math.max(0, (riga - 1) * alto - campo.clientHeight / 2);
}

/** Controllo continuo (con ritardo) su un'area di testo. */
export function agganciaLint(campo, barra, opts = {}) {
  if (!campo || !barra) return () => {};
  let attesa = 0;
  const controlla = () => {
    clearTimeout(attesa);
    attesa = setTimeout(() => aggiornaLint(campo, barra, opts), ATTESA_MS);
  };
  campo.addEventListener('input', controlla);
  campo.addEventListener('blur', () => {
    clearTimeout(attesa);
    aggiornaLint(campo, barra, opts);
  });
  return controlla;
}

/**
 * Formatta il contenuto di un'area di testo. Se non è analizzabile **non lo
 * tocca** e mostra il perché: una formattazione che corrompe il documento
 * sarebbe molto peggio di una formattazione mancata.
 * @returns {boolean} true se il testo è stato riscritto
 */
export function formattaCampo(campo, barra, opts = {}) {
  return trasforma(campo, barra, formattaJsonBson, opts);
}

/** Lo stesso documento su una riga sola. */
export function minificaCampo(campo, barra, opts = {}) {
  return trasforma(campo, barra, minificaJsonBson, opts);
}

/**
 * Collega i due pulsanti (e le scorciatoie Ctrl+Shift+F / Ctrl+Shift+M) a
 * un'area di testo che contiene un documento. Le scorciatoie sono le stesse
 * dell'editor ⚡: una sola combinazione da ricordare in tutta l'applicazione.
 *
 * @param {HTMLTextAreaElement} campo
 * @param {HTMLElement} barra            barra di stato del linting
 * @param {string|HTMLElement} formatta  pulsante "Formatta"
 * @param {string|HTMLElement} minifica  pulsante "Minifica"
 */
export function collegaStrumentiJson(campo, barra, formatta, minifica, opts = {}) {
  if (!campo) return;
  const el = (x) => (typeof x === 'string' ? document.querySelector(x) : x);
  const btnF = el(formatta);
  const btnM = el(minifica);

  if (btnF) btnF.addEventListener('click', () => formattaCampo(campo, barra, opts));
  if (btnM) btnM.addEventListener('click', () => minificaCampo(campo, barra, opts));

  campo.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if (e.key === 'F' || e.key === 'f') {
      e.preventDefault();
      formattaCampo(campo, barra, opts);
    } else if (e.key === 'M' || e.key === 'm') {
      e.preventDefault();
      minificaCampo(campo, barra, opts);
    }
  });
}

function trasforma(campo, barra, fn, opts) {
  if (!campo) return false;
  const prima = campo.value;
  if (!prima.trim()) return false;
  try {
    const dopo = fn(prima);
    if (dopo === prima) {
      if (barra) aggiornaLint(campo, barra, opts);
      return false;
    }
    campo.value = dopo;
    // Il cursore andrebbe altrimenti a fine testo, con l'area scrollata in
    // fondo: chi ha appena formattato vuole vedere l'inizio del documento.
    campo.setSelectionRange(0, 0);
    campo.scrollTop = 0;
    if (barra) aggiornaLint(campo, barra, opts);
    if (typeof opts.onCambio === 'function') opts.onCambio();
    return true;
  } catch (_err) {
    if (barra) aggiornaLint(campo, barra, opts);
    return false;
  }
}
