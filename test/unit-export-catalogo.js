'use strict';

// Il catalogo di export si prova senza database mettendo una funzione di query
// FINTA al posto del pool: le query che girano sono quelle vere, e cio' che si
// controlla e' come le righe del catalogo diventano oggetti e dipendenze. E' la
// stessa scelta di test/unit-sql-metadati.js, per la stessa ragione: qui non
// servono due dialetti finti scritti nel test, serve il dialetto vero.

const assert = require('assert');
const { catalogoMySql, catalogoPostgres, catalogoMongo, vistePerMySql } = require('../db/exportCatalogo');
const { creaPianoExport, MODALITA } = require('../db/exportPlan');

(async () => {
  /* --- MySQL -------------------------------------------------------------- */

  const sqlVisti = [];
  const qMy = async (sql, params) => {
    sqlVisti.push(sql.replace(/\s+/g, ' ').trim());
    if (/information_schema\.TABLES/.test(sql)) {
      assert.deepStrictEqual(params, ['negozio']);
      return [
        { name: 'clienti', rows_approx: 12 },
        // InnoDB non sa sempre stimare: NULL significa «non so», e non deve
        // diventare zero — una tabella dichiarata vuota puo' essere nascosta.
        { name: 'ordini', rows_approx: null },
      ];
    }
    if (/KEY_COLUMN_USAGE/.test(sql)) {
      return [
        { src: 'ordini', col: 'cliente_id', ref_schema: 'negozio', ref: 'clienti' },
        // Cross-database: il bersaglio non e' nel perimetro e non ci va messo.
        { src: 'ordini', col: 'listino_id', ref_schema: 'anagrafiche', ref: 'listino' },
      ];
    }
    throw new Error(`query non prevista: ${sql}`);
  };
  const my = await catalogoMySql(qMy, 'negozio');
  assert.strictEqual(my.oggetti.find((o) => o.nome === 'clienti').righeStimate, 12);
  assert.strictEqual(my.oggetti.find((o) => o.nome === 'ordini').righeStimate, null,
    'una stima assente resta assente, non diventa zero');
  const interna = my.dipendenze.find((d) => d.campo === 'cliente_id');
  assert.strictEqual(interna.esterna, false);
  assert.strictEqual(interna.a, 'tabella:clienti');
  const esterna = my.dipendenze.find((d) => d.campo === 'listino_id');
  assert.strictEqual(esterna.esterna, true, 'una FK cross-database e un prerequisito, non un oggetto');
  assert.strictEqual(esterna.db, 'anagrafiche');
  // Le tabelle si leggono da information_schema, non da SHOW TABLES: serve il
  // conteggio stimato insieme al nome.
  assert.ok(sqlVisti.some((s) => /TABLE_TYPE = 'BASE TABLE'/.test(s)), 'le view non sono tabelle');
  console.log('  OK   MySQL: stime, FK interne ed esterne distinte');

  // Le dipendenze di una view su un server che non le espone NON diventano
  // «nessuna dipendenza»: diventano non deducibili. L'alternativa sarebbe
  // leggere il testo della view e indovinare i nomi, che e' esattamente cio'
  // che questo modulo esiste per non fare.
  const vecchio = async () => { throw new Error('Unknown table VIEW_TABLE_USAGE'); };
  const ripiego = await vistePerMySql(vecchio, 'negozio', ['v_ordini']);
  assert.strictEqual(ripiego.dipendenze.length, 0);
  assert.strictEqual(ripiego.nonDeducibili.length, 1);
  assert.strictEqual(ripiego.nonDeducibili[0].da, 'vista:v_ordini');
  assert.match(ripiego.nonDeducibili[0].nota, /non leggibili/);

  const moderno = await vistePerMySql(
    async () => [{ view_name: 'v_ordini', ref_schema: 'negozio', ref: 'ordini' }], 'negozio', ['v_ordini'],
  );
  assert.deepStrictEqual(moderno.dipendenze[0], {
    da: 'vista:v_ordini', a: 'tabella:ordini', tipo: 'vista', esterna: false, db: null,
  });
  assert.strictEqual(moderno.nonDeducibili.length, 0);
  console.log('  OK   MySQL: una view illeggibile e dichiarata, non data per indipendente');

  /* --- PostgreSQL --------------------------------------------------------- */

  const qPg = async (sql, params) => {
    assert.deepStrictEqual(params, ['pubblico']);
    if (/pg_class c/.test(sql) && /relkind IN \('r', 'p'\)/.test(sql)) {
      // Il `CASE WHEN c.reltuples < 0` sta nella query vera: qui arriva gia'
      // tradotto, ed e' il contratto che si vuole fissare.
      assert.ok(/reltuples < 0 THEN NULL/.test(sql), 'reltuples negativo deve diventare NULL nella query');
      return { rows: [{ name: 'ordini', rows_approx: '500' }, { name: 'nuova', rows_approx: null }] };
    }
    if (/contype = 'f'/.test(sql)) {
      return { rows: [{ src: 'ordini', ref: 'clienti', ref_schema: 'pubblico', col: 'cliente_id' }] };
    }
    if (/pg_rewrite/.test(sql)) {
      return { rows: [{ view_name: 'v_ordini', ref: 'ordini', ref_schema: 'pubblico', ref_kind: 'r' }] };
    }
    if (/deptype = 'a'/.test(sql)) return { rows: [{ seq: 'ordini_id_seq', tabella: 'ordini' }] };
    throw new Error(`query non prevista: ${sql}`);
  };
  const pg = await catalogoPostgres(qPg, 'pubblico');
  assert.strictEqual(pg.oggetti.find((o) => o.nome === 'ordini').righeStimate, 500);
  assert.strictEqual(pg.oggetti.find((o) => o.nome === 'nuova').righeStimate, null);
  assert.ok(pg.dipendenze.some((d) => d.tipo === 'fk' && d.a === 'tabella:clienti'));
  assert.ok(pg.dipendenze.some((d) => d.tipo === 'vista' && d.da === 'vista:v_ordini' && d.a === 'tabella:ordini'),
    'la dipendenza della view viene da pg_depend, non dal testo della view');
  assert.ok(pg.possedute.has('ordini_id_seq'),
    'una sequenza posseduta la ricrea la CREATE TABLE: non e un oggetto a se');
  console.log('  OK   PostgreSQL: FK, dipendenze di view da pg_depend, sequenze possedute');

  /* --- MongoDB ------------------------------------------------------------ */

  const mongo = catalogoMongo([
    { name: 'clienti', type: 'collection' },
    { name: 'ordini', type: 'collection' },
    { name: 'v_semplice', type: 'view', options: { viewOn: 'ordini', pipeline: [{ $match: {} }] } },
    { name: 'v_unita', type: 'view', options: { viewOn: 'ordini', pipeline: [{ $lookup: { from: 'clienti' } }] } },
  ], new Map([['clienti', 3], ['ordini', 7]]));
  assert.strictEqual(mongo.oggetti.filter((o) => o.tipo === 'collection').length, 2);
  assert.strictEqual(mongo.oggetti.find((o) => o.nome === 'ordini').righeStimate, 7);
  assert.ok(mongo.dipendenze.some((d) => d.da === 'vista:v_semplice' && d.a === 'collection:ordini'));
  // `viewOn` e' dichiarato dal catalogo; le collection lette da un `$lookup`
  // dentro la pipeline no. La differenza va detta, non appianata.
  const lookup = mongo.dipendenze.find((d) => d.tipo === 'lookup');
  assert.strictEqual(lookup.da, 'vista:v_unita');
  assert.strictEqual(lookup.a, null);
  assert.ok(!mongo.dipendenze.some((d) => d.tipo === 'fk'), 'MongoDB non dichiara chiavi esterne');
  console.log('  OK   MongoDB: viewOn dichiarato, $lookup dichiarato non deducibile');

  /* --- I due strati si incastrano ----------------------------------------- */

  // Il catalogo prodotto qui deve essere accettato dal piano cosi' com'e': se
  // le due forme divergono il difetto si scopre in produzione, alla prima
  // anteprima, e non qui.
  const piano = creaPianoExport({
    catalogo: {
      dbType: 'mysql', db: 'negozio',
      // La view arriva da `readSchemaObjects`, come fa `leggiCatalogoExport`:
      // senza, il piano rifiuta la dipendenza — ed e' giusto che la rifiuti,
      // perche' un arco che parte da un oggetto sconosciuto e' un catalogo
      // incoerente, non una riga da saltare.
      oggetti: [...my.oggetti, { tipo: 'vista', nome: 'v_ordini' }],
      dipendenze: [...my.dipendenze, ...moderno.dipendenze],
    },
    connection: 'locale', modalita: MODALITA.STRUTTURA_E_DATI,
  });
  assert.ok(piano.fingerprint);
  assert.strictEqual(piano.prerequisitiEsterni.length, 1, 'la FK cross-database resta un prerequisito');
  console.log('  OK   il catalogo reale e accettato dal piano senza adattamenti');

  console.log('  OK   Catalogo di export: oggetti e dipendenze reali dei tre motori passed');
})().catch((err) => {
  console.error('  FAIL Catalogo di export:', err.stack || err);
  process.exitCode = 1;
});
