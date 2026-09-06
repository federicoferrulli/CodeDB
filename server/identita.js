'use strict';

// CodeDB — identita. Stato e dipendenze appartengono alla singola istanza.
const { ROOT_PRINCIPAL, rbacOn } = require('../auth/principal');
const { can, canUseConnection, canWholeConnection, canAdminTenant, isInstallAdmin } = require('../auth/permissions');
const express = require('express');

function createModule({ config, trasporto, audit, errori, dependencies }) {
  /* ---------------------------------------------------------------------------
   * Autenticazione e RBAC multi-utente (flag CODEDB_RBAC)
   *
   * Spento (default, e sempre nell'app desktop Electron): ogni richiesta viaggia
   * con ROOT_PRINCIPAL e `can()` risponde sempre true. Le strategie restano
   * avvolte per applicare le invarianti MongoDB indipendenti dai grant.
   *
   * Acceso: serve un control plane MongoDB (CODEDB_APP_DB_URI) con utenti, ruoli,
   * grant, API key e sessioni. La UI si autentica con un token opaco
   * (POST /auth/login → handshake Socket.IO), i client MCP con una API key.
   * ------------------------------------------------------------------------- */

  /** @type {import('../auth/AppStore').AppStore|null} */
  let appStore = null;

  let entitlements = null;
  let inChiusura = false;
  const richieste = new Set();

  function track(promise) {
    richieste.add(promise);
    promise.then(() => richieste.delete(promise), () => richieste.delete(promise));
    return promise;
  }
  function beginShutdown() { inChiusura = true; }
  async function drain() { while (richieste.size) await Promise.allSettled([...richieste]); }
  function richiestaHttp(handler) {
    return (req, res, next) => {
      if (inChiusura) return res.status(503).json({ ok: false, error: 'Server in chiusura.' });
      track(Promise.resolve().then(() => handler(req, res))).catch(next);
    };
  }

  function requireStore() {
    if (!appStore) throw new Error('Control plane non disponibile: RBAC non inizializzato.');
    return appStore;
  }

  // Il principal di una richiesta: con RBAC spento è sempre l'owner locale.
  function principalOf(carrier) {
    return (carrier && carrier.principal) || ROOT_PRINCIPAL;
  }

  /**
   * Chiude SUBITO i socket di un soggetto.
   *
   * Cancellare la riga della sessione nel control plane non tocca una connessione
   * WebSocket già stabilita: il principal era risolto una volta sola
   * nell'handshake, quindi una scheda lasciata aperta continuava a leggere,
   * scrivere ed eseguire DDL con i permessi di prima — e Socket.IO si riconnette
   * da sé, quindi poteva durare giorni. La ri-validazione periodica del socket
   * (`rivalidaPrincipal`) chiude comunque la finestra, ma qui la revoca passa da
   * questa istanza e non c'è ragione di far aspettare mezzo minuto.
   *
   * Le sessioni DB aperte dal socket vengono chiuse dal suo handler `disconnect`.
   */
  function disconnettiSocketDi(userId, motivo) {
    if (!config.rbacOn() || !userId) return 0;
    let chiusi = 0;
    for (const s of trasporto.io.sockets.sockets.values()) {
      if (s.principal && String(s.principal.id) === String(userId)) {
        s.disconnect(true);
        chiusi++;
      }
    }
    if (chiusi) console.log(`[Auth] ${chiusi} socket chiusi per l'utente "${userId}" (${motivo}).`);
    return chiusi;
  }

  /**
   * Rimuove i grant che puntano al nome di una connessione prima che quel nome
   * venga eliminato o riutilizzato e chiude i socket dei soggetti coinvolti.
   * L'owner che sta eseguendo il comando non è un subject dei grant e conserva
   * quindi il proprio socket fino all'ack.
   */
  async function revocaAccessiConnessione(ownerId, connName, motivo) {
    if (!config.rbacOn()) return { deleted: 0, subjectIds: [] };
    const result = await requireStore().revokeGrantsForConnection(ownerId, connName);
    for (const subjectId of result.subjectIds) {
      // Difesa per eventuali grant owner legacy: la revoca va eseguita, ma il
      // socket dell'owner deve restare vivo per ricevere l'ack dell'operazione.
      if (String(subjectId) !== String(ownerId)) disconnettiSocketDi(subjectId, motivo);
    }
    return result;
  }

  // Connessioni salvate e grant vivono in due storage diversi. Serializzare per
  // tenant delete/rename e grants:set chiude la finestra in cui un grant potrebbe
  // essere reinserito sul vecchio nome fra la revoca e il salvataggio del file.
  const connectionAclLocks = new Map();

  function withConnectionAclLock(ownerId, fn) {
    const key = String(ownerId || '');
    const previous = connectionAclLocks.get(key) || Promise.resolve();
    const current = previous.then(fn, fn);
    const tail = current.then(() => {}, () => {});
    connectionAclLocks.set(key, tail);
    return current.finally(() => {
      if (connectionAclLocks.get(key) === tail) connectionAclLocks.delete(key);
    });
  }

  async function resolvePrincipalFromToken(token) {
    if (!config.rbacOn()) return ROOT_PRINCIPAL;
    if (!appStore || !token) return null;
    return appStore.resolveSession(token).catch(() => null);
  }

  async function resolvePrincipalFromApiKey(key) {
    if (!config.rbacOn()) return ROOT_PRINCIPAL;
    if (!appStore || !key) return null;
    return appStore.resolveApiKey(key).catch(() => null);
  }

  /** Vista pubblica del principal per il frontend (mai segreti). */
  function principalView(principal) {
    return {
      id: principal.id,
      type: principal.type,
      email: principal.email,
      displayName: principal.displayName,
      owner: !!(principal.owner || principal.root),
      rbac: config.rbacOn(),
      capabilities: principal.capabilities || [],
      tenantCapabilities: principal.tenantCapabilities || [],
      grants: (principal.grants || []).map((g) => ({ connName: g.connName, role: g.role, capabilities: g.capabilities, scope: g.scope })),
    };
  }

  // Gate storico delle operazioni riservate all'owner del tenant (connessioni,
  // backup, aggiornamenti). La delega amministrativa NON amplia questo perimetro.
  function assertManage(principal) {
    if (principal.root || principal.owner) return;
    throw new Error('Permesso negato: operazione riservata all\'owner del tenant.');
  }

  // Gate delegabile soltanto per utenti, ruoli, grant, API key e preferenze
  // condivise: è indipendente dalle capability assegnate sulle connessioni.
  function assertTenantAdmin(principal) {
    if (canAdminTenant(principal)) return;
    throw new Error('Permesso negato: operazione riservata all\'amministratore del tenant.');
  }

  /**
   * Gate delle operazioni che toccano l'INSTALLAZIONE e non un singolo tenant.
   * La decisione vive in auth/permissions.js (`isInstallAdmin`, provata in Node):
   * qui resta solo il messaggio, che deve dire cosa fare.
   */
  function assertInstallAdmin(principal, cosa) {
    if (isInstallAdmin(principal, config.env)) return;
    throw new Error(
      `Permesso negato: ${cosa} riguarda l'intera installazione (la chiave dei segreti e le connessioni salvate di TUTTI gli account), ` +
      'quindi è riservata a chi la amministra. Cosa fare: eseguila dall\'account indicato in CODEDB_OWNER_EMAIL, ' +
      'oppure elenca gli amministratori abilitati in CODEDB_VAULT_ADMINS e riavvia il server.',
    );
  }

  /**
   * Autorizza l'apertura (o il test) di una connessione al database.
   * - connessione salvata → serve un grant su quel nome;
   * - connessione "a mano" o salvataggio di una nuova (saveAs) → serve `manage`,
   *   perché significa introdurre credenziali nuove nell'istanza.
   */
  function assertConnAllowed(principal, cfg, connName) {
    if (principal.root) return;
    if (String((cfg && cfg.saveAs) || '').trim()) {
      assertManage(principal);
      return;
    }
    if (!connName) {
      if (!principal.owner) {
        throw new Error('Permesso negato: puoi aprire solo le connessioni salvate assegnate al tuo utente.');
      }
      return;
    }
    if (!canUseConnection(principal, connName)) {
      throw new Error(`Permesso negato: nessun accesso alla connessione "${connName}".`);
    }
  }

  /**
   * Autorizza un'operazione che agisce sull'intera connessione senza passare dai
   * metodi della strategia (backup): serve la capability e nessuno scope, perché
   * su questo percorso lo scope non sarebbe applicabile.
   */
  function assertWholeConnection(principal, connName, capability, what) {
    if (principal.root) return;
    if (!canWholeConnection(principal, connName, capability)) {
      throw new Error(`Permesso negato: non hai i privilegi per ${what} su questa connessione.`);
    }
  }

  // Freno agli attacchi a forza bruta sul login: 5 tentativi falliti per IP, poi
  // un minuto di attesa. In memoria: sufficiente per un'istanza singola.
  const LOGIN_MAX_ATTEMPTS = 5;

  const LOGIN_LOCK_MS = 60 * 1000;

  const loginAttempts = new Map();

  function loginBlocked(ip) {
    const entry = loginAttempts.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.last > LOGIN_LOCK_MS) {
      loginAttempts.delete(ip);
      return false;
    }
    return entry.count >= LOGIN_MAX_ATTEMPTS;
  }

  function noteLoginFailure(ip) {
    const entry = loginAttempts.get(ip) || { count: 0, last: 0 };
    entry.count += 1;
    entry.last = Date.now();
    loginAttempts.set(ip, entry);
    potaLoginAttempts();
  }

  // Potatura della mappa dei tentativi (CDB-19). Senza, `loginAttempts` cresce di
  // una voce per ogni indirizzo che sbaglia una password e non la si rilascia mai:
  // le voci vengono cancellate solo quando QUELLO STESSO indirizzo torna a tentare
  // dopo la scadenza, cioè quasi mai per un attacco distribuito. È un consumo di
  // memoria illimitato comandato dall'esterno.
  const LOGIN_ATTEMPTS_MAX = 10000;

  function potaLoginAttempts() {
    if (loginAttempts.size <= LOGIN_ATTEMPTS_MAX) {
      // Potatura ordinaria: si buttano le voci ormai scadute (costa poco perché
      // scatta solo su un fallimento di login, non su ogni richiesta).
      const limite = Date.now() - LOGIN_LOCK_MS;
      for (const [k, v] of loginAttempts) {
        if (v.last < limite) loginAttempts.delete(k);
      }
      return;
    }
    // Oltre il tetto: la mappa è sotto pressione, si riparte da zero. Perdere lo
    // storico dei tentativi è meno grave che esaurire la memoria del processo, e
    // il blocco si ricostruisce in cinque tentativi.
    loginAttempts.clear();
  }

  // Login/logout via HTTP (non via socket): così il gate dell'handshake resta una
  // regola secca — nessun evento è raggiungibile senza essere già autenticati.
  trasporto.app.post('/auth/login', express.json({ limit: '16kb' }), richiestaHttp(async (req, res) => {
    if (!config.rbacOn()) {
      res.json({ ok: true, rbac: false, token: null, user: principalView(ROOT_PRINCIPAL) });
      return;
    }
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    if (loginBlocked(ip)) {
      res.status(429).json({ ok: false, error: 'Troppi tentativi di accesso falliti: riprova tra un minuto.' });
      return;
    }
    const email = String((req.body && req.body.email) || '').trim();
    const password = String((req.body && req.body.password) || '');
    try {
      // Prima l'owner (identità verificata dall'Entitlement Provider, cioè dal
      // sistema di billing in SaaS), poi i sottoutenti locali del control plane.
      let user = await entitlements.verifyOwner({ email, password });
      if (!user) user = await appStore.verifySubUser(email, password);
      if (!user) {
        noteLoginFailure(ip);
        res.status(401).json({ ok: false, error: 'Email o password non validi.' });
        return;
      }
      loginAttempts.delete(ip);
      const token = await appStore.createSession(user);
      const principal = await appStore.principalFor(user);
      audit.auditUi({ event: 'auth:login', category: 'write', status: 'ok', op: 'Accesso utente', ...audit.auditActor(principal), client: ip });
      res.json({ ok: true, rbac: true, token, user: principalView(principal) });
    } catch (err) {
      // Email presente su più tenant con la stessa password: non è un errore
      // interno ma una richiesta ambigua, e va detto all'utente invece di
      // restituire un 500 opaco (o, peggio, farlo entrare nel tenant sbagliato).
      if (err && err.ambiguousLogin) {
        noteLoginFailure(ip);
        res.status(409).json({ ok: false, error: errori.errMsg(err) });
        return;
      }
      res.status(500).json({ ok: false, error: errori.errMsg(err) });
    }
  }));

  trasporto.app.post('/auth/logout', express.json({ limit: '16kb' }), richiestaHttp(async (req, res) => {
    const token = String((req.body && req.body.token) || '') || bearerToken(req);
    if (config.rbacOn() && appStore) await appStore.deleteSession(token).catch(() => {});
    res.json({ ok: true });
  }));

  function bearerToken(req) {
    const raw = String(req.headers.authorization || '');
    const m = raw.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : '';
  }

  // Gate dell'handshake Socket.IO: nessun evento viene registrato prima che il
  // principal sia noto. È l'unico punto d'ingresso della UI.
  trasporto.io.use((socket, next) => {
    if (inChiusura) return next(new Error('Server in chiusura.'));
    track((async () => {
    if (!config.rbacOn()) {
      socket.principal = ROOT_PRINCIPAL;
      next();
      return;
    }
    const auth = socket.handshake.auth || {};
    // Le API key appartengono al dominio MCP e possono essere limitate a una
    // singola connessione. Accettarle come sessioni UI trasformerebbe quella key
    // in accesso agli eventi amministrativi del socket.
    const principal = await resolvePrincipalFromToken(auth.token);
    if (inChiusura) return next(new Error('Server in chiusura.'));
    if (!principal) {
      next(new Error('auth_required'));
      return;
    }
    socket.principal = principal;
    next();
    })()).catch(next);
  });

  async function initialize() {
    if (!config.rbacOn()) return;
    appStore = new dependencies.AppStore({ uri: config.env.CODEDB_APP_DB_URI || '', dbName: config.env.CODEDB_APP_DB_NAME || 'codedb_control' });
    await appStore.connect();
    entitlements = dependencies.createEntitlementProvider(appStore, config.env);
    const owner = await entitlements.bootstrap();
    console.log('[RBAC] Control plane pronto; owner: ' + owner.email);
  }
  async function close() { beginShutdown(); await drain(); if (appStore) await appStore.close(); }

  return {
    get entitlements() { return entitlements; },
    requireStore,
    principalOf,
    disconnettiSocketDi,
    revocaAccessiConnessione,
    withConnectionAclLock,
    resolvePrincipalFromToken,
    resolvePrincipalFromApiKey,
    principalView,
    assertManage,
    assertTenantAdmin,
    assertInstallAdmin,
    assertConnAllowed,
    assertWholeConnection,
    loginAttempts,
    loginBlocked,
    noteLoginFailure,
    initialize,
    beginShutdown,
    drain,
    close
  };
}

module.exports = { createModule };
