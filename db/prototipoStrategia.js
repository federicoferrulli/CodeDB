'use strict';

/**
 * Installa un gruppo di metodi su un prototipo di strategia con gli stessi
 * descrittori dei metodi di una classe (`enumerable: false`, `writable: true`,
 * `configurable: true`).
 *
 * Evita sia l'enumerazione involontaria in `for...in` (effetto collaterale di
 * `Object.assign`) sia il blocco delle sostituzioni mirate nei test di
 * mutazione/sensibilità.
 */
function definisciMetodi(prototipo, metodi) {
  const descrittori = {};
  for (const [nome, fn] of Object.entries(metodi)) {
    descrittori[nome] = { value: fn, writable: true, enumerable: false, configurable: true };
  }
  Object.defineProperties(prototipo, descrittori);
  return prototipo;
}

module.exports = { definisciMetodi };
