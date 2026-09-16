'use strict';

/**
 * Il codec fedele: l'unico punto in cui si decide come un valore BSON/SQL
 * diventa testo su disco e come torna indietro.
 *
 * Il motore di backup scriveva in EJSON *relaxed* e rileggeva in *canonico*
 * (`backup/lib/engine.js` → `backup/lib/restore.js`): nella scrittura si
 * perdevano i tipi — `Long(5)` e `Double(3)` tornavano `Int32` (matrice di
 * fedeltà §1-bis, misurato). Il valore restava, il TIPO no, e nessun errore lo
 * segnalava: la perdita silenziosa peggiore per un backup.
 *
 * La regola è una sola e sta qui, così motore di backup, export futuro e GUI
 * non possono divergere senza che un test lo segnali:
 *
 *  · si scrive CANONICO: ogni tipo BSON ha la sua forma (`$numberLong`,
 *    `$numberDouble`, `$numberDecimal`, `$date` in millisecondi, …) e torna
 *    identico;
 *  · si legge canonico, che legge anche i file relaxed storici (stesso lettore
 *    di prima: nessun file esistente diventa illeggibile);
 *  · mai `Number` per interi oltre i 53 bit: il canonico li tiene come testo.
 */

const { EJSON } = require('bson');

/**
 * bson ha il relaxed come default quando le opzioni mancano: chiamare
 * `EJSON.stringify` senza dirlo È scrivere relaxed. Qui il canonico è
 * esplicito in ogni chiamata, così nessun default futuro ci cambia il formato.
 */

/** Una riga di dati verso il file: forma canonica, tipi preservati. */
function stringifyRiga(value) {
  return EJSON.stringify(value, { relaxed: false });
}

/** Una riga dal file verso il restore: accetta canonico e relaxed storico. */
function parseRiga(line) {
  return EJSON.parse(line, { relaxed: false });
}

/** Oggetti di corredo (indici, cataloghi): forma canonica serializzata. */
function serializeConservativo(value) {
  return EJSON.serialize(value, { relaxed: false });
}

/** Il deserialize corrispondente, per i file scritti qui. */
function deserializeConservativo(value) {
  return EJSON.deserialize(value, { relaxed: false });
}

module.exports = { stringifyRiga, parseRiga, serializeConservativo, deserializeConservativo };
