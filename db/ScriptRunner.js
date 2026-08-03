'use strict';

/* ---------------------------------------------------------------------------
 * ScriptRunner — esecuzione di uno script come SEQUENZA di istruzioni, con
 * pausa e ripresa dal punto esatto in cui ci si era fermati.
 *
 * Perché non basta mandare l'intero script al driver:
 *
 *  - su mysql2 `multipleStatements` resta `false` di proposito (abilitarlo
 *    allargherebbe la superficie da injection su TUTTA l'app, non solo qui);
 *  - eseguendo un'istruzione alla volta si ottiene un progresso reale, la
 *    pausa/ripresa a granularità di statement, l'errore localizzato alla riga
 *    esatta e — non ultimo — la classificazione lettura/scrittura per singola
 *    istruzione, quindi audit e permessi precisi invece di un unico "write".
 *
 * Politica sugli errori: CONTINUA E RIPORTA (scelta di Keus). Uno script non si
 * ferma al primo fallimento; ogni istruzione lascia una voce nel resoconto e
 * alla fine si sa quante sono passate, quante no e perché. Chi vuole il
 * comportamento prudente passa `stopOnError: true`.
 *
 * Il modulo è deliberatamente indipendente dal trasporto e dal tipo di
 * database: riceve un `executor(stmt, index)` e non sa nulla di socket, di
 * strategie o di RBAC. Questo lo rende testabile senza database (vedi
 * test/unit-script-runner.js).
 * ------------------------------------------------------------------------- */

// Stati del run. `paused` è l'unico da cui si può ripartire.
const STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  DONE: 'done',
  ABORTED: 'aborted',
};

class ScriptRun {
  /**
   * @param {object} opts
   * @param {string} opts.id                    runId condiviso col client
   * @param {Array<{sql:string,line:number}>} opts.statements istruzioni già divise
   * @param {boolean} [opts.stopOnError=false]  ferma al primo errore
   * @param {(ev:object)=>void} [opts.onProgress] notifica per ogni istruzione
   * @param {number} [opts.maxStoredResults=500] tetto alle voci CONSERVATE
   */
  constructor({ id, statements, stopOnError = false, onProgress = null, maxStoredResults = 500 }) {
    this.id = id;
    this.statements = Array.isArray(statements) ? statements : [];
    this.stopOnError = !!stopOnError;
    this.onProgress = typeof onProgress === 'function' ? onProgress : null;
    this.maxStoredResults = Math.max(50, maxStoredResults | 0);

    this.status = STATUS.IDLE;
    this.cursor = 0;          // indice della PROSSIMA istruzione da eseguire
    this.results = [];        // voci conservate (vedi _record)
    this.eseguiti = 0;        // istruzioni TENTATE (non solo quelle conservate)
    this.falliti = 0;
    this.omessi = 0;          // voci riuscite scartate per il tetto
    this.startedAt = null;
    this.endedAt = null;

    this._pauseRequested = false;
    this._abortRequested = false;
    this._loop = null;        // promise del ciclo in corso
    this._current = null;     // { index, opHandle } dell'istruzione in volo
    this._interruptedIndex = null; // istruzione troncata da una pausa forzata
  }

  get total() { return this.statements.length; }

  /** Istruzione attualmente in esecuzione (per l'annullamento reale). */
  get currentStatement() { return this._current; }

  /** Fotografia dello stato, sicura da serializzare verso il client. */
  state() {
    return {
      id: this.id,
      status: this.status,
      cursor: this.cursor,
      total: this.total,
      eseguiti: this.eseguiti,
      falliti: this.falliti,
      omessi: this.omessi,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      results: this.results,
    };
  }

  /**
   * Conserva la voce rispettando il tetto: uno script da decine di migliaia di
   * istruzioni non deve tenere in memoria (né spedire) un resoconto altrettanto
   * lungo. Gli ERRORI si conservano sempre — sono il motivo per cui si guarda
   * il resoconto —, i successi in eccesso vengono scartati dai più vecchi e
   * contati in `omessi`.
   */
  _record(voce) {
    this.eseguiti++;
    // Un'istruzione troncata dall'utente non è un fallimento dello script.
    if (!voce.ok && !voce.interrupted) this.falliti++;
    this.results.push(voce);

    if (this.results.length > this.maxStoredResults) {
      const idx = this.results.findIndex((r) => r.ok);
      if (idx >= 0) {
        this.results.splice(idx, 1);
        this.omessi++;
      } else {
        // Tutti errori: meglio perdere il più vecchio che crescere all'infinito.
        this.results.shift();
        this.omessi++;
      }
    }
  }

  /**
   * Avvia (o riprende) l'esecuzione. Ritorna una promise che si risolve quando
   * il ciclo si ferma — per fine script, per pausa o per abort — con `state()`.
   *
   * `executor(stmt, index, run)` deve restituire un oggetto libero (righe,
   * affected, colonne...) o lanciare. Può usare `run.setOpHandle()` per
   * registrare l'handle con cui annullare l'operazione in corso.
   */
  start(executor) {
    if (this.status === STATUS.RUNNING) return this._loop;
    if (this.status === STATUS.DONE || this.status === STATUS.ABORTED) {
      return Promise.resolve(this.state());
    }

    this._pauseRequested = false;
    this.status = STATUS.RUNNING;
    if (this.startedAt === null) this.startedAt = Date.now();

    this._loop = this._run(executor);
    return this._loop;
  }

  /** Alias esplicito: riprendere è ripartire dal cursore conservato. */
  resume(executor, fromIndex) {
    if (Number.isInteger(fromIndex) && fromIndex >= 0 && fromIndex <= this.total) {
      this.cursor = fromIndex;
    }
    if (this.status === STATUS.DONE || this.status === STATUS.ABORTED) {
      // Ripresa esplicita di uno script già concluso: ha senso solo se si
      // riparte da un indice precedente, altrimenti non c'è nulla da fare.
      if (this.cursor >= this.total) return Promise.resolve(this.state());
      this.status = STATUS.PAUSED;
      this.endedAt = null;
    }
    return this.start(executor);
  }

  /**
   * Chiede la pausa. Il ciclo si ferma DOPO l'istruzione in corso: interrompere
   * a metà una scrittura lascerebbe uno stato peggiore di quello che si evita.
   * Chi vuole troncare anche l'istruzione in volo usa l'handle di
   * `currentStatement` con `strategy.cancelQuery`.
   */
  pause() {
    if (this.status !== STATUS.RUNNING) return false;
    this._pauseRequested = true;
    return true;
  }

  /** Interrompe definitivamente: nessuna ripresa possibile. */
  abort() {
    this._abortRequested = true;
    this._pauseRequested = true;
    return true;
  }

  /** Registra l'handle dell'operazione in volo (usato da `cancelQuery`). */
  setOpHandle(handle) {
    if (this._current) this._current.opHandle = handle;
  }

  /**
   * Dichiara che l'istruzione in volo sta per essere TRONCATA sul database
   * (pausa forzata: `cancelQuery`). Il fallimento che ne seguirà non è un
   * errore dello script — è l'utente che ha interrotto —, quindi non va contato
   * fra i falliti e il cursore NON deve superarla: alla ripresa si riparte da
   * quella, altrimenti un'istruzione verrebbe saltata in silenzio.
   *
   * Attenzione: una SCRITTURA troncata può essere andata a segno in parte.
   * Chi la rilancia lo fa con la semantica "almeno una volta"; per questo la
   * pausa NON tronca nulla se non le viene chiesto esplicitamente.
   */
  markCurrentInterrupted() {
    if (this._current) this._interruptedIndex = this._current.index;
  }

  async _run(executor) {
    while (this.cursor < this.total) {
      if (this._abortRequested) {
        this.status = STATUS.ABORTED;
        this.endedAt = Date.now();
        this._current = null;
        // Va annunciato come la fine e la pausa: senza, chi segue il run non
        // saprebbe mai che è finito e resterebbe con un "in esecuzione" eterno.
        this._emit({ tipo: 'aborted', cursor: this.cursor });
        return this.state();
      }
      if (this._pauseRequested) {
        this.status = STATUS.PAUSED;
        this._current = null;
        this._emit({ tipo: 'paused', cursor: this.cursor });
        return this.state();
      }

      const index = this.cursor;
      const stmt = this.statements[index];
      this._current = { index, statement: stmt, opHandle: null };

      const t0 = Date.now();
      let voce;
      try {
        const res = await executor(stmt, index, this);
        voce = {
          index,
          line: stmt.line ?? null,
          sql: stmt.sql,
          ok: true,
          ms: Date.now() - t0,
          ...summarize(res),
        };
      } catch (err) {
        voce = {
          index,
          line: stmt.line ?? null,
          sql: stmt.sql,
          ok: false,
          ms: Date.now() - t0,
          error: err && err.message ? err.message : String(err),
          ...(this._interruptedIndex === index ? { interrupted: true } : {}),
        };
      }

      const interrotta = !!voce.interrupted;
      this._interruptedIndex = null;
      this._record(voce);
      // Il cursore avanza anche su errore: riprendendo si riparte
      // dall'istruzione successiva, non da quella che ha già fallito.
      // L'eccezione è l'istruzione TRONCATA dall'utente: quella non ha avuto
      // la sua occasione, quindi il cursore resta lì e la ripresa la rilancia.
      this.cursor = interrotta ? index : index + 1;
      this._current = null;
      this._emit({ tipo: 'statement', result: voce, cursor: this.cursor });

      if (!voce.ok && this.stopOnError) {
        this.status = STATUS.PAUSED;
        this._emit({ tipo: 'paused', cursor: this.cursor, motivo: 'errore' });
        return this.state();
      }
    }

    this.status = STATUS.DONE;
    this.endedAt = Date.now();
    this._current = null;
    this._emit({ tipo: 'done' });
    return this.state();
  }

  /**
   * Chiusura forzata dopo un errore IMPREVISTO del ciclo (CDB-67).
   *
   * Gli errori delle singole istruzioni sono già gestiti (si contano e si
   * prosegue); questo è il caso residuo — un guasto del runner stesso. Senza una
   * chiusura esplicita il run resta `running` per sempre: il pannello mostra un
   * avanzamento fermo, Pausa e Interrompi non hanno effetto perché nulla
   * progredisce, e nemmeno il pulsante di chiusura compare, perché il client
   * ricava lo stato terminale unicamente da questo evento.
   */
  fail(err) {
    if (this.status === STATUS.DONE || this.status === STATUS.ABORTED) return this.state();
    this.status = STATUS.ABORTED;
    this.endedAt = Date.now();
    this._current = null;
    this.errore = (err && err.message) || String(err);
    this._emit({ tipo: 'aborted', cursor: this.cursor, errore: this.errore });
    return this.state();
  }

  _emit(ev) {
    if (!this.onProgress) return;
    // Il progresso è informativo: un listener che esplode non deve far fallire
    // lo script (stesso principio di `audit`, fire-and-forget).
    try {
      this.onProgress({ runId: this.id, total: this.total, ...ev });
    } catch (_) { /* ignora */ }
  }
}

/**
 * Riduce il risultato di un'istruzione a poche misure trasportabili: il
 * resoconto di uno script da migliaia di righe non deve trascinarsi dietro
 * tutti i result set.
 */
function summarize(res) {
  if (!res || typeof res !== 'object') return { rows: 0 };
  const docs = Array.isArray(res.docs) ? res.docs : (Array.isArray(res.data) ? res.data : null);
  const out = {};
  if (docs) out.rows = docs.length;
  if (typeof res.affected === 'number') out.affected = res.affected;
  else if (typeof res.affectedRows === 'number') out.affected = res.affectedRows;
  if (Array.isArray(res.columns)) out.columns = res.columns;
  if (res.truncated) out.truncated = true;
  if (out.rows === undefined) out.rows = 0;
  return out;
}

function createScriptRun(opts) {
  return new ScriptRun(opts);
}

module.exports = { ScriptRun, createScriptRun, STATUS };
