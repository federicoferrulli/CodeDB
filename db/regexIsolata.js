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
  const testoStr = testo == null ? '' : (typeof testo === 'string' ? testo : String(testo));
  if (testoStr.length > limiti.maxTesto) {
    throw erroreBudget(`Testo regex di ${testoStr.length} caratteri: il limite è ${limiti.maxTesto}.`);
  }
  return {
    bersaglio: bersaglioSerializzato,
    metodo,
    args: args.map((arg, idx) => {
      if (arg instanceof RegExp) return serializzaRegex(arg);
      if (bersaglio instanceof RegExp && idx === 0 && typeof arg !== 'string') return testoStr;
      return arg;
    }),
  };
}

const MAX_WORKER_ATTIVI = 3;
const MAX_CODA_WORKER = 16;
let workerAttivi = 0;
const codaWorker = [];

async function eseguiRegexIsolata(bersaglio, metodo, args, opzioni = {}) {
  const limiti = { ...DEFAULT, ...opzioni };
  const lavoro = prepara(bersaglio, metodo, args, limiti);

  if (workerAttivi >= MAX_WORKER_ATTIVI) {
    if (codaWorker.length >= MAX_CODA_WORKER) {
      throw erroreBudget('Troppi controlli regex concorrenti in corso: riprova tra poco.');
    }
    await new Promise((resolve) => codaWorker.push(resolve));
  } else {
    workerAttivi++;
  }

  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'regex-worker.js'), {
        workerData: lavoro,
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
      let concluso = false;
      let timer = null;
      const chiudi = (fn, valore) => {
        if (concluso) return;
        concluso = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        fn(valore);
      };

      worker.on('message', (msg) => {
        if (msg.pronto) {
          timer = setTimeout(() => {
            if (concluso) return;
            concluso = true;
            worker.terminate().catch(() => {});
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
  } finally {
    const prossimo = codaWorker.shift();
    if (prossimo) prossimo();
    else workerAttivi--;
  }
}

module.exports = { eseguiRegexIsolata, LIMITI_REGEX_DEFAULT: DEFAULT };
