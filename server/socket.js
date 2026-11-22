'use strict';

// CodeDB — socket. Stato e dipendenze appartengono alla singola istanza.
const { eventCapability } = require('../auth/capabilities');
const { invalidaSnapshot } = require('../db/schemaSnapshot');
const { can } = require('../auth/permissions');
const { payloadEsecuzione } = require('../db/payloadEsecuzione');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const ATTESA_RIPRESA_MS = 10 * 60 * 1000;
const CADUTA_TRASPORTO = new Set(['transport close', 'transport error', 'ping timeout', 'forced close']);

function createModule({ identita, trasporto, budget, config, connessioni, lock, errori, query, audit, registratori, now = Date.now }) {
  const contesti = new Set();
  const recuperabili = new Map();
  const pendenti = new Set();
  let inChiusura = false;
  function track(promise) {
    const p = Promise.resolve(promise);
    pendenti.add(p);
    p.then(() => pendenti.delete(p), () => pendenti.delete(p));
    return p;
  }

  function interrompiQuery(sess) {
    const attive = new Set(sess.inflight?.values());
    for (const run of sess.scripts?.values() || []) {
      const handle = run.currentStatement?.opHandle;
      if (handle) attive.add(handle);
      run.abort();
    }
    return Promise.allSettled([...attive].map(async handle => {
      if (handle.interrotto) return;
      handle.interrotto = true;
      if (handle.cancelMongosh) await handle.cancelMongosh();
      else await sess.strategy?.cancelQuery?.(handle);
    }));
  }

  function beginShutdown() {
    inChiusura = true;
    for (const ctx of contesti) for (const sess of ctx.sessions.values()) {
      if (ctx.timerRipresa) track(interrompiQuery(sess));
      else if (sess.scripts) for (const run of sess.scripts.values()) run.abort();
      if (sess.mongosh) track(sess.mongosh.close());
      sess.cancelReconnectWait?.();
    }
  }
  async function drain() { while (pendenti.size) await Promise.allSettled([...pendenti]); }
  async function close() {
    for (const ctx of contesti) clearTimeout(ctx.timerRipresa);
    recuperabili.clear();
    await Promise.allSettled([...contesti].map(ctx => ctx.socket.closeAllSessions()));
    await drain();
    contesti.clear();
  }

  function terminaContesto(ctx) {
    clearTimeout(ctx.timerRipresa);
    if (recuperabili.get(ctx.chiave) === ctx) recuperabili.delete(ctx.chiave);
    track(ctx.socket.closeAllSessions().finally(() => contesti.delete(ctx))).catch(err => {
      console.error('[Sessioni] Errore chiudendo le sessioni del socket:', errori.errMsg(err));
    });
  }

  function chiudiSessioniSospese(userId) {
    for (const ctx of recuperabili.values()) {
      if (ctx.timerRipresa && String(ctx.principal.id) === String(userId)) terminaContesto(ctx);
    }
  }

  function chiudiLogin(token) {
    if (!token) return;
    for (const ctx of contesti) {
      if (ctx.socket.handshake.auth?.token !== token) continue;
      if (ctx.timerRipresa) terminaContesto(ctx);
      else ctx.socket.disconnect(true);
    }
  }

  /* ---------------------------------------------------------------------------
   * IL CONTESTO DELLA SESSIONE SOCKET.
   *
   * Tutto ciò che un socket porta con sé — chi è l'utente, quali sessioni di
   * database ha aperte, da quale indirizzo arriva — stava dentro una chiusura
   * anonima di duemiladuecento righe, e per questo non esisteva alcun punto in
   * cui sostituirlo. La conseguenza si vedeva nei test, ridotti a leggere
   * server.js come TESTO e a bilanciare le graffe con un'espressione regolare: è
   * così che è stato scoperto uno scambio fra due variabili omonime che uccideva
   * l'intero esecutore di script a ogni invocazione, vissuto a lungo perché quel
   * percorso non ha test.
   *
   * Ora il contesto è un ARGOMENTO. `registraEventi(ctx)` si può chiamare con un
   * socket finto, sessioni finte e un principal finto, e da lì invocare qualunque
   * handler senza aprire né un socket vero né una connessione a un database
   * (vedi test/contesto-finto.js).
   * ------------------------------------------------------------------------- */

  /**
   * Il contesto di un socket appena connesso.
   *
   * @param {import('socket.io').Socket} socket
   * @returns {{ socket: object, ip: string, principal: object, sessions: Map }}
   */
  function creaContestoSocket(socket) {
    return {
      socket,
      sessionId: socket.id,
      ip: socket.request ? trasporto.ipClient(socket.request) : socket.handshake.address,
      // Chi è l'utente di questo socket: risolto dal gate dell'handshake
      // (io.use). Con RBAC spento è l'owner locale e nessun controllo ha effetto.
      // È MUTABILE: `rivalidaPrincipal` lo sostituisce quando i grant cambiano.
      principal: identita.principalOf(socket),
      /** @type {Map<string, { strategy: import('../db/DbStrategy'), tunnel: { close: () => void }|null }>} */
      sessions: new Map(),
    };
  }

  trasporto.io.on('connection', (socket) => {
    if (inChiusura) { socket.disconnect(true); return; }
    const nuovo = creaContestoSocket(socket);
    const { ip, principal } = nuovo;
    const currentSocketsForIp = budget.ipConnections.get(ip) || 0;

    // Controllo limiti connessioni WebSocket
    if (trasporto.io.engine.clientsCount > budget.MAX_GLOBAL_SOCKETS) {
      console.warn(`Rifiutata connessione WebSocket: raggiunto limite globale di ${budget.MAX_GLOBAL_SOCKETS}.`);
      socket.disconnect(true);
      return;
    }
    if (currentSocketsForIp >= budget.MAX_SOCKETS_PER_IP) {
      console.warn(`Rifiutata connessione WebSocket da IP ${ip}: raggiunto limite per IP di ${budget.MAX_SOCKETS_PER_IP}.`);
      socket.disconnect(true);
      return;
    }
    budget.ipConnections.set(ip, currentSocketsForIp + 1);

    const auth = socket.handshake.auth || {};
    if (typeof auth.recoveryKey === 'string' && /^[a-f0-9]{32}$/.test(auth.recoveryKey)) {
      nuovo.chiave = createHash('sha256').update(JSON.stringify([principal.ownerId, principal.id, auth.token || '', auth.recoveryKey])).digest('hex');
      const prima = recuperabili.get(nuovo.chiave);
      if (prima) {
        // Il client può avere già rilevato la caduta mentre il server aspetta ancora il ping.
        if (!prima.timerRipresa) {
          prima.sostituito = true;
          prima.socket.disconnect(true);
        }
        if (prima.timerRipresa && now() < prima.scadenza && isDeepStrictEqual(prima.principal, principal)) {
          clearTimeout(prima.timerRipresa);
          Object.assign(prima, { socket, ip, principal, timerRipresa: null, sostituito: false });
          for (const sess of prima.sessions.values()) {
            sess.ip = ip;
            sess.principal = principal;
            if (sess.guardCtx) sess.guardCtx.principal = principal;
          }
          registraEventi(prima, true);
          return;
        }
        if (prima.timerRipresa) terminaContesto(prima);
      }
      recuperabili.set(nuovo.chiave, nuovo);
    }
    registraEventi(nuovo);
  });

  function registraEventi(ctx, recuperato = false) {
    if (inChiusura) throw new Error('Server in chiusura.');
    if (contesti.has(ctx) && !recuperato) throw new Error('Eventi già registrati per questo contesto.');
    contesti.add(ctx);

    const { socket, ip, sessions } = ctx;

    const REVALIDA_PRINCIPAL_MS = Math.max(parseInt(config.env.CODEDB_REVALIDATE_PRINCIPAL_MS, 10) || 30000, 100);
    let ultimaRivalida = now();
    let verifica;
    let revocata = false;
    function rivalidaPrincipal(forza = false) {
      if (!config.rbacOn()) return Promise.resolve(true);
      if (revocata) return Promise.resolve(false);
      if (verifica) return verifica;
      if (!forza && now() - ultimaRivalida < REVALIDA_PRINCIPAL_MS) return Promise.resolve(true);
      verifica = (async () => {
        const fresco = await identita.resolvePrincipalFromToken((socket.handshake.auth || {}).token);
        if (socketClosed && ctx.socket !== socket) return false;
        if (!fresco) { revocata = true; return false; }
        ctx.principal = socket.principal = fresco;
        for (const sess of sessions.values()) {
          sess.principal = fresco;
          if (sess.guardCtx) sess.guardCtx.principal = fresco;
          if (sess.mongosh && !require('../auth/permissions').isInstallAdmin(fresco, config.env)) await sess.mongosh.close();
        }
        ultimaRivalida = now();
        return true;
      })().finally(() => { verifica = null; });
      return verifica;
    }

    function acquisisciLeaseOperazione(sess) {
      sess.operationLeases = (sess.operationLeases || 0) + 1;
    }

    async function rilasciaLeaseOperazione(sess) {
      sess.operationLeases = Math.max(0, (sess.operationLeases || 1) - 1);
      if (sess.detachedForOperation && sess.operationLeases === 0 && !sess.closed) {
        sess.closed = true;
        await finalizzaSessione(sess);
      }
    }

    async function finalizzaSessione(sess) {
      try {
        sess.closeScriptUploads?.();
        await interrompiQuery(sess);
        await sess.mongosh?.close();
        if (sess.scripts) {
          await Promise.allSettled([...sess.scripts.values()].map(run => run.completion));
          sess.scripts.clear();
        }
        if (sess.depositi) {
          await Promise.allSettled([...sess.depositi.values()].map(dep => dep.elimina()));
          sess.depositi.clear();
        }
        await connessioni.teardownConnection(sess);
      } finally { sess.releaseGlobalSession?.(); }
    }

    async function closeSession(tabId) {
      const sess = sessions.get(tabId);
      if (!sess) return;
      // Rimuovi prima di await: evita doppie chiusure su chiamate concorrenti.
      sessions.delete(tabId);

      // Un'operazione lunga già accettata possiede una lease della sessione:
      // chiudere il tab stacca la UI ma non spegne il driver sotto un lavoro vivo.
      if (sess.operationLeases > 0) {
        sess.detachedForOperation = true;
        return;
      }
      sess.closed = true;
      if (typeof sess.cancelReconnectWait === 'function') sess.cancelReconnectWait();
      await finalizzaSessione(sess);
    }

    async function closeAllSessions() {
      await Promise.allSettled([...sessions.keys()].map(closeSession));
    }

    socket.closeAllSessions = closeAllSessions;

    // Anche dopo il cambio di trasporto, apertura e chiusura del tab condividono il lock.
    const withConnectLock = ctx.withConnectLock ||= lock.makeConnectLocks();

    // Il socket può cadere mentre una connessione è ancora in apertura: in quel
    // caso `closeAllSessions()` non la vede (non è ancora nella mappa) e resterebbe
    // orfana. Il flag permette a `mongo:connect` di accorgersene e smontarla.
    let socketClosed = false;

    socket.on('disconnect', () => { socketClosed = true; });

    // Registrazione sicura di un evento: payload sempre oggetto e ack sempre
    // funzione monouso — un client senza callback o con payload malformato non
    // deve mai abbattere il processo. Gli errori del handler, sincroni o async,
    // diventano la risposta { ok: false, error }.
    const eventi = new Set();
    function safeOn(event, fn) {
      if (eventi.has(event)) throw new Error('Evento già registrato: ' + event);
      eventi.add(event);
      socket.on(event, (payload, ack) => track((async () => {
        let done = false;
        const cb = res => {
          if (done) return;
          done = true;
          if (typeof ack === 'function') ack(res);
        };
        try {
          if (inChiusura || socketClosed) throw new Error('Sessione chiusa o server in arresto.');
          if (!(await rivalidaPrincipal())) {
            cb({ ok: false, error: 'Sessione non più valida: accedi di nuovo.' });
            setTimeout(() => socket.disconnect(true), 0);
            return;
          }
          if (socketClosed || inChiusura) throw new Error('Sessione chiusa o server in arresto.');
          if (payload != null && (typeof payload !== 'object' || Array.isArray(payload))) {
            throw new Error('Payload non valido: è richiesto un oggetto.');
          }
          if (payload?.dbSessionId != null && sessions.get(lock.normTabId(payload.tabId))?.dbSessionId !== payload.dbSessionId) {
            throw new Error('La sessione del database è cambiata. Verifica le istruzioni già applicate prima di ripeterle.');
          }
          await fn(payload || {}, cb, ctx);
        } catch (err) {
          // Solo la prima impronta SSH è approvabile: mai una chiave cambiata.
          const ssh = ['mongo:connect', 'connections:test'].includes(event) && err?.code === 'SSH_HOST_KEY_UNKNOWN'
            ? { code: err.code, sshHostKey: err.sshHostKey } : {};
          const queryError = event === 'query:execute' && err.queryError ? { queryError: err.queryError } : {};
          const key = /^SSH_(?:KEY|AGENT|NATIVE)_/.test(err?.code || '') ? { code: err.code } : {};
          cb({ ok: false, error: errori.errMsg(err), ...ssh, ...key, ...queryError });
        }
      })()));
    }

    // Registra un evento che delega alla strategia della sessione indicata dal
    // tabId nel payload e adatta il risultato (o l'errore) al formato di
    // risposta { ok, ... } usato dal frontend.
    function delegate(event, fn) {
      safeOn(event, async (payload, cb) => {
        // Campi che SOLO il server può impostare: arrivano fino alle strategie
        // insieme al resto del payload, quindi vanno rimossi da ciò che manda il
        // client. `maxRows` alza il tetto dei risultati fino a 100.000 documenti
        // (DbStrategy.resultCap): pensato per il Query Engine, che lo imposta lato
        // server, ma nulla impediva a un client di metterlo in una normale
        // collection:find e farsi serializzare centinaia di MB per socket e per
        // tab — memoria del processo esaurita in poche richieste.
        for (const serverOnly of query.SERVER_ONLY_PAYLOAD_FIELDS) delete payload[serverOnly];

        const sess = sessions.get(lock.normTabId(payload.tabId));
        if (!sess) {
          cb({ ok: false, error: errori.errMsg('Nessuna connessione attiva al database.') });
          return;
        }
        // Classificazione (scrittura/lettura/non tracciato) per l'audit: dipende
        // da evento, payload e strategia (vedi collection:aggregate).
        const cls = audit.classifyAudit(event, payload, sess);
        // Pre-check dei permessi: il Proxy autorizzante sulla strategia coprirebbe
        // comunque l'operazione, ma qui l'errore arriva prima di toccare il DB e
        // nomina l'evento richiesto.
        const capability = eventCapability(event, payload, sess);
        if (!can(ctx.principal, { connName: sess.connName, capability, db: payload.db, coll: payload.coll })) {
          cb({ ok: false, error: `Permesso negato: non hai i privilegi per l'operazione "${event}" su questa connessione.` });
          return;
        }
        // Query annullabili della griglia: se il payload porta un runId, registra
        // un opHandle in sess.inflight così `query:cancel` può fermare la lettura
        // in corso (killOp / KILL QUERY / pg_cancel_backend — nessuna modifica ai
        // dati). La strategia vi scrive connectionId/processID/comment.
        const runId = payload.runId;
        let opHandle;
        if (runId) {
          if (!sess.inflight) sess.inflight = new Map();
          opHandle = { runId };
          sess.inflight.set(runId, opHandle);
        }
        // Ciò che arriva alla strategia passa dalla stessa regola dichiarata del
        // gestore `query:execute` (db/payloadEsecuzione.js). Qui il residuo era
        // l'altra metà dell'accidente d'ordine: senza un runId non si entrava nel
        // ramo qui sopra, quindi un `opHandle` mandato dal client sopravviveva
        // fino alla strategia — che su MySQL e PostgreSQL vi legge il ramo della
        // connessione dedicata e vi scrive connectionId/processID.
        const richiesta = payloadEsecuzione(payload, { runId, opHandle });
        try {
          const result = await connessioni.executeWithReconnect(sess, (strat) => fn(strat, richiesta, sess));
          // Una DDL riuscita rende obsoleti i metadati tenuti in sessione: lo
          // snapshot dello schema si butta QUI, dalla capability, e non da un
          // elenco di nomi di evento che si dimentica di aggiornare quando ne
          // nasce uno nuovo.
          if (capability === 'ddl') invalidaSnapshot(sess);
          cb({ ok: true, ...result });
          audit.auditDelegate(cls, sess, event, payload, 'ok', result, null);
        } catch (err) {
          audit.auditDelegate(cls, sess, event, payload, 'error', null, err);
          // Se il tunnel SSH è caduto dopo l'apertura, la strategia vede solo
          // un errore di rete generico verso la porta locale ormai orfana:
          // qui lo si riconosce e si dà un messaggio chiaro invece di quello
          // del driver DB.
          if (sess.tunnel && !sess.tunnel.alive) {
            throw new Error(`Tunnel SSH caduto${sess.tunnel.lastError ? `: ${sess.tunnel.lastError}` : '.'}`);
          }
          // Contesto per il messaggio parlante (vedi errMsg): lo stesso codice ha
          // spiegazioni diverse a seconda del DBMS.
          if (err && typeof err === 'object' && !err._ctx) {
            err._ctx = { dbType: sess.dbType, db: payload.db, coll: payload.coll };
          }
          throw err;
        } finally {
          if (runId && sess.inflight) sess.inflight.delete(runId);
        }
      });
    }

    /**
     * Registra un evento AMMINISTRATIVO (ADR-0001, seconda famiglia).
     *
     * Fa una cosa sola, ed è quella che veniva dimenticata: scrive la voce di
     * audit. L'handler resta scritto come prima — riceve payload e cb — ma non
     * deve più comporre a mano `auditUi({...})`, e soprattutto non può più
     * dimenticarsene: un evento senza voce nella tabella non si registra affatto,
     * e l'errore arriva all'AVVIO, non il giorno in cui serve leggere lo storico.
     *
     * I gate d'installazione e le verifiche di amministrazione restano nei corpi
     * degli handler, dove sono sempre stati.
     */
    function amministrativo(event, fn) {
      const spec = audit.EVENTI_AMMINISTRATIVI[event];
      if (!spec) {
        throw new Error(
          `Evento amministrativo "${event}" non dichiarato in EVENTI_AMMINISTRATIVI. `
          + 'Cosa fare: aggiungi una voce con l\'etichetta da scrivere nello storico, '
          + 'oppure dichiara NON_TRACCIATO(motivo) se è una lettura senza effetti.'
        );
      }
      safeOn(event, async (payload, cb) => {
        // L'esito serve all'audit: si intercetta la risposta invece di chiedere
        // agli handler di restituirla, così nessun corpo va riscritto.
        let esito = null;
        const cbTracciata = (res) => { esito = res; cb(res); };
        try {
          await fn(payload, cbTracciata);
          scriviAuditAmministrativo(event, spec, payload, esito, null);
        } catch (err) {
          scriviAuditAmministrativo(event, spec, payload, null, err);
          throw err;
        }
      });
    }

    /**
     * Registra un'OPERAZIONE LUNGA (ADR-0001, terza famiglia).
     *
     * Non aggiunge comportamento: DICHIARA. L'evento deve comparire in
     * `OPERAZIONI_LUNGHE` con almeno un punto di estensione, e ogni punto deve
     * essere uno degli otto nominati. È l'unica cosa che impedisce a questa
     * famiglia di diventare il cassetto dove finisce ciò che non si sa dove
     * mettere: un evento che non usa nessuno degli otto non ha motivo di stare
     * qui, e va spostato in una delle altre due giunture.
     *
     * Perché non fa altro: i corpi di questi handler sono lunghi e diversissimi
     * fra loro — avanzamento, pause, depositi, interpreti — e una giuntura che
     * provasse a governarli tutti diventerebbe l'interfaccia piena di parametri
     * opzionali che ADR-0001 ha deciso di non costruire. Qui il valore è nel
     * vincolo, non nel codice condiviso.
     */
    function operazioneLunga(event, fn) {
      const punti = audit.OPERAZIONI_LUNGHE[event];
      if (!punti || !punti.length) {
        throw new Error(
          `Operazione lunga "${event}" non dichiarata in OPERAZIONI_LUNGHE. `
          + 'Cosa fare: elenca i punti di estensione che usa fra gli otto di '
          + 'PUNTI_ESTENSIONE. Se non ne usa nessuno non appartiene a questa '
          + 'famiglia: registrala con delegate() se tocca una strategia, con '
          + 'amministrativo() se non la tocca.'
        );
      }
      const sconosciuti = punti.filter((p) => !audit.PUNTI_ESTENSIONE[p]);
      if (sconosciuti.length) {
        throw new Error(
          `Operazione lunga "${event}": punti di estensione sconosciuti `
          + `(${sconosciuti.join(', ')}). Quelli previsti sono: `
          + `${Object.keys(audit.PUNTI_ESTENSIONE).join(', ')}.`
        );
      }
      safeOn(event, fn);
    }

    /** La voce di audit di un evento amministrativo, composta in un posto solo. */
    function scriviAuditAmministrativo(event, spec, payload, esito, errore) {
      if (!spec.tracciato && spec.tracciato !== undefined) return;
      try {
        audit.auditUi({
          event,
          category: 'write',
          status: errore ? 'error' : 'ok',
          op: typeof spec.op === 'function' ? spec.op(payload, esito) : (spec.op || event),
          ...audit.auditActor(ctx.principal),
          client: ip || null,
          ...(spec.bersaglio ? { target: spec.bersaglio(payload, esito) } : {}),
          ...(spec.dettagli ? { details: spec.dettagli(payload, esito) } : {}),
          ...(errore ? { error: errori.errMsg(errore) } : {}),
        });
      } catch { /* audit best-effort: non deve mai disturbare l'operazione */ }
    }

    const lifecycle = {
      recuperato,
      track,
      rivalidaPrincipal,
      acquisisciLeaseOperazione,
      rilasciaLeaseOperazione,
      closeSession,
      closeAllSessions,
      withConnectLock,
      get socketClosed() { return socketClosed; },
      safeOn,
      delegate,
      amministrativo,
      operazioneLunga,
      scriviAuditAmministrativo,
    };
    for (const registra of registratori) registra(ctx, lifecycle);
    socket.on('disconnect', motivo => {
      if (!inChiusura && !revocata && ctx.chiave && sessions.size && (ctx.sostituito || CADUTA_TRASPORTO.has(motivo))) {
        ctx.scadenza = now() + ATTESA_RIPRESA_MS;
        ctx.timerRipresa = setTimeout(() => terminaContesto(ctx), ATTESA_RIPRESA_MS);
        ctx.timerRipresa.unref();
      } else {
        terminaContesto(ctx);
      }

      const count = budget.ipConnections.get(ip);
      if (count > 1) {
        budget.ipConnections.set(ip, count - 1);
      } else {
        budget.ipConnections.delete(ip);
      }
    });
  }

  return {
    beginShutdown, drain, close, chiudiSessioniSospese, chiudiLogin,
    creaContestoSocket,
    registraEventi
  };
}

module.exports = { createModule };
