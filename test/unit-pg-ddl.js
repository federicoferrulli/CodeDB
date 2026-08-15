'use strict';

/* ---------------------------------------------------------------------------
 * Lettura dello schema PostgreSQL condivisa fra strategia e motore di backup
 * (CDB-A87).
 *
 * Questo modulo nasce da una duplicazione che ha fatto danni: la stessa logica
 * era scritta due volte, in `PostgreSqlStrategy.tableDdl` e in `pgTableDdl` del
 * motore di backup. Correggendo la prima (CDB-A83) le due sono divergute, e per
 * un'intera revisione il backup ha continuato a produrre DDL rotte mentre
 * l'export/import era già a posto — senza che nulla lo segnalasse.
 *
 * Le prove guardano ciò che non si nota leggendo il codice:
 *
 *   1. i DEFAULT sono ESPRESSIONI e vanno riprodotte verbatim. La vecchia
 *      `pgDefaultSql` del motore le quotava come letterali, trasformando
 *      `nextval('s'::regclass)` nella STRINGA "nextval('s'::regclass)": la DDL
 *      del backup assegnava un testo a una colonna intera;
 *   2. una colonna con `nextval(...)` torna `serial`, perché la sequenza di
 *      origine non esiste nello schema di destinazione;
 *   3. identità e colonne generate non diventano colonne ordinarie;
 *   4. le colonne GENERATE sono escluse dalla lista di lettura: PostgreSQL
 *      rifiuta un INSERT che le valorizzi, quindi salvarle faceva fallire il
 *      ripristino dell'intera tabella;
 *   5. `bytea` si legge in esadecimale e i temporali come testo, perché il
 *      driver li consegna come Buffer e come Date — forme che perdono byte e
 *      microsecondi;
 *   6. le chiavi esterne NON stanno nella CREATE TABLE.
 *
 * Nessun database: l'esecutore è finto. È anche il motivo per cui il modulo
 * riceve una funzione `q` invece di un pool.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { pgCreateTable, pgAuxDdl, pgColonneDaSalvare, pgSchemaObjects } = require('../db/pg-ddl');

/**
 * Esecutore finto: risponde in base a ciò che la query CHIEDE, non all'ordine
 * in cui arriva. Legare le risposte alla sequenza renderebbe il test verde
 * anche dopo aver invertito due chiamate.
 */
function esecutore(risposte) {
  const eseguite = [];
  const q = async (sql, params) => {
    eseguite.push(String(sql));
    for (const [riconosce, rows] of risposte) {
      if (riconosce.test(String(sql))) return { rows, rowCount: rows.length };
    }
    throw new Error(`Query non prevista dal test:\n${sql}\nparams=${JSON.stringify(params)}`);
  };
  return { q, eseguite };
}

// Catalogo di prova: tabella `ordini` con una seriale, un'identità, una
// generata, un bytea, un timestamp, una FK e un indice.
const COLONNE = [
  { name: 'id', ctype: 'integer', notnull: true, cdefault: "nextval('ordini_id_seq'::regclass)", identity: '', generated: '' },
  { name: 'num', ctype: 'bigint', notnull: true, cdefault: null, identity: 'a', generated: '' },
  { name: 'codice', ctype: 'character varying(40)', notnull: true, cdefault: null, identity: '', generated: '' },
  { name: 'totale', ctype: 'numeric(12,2)', notnull: false, cdefault: '0', identity: '', generated: '' },
  { name: 'creato', ctype: 'timestamp without time zone', notnull: false, cdefault: 'now()', identity: '', generated: '' },
  { name: 'firma', ctype: 'bytea', notnull: false, cdefault: null, identity: '', generated: '' },
  { name: 'totale_iva', ctype: 'numeric(12,2)', notnull: false, cdefault: '(totale * 1.22)', identity: '', generated: 's' },
];

const CATALOGO = [
  [/pg_catalog\.pg_attribute/, COLONNE],
  [/pg_get_constraintdef[\s\S]*contype IN/, [
    { def: 'PRIMARY KEY (id)' },
    { def: 'UNIQUE (codice)' },
    { def: 'CHECK ((totale >= (0)::numeric))' },
  ]],
  [/pg_get_indexdef/, [{ def: 'CREATE INDEX ordini_creato_idx ON ordini USING btree (creato)' }]],
  [/pg_get_constraintdef[\s\S]*contype = /, [
    { name: 'ordini_cliente_fk', def: 'FOREIGN KEY (cliente_id) REFERENCES clienti(id) ON DELETE CASCADE' },
  ]],
];

async function main() {
  // --- CREATE TABLE fedele ------------------------------------------------
  {
    const { q, eseguite } = esecutore(CATALOGO);
    const ddl = await pgCreateTable(q, 'vendite', 'ordini');

    // 1 + 2. Il default espressione non va quotato, e la seriale diventa serial.
    assert.ok(/"id"\s+serial/i.test(ddl), `nextval deve diventare serial:\n${ddl}`);
    assert.ok(!/nextval/i.test(ddl), `il DDL non deve puntare alla sequenza di origine:\n${ddl}`);
    assert.ok(/DEFAULT now\(\)/i.test(ddl), `now() va riprodotto verbatim, non quotato:\n${ddl}`);
    assert.ok(!/DEFAULT '/.test(ddl), `nessun default deve diventare un letterale di testo:\n${ddl}`);

    // 3. Identità e generate restano tali.
    assert.ok(/"num"\s+bigint\s+GENERATED ALWAYS AS IDENTITY/i.test(ddl), `identità persa:\n${ddl}`);
    assert.ok(/"totale_iva"[\s\S]*GENERATED ALWAYS AS \(\(totale \* 1\.22\)\) STORED/i.test(ddl),
      `colonna generata persa:\n${ddl}`);

    // I modificatori di tipo che una ricostruzione a mano perde.
    assert.ok(ddl.includes('character varying(40)'), `varchar(40) preservato:\n${ddl}`);
    assert.ok(ddl.includes('numeric(12,2)'), `numeric(12,2) preservato:\n${ddl}`);

    // Vincoli dentro la CREATE TABLE...
    assert.ok(ddl.includes('PRIMARY KEY (id)'), `PRIMARY KEY:\n${ddl}`);
    assert.ok(ddl.includes('UNIQUE (codice)'), `UNIQUE:\n${ddl}`);
    assert.ok(ddl.includes('CHECK'), `CHECK:\n${ddl}`);

    // 6. ...ma NON le chiavi esterne.
    assert.ok(!/FOREIGN KEY/i.test(ddl), `le FK non vanno nella CREATE TABLE:\n${ddl}`);
    const qVincoli = eseguite.find((s) => /pg_get_constraintdef/.test(s) && /contype IN/.test(s));
    assert.ok(qVincoli && !/contype IN[^)]*'f'/.test(qVincoli),
      `la query dei vincoli non deve chiedere le FK:\n${qVincoli}`);

    // Non qualificata per default (retarget via search_path), qualificabile su richiesta.
    assert.ok(/CREATE TABLE "ordini"/.test(ddl), `nome nudo per default:\n${ddl}`);
    const { q: q2 } = esecutore(CATALOGO);
    const ddlQ = await pgCreateTable(q2, 'vendite', 'ordini', { qualificato: true });
    assert.ok(/CREATE TABLE "vendite"\."ordini"/.test(ddlQ), `qualificazione su richiesta:\n${ddlQ}`);

    console.log('  OK   CREATE TABLE PostgreSQL: default verbatim, serial, identità, generate, vincoli (CDB-A87)');
  }

  // --- 4 + 5. Come si leggono le colonne ----------------------------------
  {
    const { q } = esecutore(CATALOGO);
    const { nomi, binarie, select } = await pgColonneDaSalvare(q, 'vendite', 'ordini');

    assert.ok(!nomi.includes('totale_iva'),
      'le colonne generate NON vanno salvate: PostgreSQL rifiuta un INSERT che le valorizzi');
    assert.strictEqual(nomi.length, 6, `attese 6 colonne salvabili, trovate ${nomi.length}`);
    assert.ok(!/totale_iva/.test(select), `la generata non deve stare nella SELECT:\n${select}`);

    assert.ok(/encode\("firma", 'hex'\) AS "firma"/.test(select),
      `bytea va letto in esadecimale:\n${select}`);
    assert.ok(binarie.has('firma'), 'la colonna binaria va segnalata al restore');

    assert.ok(/"creato"::text AS "creato"/.test(select),
      `i temporali vanno letti come testo, o il Date del driver tronca i microsecondi:\n${select}`);

    // Le colonne ordinarie restano nude: nessun costo inutile.
    assert.ok(/(^|, )"codice"(,|$)/.test(select), `colonna ordinaria non alterata:\n${select}`);

    console.log('  OK   Lettura PostgreSQL: generate escluse, bytea in hex, temporali come testo (CDB-A87)');
  }

  // --- Indici e FK differiti ----------------------------------------------
  {
    const { q } = esecutore(CATALOGO);
    const aux = await pgAuxDdl(q, 'vendite', 'ordini');
    assert.strictEqual(aux.indexes.length, 1, 'un indice non vincolare atteso');
    assert.ok(aux.indexes[0].trim().endsWith(';'), 'istruzione terminata');
    assert.strictEqual(aux.foreignKeys.length, 1, 'una FK attesa');
    assert.ok(/ALTER TABLE "ordini" ADD CONSTRAINT "ordini_cliente_fk" FOREIGN KEY/.test(aux.foreignKeys[0]),
      aux.foreignKeys[0]);
    assert.ok(/ON DELETE CASCADE/.test(aux.foreignKeys[0]),
      `l'azione referenziale non va persa:\n${aux.foreignKeys[0]}`);
    console.log('  OK   Indici e chiavi esterne PostgreSQL differiti alla terza fase (CDB-A87)');
  }

  // --- Oggetti di schema ---------------------------------------------------
  {
    const { q } = esecutore([
      [/pg_get_viewdef/, [
        { name: 'v_caro', kind: 'v', def: 'SELECT id FROM ordini WHERE totale > 100' },
        { name: 'v_mat', kind: 'm', def: 'SELECT 1' },
      ]],
      [/pg_get_functiondef/, [{ oid: 1, name: 'f_doppio', def: 'CREATE OR REPLACE FUNCTION f_doppio(x integer) RETURNS integer AS $$ SELECT x*2 $$ LANGUAGE sql' }]],
      [/pg_get_triggerdef/, [{ name: 't_ins', ontable: 'ordini', def: 'CREATE TRIGGER t_ins BEFORE INSERT ON ordini FOR EACH ROW EXECUTE FUNCTION f()' }]],
      [/pg_sequences/, [
        {
          name: 'seq_libera', start_value: '5', min_value: '1', max_value: '9223372036854775807',
          increment_by: '2', cycle: false, cache_size: '1', last_value: '41', posseduta: null,
        },
        {
          name: 'ordini_id_seq', start_value: '1', min_value: '1', max_value: '2147483647',
          increment_by: '1', cycle: false, cache_size: '1', last_value: '1000', posseduta: 1,
        },
        {
          name: 'mai_usata', start_value: '1', min_value: '1', max_value: '100',
          increment_by: '1', cycle: true, cache_size: '1', last_value: null, posseduta: null,
        },
      ]],
    ]);
    const o = await pgSchemaObjects(q, 'vendite');
    assert.strictEqual(o.views.length, 2, 'due view attese');
    assert.ok(/^CREATE VIEW "v_caro" AS /.test(o.views[0].ddl), o.views[0].ddl);
    assert.ok(/^CREATE MATERIALIZED VIEW "v_mat" AS /.test(o.views[1].ddl),
      `la view materializzata va ricreata come tale:\n${o.views[1].ddl}`);
    assert.strictEqual(o.routines.length, 1, 'una funzione attesa');
    assert.strictEqual(o.triggers.length, 1, 'un trigger atteso');
    // Solo le sequenze INDIPENDENTI vanno ricreate: quella di una serial la
    // ricrea il tipo `serial` della CREATE TABLE, e ricrearla qui sarebbe un
    // duplicato.
    assert.strictEqual(o.sequences.length, 2, 'due sequenze indipendenti attese (non quella posseduta)');
    assert.ok(!o.sequences.some((s) => s.name === 'ordini_id_seq'),
      'la sequenza posseduta da una colonna serial NON va ricreata');

    // I PARAMETRI vanno riprodotti: una sequenza ricreata con i default non è
    // la stessa sequenza — cambiano passo, limiti e comportamento al giro.
    const libera = o.sequences.find((s) => s.name === 'seq_libera');
    assert.ok(/INCREMENT BY 2/.test(libera.ddl), `passo perso:\n${libera.ddl}`);
    assert.ok(/START WITH 5/.test(libera.ddl), `start perso:\n${libera.ddl}`);
    assert.ok(/NO CYCLE/.test(libera.ddl), `cycle perso:\n${libera.ddl}`);
    const ciclica = o.sequences.find((s) => s.name === 'mai_usata');
    assert.ok(/\bCYCLE$/.test(ciclica.ddl), `CYCLE perso:\n${ciclica.ddl}`);

    // --- Il pezzo che mancava del tutto: il VALORE corrente ----------------
    // Senza, una tabella con id 1..1000 si ripristina con i dati giusti ma la
    // sequenza riparte da 1 e il primo INSERT sbatte contro la chiave primaria.
    assert.strictEqual(o.sequenceValues.length, 2,
      'il valore va ripristinato per TUTTE le sequenze usate, anche quelle possedute da una serial');
    const valPosseduta = o.sequenceValues.find((s) => s.name === 'ordini_id_seq');
    assert.ok(valPosseduta, 'manca il valore della sequenza di una colonna serial: è il caso che rompe di più');
    assert.ok(/setval\('ordini_id_seq', 1000, true\)/.test(valPosseduta.sql), valPosseduta.sql);
    assert.ok(!o.sequenceValues.some((s) => s.name === 'mai_usata'),
      'una sequenza mai usata non ha un valore da riportare: va lasciata al suo START WITH');

    console.log('  OK   Oggetti PostgreSQL: view, funzioni, trigger, sequenze con parametri e VALORE (CDB-A87)');
  }

  console.log('\nTutti i test dello schema PostgreSQL superati!');
}

module.exports = main().catch((err) => {
  console.error('\nTest dello schema PostgreSQL FALLITO:\n', err);
  process.exitCode = 1;
  throw err;
});
