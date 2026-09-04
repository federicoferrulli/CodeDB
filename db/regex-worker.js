'use strict';

const { parentPort, workerData } = require('worker_threads');

function deserializzaArg(arg) {
  if (!arg || arg.__codedbRegex !== true) return arg;
  const re = new RegExp(arg.pattern, arg.flags);
  re.lastIndex = arg.lastIndex || 0;
  return re;
}

function esegui() {
  try {
    const args = workerData.args.map(deserializzaArg);
    let bersaglio;
    if (workerData.bersaglio.tipo === 'regex') {
      bersaglio = new RegExp(workerData.bersaglio.pattern, workerData.bersaglio.flags);
      bersaglio.lastIndex = workerData.bersaglio.lastIndex || 0;
    } else bersaglio = workerData.bersaglio.valore;

    let risultato = bersaglio[workerData.metodo](...args);
    // Le proprietà supplementari degli array restituiti da match/exec non sono
    // raggiungibili dalla sandbox; una lista semplice è più stabile da clonare.
    if (Array.isArray(risultato)) risultato = Array.from(risultato);
    parentPort.postMessage({ ok: true, risultato, lastIndex: bersaglio instanceof RegExp ? bersaglio.lastIndex : null });
  } catch (err) {
    parentPort.postMessage({ ok: false, errore: err && err.message ? err.message : String(err) });
  }
}

parentPort.once('message', esegui);
parentPort.postMessage({ pronto: true });
