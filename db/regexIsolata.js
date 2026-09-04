'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT = Object.freeze({ tempoMs: 250, maxTesto: 5000, maxPattern: 1000, runId: null });

function erroreBudget(messaggio) {
  const err = new Error(messaggio);
  err.budget = true;
  err.codice = 'REGEX_BUDGET';
  return err;
}

function serializzaRegex(re) {
  return { __codedbRegex: true, pattern: re.source, flags: re.flags, lastIndex: re.lastIndex };
}

function prepara(bersaglio, metodo, args, limiti) {
  const regex = [];
  let testo = null;
  let bersaglioSerializzato;
  if (bersaglio instanceof RegExp) {
    regex.push(bersaglio);
    testo = args[0];
    bersaglioSerializzato = { tipo: 'regex', ...serializzaRegex(bersaglio) };
  } else {
    testo = bersaglio;
    regex.push(...args.filter((arg) => arg instanceof RegExp));
    bersaglioSerializzato = { tipo: 'stringa', valore: String(bersaglio) };
  }
  for (const re of regex) {
    if (re.source.length > limiti.maxPattern) {
      throw erroreBudget(`Pattern regex di ${re.source.length} caratteri: il limite è ${limiti.maxPattern}.`);
    }
  }
  if (typeof testo === 'string' && testo.length > limiti.maxTesto) {
    throw erroreBudget(`Testo regex di ${testo.length} caratteri: il limite è ${limiti.maxTesto}.`);
  }
  return {
    bersaglio: bersaglioSerializzato,
    metodo,
    args: args.map((arg) => (arg instanceof RegExp ? serializzaRegex(arg) : arg)),
  };
}

function eseguiRegexIsolata(bersaglio, metodo, args, opzioni = {}) {
  const limiti = { ...DEFAULT, ...opzioni };
  let lavoro;
  try { lavoro = prepara(bersaglio, metodo, args, limiti); } catch (err) { return Promise.reject(err); }

  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'regex-worker.js'), { workerData: lavoro });
    let concluso = false;
    let timer = null;
    const chiudi = (fn, valore) => {
      if (concluso) return;
      concluso = true;
      clearTimeout(timer);
      fn(valore);
    };

    worker.on('message', (msg) => {
      if (msg.pronto) {
        timer = setTimeout(() => {
          if (concluso) return;
          concluso = true;
          worker.terminate();
          const run = limiti.runId ? ` del run ${limiti.runId}` : '';
          reject(erroreBudget(`Regex${run} interrotta: superato il tempo massimo di ${limiti.tempoMs} ms.`));
        }, limiti.tempoMs);
        worker.postMessage('esegui');
        return;
      }
      if (!msg.ok) return chiudi(reject, new Error(`Errore durante la regex isolata: ${msg.errore}`));
      if (bersaglio instanceof RegExp && msg.lastIndex != null) bersaglio.lastIndex = msg.lastIndex;
      chiudi(resolve, msg.risultato);
    });
    worker.once('error', (err) => chiudi(reject, new Error(`Worker regex non disponibile: ${err.message}`)));
    worker.once('exit', (codice) => {
      if (!concluso && codice !== 0) chiudi(reject, new Error(`Worker regex terminato in modo anomalo (codice ${codice}).`));
    });
  });
}

module.exports = { eseguiRegexIsolata, LIMITI_REGEX_DEFAULT: DEFAULT };
