import { state } from './state.js';
import { socket } from './socket.js';
import { tabs } from './tabs.js';
import { $, emit } from './utils.js';
import { runQuery, svuotaRelazioni } from './grid.js';
import { renderDbTree } from './dbtree.js';

export function togglePolling() {
  const isEnabled = $('#polling-checkbox').checked;
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval);
    state.pollingInterval = null;
  }
  if (isEnabled) {
    const owner = tabs.activeId; // l'intervallo appartiene a questo tab
    state.pollingInterval = setInterval(() => {
      // runQuery agisce sul tab attivo: il polling di un tab in background
      // non deve interrogare i dati di un altro tab.
      if (owner !== tabs.activeId) return;
      if (document.hidden) return;
      if (document.querySelector('.editing')) return;
      if (!$('#editdoc-overlay').classList.contains('hidden')) return;
      if (!$('#insert-overlay').classList.contains('hidden')) return;
      runQuery({ auto: true }); // polling automatico: non tracciato nell'audit
    }, 5000);
  }
}

export function startWatch() {
  $('#polling-toggle').classList.add('hidden');
  $('#polling-checkbox').checked = false;
  state.pollingShown = false;
  togglePolling();
  const tab = tabs.list.find((t) => t.id === tabs.activeId);
  emit('collection:watch', { db: state.db, coll: state.coll }).then((res) => {
    const targetTab = (res && res._tab) || tab;
    if (targetTab && targetTab.state) {
      targetTab.state.watching = true;
      if (targetTab.id === tabs.activeId) $('#live-badge').classList.remove('hidden');
    }
  }).catch(() => {
    // Watch rifiutato subito (MySQL non lo supporta, o errore lato server):
    // stesso ripiego dell'evento watch:unavailable, cioè il toggle di
    // auto-refresh a polling. Così anche le tabelle hanno l'aggiornamento
    // automatico.
    if (!tab || !tabs.list.includes(tab)) return;
    tab.state.watching = false;
    tab.state.pollingShown = true;
    // `?.`: con la Split-View attiva la toolbar è staccata dal DOM; lo stato
    // del tab è comunque aggiornato e renderWorkspace la ridipinge al rientro.
    if (tab.id === tabs.activeId) {
      $('#live-badge').classList.add('hidden');
      $('#polling-toggle')?.classList.remove('hidden');
    }
  });
}

// Watch dello schema: attivato una volta per tab dopo il connect. Dove il
// change stream non c'è (MySQL, Mongo standalone) arriva schema:unavailable
// e si ripiega su un polling silenzioso della sidebar.
// NB: niente reset di schemaPolling nell'ack — su MySQL schema:unavailable
// arriva PRIMA dell'ack (onUnavailable è sincrono lato server) e il reset
// spegnerebbe il polling appena attivato.
export function startSchemaWatch() {
  emit('schema:watch', {}).catch(() => {
    // Errore lato server: nessun auto-update dello schema, resta l'aggiornamento manuale.
  });
}

// Aggiorna la sidebar senza disturbare: salta se l'utente sta usando la
// ricerca (il tree mostrerebbe i risultati filtrati) e non mostra toast.
// Le collection dei db espansi vengono precaricate prima del render, così
// tabelle nuove/eliminate e i conteggi compaiono senza flash "caricamento…".
function refreshTreeAuto() {
  const search = $('#db-search');
  if (search.value.trim() || document.activeElement === search) return;
  emit('db:list', {}).then(async (res) => {
    const originState = res._state || state;
    const expanded = res.databases.filter((d) => originState.expandedDbs.has(d.name));
    await Promise.all(expanded.map((d) =>
      // tabId esplicito: la fetch resta sulla sessione che ha avviato il refresh
      // anche se l'utente cambia tab mentre è in volo.
      emit('db:collections', { db: d.name, tabId: res._tab ? res._tab.id : undefined })
        .then((r) => { d.collections = r.collections; })
        .catch(() => {}) // db sparito nel frattempo: il render lo mostrerà chiuso
    ));
    // L'utente può aver cambiato tab mentre le richieste erano in volo:
    // la sidebar mostra i dati del tab attivo, non si sovrascrive.
    if (res._tab && res._tab.id !== tabs.activeId) return;
    renderDbTree(res.databases);
  }).catch(() => {});
}

export function initLive() {
  $('#polling-checkbox').addEventListener('change', togglePolling);

  socket.on('collection:changed', (change) => {
    const tab = change.tabId
      ? tabs.list.find((t) => t.id === change.tabId)
      : tabs.list.find((t) => t.id === tabs.activeId);
    if (!tab) return;
    const collTab = tab.state.collTabs.find((ct) =>
      !ct.isDbTab && !ct.isSplitTab && ct.db === change.db && ct.coll === change.coll
    );
    if (!collTab) return;
    const corrente = tab.state.activeCollId === collTab.id
      && change.db === tab.state.db && change.coll === tab.state.coll;
    if (!corrente) {
      collTab.dataDirty = true;
      return;
    }
    clearTimeout(tab.state.liveTimer);
    if (tab.id !== tabs.activeId) {
      tab.state.dataDirty = true;
      collTab.dataDirty = true;
      return;
    }
    const db = tab.state.db;
    const coll = tab.state.coll;
    tab.state.liveTimer = setTimeout(() => {
      tab.state.liveTimer = null;
      if (!tabs.list.includes(tab)) return;
      if (tab.id !== tabs.activeId) {
        tab.state.dataDirty = true;
        collTab.dataDirty = true;
        return;
      }
      // Anche il coll-tab può essere cambiato durante il debounce.
      if (tab.state.db !== db || tab.state.coll !== coll || tab.state.activeCollId !== collTab.id) {
        collTab.dataDirty = true;
        return;
      }
      // I marker dirty, se presenti, si consumano solo quando la lettura torna
      // valida (grid.runQuery). Un errore non deve far sembrare fresca la cache.
      runQuery({ auto: true }); // refresh da change stream: non tracciato
    }, 300);
  });

  socket.on('schema:changed', (info) => {
    const tab = tabs.list.find((t) => t.id === info.tabId);
    if (!tab) return;
    // Le chiavi esterne sono metadati di schema: una DDL le rende obsolete, e
    // un indicatore 🔗 acceso su un vincolo eliminato è peggio di nessun
    // indicatore. Si svuota subito, anche per i tab in secondo piano: la cache
    // è per collection, non per tab.
    svuotaRelazioni();
    // Tab in background: si segna lo schema come sporco e si aggiorna
    // alla riattivazione (vedi renderWorkspace).
    if (tab.id !== tabs.activeId) {
      tab.state.schemaDirty = true;
      return;
    }
    clearTimeout(tab.state.schemaTimer);
    tab.state.schemaTimer = setTimeout(() => {
      tab.state.schemaTimer = null;
      if (!tabs.list.includes(tab)) return;
      if (tab.id !== tabs.activeId) {
        tab.state.schemaDirty = true;
        return;
      }
      refreshTreeAuto();
    }, 300);
  });

  socket.on('schema:unavailable', (info) => {
    const tab = tabs.list.find((t) => t.id === (info && info.tabId));
    if (tab) tab.state.schemaPolling = true;
  });

  // Polling di riserva per i tab senza change stream: aggiorna la sidebar
  // del tab attivo ogni 10 secondi.
  setInterval(() => {
    if (document.hidden) return;
    const tab = tabs.list.find((t) => t.id === tabs.activeId);
    if (!tab || !tab.state.connected || !tab.state.schemaPolling) return;
    refreshTreeAuto();
  }, 10000);

  socket.on('watch:unavailable', (info) => {
    const tab = info && info.tabId
      ? tabs.list.find((t) => t.id === info.tabId)
      : tabs.list.find((t) => t.id === tabs.activeId);
    if (!tab) return;
    tab.state.watching = false;
    tab.state.pollingShown = true;
    if (tab.id === tabs.activeId) {
      $('#live-badge').classList.add('hidden');
      $('#polling-toggle')?.classList.remove('hidden'); // vedi nota in startWatch
    }
  });
}
