'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario della macchina a stati di db/ScriptRunner.js.
 *
 * Verifica le due proprietà su cui si regge la funzione "script = query in
 * sospeso": si CONTINUA dopo un errore riportandolo, e la ripresa riparte dal
 * cursore conservato senza rieseguire ciò che era già passato (rieseguire un
 * INSERT sarebbe un duplicato silenzioso). Nessun database richiesto.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { createScriptRun, STATUS } = require('../db/ScriptRunner');

let falliti = 0;
async function prova(nome, fn) {
  try {
    await fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.stack || err.message}`);
  }
}

const stmts = (n) => Array.from({ length: n }, (_, i) => ({ sql: `SELECT ${i}`, line: i + 1 }));

(async () => {
  console.log('--- Test unitari ScriptRunner ---');

  await prova('Esecuzione completa: ordine, conteggi e stato finale', async () => {
    const visti = [];
    const run = createScriptRun({ id: 'r1', statements: stmts(4) });
    const st = await run.start(async (s, i) => { visti.push(i); return { docs: [1, 2] }; });

    assert.deepStrictEqual(visti, [0, 1, 2, 3]);
    assert.strictEqual(st.status, STATUS.DONE);
    assert.strictEqual(st.eseguiti, 4);
    assert.strictEqual(st.falliti, 0);
    assert.strictEqual(st.cursor, 4);
    assert.strictEqual(st.results[0].rows, 2);
    assert.strictEqual(st.results[2].line, 3);
  });

  await prova('Continua e riporta: un errore non ferma lo script', async () => {
    const run = createScriptRun({ id: 'r2', statements: stmts(4) });
    const st = await run.start(async (s, i) => {
      if (i === 1) throw new Error('tabella inesistente');
      return { docs: [] };
    });

    assert.strictEqual(st.status, STATUS.DONE);
    assert.strictEqual(st.eseguiti, 4, 'tutte le istruzioni devono essere tentate');
    assert.strictEqual(st.falliti, 1);
    assert.strictEqual(st.results[1].ok, false);
    assert.strictEqual(st.results[1].error, 'tabella inesistente');
    assert.strictEqual(st.results[1].line, 2, 'l\'errore deve puntare la riga giusta');
    assert.strictEqual(st.results[2].ok, true, 'si prosegue dopo il fallimento');
  });

  await prova('stopOnError: si ferma in pausa, riprendibile', async () => {
    const run = createScriptRun({ id: 'r3', statements: stmts(4), stopOnError: true });
    const st = await run.start(async (s, i) => {
      if (i === 1) throw new Error('boom');
      return {};
    });

    assert.strictEqual(st.status, STATUS.PAUSED);
    assert.strictEqual(st.eseguiti, 2);
    assert.strictEqual(st.cursor, 2, 'il cursore supera l\'istruzione fallita');

    const finale = await run.resume(async () => ({}));
    assert.strictEqual(finale.status, STATUS.DONE);
    assert.strictEqual(finale.eseguiti, 4);
  });

  await prova('Pausa a metà: nessuna istruzione persa né ripetuta alla ripresa', async () => {
    const eseguiti = [];
    const run = createScriptRun({ id: 'r4', statements: stmts(6) });

    const st = await run.start(async (s, i) => {
      eseguiti.push(i);
      if (i === 2) run.pause(); // pausa chiesta DURANTE la terza istruzione
      return {};
    });

    assert.strictEqual(st.status, STATUS.PAUSED);
    assert.deepStrictEqual(eseguiti, [0, 1, 2], 'l\'istruzione in corso viene completata');
    assert.strictEqual(st.cursor, 3);

    const finale = await run.resume(async (s, i) => { eseguiti.push(i); return {}; });
    assert.strictEqual(finale.status, STATUS.DONE);
    assert.deepStrictEqual(eseguiti, [0, 1, 2, 3, 4, 5], 'nessun doppione, nessun salto');
  });

  await prova('Ripresa da un indice esplicito (riesecuzione mirata)', async () => {
    const eseguiti = [];
    const run = createScriptRun({ id: 'r5', statements: stmts(3) });
    await run.start(async (s, i) => { eseguiti.push(i); return {}; });

    await run.resume(async (s, i) => { eseguiti.push(i); return {}; }, 1);
    assert.deepStrictEqual(eseguiti, [0, 1, 2, 1, 2]);
  });

  await prova('abort: interruzione definitiva, non riprendibile', async () => {
    const eseguiti = [];
    const run = createScriptRun({ id: 'r6', statements: stmts(5) });
    const st = await run.start(async (s, i) => {
      eseguiti.push(i);
      if (i === 1) run.abort();
      return {};
    });

    assert.strictEqual(st.status, STATUS.ABORTED);
    assert.deepStrictEqual(eseguiti, [0, 1]);

    const dopo = await run.resume(async (s, i) => { eseguiti.push(i); return {}; });
    assert.strictEqual(dopo.status, STATUS.ABORTED);
    assert.deepStrictEqual(eseguiti, [0, 1], 'dopo abort non si esegue più nulla');
  });

  await prova('Progresso notificato per ogni istruzione, più la fine', async () => {
    const eventi = [];
    const run = createScriptRun({
      id: 'r7',
      statements: stmts(2),
      onProgress: (ev) => eventi.push(ev),
    });
    await run.start(async () => ({}));

    assert.strictEqual(eventi.filter((e) => e.tipo === 'statement').length, 2);
    assert.strictEqual(eventi[eventi.length - 1].tipo, 'done');
    assert.strictEqual(eventi[0].runId, 'r7');
    assert.strictEqual(eventi[0].total, 2);
  });

  await prova('Un listener che esplode non fa fallire lo script', async () => {
    const run = createScriptRun({
      id: 'r8',
      statements: stmts(2),
      onProgress: () => { throw new Error('listener rotto'); },
    });
    const st = await run.start(async () => ({}));
    assert.strictEqual(st.status, STATUS.DONE);
    assert.strictEqual(st.falliti, 0);
  });

  await prova('Script vuoto: termina subito senza errori', async () => {
    const run = createScriptRun({ id: 'r9', statements: [] });
    const st = await run.start(async () => ({}));
    assert.strictEqual(st.status, STATUS.DONE);
    assert.strictEqual(st.total, 0);
    assert.strictEqual(st.eseguiti, 0);
  });

  if (falliti) {
    console.error(`\n${falliti} test falliti.`);
    process.exitCode = 1;
  } else {
    console.log('\nTutti i test dello ScriptRunner superati!');
  }
})();
