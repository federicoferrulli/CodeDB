'use strict';

// Il log del processo figlio resta originale. Solo l'output inoltrato dal
// padre identifica le righe di un mutante, la cui rilevazione è verificata
// dal chiamante. Un controllo non riceve mai il prefisso.
const { StringDecoder } = require('node:string_decoder');

function prefissoMutante(nome) {
  if (nome === null || nome === undefined) return '';
  if (typeof nome !== 'string' || !nome.trim() || nome.length > 160 || /[\u0000-\u001f\u007f]/.test(nome)) {
    throw new TypeError('Il nome del mutante deve essere una singola riga non vuota.');
  }
  return `MUTANTE ${nome}: `;
}

function formattaOutputMutante(nome, testo) {
  const prefisso = prefissoMutante(nome);
  if (typeof testo !== 'string') throw new TypeError('L’output del mutante deve essere testo.');
  if (!prefisso || !testo) return testo;
  return prefisso + testo.replace(/\n(?=[\s\S])/g, '\n' + prefisso);
}

function inoltraOutputFiglio(figlio, { log, mutante = null, stdout = process.stdout, stderr = process.stderr }) {
  const prefisso = prefissoMutante(mutante);
  for (const [origine, destinazione] of [[figlio.stdout, stdout], [figlio.stderr, stderr]]) {
    if (!origine) continue;
    const decoder = new StringDecoder('utf8');
    let sospeso = '';
    origine.on('data', chunk => {
      log.write(chunk);
      if (!prefisso) { destinazione.write(chunk); return; }
      sospeso += decoder.write(chunk);
      let fine;
      // Una riga completa per write impedisce che stdout/stderr intercalati
      // lascino una continuazione senza prefisso nel log del runner esterno.
      while ((fine = sospeso.indexOf('\n')) >= 0) {
        destinazione.write(prefisso + sospeso.slice(0, fine + 1));
        sospeso = sospeso.slice(fine + 1);
      }
    });
    origine.once('end', () => {
      if (!prefisso) return;
      sospeso += decoder.end();
      if (sospeso) destinazione.write(prefisso + sospeso + '\n');
    });
  }
}

module.exports = { formattaOutputMutante, inoltraOutputFiglio };
