'use strict';

// CodeDB — connessioni. Stato e dipendenze appartengono alla singola istanza.
const { guardStrategy } = require('../auth/guardStrategy');

function createModule({ vault, dependencies, errori }) {
  /* ---------------------------------------------------------------------------
   * Apertura di una connessione DB (comune a mongo:connect e connections:test)
   * ------------------------------------------------------------------------- */

  // Risolve la configurazione effettiva: cfg.saved = usa una connessione salvata
  // (i parametri, password inclusa, restano lato server); cfg.keepPasswordFrom =
  // riusa i segreti di una connessione salvata quando il form li lascia vuoti
  // (non vengono mai rimandati al browser, quindi il client non può reinviarli).
  function resolveEffectiveCfg(cfg, ownerId) {
    let effective = cfg;
    // Un solo caricamento del file: sia "saved" che "keepPasswordFrom" leggono
    // dalla stessa mappa in memoria, evitando due letture/decifrature ridondanti.
    const needsLookup = cfg.saved || cfg.keepPasswordFrom;
    const conns = needsLookup ? vault.loadConnections(ownerId) : null;
    if (cfg.saved) {
      const saved = conns[cfg.saved];
      if (!saved) throw new Error(`Connessione salvata "${cfg.saved}" non trovata.`);
      effective = saved;
    }
    if (cfg.keepPasswordFrom) {
      const prev = conns[cfg.keepPasswordFrom];
      if (prev) effective = vault.preserveConnSecrets(effective, prev);
    }
    return vault.preserveConnSecrets(effective, null);
  }

  // Apre tunnel SSH (se richiesto) e connette la strategia. In caso di errore
  // chiude quanto già aperto e rilancia; altrimenti restituisce le risorse
  // aperte, la cui chiusura è a carico del chiamante (teardownConnection).
  //
  // `guardCtx` = { principal, connName }: se presente, la strategia restituita è
  // avvolta nel Proxy autorizzante, quindi ogni accesso ai dati che ne deriva —
  // griglia, Query Engine, tool MCP — è già soggetto ai permessi. Anche root passa
  // dal Proxy: `can()` gli concede tutto, ma restano attive le invarianti MongoDB
  // che vietano JavaScript lato server e validano le pipeline strutturalmente.
  async function establishConnection(cfg, guardCtx = null) {
    // Il lookup delle connessioni salvate avviene nel file del tenant richiedente
    // (guardCtx.principal.ownerId); con RBAC spento resta il file condiviso.
    const effective = resolveEffectiveCfg(cfg, guardCtx && guardCtx.principal && guardCtx.principal.ownerId);
    const dbType = vault.connDbType(effective);
    let tunnel = null;
    let strategy = null;
    try {
      // Tunnel SSH (solo in modalità "Parametri"): la strategia si connette al
      // capo locale del tunnel anziché direttamente all'host del database.
      let connectCfg = effective;
      if (vault.sshEnabled(effective)) {
        if (effective.uri && effective.uri.trim()) {
          throw new Error('Il tunnel SSH è disponibile solo in modalità "Parametri", non con URI completa.');
        }
        const target = {
          host: (effective.host || 'localhost').trim(),
          port: parseInt(effective.port, 10) || dependencies.DbFactory.defaultPort(dbType),
        };
        const savedName = String(cfg.saved || '').trim();
        tunnel = await dependencies.openSshTunnel(effective, target, {
          // ssh2 chiama questa funzione dentro hostVerifier, prima di inviare le
          // credenziali. Il test e la connessione reale passano entrambi da qui.
          persistNewHostKey: savedName ? (fingerprint) => {
            const conns = vault.loadConnections(guardCtx && guardCtx.principal && guardCtx.principal.ownerId);
            const saved = conns[savedName];
            if (!saved) throw new Error(`Connessione salvata "${savedName}" non trovata.`);
            const existing = String(saved.sshHostKey || '').trim();
            if (existing && existing !== fingerprint) throw new Error('Il pin SSH è cambiato durante la verifica.');
            saved.sshHostKey = fingerprint;
            vault.saveConnections(conns, guardCtx && guardCtx.principal && guardCtx.principal.ownerId);
            effective.sshHostKey = fingerprint;
          } : undefined,
        });
        connectCfg = { ...effective, host: tunnel.host, port: String(tunnel.port) };
        // Per MongoDB dietro tunnel: evita la topology discovery verso host del
        // replica set non raggiungibili attraverso il tunnel.
        if (dbType === 'mongodb') connectCfg.directConnection = true;
      }
      strategy = dependencies.DbFactory.getStrategy(dbType);
      await strategy.connect(connectCfg);
      return { strategy: guardStrategy(strategy, guardCtx), tunnel, effective, dbType };
    } catch (err) {
      await teardownConnection({ strategy, tunnel });
      // Destinazione reale per il messaggio parlante (vedi errMsg/safeOn): è
      // l'unico punto che la conosce — "connessione rifiutata su localhost:27017"
      // invece di un ECONNREFUSED nudo. Mai l'host del tunnel, che all'utente non
      // dice nulla: quello che ha configurato è l'host del database.
      if (err && typeof err === 'object' && !err._ctx) {
        err._ctx = {
          dbType,
          host: (effective.host || '').trim() || undefined,
          port: effective.port ? String(effective.port).trim() : undefined,
        };
      }
      throw err;
    }
  }

  async function teardownConnection({ strategy, tunnel }) {
    try {
      if (strategy) await strategy.disconnect();
    } catch { /* la rete può essere già caduta */ }
    finally {
      // Anche un errore sincrono del driver deve liberare il tunnel.
      if (tunnel) {
        try { await tunnel.close(); } catch { /* tunnel già chiuso */ }
      }
    }
  }

  /* ---------------------------------------------------------------------------
   * Riconnessione automatica in caso di perdita di connessione DB / tunnel SSH
   * ------------------------------------------------------------------------- */

  function isConnectionError(err, sess) {
    if (!err) return false;
    if (sess && sess.tunnel && !sess.tunnel.alive) return true;

    const msg = (err.message || String(err)).toLowerCase();
    const name = (err.name || '').toLowerCase();
    const code = String(err.code || '').toLowerCase();

    const connTerms = [
      'nessuna connessione attiva',
      'topology was destroyed',
      'client is closed',
      'pool is closed',
      'pool closed',
      'socket closed',
      'socket disconnected',
      'socket hang up',
      'connection closed',
      'connection terminated',
      'connection reset',
      'connection lost',
      'tunnel ssh caduto',
      'client has already been dismantled',
      'server shutdown',
      'econnreset',
      'econnrefused',
      'etimedout',
      'epipe',
      'enotfound',
      'protocol_connection_lost',
      'protocol_enqueue_after_fatal_error',
      'mongonetworkerror',
      'mongoserverselectionerror',
    ];

    return connTerms.some((term) => msg.includes(term) || name.includes(term) || code.includes(term));
  }

  async function reconnectSession(sess, maxAttempts = 14) {
    if (!sess || !sess.effectiveCfg) {
      throw new Error('Impossibile riconnettersi: configurazione di connessione non disponibile.');
    }
    const assertOpen = () => {
      if (!sess.closed) return;
      const err = new Error('Riconnessione annullata: la sessione è stata chiusa.');
      err.code = 'SESSION_CLOSED';
      throw err;
    };
    assertOpen();
    if (sess.reconnecting) {
      return sess.reconnectPromise;
    }
    sess.reconnecting = true;
    sess.reconnectPromise = (async () => {
      let lastErr = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const delayMs = Math.min(attempt * 5000, 60000);
        if (delayMs > 0) {
          console.log(`[Auto-Reconnect] Attesa di ${delayMs / 1000}s prima del tentativo ${attempt + 1}/${maxAttempts} per ${sess.label || 'sessione'}...`);
          const cancelled = await new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (sess.cancelReconnectWait === cancel) sess.cancelReconnectWait = null;
              resolve(value);
            };
            const timer = setTimeout(() => finish(false), delayMs);
            const cancel = () => finish(true);
            sess.cancelReconnectWait = cancel;
          });
          if (cancelled) assertOpen();
        } else {
          console.log(`[Auto-Reconnect] Tentativo immediato (1/${maxAttempts}) di riconnessione automatica al DB per ${sess.label || 'sessione'}...`);
        }

        try {
          assertOpen();
          await teardownConnection(sess).catch(() => {});
          assertOpen();
          // Il contesto di autorizzazione va ripassato: senza, la riconnessione
          // automatica restituirebbe una strategia non protetta dal Proxy.
          const conn = await establishConnection(sess.effectiveCfg, sess.guardCtx || null);
          if (sess.closed) {
            await teardownConnection(conn).catch(() => {});
            assertOpen();
          }
          sess.strategy = conn.strategy;
          sess.tunnel = conn.tunnel;
          sess.dbType = conn.dbType;
          sess.label = vault.connLabel(conn.effective);
          console.log(`[Auto-Reconnect] Riconnessione automatica al DB riuscita al tentativo ${attempt + 1} per ${sess.label}!`);
          return true;
        } catch (err) {
          if (sess.closed || (err && err.code === 'SESSION_CLOSED')) throw err;
          lastErr = err;
          console.warn(`[Auto-Reconnect] Tentativo ${attempt + 1}/${maxAttempts} fallito per ${sess.label || 'sessione'}: ${errori.errMsg(err, { dbType: sess.dbType })}`);
        }
      }

      console.error(`[Auto-Reconnect] Tutti i ${maxAttempts} tentativi di riconnessione automatica sono falliti per ${sess.label || 'sessione'}.`);
      throw new Error(`Connessione al database persa. Tentativo di riconnessione automatico fallito dopo ${maxAttempts} tentativi: ${lastErr ? errori.errMsg(lastErr, { dbType: sess.dbType }) : 'Errore sconosciuto'}`);
    })().finally(() => {
      sess.cancelReconnectWait = null;
      sess.reconnecting = false;
      sess.reconnectPromise = null;
    });

    return sess.reconnectPromise;
  }

  async function executeWithReconnect(sess, actionFn) {
    if (!sess || sess.closed) throw new Error('Sessione chiusa.');
    try {
      return await actionFn(sess.strategy);
    } catch (err) {
      if (err && err.importOutcomeUnknown) throw err;
      if (isConnectionError(err, sess) && sess.effectiveCfg) {
        console.warn(`[Auto-Reconnect] Rilevata perdita di connessione DB. Avvio ripristino connessione...`);
        await reconnectSession(sess);
        if (sess.closed) throw new Error('Sessione chiusa durante la riconnessione.');
        return await actionFn(sess.strategy);
      }
      throw err;
    }
  }

  return {
    establishConnection,
    teardownConnection,
    isConnectionError,
    reconnectSession,
    executeWithReconnect
  };
}

module.exports = { createModule };
