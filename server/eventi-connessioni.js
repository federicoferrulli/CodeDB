'use strict';

// CodeDB — eventi-connessioni. Stato e dipendenze appartengono alla singola istanza.

function createModule({ lock, budget, identita, connessioni, vault }) {
  function registra(socketContext, lifecycle) {
    // --- Connection -----------------------------------------------------------

    lifecycle.safeOn('mongo:connect', async (cfg, cb) => {
      if (cfg.tabId != null && String(cfg.tabId).length > 100) {
        throw new Error('tabId non valido.');
      }
      const tabId = lock.normTabId(cfg.tabId);
      // Tutto il corpo (controllo dei limiti compreso) gira dentro il lock: i
      // controlli devono vedere lo stato lasciato dall'apertura precedente.
      await lifecycle.withConnectLock(tabId, async () => {
        if (!socketContext.sessions.has(tabId) && socketContext.sessions.size >= budget.MAX_SESSIONS_PER_SOCKET) {
          throw new Error(`Raggiunto il limite di ${budget.MAX_SESSIONS_PER_SOCKET} connessioni contemporanee: chiudi un tab.`);
        }
        // Nome della connessione salvata: è la chiave su cui poggiano i permessi,
        // quindi va risolto PRIMA di aprire qualsiasi cosa.
        const connName = String(cfg.saved || cfg.saveAs || '').trim() || null;
        identita.assertConnAllowed(socketContext.principal, cfg, connName);
        const guardCtx = { principal: socketContext.principal, connName };

        // Riconnessione sullo stesso tab: chiudi prima la sessione precedente
        // (libera anche il posto nel budget globale, verificato subito dopo).
        await lifecycle.closeSession(tabId);
        if (!budget.tryAcquireGlobalSession()) {
          throw new Error(`Raggiunto il limite globale di ${budget.MAX_GLOBAL_SESSIONS} connessioni al database.`);
        }

        // Il posto nel budget si prenota PRIMA di aprire e si rilascia se
        // l'apertura fallisce: incrementare a cose fatte lasciava una finestra in
        // cui più aperture concorrenti superavano il limite, e ogni errore dopo
        // l'incremento faceva divergere il contatore dalle sessioni reali.

        let conn;
        try {
          conn = await connessioni.establishConnection(cfg, guardCtx);
        } catch (err) {
          budget.releaseGlobalSession();
          throw err;
        }
        // Socket caduto durante l'apertura: la sessione non entrerà mai nella
        // mappa, quindi va smontata qui o resterebbe orfana con il suo tunnel.
        if (lifecycle.socketClosed) {
          budget.releaseGlobalSession();
          await connessioni.teardownConnection(conn).catch(() => {});
          throw new Error('Connessione annullata: sessione chiusa.');
        }

        let released = false;
        socketContext.sessions.set(tabId, {
          releaseGlobalSession() { if (!released) { released = true; budget.releaseGlobalSession(); } },
          tabId,
          strategy: conn.strategy,
          tunnel: conn.tunnel,
          dbType: conn.dbType,
          effectiveCfg: conn.effective,
          principal: socketContext.principal,
          guardCtx,
          closed: false,
          // Metadati per l'audit delle scritture (mai segreti): etichetta mostrata
          // in UI, nome della connessione salvata (se noto) e IP del client.
          label: vault.connLabel(conn.effective),
          connName,
          ip: socketContext.ip,
        });
        // Da qui in poi il rilascio del posto spetta a closeSession.
        try {
          // cfg.saveAs = salva (o aggiorna) la connessione, solo se funzionante.
          const saveAs = String(cfg.saveAs || '').trim();
          if (saveAs) {
            vault.assertConnName(saveAs);
            const conns = vault.loadConnections(socketContext.principal.ownerId);
            conns[saveAs] = vault.sanitizeConnCfg(conn.effective);
            vault.saveConnections(conns, socketContext.principal.ownerId);
          }
          cb({
            ok: true,
            tabId,
            label: vault.connLabel(conn.effective),
            dbType: conn.dbType,
            databases: await conn.strategy.listDatabases(),
            sshHostKey: conn.tunnel ? conn.tunnel.hostKey : undefined,
            sshHostKeyNew: conn.tunnel ? !!conn.tunnel.hostKeyNew : undefined,
          });
        } catch (err) {
          await lifecycle.closeSession(tabId);
          throw err;
        }
      });
    });

    lifecycle.safeOn('mongo:disconnect', async (payload, cb) => {
      const tabId = lock.normTabId(payload.tabId);
      // Anche la chiusura passa dal lock: un disconnect che scavalcasse una
      // apertura ancora in corso non troverebbe nulla da chiudere e la sessione
      // comparirebbe subito dopo, viva sul server ma non più nella UI.
      await lifecycle.withConnectLock(tabId, () => lifecycle.closeSession(tabId));
      cb({ ok: true });
    });

    // Prova una configurazione (o una connessione salvata) senza tenere aperto
    // nulla: connect + listDatabases + disconnect. Serve al pulsante "Testa".
    lifecycle.safeOn('connections:test', async (cfg, cb) => {
      const connName = String(cfg.saved || cfg.saveAs || '').trim() || null;
      identita.assertConnAllowed(socketContext.principal, cfg, connName);
      if (!budget.tryAcquireGlobalSession()) {
        throw new Error(`Raggiunto il limite globale di ${budget.MAX_GLOBAL_SESSIONS} connessioni al database.`);
      }

      let conn = null;
      try {
        conn = await connessioni.establishConnection(cfg, { principal: socketContext.principal, connName });
        const databases = await conn.strategy.listDatabases();
        cb({ ok: true, dbType: conn.dbType, label: vault.connLabel(conn.effective), databases: databases.length });
      } finally {
        if (conn) await connessioni.teardownConnection(conn);
        budget.releaseGlobalSession();
      }
    });
  }

  return registra;
}

module.exports = { createModule };
