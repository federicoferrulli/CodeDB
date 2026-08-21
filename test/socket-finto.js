'use strict';

/* ---------------------------------------------------------------------------
 * Socket finto per provare il trasporto del frontend senza alzare un server.
 *
 * Registra ogni `emit` ricevuto e risponde con ciò che il test decide, anche in
 * ritardo: è l'unico modo di far accadere qualcosa (la chiusura di un tab)
 * MENTRE una richiesta è in volo, che è precisamente la situazione che il
 * trasporto esiste per gestire.
 *
 * Si installa con `impostaSocket` (public/js/socket.js): quel punto di innesto
 * è la ragione per cui il socket non viene più aperto al caricamento del
 * modulo.
 * ------------------------------------------------------------------------- */

class SocketFinto {
  constructor() {
    /** @type {{ evento: string, payload: object, rispondi: (res:object)=>void }[]} */
    this.inviati = [];
    // Risposte preparate per evento: una coda, così due chiamate dello stesso
    // evento possono ricevere risposte diverse (la seconda è il tentativo dopo
    // la riconnessione).
    this.risposte = new Map();
    // Eventi per cui NON si deve rispondere subito: il test risponderà a mano.
    this.sospesi = new Set();
  }

  /** Prepara la prossima risposta per un evento. */
  rispondiA(evento, risposta) {
    if (!this.risposte.has(evento)) this.risposte.set(evento, []);
    this.risposte.get(evento).push(risposta);
    return this;
  }

  /** L'evento resta in volo finché il test non chiama `sblocca`. */
  sospendi(evento) {
    this.sospesi.add(evento);
    return this;
  }

  /** Risponde a una richiesta lasciata in volo. */
  sblocca(evento, risposta) {
    const inviato = this.inviati.find((i) => i.evento === evento && !i.risposto);
    if (!inviato) throw new Error(`Nessuna richiesta "${evento}" in volo da sbloccare.`);
    inviato.risposto = true;
    inviato.rispondi(risposta);
  }

  emit(evento, payload, ack) {
    const voce = { evento, payload, risposto: false, rispondi: (res) => ack && ack(res) };
    this.inviati.push(voce);
    if (typeof ack !== 'function') { voce.risposto = true; return; }
    if (this.sospesi.has(evento)) return;
    const coda = this.risposte.get(evento);
    const risposta = coda && coda.length ? coda.shift() : { ok: true };
    voce.risposto = true;
    // Asincrono come il socket vero: rispondere in modo sincrono nasconderebbe
    // ogni difetto di ordine fra la risposta e ciò che accade nel frattempo.
    setTimeout(() => ack(risposta), 0);
  }

  on() { /* il trasporto non si iscrive a nulla */ }
  off() { }

  /** Gli eventi di un certo tipo, in ordine. */
  con(evento) {
    return this.inviati.filter((i) => i.evento === evento);
  }

  /** L'ultimo payload inviato per quell'evento. */
  ultimoPayload(evento) {
    const lista = this.con(evento);
    return lista.length ? lista[lista.length - 1].payload : null;
  }
}

module.exports = { SocketFinto };
