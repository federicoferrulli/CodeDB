'use strict';

/* ---------------------------------------------------------------------------
 * Il divieto degli operatori che eseguono JavaScript sul SERVER MongoDB.
 *
 * `$where`, `$function` e `$accumulator` trasformano una query in esecuzione
 * di codice arbitrario sul server del database: nessuna capability li
 * autorizza, e la barriera non è un permesso ma un'invariante — vale anche per
 * root, che infatti dal Proxy ci passa lo stesso.
 *
 * Il difetto che questo test presidia non è «il divieto non funziona», ma
 * «i divieti sono tre». Ne esistevano infatti tre versioni: quella autorevole
 * in `auth/capabilities.js`, una copia in server.js con un proprio elenco di
 * operatori e un proprio messaggio, e una terza sotto forma di espressione
 * regolare applicata al TESTO di un messaggio d'errore. Tre versioni della
 * stessa regola sono tre occasioni di divergere, e la terza si sarebbe rotta
 * al primo cambio di frase.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { assertNoMongoServerJs, FORBIDDEN_MONGO_SERVER_JS } = require('../auth/capabilities');
const { guardStrategy } = require('../auth/guardStrategy');
const { ROOT_PRINCIPAL } = require('../auth/principal');

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

module.exports = (async () => {
  console.log('  --- Divieto del JavaScript lato server MongoDB ---');

  /* --- Percorso 1: la definizione autorevole ---------------------------- */

  await prova('i tre operatori sono vietati, ovunque siano annidati', () => {
    for (const op of FORBIDDEN_MONGO_SERVER_JS) {
      assert.throws(
        () => assertNoMongoServerJs(JSON.stringify({ [op]: 'return true' })),
        new RegExp(`Operatore \\${op} non consentito`),
        `${op} al primo livello`
      );
      assert.throws(
        () => assertNoMongoServerJs(JSON.stringify([{ $match: { $and: [{ [op]: 'x' }] } }])),
        /non consentito/,
        `${op} annidato dentro una pipeline`
      );
    }
  });

  await prova('una query legittima passa', () => {
    const parsed = assertNoMongoServerJs('{"nome":"Anna"}');
    assert.deepStrictEqual(parsed, { nome: 'Anna' });
  });

  await prova('testo illeggibile: errore per chi non ha un secondo controllo', () => {
    assert.throws(() => assertNoMongoServerJs('{non json', 'Filtro MongoDB'), /Filtro MongoDB non valido/);
  });

  await prova('testo illeggibile: silenzio per chi lo dichiara', () => {
    // È il caso di server.js, dove lo stesso testo verrà riletto dal traduttore
    // o dalla strategia e rifiutato con il messaggio giusto. Anticipare qui un
    // errore di sintassi sarebbe un peggioramento.
    assert.strictEqual(
      assertNoMongoServerJs('db.coll.find()', 'Comando', { testoIllegibile: 'ignora' }),
      null
    );
  });

  /* --- Percorso 2: il Proxy autorizzante -------------------------------- */

  await prova('il Proxy rifiuta $where in un filtro, anche a root', async () => {
    let arrivato = false;
    const strategia = guardStrategy(
      { type: 'mongodb', async collectionFind() { arrivato = true; return { docs: [] }; } },
      { principal: ROOT_PRINCIPAL, connName: 'prova' }
    );
    await assert.rejects(
      () => strategia.collectionFind('app', 'utenti', { filter: '{"$where":"this.a==1"}' }),
      /non consentito/
    );
    assert.strictEqual(arrivato, false, 'la query non deve nemmeno raggiungere la strategia');
  });

  await prova('il Proxy rifiuta $function in una pipeline', async () => {
    const strategia = guardStrategy(
      { type: 'mongodb', async collectionAggregate() { return { docs: [] }; } },
      { principal: ROOT_PRINCIPAL, connName: 'prova' }
    );
    await assert.rejects(
      () => strategia.collectionAggregate('app', 'utenti', {
        pipeline: '[{"$addFields":{"x":{"$function":{"body":"function(){}","args":[],"lang":"js"}}}}]',
      }),
      /non consentito/
    );
  });

  await prova('il Proxy lascia passare una pipeline legittima', async () => {
    let vista = null;
    const strategia = guardStrategy(
      { type: 'mongodb', async collectionAggregate(db, coll, p) { vista = p.pipeline; return { docs: [] }; } },
      { principal: ROOT_PRINCIPAL, connName: 'prova' }
    );
    await strategia.collectionAggregate('app', 'utenti', { pipeline: '[{"$match":{"a":1}}]' });
    assert.strictEqual(vista, '[{"$match":{"a":1}}]');
  });

  await prova('sintassi MQL shell: accetta filtri validi, vieta $where non quotato e rifiuta non-oggetti', async () => {
    const DbFactory = require('../db/DbFactory');
    const raw = DbFactory.getStrategy('mongodb');
    let ultimoFiltro = null;
    raw.client = {
      db: () => ({
        collection: () => ({
          dbName: 'app',
          collectionName: 'utenti',
          estimatedDocumentCount: async () => 1,
          aggregate: () => ({ toArray: async () => [] }),
          find(f) {
            ultimoFiltro = f;
            const c = {
              sort: () => c, skip: () => c, limit: () => c, close: async () => {},
              async *[Symbol.asyncIterator]() { yield { _id: '1', user: 'Mario', age: 35 }; },
            };
            return c;
          },
        }),
      }),
    };
    const strategia = guardStrategy(raw, { principal: ROOT_PRINCIPAL, connName: 'prova' });

    await strategia.collectionFind('app', 'utenti', { filter: '{ age: { $gt: 30 } }', deferCount: true });
    assert.strictEqual(Number(ultimoFiltro.age.$gt), 30);

    await strategia.collectionFind('app', 'utenti', { filter: '{ big: NumberLong("9007199254740993") }', deferCount: true });
    assert.strictEqual(String(ultimoFiltro.big), '9007199254740993');

    await strategia.collectionFind('app', 'utenti', { filter: "{ 'user': 'Mario' }", deferCount: true });
    assert.deepStrictEqual(ultimoFiltro, { user: 'Mario' });

    await strategia.collectionFind('app', 'utenti', { filter: '{ _id: ObjectId("507f1f77bcf86cd799439011") }', deferCount: true });
    assert.strictEqual(ultimoFiltro._id.toHexString(), '507f1f77bcf86cd799439011');

    await strategia.collectionFind('app', 'utenti', { filter: '{ createdAt: ISODate("2026-01-01T00:00:00Z") }', deferCount: true });
    assert.ok(ultimoFiltro.createdAt instanceof Date);

    await strategia.collectionFind('app', 'utenti', { filter: '{ user: /mario/i }', deferCount: true });
    assert.strictEqual(ultimoFiltro.user.pattern, 'mario');
    assert.strictEqual(ultimoFiltro.user.options, 'i');

    // Divieto JS lato server anche con chiavi non quotate o escape in apici singoli
    await assert.rejects(
      () => strategia.collectionFind('app', 'utenti', { filter: '{ $where: "this.a == 1" }' }),
      /non consentito/
    );
    await assert.rejects(
      () => strategia.collectionFind('app', 'utenti', { filter: "{ '\\u0024where': 'this.a == 1' }" }),
      /non consentito/
    );

    // Scalari e array JSON non devono essere ignorati silenziosamente come {}
    for (const nonDocumento of ['"mario"', 'true', 'null', '123', '[{ "age": 30 }]']) {
      ultimoFiltro = null;
      await assert.rejects(
        () => strategia.collectionFind('app', 'utenti', { filter: nonDocumento, deferCount: true }),
        /Filtro MongoDB non valido/,
        `deve rifiutare ${nonDocumento}`
      );
      assert.strictEqual(ultimoFiltro, null, `${nonDocumento} non deve raggiungere il driver`);
    }
  });

  /* --- Che non ricompaia una quarta versione ---------------------------- */

  await prova('la regola è definita in un posto solo', () => {
    // Controllo statico: nessun altro file deve nominare i tre operatori in un
    // elenco proprio, e nessuno deve più riconoscere il divieto guardando il
    // TESTO di un messaggio d'errore.
    const radice = path.join(__dirname, '..');
    const file = [
      'server.js',
      'auth/guardStrategy.js',
      'db/MongoDbStrategy.js',
      'db/MongoScript.js',
      'db/MongoScriptRunner.js',
      ...fs.readdirSync(path.join(radice, 'db')).filter((f) => f.startsWith('mongo-') && f.endsWith('.js')).map((f) => 'db/' + f),
      ...fs.readdirSync(path.join(radice, 'mcp')).filter((f) => f.endsWith('.js')).map((f) => 'mcp/' + f),
      ...fs.readdirSync(path.join(radice, 'server')).filter((f) => f.endsWith('.js')).map((f) => 'server/' + f),
    ];
    const colpevoli = [];
    for (const f of file) {
      const testo = fs.readFileSync(path.join(radice, f), 'utf8');
      // Un elenco proprio si riconosce dai tre nomi VICINI fra loro: è così
      // che si scrive un Set, un array o un'alternativa in una regex. I
      // commenti si tolgono prima, perché nominare `$where` spiegando il
      // divieto è legittimo — anzi, è quello che fanno i commenti rimasti.
      const codice = testo
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      if (/\$where[\s\S]{0,60}\$function/.test(codice)) {
        colpevoli.push(`${f}: elenco proprio degli operatori vietati`);
      }
    }
    assert.deepStrictEqual(colpevoli, [], colpevoli.join('; '));
  });

  if (falliti) throw new Error(`${falliti} test del divieto falliti`);
  console.log('  Divieto del JavaScript lato server: una definizione sola.');
})();
