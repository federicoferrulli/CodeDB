'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario di public/js/valori.js — la conversione valore → testo di cella.
 *
 * Perché ha una suite propria: è il codice che decide quanto lavoro dovrà fare
 * il browser a OGNI FOTOGRAMMA di scorrimento. La griglia è virtualizzata e
 * ridisegna ~20 righe per fotogramma, quindi qualunque costo che dipenda dalla
 * DIMENSIONE del valore invece che da quella della cella si moltiplica per venti
 * e per sessanta al secondo, e il thread principale si ferma.
 *
 * La proprietà provata qui non è "il testo è giusto" ma "il costo è limitato":
 * è quella che, cadendo, non produce un errore ma un'applicazione che si
 * inchioda su una tabella che l'utente ha tutto il diritto di aprire.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

let falliti = 0;
function prova(nome, fn) {
  try {
    fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err && err.message}`);
  }
}

/** Millisecondi mediani di `fn`, su più giri, per non farsi ingannare dal GC. */
function tempo(fn, giri = 30) {
  fn(); fn(); fn(); // scaldata
  const misure = [];
  for (let i = 0; i < giri; i++) {
    const t = process.hrtime.bigint();
    fn();
    misure.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  misure.sort((a, b) => a - b);
  return misure[Math.floor(misure.length / 2)];
}

console.log('--- Test Unitari Valori di Cella ---');

(async () => {
  const url = require('url').pathToFileURL(
    require('path').join(__dirname, '..', 'public', 'js', 'valori.js')
  ).href;
  const V = await import(url);

  const MAX = 1000;
  // Testo con apici e a capo: è ciò che c'è davvero in una colonna TEXT (JSON,
  // log, HTML), e costa a `JSON.stringify` molto più di tre megabyte di 'x'.
  const grande = ('riga "citata"' + String.fromCharCode(10)).repeat(200_000);

  // Il costo deve dipendere dal TETTO, non dal valore. La soglia è
  // proporzionale al caso piccolo più un margine fisso per il rumore di misura:
  // sul codice precedente questi casi stavano fra 1 e 9 ms, quindi il margine
  // è largo abbastanza da non lampeggiare e stretto abbastanza da accorgersene.
  const nonPiuCaroDi = (tPiccolo) => tPiccolo * 5 + 0.2;

  /* ------------------------------ correttezza ---------------------------- */

  prova('jsonBreve produce JSON valido quando ci sta tutto', () => {
    const v = { a: 1, b: 'due', c: [1, 2, 3], d: { e: true } };
    const t = V.jsonBreve(v, MAX);
    assert.deepStrictEqual(JSON.parse(t), v, `deve restare JSON analizzabile: ${t}`);
  });

  prova('jsonBreve rispetta il tetto e segnala il taglio', () => {
    const v = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`campo_${i}`, `valore ${i}`]));
    const t = V.jsonBreve(v, MAX);
    assert.ok(t.length <= MAX + 1, `oltre il tetto: ${t.length}`);
    assert.ok(t.endsWith('…'), 'il troncamento va dichiarato con un carattere di continuazione');
  });

  prova('L\'ordine dei campi è quello di Object.keys', () => {
    // `for…in` sostituisce `Object.keys` per non materializzare l'elenco: l'ordine
    // deve restare identico, altrimenti la cella mostra i campi in un altro ordine.
    const v = { zeta: 1, 2: 'due', alfa: 3, 1: 'uno', beta: 4 };
    const t = V.jsonBreve(v, MAX);
    const attesi = Object.keys(v);
    let pos = -1;
    for (const k of attesi) {
      const i = t.indexOf(`"${k}"`);
      assert.ok(i > pos, `il campo "${k}" è fuori ordine in ${t}`);
      pos = i;
    }
  });

  prova('tronca taglia solo oltre il tetto', () => {
    assert.strictEqual(V.tronca('breve', 100), 'breve');
    assert.strictEqual(V.tronca('abcdef', 3), 'abc…');
    assert.strictEqual(V.tronca(null, 10), '');
  });

  /* -------------------------- costo LIMITATO (il punto) ------------------- */

  prova('Una foglia enorme non costa più di una piccola', () => {
    // Il caso reale: un campo `note`, un log o un base64 dentro un documento.
    // `JSON.stringify` della foglia costruiva l'intera stringa PRIMA che il
    // budget potesse tagliarla: tre megabyte allocati per mostrarne mille
    // caratteri, per cella e per fotogramma.
    const piccolo = { nota: 'x'.repeat(50), altro: 1 };
    const enorme = { nota: grande, altro: 1 };
    const tPiccolo = tempo(() => V.jsonBreve(piccolo, MAX));
    const tEnorme = tempo(() => V.jsonBreve(enorme, MAX));
    assert.ok(V.jsonBreve(enorme, MAX).length <= MAX + 1, 'il testo resta limitato');
    assert.ok(tEnorme < nonPiuCaroDi(tPiccolo),
      `il costo non deve dipendere dalla dimensione del valore: ${tPiccolo.toFixed(3)} ms contro ${tEnorme.toFixed(3)} ms`);
  });

  prova('Una stringa enorme in cima non costa più di una piccola', () => {
    const tPiccolo = tempo(() => V.jsonBreve('x'.repeat(50), MAX));
    const tEnorme = tempo(() => V.jsonBreve(grande, MAX));
    assert.ok(V.jsonBreve(grande, MAX).length <= MAX + 1, 'il testo resta limitato');
    assert.ok(tEnorme < nonPiuCaroDi(tPiccolo),
      `${tPiccolo.toFixed(3)} ms contro ${tEnorme.toFixed(3)} ms`);
  });

  prova('Un array enorme non costa più di uno corto', () => {
    const corto = Array.from({ length: 10 }, (_, i) => i);
    const lungo = Array.from({ length: 1_000_000 }, (_, i) => i);
    const tCorto = tempo(() => V.jsonBreve(corto, MAX));
    const tLungo = tempo(() => V.jsonBreve(lungo, MAX));
    assert.ok(tLungo < nonPiuCaroDi(tCorto),
      `un array da un milione di elementi non va percorso tutto: ${tCorto.toFixed(3)} ms contro ${tLungo.toFixed(3)} ms`);
  });

  prova('Molte foglie grandi: il costo resta quello del tetto', () => {
    const v = { a: grande, b: grande, c: grande, d: grande, e: grande };
    const t = tempo(() => V.jsonBreve(v, MAX));
    assert.ok(t < 0.5,
      `cinque foglie enormi devono costare quanto il tetto, non quanto le foglie: ${t.toFixed(3)} ms`);
  });

  /* ------------------------- limite dichiarato --------------------------- */

  prova('LIMITE NOTO: un documento con moltissimi CAMPI costa O(campi)', () => {
    // Enumerare le chiavi di un oggetto in modalità dizionario è O(n) e in
    // JavaScript non si può evitare. È il motivo per cui `displayValueBreve`
    // (utils.js) memoizza il risultato per identità del valore: il costo si
    // paga una volta all'apertura, non a ogni fotogramma di scorrimento.
    // Questo test non chiede che sia veloce — chiede che il limite sia NOTO,
    // così chi lo tocca sa cosa sta guardando.
    const largo = Object.fromEntries(Array.from({ length: 50000 }, (_, i) => [`k${i}`, `v${i}`]));
    const t = tempo(() => V.jsonBreve(largo, MAX), 5);
    assert.ok(V.jsonBreve(largo, MAX).length <= MAX + 1, 'il testo resta comunque limitato');
    assert.ok(t < 60, `costo fuori scala per 50.000 campi: ${t.toFixed(1)} ms`);
  });

  if (falliti) {
    console.error(`\n${falliti} test falliti.`);
    process.exitCode = 1;
  } else {
    console.log('\nTutti i test dei valori di cella superati!');
  }
})();
