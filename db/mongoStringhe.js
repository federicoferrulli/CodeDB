'use strict';

// Decodifica comune alla shell, alle stringhe JS e ai template. Il testo non
// passa mai da eval: gli escape invalidi sono errori, non dati modificati.
function escapeMongo(testo, inizio, template = false) {
  const c = testo[inizio + 1];
  let fine = inizio + 2, valore;
  const invalid = () => { throw new Error('Escape non valido nella stringa MongoDB.'); };
  if (c == null) return invalid();
  if (c === '\n' || c === '\r') {
    if (c === '\r' && testo[fine] === '\n') fine++;
    return { valore: '', fine, righe: 1 };
  }
  if (c === 'u' || c === 'x') {
    let digits;
    if (c === 'u' && testo[fine] === '{') {
      const end = testo.indexOf('}', ++fine);
      if (end < 0) return invalid();
      digits = testo.slice(fine, end); fine = end + 1;
      if (!/^[0-9a-f]+$/i.test(digits) || Number.parseInt(digits, 16) > 0x10ffff) return invalid();
    } else {
      const n = c === 'u' ? 4 : 2;
      digits = testo.slice(fine, fine + n); fine += n;
      if (digits.length !== n || !/^[0-9a-f]+$/i.test(digits)) return invalid();
    }
    valore = String.fromCodePoint(Number.parseInt(digits, 16));
  } else if (/[0-7]/.test(c)) {
    if (template && (c !== '0' || /[0-9]/.test(testo[fine] || ''))) return invalid();
    let digits = c;
    while (digits.length < (c <= '3' ? 3 : 2) && /[0-7]/.test(testo[fine] || '')) digits += testo[fine++];
    valore = String.fromCharCode(Number.parseInt(digits, 8));
  } else {
    if (template && /[89]/.test(c)) return invalid();
    valore = ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[c] ?? c;
  }
  return { valore, fine, righe: 0 };
}
module.exports = { escapeMongo };
