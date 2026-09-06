/**
 * CodeDB — Il trasporto: come una richiesta arriva al server e come torna.
 *
 * Dietro tre nomi — `emit`, `emitFireAndForget`, `isForActiveTab` — ci stanno
 * tre decisioni che nessun chiamante deve rifare:
 *
 *  1. **a quale tab appartiene la richiesta.** Il tab si cattura al momento
 *     della chiamata, non della risposta: l'utente può cambiare tab mentre una
 *     query è in volo, e `state` (state.js) è un Proxy che punta SEMPRE al tab
 *     attivo. La risposta porta quindi con sé l'origine (`_tab`) e lo stato su
 *     cui scrivere (`_state`);
 *  2. **la riconnessione**, e solo per le connessioni SALVATE: per una
 *     connessione estemporanea non c'è nulla con cui riaprirla, e provarci
 *     darebbe un errore di autenticazione al posto di quello vero;
 *  3. **l'annullamento quando il tab d'origine si chiude**, compreso il caso in
 *     cui era già chiuso quando la richiesta è partita.
 *
 * Stava dentro `utils.js`, sepolto fra una quarantina di funzioni scorrelate —
 * toast, icone, modali, menu contestuali — che al solo essere importate
 * registrano ascoltatori sul `document`. Il trasporto era invisibile, e
 * importarlo tirava dentro tutto il resto.
 *
 * Il socket **si accetta**, non si crea: `socket.js` lo apre alla prima usata e
 * un test può metterci il proprio (`impostaSocket`). Le dipendenze di questo
 * modulo sono quattro moduli che non toccano il DOM al caricamento, e questo è
 * ciò che lo rende provabile fuori dal browser.
 */

import { socket } from './socket.js';
import { state } from './state.js';
import { tabs, activeTab } from './tabs.js';
import { toast } from './avvisi.js';

// Richiesta con acknowledgment: inietta il tabId del tab attivo, catturato al
// momento della chiamata (non alla risposta: l'utente può cambiare tab mentre
// la query è in volo). La risposta porta il tab di origine in `_tab` e il suo
// stato in `_state`; se nel frattempo il tab è stato chiuso, la risposta viene
// scartata.
//
// IMPORTANTE — `_state` non è un di più: `state` (state.js) è un Proxy che punta
// SEMPRE al tab attivo, quindi un callback che scrive `state.docs = …` scrive nel
// tab che è attivo AL MOMENTO DELLA RISPOSTA, non in quello che ha fatto la
// richiesta. Cambiando tab mentre una find è in volo, i risultati del tab A
// finivano nello stato del tab B (griglia, colonne e footer sbagliati, e da lì
// scritture sul documento sbagliato). Ogni callback che modifica lo stato deve
// quindi usare `res._state`, mai il Proxy; e deve ridipingere solo se il proprio
// tab è ancora quello attivo (`res._tab === activeTab()`).
export function emit(event, payload) {
  // Il tabId del payload, quando c'è, ha la precedenza (split view, modali con
  // contesto esplicito): `_tab`/`_state` devono descrivere il tab REALMENTE
  // interrogato, altrimenti il callback scriverebbe nello stato di un altro.
  const pinned = payload && payload.tabId;
  // NB: il tabId va scritto DOPO lo spread del payload. Diverse modali passano
  // `tabId` esplicito ma indefinito quando non hanno un contesto (es. insert.js
  // con `insertContext = null`): con lo spread per ultimo quell'`undefined`
  // cancellava il tabId iniettato, il server ripiegava sulla sessione "default"
  // e rispondeva "Nessuna connessione attiva al database.".
  const tab = pinned ? (tabs.list.find((t) => t.id === pinned) || null) : activeTab();
  const pinnedMancante = !!pinned && !tab;
  const withTab = (extra) => {
    const out = { ...(payload || {}), ...(extra || {}) };
    out.tabId = tab ? tab.id : pinned;
    return out;
  };
  // Se il chiamante porta il tabId di un tab già chiuso, un piccolo sentinella
  // conserva l'identità dell'origine: `isForActiveTab()` deve risultare falso e
  // non mostrare l'errore nel workspace di un'altra connessione.
  const tabStamp = tab || (pinnedMancante ? { id: pinned, orphan: true } : null);
  const stamp = (res) => Object.assign(res, {
    _tab: tabStamp,
    _state: tab ? tab.state : (pinnedMancante ? null : state),
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let onTabClosed = null;
    const cleanup = () => {
      if (onTabClosed && typeof window !== 'undefined') {
        window.removeEventListener('codedb:tab-closed', onTabClosed);
      }
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    // Anche gli errori portano l'origine: i callback di errore devono poter
    // decidere allo stesso modo se lo stato da toccare è ancora il proprio.
    const fail = (msg) => rejectOnce(stamp(new Error(msg)));
    const tabChiuso = () => pinnedMancante || !!(tab && !tabs.list.includes(tab));
    const failTabChiuso = () => {
      const err = new Error('Operazione interrotta: il tab di origine è stato chiuso.');
      err.name = 'AbortError';
      err.code = 'TAB_CLOSED';
      rejectOnce(stamp(err));
    };
    onTabClosed = (e) => {
      if (tab && e.detail && e.detail.tabId === tab.id) failTabChiuso();
    };
    if (tab && typeof window !== 'undefined') {
      window.addEventListener('codedb:tab-closed', onTabClosed);
    }
    if (tabChiuso()) {
      failTabChiuso();
      return;
    }
    socket.emit(event, withTab(), (res) => {
      if (tabChiuso()) { failTabChiuso(); return; }
      if (res && res.ok) {
        resolveOnce(stamp(res));
      } else {
        const errMsg = String((res && res.error) || '');
        const isNoSession = errMsg.includes('Nessuna connessione attiva');
        // Riconnessione automatica possibile solo per le connessioni SALVATE
        // (CDB-22): i segreti non vivono più nel browser, quindi per una
        // connessione estemporanea non c'è nulla con cui riaprirla — e provarci
        // produrrebbe un errore di autenticazione al posto di quello vero.
        const riconnettibile = !!(tab && (tab.connName || (tab.connCfg && tab.connCfg.saved)));
        if (isNoSession && riconnettibile && (!payload || !payload._reconnected)) {
          const cfg = { saved: tab.connName || tab.connCfg.saved };
          socket.emit('mongo:connect', { ...cfg, tabId: tab.id }, (connRes) => {
            if (tabChiuso()) { failTabChiuso(); return; }
            if (connRes && connRes.ok) {
              tab.state.connected = true;
              toast(`Riconnessione al database riuscita per "${tab.label || 'Tab'}"`);
              socket.emit(event, withTab({ _reconnected: true }), (retryRes) => {
                if (tabChiuso()) { failTabChiuso(); return; }
                if (retryRes && retryRes.ok) {
                  resolveOnce(stamp(retryRes));
                } else {
                  fail(retryRes ? retryRes.error : 'Errore dopo la riconnessione');
                }
              });
            } else {
              toast(`Impossibile riconnettersi al database: ${connRes ? connRes.error : 'Errore sconosciuto'}`, true);
              fail(res ? res.error : 'Connessione assente');
            }
          });
        } else {
          fail(res ? res.error : 'Errore sconosciuto');
        }
      }
    });
  });
}

// La risposta riguarda ancora ciò che l'utente sta guardando? Solo in questo
// caso il workspace (DOM unico, condiviso da tutti i tab) va ridipinto: i dati
// di un tab in background si scrivono nel suo stato e basta, verranno mostrati
// quando l'utente ci tornerà.
export function isForActiveTab(res) {
  return !res || !res._tab || res._tab === activeTab();
}

// Evento socket senza risposta (fire-and-forget), sempre col tabId del tab
// attivo. Si chiamava `notify`, nome indistinguibile da una notifica all'utente:
// in graph3d.js era stato usato per ~27 messaggi UI, che quindi non comparivano
// mai (errori compresi) mentre il testo italiano finiva sul socket come nome di
// evento. Per i messaggi all'utente si usa `toast()`.
export function emitFireAndForget(event, payload) {
  const tab = activeTab();
  // Il tabId dopo lo spread, per lo stesso motivo di `emit()`: un `tabId`
  // esplicito ma indefinito nel payload non deve cancellare quello iniettato.
  const msg = { ...(payload || {}) };
  msg.tabId = (payload && payload.tabId) || (tab ? tab.id : undefined);
  socket.emit(event, msg);
}

