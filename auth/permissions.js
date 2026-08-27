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

  const { connName = null, capability = null } = req;
  // `db`/`coll` conservano la distinzione fra "non applicabile" (proprieta'
  // assente => undefined) e "atteso ma vuoto" (null/''), che matchesAny tratta
  // in modo opposto: la prima passa, la seconda viene negata. Il destructuring
  // con default a `null` avrebbe appiattito i due casi.
  const db = Object.prototype.hasOwnProperty.call(req, 'db') ? req.db : undefined;
  const coll = Object.prototype.hasOwnProperty.call(req, 'coll') ? req.coll : undefined;
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

/** Capability amministrativa del tenant, indipendente da connessioni e scope. */
function canAdminTenant(principal) {
  return !!principal && (principal.root || principal.owner
    || (Array.isArray(principal.tenantCapabilities) && principal.tenantCapabilities.includes('admin')));
}

/**
 * Amministratore dell'INSTALLAZIONE, che non è l'amministratore di un tenant.
 *
 * `manage` è la capability che OGNI owner possiede sul proprio account: come
 * gate per le risorse condivise da tutta l'istanza non distingue nulla. Il
 * vault è la risorsa condivisa per eccellenza — chiave unica e `connections.ini`
 * di ogni owner — quindi con il solo `manage` l'owner del tenant A poteva
 * azzerarlo o richiuderlo con una passphrase propria, lasciando gli altri
 * tenant con segreti cifrati da una chiave che nessuno possiede più.
 *
 * L'elenco arriva dall'AMBIENTE, non dal control plane, proprio perché non deve
 * essere assegnabile da dentro l'applicazione: `CODEDB_VAULT_ADMINS` (email
 * separate da virgola) e, in mancanza, `CODEDB_OWNER_EMAIL` — che il provider
 * locale documenta già come «il primo owner (amministratore) dell'istanza»,
 * quindi il self-hosted a un tenant solo continua a funzionare come prima. In
 * un'istanza SaaS (provider esterno, nessuna delle due variabili) l'elenco è
 * vuoto e l'operazione non è raggiungibile da alcun cliente: si fa sulla
 * macchina.
 *
 * `env` è iniettabile per i test; in esercizio è `process.env`.
 */
function installAdminEmails(env = process.env) {
  const raw = String(env.CODEDB_VAULT_ADMINS || env.CODEDB_OWNER_EMAIL || '').trim();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function isInstallAdmin(principal, env = process.env) {
  if (!principal) return false;
  // RBAC spento: chi apre l'interfaccia è già l'amministratore della macchina.
  if (principal.root) return true;
  if (!principal.owner) return false;
  const email = String(principal.email || '').trim().toLowerCase();
  return !!email && installAdminEmails(env).has(email);
}

module.exports = {
  can, grantFor, scopeFor, allowedConnections, canUseConnection, canWholeConnection,
  canAdminTenant,
  installAdminEmails, isInstallAdmin,
};
