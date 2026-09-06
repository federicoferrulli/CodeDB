'use strict';

/* ---------------------------------------------------------------------------
 * Pannello "Cronologia query" della tab ⚡ Query & Aggregate.
 *
 * La logica (dedup, tetti, filtri) sta nel modulo puro `query-history-store.js`;
 * qui restano DOM ed eventi. È il gemello, per la tab ⚡, del pannello che
 * `queryhistory.js` disegna per la vista Dati — con due differenze volute:
 * l'elenco è unico per tutta l'applicazione (una query con JOIN o `USE <db>`
 * non appartiene a una collection) e si può cercare dentro il testo del codice.
 * ------------------------------------------------------------------------- */

import { activeTab } from './tabs.js';
import { $, cut, esc, toast } from './utils.js';
import {
  leggiVoci, registra, aggiornaEsito, filtra, connessioniPresenti, svuota,
} from './query-history-store.js';
import { runQuery, updateEditorHighlight } from './query-tab.js';

const storage = () => window.localStorage;

// Filtri del pannello: stato effimero, azzerato a ogni apertura.
let filtroTesto = '';
let filtroConn = '';

/**
 * Nome della connessione del tab attivo. Stessa convenzione di `historyKey` in
 * `queryhistory.js`: il nome vive sul TAB (`tabs.js`), non nello stato — dove
 * `connName` non esiste affatto (vedi `freshState`, che ha `connLabel`).
 */
export function connCorrente() {
  const t = activeTab();
  return (t && (t.connName || t.label)) || 'anonima';
}

/* --------------------------- registrazione ------------------------------- */

export function registraEsecuzione(meta) {
  try {
    return registra(storage(), meta);
  } catch {
    return null; // la cronologia non deve mai far fallire un'esecuzione
  }
}

export function aggiornaEsecuzione(id, esito) {
  try {
    aggiornaEsito(storage(), id, esito);
  } catch { /* best-effort */ }
}

/* ------------------------------- pannello -------------------------------- */

function fmtTs(ts) {
  const d = new Date(ts);
  const oggi = new Date();
  const stessoGiorno = d.toDateString() === oggi.toDateString();
  const ora = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return stessoGiorno ? ora : `${d.toLocaleDateString('it-IT')} ${ora}`;
}

function hidePanel() {
  const p = $('#qe-history-panel');
  if (p) p.classList.add('hidden');
}

/**
 * Carica il codice di una voce nell'editor. NON cambia il bersaglio: caricare
 * del codice non deve poter spostare in silenzio il database su cui girerà —
 * se la voce viene da un'altra connessione lo si dice e basta.
 */
function ripristina(voce, esegui) {
  const editor = $('#query-editor-input');
  if (!editor) return;
  editor.value = voce.code;
  updateEditorHighlight();
  hidePanel();
  editor.focus();

  const altrove = voce.conn && voce.conn !== connCorrente();
  if (esegui) {
    if (altrove) toast(`Eseguo sulla connessione corrente (la query veniva da "${voce.conn}")`);
    runQuery();
    return;
  }
  toast(altrove
    ? `Query ripristinata (veniva da "${voce.conn}"): premi ▶ Esegui per lanciarla qui`
    : 'Query ripristinata: premi ▶ Esegui per lanciarla');
}

function badgeEsito(voce) {
  if (voce.script) return { testo: 'script', cls: 'qe-history-esito-script' };
  if (voce.esito === 'ok') {
    const parti = [];
    if (voce.ms !== null && voce.ms !== undefined) parti.push(`${voce.ms} ms`);
    if (voce.righe !== null && voce.righe !== undefined) parti.push(`${voce.righe} righe`);
    return { testo: `✓ ${parti.join(' · ')}`.trim(), cls: 'qe-history-esito-ok' };
  }
  if (voce.esito === 'errore') {
    return { testo: voce.ms !== null && voce.ms !== undefined ? `✖ ${voce.ms} ms` : '✖', cls: 'qe-history-esito-err' };
  }
  return { testo: '—', cls: 'qe-history-esito-ignoto' };
}

function renderLista() {
  const lista = $('#qe-history-list');
  if (!lista) return;
  lista.innerHTML = '';

  const tutte = leggiVoci(storage());
  const voci = filtra(tutte, { testo: filtroTesto, conn: filtroConn });

  if (!voci.length) {
    const vuoto = document.createElement('div');
    vuoto.className = 'query-history-empty';
    vuoto.textContent = tutte.length
      ? 'Nessuna query corrisponde ai filtri.'
      : 'Nessuna query eseguita finora in questa tab.';
    lista.appendChild(vuoto);
    return;
  }

  for (const voce of voci) {
    const item = document.createElement('div');
    item.className = 'query-history-item';
    item.title = 'Clicca per ripristinare il codice nell\'editor (Ctrl+clic per eseguirlo subito)';

    const top = document.createElement('div');
    top.className = 'query-history-item-top';

    const modo = document.createElement('span');
    modo.className = 'query-history-mode';
    modo.textContent = voce.engine && voce.engine !== 'auto' ? voce.engine : (voce.dbType || 'auto');
    top.appendChild(modo);

    const bersaglio = document.createElement('span');
    bersaglio.className = 'qe-history-target';
    const pezzi = [voce.conn, voce.db, voce.coll].filter(Boolean);
    bersaglio.textContent = pezzi.length ? pezzi.join(' ▸ ') : '—';
    bersaglio.title = bersaglio.textContent;
    top.appendChild(bersaglio);

    const ts = document.createElement('span');
    ts.className = 'query-history-ts';
    ts.textContent = fmtTs(voce.ts);
    top.appendChild(ts);
    item.appendChild(top);

    const testo = document.createElement('div');
    testo.className = 'query-history-text';
    testo.textContent = cut(voce.code.trim().replace(/\s*\n\s*/g, ' ⏎ '), 160);
    item.appendChild(testo);

    const basso = document.createElement('div');
    basso.className = 'qe-history-bottom';
    const esito = badgeEsito(voce);
    const spanEsito = document.createElement('span');
    spanEsito.className = `qe-history-esito ${esito.cls}`;
    spanEsito.textContent = esito.testo;
    basso.appendChild(spanEsito);

    const play = document.createElement('button');
    play.className = 'qe-history-run';
    play.type = 'button';
    play.textContent = '▶';
    play.title = 'Carica ed esegui subito';
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      ripristina(voce, true);
    });
    basso.appendChild(play);
    item.appendChild(basso);

    item.addEventListener('click', (e) => ripristina(voce, e.ctrlKey || e.metaKey));
    lista.appendChild(item);
  }
}

function renderPanel() {
  const panel = $('#qe-history-panel');
  if (!panel) return;
  const voci = leggiVoci(storage());
  const conns = connessioniPresenti(voci);
  const corrente = connCorrente();
  // La connessione corrente va in cima: è quasi sempre quella che si cerca.
  const ordinate = conns.includes(corrente)
    ? [corrente, ...conns.filter((c) => c !== corrente)]
    : conns;

  panel.innerHTML = `
    <div class="query-history-header">
      <span>Cronologia query ⚡</span>
      <button type="button" id="qe-history-clear">Svuota</button>
    </div>
    <div class="qe-history-filtri">
      <input type="search" id="qe-history-search" placeholder="Cerca nel codice, database, tabella…" autocomplete="off">
      <select id="qe-history-conn" title="Filtra per connessione">
        <option value="">Tutte le connessioni</option>
        ${ordinate.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
      </select>
    </div>
    <div id="qe-history-list" class="qe-history-list"></div>`;

  const search = $('#qe-history-search');
  if (search) {
    search.value = filtroTesto;
    // Si ridisegna la SOLA lista: riscrivere il pannello intero a ogni tasto
    // premuto toglierebbe il fuoco dal campo di ricerca.
    search.addEventListener('input', () => {
      filtroTesto = search.value;
      renderLista();
    });
  }
  const selConn = $('#qe-history-conn');
  if (selConn) {
    selConn.value = filtroConn;
    selConn.addEventListener('change', () => {
      filtroConn = selConn.value;
      renderLista();
    });
  }
  const clear = $('#qe-history-clear');
  if (clear) {
    clear.addEventListener('click', () => {
      svuota(storage());
      renderLista();
    });
  }

  renderLista();
  if (search) search.focus();
}

export function initQeHistory() {
  const btn = $('#qe-history-btn');
  const panel = $('#qe-history-panel');
  if (!btn || !panel) return;

  btn.addEventListener('click', (e) => {
    // Serve a non far chiudere subito il pannello dal gestore su `document`
    // qui sotto — ma impedisce anche al menu ⋯ che ospita questa voce di
    // accorgersi del clic, quindi lo si chiude a mano.
    e.stopPropagation();
    const menu = $('#query-editor-more-menu');
    if (menu) menu.classList.add('hidden');
    const trigger = $('#query-editor-more-btn');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (panel.classList.contains('hidden')) {
      // I filtri sono stato effimero del pannello: chi lo riapre si aspetta
      // l'elenco completo, non i residui della ricerca di ieri.
      filtroTesto = '';
      filtroConn = '';
      renderPanel();
      panel.classList.remove('hidden');
    } else {
      hidePanel();
    }
  });

  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !panel.contains(e.target)) hidePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePanel();
  });
}
