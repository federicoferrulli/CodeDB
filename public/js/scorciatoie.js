'use strict';

/* ---------------------------------------------------------------------------
 * Scorciatoie da tastiera â€” modulo FOGLIA e puro.
 *
 * Il catalogo delle azioni, la normalizzazione delle combinazioni e la
 * corrispondenza con un evento tastiera stanno qui, senza DOM nÃ© socket, cosÃ¬
 * sono provabili in Node (`test/unit-scorciatoie.js`). La mappa ATTIVA vive
 * anch'essa qui (seminata con i predefiniti, aggiornata da `scorciatoie-ui.js`
 * quando le preferenze personali arrivano): i consumatori come `json-lint.js`
 * devono leggere la combinazione in modo SINCRONO dentro il keydown, e non
 * possono aspettare il socket.
 *
 * Persistenza: con RBAC attivo le preferenze stanno sul server, nella
 * collezione `prefs` del control plane, chiave
 * `{ownerId, subjectId, ambito, chiave}`: utenti dello stesso tenant non si
 * sovrascrivono, mentre lo stesso account ritrova le combinazioni su altri browser.
 * Senza RBAC non esiste un tenant (l'istanza Ã¨ locale) e il ripiego dichiarato
 * Ã¨ il `localStorage` del browser (`codedb:scorciatoie`).
 * ------------------------------------------------------------------------- */

/** Chiave delle preferenze lato server e nel localStorage di ripiego. */
export const CHIAVE_PREFS = 'scorciatoie';
export const CHIAVE_LOCALE = 'codedb:scorciatoie';

/**
 * Il catalogo: le azioni che l'utente puÃ² rimappare. Aggiungere una voce qui
 * NON la attiva: serve un consumatore che chiami `azioneDi(evento)` e reagisca
 * all'id â€” altrimenti Ã¨ una scorciatoia che non fa nulla.
 */
export const CATALOGO = [
  {
    id: 'formattaJson',
    etichetta: 'Formatta il documento JSON',
    descrizione: 'Nell\'editor âš¡ e nelle modali di inserimento/modifica: riscrive il documento indentato (Ctrl+Shift+F di default).',
    predefinito: 'Ctrl+Shift+F',
  },
  {
    id: 'sidebarConnessioni',
    etichetta: 'Mostra/nascondi la barra connessioni',
    descrizione: 'Apre o chiude la barra di sinistra con le connessioni salvate (Ctrl+B di default).',
    predefinito: 'Ctrl+B',
  },
  {
    id: 'chiudiScheda',
    etichetta: 'Chiudi la scheda aperta',
    descrizione: 'Chiude la tabella/collection aperta; se non ce ne sono, chiude il tab di connessione (Ctrl+W di default). Nota: nel browser Ctrl+W è riservato alla scheda del browser e non è intercettabile — funziona nell\'app desktop.',
    predefinito: 'Ctrl+W',
  },
  {
    id: 'paletteComandi',
    etichetta: 'Ricerca e comandi veloci',
    descrizione: 'Apre la palette: cerca connessioni, database, tabelle ed esegui comandi da tastiera (Ctrl+P di default).',
    predefinito: 'Ctrl+P',
  },
  {
    id: 'minificaJson',
    etichetta: 'Minifica il documento JSON',
    descrizione: 'Lo stesso documento su una riga sola (Ctrl+Shift+M di default).',
    predefinito: 'Ctrl+Shift+M',
  },
];

const MODIFICATORI = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'meta' };

/** Il tasto principale, normalizzato: lettere minuscole, cifre, nomi noti. */
function normalizzaTasto(tasto) {
  const t = String(tasto || '').trim().toLowerCase();
  if (!t) return null;
  if (MODIFICATORI[t]) return null; // un modificatore da solo non Ã¨ una scorciatoia
  const noti = {
    escape: 'escape', esc: 'escape', enter: 'enter', tab: 'tab',
    space: ' ', ' ': ' ', spacebar: ' ',
    arrowup: 'arrowup', arrowdown: 'arrowdown', arrowleft: 'arrowleft', arrowright: 'arrowright',
    delete: 'delete', backspace: 'backspace', home: 'home', end: 'end',
    pageup: 'pageup', pagedown: 'pagedown',
  };
  if (noti[t] !== undefined) return noti[t];
  if (/^[a-z]$/.test(t)) return t;
  if (/^[0-9]$/.test(t)) return t;
  if (/^f([1-9]|1[0-2])$/.test(t)) return t; // F1..F12
  return null;
}

/**
 * Normalizza il testo di una combinazione ("Ctrl+Shift+F", "Meta+Enter").
 * @returns {object|null} {ctrl, alt, shift, meta, tasto} oppure null se il
 *   testo non descrive una combinazione sensata.
 */
export function normalizzaCombo(testo) {
  if (typeof testo !== 'string') return null;
  const parti = testo.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parti.length) return null;
  const combo = { ctrl: false, alt: false, shift: false, meta: false, tasto: null };
  for (const p of parti) {
    if (p === 'ctrl' || p === 'control' || p === 'cmdorctrl') combo.ctrl = true;
    else if (p === 'alt' || p === 'option') combo.alt = true;
    else if (p === 'shift') combo.shift = true;
    else if (p === 'meta' || p === 'cmd' || p === 'command') combo.meta = true;
    else {
      if (combo.tasto !== null) return null; // due tasti principali: non Ã¨ una combinazione
      combo.tasto = normalizzaTasto(p);
      if (combo.tasto === null) return null;
    }
  }
  if (combo.tasto === null) return null; // soli modificatori: intercetterebbero tutto
  return combo;
}

/** La combinazione di un evento tastiera, nella stessa forma normalizzata. */
export function comboDaEvento(e) {
  if (!e || typeof e.key !== 'string') return null;
  const k = e.key.toLowerCase();
  const tasto = k === 'control' || k === 'shift' || k === 'alt' || k === 'meta'
    ? null
    : normalizzaTasto(k);
  if (tasto === null) return null;
  return { ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey, tasto };
}

/** Due combinazioni normalizzate descrivono la stessa sequenza di tasti. */
/** Due combinazioni normalizzate descrivono la stessa sequenza di tasti.
 *  I modificatori sono forzati a booleano: una combinazione scritta a mano
 *  può ometterli, e un campo assente non è un tasto diverso premuto. */
export function stessaCombo(a, b) {
  if (!a || !b) return false;
  return !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift
    && !!a.meta === !!b.meta && a.tasto === b.tasto;
}

/** Il testo canonico di una combinazione, per l'interfaccia. */
export function etichettaCombo(combo) {
  if (!combo || !combo.tasto) return '';
  const parti = [];
  if (combo.ctrl) parti.push('Ctrl');
  if (combo.alt) parti.push('Alt');
  if (combo.shift) parti.push('Shift');
  if (combo.meta) parti.push('Meta');
  const t = combo.tasto;
  parti.push(t === ' ' ? 'Spazio' : t.length === 1 ? t.toUpperCase() : t);
  return parti.join('+');
}

/**
 * L'azione da eseguire per un evento tastiera, data la mappa {id: combo}.
 * La mappa accetta sia la forma normalizzata sia il testo grezzo ("Ctrl+K"):
 * chi salva da un pannello di registrazione scrive testo, chi legge non deve
 * conoscere la differenza.
 */
export function azioneDi(evento, mappa) {
  const combo = comboDaEvento(evento);
  if (!combo || !mappa) return null;
  for (const [id, valore] of Object.entries(mappa)) {
    const c = (valore && valore.tasto) ? valore : normalizzaCombo(valore);
    if (c && stessaCombo(combo, c)) return id;
  }
  return null;
}

/**
 * La mappa effettiva: predefiniti del catalogo + personalizzazioni valide.
 * Le voci sconosciute o rotte sono SCARTATE, non corrette: una preferenza
 * scritta a mano nel DB non deve poter spegnere una scorciatoia in silenzio.
 * @returns {{mappa: Object<string,object>, errori: string[]}}
 */
export function mappaEffettiva(personalizzazioni) {
  const mappa = {};
  for (const a of CATALOGO) {
    const c = normalizzaCombo(a.predefinito);
    if (c) mappa[a.id] = c;
  }
  const errori = [];
  if (!personalizzazioni || typeof personalizzazioni !== 'object') return { mappa, errori };
  for (const [id, valore] of Object.entries(personalizzazioni)) {
    const nota = CATALOGO.find((a) => a.id === id);
    if (!nota) { errori.push(`Azione sconosciuta: ${id}`); continue; }
    const c = normalizzaCombo(valore);
    if (!c) { errori.push(`Combinazione non valida per ${nota.etichetta}: ${valore}`); continue; }
    mappa[id] = c;
  }
  // Conflitti: due azioni sulla stessa combinazione - l'ultima vince, ma lo si
  // dichiara invece di lasciare un tasto che "a volte non funziona".
  const viste = new Map();
  for (const a of CATALOGO) {
    const c = mappa[a.id];
    if (!c) continue;
    const chiave = etichettaCombo(c);
    if (viste.has(chiave)) {
      errori.push(`Conflitto: ${viste.get(chiave)} e ${a.etichetta} usano entrambe ${chiave}`);
    } else {
      viste.set(chiave, a.etichetta);
    }
  }
  return { mappa, errori };
}

/* ------------------------- La mappa ATTIVA (cache) ------------------------ */

let attiva = mappaEffettiva(null).mappa;

/** La mappa in uso ORA: lettura sincrona per i keydown dei consumatori. */
export function mappaAttiva() { return attiva; }

/** L'id dell'azione per un evento, secondo la mappa in uso. */
export function azioneDiEvento(evento) { return azioneDi(evento, attiva); }

/** Sostituisce la mappa in uso (gia normalizzata, es. da mappaEffettiva). */
export function impostaMappaAttiva(mappa) {
  if (mappa && typeof mappa === 'object') attiva = mappa;
  return attiva;
}
