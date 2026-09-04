'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): l'inserimento condivide il codec esatto con l'editing inline (issue 05).
 *
 * `insert.js` e `inlineEdit.js` hanno bisogno del DOM (creano input, leggono
 * `document`) e non sono importabili in Node: per verificare che i due FORM
 * VERI producano lo stesso EJSON per lo stesso testo e la stessa colonna, il
 * test carica la pagina reale e importa entrambi i moduli con `import()` nel
 * contesto della pagina, come già fanno `e2e-fk-viste.js` ed
 * `e2e-editor-geometrico.js`. Nessun database: `insertRowValue` e
 * `buildEditor` sono funzioni pure rispetto alla rete, e la parte di
 * "inserito → riletto" è già provata end-to-end (senza browser) da
 * `test/unit-sql-valori-esatti.js`, che porta lo stesso testo attraverso
 * EJSON → parametro SQL → riga riletta → EJSON. Qui si prova l'unico pezzo che
 * quel test non può vedere: che i DUE MODULI del browser, per lo stesso input,
 * chiamino davvero lo stesso codec — non due copie che potrebbero divergere.
 *
 * Uso: node test/e2e-numeri-esatti-inserimento.js
 * ------------------------------------------------------------------------- */

const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

let falliti = 0;
const ok = (cond, etichetta, dettaglio = '') => {
  if (cond) console.log(`  \x1b[32m✔ OK\x1b[0m   ${etichetta}`);
  else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${etichetta}${dettaglio ? `\n         ${dettaglio}` : ''}`);
    falliti++;
  }
};

(async () => {
  console.log('--- E2E: numeri esatti nell\'inserimento (issue 05) ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3161 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#insert-overlay', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(300);

    /* --- 1. Stessi valori limite, stesso EJSON nei due percorsi ----------- */

    const esiti = await page.evaluate(async () => {
      const { addInsertRow, insertRowValue, insertKindOf } = await import('/js/insert.js');
      const { buildEditor } = await import('/js/inlineEdit.js');

      // [nome, testo, typeName dichiarato dallo schema, dbType, EJSON atteso]
      const casi = [
        ['bigint_max_mysql', '9223372036854775807', 'bigint', 'mysql',
          { $numberLong: '9223372036854775807' }],
        ['bigint_min_mysql', '-9223372036854775808', 'bigint', 'mysql',
          { $numberLong: '-9223372036854775808' }],
        ['bigint_unsigned_max_mysql', '18446744073709551615', 'bigint unsigned', 'mysql',
          { $numberDecimal: '18446744073709551615' }],
        ['bigint_unsigned_sotto_2_63_mysql', '9223372036854775807', 'bigint unsigned', 'mysql',
          { $numberLong: '9223372036854775807' }],
        ['decimal_alta_precisione_mysql', '1234567890.123456789012345678', 'decimal(38,18)', 'mysql',
          { $numberDecimal: '1234567890.123456789012345678' }],
        ['bigint_oltre_2_53_postgres', '9007199254740993', 'bigint', 'postgresql',
          { $numberLong: '9007199254740993' }],
        ['numeric_esteso_postgres', '-99999999999999999999999999999999999999.99', 'numeric', 'postgresql',
          { $numberDecimal: '-99999999999999999999999999999999999999.99' }],
        ['long_mongo', '9007199254740995', 'long', 'mongodb',
          { $numberLong: '9007199254740995' }],
        ['decimal_piccolissimo_mongo', '0.00000000000000000000000000000000000001', 'decimal', 'mongodb',
          { $numberDecimal: '0.00000000000000000000000000000000000001' }],
      ];

      const risultati = [];
      for (const [nome, testo, typeName, dbType, atteso] of casi) {
        // Percorso INSERIMENTO: stessa costruzione riga che usa la modale
        // quando popola il form dallo schema (collection:stats -> addInsertRow).
        const kind = insertKindOf(typeName, dbType);
        const riga = addInsertRow({ name: nome, kind, typeName, numericMeta: { type: typeName } });
        riga.input.value = testo;
        const daInserimento = insertRowValue(riga, dbType);

        // Percorso MODIFICA: stessa costruzione editor che usa la cella
        // inline, con la stessa metadata di colonna.
        const editor = buildEditor(0, { type: typeName });
        editor.input.value = testo;
        const daModifica = editor.buildValue();

        risultati.push({ nome, testo, atteso, daInserimento, daModifica });
      }
      return risultati;
    });

    for (const r of esiti) {
      ok(JSON.stringify(r.daInserimento) === JSON.stringify(r.atteso),
        `inserimento: "${r.nome}" produce ${JSON.stringify(r.atteso)}`,
        `ottenuto ${JSON.stringify(r.daInserimento)}`);
      ok(JSON.stringify(r.daModifica) === JSON.stringify(r.atteso),
        `modifica inline: "${r.nome}" produce ${JSON.stringify(r.atteso)}`,
        `ottenuto ${JSON.stringify(r.daModifica)}`);
      ok(JSON.stringify(r.daInserimento) === JSON.stringify(r.daModifica),
        `inserimento e modifica coincidono per "${r.nome}" (testo "${r.testo}")`,
        `inserimento=${JSON.stringify(r.daInserimento)} modifica=${JSON.stringify(r.daModifica)}`);
    }

    /* --- 1-bis. Stesso tipo di casella: testo per i valori esatti --------- */

    const tipiCasella = await page.evaluate(async () => {
      const { insertInputFor } = await import('/js/insert.js');
      const { buildEditor } = await import('/js/inlineEdit.js');
      const casi = [
        ['bigint', 'bigint'],
        ['bigint unsigned', 'bigint unsigned'],
        ['decimal(38,18)', 'decimal(38,18)'],
        ['int', 'int'], // NON esatto: deve restare type=number in entrambi
      ];
      return casi.map(([typeName]) => {
        const kindInserimento = typeName.startsWith('decimal') ? 'decimal' : 'number';
        const inputInserimento = insertInputFor(kindInserimento, { typeName, numericMeta: { type: typeName } });
        const editor = buildEditor(0, { type: typeName });
        return { typeName, inserimento: inputInserimento.type, modifica: editor.input.type };
      });
    });
    for (const t of tipiCasella) {
      ok(t.inserimento === t.modifica,
        `casella dello stesso tipo (${t.inserimento}) per "${t.typeName}" in inserimento e modifica`,
        JSON.stringify(t));
    }
    ok(tipiCasella.find((t) => t.typeName === 'bigint').inserimento === 'text',
      'un BIGINT usa una casella di TESTO (non "number", che arrotonderebbe con le frecce native)',
      JSON.stringify(tipiCasella));

    /* --- 2. Un campo fuori intervallo nomina la colonna e non scrive nulla - */

    const rifiuto = await page.evaluate(async () => {
      const { addInsertRow, buildInsertDoc } = await import('/js/insert.js');
      addInsertRow({ name: 'id_valido', kind: 'number', typeName: 'bigint', numericMeta: { type: 'bigint' } })
        .input.value = '42';
      addInsertRow({ name: 'id_fuori_range', kind: 'number', typeName: 'bigint', numericMeta: { type: 'bigint' } })
        .input.value = '99999999999999999999'; // oltre 2^63 - 1
      try {
        const doc = buildInsertDoc();
        return { lanciato: false, doc };
      } catch (err) {
        return { lanciato: true, messaggio: err.message };
      }
    });
    ok(rifiuto.lanciato, 'un valore fuori intervallo fa fallire buildInsertDoc invece di restituire un documento parziale',
      JSON.stringify(rifiuto));
    ok(rifiuto.lanciato && /id_fuori_range/.test(rifiuto.messaggio),
      'l\'errore nomina la colonna responsabile', JSON.stringify(rifiuto));
    // `buildInsertDoc()` è chiamato PRIMA di `emit('doc:insert', …)` (vedi
    // insert.js): se lancia, quell'emit non parte affatto — non c'è quindi un
    // percorso per cui un campo valido raggiunga il database mentre uno
    // fuori intervallo viene scartato in silenzio.

    /* --- 3. Controprova: un ritorno a Number() nell'inserimento romperebbe -
     *        l'equivalenza appena provata sopra.                            */

    const controprova = await page.evaluate(() => {
      const testoCritico = '9223372036854775807'; // 2^63 - 1: illeso solo se il testo attraversa BigInt/stringa
      // Simula una regressione: `insertRowValue` che tornasse a `Number(t)`
      // per il ramo 'number' invece di `decodificaNumeroEsatto`.
      function insertRowValueDifettoso(testo) { return Number(testo); }
      const approssimato = insertRowValueDifettoso(testoCritico);
      return { testoCritico, approssimato: String(approssimato) };
    });
    ok(controprova.approssimato !== controprova.testoCritico,
      'controprova: Number() al posto del codec perde le ultime cifre di 2^63 - 1 (renderebbe rosso il confronto sopra)',
      JSON.stringify(controprova));

    ok(errori.length === 0, 'nessun errore JavaScript durante le prove', errori.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Numeri esatti nell'inserimento: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Numeri esatti nell\'inserimento: tutti i test superati ---');
})();
