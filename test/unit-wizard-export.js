'use strict';

// Il cablaggio del wizard di export e della conferma di un piano.
//
// Senza browser non si prova che i bottoni facciano qualcosa; si prova però la
// cosa che qui si rompe in SILENZIO: un id scritto male. `$('#dbexport-run')`
// su un id inesistente restituisce null e l'ascoltatore non si aggancia — la
// modale si apre e il bottone non fa nulla, senza un errore in console che
// dica perché. Lo stesso vale per un modulo importato ma mai incluso, che è
// esattamente lo stato in cui questi tre moduli si trovavano.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const radice = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(radice, 'public', 'index.html'), 'utf8');
const idsNelMarkup = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

module.exports = (async () => {
  /* --- Ogni id usato dal codice esiste nel markup --------------------------- */

  {
    const moduli = ['exportimport.js', 'piano-anteprima.js'];
    const mancanti = [];
    for (const nome of moduli) {
      const src = fs.readFileSync(path.join(radice, 'public', 'js', nome), 'utf8');
      for (const m of src.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) {
        if (!idsNelMarkup.has(m[1])) mancanti.push(`${nome}: #${m[1]}`);
      }
    }
    assert.deepStrictEqual(mancanti, [], 'id usati dal codice ma assenti da index.html');
    console.log('  OK   ogni #id del wizard esiste nel markup');
  }

  /* --- I moduli del wizard sono RAGGIUNGIBILI ------------------------------- */

  {
    // Un modulo provato ma che nessuno importa non è una funzione consegnata:
    // è il difetto per cui questi tre vivevano solo dentro i propri test.
    // Si segue la catena vera degli import a partire da `main.js`, perché
    // «qualcuno lo importa» non basta — anche l'importatore dev'essere incluso.
    const visti = new Set();
    const coda = ['main.js'];
    while (coda.length) {
      const nome = coda.shift();
      if (visti.has(nome)) continue;
      visti.add(nome);
      let src;
      try { src = fs.readFileSync(path.join(radice, 'public', 'js', nome), 'utf8'); }
      catch { continue; } // import di vendor o percorsi fuori da js/
      for (const m of src.matchAll(/from\s+'\.\/([A-Za-z0-9_.-]+)'/g)) coda.push(m[1]);
    }
    for (const nome of ['export-selezione.js', 'import-mapping.js', 'riepilogo-piano.js', 'piano-anteprima.js']) {
      assert(visti.has(nome), `${nome} non è raggiungibile dalla catena di import di main.js`);
    }
    console.log('  OK   i moduli del wizard sono nella catena di import');
  }

  /* --- La logica pura resta quella del modulo, non una seconda copia -------- */

  {
    const src = fs.readFileSync(path.join(radice, 'public', 'js', 'exportimport.js'), 'utf8');
    assert(/creaStatoSelezione\(/.test(src), 'la selezione passa dal modulo puro');
    assert(/riepilogoPiano|confermaPiano\(/.test(src), 'la conferma passa dal riepilogo del piano');
    assert(/mappaNomi\(/.test(src), 'le collisioni passano dal modulo di mapping');
    // Un `window.confirm` con il riepilogo ricomposto a mano sarebbe la copia
    // che il modulo esiste per togliere.
    assert(!/window\.confirm\([\s\S]{0,200}Collection\/tabelle/.test(src),
      'il riepilogo dell import non si ricompone a mano');
    console.log('  OK   il wizard usa i moduli puri, non copie locali');
  }

  console.log('  OK   Wizard di export e conferma del piano passed');
})().catch((err) => {
  console.error('  FAIL Wizard di export:', err.stack || err);
  process.exitCode = 1;
});
