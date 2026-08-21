'use strict';

/* ---------------------------------------------------------------------------
 * Il contesto finto di una sessione socket.
 *
 * È ciò che il ticket 16 rende possibile: `registraEventi(ctx)` accetta un
 * contesto costruito qui — socket finto, sessioni finte, principal finto — e da
 * lì si può invocare qualunque handler **senza aprire un socket vero né una
 * connessione a un database**.
 *
 * Prima non esisteva alcun punto in cui sostituire quel contesto, e i test di
 * server.js erano ridotti a leggere il file come TESTO bilanciando le graffe
 * con un'espressione regolare. Quei controlli statici restano — vedono cose che
 * nessuna invocazione vede — ma non sono più l'unica cosa possibile.
 * ------------------------------------------------------------------------- */

const { ROOT_PRINCIPAL } = require('../auth/principal');

/**
 * Un socket finto: registra gli handler invece di ascoltare la rete, e sa
 * invocarli restituendo l'ack come promessa.
 */
class SocketFinto {
  constructor({ indirizzo = '127.0.0.1', token = '' } = {}) {
    this.handshake = { address: indirizzo, auth: { token } };
    /** @type {Map<string, Function[]>} */
    this.handler = new Map();
    /** Eventi spediti al client (push del server), in ordine. */
    this.inviati = [];
    this.chiuso = false;
    this.principal = null;
    this.stanze = new Set();
  }

  on(evento, fn) {
    if (!this.handler.has(evento)) this.handler.set(evento, []);
    this.handler.get(evento).push(fn);
    return this;
  }

  /** Push verso il client: qui si registra e basta. */
  emit(evento, ...args) {
    this.inviati.push({ evento, args });
    return true;
  }

  disconnect() { this.chiuso = true; return this; }
  join(stanza) { this.stanze.add(stanza); return this; }
  leave(stanza) { this.stanze.delete(stanza); return this; }

  /** L'evento è stato registrato? */
  conosce(evento) { return this.handler.has(evento); }

  /** I nomi di tutti gli eventi registrati, in ordine di registrazione. */
  eventi() { return [...this.handler.keys()]; }

  /**
   * Invoca un handler come farebbe Socket.IO e restituisce l'ack.
   *
   * L'ack è una promessa: gli handler sono asincroni, e aspettare un callback
   * sincrono nasconderebbe ogni difetto di ordine.
   */
  chiama(evento, payload = {}, { scadenzaMs = 4000 } = {}) {
    const lista = this.handler.get(evento);
    if (!lista || !lista.length) {
      return Promise.reject(new Error(`Nessun handler registrato per "${evento}".`));
    }
    return new Promise((risolvi, rifiuta) => {
      let risposto = false;
      // Un handler che NON risponde è un difetto vero — il client resterebbe in
      // attesa di un ack che non arriva mai — e senza questa scadenza il test
      // si appenderebbe invece di fallire. Un test appeso non dice quale
      // handler è muto; questo sì.
      const timer = setTimeout(() => {
        if (risposto) return;
        risposto = true;
        rifiuta(new Error(
          `L'handler di "${evento}" non ha risposto entro ${scadenzaMs} ms: `
          + 'il client resterebbe in attesa di un ack che non arriva.'
        ));
      }, scadenzaMs);
      const ack = (res) => {
        if (risposto) return;
        risposto = true;
        clearTimeout(timer);
        risolvi(res);
      };
      Promise.resolve(lista[0](payload, ack)).catch((err) => {
        clearTimeout(timer);
        rifiuta(err);
      });
    });
  }

  /** L'ultimo push di un certo tipo verso il client. */
  ultimoInviato(evento) {
    for (let i = this.inviati.length - 1; i >= 0; i--) {
      if (this.inviati[i].evento === evento) return this.inviati[i];
    }
    return null;
  }
}

/**
 * Una sessione di database finta.
 *
 * `strategy` è l'adattatore finto: si passa quello che serve alla prova, e ciò
 * che non si passa semplicemente non esiste — un metodo mancante fa fallire il
 * test dicendo quale, che è più utile di un finto che risponde a tutto.
 */
function sessioneFinta({
  tabId = 'tab-1', strategy = {}, dbType = 'mongodb', connName = null, principal = ROOT_PRINCIPAL,
} = {}) {
  return {
    tabId,
    strategy,
    tunnel: null,
    dbType,
    effectiveCfg: { host: '127.0.0.1', port: 27017 },
    principal,
    guardCtx: { principal, connName },
    closed: false,
    label: connName || 'finta',
    connName,
    ip: '127.0.0.1',
  };
}

/**
 * Il contesto completo, pronto per `registraEventi`.
 *
 * @param {object} [opts]
 * @param {object} [opts.principal]
 * @param {Array<[string, object]>} [opts.sessioni] coppie [tabId, sessione]
 */
function contestoFinto({ principal = ROOT_PRINCIPAL, sessioni = [], indirizzo = '127.0.0.1' } = {}) {
  const socket = new SocketFinto({ indirizzo });
  // NON si scrive `socket.principal`: l'identita' deve arrivare dal CONTESTO.
  // Metterla anche sul socket renderebbe indistinguibile una giuntura che legge
  // il contesto da una che se la risolve da se' dal socket — cioe' renderebbe
  // cieca la prova che il contesto conti davvero.
  return {
    socket,
    ip: indirizzo,
    principal,
    sessions: new Map(sessioni),
  };
}

module.exports = { SocketFinto, contestoFinto, sessioneFinta };
