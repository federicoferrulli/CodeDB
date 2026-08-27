'use strict';

/**
 * Codifica una cella CSV. La modalita predefinita neutralizza i quattro
 * prefissi interpretati come formule dai fogli di calcolo. Il valore rimane
 * leggibile e l'apostrofo rende esplicito che si tratta di testo.
 */
function cellaCsv(valore, { modalita = 'sicura' } = {}) {
  if (valore === null || valore === undefined) return '';
  let testo;
  if (valore instanceof Date) testo = Number.isNaN(valore.getTime()) ? '' : valore.toISOString();
  else if (Buffer.isBuffer(valore)) testo = valore.toString('base64');
  else if (typeof valore === 'object') testo = JSON.stringify(valore);
  else testo = String(valore);

  if (modalita !== 'letterale' && /^[=+\-@]/.test(testo)) testo = `'${testo}`;
  return /[",\r\n]/.test(testo) ? `"${testo.replace(/"/g, '""')}"` : testo;
}

function rigaCsv(valori, opzioni) {
  return valori.map((valore) => cellaCsv(valore, opzioni)).join(',');
}

module.exports = { cellaCsv, rigaCsv };
