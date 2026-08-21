'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari dei tetti imposti dalla giuntura (db/tetti.js).
 *
 * La domanda a cui questi test rispondono non è «i tetti funzionano», ma
 * «i tetti valgono anche per un adattatore che non fa nulla per rispettarli».
 * È la differenza fra un limite e una convenzione, ed è il motivo per cui
 * l'adattatore usato qui (`test/adattatore-finto.js`) è deliberatamente
 * disobbediente: ignora `maxRows`, non conta i byte, non ha alcun timeout.
 * Se il risultato arriva limitato, il limite non può venire da lui.
 *
 * Nessun database: la giuntura si prova avvolgendo un oggetto in memoria.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { conTetti, grazia, GRAZIA_MINIMA_MS } = require('../db/tetti');
const DbStrategy = require('../db/DbStrategy');
const DbFactory = require('../db/DbFactory');
const { AdattatoreFinto, righeFinte } = require('./adattatore-finto');

let falliti = 0;
async function prova(nome, fn) {
  try {
    await fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.message}`);
  }
}

/** Esegue `fn` con certe variabili d'ambiente, e le rimette come stavano. */
async function conAmbiente(vars, fn) {
  const prima = {};
  for (const [k, v] of Object.entries(vars)) {
    prima[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prima)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* I test che aspettano DAVVERO una scadenza userebbero i due secondi di grazia
 * minima veri: il comportamento sarebbe lo stesso e la suite unitaria ci
 * metterebbe quindici secondi in più. La grazia si accorcia solo qui. */
const GRAZIA_CORTA = { graziaMinima: 100 };

module.exports = (async () => {
  console.log('  --- Tetti imposti dalla giuntura (db/tetti.js) ---');

  /* --- Tetto sulle righe ------------------------------------------------ */

  await prova('righe: l\'adattatore ne restituisce 5.000, la giuntura ne consegna 500', async () => {
    const finto = new AdattatoreFinto({ righe: righeFinte(5000) });
    const limitato = conTetti(finto);
    const esito = await limitato.collectionFind('db', 'coll', {});
    assert.strictEqual(esito.docs.length, 500, 'il tetto predefinito è 500 righe');
    assert.strictEqual(esito.truncated, true, 'il troncamento va DICHIARATO, non fatto in silenzio');
    // L'adattatore non è stato toccato: ha davvero restituito tutto.
    assert.strictEqual(finto.righe.length, 5000);
  });

  await prova('righe: maxRows alza il tetto, ma non oltre il massimo assoluto', async () => {
    const finto = conTetti(new AdattatoreFinto({ righe: righeFinte(3000) }));
    const esito = await finto.collectionFind('db', 'coll', { maxRows: 2000 });
    assert.strictEqual(esito.docs.length, 2000);
    assert.strictEqual(esito.truncated, true);
  });

  await prova('righe: sotto il tetto non si tocca niente', async () => {
    const finto = conTetti(new AdattatoreFinto({ righe: righeFinte(3) }));
    const esito = await finto.collectionFind('db', 'coll', {});
    assert.strictEqual(esito.docs.length, 3);
    assert.strictEqual(esito.truncated, undefined, 'nessun troncamento da dichiarare');
  });

  /* --- Tetto sui byte --------------------------------------------------- */

  await prova('byte: poche righe pesanti vengono tagliate anche sotto il tetto delle righe', async () => {
    // 100 righe da ~50 KB: ben sotto le 500 righe, ben sopra un budget di 200 KB.
    const finto = conTetti(new AdattatoreFinto({ righe: righeFinte(100, 50 * 1024) }));
    const esito = await conAmbiente({ CODEDB_MAX_RESULT_BYTES: 200 * 1024 }, () =>
      finto.collectionFind('db', 'coll', {})
    );
    assert.ok(esito.docs.length < 100, `attese meno di 100 righe, arrivate ${esito.docs.length}`);
    assert.ok(esito.docs.length > 0, 'almeno una riga deve passare, altrimenti non si vede nulla');
    assert.strictEqual(esito.truncated, true);
  });

  await prova('byte: il budget vale anche sulla tab ⚡, non solo sulla griglia', async () => {
    // È la macchia che questo ticket chiude: su MySQL e PostgreSQL il budget di
    // byte valeva su collectionFind e NON su collectionAggregate.
    const finto = conTetti(new AdattatoreFinto({ righe: righeFinte(100, 50 * 1024) }));
    const esito = await conAmbiente({ CODEDB_MAX_RESULT_BYTES: 200 * 1024 }, () =>
      finto.collectionAggregate('db', 'coll', { pipeline: 'SELECT 1', maxRows: 100000 })
    );
    assert.ok(esito.docs.length < 100, `attese meno di 100 righe, arrivate ${esito.docs.length}`);
    assert.strictEqual(esito.truncated, true);
  });

  await prova('byte: budget <= 0 disattiva il controllo', async () => {
    const finto = conTetti(new AdattatoreFinto({ righe: righeFinte(100, 50 * 1024) }));
    const esito = await conAmbiente({ CODEDB_MAX_RESULT_BYTES: 0 }, () =>
      finto.collectionFind('db', 'coll', {})
    );
    assert.strictEqual(esito.docs.length, 100);
  });

  /* --- Tetto sul tempo -------------------------------------------------- */

  await prova('tempo: un adattatore senza alcun timeout viene interrotto lo stesso', async () => {
    // 60 ms di tetto e una grazia accorciata: il cane da guardia scatta a
    // 160 ms. L'adattatore ci mette molto di più e non ha alcun meccanismo suo.
    const finto = conTetti(new AdattatoreFinto({ ritardoMs: 900 }), GRAZIA_CORTA);
    await conAmbiente({ CODEDB_QUERY_TIMEOUT_MS: 60 }, async () => {
      await assert.rejects(
        () => finto.collectionFind('db', 'coll', {}),
        /superato il tetto di 60 ms/,
        'la giuntura deve smettere di aspettare'
      );
    });
  });

  await prova('tempo: la scadenza lascia un margine di grazia all\'adattatore', async () => {
    // Il margine esiste perché il messaggio preciso del motore vinca su quello
    // generico della giuntura: sotto la grazia, chi risponde è l'adattatore.
    assert.strictEqual(grazia(60), GRAZIA_MINIMA_MS, 'grazia minima di 2 s');
    assert.strictEqual(grazia(120000), 30000, 'un quarto sui tetti grandi');
    const finto = conTetti(new AdattatoreFinto({ ritardoMs: 40, righe: righeFinte(2) }), GRAZIA_CORTA);
    const esito = await conAmbiente({ CODEDB_QUERY_TIMEOUT_MS: 60 }, () =>
      finto.collectionFind('db', 'coll', {})
    );
    assert.strictEqual(esito.docs.length, 2, 'entro la grazia la risposta arriva normalmente');
  });

  await prova('tempo: il conteggio degrada a "totale sconosciuto", non fallisce', async () => {
    // Un errore toglierebbe alla griglia anche le righe che ha già; il totale
    // ignoto lo sa mostrare.
    const finto = conTetti(new AdattatoreFinto({ ritardoMs: 900 }), GRAZIA_CORTA);
    const esito = await conAmbiente({ CODEDB_COUNT_TIMEOUT_MS: 50 }, () =>
      finto.collectionCount('db', 'coll', {})
    );
    assert.deepStrictEqual(esito, { total: null, timedOut: true });
  });

  await prova('tempo: tetto <= 0 disattiva il cane da guardia', async () => {
    const finto = conTetti(new AdattatoreFinto({ ritardoMs: 80, righe: righeFinte(1) }));
    const esito = await conAmbiente({ CODEDB_QUERY_TIMEOUT_MS: 0 }, () =>
      finto.collectionFind('db', 'coll', {})
    );
    assert.strictEqual(esito.docs.length, 1);
  });

  await prova('tempo: l\'adattatore può dichiarare un\'esecuzione fuori dal tetto', async () => {
    // È il caso di $out/$merge su MongoDB: fermarle a metà lascia la
    // destinazione scritta a metà.
    const finto = new AdattatoreFinto({ ritardoMs: 900, righe: righeFinte(1) });
    finto.fuoriDalTettoDiTempo = (metodo) => metodo === 'collectionAggregate';
    const limitato = conTetti(finto, GRAZIA_CORTA);
    await conAmbiente({ CODEDB_AGGREGATE_TIMEOUT_MS: 30 }, async () => {
      // La aggregate passa nonostante il tetto di 30 ms...
      const esito = await limitato.collectionAggregate('db', 'coll', {});
      assert.strictEqual(esito.docs.length, 1);
      // ...ma la find no: l'esclusione è per esecuzione, non per adattatore.
      await conAmbiente({ CODEDB_QUERY_TIMEOUT_MS: 30 }, async () => {
        await assert.rejects(() => limitato.collectionFind('db', 'coll', {}), /superato il tetto/);
      });
    });
  });

  await prova('tempo: un errore in ritardo non diventa un rifiuto non gestito', async () => {
    // L'esecuzione abbandonata continua: se fallisce dopo la scadenza e nessuno
    // la sta più ascoltando, il processo morirebbe.
    const finto = {
      type: 'finto',
      // Timer non sganciati: devono tenere il processo sveglio abbastanza da
      // vedere se il rifiuto in ritardo resta senza gestore.
      collectionFind: () => new Promise((_, rifiuta) => {
        setTimeout(() => rifiuta(new Error('esploso in ritardo')), 400);
      }),
    };
    const limitato = conTetti(finto, GRAZIA_CORTA);
    let nonGestito = null;
    const spia = (err) => { nonGestito = err; };
    process.on('unhandledRejection', spia);
    try {
      await conAmbiente({ CODEDB_QUERY_TIMEOUT_MS: 50 }, async () => {
        await assert.rejects(() => limitato.collectionFind('db', 'coll', {}), /superato il tetto/);
        await new Promise((r) => { setTimeout(r, 600); });
      });
    } finally {
      process.off('unhandledRejection', spia);
    }
    assert.strictEqual(nonGestito, null, 'nessun rifiuto non gestito dopo la scadenza');
  });

  /* --- La giuntura non deve disturbare il resto ------------------------- */

  await prova('i metodi non soggetti ai tetti passano intatti', async () => {
    const finto = conTetti(new AdattatoreFinto());
    assert.deepStrictEqual(await finto.listDatabases(), ['uno', 'due']);
  });

  await prova('proprietà e scritture attraversano la giuntura', async () => {
    // Il motore di backup legge strategy.pool/strategy.client; il Query Engine
    // scrive strategy.currentDb.
    const finto = conTetti(new AdattatoreFinto());
    assert.strictEqual(finto.type, 'finto');
    finto.currentDb = 'prova';
    assert.strictEqual(finto.currentDb, 'prova');
  });

  await prova('gli argomenti arrivano all\'adattatore invariati', async () => {
    const nudo = new AdattatoreFinto({ righe: righeFinte(2) });
    const finto = conTetti(nudo);
    await finto.collectionFind('miodb', 'miatab', { filter: 'x = 1' });
    assert.deepStrictEqual(nudo.chiamate[0], {
      metodo: 'collectionFind', db: 'miodb', coll: 'miatab', payload: { filter: 'x = 1' },
    });
  });

  /* --- I tre motori veri nascono limitati -------------------------------- */

  await prova('le tre strategie vere escono dalla fabbrica già limitate', async () => {
    // Il punto del ticket: non «gli adattatori chiamano i tetti», ma «chiunque
    // ottenga una strategia la ottiene limitata».
    for (const tipo of ['mongodb', 'mysql', 'postgresql']) {
      const s = DbFactory.getStrategy(tipo);
      // La giuntura sostituisce il metodo con il proprio involucro: il nome
      // della funzione lo dichiara.
      assert.strictEqual(s.collectionFind.name, 'conTettiApplicati', `motore ${tipo}`);
      assert.strictEqual(s.collectionAggregate.name, 'conTettiApplicati', `motore ${tipo}`);
      assert.strictEqual(s.collectionCount.name, 'conTettiApplicati', `motore ${tipo}`);
    }
  });

  await prova('la classe base risponde "no" all\'esclusione dal tetto', async () => {
    // Un motore nuovo nasce limitato: per uscirne deve dichiararlo.
    assert.strictEqual(new DbStrategy().fuoriDalTettoDiTempo('collectionAggregate', []), false);
  });

  await prova('MongoDB dichiara fuori dal tetto solo $out e $merge finali', async () => {
    const mongo = DbFactory.getStrategy('mongodb');
    const chiedi = (pipeline) => mongo.fuoriDalTettoDiTempo(
      'collectionAggregate', ['db', 'coll', { pipeline: JSON.stringify(pipeline) }]
    );
    assert.strictEqual(chiedi([{ $out: 'copia' }]), true);
    assert.strictEqual(chiedi([{ $merge: { into: 'copia' } }]), true);
    assert.strictEqual(chiedi([{ $match: { a: 1 } }]), false);
    // $out non finale non è una materializzazione valida per MongoDB: non va
    // esclusa dal tetto solo perché compare da qualche parte.
    assert.strictEqual(chiedi([{ $out: 'copia' }, { $match: { a: 1 } }]), false);
    assert.strictEqual(chiedi([]), false);
    assert.strictEqual(mongo.fuoriDalTettoDiTempo('collectionFind', ['db', 'coll', {}]), false);
  });

  if (falliti) throw new Error(`${falliti} test dei tetti falliti`);
  console.log('  Tutti i test sui tetti superati.');
})();
