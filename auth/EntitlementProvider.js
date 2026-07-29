'use strict';

/* ---------------------------------------------------------------------------
 * Entitlement Provider: chi è l'owner e che cosa gli concede il suo piano.
 *
 * È il punto di innesto del modello open-core. Il control plane sa *chi* sono
 * gli utenti e *cosa* possono fare sui database; il provider sa *quanti*
 * sottoutenti e quali funzioni il piano dell'owner consente.
 *
 *  - LocalEntitlementProvider  (self-host / community, default): owner unico da
 *    variabili d'ambiente, limiti locali. Nessun servizio esterno richiesto.
 *  - ExternalEntitlementProvider (SaaS): client verso il sistema di billing.
 *
 * Selezione con CODEDB_ENTITLEMENT=local|external.
 * ------------------------------------------------------------------------- */

const { verifyPassword } = require('./sessions');

class EntitlementProvider {
  /**
   * Verifica le credenziali dell'owner e ne restituisce identità e piano.
   * @returns {Promise<object|null>} documento utente owner, oppure null
   */
  async verifyOwner(_credentials) { throw new Error('verifyOwner non implementato.'); }

  /** @returns {Promise<{ maxSubUsers: number, features: string[], plan: string|null }>} */
  async getLimits(_ownerId) { throw new Error('getLimits non implementato.'); }

  /** Consumo da riportare al sistema di pricing (usage-based). Best-effort. */
  async reportUsage(_ownerId, _metric, _quantity) { /* niente da fare di default */ }
}

/* --- Community / self-host --------------------------------------------------- */

class LocalEntitlementProvider extends EntitlementProvider {
  constructor(store) {
    super();
    this.store = store;
    this.name = 'local';
  }

  /**
   * Crea l'owner al primo avvio dalle variabili d'ambiente. Idempotente: a ogni
   * riavvio riallinea email e password se sono cambiate.
   */
  async bootstrap() {
    const email = String(process.env.CODEDB_OWNER_EMAIL || '').trim();
    const password = String(process.env.CODEDB_OWNER_PASSWORD || '');
    if (!email || !password) {
      throw new Error(
        'CODEDB_RBAC=on con provider "local" richiede CODEDB_OWNER_EMAIL e CODEDB_OWNER_PASSWORD: ' +
        'sono le credenziali del primo owner (amministratore) dell\'istanza.',
      );
    }
    return this.store.upsertOwner({ email, password, plan: 'self-hosted' });
  }

  async verifyOwner({ email, password }) {
    const owner = await this.store.findOwnerByEmail(email);
    if (!owner || owner.status !== 'active') return null;
    if (!verifyPassword(password, owner.passwordHash)) return null;
    return owner;
  }

  async getLimits() {
    const raw = parseInt(process.env.CODEDB_MAX_SUBUSERS, 10);
    return {
      plan: 'self-hosted',
      maxSubUsers: Number.isFinite(raw) && raw >= 0 ? raw : Infinity,
      features: ['rbac', 'mcp', 'backup'],
    };
  }
}

/* --- SaaS: client del sistema di billing esterno ------------------------------ */

class ExternalEntitlementProvider extends EntitlementProvider {
  constructor(store) {
    super();
    this.store = store;
    this.name = 'external';
    this.baseUrl = String(process.env.CODEDB_BILLING_URL || '').replace(/\/+$/, '');
    this.apiKey = String(process.env.CODEDB_BILLING_KEY || '');
  }

  async bootstrap() {
    throw new Error(
      'CODEDB_ENTITLEMENT=external non è ancora disponibile in questa versione: ' +
      'usa CODEDB_ENTITLEMENT=local (self-host) finché il client di billing non è integrato.',
    );
  }
}

function createEntitlementProvider(store) {
  const kind = String(process.env.CODEDB_ENTITLEMENT || 'local').trim().toLowerCase();
  if (kind === 'external') return new ExternalEntitlementProvider(store);
  if (kind !== 'local') throw new Error(`CODEDB_ENTITLEMENT non valido: "${kind}" (valori ammessi: local, external).`);
  return new LocalEntitlementProvider(store);
}

module.exports = {
  EntitlementProvider,
  LocalEntitlementProvider,
  ExternalEntitlementProvider,
  createEntitlementProvider,
};
