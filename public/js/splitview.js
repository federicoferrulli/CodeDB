import { chiediConferma } from './conferma.js';
import { mountArcControls } from '../arc/ui.js';
'use strict';

import { state } from './state.js';
import { colonneRisultato } from './table-cols.js';
import { activeTab, tabs, switchTab, primaDellaChiusura, allaChiusura } from './tabs.js';
import { creaRuntimePane } from './pane-runtime.js';
import { queryDocument, copiaQuery } from './query-document.js';
import { leggiStatoFiltro } from './grid.js';
import { snapshotQueryView } from './query-tab.js';
import { $, emit, esc, isSqlType, dbTypeIcon, toast, safeUUID, refreshLucideIcons, showContextMenu, hideContextMenu, openModal, closeModal, chiediTesto, lucideIconHtml as ICO } from './utils.js';
import { contestoCorrente } from './coerenza-richieste.js';
import {
  creaAlbero, inserisci, rimuovi, trascina, pareggia as pareggiaAlbero,
  scambia, ruotaOrientamento as ruotaAlbero, elencoPane, contaPane, valida,
  dimensioniNormalizzate, contenitoreDi, vicinoDi, nodoAlPercorso,
  MIN_PANE_LARGHEZZA, MIN_PANE_ALTEZZA,
} from './split-layout.js';

/**
 * Le aree affiancate aperte, indicizzate per **coll-tab**.
 *
 * Erano un singleton di modulo, e il singleton non era una semplificazione: il
 * coll-tab che ospita i pannelli vive dentro un tab di connessione, quindi due
 * tab potevano ritrovarsi con due schede che disegnavano gli stessi pannelli,
 * ognuna convinta di essere l'unica. Indicizzare per coll-tab risolve il caso e
 * ne apre uno nuovo che prima era vietato: **più aree affiancate insieme**,
 * nello stesso tab di connessione o in tab diversi, ognuna con i propri
 * pannelli, il proprio layout e il proprio nome.
 *
 * Chi è "l'area corrente" dipende da cosa si sta guardando (`areaAttiva`);
 * le operazioni che partono da un pannello risalgono invece alla propria area
 * dall'id del pannello (`areaDiPane`), che è unico fra tutte le aree.
 */
const aree = new Map();

export function modifichePendentiNeiPannelli() {
  return [...aree.values()].some(a => [...a.panes.values()].some(p => p.runtime ? p.runtime.dirty() : p.query?.dirty));
}

primaDellaChiusura(async tab => {
  const dipendenti = [...aree.values()].flatMap(a => [...a.panes.values()]).filter(p => p.tabId === tab.id);
  if (!dipendenti.length) return true;
  const modificati = dipendenti.some(p => (p.runtime ? p.runtime.dirty() : p.query?.dirty));
  return await chiediConferma(`Disconnettere ${tab.label}? Verranno chiusi ${dipendenti.length} pannelli collegati.${modificati ? ' Contengono testo non salvato.' : ''} Le altre connessioni resteranno aperte.`);
});

allaChiusura(tabId => {
  const tab = tabs.list.find(t => t.id === tabId);
  for (const a of [...aree.values()]) {
    for (const p of [...a.panes.values()]) {
      if (p.tabId !== tabId) continue;
      disposePane(p);
      a.panes.delete(p.id); a.elementi.delete(p.id); a.layout = rimuovi(a.layout, p.id);
    }
    const ct = tab?.state.collTabs.find(c => c.id === a.collTabId);
    if (!a.panes.size) { aree.delete(a.collTabId); if (ct) tab.state.collTabs.splice(tab.state.collTabs.indexOf(ct), 1); continue; }
    if (!a.panes.has(a.focusedPaneId)) a.focusedPaneId = [...a.panes.keys()][0];
    if (ct) {
      const destinazione = tabs.list.find(t => t.id === [...a.panes.values()][0].tabId);
      tab.state.collTabs.splice(tab.state.collTabs.indexOf(ct), 1);
      destinazione.state.collTabs.push(ct);
      destinazione.state.activeCollId = ct.id;
    }
    aggiornaEtichettaCollTab(a);
  }
});

function nuovaArea(collTabId) {
  return {
    collTabId,
    active: false,
    focusedPaneId: null,
    panes: new Map(),
    layout: null,
    // Pannello a tutta area. NON è nell'albero di proposito: massimizzare è una
    // vista temporanea, e uscendo si deve ritrovare esattamente il layout di
    // prima — scriverlo nell'albero significherebbe perderlo.
    maximizedPaneId: null,
    // Nome scelto dall'utente; senza, l'etichetta la scrivono le tabelle dentro.
    nome: null,
    /**
     * Elementi DOM dei pannelli, tenuti fra un rimontaggio e l'altro.
     *
     * Il layout si rimonta a ogni aggiunta o chiusura di pannello, e ricostruire
     * anche i pannelli superstiti buttava via ciò che l'utente aveva sotto gli
     * occhi: posizione dello scorrimento, cella in modifica, caselle spuntate —
     * più una `db:collections` per pannello a ogni giro. `appendChild` sposta un
     * nodo già in pagina senza distruggerlo, quindi riordinare è gratis.
     */
    elementi: new Map(),
  };
}

/** Area del coll-tab attivo, se quel coll-tab è un'area affiancata. */
function areaAttiva() {
  const t = activeTab();
  if (!t || !t.state.activeCollId) return null;
  return aree.get(t.state.activeCollId) || null;
}

/** Area che contiene un dato pannello (gli id dei pannelli sono globalmente
 *  unici, quindi la risposta è una sola). */
function areaDiPane(paneId) {
  for (const a of aree.values()) if (a.panes.has(paneId)) return a;
  return null;
}

/** Il pannello, cercato in tutte le aree aperte. */
function paneById(paneId) {
  const a = areaDiPane(paneId);
  return a ? a.panes.get(paneId) : null;
}

/** Promesse di `db:collections` per (tab, database): due pannelli sullo stesso
 *  database fanno una richiesta sola. Vale per tutte le aree — la connessione è
 *  la stessa. */
const cacheCollections = new Map();

function nextPaneId() {
  // Id casuale e non progressivo: dopo un F5 il contatore ripartiva da zero
  // mentre lo snapshot ripristinava `pane_1`/`pane_2`, quindi il pannello
  // successivo riceveva un id GIÀ VIVO e `panes.set` ne sovrascriveva uno
  // aperto, in silenzio. Con più aree insieme l'unicità serve anche fra aree.
  return 'pane_' + safeUUID();
}

export function splitDisponibile() {
  return !window.matchMedia('(max-width: 900px)').matches;
}

/**
 * L'area affiancata è quella che si sta guardando ADESSO?
 *
 * Non basta che esistano dei pannelli: un'area resta viva quando si apre
 * un'altra collection in un coll-tab normale, e in quel momento non deve più
 * governare nulla. Senza questa distinzione `setView('data')` prendeva il ramo
 * della Split-View, nascondeva `#view-data` e riportava `state.db`/`state.coll`
 * al pannello a fuoco: il tab appena aperto risultava **completamente vuoto**.
 */
export function splitInPrimoPiano() {
  const a = areaAttiva();
  // Basta UN pannello: aprendo una seconda area da dentro la prima non c'è
  // alcuna collection da promuovere, quindi la nuova nasce con un pannello solo
  // e ci si trascina dentro il secondo. Pretendendone due, quell'area appena
  // creata non sarebbe riconosciuta come tale e la sua vista resterebbe vuota.
  return splitDisponibile() && !!(a && a.active && a.panes.size >= 1);
}

/** Database e tabella del pannello a fuoco dell'area corrente: è il bersaglio
 *  delle viste Dettagli/UML/Query mentre la Split-View è aperta. */
export function contestoPaneAFuoco() {
  const a = areaAttiva();
  if (!a) return null;
  const p = a.panes.get(getFocusedPaneId());
  if (!p) return null;
  return { tabId: p.tabId, db: p.db, coll: p.coll };
}

/**
 * Etichetta del coll-tab di un'area: il nome scelto dall'utente, oppure le
 * tabelle che contiene. Con più aree aperte "Area Split-View" tre volte non
 * distingue nulla, e per sceglierne una bisognerebbe aprirle tutte.
 */
function etichettaArea(a) {
  if (a && a.nome) return a.nome;
  const colls = elencoPane(a && a.layout).map((id) => a.panes.get(id)).filter(Boolean).map((p) => p.coll);
  if (!colls.length) return 'Affiancati';
  const testa = colls.slice(0, 2).join(' + ');
  const resto = colls.length - 2;
  return `${testa}${resto > 0 ? ` +${resto}` : ''}`;
}

/** Riallinea l'etichetta del coll-tab a ciò che l'area contiene davvero. */
function aggiornaEtichettaCollTab(a) {
  if (!a) return;
  for (const t of tabs.list) {
    const ct = t.state.collTabs.find((c) => c.id === a.collTabId);
    if (ct) { ct.coll = etichettaArea(a); ct.nomeSplit = a.nome || null; return; }
  }
}

/** Rinomina un'area (voce "Rinomina" nel menu del suo coll-tab). Nome vuoto =
 *  si torna all'etichetta automatica. */
export function rinominaArea(collTabId, nome) {
  const a = aree.get(collTabId);
  if (!a) return;
  a.nome = (nome || '').trim() || null;
  aggiornaEtichettaCollTab(a);
  import('./colltabs.js').then((m) => m.renderCollTabBar());
}

/**
 * Mostra i pannelli affiancati oppure, al loro posto, la vista normale del
 * workspace (Dettagli, UML, ⚡ Query…) senza smontare nulla: lo stato della
 * Split-View resta intatto e la tab "Affiancati" ci riporta.
 */
export function mostraPannelliAffiancati(mostra) {
  $('#workspace')?.classList.toggle('split-mostra-pannelli', !!mostra);
}

/** Snapshot di UNA area (per il ripristino di sessione): con più aree aperte
 *  ognuna ha il proprio, agganciato al proprio coll-tab. */
export function getSplitStateSnapshot(collTabId) {
  const a = collTabId ? aree.get(collTabId) : areaAttiva();
  if (!a || !a.active || !a.panes.size) return null;
  return {
    active: a.active,
    layout: a.layout,
    focusedPaneId: a.focusedPaneId,
    splitCollTabId: a.collTabId,
    nome: a.nome || null,
    panes: Array.from(a.panes.entries()).map(([pId, p]) => [
      pId,
      {
        id: p.id,
        tabId: p.tabId,
        db: p.db,
        coll: p.coll,
        ...datiPersistentiPane(p),
        filter: (p.runtime?.dataSnapshot() || p).filter || '',
        filterMode: (p.runtime?.dataSnapshot() || p).filterMode || 'condizione',
        sort: (p.runtime?.dataSnapshot() || p).sort || '',
        queryMode: p.queryMode || 'find',
        // Senza skip/limit il refresh riportava ogni pannello alla prima
        // pagina: chi stava guardando la pagina 12 non aveva modo di capire
        // perché i dati fossero cambiati.
        skip: (p.runtime?.dataSnapshot() || p).skip || 0,
        limit: (p.runtime?.dataSnapshot() || p).limit || 50,
        view: p.view || 'data',
        query: (() => { const q = p.runtime?.snapshot() || p.query; return q ? { code: q.code, engine: q.engine, dirty: q.dirty } : null; })(),
      },
    ]),
  };
}

export function restoreSplitStateSnapshot(snap, collTabId) {
  if (!snap || !snap.panes || !snap.panes.length) return;
  // Il coll-tab conserva il proprio id attraverso il ripristino (vedi
  // session-restore.js): è la chiave dell'area, e senza di essa più aree
  // ripristinate insieme si sovrascriverebbero a vicenda.
  const chiave = collTabId || snap.splitCollTabId;
  if (!chiave) return;
  for (const p of aree.get(chiave)?.panes.values() || []) disposePane(p);
  const a = nuovaArea(chiave);
  aree.set(chiave, a);
  cacheCollections.clear();

  a.active = !!snap.active;
  a.focusedPaneId = snap.focusedPaneId || null;
  a.nome = snap.nome || null;
  for (const [pId, p] of snap.panes) {
    a.panes.set(pId, {
      id: p.id,
      tabId: p.tabId,
      view: p.view || 'data',
      query: p.query || null,
      db: p.db,
      coll: p.coll,
      ...datiPersistentiPane(p),
      filter: p.filter || '',
      filterMode: p.filterMode || 'condizione',
      sort: p.sort || '',
      queryMode: p.queryMode || 'find',
      skip: p.skip || 0,
      limit: p.limit || 50,
      total: 0,
      docs: [],
      columns: [],
      loading: false,
      error: null,
      // I dati non stanno nello snapshot (sarebbero megabyte in sessionStorage
      // e comunque vecchi): `renderSplitView` li richiede al database per ogni
      // pannello non ancora caricato. Prima non lo faceva nessuno, e dopo un F5
      // tutti i pannelli dicevano "Nessun documento trovato" finché non si
      // premeva ⟳ su ognuno.
      caricato: false,
      selectedDocs: new Set(),
    });
  }
  // L'albero arriva da sessionStorage, cioè da fuori: può citare pannelli che
  // non esistono più o dimenticarne di vivi (che resterebbero invisibili).
  a.layout = valida(snap.layout || null, new Set(a.panes.keys()));
}

export function getFocusedPaneId() {
  const a = areaAttiva();
  if (!a) return null;
  if (a.focusedPaneId && a.panes.has(a.focusedPaneId)) return a.focusedPaneId;
  const first = Array.from(a.panes.keys())[0];
  a.focusedPaneId = first || null;
  return a.focusedPaneId;
}

export function raggiungiPannelloAttivo() {
  const id = getFocusedPaneId();
  const el = id && areaDiPane(id)?.elementi.get(id);
  el?.scrollIntoView({ block: 'start' });
  if (id) setFocusedPane(id, { sposta: true });
}

export function setFocusedPane(paneId, opts = {}) {
  const a = areaDiPane(paneId);
  if (!a) return;
  a.focusedPaneId = paneId;
  document.querySelectorAll('.split-pane').forEach((el) => {
    const attivo = el.dataset.paneId === paneId;
    el.classList.toggle('focused', attivo);
    // `aria-current` è ciò che un lettore di schermo annuncia: la sola classe
    // `.focused` dipinge un bordo e non dice nulla a chi non lo vede.
    if (attivo) el.setAttribute('aria-current', 'true');
    else el.removeAttribute('aria-current');
  });
  if (opts.sposta) {
    const el = document.querySelector(`.split-pane[data-pane-id="${paneId}"]`);
    if (el) el.focus({ preventScroll: false });
  }
}

export function setPaneView(paneId, view) {
  paneId ||= getFocusedPaneId();
  const p = paneById(paneId);
  const el = areaDiPane(paneId)?.elementi.get(paneId);
  if (!p || !el) return;
  p.view = view;
  el.querySelectorAll('[data-pane-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.paneView === view)));
  if (!p.runtime) p.runtime = creaRuntimePane(p, el.querySelector('.pane-surface-slot'), () => setFocusedPane(paneId), () => closePane(paneId), () => aggiornaContestoPane(paneId));
  p.runtime?.setView(view);
  aggiornaContestoPane(paneId);
  setFocusedPane(paneId);
}

function datiPersistentiPane(p) {
  const d = p.runtime?.dataSnapshot() || p;
  return { quickSearch: d.quickSearch, advancedCondition: d.advancedCondition, pageSize: d.pageSize, infiniteScroll: d.infiniteScroll };
}

function aggiornaContestoPane(paneId) {
  const p = paneById(paneId), el = areaDiPane(paneId)?.elementi.get(paneId);
  if (!p || !el) return;
  aggiornaEtichettaPane(el, p);
  el.querySelector('.pane-db-select').value = p.db;
  const db = p.db, coll = p.coll;
  fetchCollectionsForPane(paneId, db).then(colls => {
    if (p.db === db && p.coll === coll) popolaSelectColl(el.querySelector('.pane-coll-select'), colls, coll);
  });
  el.querySelectorAll('[data-pane-view]').forEach(button => {
    button.hidden = !p.coll && ['data', 'details'].includes(button.dataset.paneView);
    button.setAttribute('aria-pressed', String(button.dataset.paneView === p.view));
  });
  const visual = el.querySelector('.pane-visualize-btn');
  visual.setAttribute('aria-pressed', String(['uml', 'graph3d'].includes(p.view)));
  visual.querySelector('span').textContent = p.view === 'uml' ? 'UML' : p.view === 'graph3d' ? 'Grafo 3D' : 'Visualizza';
  aggiornaEtichettaCollTab(areaDiPane(paneId));
  import('./colltabs.js').then(m => m.renderCollTabBar());
}

export function scegliPannelloDaAffiancare(button) {
  if (!splitDisponibile()) return;
  const rect = button.getBoundingClientRect();
  const voci = [];
  for (const tab of tabs.list.filter(t => t.state.connected)) {
    for (const ct of tab.state.collTabs.filter(c => !c.isSplitTab)) {
      const view = tab.state.activeCollId === ct.id ? tab.state.view : ct.snap?.view;
      voci.push({ icona: ct.isDbTab ? 'code' : 'table', label: `${tab.label} / ${ct.db} / ${ct.coll || 'Query'}`,
        action: () => addOrSplitPane(getFocusedPaneId(), 'right', { tabId: tab.id, db: ct.db, coll: ct.coll,
          view: ct.isDbTab ? 'query' : view || 'data', query: ct.snapQuery,
          data: tab.state.activeCollId === ct.id ? { ...tab.state } : ct.snap,
          filter: ct.snap?.filter, filterMode: ct.snap?.filterMode, sort: ct.snap?.sort }) });
    }
  }
  if (!voci.length) voci.push({ label: 'Apri una tabella o un database per affiancarlo', disabled: true });
  showContextMenu(rect.left, rect.bottom, voci);
}

export async function riprendiQueryPane(item) {
  if (!splitDisponibile()) { toast('Riprendi questa query da desktop. Il codice resta disponibile nel registro.'); return; }
  const a = areaDiPane(item.paneId);
  const p = a?.panes.get(item.paneId);
  if (!p) { toast('Il pannello di origine è stato chiuso. Il testo resta nel registro delle query.', true); return; }
  const owner = tabs.list.find(t => t.state.collTabs.some(c => c.id === a.collTabId));
  const workspace = await import('./workspace.js');
  workspace.saveWorkspaceInputs();
  switchTab(owner.id);
  (await import('./colltabs.js')).switchCollTab(a.collTabId);
  setPaneView(p.id, 'query');
  await p.runtime?.frame.codedbPanel.riprendi?.(item);
}

export function initSplitView() {
  const ws = $('#workspace');
  if (!ws) return;

  document.addEventListener('keydown', handleSplitKeys);
  document.addEventListener('dragstart', e => {
    if (e.dataTransfer?.types.includes('application/codedb-tab')) document.body.classList.add('split-dragging');
  });
  for (const event of ['dragend', 'drop']) document.addEventListener(event, () => document.body.classList.remove('split-dragging'));

  const tabContainer = $('#coll-tab-bar') || $('#tab-bar');
  if (tabContainer) {
    tabContainer.addEventListener('dragover', (e) => e.stopPropagation());
    tabContainer.addEventListener('drop', (e) => e.stopPropagation());
  }

  let dropOverlay = $('#drop-zone-overlay');
  if (!dropOverlay) {
    dropOverlay = document.createElement('div');
    dropOverlay.id = 'drop-zone-overlay';
    dropOverlay.className = 'drop-zone-overlay hidden';
    dropOverlay.innerHTML = '<div class="drop-zone-label"></div>';
    document.body.appendChild(dropOverlay);
  }

  ws.addEventListener('dragover', handleWorkspaceDragOver);
  ws.addEventListener('dragleave', handleWorkspaceDragLeave);
  ws.addEventListener('drop', handleWorkspaceDrop);
}

/**
 * Scorciatoie della Split-View, tutte con Alt: muoversi fra i pannelli senza
 * mouse, massimizzare, pareggiare.
 *
 * Attive solo a Split-View aperta e mai mentre si scrive: `Alt+←` dentro il
 * campo filtro deve restare la navigazione del testo, non un cambio di
 * pannello.
 */
function handleSplitKeys(e) {
  if (!splitDisponibile()) return;
  const a = areaAttiva();
  if (!a || !a.active || !a.panes.size) return;
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  // `e.target` non è sempre un elemento: per un evento inviato al `document`
  // (o al `window`) è il documento stesso, che non ha `closest` — e la chiamata
  // secca lanciava un TypeError, cioè nessuna scorciatoia funzionante.
  const t = e.target;
  if (t && typeof t.closest === 'function' && (t.closest('input, textarea, select, [role="combobox"], [role="option"], [role="checkbox"], [data-arc-calendar-popup], [data-arc-color-popup]') || t.isContentEditable)) return;
  if (!$('#workspace')?.classList.contains('split-active')) return;

  const corrente = getFocusedPaneId();

  if (e.key >= '1' && e.key <= '9') {
    const ids = elencoPane(a.layout);
    const scelto = ids[Number(e.key) - 1];
    if (scelto) { e.preventDefault(); setFocusedPane(scelto, { sposta: true }); }
    return;
  }

  switch (e.key) {
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
      const vicino = paneNellaDirezione(corrente, e.key);
      if (vicino) { e.preventDefault(); setFocusedPane(vicino, { sposta: true }); }
      break;
    }
    case 'm': case 'M':
      e.preventDefault();
      massimizzaPane(corrente);
      break;
    case 'e': case 'E':
      e.preventDefault();
      pareggiaPannelli();
      break;
    default:
      break;
  }
}

/**
 * Pannello adiacente in una direzione. Si guardano i rettangoli reali e non
 * l'ordine nell'albero: con layout misti (una colonna dentro una riga) "quello
 * a destra" non è il successivo dell'elenco, ed è ciò che l'utente vede.
 */
function paneNellaDirezione(paneId, tasto) {
  const el = document.querySelector(`.split-pane[data-pane-id="${paneId}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;

  let migliore = null;
  let miglioreDist = Infinity;
  document.querySelectorAll('.split-pane').forEach((altro) => {
    if (altro === el) return;
    const ra = altro.getBoundingClientRect();
    const ax = ra.left + ra.width / 2;
    const ay = ra.top + ra.height / 2;
    const dx = ax - cx;
    const dy = ay - cy;
    const verso =
      (tasto === 'ArrowLeft' && dx < -1 && Math.abs(dx) >= Math.abs(dy)) ||
      (tasto === 'ArrowRight' && dx > 1 && Math.abs(dx) >= Math.abs(dy)) ||
      (tasto === 'ArrowUp' && dy < -1 && Math.abs(dy) > Math.abs(dx)) ||
      (tasto === 'ArrowDown' && dy > 1 && Math.abs(dy) > Math.abs(dx));
    if (!verso) return;
    const dist = dx * dx + dy * dy;
    if (dist < miglioreDist) { miglioreDist = dist; migliore = altro.dataset.paneId; }
  });
  return migliore;
}



/**
 * Coll-tab e area su cui deve finire un nuovo pannello.
 *
 * Se il coll-tab attivo È già un'area affiancata si lavora su quella; altrimenti
 * se ne crea una NUOVA. Prima esisteva un solo coll-tab split per tab di
 * connessione e ci si affiancava sempre lì dentro, quindi non c'era modo di
 * tenere due confronti aperti insieme — e con due tab di connessione le due
 * schede finivano a disegnare gli stessi pannelli.
 */
function ensureSplitCollTab(forzaNuova = false) {
  const t = activeTab();
  if (!t) return null;

  const attivo = t.state.collTabs.find((c) => c.id === t.state.activeCollId);
  let splitCt = (!forzaNuova && attivo && attivo.isSplitTab) ? attivo : null;

  if (!splitCt) {
    splitCt = {
      id: 'splitview_' + safeUUID(),
      isSplitTab: true,
      db: 'Split-View',
      coll: 'Affiancati',
      snap: null,
    };
    t.state.collTabs.push(splitCt);
  }
  t.state.activeCollId = splitCt.id;
  if (!aree.has(splitCt.id)) aree.set(splitCt.id, nuovaArea(splitCt.id));
  return splitCt;
}

/**
 * Chiude la vista affiancata rimettendo in piedi il workspace normale.
 *
 * I nodi del workspace NON vengono più staccati e riattaccati: restano in
 * pagina e li nasconde il CSS (`#workspace.split-active`). Staccarli aveva due
 * conseguenze — le tab vista Dati/Dettagli/⚡Query sparivano insieme al resto,
 * quindi durante la Split-View non c'era modo di raggiungerle, e ogni `$(...)`
 * su un elemento del workspace tornava `null`, il che obbligava `workspace.js`
 * a chiedersi se il DOM fosse "via" prima di leggere un campo.
 */
export function deactivateSplitView() {
  const ws = $('#workspace');
  if (!ws || !ws.classList.contains('split-active')) return;
  ws.classList.remove('split-active', 'split-mostra-pannelli');
  conservaPannelliMontati();
  ws.querySelector('.split-container')?.remove();
  for (const a of aree.values()) for (const p of a.panes.values()) p.runtime?.allinea();
}

// Arc smonta i controlli scollegati: anche le testate, come i runtime, restano montate.
function conservaPannelliMontati() {
  const ws = $('#workspace');
  let cache = $('#pane-layout-cache');
  if (!cache) { cache = document.createElement('div'); cache.id = 'pane-layout-cache'; cache.hidden = true; ws.append(cache); }
  for (const el of ws.querySelectorAll('.split-container .split-pane')) cache.append(el);
  for (const el of [...cache.children]) {
    if (areaDiPane(el.dataset.paneId)?.elementi.get(el.dataset.paneId) !== el) el.remove();
  }
}

// Un'area vive nello stato di UN tab di connessione: se quel tab (o il suo
// coll-tab) è stato chiuso, i suoi pannelli puntano a sessioni server
// inesistenti. Qui le aree rimaste orfane vengono buttate, una per una: con più
// aree aperte non si può più azzerare tutto perché una non c'è più.
export function discardSplitViewIfOrphan() {
  if (!aree.size) return;
  const vivi = new Set();
  for (const t of tabs.list) {
    for (const c of t.state.collTabs) if (c.isSplitTab) vivi.add(c.id);
  }
  for (const id of [...aree.keys()]) {
    if (!vivi.has(id)) { for (const p of aree.get(id).panes.values()) disposePane(p); aree.delete(id); }
  }
  if (!aree.size) cacheCollections.clear();
  if (!areaAttiva()) deactivateSplitView();
}

function handleWorkspaceDragOver(e) {
  if (!splitDisponibile()) { hideDropPreview(); return; }
  if (
    e.target.closest('#coll-tab-bar') ||
    e.target.closest('#tab-bar') ||
    e.target.closest('#sidebar') ||
    e.target.closest('#conn-sidebar') ||
    e.target.closest('input, textarea') ||
    e.target.closest('.query-editor-container') ||
    e.target.closest('.query-sidebar')
  ) {
    hideDropPreview();
    return;
  }

  if (!e.dataTransfer.types.includes('application/codedb-tab')) {
    hideDropPreview();
    return;
  }

  const targetPaneEl = e.target.closest('.split-pane') || $('#workspace');
  if (!targetPaneEl) return;

  const rect = targetPaneEl.getBoundingClientRect();
  const relX = (e.clientX - rect.left) / rect.width;
  const relY = (e.clientY - rect.top) / rect.height;

  let dir = 'center';
  if (relX > 0.75) dir = 'right';
  else if (relX < 0.25) dir = 'left';
  else if (relY > 0.75) dir = 'bottom';
  else if (relY < 0.25) dir = 'top';

  if (!splitInPrimoPiano() && dir === 'center') {
    hideDropPreview();
    return;
  }

  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  showDropPreview(targetPaneEl, dir);
}

function handleWorkspaceDragLeave(e) {
  const overlay = $('#drop-zone-overlay');
  if (!overlay) return;
  if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
    overlay.classList.add('hidden');
  }
}

function showDropPreview(targetEl, dir) {
  const overlay = $('#drop-zone-overlay');
  if (!overlay) return;

  const rect = targetEl.getBoundingClientRect();
  const label = overlay.querySelector('.drop-zone-label');

  overlay.classList.remove('hidden');

  let top = rect.top;
  let left = rect.left;
  let width = rect.width;
  let height = rect.height;

  if (dir === 'right') {
    left = rect.left + rect.width * 0.5;
    width = rect.width * 0.5;
    if (label) label.textContent = 'Affianca a destra ➔';
  } else if (dir === 'left') {
    width = rect.width * 0.5;
    if (label) label.textContent = '◄ Affianca a sinistra';
  } else if (dir === 'bottom') {
    top = rect.top + rect.height * 0.5;
    height = rect.height * 0.5;
    if (label) label.textContent = 'Affianca sotto';
  } else if (dir === 'top') {
    height = rect.height * 0.5;
    if (label) label.textContent = 'Affianca sopra';
  } else {
    if (label) label.textContent = 'Apri in questo pannello';
  }

  overlay.style.top = `${top}px`;
  overlay.style.left = `${left}px`;
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
}

function hideDropPreview() {
  const overlay = $('#drop-zone-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function handleWorkspaceDrop(e) {
  hideDropPreview();
  if (!splitDisponibile()) return;

  if (
    e.target.closest('#coll-tab-bar') ||
    e.target.closest('#tab-bar') ||
    e.target.closest('#sidebar') ||
    e.target.closest('#conn-sidebar') ||
    e.target.closest('input, textarea') ||
    e.target.closest('.query-editor-container') ||
    e.target.closest('.query-sidebar')
  ) {
    return;
  }

  const dataRaw = e.dataTransfer.getData('application/codedb-tab');
  if (!dataRaw) return;

  let item = null;
  try {
    item = JSON.parse(dataRaw);
  } catch {
    return;
  }

  if (!item || !item.db || !item.coll) return;

  const targetPaneEl = e.target.closest('.split-pane');
  const targetPaneId = targetPaneEl ? targetPaneEl.dataset.paneId : null;

  const rect = (targetPaneEl || $('#workspace')).getBoundingClientRect();
  const relX = (e.clientX - rect.left) / rect.width;
  const relY = (e.clientY - rect.top) / rect.height;

  let dir = 'center';
  if (relX > 0.75) dir = 'right';
  else if (relX < 0.25) dir = 'left';
  else if (relY > 0.75) dir = 'bottom';
  else if (relY < 0.25) dir = 'top';

  if (!splitInPrimoPiano() && dir === 'center') {
    return;
  }

  e.preventDefault();
  addOrSplitPane(targetPaneId, dir, item);
}

export async function addOrSplitPane(targetPaneId, dir, item, opts = {}) {
  if (!splitDisponibile()) return;
  const t = activeTab();
  const tabId = item.tabId || (t ? t.id : null);
  if (!tabId) return;

  // Se si rilascia su un pannello, si lavora nell'area di QUEL pannello; se non
  // c'è bersaglio, decide `ensureSplitCollTab`: area corrente se il coll-tab
  // attivo è già affiancato, altrimenti una nuova. `nuovaArea` la forza, ed è
  // l'unico modo di aprire una seconda area stando dentro la prima.
  const areaBersaglio = (targetPaneId && !opts.nuovaArea) ? areaDiPane(targetPaneId) : null;

  // La collection aperta adesso diventa il primo pannello della nuova area, e
  // va letta PRIMA di cambiare coll-tab attivo (dopo, filtro e ordinamento a
  // schermo non descriverebbero più lei).
  const corrente = t?.state.collTabs.find(c => c.id === t.state.activeCollId);
  if (corrente && !corrente.isSplitTab) Object.assign(queryDocument(t), snapshotQueryView(), { code: $('#query-editor-input')?.value || '', engine: $('#query-target-engine')?.value || 'auto' });
  const daPromuovere = (!areaBersaglio && !splitInPrimoPiano() && state.db && (state.coll || corrente?.isDbTab))
    ? {
        db: state.db,
        coll: state.coll,
        filter: $('#filter-input')?.value || '',
        filterMode: leggiStatoFiltro().modo,
        quickSearch: leggiStatoFiltro().rapido, advancedCondition: leggiStatoFiltro().condizione,
        pageSize: $('#page-size').value, infiniteScroll: state.infiniteScroll,
        sort: $('#sort-input')?.value || '',
        queryMode: $('#query-mode')?.value || 'find',
        skip: state.skip || 0,
        limit: state.limit || 50,
        total: state.total || 0,
        docs: state.docs || [],
        columns: state.columns || [],
        columnMeta: state.columnMeta || {},
        selectedDocs: new Set(state.selectedDocs),
        cellSel: structuredClone(state.cellSel),
        gridWidths: new Map(corrente?.gridWidths || []),
        view: state.view || 'data',
        query: copiaQuery(queryDocument(t)),
      }
    : null;

  const splitCt = areaBersaglio ? null : ensureSplitCollTab(!!opts.nuovaArea);
  const a = areaBersaglio || (splitCt ? aree.get(splitCt.id) : null);
  if (!a) return;

  const pId = nextPaneId();
  const newPane = {
    id: pId,
    tabId,
    view: item.view || (item.coll ? 'data' : 'query'),
    query: copiaQuery(item.query),
    data: item.data || null,
    db: item.db,
    coll: item.coll,
    filter: item.filter || '',
    filterMode: item.filterMode || 'rapido',
    sort: item.sort || '',
    queryMode: item.queryMode || 'find',
    skip: 0,
    limit: 50,
    total: 0,
    docs: [],
    columns: [],
    loading: false,
    error: null,
    caricato: false,
    selectedDocs: new Set(),
  };


  a.panes.set(pId, newPane);
  a.maximizedPaneId = null;

  if (!a.layout || a.panes.size === 1) {
    if (a.panes.size === 1 && daPromuovere) {
      const firstExistingId = nextPaneId();
      const firstPane = {
        id: firstExistingId,
        tabId: t ? t.id : tabId,
        ...daPromuovere,
        loading: false,
        error: null,
        caricato: true,
      };


      a.panes.set(firstExistingId, firstPane);
      a.panes.delete(pId);

      const pId2 = nextPaneId();
      newPane.id = pId2;
      a.panes.set(pId2, newPane);

      a.layout = creaAlbero(firstExistingId, pId2, dir);
      a.focusedPaneId = pId2;
    } else {
      a.layout = { type: 'pane', paneId: pId };
      a.focusedPaneId = pId;
    }
  } else if (targetPaneId && a.panes.has(targetPaneId)) {
    if (dir === 'center') {
      const precedente = a.panes.get(targetPaneId);
      if (!await confermaChiusuraPane(precedente) || !splitDisponibile()) { a.panes.delete(pId); return; }
      disposePane(precedente);
      newPane.id = targetPaneId;
      a.panes.set(targetPaneId, newPane);
      a.panes.delete(pId);
      // Il pannello cambia database e tabella: la sua testata va ricostruita,
      // non aggiornata.
      a.elementi.delete(targetPaneId);
      a.focusedPaneId = targetPaneId;
      renderSplitView();
      aggiornaEtichettaCollTab(a);
      import('./colltabs.js').then((m) => m.renderCollTabBar());
      return;
    } else {
      a.layout = inserisci(a.layout, targetPaneId, pId, dir);
      a.focusedPaneId = pId;
    }
  } else {
    const rootPaneId = Array.from(a.panes.keys())[0];
    a.layout = inserisci(a.layout, rootPaneId, pId, 'right');
    a.focusedPaneId = pId;
  }

  a.active = a.panes.size >= 1;
  aggiornaEtichettaCollTab(a);

  renderSplitView();

  import('./colltabs.js').then((m) => m.renderCollTabBar());
}

export async function closePane(paneId) {
  const a = areaDiPane(paneId);
  if (!a) return;
  if (!await confermaChiusuraPane(a.panes.get(paneId))) return;
  disposePane(a.panes.get(paneId));
  const vicino = vicinoDi(a.layout, paneId, 'prev') || vicinoDi(a.layout, paneId, 'next');

  a.panes.delete(paneId);
  a.elementi.delete(paneId);
  if (a.maximizedPaneId === paneId) a.maximizedPaneId = null;

  if (a.panes.size === 0) {
    closeSplitView({ collTabId: a.collTabId });
    return;
  }

  a.layout = rimuovi(a.layout, paneId);
  // Il fuoco va al vicino, non al primo pannello dell'elenco: chiudendone uno
  // ci si aspetta di restare dov'era, non di essere spediti all'altro capo.
  a.focusedPaneId = (vicino && a.panes.has(vicino))
    ? vicino
    : Array.from(a.panes.keys())[0] || null;
  aggiornaEtichettaCollTab(a);
  renderSplitView();
  import('./colltabs.js').then((m) => m.renderCollTabBar());
}

function disposePane(p) {
  if (!p) return;
  if (p.runId) emit('query:cancel', { tabId: p.tabId, runId: p.runId }).catch(() => {});
  p.runtime?.dispose();
  const el = areaDiPane(p.id)?.elementi.get(p.id);
  if (el?.parentElement?.id === 'pane-layout-cache') el.remove();
}

async function confermaChiusuraPane(p) {
  if (p?.runtime?.writing()) { toast('Salvataggio in corso: attendi l’esito prima di cambiare o chiudere il pannello.', true); return false; }
  return !p || !((p.runtime ? p.runtime.dirty() : p.query?.dirty)) || await chiediConferma(`Chiudere ${p.db} / ${p.coll || 'Query'} e scartare il testo non salvato?`);
}

/* ------------------- reazione alle DDL (drop e rinomina) ------------------ */

/** Aree del tab di connessione che possiede quello stato (anche in secondo
 *  piano: una DDL può rispondere quando l'utente ha già cambiato tab). */
function areeDi(st) {
  const t = tabs.list.find((tt) => tt.state === st) || activeTab();
  if (!t) return { t: null, lista: [] };
  const lista = [...aree.values()].filter(a => [...a.panes.values()].some(p => p.tabId === t.id));
  return { t, lista };
}

/**
 * Chiude i pannelli che puntano a un database o a una collection appena
 * eliminati. Gemello di `closeCollTabsWhere` (`colltabs.js`), che i pannelli non
 * poteva vederli: i suoi predicati leggono `db`/`coll` del coll-tab, e per
 * un'area valgono `'Split-View'`. Restavano quindi riquadri puntati su qualcosa
 * che non esiste più, che si scoprono solo alla query successiva — con un errore
 * del driver al posto di una spiegazione.
 *
 * Un'area che perde TUTTI i pannelli si chiude; una che ne conserva anche uno
 * solo resta aperta: l'eliminazione è arrivata da fuori, e chiudere d'ufficio
 * anche il resto del confronto sarebbe una decisione dell'utente presa al posto
 * suo (`closePane`, che è un gesto deliberato, collassa invece a un pannello).
 */
export function chiudiPaneDove(pred, st) {
  const { t, lista } = areeDi(st);
  if (!t) return;

  for (const a of lista) {
    const daChiudere = [...a.panes.values()].filter(
      (p) => p.tabId === t.id && pred({ db: p.db, coll: p.coll })
    );
    if (!daChiudere.length) continue;

    for (const p of daChiudere) {
      disposePane(p);
      a.panes.delete(p.id);
      a.elementi.delete(p.id);
      if (a.maximizedPaneId === p.id) a.maximizedPaneId = null;
      a.layout = rimuovi(a.layout, p.id);
    }

    if (!a.panes.size) {
      closeSplitView({ collTabId: a.collTabId });
      continue;
    }
    a.layout = valida(a.layout, new Set(a.panes.keys()));
    if (!a.panes.has(a.focusedPaneId)) a.focusedPaneId = [...a.panes.keys()][0];
    aggiornaEtichettaCollTab(a);
    if (areaAttiva() === a) renderSplitView();
  }
  import('./colltabs.js').then((m) => m.renderCollTabBar());
}

/**
 * Applica una modifica ai pannelli (rinomina di database o collection), con la
 * stessa firma di `updateCollTabs`: la funzione riceve l'oggetto e ne cambia
 * `db`/`coll` in posto.
 */
export function aggiornaPaneDove(fn, st) {
  const { t, lista } = areeDi(st);
  if (!t) return;

  let toccati = false;
  for (const a of lista) {
    let cambiata = false;
    for (const p of a.panes.values()) {
      if (p.tabId !== t.id) continue;
      const prima = `${p.db}${p.coll}`;
      fn(p);
      if (`${p.db}${p.coll}` !== prima) {
        p.query = p.runtime?.snapshot() || p.query;
        p.data = p.runtime?.dataSnapshot() || null;
        disposePane(p); p.runtime = null;
        a.elementi.delete(p.id);
        cambiata = true;
      }
    }
    if (!cambiata) continue;
    toccati = true;
    // La testata mostra database e tabella con due select popolate dal vecchio
    // elenco: vanno ricostruite, non aggiornate.
    cacheCollections.clear();
    aggiornaEtichettaCollTab(a);
    if (areaAttiva() === a) renderSplitView();
  }
  if (toccati) import('./colltabs.js').then((m) => m.renderCollTabBar());
}

/* --------------------- comandi sui pannelli (layout) ---------------------- */

/**
 * Un pannello a tutta area, e ritorno. Non tocca l'albero: è una vista
 * temporanea, e uscendo si deve ritrovare il layout esattamente com'era.
 */
export function massimizzaPane(paneId) {
  const a = areaDiPane(paneId);
  if (!a) return;
  a.maximizedPaneId = a.maximizedPaneId === paneId ? null : paneId;
  if (a.maximizedPaneId) setFocusedPane(paneId);
  applicaMassimizzato();
}

function applicaMassimizzato() {
  const container = $('#workspace .split-container');
  const a = areaAttiva();
  if (!container || !a) return;
  const max = a.maximizedPaneId;
  container.classList.toggle('has-maximized', !!max);
  document.querySelectorAll('.split-pane').forEach((el) => {
    el.classList.toggle('maximized', !!max && el.dataset.paneId === max);
    const button = el.querySelector('.pane-maximize-btn');
    button?.setAttribute('aria-label', el.classList.contains('maximized') ? 'Ripristina il layout' : 'Espandi il pannello');
    if (button) button.innerHTML = ICO(el.classList.contains('maximized') ? 'minimize-2' : 'maximize-2');
  });
  refreshLucideIcons(container);
}

/**
 * Quote uguali: su tutta l'area, o sul solo contenitore di un pannello.
 * `collTabId` serve quando il comando arriva dal menu di un'area che NON è
 * quella a schermo (il tasto destro su un altro coll-tab affiancato).
 */
export function pareggiaPannelli(paneId, collTabId) {
  const a = paneId ? areaDiPane(paneId) : (collTabId ? aree.get(collTabId) : areaAttiva());
  if (!a || !a.layout) return;
  a.layout = pareggiaAlbero(a.layout, paneId);
  if (a === areaAttiva()) applicaDimensioni();
}

export function scambiaConVicino(paneId, verso) {
  const a = areaDiPane(paneId);
  if (!a) return;
  const altro = vicinoDi(a.layout, paneId, verso);
  if (!altro) {
    toast(verso === 'prev' ? 'Nessun pannello prima di questo' : 'Nessun pannello dopo questo', true);
    return;
  }
  a.layout = scambia(a.layout, paneId, altro);
  aggiornaEtichettaCollTab(a);
  renderSplitView();
}

/** Affiancati ↔ impilati, sul solo contenitore che ospita il pannello. */
export function ruotaOrientamento(paneId) {
  const a = areaDiPane(paneId);
  if (!a) return;
  const cont = contenitoreDi(a.layout, paneId);
  if (!cont) {
    toast('Questo pannello non è affiancato ad altri', true);
    return;
  }
  a.layout = ruotaAlbero(a.layout, paneId);
  renderSplitView();
}

export async function chiudiAltriPane(paneId) {
  const a = areaDiPane(paneId);
  if (!a) return;
  const altri = elencoPane(a.layout).filter((id) => id !== paneId);
  if (!altri.length) return;
  if (!await chiediConferma(`Chiudere gli altri ${altri.length} ${altri.length === 1 ? 'pannello' : 'pannelli'}?`)) return;
  for (const id of altri) if (!await confermaChiusuraPane(a.panes.get(id))) return;
  altri.forEach(id => {
    disposePane(a.panes.get(id));
    a.panes.delete(id); a.elementi.delete(id); a.layout = rimuovi(a.layout, id);
  });
  a.focusedPaneId = paneId;
  a.maximizedPaneId = null;
  aggiornaEtichettaCollTab(a);
  renderSplitView();
  import('./colltabs.js').then(m => m.renderCollTabBar());
}

/** Su mobile torna a una scheda singola, conservando le aree per il desktop. */
export function notificaCambioLarghezza() {
  hideDropPreview();
  hideContextMenu();
  if (!splitDisponibile()) {
    if (areaAttiva()) import('./workspace.js').then(m => { if (areaAttiva()) m.renderWorkspace(); });
    return;
  }
  const a = areaAttiva();
  if (!a || !a.active) return;
  a.maximizedPaneId = null;
  applicaMassimizzato();
  applicaDimensioni();
}

/**
 * Chiude la vista affiancata.
 *
 * `riapri` distingue i due modi di arrivarci: uscendo dalla Split-View (o
 * chiudendo il penultimo pannello) si vuole continuare a lavorare sulla tabella
 * che si aveva davanti, quindi il pannello a fuoco riapre come coll-tab
 * normale; chiudendo con la ✕ il tab dell'area affiancata si vuole invece che
 * sparisca, e riaprire qualcosa sembrerebbe un tab che non si lascia chiudere.
 */
export async function closeSplitView({ riapri = false, collTabId = null } = {}) {
  const a = collTabId ? aree.get(collTabId) : areaAttiva();
  if (!a) return;
  if ([...a.panes.values()].some(p => p.runtime?.writing())) { toast('Salvataggio in corso: attendi l’esito prima di chiudere l’area.', true); return; }
  if ([...a.panes.values()].some(p => (p.runtime ? p.runtime.dirty() : p.query?.dirty))
      && !await chiediConferma('Chiudere l’area e scartare il testo non salvato dei suoi pannelli?')) return;
  for (const p of a.panes.values()) disposePane(p);

  const superstite = a.panes.get(a.focusedPaneId) || Array.from(a.panes.values())[0] || null;
  const daRiaprire = riapri && superstite && superstite.tabId === activeTab()?.id && superstite.db && superstite.coll
    ? { db: superstite.db, coll: superstite.coll }
    : null;

  // Il coll-tab dell'area può stare in un tab di connessione diverso da quello
  // attivo (chiusura di un tab, ripristino): si cerca dove è davvero, e si
  // ricorda la SUA posizione — serve a scegliere dove atterrare.
  let t = null;
  let posizione = -1;
  for (const tt of tabs.list) {
    const idx = tt.state.collTabs.findIndex((c) => c.id === a.collTabId);
    if (idx >= 0) { t = tt; posizione = idx; tt.state.collTabs.splice(idx, 1); break; }
  }
  const eraAttiva = !!(t && t.state.activeCollId === a.collTabId);

  aree.delete(a.collTabId);
  if (!aree.size) cacheCollections.clear();

  // Chiudere un'area che si stava GUARDANDO e chiuderne una in secondo piano
  // sono due cose diverse: nel secondo caso non deve succedere assolutamente
  // nulla a schermo. Prima si atterrava comunque sull'ultimo coll-tab, cioè
  // chiudere la ✕ di un tab affiancato che non stavi guardando ti spostava
  // altrove — e se quell'ultimo tab era un'altra area, ti ritrovavi davanti
  // pannelli che non avevi chiesto.
  if (!eraAttiva) {
    if (!areaAttiva()) deactivateSplitView();
    import('./colltabs.js').then((m) => m.renderCollTabBar());
    return;
  }

  t.state.activeCollId = null;
  deactivateSplitView();

  if (daRiaprire) {
    import('./colltabs.js').then((m) => m.openCollTab(daRiaprire.db, daRiaprire.coll));
    return;
  }

  // Il VICINO, non l'ultimo della barra: è la stessa regola dei coll-tab
  // normali (`closeCollTab`), e chiudendo un tab ci si aspetta di restare lì
  // vicino invece di essere spediti in fondo.
  const lista = t.state.collTabs;
  const prossimo = lista[posizione] || lista[posizione - 1] || null;
  if (prossimo) {
    import('./colltabs.js').then((m) => m.switchCollTab(prossimo.id));
  } else {
    state.db = null;
    state.coll = null;
    import('./workspace.js').then((m) => m.renderWorkspace());
  }
}

/** Esegue la query di un pannello. Restituisce la promessa, così i pulsanti che
 *  la avviano possono restare in attesa con `conCaricamento`. */
export async function runPaneQuery(paneId, opts = {}) {
  const p = paneById(paneId);
  if (!p) return;
  if (!p.runtime) setPaneView(paneId, p.view || 'data');
  await p.runtime?.refresh(opts);
}

function emitPaneQuery(tabId, event, payload) {
  // Il tabId va scritto DOPO lo spread, non prima: davanti, qualunque `tabId`
  // nel payload — anche un `undefined` esplicito — lo sovrascriverebbe, e da
  // qui passano anche doc:update e doc:delete, cioè delle scritture. È lo
  // stesso ordine, e la stessa ragione, della emit() di utils.js.
  const msg = { ...(payload || {}) };
  msg.tabId = tabId;
  return emit(event, msg);
}

export function renderSplitView() {
  if (!splitDisponibile()) {
    deactivateSplitView();
    if (areaAttiva()) import('./workspace.js').then(m => { if (areaAttiva()) m.renderWorkspace(); });
    return;
  }
  const ws = $('#workspace');
  if (!ws) return;
  // Si disegna SEMPRE l'area del coll-tab attivo: con più aree aperte "la
  // Split-View" non è più una sola, ed è il coll-tab a dire quale.
  const a = areaAttiva();
  if (!a) { deactivateSplitView(); return; }

  // I nodi del workspace restano dove sono: li nasconde il CSS. Vedi
  // `deactivateSplitView` per il perché.
  ws.classList.add('split-active', 'split-mostra-pannelli');
  state.view = 'split';
  document.querySelectorAll('.view-tab').forEach(button => {
    const view = button.dataset.view;
    button.classList.toggle('hidden', view !== 'split');
    button.classList.toggle('active', view === 'split');
    button.setAttribute('aria-pressed', String(view === 'split'));
  });
  $('#placeholder')?.classList.add('hidden');
  ws.classList.remove('hidden');
  conservaPannelliMontati();
  ws.querySelector('.split-container')?.remove();

  // NESSUNA barra d'intestazione per l'area.
  //
  // Ne esisteva una con nome, conteggio dei pannelli e quattro pulsanti, ed era
  // spazio permanente per informazioni che il resto dell'interfaccia dà già e
  // per comandi che si usano una volta ogni tanto: il nome è scritto sul
  // coll-tab (che qui fa da breadcrumb, come per le collection normali), i
  // pannelli si contano guardandoli, "Chiudi" ripeteva la ✕ del tab e
  // "Pareggia" ripeteva il doppio clic sul separatore. Rinomina, pareggia,
  // confronta e chiudi vivono ora nel menu ⋯ di ogni pannello (sezione "Area
  // affiancata") e nel menu contestuale del tab: due posti che si raggiungono
  // da dove si sta già guardando, senza rubare una riga ai dati.
  const container = document.createElement('div');
  container.className = 'split-container';
  container.style.setProperty('--pane-count', a.panes.size);
  ws.appendChild(container);

  if (a.layout) {
    container.appendChild(renderLayoutNode(a.layout, [], a));
  }

  // I nodi dei pannelli non più nell'albero (chiusi, sostituiti) non devono
  // restare in cache a tenere in vita gestori e riferimenti.
  const vivi = new Set(elencoPane(a.layout));
  for (const id of [...a.elementi.keys()]) {
    if (!vivi.has(id)) a.elementi.delete(id);
  }

  // Una sola connessione fra tutti i pannelli: il suo nome sparisce dalle
  // testate (vedi il CSS di `.una-connessione`).
  const connessioni = new Set([...a.panes.values()].map((p) => p.tabId));
  container.classList.toggle('una-connessione', connessioni.size <= 1);

  applicaMassimizzato();

  const focus = a.focusedPaneId;
  a.panes.forEach((p, pId) => {
    setPaneView(pId, p.view || 'data');
  });
  setFocusedPane(focus);
}

export function chiediNomeAreaSplit(collTabId) {
  const a = aree.get(collTabId);
  if (!a) return;
  chiediTesto({
    titolo: 'Rinomina area affiancata',
    sottotitolo: 'Lascia vuoto per tornare al nome automatico (le tabelle che contiene).',
    etichetta: 'Nome',
    valore: a.nome || '',
    ok: 'Rinomina',
  }).then((nome) => {
    if (nome === null) return; // annullato
    rinominaArea(collTabId, nome);
  });
}

function renderLayoutNode(node, percorso = [], area = null) {
  const a = area || areaAttiva();
  if (node.type === 'pane') {
    const suo = areaDiPane(node.paneId);
    return (suo && suo.elementi.get(node.paneId)) || createPaneElement(node.paneId);
  }

  const el = document.createElement('div');
  el.className = node.type === 'row' ? 'split-layout-row' : 'split-layout-col';
  el.dataset.orientamento = node.type;

  const sizes = dimensioniNormalizzate(node);

  node.children.forEach((child, idx) => {
    if (idx > 0) {
      el.appendChild(creaResizer(a, percorso, idx - 1, el));
    }
    const figlio = renderLayoutNode(child, percorso.concat(idx), a);
    // La quota vive nell'albero e viene tradotta qui in `flex-grow`: scrivere
    // `width`/`height` non avrebbe alcun effetto, perché i figli sono flex e il
    // grow vince sulla dimensione dichiarata — era esattamente il motivo per cui
    // i separatori non ridimensionavano nulla.
    figlio.style.flex = `${sizes[idx]} 1 0%`;
    el.appendChild(figlio);
  });

  return el;
}

/** Riapplica le quote dell'albero al DOM già montato: nessuna ricostruzione,
 *  quindi scorrimento, celle in modifica e selezioni restano dove sono. */
function applicaDimensioni() {
  const container = $('#workspace .split-container');
  const a = areaAttiva();
  if (!container || !a || !a.layout) return;

  const visita = (node, el) => {
    if (!node || node.type === 'pane' || !el) return;
    const sizes = dimensioniNormalizzate(node);
    const figli = [...el.children].filter((c) => !c.classList.contains('split-resizer-v') && !c.classList.contains('split-resizer-h'));
    node.children.forEach((child, i) => {
      const figlio = figli[i];
      if (!figlio) return;
      figlio.style.flex = `${sizes[i]} 1 0%`;
      visita(child, figlio);
    });
    aggiornaValoriResizer(el, sizes);
  };
  visita(a.layout, container.firstElementChild);
}

function aggiornaValoriResizer(el, sizes) {
  const resizers = [...el.children].filter((c) => c.classList.contains('split-resizer-v') || c.classList.contains('split-resizer-h'));
  let acc = 0;
  resizers.forEach((r, i) => {
    acc += sizes[i];
    r.setAttribute('aria-valuenow', String(Math.round(acc * 100)));
  });
}

function createPaneElement(paneId) {
  const p = paneById(paneId);
  const connTab = tabs.list.find((t) => t.id === p.tabId);
  const connLabel = connTab ? connTab.label : 'Connessione';
  const dbType = connTab ? connTab.dbType : 'mongodb';
  const isSql = isSqlType(dbType);

  const paneEl = document.createElement('div');
  paneEl.className = 'split-pane' + (paneId === getFocusedPaneId() ? ' focused' : '');
  paneEl.dataset.paneId = paneId;
  // Il pannello a fuoco decide dove agiscono le scorciatoie e le tab vista:
  // senza `tabindex` non sarebbe raggiungibile né visibile a chi naviga da
  // tastiera, e `.focused` resterebbe un colore di bordo e basta.
  paneEl.setAttribute('tabindex', '0');
  paneEl.setAttribute('role', 'region');
  paneEl.setAttribute('aria-label', `Pannello: ${p.db} ▸ ${p.coll}`);

  paneEl.addEventListener('pointerdown', () => setFocusedPane(paneId));
  paneEl.addEventListener('focusin', () => setFocusedPane(paneId));

  paneEl.innerHTML = `
    <div class="split-pane-head">
      <div class="split-pane-identity">
        <span class="db-icon">${dbTypeIcon(dbType)}</span>
        <span class="conn-name" title="${esc(connLabel)}">${esc(connLabel)}</span>
      </div>
      <div class="split-pane-title">
        <select class="pane-db-select" title="${dbType === 'postgresql' ? 'Schema PostgreSQL' : 'Database'}" aria-label="${dbType === 'postgresql' ? 'Schema' : 'Database'} del pannello"></select>
        <span class="sep">/</span>
        <select class="pane-coll-select" title="Seleziona Tabella/Collezione" aria-label="${isSql ? 'Tabella del pannello' : 'Collection del pannello'}"></select>
      </div>
      <div class="split-pane-tools">
        <button type="button" class="pane-maximize-btn ghost" title="Espandi il pannello (Alt+M)" aria-label="Espandi il pannello"><i data-lucide="maximize-2"></i></button>
        <button type="button" class="pane-menu-btn ghost" title="Azioni su pannello e area affiancata" aria-label="Azioni su pannello e area affiancata" aria-haspopup="true"><i data-lucide="ellipsis"></i></button>
        <button type="button" class="pane-close-btn ghost" title="Chiudi pannello" aria-label="Chiudi il pannello"><i data-lucide="x"></i></button>
      </div>
    </div>

    <div class="pane-viewbar">
      <button type="button" class="ghost" data-pane-view="data" aria-pressed="true"><i data-lucide="table"></i> Dati</button>
      <button type="button" class="ghost" data-pane-view="query" aria-pressed="false"><i data-lucide="code"></i> Query</button>
      <button type="button" class="ghost" data-pane-view="details" aria-pressed="false"><i data-lucide="info"></i> Dettagli</button>
      <button type="button" class="ghost pane-visualize-btn" aria-haspopup="true"><i data-lucide="network"></i> <span>Visualizza</span><i data-lucide="chevron-down"></i></button>
    </div>
    <div class="pane-surface-slot"></div>

  `;

  mountArcControls(paneEl);
  paneEl.querySelectorAll('[data-pane-view]').forEach(button => {
    button.addEventListener('click', () => setPaneView(paneId, button.dataset.paneView));
    if (!p.coll && ['data', 'details'].includes(button.dataset.paneView)) button.hidden = true;
  });
  const dbSelect = paneEl.querySelector('.pane-db-select');
  const collSelect = paneEl.querySelector('.pane-coll-select');

  const databases = (connTab?.state.databases || []).map(db => db.name);
  if (!databases.includes(p.db)) databases.unshift(p.db);
  dbSelect.innerHTML = databases.map(db => `<option value="${esc(db)}" ${db === p.db ? 'selected' : ''}>${esc(db)}</option>`).join('');
  popolaSelectColl(collSelect, [], p.coll);

  dbSelect.addEventListener('change', async () => {
    if (!await confermaChiusuraPane(p)) { dbSelect.value = p.db; return; }
    disposePane(p); p.runtime = null; p.query = null; p.data = null;
    p.filter = ''; p.sort = ''; p.quickSearch = ''; p.advancedCondition = '';
    const generazione = (p.generazioneRichiesta = (p.generazioneRichiesta || 0) + 1);
    const dbRichiesto = dbSelect.value;
    p.db = dbRichiesto;
    p.coll = null;
    p.skip = 0;
    p.docs = [];
    p.columns = [];
    p.total = 0;
    p.caricato = false;
    cacheCollections.delete(`${p.tabId}|${p.db}`);
    fetchCollectionsForPane(paneId, dbRichiesto).then((colls) => {
      if (paneById(paneId) !== p || !contestoCorrente(p, {
        generazioneRichiesta: generazione, db: dbRichiesto,
      })) return;
      popolaSelectColl(collSelect, colls, null);
      if (colls.length > 0) {
        p.coll = colls[0];
        aggiornaEtichettaPane(paneEl, p);
      }
      setPaneView(paneId, p.coll ? (p.view || 'data') : 'query');
    });
  });

  const dbIniziale = p.db;
  const collIniziale = p.coll;
  fetchCollectionsForPane(paneId, dbIniziale).then((colls) => {
    if (paneById(paneId) !== p || p.db !== dbIniziale || p.coll !== collIniziale) return;
    popolaSelectColl(collSelect, colls, collIniziale);
  });

  collSelect.addEventListener('change', async () => {
    if (!await confermaChiusuraPane(p)) { collSelect.value = p.coll; return; }
    disposePane(p); p.runtime = null; p.query = null; p.data = null;
    p.filter = ''; p.sort = ''; p.quickSearch = ''; p.advancedCondition = '';
    p.generazioneRichiesta = (p.generazioneRichiesta || 0) + 1;
    p.coll = collSelect.value;
    p.skip = 0;
    p.docs = [];
    p.columns = [];
    p.total = 0;
    p.caricato = false;
    aggiornaEtichettaPane(paneEl, p);
    setPaneView(paneId, p.view || 'data');
  });

  paneEl.querySelector('.pane-maximize-btn').addEventListener('click', () => massimizzaPane(paneId));
  paneEl.querySelector('.pane-visualize-btn').addEventListener('click', e => {
    const rect = e.currentTarget.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom, [
      { icona: 'network', label: 'Diagramma UML', action: () => setPaneView(paneId, 'uml') },
      { icona: 'boxes', label: 'Grafo 3D', action: () => setPaneView(paneId, 'graph3d') },
    ]);
  });
  paneEl.querySelector('.pane-close-btn').addEventListener('click', () => closePane(paneId), () => aggiornaContestoPane(paneId));
  // Massimizza: doppio clic sulla testata invece di un quarto pulsante. È il
  // gesto delle finestre di ogni sistema operativo, non toglie spazio ai nomi
  // di database e tabella (che su un pannello stretto sono la prima cosa a
  // sparire) ed è comunque scritto nel menu ⋯ per chi non lo prova.
  paneEl.querySelector('.split-pane-head').addEventListener('dblclick', (e) => {
    if (e.target.closest('button, select, input')) return;
    massimizzaPane(paneId);
  });
  paneEl.querySelector('.pane-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    setFocusedPane(paneId);
    const r = e.currentTarget.getBoundingClientRect();
    apriMenuPane(paneId, r.left, r.bottom + 4);
  });
  refreshLucideIcons(paneEl);
  areaDiPane(paneId)?.elementi.set(paneId, paneEl);
  return paneEl;
}

/** Voci del menu ⋯ di un pannello. Stanno in un menu e non in altrettanti
 *  pulsanti perché la testata è già stretta, ed è la prima cosa che si rompe
 *  sulle finestre piccole. */
function apriMenuPane(paneId, x, y) {
  const a = areaDiPane(paneId);
  if (!a) return;
  const cont = contenitoreDi(a.layout, paneId);
  const impilato = cont && cont.nodo.type === 'col';
  const altri = elencoPane(a.layout).length - 1;
  const massimizzato = a.maximizedPaneId === paneId;

  const voci = [
    ...['details', 'uml', 'graph3d'].map((view, i) => ({ icona: ['info', 'network', 'boxes'][i], label: ['Dettagli', 'Diagramma UML', 'Grafo 3D'][i], action: () => setPaneView(paneId, view) })),
    '---',
    { icona: massimizzato ? 'minimize-2' : 'maximize-2', label: massimizzato ? 'Ripristina il layout' : 'Massimizza questo pannello (doppio clic sul titolo)', action: () => massimizzaPane(paneId) },
    { label: '⌗ Pareggia questo gruppo', action: () => pareggiaPannelli(paneId) },
    { icona: 'arrow-left-right', label: 'Scambia con il precedente', action: () => scambiaConVicino(paneId, 'prev') },
    { icona: 'arrow-left-right', label: 'Scambia con il successivo', action: () => scambiaConVicino(paneId, 'next') },
    { label: impilato ? '▤ Disponi affiancati' : '▥ Disponi impilati', action: () => ruotaOrientamento(paneId) },
  ];
  if (altri > 0) {
    voci.push({ icona: 'x', label: `Chiudi gli altri ${altri} ${altri === 1 ? 'pannello' : 'pannelli'}`, action: () => chiudiAltriPane(paneId), danger: true });
  }
  voci.push({ icona: 'x', label: 'Chiudi questo pannello', action: () => closePane(paneId), danger: true });

  // Comandi dell'AREA, non del pannello: stanno qui in fondo perché è il punto
  // che si raggiunge da dove si sta guardando, e perché tenerli in una barra
  // sempre presente costava una riga di schermo per un uso occasionale.
  voci.push('---');
  voci.push({ icona: 'pencil', label: `Rinomina l'area…`, action: () => chiediNomeAreaSplit(a.collTabId) });
  voci.push({ label: '⌗ Pareggia tutta l\'area', action: () => pareggiaPannelli(null, a.collTabId) });
  if (altri > 0) {
    voci.push({ icona: 'git-compare', label: 'Confronta gli schemi dei primi due', action: () => comparePaneSchemas() });
  }
  voci.push({ icona: 'x', label: 'Chiudi l\'area affiancata', action: () => closeSplitView({ riapri: true, collTabId: a.collTabId }), danger: true });

  showContextMenu(x, y, voci);
}

/** L'etichetta accessibile del pannello segue database e tabella: è ciò che un
 *  lettore di schermo annuncia entrando nella regione. */
function aggiornaEtichettaPane(paneEl, p) {
  paneEl.setAttribute('aria-label', `Pannello: ${p.db} ▸ ${p.coll}`);
}

function popolaSelectColl(select, colls, selezionata) {
  // Il bersaglio resta leggibile anche mentre il catalogo si carica o fallisce.
  if (selezionata && !colls.includes(selezionata)) colls = [selezionata, ...colls];
  // Si riscrive solo se la lista è davvero cambiata: un `innerHTML` a ogni giro
  // chiuderebbe il menu aperto sotto le dita dell'utente e perderebbe la
  // selezione in corso.
  const firma = colls.join('\u0000');
  if (select.dataset.firma === firma) {
    if (selezionata != null) select.value = selezionata;
    return;
  }
  select.dataset.firma = firma;
  select.innerHTML = colls
    .map((c) => `<option value="${esc(c)}" ${c === selezionata ? 'selected' : ''}>${esc(c)}</option>`)
    .join('');
}

/**
 * Elenco delle collection di un database, con la PROMESSA in cache per
 * (connessione, database): due pannelli sullo stesso database facevano due
 * richieste identiche, e ne partiva una per pannello a ogni rimontaggio del
 * layout.
 */
function fetchCollectionsForPane(paneId, dbName) {
  const p = paneById(paneId);
  if (!p) return Promise.resolve([]);
  const chiave = `${p.tabId}|${dbName}`;
  if (cacheCollections.has(chiave)) return cacheCollections.get(chiave);

  const pr = emitPaneQuery(p.tabId, 'db:collections', { db: dbName, includeCounts: false })
    .then((res) => (res.collections || []).map((c) => (typeof c === 'string' ? c : c.name)))
    .catch(() => {
      // Un errore non va memorizzato: al prossimo tentativo si richiede.
      cacheCollections.delete(chiave);
      return [];
    });
  cacheCollections.set(chiave, pr);
  return pr;
}

/**
 * Separatore fra il figlio `indice` e il successivo.
 *
 * Tre scelte non ovvie:
 *
 * 1. **Pointer Events** invece di `mousedown`/`mousemove`: coprono mouse, touch
 *    e penna con un solo percorso, e `setPointerCapture` fa arrivare gli eventi
 *    al separatore anche quando il puntatore esce dalla finestra — senza, un
 *    trascinamento veloce si "perdeva" e il pannello restava a metà.
 * 2. **Nessun re-render durante il trascinamento**: si scrive la quota
 *    nell'albero e si aggiorna il solo `style.flex` dei due vicini. Rimontare il
 *    layout a ogni `pointermove` significherebbe ricostruire due tabelle di
 *    dati per fotogramma.
 * 3. **Accessibile da tastiera**: è un `separator` con `aria-valuenow`, quindi
 *    il rapporto fra i pannelli si legge e si cambia senza mouse — che è anche
 *    l'unico modo di ridimensionare per chi non può trascinare.
 */
function creaResizer(area, percorso, indice, contenitoreEl) {
  // Il nodo si risolve dal percorso a ogni uso, mai catturato: le operazioni
  // sull'albero sono immutabili e lo sostituiscono, quindi un riferimento preso
  // qui diventerebbe un ramo staccato — il separatore smetterebbe di funzionare
  // dopo un "pareggia" senza dare alcun segno. L'AREA invece è stabile (cambia
  // il suo `layout`, non lei), quindi può stare nella chiusura.
  const vivo = () => nodoAlPercorso(area.layout, percorso);
  const nodo = vivo() || { type: 'row', children: [], sizes: [] };

  const r = document.createElement('div');
  r.className = nodo.type === 'row' ? 'split-resizer-v' : 'split-resizer-h';
  r.setAttribute('role', 'separator');
  r.setAttribute('tabindex', '0');
  r.setAttribute('aria-orientation', nodo.type === 'row' ? 'vertical' : 'horizontal');
  r.setAttribute('aria-label', 'Ridimensiona i pannelli');
  r.setAttribute('aria-valuemin', '0');
  r.setAttribute('aria-valuemax', '100');

  // L'asse segue la disposizione corrente anche dopo una rotazione dell'area.
  const orizz = () => getComputedStyle(contenitoreEl).flexDirection === 'row';

  const minPx = () => (orizz() ? MIN_PANE_LARGHEZZA : MIN_PANE_ALTEZZA);

  const disponibili = () => {
    const n = vivo();
    const orizzontale = orizz();
    const rect = contenitoreEl.getBoundingClientRect();
    const lato = orizzontale ? rect.width : rect.height;
    // Lo spazio dei separatori non è distribuibile: contarlo farebbe derivare la
    // conversione pixel→quota a ogni trascinamento.
    const nRes = Math.max(0, ((n && n.children) || []).length - 1);
    const spessore = orizzontale ? r.getBoundingClientRect().width : r.getBoundingClientRect().height;
    return Math.max(1, lato - nRes * (spessore || 6));
  };

  const applica = (nuove) => {
    const n = vivo();
    if (n) n.sizes = nuove;
    const figli = [...contenitoreEl.children].filter((c) => !c.classList.contains('split-resizer-v') && !c.classList.contains('split-resizer-h'));
    if (figli[indice]) figli[indice].style.flex = `${nuove[indice]} 1 0%`;
    if (figli[indice + 1]) figli[indice + 1].style.flex = `${nuove[indice + 1]} 1 0%`;
    aggiornaValoriResizer(contenitoreEl, nuove);
  };

  const quote = () => dimensioniNormalizzate(vivo());

  const pareggiaQui = () => {
    const n = vivo();
    if (n) n.sizes = null;
    applica(quote());
  };

  let partenza = 0;
  let sizesIniziali = null;

  r.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    partenza = orizz() ? e.clientX : e.clientY;
    sizesIniziali = quote();
    r.setPointerCapture(e.pointerId);
    r.classList.add('dragging');
    document.body.classList.add('split-resizing');
  });

  r.addEventListener('pointermove', (e) => {
    if (!sizesIniziali) return;
    const delta = (orizz() ? e.clientX : e.clientY) - partenza;
    applica(trascina(sizesIniziali, indice, delta, disponibili(), minPx()));
  });

  const fine = (e) => {
    if (!sizesIniziali) return;
    sizesIniziali = null;
    r.classList.remove('dragging');
    document.body.classList.remove('split-resizing');
    try { r.releasePointerCapture(e.pointerId); } catch { /* già rilasciato */ }
  };
  r.addEventListener('pointerup', fine);
  r.addEventListener('pointercancel', fine);

  // Doppio clic sul separatore: i due (o più) pannelli di QUESTO gruppo tornano
  // uguali. È il gesto che si prova per primo davanti a un pannello schiacciato.
  r.addEventListener('dblclick', pareggiaQui);

  r.addEventListener('keydown', (e) => {
    const passo = 0.02;
    const attuali = quote();
    if (attuali.length < 2) return;
    const coppia = attuali[indice] + attuali[indice + 1];
    let quota = null;
    const avanti = orizz() ? 'ArrowRight' : 'ArrowDown';
    const indietro = orizz() ? 'ArrowLeft' : 'ArrowUp';

    if (e.key === avanti) quota = attuali[indice] + passo;
    else if (e.key === indietro) quota = attuali[indice] - passo;
    else if (e.key === 'Home') quota = 0;
    else if (e.key === 'End') quota = coppia;
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pareggiaQui(); return; }
    else return;

    e.preventDefault();
    // Si passa comunque da `trascina`, che è dove vivono il clamp e il minimo:
    // due percorsi di calcolo diversi divergerebbero al primo caso limite.
    const disp = disponibili();
    applica(trascina(attuali, indice, (quota - attuali[indice]) * disp, disp, minPx()));
  });

  return r;
}

function comparePaneSchemas() {
  const a = areaAttiva();
  // Nell'ordine in cui si vedono, non in quello di creazione: "i primi due
  // pannelli" deve voler dire i due a sinistra, altrimenti il confronto riguarda
  // due riquadri scelti a caso.
  const panes = a ? elencoPane(a.layout).map((id) => a.panes.get(id)).filter(Boolean) : [];
  if (panes.length < 2) {
    toast('Apri almeno due pannelli per confrontarne gli schemi.', true);
    return;
  }

  const p1 = panes[0];
  const p2 = panes[1];

  const d1 = p1.runtime?.dataSnapshot() || p1;
  const d2 = p2.runtime?.dataSnapshot() || p2;
  const cols1 = colonneRisultato(d1.columns, d1.docs);
  const cols2 = colonneRisultato(d2.columns, d2.docs);

  const set1 = new Set(cols1);
  const set2 = new Set(cols2);

  const common = cols1.filter((c) => set2.has(c));
  const onlyP1 = cols1.filter((c) => !set2.has(c));
  const onlyP2 = cols2.filter((c) => !set1.has(c));

  let modal = $('#compare-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'compare-modal';
    modal.className = 'overlay';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div class="modal compare-dialog">
      <h2><i data-lucide="git-compare"></i> Confronto Schema Tabelle</h2>
      <p class="subtitle">Confronto dei campi tra <b>${esc(p1.db)} ▸ ${esc(p1.coll)}</b> e <b>${esc(p2.db)} ▸ ${esc(p2.coll)}</b></p>
      
      <div class="compare-stats">
        <div class="stat-card common">
          <div class="stat-num">${common.length}</div>
          <div class="stat-lbl">Campi In Comune</div>
        </div>
        <div class="stat-card p1">
          <div class="stat-num">${onlyP1.length}</div>
          <div class="stat-lbl">Solo in ${esc(p1.coll)}</div>
        </div>
        <div class="stat-card p2">
          <div class="stat-num">${onlyP2.length}</div>
          <div class="stat-lbl">Solo in ${esc(p2.coll)}</div>
        </div>
      </div>

      <div class="compare-tables">
        <h3>Campi in Comune (${common.length})</h3>
        <ul class="field-list common-list">
          ${common.map((f) => `<li><span class="badge match">✓</span> ${esc(f)}</li>`).join('') || '<li>Nessun campo in comune</li>'}
        </ul>

        <div class="diff-flex">
          <div class="diff-col">
            <h3>Solo in ${esc(p1.coll)} (${onlyP1.length})</h3>
            <ul class="field-list p1-list">
              ${onlyP1.map((f) => `<li><span class="badge diff">−</span> ${esc(f)}</li>`).join('') || '<li>Nessun campo esclusivo</li>'}
            </ul>
          </div>

          <div class="diff-col">
            <h3>Solo in ${esc(p2.coll)} (${onlyP2.length})</h3>
            <ul class="field-list p2-list">
              ${onlyP2.map((f) => `<li><span class="badge diff">+</span> ${esc(f)}</li>`).join('') || '<li>Nessun campo esclusivo</li>'}
            </ul>
          </div>
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="primary close-compare-btn">Chiudi</button>
      </div>
    </div>
  `;

  // Da openModal e non da `classList`: così Esc la chiude come ogni altra
  // modale dell'applicazione, invece di essere l'unica che resta aperta.
  mountArcControls(modal);
  openModal(modal);
  modal.querySelector('.close-compare-btn').addEventListener('click', () => closeModal(modal));
}
