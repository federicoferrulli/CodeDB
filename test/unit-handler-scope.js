'use strict';

// Controllo mirato sui veri handler registrati, senza parser del monolite.
const assert = require('assert');

const NOMI = ['sess', 'session'];

const usato = (corpo, nome) => new RegExp(`\\b${nome}\\s*(\\.|\\[|\\))`).test(corpo);
const legato = (corpo, nome) => new RegExp(
  // dichiarazione, assegnazione, oppure parametro di una funzione/arrow
  `(\\b(const|let|var)\\s+${nome}\\b)`
  + `|(\\b${nome}\\s*=[^=])`
  + `|(\\(\\s*[^)]*\\b${nome}\\b[^)]*\\)\\s*=>)`
  + `|(function\\s*[A-Za-z0-9_$]*\\s*\\([^)]*\\b${nome}\\b)`
).test(corpo);

{
  const handlers = require('./server-fixture').catalogoEventi().map(e => ({ evento: e.evento, corpo: e.handler.toString(), riga: e.file }));
  // Se il riconoscimento si rompe (refactor del file), il test deve fallire
  // rumorosamente invece di passare per non aver trovato nulla da controllare.
  assert.ok(handlers.length >= 20,
    `Handler socket riconosciuti: ${handlers.length}. Troppo pochi: il riconoscimento è da aggiornare.`);
  assert.ok(handlers.some((h) => h.evento === 'script:execute'),
    'handler script:execute non riconosciuto: il controllo non starebbe guardando il punto che lo ha motivato');

  const rotti = [];
  for (const h of handlers) {
    for (const nome of NOMI) {
      if (usato(h.corpo, nome) && !legato(h.corpo, nome)) {
        rotti.push(`${h.evento} (server.js:${h.riga}) usa "${nome}" senza dichiararlo`);
      }
    }
  }
  assert.deepStrictEqual(rotti, [],
    'Handler che leggono una sessione con il nome sbagliato:\n  ' + rotti.join('\n  '));
  console.log(`  OK   ${handlers.length} handler socket: nessuno legge una sessione non dichiarata (CDB-A70)`);
}

// Controprova: il controllo deve saper FALLIRE. Senza, passerebbe anche se le
// espressioni regolari smettessero di riconoscere qualcosa — che è esattamente
// il modo in cui un test statico marcisce senza dare segno.
{
  const finto = `{
    const tabId = normTabId(payload.tabId);
    const session = sessions.get(tabId);
    const dialetto = { backslashEscape: (sess.dbType || '') === 'mysql' };
  }`;
  assert.ok(usato(finto, 'sess'), 'il difetto reale di CDB-A70 deve risultare "usato"');
  assert.ok(!legato(finto, 'sess'), 'il difetto reale di CDB-A70 deve risultare "non legato"');
  assert.ok(legato(finto, 'session'), '"session" è dichiarata: deve risultare legata');
  console.log('  OK   Il controllo riconosce il difetto originale (controprova)');
}

console.log('\nTutti i test sugli handler socket superati!');
