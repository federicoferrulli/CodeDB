'use strict';

// Scorrimento automatico ai bordi: la sola aritmetica, senza DOM.
//
// Quando si trascina una selezione fino al bordo del contenitore, la griglia
// deve continuare a scorrere da sola. Quanto scorrere per fotogramma dipende
// solo da dove sta il puntatore rispetto ai due bordi dell'asse, quindi è una
// funzione pura e come tale è verificabile (vedi test/unit-scorrimento.js).

export const BORDO_DEFAULT = 40; // px dal bordo entro cui parte lo scorrimento
export const V_MAX_DEFAULT = 26; // px per fotogramma alla massima distanza

/**
 * Velocità di scorrimento su un asse.
 * @param {number} p    posizione del puntatore (clientX o clientY)
 * @param {number} min  bordo iniziale del contenitore (left o top)
 * @param {number} max  bordo finale del contenitore (right o bottom)
 * @returns {number} px per fotogramma: negativo verso l'inizio, positivo verso
 *   la fine, 0 nella zona centrale. Oltre il bordo resta al massimo.
 */
export function velocitaAsse(p, min, max, { bordo = BORDO_DEFAULT, vMax = V_MAX_DEFAULT } = {}) {
  if (!Number.isFinite(p) || !Number.isFinite(min) || !Number.isFinite(max)) return 0;
  // Contenitore di dimensione nulla (pannello chiuso, elemento staccato dal
  // documento): non c'è nulla da scorrere, e senza questo controllo ogni punto
  // cadrebbe nella fascia e la griglia "scorrerebbe" a velocità massima.
  if (max <= min) return 0;
  // Contenitore più stretto di due fasce: le due zone si sovrapporrebbero e il
  // segno diventerebbe arbitrario. Si dimezza la fascia per non avere un punto
  // che tira in entrambe le direzioni.
  const b = Math.max(1, Math.min(bordo, (max - min) / 2));
  if (p < min + b) return -Math.round(vMax * Math.min(1, (min + b - p) / b));
  if (p > max - b) return Math.round(vMax * Math.min(1, (p - (max - b)) / b));
  return 0;
}
