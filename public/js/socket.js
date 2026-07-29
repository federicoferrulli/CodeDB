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

// `auth` come funzione viene rivalutata a ogni tentativo di connessione: dopo
// un login il socket si riconnette portando il token appena ottenuto.
export const socket = io({ auth: (cb) => cb({ token: getToken() }) });
