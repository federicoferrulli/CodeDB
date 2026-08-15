'use strict';

/* ---------------------------------------------------------------------------
 * DDL del round-trip export/import di un intero database (CDB-A83).
 *
 * Il round-trip PostgreSQL era stato BLOCCATO in interfaccia invece che
 * corretto: il DDL prodotto qualificava la tabella con lo schema di ORIGINE e
 * conteneva le sole colonne più la PRIMARY KEY. Importare in uno schema diverso
 * ricreava quindi la tabella nello schema di partenza, e indici, UNIQUE, CHECK
 * e chiavi esterne sparivano senza un errore.
 *
 * Perché un test con un pool finto e non un E2E: ciò che si deve dimostrare non
 * è che PostgreSQL sappia eseguire il DDL — quello lo sa — ma che il TESTO
 * generato abbia tre proprietà che a occhio non si notano e che nessun errore
 * segnala:
 *
 *   1. il nome della tabella NON è qualificato. È l'intero meccanismo del
 *      retarget: `collectionAggregate` allinea il `search_path` allo schema di
 *      destinazione, quindi un nome nudo atterra dove si sta importando. Con lo
 *      schema di origine davanti, l'import "riesce" scrivendo nel posto
 *      sbagliato — il modo peggiore di fallire;
 *   2. una colonna con `DEFAULT nextval(...)` torna `serial`. Riprodurre il
 *      default verbatim creerebbe una tabella che punta alla sequenza di un
 *      altro schema: la tabella nasce, e le INSERT falliscono dopo;
 *   3. indici e chiavi esterne NON stanno nella CREATE TABLE ma in una fase
 *      successiva. Una FK verso una tabella non ancora creata fallisce, e una
 *      FK già attiva impone alle righe un ordine di caricamento che il file
 *      dell'export non descrive.
 *
 * Il pool finto restituisce righe nella forma REALE del catalogo PostgreSQL
 * (`format_type`, `pg_get_constraintdef`, `pg_get_indexdef`), che è la parte
 * che conta: se un giorno le query cambiano forma, il test smette di
 * riconoscerle e va aggiornato insieme a loro.
 *
 * Nessun database: il pool è finto.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');

/**
 * Pool minimo che risponde in base a ciò che la query CHIEDE, non all'ordine in
 * cui arriva: legare le risposte alla sequenza renderebbe il test verde anche
 * dopo aver invertito due chiamate.
 */
function poolFinto(risposte) {
  const eseguite = [];
  const client = {
    async query(sql, params) {
      const testo = String(sql && sql.text ? sql.text : sql);
      eseguite.push(testo);
      if (/^\s*(BEGIN|ROLLBACK|COMMIT|SET|RESET)\b/i.test(testo)) return { rows: [], rowCount: 0 };
      for (const [riconosce, righe] of risposte) {
        if (riconosce.test(testo)) return { rows: righe, rowCount: righe.length };
      }
      throw new Error(`Query non prevista dal test:\n${testo}\nparams=${JSON.stringify(params)}`);
    },
    release() {},
  };
  return {
    eseguite,
    pool: {
      async connect() { return client; },
      query: (sql, params) => client.query(sql, params),
    },
  };
}

// Catalogo di prova: una tabella `ordini` nello schema `vendite`, con una
// chiave seriale, un UNIQUE, un CHECK, un indice normale e una FK verso
// `clienti`. È il minimo che copre tutte e tre le proprietà da dimostrare.
const CATALOGO = [
  [/information_schema\.columns[\s\S]*is_identity/i, []],
  [/format_type/i, [
    { name: 'id', ctype: 'integer', nullable: 'NO', cdefault: "nextval('ordini_id_seq'::regclass)" },
    { name: 'codice', ctype: 'character varying(40)', nullable: 'NO', cdefault: null },
    { name: 'cliente_id', ctype: 'integer', nullable: 'YES', cdefault: null },
    { name: 'totale', ctype: 'numeric(12,2)', nullable: 'YES', cdefault: '0' },
    { name: 'creato', ctype: 'timestamp without time zone', nullable: 'YES', cdefault: 'now()' },
  ]],
  [/constraint_name|key_column_usage/i, [{ column_name: 'id' }]],
  [/pg_get_constraintdef[\s\S]*contype IN/i, [
    { def: 'PRIMARY KEY (id)' },
    { def: 'UNIQUE (codice)' },
    { def: 'CHECK ((totale >= (0)::numeric))' },
  ]],
  [/pg_get_indexdef/i, [
    { def: 'CREATE INDEX ordini_creato_idx ON ordini USING btree (creato)' },
  ]],
  [/pg_get_constraintdef[\s\S]*contype = \$?'?f'?/i, [
    { name: 'ordini_cliente_fk', def: 'FOREIGN KEY (cliente_id) REFERENCES clienti(id) ON DELETE CASCADE' },
  ]],
];

function nuovaStrategia() {
  const finto = poolFinto(CATALOGO);
  const s = new PostgreSqlStrategy();
  s.pool = finto.pool;
  return { s, finto };
}

async function main() {
  // --- 1. Retarget: la tabella non deve essere qualificata -----------------
  {
    const { s, finto } = nuovaStrategia();
    const ddl = await s.tableDdl('vendite', 'ordini');

    assert.ok(/CREATE TABLE\s+"ordini"\s*\(/.test(ddl),
      `la CREATE TABLE deve usare il nome NUDO, altrimenti l'import atterra nello schema di origine:\n${ddl}`);
    assert.ok(!/"vendite"\s*\./.test(ddl),
      `nessun riferimento allo schema di origine nel DDL:\n${ddl}`);

    // --- 2. La colonna seriale torna `serial`, non un nextval verso un'altra
    //        sequenza -------------------------------------------------------
    assert.ok(/"id"\s+serial/i.test(ddl),
      `una colonna con DEFAULT nextval(...) deve diventare serial:\n${ddl}`);
    assert.ok(!/nextval/i.test(ddl),
      `il DDL non deve puntare alla sequenza dello schema di origine:\n${ddl}`);

    // I modificatori di tipo che `information_schema.data_type` perde e che
    // `format_type` conserva: se si perdono qui, la tabella importata ha
    // colonne di tipo diverso dall'originale senza che nulla lo segnali.
    assert.ok(ddl.includes('character varying(40)'), `varchar(40) preservato:\n${ddl}`);
    assert.ok(ddl.includes('numeric(12,2)'), `numeric(12,2) preservato:\n${ddl}`);

    // Un default che è un'ESPRESSIONE va riprodotto verbatim: quotarlo come
    // letterale (il vecchio `defaultSql`) trasformava now() nella stringa
    // "now()", cioè in un errore di tipo al primo INSERT.
    assert.ok(/DEFAULT now\(\)/i.test(ddl), `default espressione non quotato:\n${ddl}`);

    // Vincoli di tabella dentro la CREATE TABLE...
    assert.ok(ddl.includes('PRIMARY KEY (id)'), `PRIMARY KEY presente:\n${ddl}`);
    assert.ok(ddl.includes('UNIQUE (codice)'), `UNIQUE presente:\n${ddl}`);
    assert.ok(ddl.includes('CHECK'), `CHECK presente:\n${ddl}`);

    // --- 3. ...ma NON le chiavi esterne, che romperebbero l'ordine ----------
    assert.ok(!/FOREIGN KEY/i.test(ddl),
      `le FK non vanno nella CREATE TABLE: una FK verso una tabella non ancora creata fallisce:\n${ddl}`);

    // L'asserzione qui sopra da sola NON basta, ed è bene sapere perché: il
    // pool finto restituisce righe fisse e non filtra davvero per `contype`,
    // quindi resterebbe verde anche se la query tornasse a chiedere le FK
    // insieme agli altri vincoli. La separazione va perciò verificata dove
    // vive davvero, cioè nel testo della query.
    const qVincoli = finto.eseguite.find((q) => /pg_get_constraintdef/.test(q) && /contype IN/.test(q));
    assert.ok(qVincoli, 'la CREATE TABLE deve leggere i vincoli dal catalogo');
    assert.ok(!/contype IN[^)]*'f'/.test(qVincoli),
      `i vincoli della CREATE TABLE non devono includere le FK (contype 'f'):\n${qVincoli}`);

    const aux = await s.tableAuxDdl('vendite', 'ordini');
    assert.strictEqual(aux.indexes.length, 1, 'un indice non vincolare atteso');
    assert.ok(/CREATE INDEX ordini_creato_idx/.test(aux.indexes[0]), aux.indexes[0]);
    assert.ok(aux.indexes[0].trim().endsWith(';'), 'ogni istruzione deve essere terminata');

    assert.strictEqual(aux.foreignKeys.length, 1, 'una FK attesa');
    assert.ok(/ALTER TABLE "ordini" ADD CONSTRAINT "ordini_cliente_fk" FOREIGN KEY/.test(aux.foreignKeys[0]),
      aux.foreignKeys[0]);
    assert.ok(/REFERENCES clienti\(id\)/.test(aux.foreignKeys[0]),
      `il riferimento resta non qualificato, così segue lo schema di destinazione:\n${aux.foreignKeys[0]}`);
    assert.ok(/ON DELETE CASCADE/.test(aux.foreignKeys[0]),
      `l'azione referenziale non va persa:\n${aux.foreignKeys[0]}`);

    console.log('  OK   DDL PostgreSQL: retarget, serial, vincoli e FK differite (CDB-A83)');
  }

  // --- 4. Il search_path viene fissato sullo schema di ORIGINE -------------
  {
    // È ciò che fa restituire alle funzioni di catalogo nomi non qualificati.
    // Senza, `pg_get_indexdef` scriverebbe "vendite.ordini" e l'indice
    // nascerebbe nello schema sbagliato.
    const { s: s2, finto } = nuovaStrategia();
    await s2.tableAuxDdl('vendite', 'ordini');
    assert.ok(finto.eseguite.some((q) => /SET LOCAL search_path TO "vendite"/.test(q)),
      `search_path non allineato allo schema di origine:\n${finto.eseguite.join('\n')}`);
    assert.ok(finto.eseguite.some((q) => /^\s*ROLLBACK/i.test(q)),
      'la transazione di sola lettura deve chiudersi prima di restituire il client al pool');

    console.log('  OK   Catalogo PostgreSQL letto con search_path sullo schema di origine (CDB-A83)');
  }

  // --- 5. Una colonna a IDENTITÀ non diventa una colonna ordinaria ---------
  {
    const conIdentita = CATALOGO.map(([re, righe]) =>
      (/is_identity/.test(re.source) ? [re, [{ name: 'id', generation: 'ALWAYS' }]] : [re, righe]));
    const s3 = new PostgreSqlStrategy();
    s3.pool = poolFinto(conIdentita).pool;
    const ddlId = await s3.tableDdl('vendite', 'ordini');
    assert.ok(/"id"\s+integer\s+GENERATED ALWAYS AS IDENTITY/i.test(ddlId),
      `l'identità va conservata, altrimenti la colonna perde la generazione automatica:\n${ddlId}`);

    console.log('  OK   Colonne GENERATED ... AS IDENTITY conservate (CDB-A83)');
  }

  console.log('\nTutti i test del DDL di round-trip superati!');
}

module.exports = main().catch((err) => {
  console.error('\nTest del DDL di round-trip FALLITO:\n', err);
  process.exitCode = 1;
  throw err;
});
