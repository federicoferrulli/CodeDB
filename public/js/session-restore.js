'use strict';

// Persistenza della sessione tra i ricaricamenti della pagina (F5) e le
// riconnessioni a caldo del socket. Il layout dei tab (connessione, database e
// collection selezionati, vista, input di query) viene salvato in
// sessionStorage — che sopravvive al refresh ma si azzera alla chiusura del tab
// del browser — e ripristinato quando il socket torna disponibile.
//
// Vincolo di sicurezza: si riconnettono solo le connessioni SALVATE (per nome,
// via `mongo:connect { saved }`); le credenziali restano sul server e non
// transitano mai dal browser. Le connessioni non salvate non sono ripristinabili
// e vengono segnalate.

import { socket } from './socket.js';
import { tabs, createTab } from './tabs.js';
import { state } from './state.js';
import { $, toast, safeUUID } from './utils.js';
import { renderTabBar } from './tabbar.js';
import { renderWorkspace } from './workspace.js';
import { ensureActiveCollLoaded } from './colltabs.js';
import { getSplitStateSnapshot, restoreSplitStateSnapshot } from './splitview.js';

const KEY = 'codedb:session';

// Input correnti di un coll-tab: dal DOM se è quello attivo del tab attivo
// (mentre è attivo la verità è il DOM), altrimenti dal suo snapshot salvato.
function collTabInputs(t, c) {
  if (c.isSplitTab) {
    return {
      id: c.id,
      isSplitTab: true,
      db: 'Split-View',
      coll: '🔲 Area Split-View',
      splitSnap: getSplitStateSnapshot() || c.splitSnap || null,
    };
  }

  // Tab a livello database (database senza collection): non ha input di griglia
  // né snapshot, basta sapere su quale database era aperto.
  if (c.isDbTab) return { id: c.id, isDbTab: true, db: c.db, coll: null, view: 'query' };

  const activeNow = t.id === tabs.activeId && c.id === t.state.activeCollId;
  if (activeNow) {
    return {
      id: c.id, db: c.db, coll: c.coll, preview: !!c.preview,
      filter: $('#filter-input')?.value || '',
      sort: $('#sort-input')?.value || '',
      queryMode: $('#query-mode')?.value || 'find',
      pageSize: $('#page-size')?.value || '50',
      infiniteScroll: $('#infinite-toggle')?.checked || false,
      view: state.view || 'data',
    };
  }
  const src = c.snap || c.restore || {};
  return {
    id: c.id, db: c.db, coll: c.coll, preview: !!c.preview,
    filter: src.filter || '',
    sort: src.sort || '',
    queryMode: src.queryMode || 'find',
    pageSize: src.pageSize || '50',
    infiniteScroll: !!src.infiniteScroll,
    view: src.view || 'data',
  };
}

// Serializza il layout corrente in sessionStorage (best-effort).
export function persistSession() {
  // Mai salvare a ripristino in corso: il layout sarebbe parziale (i tab non
  // ancora riaperti mancherebbero) e diventerebbe la nuova verità, cancellando
  // proprio ciò che si stava ripristinando.
  if (restoring) return;
  try {
    let skippedUnsaved = 0;
    const out = [];
    for (const t of tabs.list) {
      if (!t.state.connected) continue;
      if (!t.connName) { skippedUnsaved++; continue; } // non salvata: niente credenziali per riconnettersi
      out.push({
        id: t.id,
        connName: t.connName,
        expandedDbs: [...t.state.expandedDbs],
        activeCollId: t.state.activeCollId,
        collTabs: t.state.collTabs.map((c) => collTabInputs(t, c)),
      });
    }
    if (!out.length && !skippedUnsaved) {
      sessionStorage.removeItem(KEY);
      return;
    }
    sessionStorage.setItem(KEY, JSON.stringify({ v: 1, activeId: tabs.activeId, skippedUnsaved, tabs: out }));
  } catch { /* sessionStorage pieno o non disponibile: persistenza best-effort */ }
}

// Riconnette una singola connessione salvata e ricostruisce il suo tab (con i
// coll-tab e gli input da ripristinare "una tantum" alla prima attivazione).
function reconnectTab(info) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('timeout di riconnessione'));
    }, 15000);
    socket.emit('mongo:connect', { saved: info.connName, tabId: info.id }, (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!res || !res.ok) return reject(new Error(res ? res.error : 'Risposta assente'));
      const tab = createTab({ id: info.id, connName: info.connName });
      tab.dbType = res.dbType || 'mongodb';
      tab.label = info.connName || res.label || 'Connessione';
      Object.assign(tab.state, {
        connected: true,
        connLabel: res.label || '',
        dbType: tab.dbType,
        databases: res.databases || [],
        expandedDbs: new Set(info.expandedDbs || []),
      });
      tab.state.collTabs = (info.collTabs || []).map((c) => {
        if (c.isSplitTab) {
          if (c.splitSnap) {
            restoreSplitStateSnapshot(c.splitSnap);
          }
          return {
            id: c.id || ('splitview_' + safeUUID()),
            isSplitTab: true,
            db: 'Split-View',
            coll: '🔲 Area Split-View',
            snap: null,
            splitSnap: c.splitSnap,
          };
        }
        if (c.isDbTab) {
          return { id: c.id || safeUUID(), db: c.db, coll: null, isDbTab: true, snap: null };
        }
        return {
          id: c.id || safeUUID(),
          db: c.db,
          coll: c.coll,
          snap: null,
          preview: !!c.preview,
          restore: { filter: c.filter, sort: c.sort, queryMode: c.queryMode, pageSize: c.pageSize, infiniteScroll: c.infiniteScroll, view: c.view },
        };
      });
      tab.state.activeCollId = info.activeCollId && tab.state.collTabs.some((c) => c.id === info.activeCollId)
        ? info.activeCollId
        : (tab.state.collTabs[0] ? tab.state.collTabs[0].id : null);
      // Auto-update della sidebar (schema watch) per la sessione ripristinata.
      socket.emit('schema:watch', { tabId: tab.id }, () => {});
      resolve(res);
    });
  });
}

/* ---------------------------------------------------------------------------
 * Un solo ripristino per volta.
 *
 * `restoreSession()` riconnette i tab IN SEQUENZA, con 15 s di timeout ciascuno:
 * su rete instabile Socket.IO può riconnettersi di nuovo (e rilanciare
 * l'handler) mentre il ciclo precedente è ancora a metà. Senza guardia si
 * ottenevano tab duplicati con lo stesso id, `mongo:connect` doppi sullo stesso
 * tabId (la race lato server, ora serializzata) e un `persistSession()` eseguito
 * a ripristino incompleto, che salvava un layout parziale come nuova verità
 * facendo perdere i tab non ancora riaperti.
 *
 * `restoreInProgress()` permette al chiamante di non salvare il layout mentre il
 * ripristino è in corso.
 * ------------------------------------------------------------------------- */
let restoring = null;

export function restoreInProgress() {
  return restoring !== null;
}

// Ripristina la sessione salvata: riconnette in sequenza le connessioni salvate,
// ripristina il tab attivo e carica i dati del coll-tab attivo. Ritorna true se
// c'era qualcosa da ripristinare. Chiamate concorrenti condividono lo stesso
// ripristino invece di avviarne un secondo.
export function restoreSession() {
  if (restoring) return restoring;
  restoring = doRestoreSession().finally(() => { restoring = null; });
  return restoring;
}

async function doRestoreSession() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { saved = null; }
  if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) {
    // Se restano solo connessioni non salvate, avvisa comunque.
    if (saved && saved.skippedUnsaved) {
      toast(`${saved.skippedUnsaved} connessione/i non salvata/e non è possibile ripristinarla/e.`, true);
    }
    return false;
  }

  toast('Ripristino della sessione in corso…');
  for (const info of saved.tabs) {
    try {
      await reconnectTab(info);
    } catch (err) {
      toast(`Ripristino di "${info.connName}" non riuscito: ${err.message}`, true);
    }
  }

  // Tab attivo (se ancora presente dopo eventuali fallimenti).
  if (saved.activeId && tabs.list.some((t) => t.id === saved.activeId)) {
    tabs.activeId = saved.activeId;
  } else if (tabs.list.length) {
    tabs.activeId = tabs.list[0].id;
  }

  renderTabBar();
  renderWorkspace();
  ensureActiveCollLoaded(); // esegue la query del coll-tab attivo del tab attivo

  if (saved.skippedUnsaved) {
    toast(`${saved.skippedUnsaved} connessione/i non salvata/e non è stato possibile ripristinarla/e.`, true);
  }
  return true;
}

// Registra il salvataggio del layout alla chiusura/ricarica della pagina.
export function initSessionPersistence() {
  // beforeunload copre F5 e la chiusura; pagehide è più affidabile su mobile.
  window.addEventListener('beforeunload', persistSession);
  window.addEventListener('pagehide', persistSession);
}
