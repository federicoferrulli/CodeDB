'use strict';

// CodeDB — eventi-identita. Stato e dipendenze appartengono alla singola istanza.
const { validaPreferenza } = require('../auth/preferenze');

function createModule({ config, identita, vault }) {
  function registra(socketContext, lifecycle) {
    /**
     * Preferenze personali (chiave `{ownerId, subjectId, ambito, chiave}`).
     *
     * Il primo cliente è la personalizzazione delle scorciatoie da tastiera
     * (`public/js/scorciatoie-ui.js`): il server non interpreta il valore, lo
     * custodisce e lo restituisce soltanto allo stesso principal. Le preferenze
     * condivise hanno eventi separati e scrittura riservata all'admin. Con RBAC
     * spento non esiste un tenant — l'istanza è locale e monoutente — quindi si
     * risponde con `ok: false` e il client usa dichiaratamente il localStorage
     * del browser invece di fingere una persistenza che non c'è.
     */
    lifecycle.amministrativo('prefs:get', async ({ chiave }, cb) => {
      if (!config.rbacOn()) {
        cb({ ok: false, error: 'RBAC spento: preferenze conservate nel browser.' });
        return;
      }
      const richiesta = validaPreferenza({ ambito: 'personale', chiave, solaLettura: true });
      const store = identita.requireStore();
      const valore = await store.getPrefs(socketContext.principal.ownerId || 'locale', socketContext.principal.id, richiesta.ambito, richiesta.chiave);
      cb({ ok: true, valore });
    });

    lifecycle.amministrativo('prefs:set', async ({ chiave, valore }, cb) => {
      if (!config.rbacOn()) {
        cb({ ok: false, error: 'RBAC spento: preferenze conservate nel browser.' });
        return;
      }
      const richiesta = validaPreferenza({ ambito: 'personale', chiave, valore });
      const store = identita.requireStore();
      await store.setPrefs(socketContext.principal.ownerId || 'locale', socketContext.principal.id, richiesta.ambito, richiesta.chiave, richiesta.valore);
      cb({ ok: true });
    });

    lifecycle.amministrativo('prefs:shared:get', async ({ chiave }, cb) => {
      if (!config.rbacOn()) return cb({ ok: false, error: 'RBAC spento: preferenze conservate nel browser.' });
      identita.assertTenantAdmin(socketContext.principal);
      const richiesta = validaPreferenza({ ambito: 'condiviso', chiave, solaLettura: true });
      const valore = await identita.requireStore().getPrefs(
        socketContext.principal.ownerId || 'locale', socketContext.principal.id, richiesta.ambito, richiesta.chiave,
      );
      cb({ ok: true, valore });
    });

    lifecycle.amministrativo('prefs:shared:set', async ({ chiave, valore }, cb) => {
      if (!config.rbacOn()) return cb({ ok: false, error: 'RBAC spento: preferenze conservate nel browser.' });
      identita.assertTenantAdmin(socketContext.principal);
      const richiesta = validaPreferenza({ ambito: 'condiviso', chiave, valore });
      await identita.requireStore().setPrefs(
        socketContext.principal.ownerId || 'locale', socketContext.principal.id, richiesta.ambito, richiesta.chiave, richiesta.valore,
      );
      cb({ ok: true });
    });

    // --- Utenti, permessi e API key (solo con RBAC attivo) ---------------------
    // Riservati a owner/admin del tenant; i limiti del piano (quanti sottoutenti)
    // arrivano dall'Entitlement Provider, cioè dal billing in modalità SaaS.

    function requireRbac() {
      if (!config.rbacOn()) throw new Error('Gestione utenti non disponibile: CODEDB_RBAC non è attivo su questa istanza.');
      return identita.requireStore();
    }

    lifecycle.amministrativo('auth:me', (_payload, cb) => {
      cb({ ok: true, user: identita.principalView(socketContext.principal) });
    });

    lifecycle.amministrativo('roles:list', async (_payload, cb) => {
      const store = requireRbac();
      identita.assertTenantAdmin(socketContext.principal);
      const roles = await store.listRoles(socketContext.principal.ownerId);
      cb({ ok: true, roles: roles.map((r) => ({ name: r.name, capabilities: r.capabilities, builtIn: !!r.builtIn })) });
    });

    lifecycle.amministrativo('users:list', async (_payload, cb) => {
      const store = requireRbac();
      identita.assertTenantAdmin(socketContext.principal);
      const [users, limits] = await Promise.all([
        store.listSubUsers(socketContext.principal.ownerId),
        identita.entitlements.getLimits(socketContext.principal.ownerId),
      ]);
      cb({
        ok: true,
        users: users.map((u) => ({
          id: u._id, email: u.email, displayName: u.displayName, status: u.status,
          tenantAdmin: Array.isArray(u.tenantCapabilities) && u.tenantCapabilities.includes('admin'),
          createdAt: u.createdAt,
        })),
        limits: { maxSubUsers: limits.maxSubUsers === Infinity ? null : limits.maxSubUsers, plan: limits.plan },
      });
    });

    lifecycle.amministrativo('users:create', async ({ email, password, displayName }, cb) => {
      const store = requireRbac();
      identita.assertTenantAdmin(socketContext.principal);
      const limits = await identita.entitlements.getLimits(socketContext.principal.ownerId);
      const current = await store.countSubUsers(socketContext.principal.ownerId);
      if (current >= limits.maxSubUsers) {
        throw new Error(`Il tuo piano consente al massimo ${limits.maxSubUsers} sottoutenti: elimina un utente esistente o passa a un piano superiore.`);
      }
      const user = await store.createSubUser({ ownerId: socketContext.principal.ownerId, email, password, displayName });
      await identita.entitlements.reportUsage(socketContext.principal.ownerId, 'subusers', current + 1).catch(() => {});
      cb({ ok: true, user: { id: user._id, email: user.email, displayName: user.displayName, status: user.status } });
    });

    lifecycle.amministrativo('users:update', async ({ id, status, displayName, password, tenantAdmin }, cb) => {
      const store = requireRbac();
      identita.assertTenantAdmin(socketContext.principal);
      if (tenantAdmin != null && !socketContext.principal.root && !socketContext.principal.owner) {
        throw new Error('Solo l’owner può delegare o revocare l’amministrazione del tenant.');
      }
      const esito = await store.updateSubUser(socketContext.principal.ownerId, id, {
        status, displayName, password, tenantAdmin,
      });
      // Sospensione o cambio password: le sessioni sono state cancellate, ma un
      // socket già connesso sopravviverebbe alla riga cancellata (CDB-A13).
      if (esito.revocate) identita.disconnettiSocketDi(id, 'sospensione o cambio password');
      cb({ ok: true });
    });

    lifecycle.amministrativo('users:delete', async ({ id }, cb) => {
      const store = requireRbac();
      identita.assertTenantAdmin(socketContext.principal);
      await store.deleteSubUser(socketContext.principal.ownerId, id);
      identita.disconnettiSocketDi(id, 'utente eliminato');
      cb({ ok: true });
    });

    lifecycle.amministrativo('grants:list', async (_payload, cb) => {
      const store = requireRbac();
      identita.assertTenantAdmin(socketContext.principal);
      const grants = await store.listGrants(socketContext.principal.ownerId);
      cb({ ok: true, grants: grants.map((g) => ({ subjectId: g.subjectId, connName: g.connName, role: g.role, scope: g.scope || null })) });
    });

    lifecycle.amministrativo('grants:set', async ({ subjectId, connName, role, scope }, cb) => {
      const store = requireRbac();
      identita.assertTenantAdmin(socketContext.principal);
      const grant = await identita.withConnectionAclLock(socketContext.principal.ownerId, async () => {
        // Il controllo di esistenza e la scrittura del grant condividono lo
        // stesso lock di delete/rename: non si può reinserire un permesso sul
        // vecchio nome durante la revoca.
        if (!vault.loadConnections(socketContext.principal.ownerId)[String(connName || '').trim()]) {
          throw new Error('Connessione salvata "' + connName + '" non trovata.');
        }
        return store.setGrant({
          ownerId: socketContext.principal.ownerId, subjectId, connName, role, scope,
        });
      });
      // Il principal del socket contiene capability e scope denormalizzati.
      // Chiudere le sessioni del soggetto rende effettiva subito anche una
      // restrizione; altrimenti resterebbe una finestra fino alla rivalidazione.
      identita.disconnettiSocketDi(subjectId, 'permessi aggiornati');
      cb({ ok: true, grant: { subjectId: grant.subjectId, connName: grant.connName, role: grant.role, scope: grant.scope } });
    });

    lifecycle.amministrativo('grants:revoke', async ({ subjectId, connName }, cb) => {
      const store = requireRbac();
      identita.assertTenantAdmin(socketContext.principal);
      const res = await store.revokeGrant(socketContext.principal.ownerId, subjectId, connName);
      identita.disconnettiSocketDi(subjectId, 'permesso revocato');
      cb({ ok: true, ...res });
    });

    lifecycle.amministrativo('apikeys:list', async (_payload, cb) => {
      const store = requireRbac();
      identita.assertTenantAdmin(socketContext.principal);
      const keys = await store.listApiKeys(socketContext.principal.ownerId);
      cb({
        ok: true,
        keys: keys.map((k) => ({ id: k._id, subjectId: k.subjectId, label: k.label, prefix: k.prefix, connScope: k.connScope, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
      });
    });

    // La chiave in chiaro esiste solo in questa risposta: in DB ne resta l'hash.
    lifecycle.amministrativo('apikeys:create', async ({ subjectId, label, connScope }, cb) => {
      const store = requireRbac();
      identita.assertTenantAdmin(socketContext.principal);
      const created = await store.createApiKey({
        ownerId: socketContext.principal.ownerId,
        subjectId: subjectId || socketContext.principal.id,
        label,
        connScope,
      });
      cb({ ok: true, key: created.key, apiKey: { id: created._id, subjectId: created.subjectId, label: created.label, prefix: created.prefix, connScope: created.connScope } });
    });

    lifecycle.amministrativo('apikeys:revoke', async ({ id }, cb) => {
      const store = requireRbac();
      identita.assertTenantAdmin(socketContext.principal);
      await store.revokeApiKey(socketContext.principal.ownerId, id);
      cb({ ok: true });
    });
  }

  return registra;
}

module.exports = { createModule };
