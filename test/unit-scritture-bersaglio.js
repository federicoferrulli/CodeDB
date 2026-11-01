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
const { parse } = require('@babel/parser');

const JS = path.join(__dirname, '..', 'public', 'js');

// Eventi socket che SCRIVONO: per questi il bersaglio deve essere congelato.
const EVENTI_SCRITTURA = [
  'doc:insert', 'doc:update', 'doc:replace', 'doc:delete',
  'collection:deleteMany', 'collection:import',
  'db:create', 'db:rename', 'db:drop',
  'collection:create', 'collection:rename', 'collection:drop',
  'column:drop', 'index:create', 'index:drop', 'backup:restore',
];

const FILE = [
  'grid.js', 'cellselect.js', 'inlineEdit.js', 'insert.js', 'exportimport.js',
  'splitview.js', 'schema-ops.js', 'details.js', 'backupmanager.js',
];

// Il parser distingue le chiamate reali da commenti e stringhe contenenti emit().
function payloadDiEmit(sorgente) {
  const out = [];
  const ast = parse(sorgente, { sourceType: 'module' });
  function visita(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.name === 'emit'
      && EVENTI_SCRITTURA.includes(node.arguments[0]?.value) && node.arguments[1]?.type === 'ObjectExpression') {
      const payload = node.arguments[1];
      out.push({ evento: node.arguments[0].value, testo: sorgente.slice(payload.start, payload.end), indice: node.start });
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visita); else if (value && typeof value === 'object') visita(value);
    }
  }
  visita(ast);
  return out;
}

function riga(sorgente, indice) {
  return sorgente.slice(0, indice).split('\n').length;
}

let controllati = 0;
for (const nome of FILE) {
  const percorso = path.join(JS, nome);
  if (!fs.existsSync(percorso)) continue;
  let sorgente = fs.readFileSync(percorso, 'utf8');
  if (process.argv.includes('--mutant') && nome === 'grid.js') sorgente = sorgente.replace(/(emit\('doc:delete', \{)\s*\.\.\.bersaglio,/, '$1 ...nonCongelato,');
  for (const { evento, testo, indice } of payloadDiEmit(sorgente)) {
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

// Anche il commit precedente contiene 17 payload letterali; il vecchio scanner contava un falso positivo.
assert.ok(controllati >= 17, `attese almeno 17 scritture da ispezionare, trovate ${controllati}`);
console.log(`  OK   Le ${controllati} scritture del frontend congelano il bersaglio (CDB-A18)`);
