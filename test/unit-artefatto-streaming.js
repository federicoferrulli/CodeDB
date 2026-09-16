'use strict';

// Il lettore `.codedb.json` v1 attraversa il file senza materializzarlo:
// l'involucro resta in memoria, i documenti escono uno per uno come testo.
// Sbagliare il taglio dentro `docs` non produce un errore visibile ma
// documenti spezzati; un UTF-8 a cavallo di due blocchi non deve diventare «?».

const assert = require('assert');
const { creaLettoreCodedbJson } = require('../db/artefattoStreaming');

function leggi(testo, dimensioneBlocco) {
  const documenti = [];
  const collezioni = [];
  const lettore = creaLettoreCodedbJson({
    onCollection: (nome) => collezioni.push(nome),
    onDocumento: (nome, raw) => documenti.push([nome, JSON.parse(raw)]),
    onFineCollection: () => {},
  });
  const buf = Buffer.from(testo, 'utf8');
  if (!dimensioneBlocco) {
    lettore.scrivi(buf);
  } else {
    for (let i = 0; i < buf.length; i += dimensioneBlocco) {
      lettore.scrivi(buf.subarray(i, Math.min(buf.length, i + dimensioneBlocco)));
    }
  }
  const intestazione = lettore.fine();
  return { documenti, collezioni, intestazione };
}

(async () => {
  const sorgente = '{"collections":[{"name":"a","docs":[{"x":1},{"x":2}]},{"name":"b","docs":[]}],"versione":1}';

  // Intero e a blocchi di un byte: stesso risultato, anche con l'emoji a cavallo.
  const emoji = 'ciao \u{1F600} mondo';
  const conEmoji = JSON.stringify({ collections: [{ name: 'e', docs: [{ t: emoji }] }] });
  const intero = leggi(conEmoji, 0);
  assert.strictEqual(intero.documenti[0][1].t, emoji);
  for (const n of [1, 2, 3, 7]) {
    const spezzato = leggi(conEmoji, n);
    assert.deepStrictEqual(spezzato.documenti, intero.documenti,
      `a blocchi di ${n} byte i documenti devono restare identici`);
  }
  console.log('  OK   UTF-8 a cavallo dei blocchi non si corrompe');

  const base = leggi(sorgente, 0);
  assert.deepStrictEqual(base.collezioni, ['a', 'b']);
  assert.deepStrictEqual(base.documenti, [['a', { x: 1 }], ['a', { x: 2 }]]);
  assert.deepStrictEqual(base.intestazione.collections.map((c) => c.name), ['a', 'b'],
    'nell involucro resta la forma, senza i dati dentro');
  assert.deepStrictEqual(base.intestazione.collections[0].docs, [],
    'i docs non restano nell involucro: chi lo legge non rivede i dati');
  const spezzato = leggi(sorgente, 5);
  assert.deepStrictEqual(spezzato.documenti, base.documenti, 'il taglio non dipende dai blocchi');
  console.log('  OK   involucre senza dati e documenti uno per uno');

  // Graffe e virgole dentro le stringhe non sono struttura.
  const insidioso = JSON.stringify({ collections: [{ name: 'a', docs: [{ t: '}},{["' }, { x: 3 }] }] });
  const letto = leggi(insidioso, 2);
  assert.strictEqual(letto.documenti.length, 2);
  assert.strictEqual(letto.documenti[0][1].t, '}},{["');
  console.log('  OK   parentesi dentro le stringhe non tagliano i documenti');

  // Troncato o sbilanciato: fallire, non indovinare.
  for (const tronco of ['{"collections":[{"name":"a","docs":[{"x":1}', '{"collections":[']) {
    const r = creaLettoreCodedbJson({ onDocumento: () => {} });
    r.scrivi(Buffer.from(tronco, 'utf8'));
    assert.throws(() => r.fine(), /troncato|Involucro/i, `deve fallire su: ${tronco}`);
  }
  // Documento oltre il limite: rifiutato invece di tenuto in memoria.
  const grosso = JSON.stringify({ collections: [{ name: 'a', docs: [{ t: 'x'.repeat(100) }] }] });
  const salva = process.env.CODEDB_MAX_ARTIFACT_DOC_BYTES;
  process.env.CODEDB_MAX_ARTIFACT_DOC_BYTES = '10';
  try {
    delete require.cache[require.resolve('../db/artefattoStreaming')];
    const fresco = require('../db/artefattoStreaming').creaLettoreCodedbJson({ onDocumento: () => {} });
    assert.throws(() => {
      fresco.scrivi(Buffer.from(grosso, 'utf8'));
      fresco.fine();
    }, /limite/i);
    // Il tetto deve mordere MENTRE il documento arriva, non alla sua chiusura:
    // controllarlo dopo l'accumulo significa aver gia' messo in memoria proprio
    // il documento che si voleva rifiutare — cioe' andare in OOM prima di poter
    // dire perche', in un modulo che esiste per non materializzare il file.
    // Qui il documento non si chiude MAI: se il limite fosse ancora sulla
    // chiusura, `scrivi` accetterebbe tutto in silenzio.
    delete require.cache[require.resolve('../db/artefattoStreaming')];
    const incrementale = require('../db/artefattoStreaming').creaLettoreCodedbJson({ onDocumento: () => {} });
    incrementale.scrivi(Buffer.from('{"collections":[{"name":"a","docs":[{"t":"', 'utf8'));
    assert.throws(() => {
      for (let i = 0; i < 100; i += 1) incrementale.scrivi(Buffer.from('y'.repeat(50), 'utf8'));
    }, /limite/i, 'il tetto morde durante la scrittura, non alla chiusura');
  } finally {
    if (salva == null) delete process.env.CODEDB_MAX_ARTIFACT_DOC_BYTES;
    else process.env.CODEDB_MAX_ARTIFACT_DOC_BYTES = salva;
    delete require.cache[require.resolve('../db/artefattoStreaming')];
  }
  console.log('  OK   troncamenti e limiti falliscono invece di indovinare');

  console.log('  OK   Lettore streaming .codedb.json v1 passed');
})().catch((err) => {
  console.error('  FAIL Lettore streaming:', err.stack || err);
  process.exitCode = 1;
});
