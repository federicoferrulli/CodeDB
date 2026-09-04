'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario dell'interprete di script MongoDB (db/MongoScript.js +
 * db/MongoScriptRunner.js). Nessun database: l'`host` è finto e registra le
 * chiamate, così si verifica ANCHE che lo script parli col database nel modo
 * previsto (payload EJSON, operazioni giuste).
 *
 * La sezione più importante è "Sandbox": l'interprete esiste per non usare
 * `eval`, quindi le prove di evasione — risalire a `Function` da un array,
 * raggiungere `require`/`process`, scrivere sui prototipi — sono il vero
 * collaudo. Un fallimento lì è una vulnerabilità, non un bug di comodità.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { eseguiScript, sembraScriptJs } = require('../db/MongoScriptRunner');

let falliti = 0;
async function prova(nome, fn) {
  try {
    await fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err && err.message}`);
  }
}

/** Host finto: registra le chiamate e restituisce documenti preconfezionati. */
function hostFinto(risposte = {}) {
  const chiamate = [];
  return {
    chiamate,
    async find(db, coll, payload) {
      chiamate.push({ op: 'find', db, coll, payload });
      return { docs: risposte.docs || [] };
    },
    async aggregate(db, coll, payload) {
      chiamate.push({ op: 'aggregate', db, coll, payload });
      return { docs: risposte.aggregate || [] };
    },
    async count(db, coll, payload) {
      chiamate.push({ op: 'count', db, coll, payload });
      return { total: risposte.total != null ? risposte.total : 0 };
    },
    async write(db, coll, payload) {
      chiamate.push({ op: 'write', db, coll, payload });
      return { ok: 1, inserted: 1 };
    },
    async listCollections(db) { chiamate.push({ op: 'listCollections', db }); return risposte.collections || []; },
    async createCollection(db, nome) { chiamate.push({ op: 'createCollection', db, nome }); },
    async dropCollection(db, coll) { chiamate.push({ op: 'dropCollection', db, coll }); },
    async dropDatabase(db) { chiamate.push({ op: 'dropDatabase', db }); },
    async createIndex(db, coll, payload) { chiamate.push({ op: 'createIndex', db, coll, payload }); },
    async dropIndex(db, coll, nome) { chiamate.push({ op: 'dropIndex', db, coll, nome }); },
  };
}

const esegui = (code, host = hostFinto(), opz = {}) =>
  eseguiScript(code, host, { db: 'testdb', ...opz });

async function deveFallire(code, atteso, host = hostFinto(), opz = {}) {
  let err = null;
  try {
    await esegui(code, host, opz);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `lo script doveva fallire: ${code}`);
  if (atteso) {
    assert.ok(atteso.test(err.message), `messaggio inatteso: ${err.message}`);
  }
  return err;
}

(async () => {
  console.log('--- Test unitari interprete script MongoDB ---');

  /* === Linguaggio ======================================================== */

  await prova('Variabili, aritmetica e print', async () => {
    const r = await esegui('const a = 2; let b = 3; print(a * b + 1);');
    assert.deepStrictEqual(r.output, ['7']);
  });

  await prova('Stringhe, template literal e interpolazione', async () => {
    const r = await esegui("const n = 'mondo'; print(`ciao ${n}, ${1 + 1}`);");
    assert.deepStrictEqual(r.output, ['ciao mondo, 2']);
  });

  await prova('if / else', async () => {
    const r = await esegui('const x = 5; if (x > 3) { print("grande"); } else { print("piccolo"); }');
    assert.deepStrictEqual(r.output, ['grande']);
  });

  await prova('Ciclo for classico con break e continue', async () => {
    const r = await esegui(`
      let somma = 0;
      for (let i = 0; i < 10; i++) {
        if (i === 3) continue;
        if (i === 6) break;
        somma += i;
      }
      print(somma);
    `);
    assert.deepStrictEqual(r.output, ['12']); // 0+1+2+4+5
  });

  await prova('for…of e for…in', async () => {
    const r = await esegui(`
      const arr = [10, 20, 30];
      let t = 0;
      for (const v of arr) { t += v; }
      print(t);
      const o = { a: 1, b: 2 };
      let chiavi = '';
      for (const k in o) { chiavi += k; }
      print(chiavi);
    `);
    assert.deepStrictEqual(r.output, ['60', 'ab']);
  });

  await prova('while e do…while', async () => {
    const r = await esegui('let i = 0; while (i < 3) { i++; } print(i); let j = 0; do { j++; } while (j < 2); print(j);');
    assert.deepStrictEqual(r.output, ['3', '2']);
  });

  await prova('Funzioni, chiusure, ricorsione e hoisting', async () => {
    const r = await esegui(`
      print(fattoriale(5));
      function fattoriale(n) { return n <= 1 ? 1 : n * fattoriale(n - 1); }
      function contatore() { let n = 0; return function () { n++; return n; }; }
      const c = contatore();
      c(); c();
      print(c());
    `);
    assert.deepStrictEqual(r.output, ['120', '3']);
  });

  await prova('Arrow function e metodi di array', async () => {
    const r = await esegui(`
      const nums = [1, 2, 3, 4];
      const pari = nums.filter((n) => n % 2 === 0);
      const doppi = pari.map((n) => n * 2);
      print(doppi.join(','));
      print(nums.length);
    `);
    assert.deepStrictEqual(r.output, ['4,8', '4']);
  });

  await prova('Oggetti, array, accesso e assegnamento', async () => {
    const r = await esegui(`
      const o = { a: 1, lista: [1, 2] };
      o.b = 5;
      o.lista[0] = 9;
      o['c'] = o.a + o.b;
      print(o.b, o.lista[0], o.c, Object.keys(o).join('|'));
    `);
    assert.deepStrictEqual(r.output, ['5 9 6 a|lista|b|c']);
  });

  await prova('try / catch / finally e throw', async () => {
    const r = await esegui(`
      try {
        throw 'rotto';
      } catch (e) {
        print('preso: ' + e.message);
      } finally {
        print('finito');
      }
    `);
    assert.deepStrictEqual(r.output, ['preso: rotto', 'finito']);
  });

  await prova('typeof, operatori logici e ternario', async () => {
    const r = await esegui(`
      print(typeof 1, typeof 'x', typeof nonEsiste);
      print(null ?? 'predefinito');
      print(0 || 'vuoto');
      print(1 && 'ok');
    `);
    assert.deepStrictEqual(r.output, ['number string undefined', 'predefinito', 'vuoto', 'ok']);
  });

  await prova('JSON, Math e Date', async () => {
    const r = await esegui(`
      print(JSON.stringify({ a: 1 }));
      print(Math.max(3, 7), Math.floor(2.9));
      const d = new Date('2026-01-02T03:04:05.000Z');
      print(d.toISOString());
    `);
    assert.deepStrictEqual(r.output, ['{"a":1}', '7 2', '2026-01-02T03:04:05.000Z']);
  });

  /* === Sandbox: prove di evasione ======================================= */

  await prova('SANDBOX: non si risale a Function dai valori nativi', async () => {
    await deveFallire('[].constructor', /constructor/);
    await deveFallire("''.constructor", /constructor/);
    await deveFallire('({}).constructor', /constructor/);
    await deveFallire('const f = () => 1; f.constructor', /constructor|non espongono/);
  });

  await prova('SANDBOX: __proto__ e prototype negati', async () => {
    await deveFallire('({}).__proto__', /__proto__/);
    await deveFallire('const o = {}; o.__proto__ = { x: 1 };', /__proto__/);
    await deveFallire('[].prototype', /prototype/);
  });

  await prova('SANDBOX: le globali del processo non esistono', async () => {
    for (const nome of ['require', 'process', 'global', 'globalThis', 'Function', 'eval', 'module', 'Buffer', 'setTimeout']) {
      await deveFallire(`${nome}`, /Nome non definito/);
    }
  });

  await prova('SANDBOX: call/apply/bind non raggiungibili', async () => {
    await deveFallire('const f = () => 1; f.call({});', /non espongono/);
    await deveFallire('const f = () => 1; f.apply({});', /non espongono/);
  });

  await prova('SANDBOX: metodi nativi fuori whitelist non esistono', async () => {
    // `flatMap` non è in whitelist: deve risultare inesistente, non chiamabile.
    await deveFallire('[1,2].flatMap((x) => x)', /Metodo non trovato|non richiamabile/);
  });

  await prova('SANDBOX: gli oggetti del database non sono modificabili', async () => {
    await deveFallire('db.utenti = 1;', /Variabile non dichiarata|non sono modificabili/);
    await deveFallire('db.utenti.find = 1;', /non sono modificabili/);
  });

  /* === Budget ============================================================ */

  await prova('BUDGET: ciclo infinito interrotto', async () => {
    const err = await deveFallire('while (true) { }', /iterazioni|operazioni/, hostFinto(), {
      limiti: { iterazioni: 1000, passi: 100000 },
    });
    assert.ok(err.budget, 'l\'errore deve essere marcato come budget');
  });

  await prova('BUDGET: un try/catch NON neutralizza il limite', async () => {
    // È il caso che rende il budget una protezione vera: se fosse catturabile,
    // `try { while(true) {} } catch {}` bloccherebbe il server per sempre.
    await deveFallire(
      'try { while (true) { } } catch (e) { print("catturato"); }',
      /iterazioni|operazioni/,
      hostFinto(),
      { limiti: { iterazioni: 500, passi: 100000 } }
    );
  });

  await prova('BUDGET: ricorsione senza uscita interrotta', async () => {
    await deveFallire(
      'function f() { return f(); } f();',
      /annidate|operazioni/,
      hostFinto(),
      { limiti: { profondita: 20 } }
    );
  });

  await prova('BUDGET: tetto alle operazioni sul database', async () => {
    await deveFallire(
      'for (let i = 0; i < 100; i++) { db.c.insertOne({ i: i }); }',
      /operazioni sul database/,
      hostFinto(),
      { limiti: { chiamateDb: 10 } }
    );
  });

  await prova('BUDGET: la memoria di un singolo valore è limitata (CDB-65)', async () => {
    // Gli altri budget contano OPERAZIONI e non fermano un'allocazione singola:
    // ciascuno di questi script esauriva l'heap del processo (misurato: OOM in
    // 394 ms con --max-old-space-size=256) usando una manciata di passi, e con
    // il processo cadevano le sessioni di tutti gli utenti.
    const limiti = { memoriaBytes: 1024 * 1024 }; // 1 MB: la soglia si prova, non si aspetta
    const vettori = [
      ['una stringa ripetuta', 'let s = "x".repeat(500000000); print(s.length);'],
      ['un array raddoppiato', 'let a = [1]; for (let i = 0; i < 26; i++) { a = a.concat(a); }'],
      ['una stringa raddoppiata', 'let s = "x"; for (let i = 0; i < 40; i++) { s = s + s; }'],
      ['un riempimento', 'print("x".padEnd(400000000).length);'],
    ];
    for (const [nome, code] of vettori) {
      await deveFallire(code, /oltre il limite di|CODEDB_SCRIPT_MAX_BYTES/, hostFinto(), { limiti });
      void nome;
    }

    // E, come ogni budget, non deve essere neutralizzabile dallo script.
    await deveFallire(
      'try { "x".repeat(500000000); } catch (e) { print("catturato"); }',
      /oltre il limite di/,
      hostFinto(),
      { limiti }
    );

    // Il lavoro legittimo non deve pagare nulla: qui sotto la soglia.
    const r = await esegui(
      'let a = []; for (let i = 0; i < 500; i++) { a.push(i); } print(a.length + " " + "ab".repeat(3));',
      hostFinto(),
      { limiti }
    );
    assert.deepStrictEqual(r.output, ['500 ababab']);
  });

  /* === Dialogo col database ============================================= */

  await prova('find/toArray: filtro convertito in EJSON e documenti restituiti', async () => {
    const host = hostFinto({ docs: [{ nome: 'a' }, { nome: 'b' }] });
    const r = await esegui("const d = db.utenti.find({ eta: { $gt: 30 } }).toArray(); print(d.length, d[0].nome);", host);
    assert.deepStrictEqual(r.output, ['2 a']);
    const chiamata = host.chiamate.find((c) => c.op === 'find');
    assert.strictEqual(chiamata.db, 'testdb');
    assert.strictEqual(chiamata.coll, 'utenti');
    assert.strictEqual(chiamata.payload.filter, '{"eta":{"$gt":30}}');
  });

  await prova('Catena sort/limit/skip trasmessa alla strategia', async () => {
    const host = hostFinto({ docs: [] });
    await esegui('db.utenti.find({}).sort({ nome: 1 }).limit(5).skip(2).toArray();', host);
    const c = host.chiamate.find((x) => x.op === 'find');
    assert.strictEqual(c.payload.sort, '{"nome":1}');
    assert.strictEqual(c.payload.limit, 5);
    assert.strictEqual(c.payload.skip, 2);
  });

  await prova('for…of su un cursore lo materializza', async () => {
    const host = hostFinto({ docs: [{ n: 1 }, { n: 2 }, { n: 3 }] });
    const r = await esegui('let t = 0; for (const d of db.c.find({})) { t += d.n; } print(t);', host);
    assert.deepStrictEqual(r.output, ['6']);
  });

  await prova('Scritture: insertOne/updateMany/deleteMany raggiungono l\'host', async () => {
    const host = hostFinto();
    await esegui(`
      db.c.insertOne({ a: 1 });
      db.c.updateMany({ a: 1 }, { $set: { b: 2 } });
      db.c.deleteMany({ a: 1 });
    `, host);
    const ops = host.chiamate.filter((c) => c.op === 'write').map((c) => c.payload.op);
    assert.deepStrictEqual(ops, ['insertOne', 'updateMany', 'deleteMany']);
    const update = host.chiamate.find((c) => c.payload && c.payload.op === 'updateMany');
    assert.strictEqual(update.payload.filter, '{"a":1}');
    assert.strictEqual(update.payload.update, '{"$set":{"b":2}}');
  });

  await prova('Costruttori BSON convertiti in Extended JSON', async () => {
    const host = hostFinto({ docs: [] });
    await esegui("db.c.find({ _id: ObjectId('665f1c2d3e4f5a6b7c8d9e0f'), n: NumberLong('90') }).toArray();", host);
    const c = host.chiamate.find((x) => x.op === 'find');
    assert.strictEqual(c.payload.filter, '{"_id":{"$oid":"665f1c2d3e4f5a6b7c8d9e0f"},"n":{"$numberLong":"90"}}');
  });

  await prova('DDL: createCollection, drop, createIndex, dropDatabase', async () => {
    const host = hostFinto();
    await esegui(`
      db.createCollection('nuova');
      db.vecchia.drop();
      db.c.createIndex({ nome: 1 }, { unique: true });
    `, host);
    assert.ok(host.chiamate.some((c) => c.op === 'createCollection' && c.nome === 'nuova'));
    assert.ok(host.chiamate.some((c) => c.op === 'dropCollection' && c.coll === 'vecchia'));
    const idx = host.chiamate.find((c) => c.op === 'createIndex');
    assert.deepStrictEqual(idx.payload.keys, { nome: 1 });
    assert.deepStrictEqual(idx.payload.options, { unique: true });
  });

  await prova('getSiblingDB cambia database senza toccare gli altri', async () => {
    const host = hostFinto({ docs: [] });
    await esegui("db.getSiblingDB('altro').c.find({}).toArray(); db.c.find({}).toArray();", host);
    const finds = host.chiamate.filter((c) => c.op === 'find');
    assert.strictEqual(finds[0].db, 'altro');
    assert.strictEqual(finds[1].db, 'testdb');
  });

  await prova('countDocuments e distinct', async () => {
    const host = hostFinto({ total: 42, aggregate: [{ _id: 'x' }, { _id: 'y' }] });
    const r = await esegui("print(db.c.countDocuments({ a: 1 })); print(db.c.distinct('citta').join('/'));", host);
    assert.deepStrictEqual(r.output, ['42', 'x/y']);
  });

  await prova('Senza database selezionato l\'errore è comprensibile', async () => {
    await deveFallire('db.c.find({}).toArray();', /Nessun database selezionato/, hostFinto(), { db: null });
  });

  /* === reduce: il valore iniziale conta (CDB-A14) ======================= */

  await prova('reduce() rispetta il valore iniziale', async () => {
    // Ignorarlo non produceva un errore ma un risultato SBAGLIATO in silenzio,
    // che è il difetto peggiore in un'aggregazione.
    const somma = await esegui('print([1,2,3].reduce(function(a,b){ return a+b; }, 10));');
    assert.deepStrictEqual(somma.output, ['16'], 'Il valore iniziale deve essere usato');

    const vuoto = await esegui('print([].reduce(function(a,b){ return a+b; }, 0));');
    assert.deepStrictEqual(vuoto.output, ['0'], 'Array vuoto con valore iniziale: torna il valore iniziale');

    // Accumulatore di tipo diverso dagli elementi: senza il valore iniziale
    // l'accumulatore partiva dall'OGGETTO e il risultato era NaN.
    const oggetti = await esegui('print([{n:2},{n:3}].reduce(function(a,x){ return a+x.n; }, 0));');
    assert.deepStrictEqual(oggetti.output, ['5'], 'L\'accumulatore deve partire dal valore iniziale');

    const senza = await esegui('print([1,2,3].reduce(function(a,b){ return a+b; }));');
    assert.deepStrictEqual(senza.output, ['6'], 'Senza valore iniziale la semantica resta quella standard');

    await deveFallire('[].reduce(function(a,b){ return a+b; });', /array vuoto/i);
  });

  /* === Regex: l'unico costrutto senza budget (CDB-A44) ================== */

  await prova('BUDGET: un quantificatore annidato è rifiutato prima di eseguire', async () => {
    // Una regex è una chiamata nativa e non interrompibile: mentre gira, nessun
    // budget del runner può intervenire, quindi `tempoMs` non la fermerebbe.
    // Verificato che lo script non venga eseguito, non che sia lento: se questo
    // controllo cade, il test stesso bloccherebbe il processo.
    await deveFallire('/(a+)+$/.test("aaaa!");', /quantificatore|esponenziale/i);
    await deveFallire('var r = /(x*)*/; r.test("x");', /quantificatore|esponenziale/i);
  });

  await prova('Le regex normali continuano a funzionare', async () => {
    const r = await esegui('print(/^ab+c$/.test("abbbc"));');
    assert.ok(String(r.output.join(' ')).includes('true'), 'Una regex innocua deve funzionare');
  });

  await prova('BUDGET: una regex costosa sfuggita all’euristica viene terminata nel worker', async () => {
    const testo = `${'a'.repeat(42)}!`;
    await deveFallire(
      `/^(a|aa)+$/.test("${testo}");`,
      /run-script-regex.*tempo massimo|tempo massimo.*run-script-regex/i,
      hostFinto(),
      { runId: 'run-script-regex', limiti: { regexTempoMs: 20 } }
    );
  });

  await prova('BUDGET: una regex non si applica a un testo smisurato', async () => {
    await deveFallire(
      'var s = ""; for (var i = 0; i < 6000; i++) s = s + "a"; /a+b/.test(s);',
      /limite|caratteri/i,
      hostFinto(),
      { limiti: { iterazioni: 100000, passi: 2000000 } }
    );
  });

  /* === Scritture: filtro obbligatorio (CDB-A45) ========================= */

  await prova('deleteMany/updateMany senza filtro non diventano "tutti i documenti"', async () => {
    // L'interprete non deve inventare un filtro: se `filter` manca nel payload,
    // la strategia lo deve pretendere (MongoDbStrategy.shellWrite). Qui si
    // verifica il presupposto — che il campo NON venga sintetizzato a {} —
    // perché è ciò che rende possibile il rifiuto a valle.
    const h = hostFinto();
    await esegui('db.utenti.deleteMany();', h);
    const w = h.chiamate.find((c) => c.op === 'write');
    assert.strictEqual(w.payload.filter, undefined, 'Un filtro assente non deve arrivare come {}');

    const { MongoDbStrategy } = (() => {
      try { return { MongoDbStrategy: require('../db/MongoDbStrategy') }; } catch { return {}; }
    })();
    if (MongoDbStrategy) {
      // Client finto: la collezione registra le chiamate, così se il filtro
      // mancante passasse si vedrebbe un deleteMany({}) invece di un errore.
      let arrivate = 0;
      const collFinta = {
        deleteMany: async () => { arrivate++; return { deletedCount: 0 }; },
        updateMany: async () => { arrivate++; return { matchedCount: 0, modifiedCount: 0 }; },
      };
      const s = Object.create(MongoDbStrategy.prototype);
      s.requireClient = () => ({ db: () => ({ collection: () => collFinta }) });

      await assert.rejects(
        () => s.shellWrite('db', 'c', { op: 'deleteMany' }),
        /richiede un filtro/,
        'deleteMany senza filtro deve essere rifiutato, non valere "tutti i documenti"'
      );
      await assert.rejects(
        () => s.shellWrite('db', 'c', { op: 'updateMany', update: '{"$set":{"a":1}}' }),
        /richiede un filtro/,
        'updateMany senza filtro deve essere rifiutato'
      );
      assert.strictEqual(arrivate, 0, 'Nessuna di queste chiamate deve raggiungere il driver');

      // Il filtro esplicito {} resta ammesso: è la dichiarazione di intenti.
      await s.shellWrite('db', 'c', { op: 'deleteMany', filter: '{}' });
      assert.strictEqual(arrivate, 1, 'deleteMany({}) esplicito deve passare');
    }
  });

  /* === Riconoscimento =================================================== */

  await prova('sembraScriptJs distingue script e comandi singoli', () => {
    assert.strictEqual(sembraScriptJs('const a = 1;'), true);
    assert.strictEqual(sembraScriptJs('for (const x of y) {}'), true);
    assert.strictEqual(sembraScriptJs('db.c.find({}).forEach((d) => print(d))'), true);
    assert.strictEqual(sembraScriptJs('db.utenti.find({ a: 1 })'), false);
    assert.strictEqual(sembraScriptJs('{ "a": 1 }'), false);
    assert.strictEqual(sembraScriptJs('SELECT * FROM t'), false);
  });

  await prova('Errori di sintassi indicano la riga', async () => {
    const err = await deveFallire('const a = 1;\nconst b = ;\n', /riga 2/);
    assert.strictEqual(err.scriptLine, 2);
  });

  if (falliti) {
    console.error(`\n${falliti} test falliti.`);
    process.exitCode = 1;
  } else {
    console.log('\nTutti i test dell\'interprete superati!');
  }
})();
