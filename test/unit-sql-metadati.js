'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari dei metadati comuni ai due motori SQL (db/sqlMetadati.js).
 *
 * Nessun database: al posto del pool si mette un oggetto che registra la query
 * ricevuta e restituisce righe finte. È il modo di provare i DUE dialetti
 * davvero dichiarati dagli adattatori — non due dialetti finti scritti qui —
 * cioè proprio ciò che prima non era verificabile senza un server acceso.
 *
 * Cosa vale la pena verificare:
 *   1. la pagina a chiave si compone allo stesso modo sui due motori e cambia
 *      solo il segnaposto: `?` su MySQL, `$n` numerato su PostgreSQL, con il
 *      numero che segue la posizione reale del parametro;
 *   2. le query al catalogo ricevono i parametri nell'ORDINE giusto. È il
 *      difetto che questa riconciliazione chiude: `estimatedRowCount` prendeva
 *      `(db, coll)` su un motore e `(coll, db)` sull'altro, e nessun test
 *      poteva accorgersene perché il metodo non era chiamato da fuori;
 *   3. le informazioni di colonna classificano i tipi secondo le classi
 *      DICHIARATE dal dialetto (geometrie PostGIS contro tipi nativi) e
 *      rispondono dalla cache alla seconda chiamata;
 *   4. l'elenco dei campi produce la stessa forma sui due motori pur leggendo
 *      colonne di catalogo diverse (EXTRA/COLUMN_KEY contro is_identity e
 *      chiave primaria a parte);
 *   5. gli indici unici escludono la primaria e i non unici, tengono l'ordine
 *      delle colonne e scartano gli indici su espressione;
 *   6. il conteggio usa la stima solo quando è > 0, e altrimenti conta davvero;
 *   7. i due adattatori non contengono più una propria copia di questi metodi.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { componiKeyset, raggruppaIndici } = require('../db/sqlMetadati');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');

console.log('  --- Metadati comuni SQL (db/sqlMetadati.js) ---');

/* Pool finti: registrano ciò che ricevono e rispondono con righe decise dal
 * test. `risposta` riceve il testo della query e i parametri. */
function fintoMysql(risposta) {
  const s = new MySqlStrategy();
  const viste = [];
  s.pool = {
    query: async (sql, params) => {
      const testo = typeof sql === 'string' ? sql : sql.sql;
      viste.push({ sql: testo, params });
      const r = risposta(testo, params);
      if (r instanceof Error) throw r;
      return [r || [], []];
    },
  };
  return { s, viste };
}

function fintoPg(risposta) {
  const s = new PostgreSqlStrategy();
  const viste = [];
  s.pool = {
    query: async (sql, params) => {
      viste.push({ sql, params });
      const r = risposta(sql, params);
      if (r instanceof Error) throw r;
      return { rows: r || [] };
    },
  };
  return { s, viste };
}

const attesa = (p) => p.then((v) => ({ v }), (e) => ({ e }));

module.exports = (async () => {

/* 1. Paginazione a chiave ---------------------------------------------------- */

const my = new MySqlStrategy();
const pg = new PostgreSqlStrategy();
const payload = { keyset: { after: '{"id":7}' } };

const ksMy = my.buildKeyset(payload, '`d`.`t`', ' WHERE `a` = 1', 50, ['id']);
const ksPg = pg.buildKeyset(payload, '"d"."t"', ' WHERE "a" = 1', 50, ['id']);
assert.strictEqual(ksMy.sql, 'SELECT * FROM `d`.`t` WHERE (`a` = 1) AND `id` > ? ORDER BY `id` ASC LIMIT ?');
assert.strictEqual(ksPg.sql, 'SELECT * FROM "d"."t" WHERE ("a" = 1) AND "id" > $1 ORDER BY "id" ASC LIMIT $2');
assert.deepStrictEqual(ksMy.params, [7, 50]);
assert.deepStrictEqual(ksPg.params, [7, 50]);
assert.strictEqual(ksMy.reverse, false);
console.log('  OK   keyset: stessa forma sui due motori, cambia solo il segnaposto');

// Regressione: una ricerca parametrizzata sulla prima pagina non può perdere
// i propri valori quando la griglia sceglie la paginazione keyset. Prima il
// WHERE restava nella SQL ma `params` conteneva soltanto il LIMIT: MySQL
// falliva e la UI lasciava visibili le vecchie righe, dando l'impressione che
// una ricerca senza corrispondenze trovasse tutto; su PostgreSQL i $n si
// sovrapponevano anche fra filtro, cursore e limite.
const ksRicercaMy = my.buildKeyset(
  { keyset: { first: true }, sort: '' }, '`d`.`t`', ' WHERE LOWER(`label`) LIKE LOWER(?)',
  50, ['id'], '*', ['%nessuna-corrispondenza%']
);
const ksRicercaPg = pg.buildKeyset(
  { keyset: { after: '{"id":7}' }, sort: '' }, '"d"."t"', ' WHERE LOWER("label") LIKE LOWER($1)',
  50, ['id'], '*', ['%nessuna-corrispondenza%']
);
assert.deepStrictEqual(ksRicercaMy.params, ['%nessuna-corrispondenza%', 50]);
assert.strictEqual(ksRicercaPg.sql,
  'SELECT * FROM "d"."t" WHERE (LOWER("label") LIKE LOWER($1)) AND "id" > $2 ORDER BY "id" ASC LIMIT $3');
assert.deepStrictEqual(ksRicercaPg.params, ['%nessuna-corrispondenza%', 7, 50]);
console.log('  OK   keyset: conserva parametri e numerazione della ricerca globale');

// Il numero del segnaposto PostgreSQL segue la POSIZIONE del parametro: senza
// filtro utente il cursore resta $1 e il limite diventa $2 lo stesso.
const ksPgNoWhere = pg.buildKeyset(payload, '"d"."t"', '', 25, ['id']);
assert.strictEqual(ksPgNoWhere.sql, 'SELECT * FROM "d"."t" WHERE "id" > $1 ORDER BY "id" ASC LIMIT $2');
assert.deepStrictEqual(ksPgNoWhere.params, [7, 25]);

// Pagina precedente: ordine invertito e bandiera di riordino per il chiamante.
const indietro = pg.buildKeyset({ keyset: { before: '{"id":7}' } }, '"t"', '', 10, ['id']);
assert.ok(/ORDER BY "id" DESC/.test(indietro.sql));
assert.strictEqual(indietro.reverse, true);

// Non applicabile: nessun keyset, sort personalizzato, chiave composita.
assert.strictEqual(my.buildKeyset({}, '`t`', '', 10, ['id']), null);
assert.strictEqual(my.buildKeyset({ keyset: { first: true }, sort: 'nome ASC' }, '`t`', '', 10, ['id']), null);
assert.strictEqual(my.buildKeyset({ keyset: { first: true } }, '`t`', '', 10, ['a', 'b']), null);
// Prima pagina: nessuna condizione sul cursore, ma il limite è comunque $1.
const prima = pg.buildKeyset({ keyset: { first: true } }, '"t"', '', 10, ['id']);
assert.strictEqual(prima.sql, 'SELECT * FROM "t" ORDER BY "id" ASC LIMIT $1');
console.log('  OK   keyset: casi non applicabili e prima/ultima pagina');

// Il cursore è EJSON: un $numberLong non deve arrivare al driver come oggetto.
assert.strictEqual(my.keysetValue('{"id":{"$numberLong":"42"}}', 'id'), 42);
assert.strictEqual(my.keysetValue('7', 'id'), 7);
assert.deepStrictEqual(pg.keysetValue('{"id":{"$date":"2020-01-02T00:00:00Z"}}', 'id'), new Date('2020-01-02T00:00:00Z'));
console.log('  OK   keyset: il valore del cursore passa da EJSON a parametro SQL');

// Il segnaposto è un dato del dialetto, non un ramo: con un dialetto qualsiasi
// la stessa funzione produce la stessa struttura.
const finto = componiKeyset(
  { qid: (n) => `[${n}]`, segnaposto: (n) => `:${n}` },
  payload, 'T', '', 5, ['id']
);
assert.strictEqual(finto.sql, 'SELECT * FROM T WHERE [id] > :1 ORDER BY [id] ASC LIMIT :2');

/* 2. Chiave primaria: parametri nell'ordine giusto --------------------------- */

{
  const { s, viste } = fintoMysql(() => [{ name: 'id' }, { name: 'riga' }]);
  assert.deepStrictEqual(await s.primaryKey('negozio', 'ordini'), ['id', 'riga']);
  assert.deepStrictEqual(viste[0].params, ['negozio', 'ordini']);
  assert.ok(/KEY_COLUMN_USAGE/.test(viste[0].sql));
}
{
  const { s, viste } = fintoPg(() => [{ name: 'id' }]);
  assert.deepStrictEqual(await s.primaryKey('vendite', 'ordini'), ['id']);
  // Su PostgreSQL la tabella è $1 e lo schema è $2: invertirli darebbe la
  // chiave primaria di un'altra tabella, cioè l'_id virtuale sbagliato.
  assert.deepStrictEqual(viste[0].params, ['ordini', 'vendite']);
}
console.log('  OK   chiave primaria: query e ordine dei parametri per motore');

/* 3. Informazioni sulle colonne --------------------------------------------- */

{
  const { s, viste } = fintoMysql(() => [
    { name: 'id', type: 'int', srid: null, extra: 'auto_increment' },
    { name: 'area', type: 'polygon', srid: 4326, extra: '' },
    { name: 'nascosta', type: 'int', srid: null, extra: 'INVISIBLE' },
  ]);
  const info = await s.tableColumnsInfo('d', 't');
  assert.deepStrictEqual(info.columns.map((c) => c.name), ['id', 'area']); // INVISIBLE fuori
  assert.deepStrictEqual([...info.geo.keys()], ['area']);
  assert.strictEqual(info.geo.get('area').srid, 4326);
  assert.strictEqual(info.geoNativo, undefined); // classe non dichiarata su MySQL
  // Seconda chiamata: risponde la cache, il catalogo non viene riletto.
  await s.tableColumnsInfo('d', 't');
  assert.strictEqual(viste.length, 1);
  console.log('  OK   colonne MySQL: INVISIBLE escluse, geometrie riconosciute, cache');
}
{
  // MySQL 5.7 non ha SRS_ID: la prima query fallisce e si ripiega senza.
  let prima = true;
  const { s, viste } = fintoMysql((sql) => {
    if (/SRS_ID/.test(sql) && prima) { prima = false; return new Error('Unknown column SRS_ID'); }
    return [{ name: 'id', type: 'int', srid: null, extra: '' }];
  });
  const info = await s.tableColumnsInfo('d', 't');
  assert.deepStrictEqual(info.columns.map((c) => c.name), ['id']);
  assert.strictEqual(viste.length, 2);
  console.log('  OK   colonne MySQL: ripiego senza SRS_ID (MySQL 5.7)');
}
{
  const { s, viste } = fintoPg((sql) => {
    if (/information_schema.columns/.test(sql)) {
      return [
        { name: 'id', type: 'int4' },
        { name: 'area', type: 'geometry' },
        { name: 'punto', type: 'point' },
      ];
    }
    return [{ name: 'area', srid: 3003, kind: 'geometry' }];
  });
  const info = await s.tableColumnsInfo('vendite', 't');
  assert.deepStrictEqual([...info.geo.keys()], ['area']);      // PostGIS
  assert.deepStrictEqual([...info.geoNativo.keys()], ['punto']); // tipo nativo
  assert.strictEqual(info.geo.get('area').srid, 3003);
  assert.strictEqual(info.geo.get('area').kind, 'geometry');
  assert.deepStrictEqual(viste[0].params, ['vendite', 't']);
  console.log('  OK   colonne PostgreSQL: PostGIS e tipi nativi in classi diverse, SRID');
}
{
  // Viste PostGIS assenti: la lettura non deve fallire, si resta senza SRID.
  const { s } = fintoPg((sql) => (/geometry_columns/.test(sql)
    ? new Error('relation "geometry_columns" does not exist')
    : [{ name: 'area', type: 'geometry' }]));
  const info = await s.tableColumnsInfo('public', 't');
  assert.strictEqual(info.geo.get('area').srid, null);
  console.log('  OK   colonne PostgreSQL: senza PostGIS la lettura prosegue');
}

/* 4. Elenco dei campi -------------------------------------------------------- */

{
  const { s, viste } = fintoMysql(() => [
    { name: 'id', ctype: 'int unsigned', nullable: 'NO', cdefault: null, extra: 'auto_increment', ckey: 'PRI' },
    { name: 'tot', ctype: 'decimal(10,2)', nullable: 'YES', cdefault: '0.00', extra: 'STORED GENERATED', ckey: '' },
  ]);
  const campi = await s.tableFields('d', 't');
  assert.deepStrictEqual(campi[0], {
    name: 'id', types: ['int unsigned'], presence: 100, nullable: false,
    default: null, autoIncrement: true, generated: false, key: 'PRI',
  });
  assert.deepStrictEqual(campi[1], {
    name: 'tot', types: ['decimal(10,2)'], presence: 0, nullable: true,
    default: '0.00', autoIncrement: false, generated: true, key: '',
  });
  // Su MySQL COLUMN_KEY basta: nessuna seconda lettura per la chiave primaria.
  assert.strictEqual(viste.length, 1);
  console.log('  OK   campi MySQL: EXTRA e COLUMN_KEY letti come dichiara il dialetto');
}
{
  const { s, viste } = fintoPg((sql) => {
    if (/table_constraints/.test(sql)) return [{ name: 'id' }];
    return [
      { name: 'id', ctype: 'integer', nullable: 'NO', cdefault: "nextval('t_id_seq')", identity: 'NO', generated: 'NEVER' },
      { name: 'cod', ctype: 'character varying(80)', nullable: 'YES', cdefault: null, identity: 'NO', generated: 'ALWAYS' },
      { name: 'n', ctype: 'bigint', nullable: 'NO', cdefault: null, identity: 'YES', generated: 'NEVER' },
    ];
  });
  const campi = await s.tableFields('vendite', 't');
  assert.deepStrictEqual(campi.map((c) => [c.name, c.types[0], c.autoIncrement, c.generated, c.key]), [
    ['id', 'integer', true, false, 'PRI'],   // serial
    ['cod', 'character varying(80)', false, true, ''],
    ['n', 'bigint', true, false, ''],        // identity
  ]);
  // Qui la chiave primaria è una lettura in più, dichiarata dal dialetto.
  assert.strictEqual(viste.length, 2);
  console.log('  OK   campi PostgreSQL: serial e identity, chiave primaria a parte');
}

/* 5. Indici unici ------------------------------------------------------------ */

assert.deepStrictEqual(
  raggruppaIndici(
    [
      { n: 'i', c: 'b', o: 2, u: true, p: false },
      { n: 'i', c: 'a', o: 1, u: true, p: false },
      { n: 'e', c: null, o: 1, u: true, p: false },
    ],
    { nome: (r) => r.n, colonna: (r) => r.c, ordine: (r) => r.o, unico: (r) => r.u, primario: (r) => r.p }
  ),
  [
    { name: 'i', columns: ['a', 'b'], unique: true, primary: false }, // ordine dell'indice
    { name: 'e', columns: [], unique: true, primary: false },         // su espressione
  ]
);
console.log('  OK   raggruppamento indici: ordine delle colonne e buchi tolti');

{
  const { s } = fintoMysql(() => [
    { Key_name: 'PRIMARY', Column_name: 'id', Seq_in_index: 1, Non_unique: 0 },
    { Key_name: 'u_email', Column_name: 'email', Seq_in_index: 1, Non_unique: 0 },
    { Key_name: 'u_comp', Column_name: 'b', Seq_in_index: 2, Non_unique: 0 },
    { Key_name: 'u_comp', Column_name: 'a', Seq_in_index: 1, Non_unique: 0 },
    { Key_name: 'i_nome', Column_name: 'nome', Seq_in_index: 1, Non_unique: 1 },
  ]);
  assert.deepStrictEqual(await s.uniqueIndexes('d', 't'), [['email'], ['a', 'b']]);
}
{
  // Le view non hanno indici: SHOW INDEX fallisce e l'assenza non è un errore.
  const { s } = fintoMysql(() => new Error("'d.v' is not BASE TABLE"));
  assert.deepStrictEqual(await s.uniqueIndexes('d', 'v'), []);
}
{
  const { s } = fintoPg(() => [
    { name: 'pk', unico: true, primaria: true, colonna: 'id', ord: 1 },
    { name: 'u_email', unico: true, primaria: false, colonna: 'email', ord: 1 },
    { name: 'i_nome', unico: false, primaria: false, colonna: 'nome', ord: 1 },
    { name: 'u_expr', unico: true, primaria: false, colonna: null, ord: 1 },
  ]);
  assert.deepStrictEqual(await s.uniqueIndexes('vendite', 't'), [['email'], []]);
  // indexList conserva la forma attesa dalla vista Dettagli.
  const { s: s2 } = fintoPg(() => [{ name: 'u_email', unico: true, primaria: false, colonna: 'email', ord: 1 }]);
  assert.deepStrictEqual(await s2.indexList('vendite', 't'), [
    { name: 'u_email', key: { email: 1 }, unique: true, primary: false },
  ]);
}
console.log('  OK   indici unici: primaria e non unici esclusi sui due motori');

/* 6. Stima e conteggio ------------------------------------------------------- */

{
  const { s, viste } = fintoMysql(() => [{ n: 1234 }]);
  assert.strictEqual(await s.estimatedRowCount('negozio', 'ordini'), 1234);
  assert.deepStrictEqual(viste[0].params, ['negozio', 'ordini', 'BASE TABLE']);
}
{
  const { s } = fintoMysql(() => [{ n: null }]); // view: TABLE_ROWS è NULL
  assert.strictEqual(await s.estimatedRowCount('d', 'v'), null);
}
{
  const { s } = fintoMysql(() => new Error('permesso negato su information_schema'));
  assert.strictEqual(await s.estimatedRowCount('d', 't'), null);
}
{
  const { s, viste } = fintoPg(() => [{ n: '900' }]);
  // Stessa firma dei due motori: (db, coll). Prima PostgreSQL prendeva
  // (coll, db), e la stima veniva da tutt'altra tabella.
  assert.strictEqual(await s.estimatedRowCount('vendite', 'ordini'), 900);
  assert.deepStrictEqual(viste[0].params, ['ordini', 'vendite']);
}
{
  const { s } = fintoPg(() => [{ n: '-1' }]); // mai analizzata (PG >= 14)
  assert.strictEqual(await s.estimatedRowCount('vendite', 'ordini'), null);
}
console.log('  OK   stima righe: stessa firma, stesse regole, query per motore');

for (const [nome, fabbrica] of [['MySQL', fintoMysql], ['PostgreSQL', fintoPg]]) {
  {
    // Senza filtro e con stima attendibile: nessun COUNT(*).
    const { s } = fabbrica(() => [{ n: 5000 }]);
    let contato = false;
    s.countWithTimeout = async () => { contato = true; return { total: 0, timedOut: false }; };
    assert.deepStrictEqual(await s.collectionCount('d', 't', {}), { total: 5000, timedOut: false, approx: true });
    assert.strictEqual(contato, false, `${nome}: la stima attendibile evita il COUNT(*)`);
  }
  {
    // Stima a zero (tabella vuota o mai analizzata): si conta davvero.
    const { s } = fabbrica(() => [{ n: 0 }]);
    let visto = null;
    s.countWithTimeout = async (table, whereSql) => { visto = { table, whereSql }; return { total: 3, timedOut: false }; };
    assert.deepStrictEqual(await s.collectionCount('d', 't', {}), { total: 3, timedOut: false });
    assert.strictEqual(visto.whereSql, '');
  }
  {
    // Con filtro la stima non c'entra: conteggio esatto sul filtro dell'utente.
    const { s, viste } = fabbrica(() => [{ n: 5000 }]);
    let visto = null;
    s.countWithTimeout = async (table, whereSql) => { visto = { table, whereSql }; return { total: 2, timedOut: false }; };
    await s.collectionCount('d', 't', { filter: 'a = 1' });
    assert.strictEqual(visto.whereSql, ' WHERE a = 1');
    assert.strictEqual(viste.length, 0, `${nome}: con filtro non si chiede nessuna stima`);
  }
}
console.log('  OK   conteggio: la stima vale solo se > 0 e solo senza filtro');

/* 7. Una implementazione sola ------------------------------------------------ */

// Il difetto da evitare (due implementazioni che divergono) non è osservabile
// finché non è già successo: serve quindi un controllo sul TESTO degli
// adattatori, la stessa scelta di test/unit-sql-tabellare.js.
for (const file of ['MySqlStrategy.js', 'PostgreSqlStrategy.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8');
  assert.ok(
    /require\('\.\/sqlMetadati'\)/.test(src),
    `${file} deve prendere i metadati comuni dal modulo`
  );
  for (const metodo of [
    'primaryKey', 'tableColumnsInfo', 'tableFields', 'uniqueIndexes', 'elencoIndici',
    'estimatedRowCount', 'buildKeyset', 'keysetValue', 'collectionCount',
  ]) {
    assert.ok(
      !new RegExp(`\\n\\s+(async\\s+)?${metodo}\\s*\\(`).test(src),
      `${file} dichiara ancora ${metodo}: quel metodo vive in db/sqlMetadati.js`
    );
  }
}
console.log('  OK   gli adattatori non ridichiarano i metodi riconciliati');

// L'interfaccia si è accorciata ma nulla è sparito: i metodi restano
// raggiungibili sulle istanze, che è ciò che i chiamanti vedono.
for (const S of [MySqlStrategy, PostgreSqlStrategy]) {
  const s = new S();
  const installati = ['primaryKey', 'tableColumnsInfo', 'tableFields', 'uniqueIndexes',
    'elencoIndici', 'estimatedRowCount', 'buildKeyset', 'keysetValue', 'collectionCount'];
  for (const metodo of installati) {
    assert.strictEqual(typeof s[metodo], 'function', `${S.name}.${metodo} deve restare invocabile`);
  }
  // ...e sono invisibili all'enumerazione, come i metodi di una classe: un
  // `Object.assign` sul prototipo li avrebbe resi enumerabili, facendo
  // comparire nove nomi in ogni `for...in` su una strategia.
  const enumerati = [];
  for (const k in s) enumerati.push(k);
  for (const metodo of installati) {
    assert.ok(!enumerati.includes(metodo), `${S.name}: ${metodo} non deve comparire in un for...in`);
  }
  // Senza connessione l'errore resta quello di sempre, non un TypeError.
  const esito = await attesa(s.primaryKey('d', 't'));
  assert.ok(esito.e && /Nessuna connessione attiva/.test(esito.e.message));
}
console.log('  OK   i metodi restano invocabili sulle strategie');

})();
