'use strict';

/* ---------------------------------------------------------------------------
 * Test end-to-end: collation di connessione su MySQL reale.
 *
 *   MYSQL_PASSWORD=root node test/e2e-collazione-mysql.js
 *
 * Quello che qui si prova non è provabile senza un server: che il MOTORE
 * accetti gli SET che componiamo, e soprattutto che l'errore 1267 sparisca
 * dove era colpa nostra e RESTI dove non lo è.
 *
 * Il difetto originale: mysql2, senza `charset`, impone la collation compilata
 * nel driver (utf8mb4_unicode_ci). Le variabili utente e i risultati di
 * `CAST(… AS CHAR)` la ereditano con coercibilità IMPLICIT — la stessa di una
 * colonna — quindi confrontarli con una colonna utf8mb4_general_ci faceva
 * fallire in CodeDB query che nel client `mysql` e in DBeaver funzionavano.
 * Non è una preferenza estetica: era un errore che si vedeva SOLO qui.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const MySqlStrategy = require('../db/MySqlStrategy');
const { createE2eTargetRegistry } = require('./e2e-harness');

const HOST = process.env.MYSQL_HOST || 'localhost';
const PORT = parseInt(process.env.MYSQL_PORT, 10) || 3306;
const USER = process.env.MYSQL_USER || 'root';
const PASSWORD = process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '';
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_collazione' });
const DB = targets.target('db');

(async () => {
  console.log('--- E2E: collation di connessione (MySQL) ---');
  const strategy = new MySqlStrategy();
  try {
    await strategy.connect({ host: HOST, port: PORT, username: USER, password: PASSWORD });
  } catch (err) {
    if (err && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT')) {
      console.log(`  SKIP Nessun MySQL su ${HOST}:${PORT} (${err.code})`);
      return;
    }
    throw err;
  }

  const esegui = (db, testo) => strategy.collectionAggregate(db, null, { pipeline: testo });
  const valore = async (db, testo) => {
    const r = await esegui(db, testo);
    const doc = r.docs[0];
    return doc[Object.keys(doc)[0]];
  };

  try {
    // Uno schema come quelli che il difetto colpiva: database e tabelle in
    // utf8mb4_general_ci (l'eredità di MySQL 5.7), su un server la cui
    // predefinita è un'altra.
    await targets.drop(DB, (name) => esegui(null, `DROP DATABASE IF EXISTS \`${name}\``));
    await esegui(null, `CREATE DATABASE ${DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    await esegui(DB, 'CREATE TABLE t (id INT PRIMARY KEY, nome VARCHAR(50))');
    await esegui(DB, "INSERT INTO t VALUES (1,'alfa'),(2,'beta')");
    // Seconda tabella con collation ESPLICITAMENTE diversa: serve per il caso
    // che deve continuare a fallire.
    await esegui(DB, 'CREATE TABLE u (id INT PRIMARY KEY, nome VARCHAR(50) COLLATE utf8mb4_unicode_ci)');
    await esegui(DB, "INSERT INTO u VALUES (1,'alfa')");

    // 1. La connessione segue il DATABASE, non la costante del driver.
    const ccDb = await valore(DB, 'SELECT @@collation_connection');
    assert.strictEqual(ccDb, 'utf8mb4_general_ci',
      `la connessione doveva allinearsi al database, invece è ${ccDb}`);
    console.log('  OK   collation_connection segue il database (utf8mb4_general_ci)');

    // 2. …e cambia seguendo il bersaglio: senza questo, l'allineamento
    //    varrebbe solo per il database predefinito della connessione.
    const ccServer = await valore('mysql', 'SELECT @@collation_connection');
    assert.notStrictEqual(ccServer, ccDb, 'cambiando database la collation doveva cambiare');
    assert.ok(ccServer.startsWith('utf8mb4_'), `mai fuori da utf8mb4, era ${ccServer}`);
    console.log(`  OK   Cambiando database la connessione lo segue (${ccServer})`);

    // 3. I due casi che PRIMA fallivano: variabile utente e CAST confrontati
    //    con una colonna. Sono il difetto segnalato.
    await esegui(DB, "SET @v := 'alfa'");
    const perVar = await esegui(DB, 'SELECT id FROM t WHERE nome = @v');
    assert.strictEqual(perVar.docs.length, 1, 'il confronto con @v doveva funzionare e trovare 1 riga');
    const perCast = await esegui(DB, "SELECT id FROM t WHERE CAST(id AS CHAR) = nome OR id = 1");
    assert.ok(perCast.docs.length >= 1, 'il confronto con CAST doveva funzionare');
    console.log('  OK   Confronti con @variabile e CAST(… AS CHAR) non danno più 1267');

    // 4. Il caso che NON è nostro deve continuare a fallire: due colonne di
    //    collation diverse. Se sparisse anche questo avremmo nascosto un
    //    difetto dello schema invece di correggere il nostro.
    await assert.rejects(
      () => esegui(DB, 'SELECT t.id FROM t JOIN u ON t.nome = u.nome'),
      /Illegal mix of collations|collation/i,
      'il confronto fra due colonne di collation diverse deve restare un errore'
    );
    console.log('  OK   Due colonne di collation diverse restano un errore (è lo schema)');

    // 5. L'allineamento vale per OGNI connessione del pool, non solo per la
    //    prima: il pool ne apre fino a 8, e una nuova nasce col default del
    //    driver. Query in parallelo ⇒ connessioni distinte.
    const paralleli = await Promise.all(
      Array.from({ length: 5 }, () => valore(DB, 'SELECT @@collation_connection AS cc, SLEEP(0.2)'))
    );
    assert.ok(paralleli.every((c) => c === 'utf8mb4_general_ci'),
      `qualche connessione del pool è rimasta disallineata: ${JSON.stringify(paralleli)}`);
    console.log('  OK   Tutte le connessioni del pool sono allineate, non solo la prima');

    // 6. utf8mb4 resta utf8mb4: un testo fuori dal latino sopravvive al giro.
    //    È la garanzia che paga il filtro sul charset (una collation latin1
    //    adottata dal server avrebbe mangiato questi caratteri).
    await esegui(DB, "INSERT INTO t VALUES (3, '日本語 😀')");
    const tornato = await valore(DB, 'SELECT nome FROM t WHERE id = 3');
    assert.strictEqual(tornato, '日本語 😀', `testo non latino alterato: ${tornato}`);
    console.log('  OK   Testo non latino integro (la connessione resta utf8mb4)');

    console.log('Tutti i test E2E sulla collation superati!');
  } finally {
    await targets.cleanup((name) => strategy.collectionAggregate(null, null, { pipeline: `DROP DATABASE IF EXISTS \`${name}\`` }).catch(() => {}));
    await strategy.disconnect();
  }
})().catch((err) => {
  console.error('\nFALLITO (collation MySQL):', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
