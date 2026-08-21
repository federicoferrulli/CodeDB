'use strict';

/* ---------------------------------------------------------------------------
 * Adattatore finto in memoria.
 *
 * Serve a provare ciò che la giuntura fa *attorno* a un adattatore senza
 * accendere un database: i tetti su righe, byte e tempo, e — nei lotti
 * successivi — tutto il resto che la giuntura impone.
 *
 * È deliberatamente **disobbediente**: non guarda `payload.maxRows`, non conta
 * i byte, non ha alcun timeout, e restituisce esattamente le righe che gli si
 * dice di restituire, quando gli si dice di restituirle. È questa disobbedienza
 * a rendere il test significativo: se il risultato arriva limitato lo stesso, il
 * limite non può venire dall'adattatore.
 *
 * Non eredita da `DbStrategy` di proposito. Ereditare porterebbe con sé
 * `fuoriDalTettoDiTempo` e chiunque leggesse il test si chiederebbe se il
 * comportamento provato venga dalla classe base o dalla giuntura.
 * ------------------------------------------------------------------------- */

/** Righe finte: `quante` documenti, ciascuno con un campo lungo `pesoCampo`. */
function righeFinte(quante, pesoCampo = 8) {
  const riempimento = 'x'.repeat(Math.max(pesoCampo, 1));
  return Array.from({ length: quante }, (_, i) => ({ _id: i + 1, testo: riempimento }));
}

/**
 * Aspetta `ms`. Il timer NON viene sganciato dal ciclo di eventi di proposito:
 * un adattatore che non tiene sveglio il processo lascerebbe uscire Node prima
 * che il cane da guardia della giuntura possa scattare, e il test passerebbe
 * senza aver provato nulla.
 */
function attendi(ms) {
  return new Promise((risolvi) => { setTimeout(risolvi, ms); });
}

class AdattatoreFinto {
  /**
   * @param {object} opts
   * @param {object[]} [opts.righe]     righe che ogni lettura restituisce
   * @param {number}   [opts.ritardoMs] quanto ci mette prima di rispondere
   * @param {number}   [opts.totale]    risposta di collectionCount
   */
  constructor(opts = {}) {
    this.type = 'finto';
    this.righe = opts.righe || righeFinte(10);
    this.ritardoMs = opts.ritardoMs || 0;
    this.totale = opts.totale == null ? 42 : opts.totale;
    // Ogni chiamata ricevuta, per poter verificare che la giuntura non abbia
    // alterato gli argomenti.
    this.chiamate = [];
  }

  async collectionFind(db, coll, payload) {
    this.chiamate.push({ metodo: 'collectionFind', db, coll, payload });
    if (this.ritardoMs) await attendi(this.ritardoMs);
    // Nessun rispetto di maxRows, nessun conteggio di byte, nessun troncamento
    // dichiarato: tutto quello che ha, per intero.
    return { docs: this.righe, columns: ['_id', 'testo'], total: this.righe.length, skip: 0, limit: this.righe.length };
  }

  async collectionAggregate(db, coll, payload) {
    this.chiamate.push({ metodo: 'collectionAggregate', db, coll, payload });
    if (this.ritardoMs) await attendi(this.ritardoMs);
    return { docs: this.righe, columns: ['_id', 'testo'], total: this.righe.length, resultSet: true };
  }

  async collectionCount(db, coll, payload) {
    this.chiamate.push({ metodo: 'collectionCount', db, coll, payload });
    if (this.ritardoMs) await attendi(this.ritardoMs);
    return { total: this.totale, timedOut: false };
  }

  // Un metodo NON soggetto ai tetti, per verificare che la giuntura lo lasci
  // passare intatto e senza ritardi propri.
  async listDatabases() {
    this.chiamate.push({ metodo: 'listDatabases' });
    return ['uno', 'due'];
  }
}

module.exports = { AdattatoreFinto, righeFinte, attendi };
