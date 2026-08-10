'use strict';

/* ---------------------------------------------------------------------------
 * Una SCRITTURA non legge mai il proprio bersaglio dal Proxy `state` (CDB-A18).
 *
 * `state` (public/js/state.js) delega allo stato del tab ATTIVO e `emit()`
 * inietta il tabId del tab attivo AL MOMENTO DELLA CHIAMATA. Va benissimo per
 * una lettura — al più si ridipinge la cosa sbagliata — ma per una scrittura è
 * un indirizzo che cambia sotto i piedi: l'incolla di celle e la cancellazione
 * multipla partono a ondate di 8 (`eseguiAOndate`), quindi le richieste sono
 * distribuite nel tempo, e le modali restano aperte quanto vuole l'utente.
 * Cambiando tab a metà operazione, le richieste rimanenti venivano indirizzate
 * all'altra connessione con gli id presi però dalle righe di questa: su MongoDB
 * un `_id` presente anche là veniva cancellato là, su MySQL/PostgreSQL l'`_id`
 * virtuale `{colonna: valore}` colpiva la riga omonima della tabella sbagliata.
 * Danno permanente e nessun segnale.
 *
 * Il rimedio è congelare il bersaglio (`captureContext()` → `tabId`, `db`,
 * `coll`) e passarlo esplicitamente, come faceva già exportimport.js. Questa
 * verifica è statica di proposito: i moduli coinvolti importano `utils.js`, che
 * fa parte di un ciclo di import che tira dentro l'intera applicazione, quindi
 * non sono caricabili in Node; e riprodurre il difetto vero richiederebbe due
 * connessioni vive in un browser. Un controllo sul TESTO non prova che il
 * bersaglio sia quello giusto, ma impedisce il ritorno esatto del difetto — che
 * è una riga in più, scritta per abitudine, in un modulo grande.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const JS = path.join(__dirname, '..', 'public', 'js');

// Eventi socket che SCRIVONO: per questi il bersaglio deve essere congelato.
const EVENTI_SCRITTURA = [
  'doc:insert', 'doc:update', 'doc:replace', 'doc:delete',
  'collection:deleteMany', 'collection:import',
];

const FILE = ['grid.js', 'cellselect.js', 'inlineEdit.js', 'insert.js', 'exportimport.js', 'splitview.js'];

/**
 * Estrae il testo dell'oggetto payload passato a `emit('<evento>', { … })`,
 * bilanciando le graffe. Ritorna la lista delle occorrenze trovate nel file.
 */
function payloadDiEmit(sorgente, evento) {
  const out = [];
  const apertura = `emit('${evento}'`;
  let i = sorgente.indexOf(apertura);
  while (i !== -1) {
    const graffa = sorgente.indexOf('{', i);
    // `emit('x', payload)` senza oggetto letterale: niente da ispezionare qui.
    const virgola = sorgente.indexOf(',', i + apertura.length);
    if (graffa !== -1 && virgola !== -1 && graffa < sorgente.indexOf(')', virgola) + 1) {
      let livello = 0;
      let j = graffa;
      for (; j < sorgente.length; j++) {
        if (sorgente[j] === '{') livello++;
        else if (sorgente[j] === '}' && --livello === 0) break;
      }
      out.push({ testo: sorgente.slice(graffa, j + 1), indice: i });
    }
    i = sorgente.indexOf(apertura, i + apertura.length);
  }
  return out;
}

function riga(sorgente, indice) {
  return sorgente.slice(0, indice).split('\n').length;
}

let controllati = 0;
for (const nome of FILE) {
  const percorso = path.join(JS, nome);
  if (!fs.existsSync(percorso)) continue;
  const sorgente = fs.readFileSync(percorso, 'utf8');
  for (const evento of EVENTI_SCRITTURA) {
    for (const { testo, indice } of payloadDiEmit(sorgente, evento)) {
      controllati++;
      assert.ok(
        !/\bstate\.(db|coll)\b/.test(testo),
        `${nome}:${riga(sorgente, indice)} — emit('${evento}') legge il bersaglio da "state", ` +
        'che punta al tab ATTIVO al momento della chiamata. Congelalo prima con captureContext() ' +
        '(vedi CDB-A18 e il modello in exportimport.js).',
      );
      assert.ok(
        /\btabId\b|\.\.\.bersaglio\b/.test(testo),
        `${nome}:${riga(sorgente, indice)} — emit('${evento}') non porta un tabId esplicito: ` +
        'la scrittura verrebbe indirizzata al tab attivo alla chiamata, non a quello d\'origine.',
      );
    }
  }
}

assert.ok(controllati >= 8, `attese almeno 8 scritture da ispezionare, trovate ${controllati}`);
console.log(`  OK   Le ${controllati} scritture del frontend congelano il bersaglio (CDB-A18)`);
