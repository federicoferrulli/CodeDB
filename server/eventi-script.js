'use strict';

// CodeDB — eventi-script. Stato e dipendenze appartengono alla singola istanza.
const { payloadEsecuzione } = require('../db/payloadEsecuzione');
const MongoScriptRunner = require('../db/MongoScriptRunner');
const { splitStatementsDetailed, stripSqlNoise } = require('../db/sqlText');
const { createScriptRun } = require('../db/ScriptRunner');
const { isWriteSql } = require('../auth/capabilities');

function createModule({ lock, query, audit, dependencies, errori }) {
  function registra(socketContext, lifecycle) {
    // --- Esecutore dinamico Query & Virtual JOINs -------------------------------
    lifecycle.operazioneLunga('query:execute', async (payload, cb) => {
      const tabId = lock.normTabId(payload.tabId);
      const session = socketContext.sessions.get(tabId);
      if (!session || !session.strategy) {
        throw new Error('Nessuna connessione attiva al database per questo tab.');
      }

      if (!session.inflight) session.inflight = new Map();

      const runId = payload.runId;
      const opHandle = { runId };
      if (runId) session.inflight.set(runId, opHandle);

      try {
        const esito = await query.executeQueryCode(session, payloadEsecuzione(payload, { runId, opHandle }));
        audit.auditQuery(session, esito.db, esito.coll, esito.code, esito.category, esito.op, 'ok', esito.res, null);
        return cb({ ok: true, ...esito.res, data: esito.res.docs });
      } catch (err) {
        const ctx = err.auditCtx;
        if (ctx) audit.auditQuery(session, ctx.db, ctx.coll, ctx.code, ctx.category, ctx.op, 'error', null, err);
        throw err;
      } finally {
        if (runId && session.inflight) {
          session.inflight.delete(runId);
        }
      }
    });

    /* --- Esecuzione di SCRIPT (più istruzioni) ---------------------------------
     * Uno script non viene mandato in blocco al driver: viene diviso e ESEGUITO
     * UN'ISTRUZIONE ALLA VOLTA (vedi db/ScriptRunner.js per il perché). Il run
     * vive nella sessione, quindi sopravvive all'ack: il client riceve subito
     * `{ ok, total }` e poi segue l'avanzamento con gli eventi push
     * `script:progress`, potendo mettere in pausa e riprendere dal punto esatto.
     * ------------------------------------------------------------------------- */

    // Registro dei run per sessione, con l'esito da mostrare (l'ULTIMO result set
    // prodotto: in uno script di 500 righe è quello che l'utente si aspetta di
    // vedere nella griglia dei risultati).
    function scriptsOf(session) {
      if (!session.scripts) session.scripts = new Map();
      return session.scripts;
    }

    // Depositi dei result set, uno per run. Vivono ACCANTO ai run e non dentro,
    // perché un run interrotto viene tolto subito dalla mappa mentre i suoi
    // risultati devono restare consultabili: è proprio lo script che si è fermato
    // a metà quello di cui si vuole rivedere l'ultima SELECT riuscita.
    const MAX_DEPOSITI_PER_SESSIONE = 5;

    function depositiOf(session) {
      if (!session.depositi) session.depositi = new Map();
      return session.depositi;
    }

    // Apre il deposito del run e pota i più vecchi. Il tetto non è un dettaglio:
    // senza, una sessione che lancia script tutto il giorno lascerebbe sul disco
    // ogni result set prodotto da quando è stata aperta.
    function apriDeposito(session, runId, codeStr) {
      const dep = depositiOf(session);
      const deposito = dependencies.ScriptResults.creaDeposito(codeStr);
      dep.set(runId, deposito);
      while (dep.size > MAX_DEPOSITI_PER_SESSIONE) {
        const piuVecchio = dep.keys().next().value;
        const vecchio = dep.get(piuVecchio);
        dep.delete(piuVecchio);
        if (vecchio) vecchio.elimina().catch(() => {});
      }
      return deposito;
    }

    // Il progresso è informativo e ad altissima frequenza: mandarlo per ogni
    // istruzione intaserebbe il socket su uno script da decine di migliaia di
    // righe. Si spedisce a intervalli, ma ERRORI, pause e fine passano sempre.
    function makeProgressSender(tab, run, holder) {
      let ultimoInvio = 0;
      return (ev) => {
        const importante = ev.tipo !== 'statement' || (ev.result && !ev.result.ok);
        const adesso = Date.now();
        if (!importante && adesso - ultimoInvio < query.SCRIPT_PROGRESS_MS) return;
        ultimoInvio = adesso;
        // Il RESOCONTO completo solo negli eventi terminali: allegarlo a ogni
        // avanzamento significava rispedire fino a 500 istruzioni col loro testo
        // a ogni push, e gli errori — che non vengono diradati né scartati —
        // rendevano il traffico quadratico nella lunghezza dello script (vedi
        // ScriptRunner.state). L'evento porta comunque il proprio `result`, che è
        // ciò che il pannello aggiunge al log riga per riga; chi ha bisogno del
        // resoconto intero (ripristino dopo un F5) lo chiede con `script:state`.
        const terminale = ev.tipo === 'done' || ev.tipo === 'paused' || ev.tipo === 'aborted';
        socketContext.socket.emit('script:progress', {
          tabId: tab,
          ...ev,
          stato: run.state({ conResults: terminale }),
          // L'ELENCO delle schede (non il loro contenuto) accompagna ogni evento
          // terminale: il pannello deve poter disegnare le linguette senza
          // scaricare megabyte di righe che l'utente forse non aprirà mai. Il
          // contenuto si chiede con `script:result`, una scheda alla volta.
          ...(terminale ? {
            ultimoRisultato: holder.last,
            risultati: run.deposito ? run.deposito.elenco() : null,
          } : {}),
        });
      };
    }

    // Esecutore di una singola istruzione dello script: passa dallo STESSO
    // percorso della query singola (`executeQueryCode`), quindi shell MongoDB,
    // SQL→MQL, `USE` e SQL Raw si comportano identicamente dentro e fuori da uno
    // script — e ogni istruzione attraversa il Proxy autorizzante, che decide la
    // capability guardando QUELLA istruzione.
    function makeScriptExecutor(session, ctx, holder, run) {
      return async (stmt, index) => {
        const opHandle = { runId: run.id };
        run.setOpHandle(opHandle);
        // Il registro dell'esecuzione (`run`) e il riferimento di annullamento
        // arrivano dal CONTESTO DEL SERVER, non dal payload: le operazioni di
        // scrittura lasciano un segno sul registro e la voce di audit di chiusura
        // legge quel segno per dire il vero sulla categoria (CDB-69).
        const esito = await query.executeQueryCode(session, payloadEsecuzione(
          { code: stmt.sql, engine: ctx.engine, db: ctx.db, coll: ctx.coll },
          { opHandle, run }
        ));
        // Il bersaglio può cambiare in corsa (`USE altro_db`): le istruzioni
        // successive devono seguirlo, come farebbe un client SQL.
        if (esito.res && esito.res.activeDb) ctx.db = esito.res.activeDb;
        // Ultimo RESULT SET dello script, cioè ciò che la griglia mostrerà.
        // `resultSet` lo dichiara la strategia, che è l'unica a sapere se il
        // driver ha restituito righe o un riepilogo di scrittura: senza quel
        // flag l'unico indizio erano i docs, e un `SELECT` con ZERO righe —
        // che è un risultato a tutti gli effetti — veniva scambiato per
        // "nessun risultato". La griglia continuava allora a mostrare
        // l'istruzione PRECEDENTE (il messaggio di una `USE`, il riepilogo di
        // un `INSERT`), che ha tutta l'aria di essere la risposta alla query
        // appena scritta: molto peggio di una tabella vuota.
        const res = esito.res;
        const eRisultato = res && (res.resultSet === true
          // Ripiego per i percorsi che non dichiarano il flag (script MongoDB
          // interpretato, comandi `USE`): vale la vecchia regola.
          || (res.resultSet === undefined && Array.isArray(res.docs) && res.docs.length));
        if (eRisultato) {
          // `index`: quale ISTRUZIONE ha prodotto ciò che la griglia mostra. Serve
          // al pannello per accendere la linguetta giusta — o nessuna, quando la
          // griglia sta mostrando il riepilogo di una scrittura, che linguetta non
          // ne ha.
          holder.last = { docs: res.docs || [], columns: res.columns || null, index };
          // …e finisce anche su file, come SCHEDA consultabile a parte: è ciò che
          // permette di rivedere il risultato dell'istruzione 3 dopo che
          // l'istruzione 40 ha prodotto il suo. Su file e non in memoria perché
          // qui il numero non lo decide il server: lo decide il file .sql che
          // l'utente ha aperto (vedi db/ScriptResults.js).
          // Schede: SOLO i result set veri (`resultSet`), non i riepiloghi di
          // scrittura. Un file .sql di cinquecento INSERT produrrebbe altrimenti
          // cinquanta linguette «1 riga coinvolta» che, con il tetto sulle prime,
          // toglierebbero il posto proprio alla SELECT che si voleva rivedere. Le
          // scritture restano nel log, dove c'è già il conteggio delle righe
          // modificate.
          if (res.resultSet === true && run && run.deposito) {
            try {
              await run.deposito.aggiungi({ index, line: stmt.line, sql: stmt.sql, res });
            } catch (err) {
              // Il disco pieno o una cartella non scrivibile NON devono fermare
              // uno script che sta scrivendo sul database: si perde la scheda, si
              // continua a eseguire. La griglia mostra comunque l'ultimo
              // risultato, che vive in memoria.
              console.error('[script] impossibile conservare il result set:', err && err.message);
            }
          }
        }
        // Audit: una voce per ogni istruzione di SCRITTURA (sono quelle che
        // lasciano traccia sui dati), non per ogni lettura di uno script lungo —
        // il riepilogo finale copre l'esecuzione nel suo insieme.
        if (esito.category === 'write') {
          audit.auditQuery(session, esito.db, esito.coll, esito.code, 'write', `${esito.op} [script]`, 'ok', esito.res, null);
        }
        return esito.res;
      };
    }

    lifecycle.operazioneLunga('script:execute', async (payload, cb) => {
      const tabId = lock.normTabId(payload.tabId);
      const session = socketContext.sessions.get(tabId);
      if (!session || !session.strategy) {
        throw new Error('Nessuna connessione attiva al database per questo tab.');
      }

      const runId = String(payload.runId || '').trim();
      if (!runId) throw new Error('runId mancante: impossibile seguire e mettere in pausa lo script.');

      const runs = scriptsOf(session);
      if (runs.has(runId)) throw new Error('Uno script con questo identificativo è già in corso.');
      // I run terminati restano consultabili, ma non all'infinito.
      for (const [id, r] of runs) {
        if (r.status === 'done' || r.status === 'aborted') runs.delete(id);
      }
      if (runs.size >= query.MAX_SCRIPTS_PER_SESSION) {
        throw new Error(`Troppi script attivi su questa connessione (max ${query.MAX_SCRIPTS_PER_SESSION}): mettine in pausa o chiudine uno.`);
      }

      const codeStr = String(payload.code || '').trim();
      if (!codeStr) throw new Error('Script vuoto.');

      // Uno SCRIPT JavaScript su MongoDB non si divide per `;`: il separatore
      // sta anche dentro i blocchi `{ … }` di cicli e funzioni, e spezzarlo
      // produrrebbe frammenti privi di senso. Lo si tratta come un'unica unità e
      // sarà l'interprete ad analizzarlo (executeQueryCode → MongoScriptRunner).
      const jsMongo = session.strategy.type === 'mongodb'
        && MongoScriptRunner.sembraScriptJs(codeStr);

      // Le porzioni fatte di soli commenti non sono istruzioni: un file .sql
      // finisce spesso con un commento di chiusura, e mandarlo al database
      // produrrebbe un errore di sintassi per qualcosa che l'utente non ha
      // nemmeno scritto come comando.
      // Qui si divide per ESEGUIRE, non per classificare: dividere male romperebbe
      // le istruzioni dell'utente, quindi vale il dialetto vero della connessione
      // (su MySQL la barra rovesciata dentro un literal è un escape, su
      // PostgreSQL no — vedi la nota in db/sqlText.js).
      const dialetto = { backslashEscape: (session.dbType || '') === 'mysql' };
      const statements = jsMongo
        ? [{ sql: codeStr, line: 1 }]
        : splitStatementsDetailed(codeStr, dialetto).filter((st) => stripSqlNoise(st.sql, dialetto).trim().length > 0);
      if (!statements.length) throw new Error('Lo script non contiene istruzioni eseguibili.');
      if (statements.length > query.MAX_SCRIPT_STATEMENTS) {
        throw new Error(`Lo script contiene ${statements.length} istruzioni: il massimo per esecuzione è ${query.MAX_SCRIPT_STATEMENTS}. Caricalo come file per eseguirlo a blocchi.`);
      }

      const ctx = { engine: payload.engine, db: payload.db, coll: payload.coll };
      const holder = { last: null };
      const run = createScriptRun({
        id: runId,
        statements,
        stopOnError: !!payload.stopOnError,
      });
      // Deposito dei result set su file. Se non si riesce ad aprirlo (cartella
      // temporanea non scrivibile) lo script parte lo stesso: si perdono le
      // schede, non l'esecuzione.
      try {
        run.deposito = apriDeposito(session, runId, codeStr);
      } catch (err) {
        console.error('[script] deposito dei risultati non disponibile:', err && err.message);
        run.deposito = null;
      }
      run.onProgress = makeProgressSender(tabId, run, holder);
      run.ctx = ctx;
      run.holder = holder;
      runs.set(runId, run);

      // Categoria REALE dello script (CDB-69): registrarlo sempre come scrittura
      // riempiva lo Storico Azioni di finte modifiche, e chi filtra per
      // "scrittura" per ricostruire chi ha toccato i dati trovava rumore proprio
      // quando serve precisione. Su SQL la risposta si legge dalle istruzioni con
      // la stessa funzione usata dai permessi; su uno script MongoDB interpretato
      // si sa solo a fine esecuzione, quindi l'avvio è una lettura e sarà la voce
      // di chiusura a dire se ha scritto.
      const scritturaNota = !jsMongo && statements.some((st) => isWriteSql(st.sql));
      run.categoria = scritturaNota ? 'write' : 'read';
      audit.auditQuery(
        session, ctx.db || null, ctx.coll || null, codeStr,
        run.categoria,
        `Avvio script (${statements.length} istruzioni)`,
        'ok', null, null
      );

      // L'ack torna SUBITO: lo script può durare minuti e l'utente deve poter
      // interagire (pausa, chiusura del pannello) mentre gira.
      cb({ ok: true, runId, total: statements.length });

      run.completion = lifecycle.track(run.start(makeScriptExecutor(session, ctx, holder, run))
        .then((stato) => finalizzaScript(session, run, stato))
        .catch((err) => chiudiRunInErrore(session, run, err, 'nel ciclo')));
    });

    /**
     * Chiusura di un run finito in errore IMPREVISTO (CDB-67).
     *
     * Il run va portato a uno stato TERMINALE e annunciato: il client ricava la
     * fine solo dai push, quindi senza questo resta con un pannello "in
     * esecuzione" che non si chiude e non risponde ai comandi, e non viene
     * scritta la voce di audit di chiusura.
     *
     * Sta in una funzione perché i punti di ingresso del ciclo sono DUE —
     * `script:execute` e `script:resume` — e la correzione era stata applicata a
     * uno solo: alla ripresa il run restava `running` per sempre.
     */
    function chiudiRunInErrore(session, run, err, dove) {
      console.error(`[script] errore imprevisto ${dove}:`, err && err.message);
      try {
        const stato = run.fail(err);
        finalizzaScript(session, run, stato);
      } catch (e2) {
        console.error('[script] impossibile chiudere il run:', e2 && e2.message);
      }
      // Un run concluso non deve restare nella mappa della sessione.
      try { scriptsOf(session).delete(run.id); } catch { /* sessione già chiusa */ }
    }

    function finalizzaScript(session, run, stato) {
      if (stato.status !== 'done' && stato.status !== 'aborted') return;
      audit.auditQuery(
        session,
        (run.ctx && run.ctx.db) || null,
        (run.ctx && run.ctx.coll) || null,
        `script ${run.id}`,
        // Categoria vera (CDB-69): quella decisa all'avvio per gli script SQL,
        // oppure quella che l'esecuzione ha rivelato per gli script MongoDB
        // interpretati (il Proxy autorizzante ha già visto ogni scrittura).
        run.categoria === 'write' || run.haScritto ? 'write' : 'read',
        `Fine script: ${stato.eseguiti} eseguite, ${stato.falliti} fallite`,
        stato.falliti ? 'error' : 'ok',
        null,
        stato.falliti ? new Error(`${stato.falliti} istruzioni fallite`) : null
      );
    }

    lifecycle.operazioneLunga('script:pause', async (payload, cb) => {
      const session = socketContext.sessions.get(lock.normTabId(payload.tabId));
      const run = session && session.scripts && session.scripts.get(String(payload.runId || ''));
      if (!run) return cb({ ok: true, paused: false });

      // `pause()` risponde `false` se non c'era nulla da fermare (script già
      // finito o già in pausa): va riportato com'è, altrimenti la UI mostrerebbe
      // "in pausa" su uno script concluso e offrirebbe una ripresa impossibile.
      const paused = run.pause();
      // La pausa si ferma DOPO l'istruzione in corso: troncarla d'ufficio
      // significherebbe interrompere a metà una possibile scrittura, cioè proprio
      // lo stato incoerente che si vuole evitare. Con `force` (l'utente insiste
      // perché l'istruzione è lunga) la si tronca sul database e la si segna come
      // interrotta: non conta come fallimento e la ripresa la rilancia.
      const corrente = run.currentStatement;
      let cancelled = false;
      if (paused && payload.force && corrente && corrente.opHandle && session.strategy) {
        run.markCurrentInterrupted();
        corrente.opHandle.interrotto = true; // ferma anche uno script interpretato
        try {
          const res = await session.strategy.cancelQuery(corrente.opHandle);
          cancelled = !!(res && res.cancelled);
        } catch (_) { /* annullamento best-effort */ }
      }
      cb({ ok: true, paused, cancelled, stato: run.state() });
    });

    lifecycle.operazioneLunga('script:resume', async (payload, cb) => {
      const tabId = lock.normTabId(payload.tabId);
      const session = socketContext.sessions.get(tabId);
      if (!session || !session.strategy) {
        throw new Error('Nessuna connessione attiva al database per questo tab.');
      }
      const run = session.scripts && session.scripts.get(String(payload.runId || ''));
      if (!run) throw new Error('Script non trovato: potrebbe essere scaduto o la connessione è stata riaperta.');
      if (run.status === 'running') return cb({ ok: true, stato: run.state() });

      const fromIndex = Number.isInteger(payload.fromIndex) ? payload.fromIndex : undefined;
      cb({ ok: true, stato: run.state() });

      run.completion = lifecycle.track(run.resume(makeScriptExecutor(session, run.ctx, run.holder, run), fromIndex)
        .then((stato) => finalizzaScript(session, run, stato))
        .catch((err) => chiudiRunInErrore(session, run, err, 'alla ripresa')));
    });

    // Stato di un run (ripristino della UI dopo un F5 o un cambio di tab).
    lifecycle.operazioneLunga('script:state', async (payload, cb) => {
      const session = socketContext.sessions.get(lock.normTabId(payload.tabId));
      const runs = session && session.scripts;
      if (!runs) return cb({ ok: true, scripts: [] });

      const runId = payload.runId ? String(payload.runId) : null;
      if (runId) {
        const run = runs.get(runId);
        return cb({ ok: true, stato: run ? run.state() : null, ultimoRisultato: run ? run.holder.last : null });
      }
      cb({ ok: true, scripts: [...runs.values()].map((r) => r.state()) });
    });

    /* --- Contenuto di UNA scheda di risultato ---------------------------------
     * Il pannello conosce le schede (riga, istruzione, quante righe) dall'elenco
     * che arriva a fine script; le RIGHE le chiede qui, quando l'utente apre la
     * scheda. È il motivo per cui i result set stanno su file: così questo
     * evento legge solo quello che serve, e uno script con cinquanta SELECT non
     * spedisce cinquanta result set a chi ne guarderà uno.
     * ------------------------------------------------------------------------ */
    lifecycle.operazioneLunga('script:result', async (payload, cb) => {
      const session = socketContext.sessions.get(lock.normTabId(payload.tabId));
      if (!session) throw new Error('Nessuna connessione attiva al database per questo tab.');
      const deposito = depositiOf(session).get(String(payload.runId || ''));
      if (!deposito) {
        throw new Error('I risultati di questo script non sono più disponibili: vengono conservati per gli ultimi script eseguiti e fino alla chiusura della connessione.');
      }
      const scheda = await deposito.leggi(payload.pos);
      cb({ ok: true, ...scheda });
    });

    lifecycle.operazioneLunga('script:abort', async (payload, cb) => {
      const session = socketContext.sessions.get(lock.normTabId(payload.tabId));
      const runs = session && session.scripts;
      const run = runs && runs.get(String(payload.runId || ''));
      if (!run) return cb({ ok: true, aborted: false });
      run.abort();
      const corrente = run.currentStatement;
      if (corrente && corrente.opHandle && session.strategy) {
        corrente.opHandle.interrotto = true;
        try { await session.strategy.cancelQuery(corrente.opHandle); } catch (_) {}
      }
      runs.delete(run.id);
      cb({ ok: true, aborted: true });
    });

    lifecycle.operazioneLunga('query:cancel', async (payload, cb) => {
      const tabId = lock.normTabId(payload.tabId);
      const session = socketContext.sessions.get(tabId);
      if (!session || !session.strategy || !session.inflight) {
        if (cb) cb({ ok: true, cancelled: false });
        return;
      }

      const runId = payload.runId;
      if (!runId) {
        if (cb) cb({ ok: true, cancelled: false });
        return;
      }

      const opHandle = session.inflight.get(runId);
      if (!opHandle) {
        if (cb) cb({ ok: true, cancelled: false });
        return;
      }

      try {
        // Uno script MongoDB interpretato non è un'operazione del database che
        // si possa uccidere con killOp: gira nel processo CodeDB. Il flag è il
        // suo canale di interruzione, controllato insieme agli altri budget.
        opHandle.interrotto = true;
        const res = await session.strategy.cancelQuery(opHandle);
        // Gli annullamenti del single-flight della griglia (superamento di una
        // pagina da parte della successiva) sono marcati `_bg`: sono housekeeping
        // interno, non un'azione utente, e intaserebbero lo Storico Azioni
        // (peggio col refresh live). Solo gli annullamenti espliciti sono tracciati.
        if (!payload._bg) {
          try {
            audit.auditUi({
              event: 'query:cancel',
              category: 'write',
              op: 'Annullamento query',
              status: 'ok',
              ...audit.auditActor(session && session.principal),
              connection: (session && (session.connName || session.label)) || null,
              dbType: (session && (session.dbType || (session.strategy && session.strategy.type))) || null,
              client: (session && session.ip) || null,
              runId,
              cancelled: res.cancelled
            });
          } catch (_) {}
        }
        if (cb) cb({ ok: true, cancelled: res.cancelled });
      } catch (err) {
        try {
          audit.auditUi({
            event: 'query:cancel',
            category: 'write',
            op: 'Annullamento query',
            status: 'error',
            ...audit.auditActor(session && session.principal),
            connection: (session && (session.connName || session.label)) || null,
            dbType: (session && (session.dbType || (session.strategy && session.strategy.type))) || null,
            client: (session && session.ip) || null,
            runId,
            error: errori.errMsg(err)
          });
        } catch (_) {}
        if (cb) cb({ ok: true, cancelled: false, error: err.message });
      }
    });
  }

  return registra;
}

module.exports = { createModule };
