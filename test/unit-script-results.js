'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari del deposito dei result set di uno script (db/ScriptResults.js).
 *
 * Nessun database e nessun socket: qui si prova ciò che decide quanto disco e
 * quanta memoria costa mostrare "un risultato per istruzione", e la cosa che
 * più facilmente passa inosservata — i file che RESTANO. Sono file con dentro
 * righe di database: dimenticarne uno non fa fallire niente, ed è esattamente
 * per questo che va tenuto fermo da un test.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { idDeposito, creaDeposito, puliziaVecchi } = require('../db/ScriptResults');

const radice = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-test-risultati-'));
const risultato = (docs, columns) => ({ res: { docs, columns } });

(async () => {
  console.log('--- Test Unitari: deposito dei result set di uno script ---');

  // 1. L'identificativo lega il deposito alla query e al momento. Base64url:
  //    un "/" nel nome di una cartella è un separatore di percorso, cioè un
  //    modo per scrivere altrove.
  {
    const id = idDeposito('SELECT * FROM Pippo', 1787094643810);
    assert.ok(/^[A-Za-z0-9_-]+-1787094643810$/.test(id), `id non conforme: ${id}`);
    assert.strictEqual(id.split('-').slice(0, -1).join('-').length, 10, 'dieci caratteri di testa');
    // Stessa query, momenti diversi: identificativi diversi.
    assert.notStrictEqual(idDeposito('SELECT 1', 1), idDeposito('SELECT 1', 2));
    // Query diverse, stesso momento: identificativi diversi.
    assert.notStrictEqual(idDeposito('SELECT 1', 1), idDeposito('DELETE FROM t', 1));
    // Nessun carattere fuori dall'alfabeto dei nomi di file, qualunque sia il
    // testo della query (accenti, apici, barre, ideogrammi).
    // Il caso che conta è quello che il base64 NORMALE rovinerebbe: "ÿÿÿ"
    // produce "w7/Dv8O/", con dentro la barra — che in un nome di cartella è un
    // separatore di percorso, cioè un modo per scrivere fuori dalla radice. Con
    // un testo qualsiasi il difetto non si vedrebbe: i primi dieci caratteri
    // quasi sempre cadono nella parte innocua dell'alfabeto.
    for (const testo of ['ÿÿÿ', "SELECT 'à/b' FROM 日本", 'SELECT "😀" FROM t']) {
      const strano = idDeposito(testo, 5);
      assert.ok(/^[A-Za-z0-9_-]+-5$/.test(strano), `id con caratteri non ammessi da ${testo}: ${strano}`);
    }
    // Query vuota: un identificativo c'è comunque.
    assert.ok(idDeposito('', 5).startsWith('script-'));
  }
  console.log('  OK   Identificativo: 10 caratteri di base64url + timestamp');

  // 2. Andata e ritorno di una scheda: l'elenco NON porta i documenti (è il
  //    motivo per cui esiste il deposito), il contenuto arriva solo su richiesta.
  {
    const d = creaDeposito('SELECT * FROM alfa', { radice });
    const voce = await d.aggiungi({ index: 1, line: 2, sql: 'SELECT * FROM alfa', ...risultato([{ id: 1 }, { id: 2 }], ['id']) });
    assert.strictEqual(voce.pos, 0);
    assert.strictEqual(voce.rows, 2);

    const elenco = d.elenco();
    assert.strictEqual(elenco.schede.length, 1);
    assert.ok(!('docs' in elenco.schede[0]), 'l\'elenco non deve portare le righe');
    assert.deepStrictEqual(elenco.schede[0].columns, ['id']);

    const letto = await d.leggi(0);
    assert.deepStrictEqual(letto.docs, [{ id: 1 }, { id: 2 }]);
    assert.strictEqual(letto.line, 2);
    await d.elimina();
  }
  console.log('  OK   L\'elenco è leggero, le righe arrivano solo con leggi()');

  // 3. Un result set VUOTO è una scheda: è il difetto da cui è nato tutto.
  {
    const d = creaDeposito('SELECT * FROM vuota', { radice });
    const voce = await d.aggiungi({ index: 0, line: 1, sql: 'SELECT * FROM vuota', ...risultato([], ['id', 'addsa']) });
    assert.ok(voce, 'un result set vuoto deve produrre una scheda');
    assert.strictEqual(voce.rows, 0);
    assert.deepStrictEqual((await d.leggi(0)).columns, ['id', 'addsa'],
      'le colonne servono a disegnare la tabella vuota');
    await d.elimina();
  }
  console.log('  OK   Un result set vuoto è una scheda, con le sue colonne');

  // 4. Tetto sul NUMERO: si tengono i primi, e gli altri si CONTANO. Una
  //    scheda che sparisce senza spiegazione sembra un risultato perso.
  {
    const d = creaDeposito('script lungo', { radice, maxRisultati: 3 });
    for (let i = 0; i < 10; i += 1) {
      await d.aggiungi({ index: i, line: i + 1, sql: `SELECT ${i}`, ...risultato([{ n: i }], ['n']) });
    }
    const elenco = d.elenco();
    assert.strictEqual(elenco.schede.length, 3);
    assert.strictEqual(elenco.scartati, 7, 'gli scartati vanno contati, non taciuti');
    assert.strictEqual((await d.leggi(0)).docs[0].n, 0, 'si tengono i PRIMI: le linguette non devono spostarsi');
    assert.strictEqual(fs.readdirSync(d.dir).length, 3, 'e non si scrivono file oltre il tetto');
    await d.elimina();
  }
  console.log('  OK   Tetto sul numero: si tengono i primi, gli altri si dichiarano');

  // 5. Tetto sui BYTE: il numero da solo non basta, cinquanta SELECT da trenta
  //    megabyte riempiono il disco della macchina.
  {
    const grande = Array.from({ length: 20 }, (_, i) => ({ testo: 'x'.repeat(20), i }));
    // Budget tarato su DUE schede: il tetto va provato dove scatta, non a caso.
    const unaScheda = Buffer.byteLength(JSON.stringify({ index: 0, line: 0, sql: 'SELECT', columns: ['testo'], docs: grande }), 'utf8');
    const d = creaDeposito('script pesante', { radice, maxBytes: unaScheda * 2 + 10 });
    let accettate = 0;
    for (let i = 0; i < 5; i += 1) {
      if (await d.aggiungi({ index: i, line: i, sql: 'SELECT', ...risultato(grande, ['testo']) })) accettate += 1;
    }
    assert.strictEqual(accettate, 2, `il budget deve fermare le eccedenti (accettate: ${accettate})`);
    assert.strictEqual(d.elenco().scartati, 3);
    assert.strictEqual(fs.readdirSync(d.dir).length, 2, 'e non si scrive oltre il budget');
    await d.elimina();
  }
  console.log('  OK   Tetto sui byte: oltre il budget non si scrive più');

  // 6. Collisione: stesso testo, stesso millisecondo, due tab. Due depositi che
  //    condividessero la cartella si sovrascriverebbero i risultati a vicenda.
  {
    const a = creaDeposito('SELECT 1', { radice });
    const b = creaDeposito('SELECT 1', { radice });
    assert.notStrictEqual(a.dir, b.dir, 'due depositi non possono condividere la cartella');
    await a.aggiungi({ index: 0, line: 1, sql: 'SELECT 1', ...risultato([{ a: 1 }], ['a']) });
    await b.aggiungi({ index: 0, line: 1, sql: 'SELECT 1', ...risultato([{ b: 2 }], ['b']) });
    assert.deepStrictEqual((await a.leggi(0)).docs, [{ a: 1 }], 'il primo deposito non deve essere sovrascritto');
    await a.elimina(); await b.elimina();
  }
  console.log('  OK   Due run non condividono mai la stessa cartella');

  // 7. Una posizione inesistente è un errore PARLANTE, non un file letto a caso
  //    (o peggio: un percorso costruito con quello che arriva dal client).
  {
    const d = creaDeposito('SELECT 1', { radice });
    await d.aggiungi({ index: 0, line: 1, sql: 'SELECT 1', ...risultato([{ a: 1 }], ['a']) });
    for (const pos of [1, -1, 99, '../../segreto', null, undefined, 1.5, 'abc']) {
      await assert.rejects(() => d.leggi(pos), /inesistente/i, `posizione accettata: ${pos}`);
    }
    await d.elimina();
  }
  console.log('  OK   Posizione inesistente o malformata: errore, non un file a caso');

  // 8. elimina() cancella davvero. È la garanzia che tiene la cartella
  //    temporanea pulita: qui dentro ci sono righe di database.
  {
    const d = creaDeposito('SELECT 1', { radice });
    await d.aggiungi({ index: 0, line: 1, sql: 'SELECT 1', ...risultato([{ a: 1 }], ['a']) });
    assert.ok(fs.existsSync(d.dir));
    await d.elimina();
    assert.ok(!fs.existsSync(d.dir), 'la cartella deve sparire');
    // Dopo la chiusura non si aggiunge più: un run finito non deve poter
    // ricreare i propri file alle spalle di chi ha appena pulito.
    assert.strictEqual(await d.aggiungi({ index: 1, line: 2, sql: 'SELECT 2', ...risultato([{ a: 2 }], ['a']) }), null);
    assert.ok(!fs.existsSync(d.dir));
    // Ed è idempotente: la chiusura del socket può arrivare dopo la fine del run.
    await d.elimina();
  }
  console.log('  OK   elimina() cancella i file, ed è definitivo e ripetibile');

  // 9. Passata di pulizia: un arresto anomalo non esegue nessun elimina(), e
  //    quei file restano lì con dentro dati di database.
  {
    const vecchio = creaDeposito('vecchio', { radice });
    await vecchio.aggiungi({ index: 0, line: 1, sql: 'SELECT 1', ...risultato([{ a: 1 }], ['a']) });
    const recente = creaDeposito('recente', { radice });
    await recente.aggiungi({ index: 0, line: 1, sql: 'SELECT 1', ...risultato([{ a: 1 }], ['a']) });
    // Il vecchio viene invecchiato a mano di due ore.
    const dueOreFa = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(vecchio.dir, dueOreFa, dueOreFa);

    const rimossi = await puliziaVecchi({ radice, etaMassimaMs: 60 * 60 * 1000 });
    assert.ok(rimossi >= 1, 'il deposito vecchio doveva essere rimosso');
    assert.ok(!fs.existsSync(vecchio.dir), 'il vecchio non c\'è più');
    assert.ok(fs.existsSync(recente.dir), 'il recente NON va toccato: potrebbe essere di un run in corso');
    await recente.elimina();
  }
  console.log('  OK   La pulizia rimuove i depositi vecchi e risparmia quelli vivi');

  // 10. La pulizia su una radice inesistente non è un errore: al primo avvio
  //     non c'è ancora nulla, e un'eccezione lì fermerebbe l'avvio del server.
  assert.strictEqual(await puliziaVecchi({ radice: path.join(radice, 'mai-creata') }), 0);
  console.log('  OK   Pulizia su radice inesistente: zero, non un\'eccezione');

  fs.rmSync(radice, { recursive: true, force: true });
  console.log('Tutti i test unitari sul deposito dei risultati superati!');
})().catch((err) => {
  fs.rmSync(radice, { recursive: true, force: true });
  console.error('\nFALLITO (deposito risultati):', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
