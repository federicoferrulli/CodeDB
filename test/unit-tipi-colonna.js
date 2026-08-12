'use strict';

/* ---------------------------------------------------------------------------
 * Il TIPO di una colonna è sintassi interpolata nel DDL (CDB-A67).
 *
 * Il nome della colonna viene quotato (`qid`), il tipo no — e non può esserlo,
 * perché `VARCHAR(255)` deve arrivare al motore come sintassi. L'unica difesa
 * possibile è pretendere che il testo *abbia la forma* di un tipo, ed è
 * `DbStrategy.assertColumnType`.
 *
 * Perché serve un test dedicato: su PostgreSQL le DDL passano da
 * `pool.query(testo)` senza parametri, cioè dal simple query protocol, che
 * esegue tutto ciò che è separato da `;`. Un tipo non validato rendeva
 * `column:add`/`column:alter` esecuzione di SQL arbitrario per un sottoutente
 * con la sola capability `ddl`. Il difetto è vissuto a lungo senza che nulla lo
 * segnalasse, perché nessun test guardava questo argomento.
 *
 * Le prove sono TRE gruppi e servono tutti e tre:
 *
 *   1. cosa deve PASSARE — una barriera che rifiuta i tipi veri viene aggirata
 *      dal primo amministratore che la incontra, e allora non protegge più
 *      nulla. `character varying` è il caso da non perdere di vista: è la forma
 *      che `information_schema.columns` restituisce su PostgreSQL, cioè quella
 *      che pre-riempie il form di modifica;
 *   2. cosa deve essere RIFIUTATO per non eseguire altre istruzioni;
 *   3. cosa deve essere rifiutato per non valutare un'ESPRESSIONE — il gruppo
 *      che alla prima stesura passava, e che vale quanto gli altri due: una
 *      espressione porta il contenuto di un file dell'host dentro una colonna
 *      leggibile con una normale SELECT.
 *
 * Nessun database: la funzione è pura.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const DbStrategy = require('../db/DbStrategy');

const ammesso = (t) => assert.doesNotThrow(
  () => DbStrategy.assertColumnType(t), `doveva essere ammesso: ${t}`);
const negato = (t) => assert.throws(
  () => DbStrategy.assertColumnType(t), `doveva essere rifiutato: ${t}`);

// --- 1. Tipi veri: devono continuare a funzionare --------------------------
{
  [
    // scalari e alias dei tre DBMS
    'INT', 'int unsigned', 'BIGSERIAL', 'numeric', 'JSONB', 'uuid', 'timestamptz',
    'MEDIUMTEXT', 'DOUBLE', 'int4range',
    // con argomenti
    'VARCHAR(255)', 'DECIMAL(10,2)', 'numeric (10,2)', 'geometry(Point,4326)',
    // nomi composti, con e senza argomenti
    'DOUBLE PRECISION', 'TIMESTAMP WITH TIME ZONE', 'timestamp without time zone',
    'timestamp(3) with time zone', 'time(6) without time zone', 'POINT SRID 4326',
    // `varying`: la forma che PostgreSQL stesso restituisce al form di modifica
    'character varying', 'character varying(50)', 'CHARACTER VARYING(50)', 'bit varying(8)',
    // array PostgreSQL
    'TEXT[]', 'varchar(50)[]',
    // literal come argomenti (MySQL)
    "ENUM('a','b')", "SET('x')", "ENUM('l''apostrofo')",
  ].forEach(ammesso);
  console.log('  OK   I tipi SQL reali dei tre DBMS restano ammessi');
}

// --- 2. Istruzioni aggiuntive e uscita dallo scope -------------------------
{
  // PostgreSQL: simple query protocol, esegue tutto ciò che segue il `;`.
  negato("text; CREATE ROLE evil SUPERUSER LOGIN PASSWORD 'x'; --");
  negato('int; DROP TABLE altra');
  // MySQL: `multipleStatements:false` ferma il `;` ma non la virgola, che apre
  // una nuova specifica dell'ALTER — e `RENAME TO` porta la tabella fuori dallo
  // scope, cioè ciò che `coll2` di renameCollection esiste per impedire.
  negato('INT, RENAME TO altra_tabella');
  negato('INT, DROP COLUMN altra');
  // Caratteri che servono solo a uscire dalla posizione "tipo".
  negato('INT/*x*/');
  negato('VARCHAR(255) DEFAULT "a"');
  negato('INT`');
  negato('text\\');
  negato("ENUM('a");        // apice mai chiuso
  negato('INT)');           // parentesi sbilanciate
  negato('x'.repeat(300));  // oltre il tetto di lunghezza
  console.log('  OK   Nessuna istruzione aggiuntiva né uscita dallo scope (CDB-A67)');
}

// --- 3. Valutazione di espressioni ----------------------------------------
{
  // `USING` è la clausola di `ALTER COLUMN … TYPE`; le altre appartengono alla
  // definizione di colonna di `ADD COLUMN`. Nessuna deve poter entrare dal
  // campo "tipo": tutte valutano un'espressione con l'utente DBMS della
  // connessione, e da lì si legge un file dell'host o un'altra tabella.
  negato("text USING pg_read_file('/etc/passwd')");
  negato("text USING (pg_read_file('/etc/passwd'))");
  negato('text USING (SELECT p FROM segreti)');
  negato('text USING(SELECT p FROM segreti)');
  negato('text USING (1)');
  negato("text DEFAULT pg_read_file('/etc/passwd')");
  negato("text DEFAULT 'x'");
  negato('text COLLATE "C"');
  negato('text REFERENCES altra(id)');
  negato('int GENERATED ALWAYS AS (1) STORED');
  negato('text CHECK (1=1)');
  // Anche dentro gli argomenti: nessun tipo ha parentesi annidate.
  negato("varchar(pg_read_file('/x'))");
  console.log('  OK   Nessuna espressione valutabile nella posizione del tipo (CDB-A67)');
}

// --- 4. Il rifiuto deve dire cosa fare ------------------------------------
{
  try {
    DbStrategy.assertColumnType('text USING (SELECT 1)');
    assert.fail('doveva essere rifiutato');
  } catch (err) {
    assert.ok(/Query & Aggregate/.test(err.message),
      'il rifiuto deve indicare la via legittima per una definizione complessa');
    assert.ok(/VARCHAR\(255\)/.test(err.message),
      'il rifiuto deve mostrare un esempio di forma ammessa');
  }
  // Un tipo mancante è un errore diverso e va detto come tale.
  assert.throws(() => DbStrategy.assertColumnType(''), /mancante/);
  assert.throws(() => DbStrategy.assertColumnType(null), /mancante/);
  console.log('  OK   Il rifiuto spiega come procedere invece di limitarsi a negare');
}

console.log('\nTutti i test sui tipi di colonna superati!');
