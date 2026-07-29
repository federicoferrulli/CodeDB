'use strict';

/* ---------------------------------------------------------------------------
 * Motore dei permessi: una sola funzione decisionale, `can()`, interrogata dal
 * Proxy autorizzante (auth/guardStrategy.js) e dai pochi handler che non
 * passano da una strategia (connessioni salvate, gestione utenti, backup).
 *
 * I grant del principal sono già denormalizzati al login (ogni grant porta le
 * capability del proprio ruolo), così `can()` non tocca mai il database.
 * ------------------------------------------------------------------------- */

const { matchesAny } = require('./capabilities');

function grantFor(principal, connName) {
  if (!principal || !Array.isArray(principal.grants) || !connName) return null;
  return principal.grants.find((g) => g.connName === connName) || null;
}

/**
 * @param {object} principal
 * @param {{ connName?: string|null, capability?: string|null, db?: string|null, coll?: string|null }} req
 * @returns {boolean}
 */
function can(principal, req = {}) {
  if (!principal) return false;
  if (principal.root) return true;

  const { connName = null, capability = null, db = null, coll = null } = req;
  if (!capability) return true; // operazione non classificata: nessun permesso richiesto

  // Le API key possono essere limitate a un sottoinsieme di connessioni: il
  // vincolo si somma ai grant, non li sostituisce.
  if (principal.connScope && connName && !principal.connScope.includes(connName)) return false;

  // L'owner ha tutti i permessi sulle proprie connessioni, senza scope.
  if (principal.owner) return true;

  if (!connName) return false; // sottoutente: nessun permesso fuori da una connessione salvata

  const grant = grantFor(principal, connName);
  if (!grant) return false;
  if (!Array.isArray(grant.capabilities) || !grant.capabilities.includes(capability)) return false;

  const scope = grant.scope;
  if (!scope) return true;
  if (!matchesAny(scope.databases, db)) return false;
  if (!matchesAny(scope.collections, coll)) return false;
  return true;
}

/** Scope db/collezione applicabile a una connessione (null = nessun limite). */
function scopeFor(principal, connName) {
  if (!principal || principal.root || principal.owner) return null;
  const grant = grantFor(principal, connName);
  return (grant && grant.scope) || null;
}

/** Filtra una lista di nomi di connessioni salvate a quelle utilizzabili. */
function allowedConnections(principal, names) {
  if (!principal) return [];
  if (principal.root) return names.slice();
  const inKeyScope = (n) => !principal.connScope || principal.connScope.includes(n);
  if (principal.owner) return names.filter(inKeyScope);
  return names.filter((n) => inKeyScope(n) && grantFor(principal, n));
}

/** true se il principal può aprire la connessione salvata indicata. */
function canUseConnection(principal, connName) {
  return can(principal, { connName, capability: 'read' });
}

/**
 * Permesso su un'operazione che legge o scrive l'intera connessione senza
 * passare dai metodi della strategia (backup/restore usano il client nativo):
 * richiede la capability **e** l'assenza di uno scope db/collezione, perché non
 * sarebbe possibile applicarlo.
 */
function canWholeConnection(principal, connName, capability) {
  if (!can(principal, { connName, capability })) return false;
  const scope = scopeFor(principal, connName);
  if (!scope) return true;
  const unrestricted = (list) => !Array.isArray(list) || list.length === 0 || list.every((p) => p === '*');
  return unrestricted(scope.databases) && unrestricted(scope.collections);
}

module.exports = { can, grantFor, scopeFor, allowedConnections, canUseConnection, canWholeConnection };
