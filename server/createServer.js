'use strict';

const { configurazione } = require('./configurazione');
const { dipendenze } = require('./dipendenze');

/** Compone un server indipendente. Solo start() apre la porta; stop() non termina il processo. */
function createServer(options = {}) {
  const config = configurazione(options.config);
  const dependencies = dipendenze(config, options.dependencies);
  const errori = require('./errori').createModule({});
  const lock = require('./lock').createModule({});
  const budget = require('./budget').createModule({});
  const trasporto = require('./trasporto').createModule({ config });
  const audit = require('./audit').createModule({ config, dependencies, errori });
  const vault = require('./vault').createModule({ config, dependencies, errori });
  const informazioni = require('./informazioni').createModule({ config });
  const connessioni = require('./connessioni').createModule({ vault, dependencies, errori });
  const identita = require('./identita').createModule({ config, trasporto, audit, errori, dependencies });
  const operazioni = require('./operazioni').createModule({ config, identita });
  const query = require('./query').createModule({ config, connessioni, dependencies });
  const registratori = [
    require('./eventi-connessioni').createModule({ lock, budget, identita, connessioni, vault }),
    require('./eventi-app').createModule({ informazioni, identita }),
    require('./eventi-import').createModule({ operazioni, lock, identita, audit }),
    require('./eventi-identita').createModule({ config, identita, vault }),
    require('./eventi-vault').createModule({ vault, identita, config }),
    require('./eventi-monitoraggio').createModule({ audit, errori, connessioni, lock, identita }),
    require('./eventi-dati').createModule({ query, lock, identita, operazioni, audit }),
    require('./eventi-script').createModule({ lock, query, audit, dependencies, errori }),
    require('./eventi-backup').createModule({ lock, identita, operazioni, audit, errori, config }),
  ];
  const socket = require('./socket').createModule({
    identita, trasporto, budget, config, connessioni, lock, errori, query, audit, registratori,
  });
  const { mcpControl } = require('./mcp').createModule({ trasporto, vault, connessioni, config, identita, budget });
  const { app, server, io } = trasporto;
  let avvio;
  let arresto;
  let rilascio;
  let stato = 'creato';

  function start() {
    if (arresto || stato === 'chiusura' || stato === 'chiuso') return Promise.reject(new Error('Server arrestato: crea una nuova istanza.'));
    if (avvio) return avvio;
    stato = 'avvio';
    avvio = (async () => {
      try {
        const esposto = trasporto.bindEsposto();
        trasporto.assertTransportSafe(esposto);
        trasporto.assertAuthSafe(esposto);
        vault.initialize();
        await identita.initialize();
        await dependencies.ScriptResults.puliziaVecchi();
        await new Promise((resolve, reject) => {
          const errore = err => { server.removeListener('listening', pronto); reject(err); };
          const pronto = () => { server.removeListener('error', errore); resolve(); };
          server.once('error', errore);
          server.once('listening', pronto);
          server.listen(config.env.PORT, config.env.HOST || '127.0.0.1');
        });
        stato = 'attivo';
        console.log(`CodeDB in ascolto su http://${config.env.HOST || '127.0.0.1'}:${server.address().port}`);
        return instance;
      } catch (err) {
        await liberaRisorse().catch(cleanup => console.error('[Avvio] Errore durante la chiusura:', cleanup));
        stato = 'chiuso';
        throw err;
      }
    })();
    return avvio;
  }

  function liberaRisorse() {
    return rilascio ||= (async () => {
      const errors = [];
      const release = async fn => { try { await fn(); } catch (err) { errors.push(err); } };
      socket.beginShutdown();
      mcpControl.beginShutdown();
      identita.beginShutdown();
      // Le operazioni accettate terminano prima di spegnere le strategie che possiedono.
      await release(() => socket.drain());
      await release(() => operazioni.importOperations.close());
      await release(() => operazioni.importUploads.close());
      await release(() => socket.close());
      await release(() => mcpControl.shutdownMcp());
      await release(() => new Promise(resolve => io.close(resolve)));
      if (server.listening) await release(() => new Promise((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
        server.closeIdleConnections?.();
      }));
      await release(() => identita.drain());
      await release(() => audit.flushAuditUi());
      await release(() => identita.close());
      if (errors.length) throw new AggregateError(errors, 'Chiusura incompleta delle risorse del server.');
    })();
  }

  function stop() {
    if (arresto) return arresto;
    if (stato === 'chiuso') return arresto = Promise.resolve();
    const precedente = avvio;
    stato = 'chiusura';
    socket.beginShutdown();
    mcpControl.beginShutdown();
    identita.beginShutdown();
    arresto = (async () => {
      if (precedente) await precedente.catch(() => {});
      try { if (stato !== 'chiuso') await liberaRisorse(); }
      finally { stato = 'chiuso'; }
    })();
    return arresto;
  }

  const instance = {
    app, server, io, start, stop,
    startServer: start,
    executeQueryCode: query.executeQueryCode,
    registraEventi: socket.registraEventi,
    creaContestoSocket: socket.creaContestoSocket,
  };
  return instance;
}

module.exports = { createServer };
