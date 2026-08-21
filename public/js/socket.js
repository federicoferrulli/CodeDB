/* global io */

// Token di sessione dell'utente (RBAC): vive in sessionStorage come lo stato di
// ripristino dei tab (session-restore.js), quindi si azzera alla chiusura del
// tab del browser. Con CODEDB_RBAC spento resta vuoto e il server accetta
// comunque l'handshake.
const TOKEN_KEY = 'codedb:token';

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage non disponibile: si resta senza sessione persistente */
  }
}

/* ---------------------------------------------------------------------------
 * Il socket si apre alla PRIMA USATA, non al caricamento del modulo.
 *
 * Prima la riga `export const socket = io(…)` girava all'atto dell'import, e
 * `io` è un globale che esiste solo nella pagina: bastava importare un qualsiasi
 * modulo del frontend fuori dal browser — cioè in un test — per prendere un
 * `ReferenceError: io is not defined` prima ancora di arrivare al codice da
 * provare. Non era un dettaglio di comodità: siccome quasi tutti i moduli
 * grandi risalgono fin qui, NESSUNO di loro era caricabile in prova.
 *
 * Aprirlo pigramente non cambia niente nella pagina (il primo `emit` arriva
 * comunque subito) e rende il modulo caricabile ovunque. `impostaSocket` è il
 * punto in cui un test mette il proprio socket finto: senza, l'unico modo di
 * provare il trasporto sarebbe alzare un server vero.
 * ------------------------------------------------------------------------- */

let reale = null;

/** Il socket vero, aperto alla prima richiesta. */
export function socketReale() {
  // `auth` come funzione viene rivalutata a ogni tentativo di connessione: dopo
  // un login il socket si riconnette portando il token appena ottenuto.
  if (!reale) reale = io({ auth: (cb) => cb({ token: getToken() }) });
  return reale;
}

/**
 * Sostituisce il socket. Serve ai test, che ne passano uno finto; passare
 * `null` rimette le cose come stavano (il prossimo uso riaprirà quello vero).
 */
export function impostaSocket(finto) {
  reale = finto || null;
}

/**
 * L'oggetto che tutti importano. È un rimando: ogni accesso arriva al socket
 * vero, aprendolo se serve. Così le decine di `socket.emit(…)` e `socket.on(…)`
 * sparse per il frontend continuano a essere scritte come prima.
 */
export const socket = new Proxy({}, {
  get(_, prop) {
    const s = socketReale();
    const valore = s[prop];
    return typeof valore === 'function' ? valore.bind(s) : valore;
  },
  set(_, prop, valore) {
    socketReale()[prop] = valore;
    return true;
  },
  has(_, prop) {
    return prop in socketReale();
  },
});
