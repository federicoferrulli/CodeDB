'use strict';

/* ---------------------------------------------------------------------------
 * Principal = "chi sta parlando" con il server, sia da UI (token di sessione)
 * sia da MCP (API key). È l'unico oggetto che il motore dei permessi consulta.
 *
* Con il flag CODEDB_RBAC spento (default, e sempre nell'app desktop Electron)
* ogni richiesta viaggia con ROOT_PRINCIPAL: `can()` risponde sempre true e
 * `guardStrategy()` mantiene le invarianti indipendenti dai grant (per esempio
 * niente JavaScript lato server MongoDB o SQL Raw multi-statement), mentre
 * nessuna operazione viene negata per capability o scope.
 * ------------------------------------------------------------------------- */

const ALL_CAPABILITIES = ['read', 'write', 'ddl', 'delete', 'manage'];
const ALL_TENANT_CAPABILITIES = ['admin'];

// Letto a ogni chiamata (non congelato in una costante) così i test possono
// impostare l'env prima di far partire il server nello stesso processo.
function rbacOn() {
  return String(process.env.CODEDB_RBAC || 'off').trim().toLowerCase() === 'on';
}

/** Utente sintetico "owner locale": tutti i permessi, nessuno scope. */
const ROOT_PRINCIPAL = Object.freeze({
  id: 'local',
  type: 'owner',
  ownerId: 'local',
  email: null,
  displayName: 'Owner locale',
  root: true,
  capabilities: ALL_CAPABILITIES.slice(),
  tenantCapabilities: ALL_TENANT_CAPABILITIES.slice(),
  grants: null,
  connScope: null,
});

/**
 * Principal di un utente del control plane.
 * @param {object} user documento della collezione `users`
 * @param {Array<object>} grants documenti `grants` del soggetto (vuoto per l'owner)
 * @param {Array<string>|null} connScope connessioni consentite dalla API key (null = tutte)
 */
function makePrincipal(user, grants = [], connScope = null) {
  const isOwner = user.type === 'owner';
  return {
    id: String(user._id),
    type: user.type,
    ownerId: String(user.ownerId || user._id),
    email: user.email || null,
    displayName: user.displayName || user.email || null,
    // L'owner non è "root": resta legato al proprio tenant (ownerId) e alle
    // proprie connessioni, ma non ha vincoli di scope al loro interno.
    root: false,
    owner: isOwner,
    capabilities: isOwner ? ALL_CAPABILITIES.slice() : [],
    tenantCapabilities: isOwner
      ? ALL_TENANT_CAPABILITIES.slice()
      : (Array.isArray(user.tenantCapabilities)
        ? user.tenantCapabilities.filter((capability) => ALL_TENANT_CAPABILITIES.includes(capability))
        : []),
    grants: Array.isArray(grants) ? grants : [],
    connScope: Array.isArray(connScope) && connScope.length ? connScope.map(String) : null,
  };
}

module.exports = { ALL_CAPABILITIES, ALL_TENANT_CAPABILITIES, ROOT_PRINCIPAL, rbacOn, makePrincipal };
