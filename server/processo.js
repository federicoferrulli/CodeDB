'use strict';

function eccezioneFatale(err) {
  if (!err) return false;
  if (err instanceof RangeError && /call stack/i.test(err.message || '')) return true;
  return /heap out of memory|allocation failed/i.test(String(err.message || '')) || err.name === 'AssertionError';
}

/** I listener appartengono al launcher, non alle istanze incorporate o ai test. */
function creaProcesso(getServer, processo = process) {
  let registrati = false;
  let arresto;
  function gracefulShutdown(signal) {
    if (arresto) return arresto;
    arresto = (async () => {
      const timer = setTimeout(() => processo.exit(1), 5000);
      timer.unref?.();
      let code = signal === 'uncaughtException' ? 1 : 0;
      try { await getServer().stop(); }
      catch (err) { console.error('[Shutdown] Chiusura non completata:', err); code = 1; }
      finally { clearTimeout(timer); unregister(); }
      processo.exit(code);
    })();
    return arresto;
  }
  const handlers = {
    SIGINT: () => gracefulShutdown('SIGINT'),
    SIGTERM: () => gracefulShutdown('SIGTERM'),
    uncaughtException: (err, origin) => {
      console.error(`[Process] Uncaught Exception (${origin}):`, err);
      if (eccezioneFatale(err)) gracefulShutdown('uncaughtException');
      else console.error('[Process] Errore considerato recuperabile: il server resta in esecuzione.');
    },
    unhandledRejection: (reason, promise) => console.error('[Process] Unhandled Rejection in Promise:', promise, 'motivo:', reason),
  };
  function unregister() {
    if (!registrati) return;
    for (const [name, fn] of Object.entries(handlers)) processo.removeListener(name, fn);
    registrati = false;
  }
  function registerGlobalExceptionHandlers() {
    if (!registrati) {
      for (const [name, fn] of Object.entries(handlers)) processo.on(name, fn);
      registrati = true;
    }
    return unregister;
  }
  return { registerGlobalExceptionHandlers, gracefulShutdown };
}

module.exports = { creaProcesso, eccezioneFatale };
