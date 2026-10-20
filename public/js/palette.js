import { mountArcControls, removeDialog } from '../arc/ui.js';
'use strict';

/* ---------------------------------------------------------------------------
 * Palette di ricerca e comandi veloci (Ctrl+P) + dispatcher delle scorciatoie
 * GLOBALI (pannello sinistro, chiusura e navigazione schede, palette).
 *
 * Le combinazioni vengono dal catalogo (`scorciatoie.js`), quindi sono
 * rimappabili da Impostazioni e salvate sotto al tenant. Il dispatcher esegue
 * SOLO le azioni globali dichiarate qui sotto: le altre (formatta, minifica…)
 * hanno consumatori propri che leggono la stessa mappa, e un secondo esecutore
 * globale le farebbe scattare due volte.
 *
 * Limite noto e dichiarato: Ctrl+W nel BROWSER non è intercettabile (Chrome e
 * Firefox lo riservano alla scheda) — funziona nell'app desktop Electron.
 * ------------------------------------------------------------------------- */

import { activeTab, tabs, closeTab, switchTab } from './tabs.js';
import { renderTabBar } from './tabbar.js';
import { renderWorkspace, saveWorkspaceInputs } from './workspace.js';
import { closeCollTab, openCollTab, switchCollTab } from './colltabs.js';
import { elencoConnessioni } from './connmanager.js';
import { toggleDrawer } from './responsive.js';
import { openConnModal } from './connection.js';
import { $, emit, toast, refreshLucideIcons, lucideIconHtml } from './utils.js';
import { connectAndOpenTab } from './connection.js';
import { azioneDiEvento, etichettaCombo, mappaAttiva } from './scorciatoie.js';
import { filtra, interpreta, RICHIAMI } from './palette-ricerca.js';
import { finestraVirtuale, scorrimentoPerRiga } from './griglia.js';
import { preparaTransizioneTab, fermaTransizioniTab } from './tab-motion.js';
import { preparaTransizioneAlbero, fermaTransizioniAlbero } from './navigator-motion.js';

/** Le azioni che QUESTO modulo esegue globalmente. */
const GLOBALI = new Set(['sidebarConnessioni', 'chiudiScheda', 'paletteComandi', 'tabellaSuccessiva', 'databaseSuccessivo']);

/* Le tabelle di TUTTI i database del tab, non dei primi dodici: una palette che
 * cerca in mezzo elenco è peggio di una che dichiara di non cercare. Ciò che
 * resta limitato è il PARALLELISMO — sei richieste in volo insieme, chiedendo
 * solo i nomi: la ricerca non deve avviare conteggi sulle tabelle. */
const PARALLELE = 6;

// Schede e richiami testuali condividono il catalogo della ricerca.
const ETICHETTA_RICHIAMO = { '>': 'comandi', '#': 'database', '@': 'tabelle' };
const ICONE_TIPO = { Comando: 'command', Connessione: 'plug', Database: 'database', Tabella: 'table-2' };

/* Altezza desktop in px: combacia con `.palette-voce` in workbench.css.
 * È il valore di partenza della finestra virtuale, che poi si MISURA sul primo
 * disegno — un tema con un font più grande sposterebbe tutto di qualche pixel. */
const ALTEZZA_RIGA = 48;

/* ------------------------------ Azioni globali ---------------------------- */

function mostraBarraConnessioni() {
  toggleDrawer('#conn-sidebar');
}

function chiudiScheda() {
  const t = activeTab();
  if (!t) return;
  const collTabs = t.state.collTabs || [];
  const attiva = collTabs.find((c) => c.id === t.state.activeCollId);
  if (attiva) {
    closeCollTab(attiva.id); // chiude la tabella/collection aperta
    return;
  }
  closeTab(t.id); // nessuna scheda aperta: si chiude il tab di connessione
  renderTabBar();
  renderWorkspace();
}

function tabellaSuccessiva() {
  const t = activeTab();
  if (!t?.state.connected || t.state.collTabs.length < 2) return;
  const lista = t.state.collTabs;
  const indice = lista.findIndex(c => c.id === t.state.activeCollId);
  switchCollTab(lista[(indice + 1) % lista.length].id);
  $('#coll-tab-bar [aria-selected="true"]')?.focus();
}

function databaseSuccessivo() {
  const lista = tabs.list.filter(t => t.state.connected);
  if (lista.length < 2) return;
  const indice = lista.findIndex(t => t.id === tabs.activeId);
  saveWorkspaceInputs();
  switchTab(lista[(indice + 1) % lista.length].id);
  $('#tab-bar [aria-selected="true"]')?.focus();
}

/* --------------------------------- Palette -------------------------------- */

/** Le voci della palette: comandi fissi + connessioni + database + tabelle. */
function raccogliVoci() {
  const voci = [
    { tipo: 'Comando', etichetta: window.matchMedia('(max-width: 900px)').matches ? 'Apri/chiudi Connessioni' : 'Mostra/nascondi la navigazione', esegui: mostraBarraConnessioni },
    { tipo: 'Comando', etichetta: 'Nuova connessione', esegui: () => openConnModal() },
  ];
  for (const conn of elencoConnessioni()) {
    if (!conn || !conn.name) continue;
    voci.push({
      tipo: 'Connessione',
      etichetta: conn.name,
      nota: conn.dbType || '',
      esegui: () => {
        toast(`Connessione a "${conn.name}"…`);
        connectAndOpenTab({ saved: conn.name })
          .then(() => toast(`Connesso a "${conn.name}"`))
          .catch((err) => toast(err.message, true));
      },
    });
  }
  for (const db of dbsDelTab()) {
    voci.push({ tipo: 'Database', etichetta: db, esegui: () => espandiNelAlbero(db) });
    for (const nome of (palette && palette.tabelle.get(db)) || []) {
      voci.push({ tipo: 'Tabella', etichetta: nome, nota: db, esegui: () => openCollTab(db, nome) });
    }
  }
  return voci;
}

/** Un database scelto dalla palette: si evidenzia nell'albero (il click che
 *  carica le collection resta un gesto del mouse, qui si porta l'utente lì). */
function espandiNelAlbero(db) {
  // Il nodo del database, non la prima collection che porta lo stesso data-db.
  const nodo = document.querySelector(`#db-tree li.db > .node-label[data-db="${CSS.escape(db)}"]`);
  if (nodo) {
    nodo.scrollIntoView({ block: 'center' });
    nodo.click();
  }
}

/** Il nome di una collection/tabella comunque il motore la descriva. */
function nomeDiCollection(c) {
  if (typeof c === 'string') return c;
  return (c && (c.name || c.table_name)) || null;
}

/**
 * Le tabelle dei database del tab attivo.
 *
 * Due sorgenti, nell'ordine: l'albero, che per i database già espansi le tiene
 * in cache (niente attesa e niente rete per ciò che l'utente sta guardando), e
 * la rete per tutti gli altri. La risposta di rete SOSTITUISCE la cache, quindi
 * una tabella creata altrove compare senza dover riaprire la connessione.
 *
 * Le risposte si fondono nella lista man mano: la palette non aspetta il
 * database più lento, e `token` fa scartare quelle di un'apertura precedente —
 * senza, riaprire la palette due volte di fila mescolerebbe due elenchi.
 */
function caricaTabelle(dbs, token) {
  const t = activeTab();
  const cache = (t && t.state && Array.isArray(t.state.databases)) ? t.state.databases : [];
  for (const db of cache) {
    if (db && db.name && Array.isArray(db.collections)) {
      palette.tabelle.set(db.name, db.collections.map(nomeDiCollection).filter(Boolean));
    }
  }

  let i = 0;
  const vivo = () => palette && palette.token === token;
  const prossimo = () => {
    if (!vivo() || i >= dbs.length) return;
    const db = dbs[i++];
    emit('db:collections', { db, includeCounts: false })
      .then((res) => {
        if (!vivo()) return;
        const elenco = (res && Array.isArray(res.collections)) ? res.collections : [];
        palette.tabelle.set(db, elenco.map(nomeDiCollection).filter(Boolean));
      })
      .catch(() => { /* un db che non risponde non deve svuotare la palette */ })
      .then(() => {
        if (!vivo()) return;
        palette.letti++;
        palette.disegna();
        prossimo();
      });
  };
  for (let k = 0; k < Math.min(PARALLELE, dbs.length); k++) prossimo();
}

/* ------------------------------- Interfaccia ------------------------------ */

let palette = null;
let aperture = 0; // ogni apertura ha il suo numero: le risposte in ritardo lo portano

/** Una riga della lista, creata UNA volta e poi riusata. La lista è
 *  virtualizzata: in DOM stanno solo le righe della finestra visibile, e
 *  scorrere non ne crea di nuove — ne riscrive il testo. */
function creaRiga() {
  const li = document.createElement('li');
  li.className = 'palette-voce';
  li.setAttribute('role', 'option');
  const tipo = document.createElement('span');
  tipo.className = 'palette-tipo';
  const nome = document.createElement('span');
  nome.className = 'palette-nome';
  const nota = document.createElement('span');
  nota.className = 'palette-nota';
  const icona = document.createElement('span');
  icona.className = 'palette-icona';
  icona.setAttribute('aria-hidden', 'true');
  const testo = document.createElement('span');
  testo.className = 'palette-testo';
  const meta = document.createElement('span');
  meta.className = 'palette-meta';
  meta.append(tipo, nota);
  testo.append(nome, meta);
  const apri = document.createElement('span');
  apri.className = 'palette-invio';
  apri.setAttribute('aria-hidden', 'true');
  apri.innerHTML = lucideIconHtml('corner-down-left');
  li.append(icona, testo, apri);
  refreshLucideIcons(apri);
  li._parti = { tipo, nome, nota, icona };
  return li;
}

/** Testo e stato di una riga riusata. `textContent` e non `innerHTML`: i nomi
 *  di database e tabella sono dati non fidati (vedi la nota in dbtree.js). */
function aggiornaRiga(li, voce, indice) {
  const { tipo, nome, nota, icona } = li._parti;
  if (tipo.textContent !== voce.tipo) {
    tipo.textContent = voce.tipo;
    icona.innerHTML = lucideIconHtml(ICONE_TIPO[voce.tipo] || 'search');
    refreshLucideIcons(icona);
  }
  if (nome.textContent !== voce.etichetta) nome.textContent = voce.etichetta;
  const testoNota = voce.nota || '';
  if (nota.textContent !== testoNota) nota.textContent = testoNota;
  nota.hidden = !testoNota;
  li.dataset.i = String(indice);
  li.id = `palette-option-${palette.token}-${indice}`;
  li.title = `${voce.etichetta}${testoNota ? ` — ${testoNota}` : ''}`;
  li.setAttribute('aria-posinset', String(indice + 1));
  li.setAttribute('aria-setsize', String(palette.viste.length));
  li.classList.toggle('attiva', indice === palette.selezione);
  li.setAttribute('aria-selected', indice === palette.selezione ? 'true' : 'false');
}

function apriPalette() {
  document.querySelector('#palette-overlay.hidden')?.remove();
  if (palette) { chiudiPalette(); return; } // Ctrl+P di nuovo: si chiude, come in VS Code

  const overlay = document.createElement('div');
  overlay.id = 'palette-overlay';
  overlay.className = 'palette-overlay';
  overlay.innerHTML = `
    <div class="palette">
      <div class="palette-heading">
        <h2>Ricerca rapida</h2>
        <span class="palette-contesto"></span>
        <button type="button" id="palette-close" class="ghost palette-close" aria-label="Chiudi ricerca" title="Chiudi ricerca (Esc)">${lucideIconHtml('x')}</button>
      </div>
      <div class="palette-search">
        ${lucideIconHtml('search')}
        <input id="palette-input" type="text" spellcheck="false" autocomplete="off" aria-label="Cerca database, tabelle e comandi"
          role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="palette-lista" placeholder="Nome, database o comando…" />
      </div>
      <div class="palette-filtri" role="tablist" aria-label="Categorie di ricerca">
        <button type="button" class="ghost palette-filtro" role="tab" data-tab-id="tutto" data-prefix="" id="palette-filtro-tutto" aria-controls="palette-risultati">Tutto</button>
        ${Object.keys(RICHIAMI).map(c => `<button type="button" class="ghost palette-filtro" role="tab" data-tab-id="${RICHIAMI[c]}" data-prefix="${c}" id="palette-filtro-${RICHIAMI[c]}" aria-controls="palette-risultati"><span>${ETICHETTA_RICHIAMO[c]}</span><kbd>${c === '>' ? '&gt;' : c}</kbd></button>`).join('')}
      </div>
      <div id="palette-risultati" class="palette-risultati" role="tabpanel">
      <ul id="palette-lista" role="listbox" aria-label="Risultati della ricerca">
        <li class="palette-spazio" aria-hidden="true"></li>
        <li class="palette-spazio" aria-hidden="true"></li>
        <li class="palette-vuota" role="presentation" hidden>${lucideIconHtml('search-x')}<strong>Nessun risultato</strong><span>Prova un altro nome o cambia categoria.</span></li>
      </ul>
      </div>
      <div class="palette-piede">
        <span class="palette-stato" role="status"></span>
        <span class="palette-legenda"><span><kbd>↑↓</kbd> scegli</span><span><kbd>↵</kbd> apri</span><span><kbd>esc</kbd> chiudi</span></span>
      </div>
    </div>`;
  mountArcControls(overlay);
  refreshLucideIcons(overlay);
  overlay.querySelector('#palette-close').addEventListener('click', chiudiPalette);
  document.body.appendChild(overlay);
  overlay.querySelector('.palette-contesto').textContent = activeTab()?.label || 'CodeDB';

  const lista = overlay.querySelector('#palette-lista');
  const spazi = lista.querySelectorAll('.palette-spazio');
  const dbs = dbsDelTab();
  palette = {
    overlay,
    input: overlay.querySelector('#palette-input'),
    lista,
    stato: overlay.querySelector('.palette-stato'),
    filtri: overlay.querySelector('.palette-filtri'),
    risultati: overlay.querySelector('#palette-risultati'),
    sopra: spazi[0],
    sotto: spazi[1],
    vuoto: lista.querySelector('.palette-vuota'),
    righe: [],              // il pool di <li> riusati dalla finestra virtuale
    tabelle: new Map(),     // database -> nomi delle sue tabelle
    viste: [],
    selezione: 0,
    altezzaRiga: ALTEZZA_RIGA,
    misurata: false,
    token: ++aperture,
    letti: 0,
    daLeggere: dbs.length,
    ridisegnoInCorso: false,
  };
  const corrente = palette;

  /** Ricalcola l'elenco filtrato e ridisegna. Da chiamare quando cambia il
   *  CONTENUTO (termine scritto, tabelle arrivate), non quando si scorre. */
  const disegna = () => {
    if (!palette) return;
    const query = palette.input.value;
    const precedente = palette.query === query ? palette.viste[palette.selezione] : null;
    const indicePrecedente = palette.selezione;
    const y = indicePrecedente * palette.altezzaRiga - palette.lista.scrollTop;
    const inVista = y >= 0 && y + palette.altezzaRiga <= palette.lista.clientHeight + 1;
    palette.viste = filtra(raccogliVoci(), query);
    palette.query = query;
    // Le risposte in ritardo non devono spostare Invio su una voce diversa.
    if (precedente) {
      const indice = palette.viste.findIndex(v => v.tipo === precedente.tipo && v.etichetta === precedente.etichetta && v.nota === precedente.nota);
      if (indice >= 0) palette.selezione = indice;
    }
    if (palette.selezione > palette.viste.length - 1) {
      palette.selezione = Math.max(0, palette.viste.length - 1);
    }
    disegnaFinestra();
    if (precedente && inVista && indicePrecedente !== palette.selezione) muoviSelezione(0);
    aggiornaPiede();
  };
  palette.disegna = disegna;

  const scegliFiltro = button => {
    const { termine } = interpreta(palette.input.value);
    palette.input.value = button.dataset.prefix ? `${button.dataset.prefix} ${termine}` : termine;
    palette.input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  palette.filtri.addEventListener('click', e => {
    const button = e.target.closest('[role="tab"]');
    if (button) { scegliFiltro(button); palette.input.focus(); }
  });
  palette.filtri.addEventListener('keydown', e => {
    const buttons = [...palette.filtri.querySelectorAll('[role="tab"]')];
    const index = buttons.indexOf(e.target);
    if (index < 0) return;
    const next = e.key === 'ArrowRight' ? (index + 1) % buttons.length : e.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null;
    if (next !== null) { e.preventDefault(); scegliFiltro(buttons[next]); buttons[next].focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); palette.input.focus(); }
  });

  palette.input.addEventListener('input', () => {
    palette.selezione = 0;
    palette.lista.scrollTop = 0; // un termine nuovo è una lista nuova: si riparte da cima
    disegna();
  });
  palette.input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); muoviSelezione(+1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); muoviSelezione(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); muoviSelezione(+righePerSchermata()); }
    else if (e.key === 'PageUp') { e.preventDefault(); muoviSelezione(-righePerSchermata()); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      esegui(palette.viste[palette.selezione]);
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); chiudiPalette(); }
  });

  // Scorrere non ricalcola l'elenco: ridisegna solo la finestra, e al massimo
  // una volta per frame (un `wheel` ne genera molti di più).
  palette.lista.addEventListener('scroll', () => {
    if (palette !== corrente) return;
    if (palette.ridisegnoInCorso) return;
    palette.ridisegnoInCorso = true;
    requestAnimationFrame(() => {
      if (palette !== corrente) return;
      palette.ridisegnoInCorso = false;
      disegnaFinestra();
    });
  });

  palette.lista.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (!li) return;
    esegui(palette.viste[Number(li.dataset.i)]);
  });

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) chiudiPalette(); // click fuori: si chiude, come le modali
  });
  palette.lista.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || (!e.movementX && !e.movementY)) return;
    const li = e.target.closest('[data-i]');
    if (!li || Number(li.dataset.i) === palette.selezione) return;
    palette.selezione = Number(li.dataset.i);
    disegnaFinestra();
  });
  palette.lista.addEventListener('mousedown', e => {
    if (e.target.closest('[data-i]')) e.preventDefault();
  });
  overlay.addEventListener('codedb:close-dialog', chiudiPalette);

  overlay.classList.add('aperta');
  disegna();
  palette.input.focus();

  palette.observer = new ResizeObserver(() => {
    if (palette !== corrente) return;
    const h = palette.righe[0]?.offsetHeight;
    if (h && h !== palette.altezzaRiga) { palette.altezzaRiga = h; muoviSelezione(0); }
  });
  palette.observer.observe(lista);

  caricaTabelle(dbs, palette.token);
}

function esegui(voce) {
  if (!voce) return;
  chiudiPalette();
  voce.esegui();
}

/** Quante righe entrano in una schermata della lista (PagSu/PagGiù). */
function righePerSchermata() {
  return Math.max(1, Math.floor((palette.lista.clientHeight || 0) / palette.altezzaRiga) - 1);
}

/** Sposta la selezione e la porta in vista. Con la lista virtualizzata non si
 *  può usare `scrollIntoView` sull'elemento attivo: la riga scelta con le
 *  frecce può non essere in DOM. La posizione si calcola dall'indice. */
function muoviSelezione(passo) {
  const n = palette.viste.length;
  if (!n) return;
  palette.selezione = Math.min(n - 1, Math.max(0, palette.selezione + passo));
  const y = scorrimentoPerRiga({
    indice: palette.selezione,
    altezzaRiga: palette.altezzaRiga,
    scrollTop: palette.lista.scrollTop,
    altezzaViewport: palette.lista.clientHeight,
  });
  if (y !== null) palette.lista.scrollTop = y;
  disegnaFinestra();
}

/**
 * Disegna la sola finestra visibile fra i due spaziatori.
 *
 * L'aritmetica è quella della griglia dei risultati (`finestraVirtuale`), non
 * una seconda copia scritta qui: è la stessa decisione — quali righe stanno
 * nella finestra — e il modulo esiste perché non venga riscritta ogni volta.
 * Cambia il MARKUP (un elenco, non una tabella), e quello resta qui.
 */
function disegnaFinestra() {
  if (!palette) return;
  const completaTransizione = preparaTransizioneAlbero(palette.lista, '', { selettore: '.palette-voce.attiva', durata: 160 });
  const n = palette.viste.length;
  palette.vuoto.hidden = n > 0;
  palette.vuoto.querySelector('strong').textContent = palette.letti < palette.daLeggere ? 'Ricerca nelle tabelle…' : 'Nessun risultato';

  const f = finestraVirtuale({
    scrollTop: palette.lista.scrollTop,
    altezzaViewport: palette.lista.clientHeight || 300,
    altezzaRiga: palette.altezzaRiga,
    righeTotali: n,
    overscan: 6,
  });
  palette.sopra.style.height = `${f.spazioSopra}px`;
  palette.sotto.style.height = `${f.spazioSotto}px`;

  const quante = f.fine - f.inizio;
  while (palette.righe.length < quante) {
    const li = creaRiga();
    palette.righe.push(li);
    palette.lista.insertBefore(li, palette.sotto);
  }
  while (palette.righe.length > quante) palette.righe.pop().remove();
  for (let k = 0; k < quante; k++) aggiornaRiga(palette.righe[k], palette.viste[f.inizio + k], f.inizio + k);

  // L'altezza vera di una riga si sa solo dopo averne disegnata una: un tema con
  // un font più grande manderebbe fuori misura tutti gli spaziatori.
  if (!palette.misurata && palette.righe.length) {
    const h = palette.righe[0].offsetHeight;
    palette.misurata = true;
    if (h > 0 && h !== palette.altezzaRiga) { palette.altezzaRiga = h; disegnaFinestra(); return; }
  }
  const attiva = palette.righe.find(li => li.classList.contains('attiva'));
  if (attiva) palette.input.setAttribute('aria-activedescendant', attiva.id);
  else palette.input.removeAttribute('aria-activedescendant');
  completaTransizione();
}

/**
 * Il piede dice tre cose, e ognuna serve a non far sbagliare l'utente:
 *
 *  - **quante voci** ci sono, e se le tabelle stanno ancora arrivando — senza,
 *    una palette che non trova una tabella è indistinguibile da una che non
 *    l'ha ancora letta;
 *  - **quale richiamo è attivo**: con `#` scritto in testa si sta cercando fra
 *    i soli database, e non vederlo scritto significa credere che le tabelle
 *    siano sparite;
 *  Le schede espongono gli stessi richiami e seguono il prefisso digitato.
 */
function aggiornaPiede() {
  const n = palette.viste.length;
  const { richiamo, tipo } = interpreta(palette.input.value);
  const attesa = palette.letti < palette.daLeggere
    ? ` · lettura tabelle ${palette.letti}/${palette.daLeggere}…`
    : '';
  const solo = tipo ? ` · solo ${ETICHETTA_RICHIAMO[richiamo]}` : '';
  palette.stato.textContent = `${n} risultat${n === 1 ? 'o' : 'i'}${solo}${attesa}`;
  if (palette.filtro !== richiamo) {
    const completaTransizione = preparaTransizioneTab(palette.filtri);
    for (const button of palette.filtri.querySelectorAll('[role="tab"]')) {
      const selected = button.dataset.prefix === richiamo;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected) palette.risultati.setAttribute('aria-labelledby', button.id);
    }
    palette.filtro = richiamo;
    completaTransizione();
  }
}

/** I NOMI dei database del tab attivo. L'albero li tiene in cache come oggetti
 *  (`{ name, collections? }`): passarli cosi' com'erano dava una voce
 *  «[object Object]» nella palette e mandava un oggetto al posto del nome in
 *  `db:collections`, quindi nessuna tabella arrivava mai. */
function dbsDelTab() {
  const t = activeTab();
  const dbs = (t && t.state && Array.isArray(t.state.databases)) ? t.state.databases : [];
  return dbs.map((db) => (typeof db === 'string' ? db : (db && db.name))).filter(Boolean);
}

function chiudiPalette() {
  if (!palette) return;
  palette.observer?.disconnect();
  fermaTransizioniAlbero(palette.lista);
  fermaTransizioniTab(palette.filtri);
  removeDialog(palette.overlay);
  palette = null; // le risposte in volo lo vedono e si scartano da sole
}

/* ------------------------- Dispatcher globale ----------------------------- */

let inizializzato = false;

export function initPalette() {
  if (inizializzato) return;
  inizializzato = true;
  const pulsante = document.getElementById('command-palette-open');
  if (pulsante) {
    pulsante.addEventListener('click', apriPalette);
    const aggiornaRichiamo = () => {
      const richiamo = etichettaCombo(mappaAttiva().paletteComandi);
      pulsante.querySelector('kbd').textContent = richiamo;
      pulsante.title = `Cerca tabelle e comandi (${richiamo})`;
    };
    aggiornaRichiamo();
    document.addEventListener('codedb:scorciatoie', aggiornaRichiamo);
  }

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || document.querySelector('.scorciatoie-riga.attiva')) return;
    const id = azioneDiEvento(e);
    if (!id || !GLOBALI.has(id)) return; // le altre azioni sono dei loro consumatori
    // Una modale conserva il proprio contesto anche se si preme la scorciatoia di cambio scheda.
    if ((id === 'tabellaSuccessiva' || id === 'databaseSuccessivo') && document.querySelector('.overlay:not(.hidden)')) return;
    // I soli modificatori non fanno nulla: il keydown di Ctrl da solo passa.
    e.preventDefault();
    e.stopPropagation();
    if (id === 'sidebarConnessioni') mostraBarraConnessioni();
    else if (id === 'chiudiScheda') chiudiScheda();
    else if (id === 'paletteComandi') apriPalette();
    else if (id === 'tabellaSuccessiva') tabellaSuccessiva();
    else if (id === 'databaseSuccessivo') databaseSuccessivo();
  }, true);
}
