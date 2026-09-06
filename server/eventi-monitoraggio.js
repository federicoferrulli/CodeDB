'use strict';

// CodeDB — eventi-monitoraggio. Stato e dipendenze appartengono alla singola istanza.
const { motivoNonTerminabile, diagnosi: diagnosiSessioni } = require('../db/sessioni');

function createModule({ audit, errori, connessioni, lock, identita }) {
  function registra(socketContext, lifecycle) {
    // Storico delle operazioni critiche/di scrittura via Web UI. Non richiede una
    // connessione DB attiva: legge il file di audit lato server (ui-audit.log).
    //
    // `ui-audit.log` è unico per installazione e contiene nomi di connessione,
    // database, filtri e query di TUTTI i tenant: va quindi filtrato, non negato
    // (negarlo toglierebbe lo Storico Azioni ai sottoutenti, che è una funzione
    // legittima e utile). Il criterio è lo stesso già applicato dal Proxy alle
    // liste di navigazione — si mostra solo il consentito:
    //   · root (RBAC spento o owner locale) → tutto;
    //   · owner                             → le azioni del proprio tenant;
    //   · sottoutente                       → soltanto le proprie.
    lifecycle.amministrativo('audit:list', async (payload, cb) => {
      await audit.flushAuditUi();
      const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), 500);
      const offset = Math.max(parseInt(payload.offset, 10) || 0, 0);
      const visibility = socketContext.principal.root
        ? {}
        : { ownerId: socketContext.principal.ownerId, ...(socketContext.principal.owner ? {} : { userId: socketContext.principal.id }) };
      const { entries, total } = audit.readUiAudit({
        limit,
        offset,
        ...visibility,
        event: payload.event ? String(payload.event) : undefined,
        db: payload.db ? String(payload.db) : undefined,
        connection: payload.connection ? String(payload.connection) : undefined,
        dbType: payload.dbType ? String(payload.dbType) : undefined,
        status: payload.status ? String(payload.status) : undefined,
        category: payload.category ? String(payload.category) : undefined,
      });
      cb({ ok: true, entries, total, offset, limit });
    });

    // Stato di salute delle connessioni attive di questo socket (una per tab):
    // latenza di ping, stato del tunnel SSH e statistiche del pool. I ping vanno
    // in parallelo con un timeout, così una connessione morta non blocca il resto.
    lifecycle.safeOn('health:connections', async (_payload, cb) => {
      const entries = await Promise.all([...socketContext.sessions.entries()].map(async ([tabId, sess]) => {
        const entry = {
          tabId,
          label: sess.label || null,
          connName: sess.connName || null,
          dbType: sess.dbType || (sess.strategy && sess.strategy.type) || null,
          ssh: sess.tunnel
            ? { active: true, alive: !!sess.tunnel.alive, host: sess.tunnel.host, port: sess.tunnel.port, lastError: sess.tunnel.lastError || null }
            : { active: false },
        };
        const checkPing = async () => {
          const h = await errori.withTimeout(sess.strategy.health(), 5000, 'Ping');
          entry.status = 'ok';
          entry.latencyMs = h.latencyMs;
          entry.pool = h.pool || null;
          if (h.extra) entry.extra = h.extra;
        };

        if (sess.tunnel && !sess.tunnel.alive) {
          if (sess.effectiveCfg) {
            try {
              await connessioni.reconnectSession(sess);
              await checkPing();
              entry.ssh = sess.tunnel
                ? { active: true, alive: !!sess.tunnel.alive, host: sess.tunnel.host, port: sess.tunnel.port }
                : { active: false };
              return entry;
            } catch (recErr) {
              entry.status = 'error';
              entry.error = errori.errMsg(recErr);
              return entry;
            }
          } else {
            entry.status = 'error';
            entry.error = `Tunnel SSH caduto${sess.tunnel.lastError ? `: ${sess.tunnel.lastError}` : '.'}`;
            return entry;
          }
        }

        try {
          await checkPing();
        } catch (err) {
          if (connessioni.isConnectionError(err, sess) && sess.effectiveCfg) {
            try {
              await connessioni.reconnectSession(sess);
              await checkPing();
            } catch (recErr) {
              entry.status = 'error';
              entry.error = errori.errMsg(recErr);
            }
          } else {
            entry.status = 'error';
            entry.error = errori.errMsg(err);
          }
        }
        return entry;
      }));
      cb({ ok: true, connections: entries, audit: audit.statoSaluteAuditUi() });
    });

    /* --- Monitor delle sessioni del SERVER di database ------------------------
     * Vicino a `health:connections` ma di natura diversa, e la differenza è il
     * motivo per cui sono due pannelli e non uno: là si guardano le connessioni
     * di CodeDB (le nostre), qui TUTTE quelle del server — comprese quelle di
     * altre applicazioni, di altri sviluppatori e dei processi di servizio.
     *
     * Perché non passano da `delegate()`: quello risolve la capability con lo
     * scope db/collezione, che qui non ha alcun bersaglio da confrontare (una
     * sessione non appartiene a un database in modo stabile — cambia con USE, e
     * su MongoDB un'operazione può toccarne più d'uno). Vale quindi la stessa
     * regola di backup: capability sull'INTERA connessione, senza scope.
     *
     * `read` per guardare, `manage` per terminare. La lista mostra il testo delle
     * query altrui, cioè dati fuori da qualunque scope: chiede perciò la lettura
     * sull'intera connessione, la stessa che serve a portarsela via con un
     * backup. Terminare è un'altra cosa — interrompe il lavoro di qualcun altro,
     * potenzialmente a metà di una transazione — e resta amministrazione.
     * ---------------------------------------------------------------------- */
    lifecycle.safeOn('db:sessions', async (payload, cb) => {
      const tabId = lock.normTabId(payload.tabId);
      const sess = socketContext.sessions.get(tabId);
      if (!sess) throw new Error('Nessuna connessione attiva per questo tab.');
      identita.assertWholeConnection(socketContext.principal, sess.connName, 'read', 'vedere le sessioni attive sul server');

      const res = await sess.strategy.listSessions();
      // Il MOTIVO per cui una riga non è terminabile lo calcola il server e lo
      // manda già scritto, invece di lasciare che il client riapplichi le stesse
      // regole: sarebbe una seconda copia di `motivoNonTerminabile`, cioè due
      // idee di "cosa si può uccidere" destinate a divergere alla prima
      // correzione — con l'interfaccia dalla parte sbagliata (offre, e il
      // server rifiuta) oppure, peggio, il contrario.
      const capacita = res.capacita || {};
      res.sessioni = (res.sessioni || []).map((s) => ({
        ...s,
        blocchi: {
          query: motivoNonTerminabile(s, 'query', capacita),
          connessione: motivoNonTerminabile(s, 'connessione', capacita),
        },
      }));
      // Il verdetto ("chi sta bloccando cosa, e su quale riga agire") si calcola
      // DOPO i blocchi, perché l'azione che propone dev'essere un'azione
      // possibile: suggerire di terminare una connessione di CodeDB o un
      // processo di servizio sarebbe il consiglio peggiore del pannello.
      res.diagnosi = diagnosiSessioni(res.sessioni);
      // Lettura di dati altrui: va nello Storico Azioni come le altre letture
      // esplicite. L'auto-refresh del pannello arriva marcato `_bg` e non viene
      // registrato, altrimenti un pannello lasciato aperto riempirebbe il log.
      if (!payload._bg) {
        audit.auditWrite(sess, 'db:sessions', {}, { op: 'Elenco sessioni del server' }, 'ok',
          { count: (res.sessioni || []).length }, null, 'read');
      }
      cb({ ok: true, ...res });
    });

    lifecycle.safeOn('db:killSession', async (payload, cb) => {
      const tabId = lock.normTabId(payload.tabId);
      const sess = socketContext.sessions.get(tabId);
      if (!sess) throw new Error('Nessuna connessione attiva per questo tab.');
      identita.assertWholeConnection(socketContext.principal, sess.connName, 'manage', 'terminare le sessioni sul server');

      const id = String(payload.id == null ? '' : payload.id).trim();
      if (!id) throw new Error('Id della sessione da terminare mancante.');
      const modo = payload.modo === 'connessione' ? 'connessione' : 'query';
      const identitaOsservata = payload.identita == null ? null : String(payload.identita);
      if (!identitaOsservata) {
        throw new Error('Identità stabile della sessione mancante: aggiorna il monitor e ripeti la conferma.');
      }

      // Le regole su cosa NON si può terminare (connessioni di CodeDB, processi
      // di servizio del DBMS) vengono riapplicate QUI sullo stato corrente del
      // server, non prese per buone dal client: nell'interfaccia servono a
      // disabilitare un pulsante, qui sono la barriera vera — un evento socket
      // costruito a mano non passa dai pulsanti. Rileggere la lista costa una
      // query e RESTRINGE anche la finestra fra il disegno della tabella e il
      // clic, in cui quel pid può essere già stato riassegnato a un altro
      // processo: non la chiude — fra questa lettura e il kill resta un istante,
      // e nessun DBMS offre un "termina la sessione X solo se è ancora quella
      // che ho visto". Il rischio residuo è quello di qualunque `kill` per pid.
      const stato = await sess.strategy.listSessions();
      const bersaglio = (stato.sessioni || []).find((s) => String(s.id) === id);
      const motivo = motivoNonTerminabile(bersaglio, modo, stato.capacita || {});
      if (motivo) throw new Error(motivo);
      if (bersaglio.identita !== identitaOsservata) {
        throw new Error('La sessione è cambiata dopo la conferma: aggiorna il monitor prima di riprovare.');
      }

      try {
        const res = await sess.strategy.killSession(id, modo, identitaOsservata);
        audit.auditWrite(sess, 'db:killSession', { db: bersaglio.db }, {
          op: modo === 'connessione' ? 'Terminazione connessione DB' : 'Annullamento query altrui',
          sessionId: id,
          sessionUser: bersaglio.utente || null,
          sessionQuery: bersaglio.query ? bersaglio.query.slice(0, 500) : null,
        }, 'ok', null, null);
        cb({ ok: true, ...res });
      } catch (err) {
        audit.auditWrite(sess, 'db:killSession', { db: bersaglio.db }, {
          op: modo === 'connessione' ? 'Terminazione connessione DB' : 'Annullamento query altrui',
          sessionId: id,
        }, 'error', null, err);
        throw err;
      }
    });
  }

  return registra;
}

module.exports = { createModule };
