'use strict';

/* ---------------------------------------------------------------------------
 * Oggetti di schema nel backup, e rinomina di un database (CDB-A85).
 *
 * La rinomina di un database su MongoDB e MySQL non ha un comando nativo: passa
 * da dump → verifica → restore. Perché quel percorso sia una RINOMINA e non una
 * perdita, il backup deve portarsi dietro anche ciò che non è una riga — view,
 * routine, trigger, eventi, vincoli, validatori — e il restore deve rimetterlo
 * al posto giusto, nel database GIUSTO.
 *
 * Qui si provano le funzioni pure di quel percorso, cioè quelle in cui un errore
 * non lancia e non si vede:
 *
 *   1. `splitMySqlForeignKeys` — se le FK restano dentro la CREATE TABLE, il
 *      ripristino dipende dall'ordine alfabetico delle tabelle: una figlia
 *      creata prima della padre fallisce con ER_FK_CANNOT_OPEN_PARENT e sparisce
 *      con le sue righe. Verificato dal vivo su MySQL 8.4.9 prima della
 *      correzione: 1 tabella persa su 2. La virgola sospesa dopo l'estrazione è
 *      il modo più facile di rompere tutto, quindi ha una prova sua;
 *   2. `riqualificaDdl` — `SHOW CREATE VIEW` qualifica le tabelle con lo schema
 *      di ORIGINE. Ripristinata altrove senza riscrittura, la view continua a
 *      leggere il database ORIGINALE: il restore "riesce" e produce oggetti che
 *      puntano al posto sbagliato;
 *   3. `senzaDefiner` — il DEFINER nomina un utente dell'istanza di origine e
 *      fa fallire il ripristino con ERROR 1227 per un motivo che non ha nulla a
 *      che vedere con i dati;
 *   4. `assertSafeObjectSql` — il file degli oggetti arriva dal DISCO e un
 *      backup può essere stato ricevuto da terzi. Vale lo stesso principio di
 *      `assertSafeSchemaSql` (CDB-A80).
 *
 * Nessun database: sono tutte funzioni di testo.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { riqualificaDdl, senzaDefiner } = require('../backup/lib/restore');
const { splitMySqlForeignKeys } = require('../backup/lib/engine');

// --- 1. Estrazione delle chiavi esterne ------------------------------------
{
  const create = [
    'CREATE TABLE `articoli` (',
    '  `id` int NOT NULL,',
    '  `fornitore_id` int DEFAULT NULL,',
    '  PRIMARY KEY (`id`),',
    '  KEY `fk_a_f` (`fornitore_id`),',
    '  CONSTRAINT `fk_a_f` FOREIGN KEY (`fornitore_id`) REFERENCES `zfornitori` (`id`) ON DELETE CASCADE',
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  ].join('\n');

  const r = splitMySqlForeignKeys(create, 'articoli');
  assert.ok(!/FOREIGN KEY/i.test(r.ddl), `la FK deve uscire dalla CREATE TABLE:\n${r.ddl}`);
  assert.strictEqual(r.foreignKeys.length, 1);
  assert.ok(/ALTER TABLE `articoli` ADD CONSTRAINT `fk_a_f` FOREIGN KEY/.test(r.foreignKeys[0]), r.foreignKeys[0]);
  assert.ok(/ON DELETE CASCADE/.test(r.foreignKeys[0]),
    `l'azione referenziale non va persa:\n${r.foreignKeys[0]}`);

  // La FK era l'ULTIMA voce dell'elenco: la riga precedente resta con una
  // virgola sospesa e `CREATE TABLE (... ,\n) ENGINE=...` non è sintassi valida.
  assert.ok(!/,\s*\n\s*\)/.test(r.ddl), `virgola sospesa prima della parentesi:\n${r.ddl}`);
  assert.ok(/KEY `fk_a_f` \(`fornitore_id`\)\n/.test(r.ddl),
    `l'indice che accompagna la FK resta nella tabella:\n${r.ddl}`);
  assert.ok(/\) ENGINE=InnoDB/.test(r.ddl), `la coda della CREATE TABLE resta intatta:\n${r.ddl}`);

  // Una CREATE TABLE in cui la FK e scritta in una forma che la regex non
  // riconosce: serve a provare che il conteggio la intercetti.
  const senzaFkMaDichiarata = 'CREATE TABLE `x` (\n  `id` int NOT NULL\n) ENGINE=InnoDB';

  // Una tabella senza FK non deve essere toccata affatto.
  const senza = 'CREATE TABLE `x` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB';
  const r2 = splitMySqlForeignKeys(senza, 'x');
  assert.strictEqual(r2.ddl, senza, 'una tabella senza FK deve restare identica');
  assert.strictEqual(r2.foreignKeys.length, 0);

  // Il CONTO viene dal catalogo, non dal testo: se la regex smettesse di
  // corrispondere — per un cambio di formato di MySQL o una clausola non
  // prevista — si produrrebbe uno schema PRIVO di vincoli senza dirlo a
  // nessuno. Con il confronto, il backup si ferma.
  assert.doesNotThrow(() => splitMySqlForeignKeys(create, 'articoli', 1),
    'il conteggio coincide: deve passare');
  assert.throws(() => splitMySqlForeignKeys(create, 'articoli', 2), /catalogo ne dichiara 2/,
    'se il catalogo dichiara più FK di quante il testo ne mostri, il backup deve fermarsi');
  assert.throws(() => splitMySqlForeignKeys(senzaFkMaDichiarata, 'x', 1), /catalogo ne dichiara 1/,
    'una FK che la regex non riconosce non deve sparire in silenzio');

  console.log('  OK   Chiavi esterne estratte dalla CREATE TABLE, con conto verificato sul catalogo (CDB-A85)');
}

// --- 2. Riqualificazione del database in una DDL ---------------------------
{
  const view = 'CREATE VIEW `v` AS select `a`.`id` from (`vecchio`.`articoli` `a` '
    + 'join `vecchio`.`zfornitori` `f` on((`f`.`id` = `a`.`fornitore_id`)))';
  const out = riqualificaDdl(view, 'vecchio', 'nuovo');
  assert.ok(!/`vecchio`\s*\./.test(out), `nessun riferimento al database di origine:\n${out}`);
  assert.strictEqual((out.match(/`nuovo`\./g) || []).length, 2, `entrambi i riferimenti riscritti:\n${out}`);

  // Non deve toccare un'occorrenza che NON è una qualificazione di database:
  // una colonna o un valore che si chiama come il database resterebbe corrotto.
  const insidioso = 'CREATE VIEW `v` AS select `vecchio` from `vecchio`.`t`';
  const out2 = riqualificaDdl(insidioso, 'vecchio', 'nuovo');
  assert.ok(/select `vecchio` from `nuovo`\.`t`/.test(out2),
    `solo la qualificazione va riscritta, non una colonna omonima:\n${out2}`);

  // Stesso nome: nessuna riscrittura (ripristino nello stesso database).
  assert.strictEqual(riqualificaDdl(view, 'vecchio', 'vecchio'), view);

  // Se il database di origine resta nominato in una forma che la riscrittura
  // non copre, proseguire creerebbe un oggetto che legge le tabelle
  // ORIGINALI: il ripristino "riesce" e punta altrove. Deve fermarsi.
  const nonRiscrivibile = 'CREATE VIEW `v` AS select * from vecchio.articoli';
  assert.throws(() => riqualificaDdl(nonRiscrivibile, 'vecchio', 'nuovo'),
    /non riscrivibile/,
    'una qualificazione non fra backtick non deve passare in silenzio');

  const pg = 'CREATE TABLE "vecchio"."articoli" ("id" integer); '
    + 'CREATE VIEW "vecchio"."vista" AS SELECT * FROM "vecchio"."articoli"';
  const pgOut = riqualificaDdl(pg, 'vecchio', 'nuovo');
  assert(!pgOut.includes('"vecchio".'), 'anche le DDL PostgreSQL qualificate vengono retargettizzate');
  assert.strictEqual((pgOut.match(/"nuovo"\./g) || []).length, 3);

  console.log('  OK   DDL riqualificate, e fallimento dichiarato se non è possibile (CDB-A85)');
}

// --- 3. Rimozione del DEFINER ----------------------------------------------
{
  const casi = [
    "CREATE DEFINER=`root`@`localhost` PROCEDURE `p`() SELECT 1",
    "CREATE ALGORITHM=UNDEFINED DEFINER=`app`@`%` SQL SECURITY DEFINER VIEW `v` AS SELECT 1",
    "CREATE DEFINER=`u`@`h` TRIGGER `t` BEFORE INSERT ON `x` FOR EACH ROW SET NEW.a = 1",
  ];
  for (const c of casi) {
    const out = senzaDefiner(c);
    assert.ok(!/DEFINER\s*=/.test(out), `DEFINER non rimosso:\n${out}`);
    assert.ok(/^CREATE /.test(out), `la DDL deve restare eseguibile:\n${out}`);
  }
  // `SQL SECURITY DEFINER` non è una clausola DEFINER=: non va toccata.
  assert.ok(/SQL SECURITY DEFINER/.test(senzaDefiner(casi[1])),
    'SQL SECURITY DEFINER non va confuso con la clausola DEFINER=');

  console.log('  OK   Clausola DEFINER rimossa senza rompere la DDL (CDB-A85)');
}

// --- 4. Il file degli oggetti arriva dal disco: si valida ------------------
{
  const { restoreSchemaObjects } = require('../backup/lib/restore');
  const ammesse = {
    foreignKeys: ['ALTER TABLE `a` ADD CONSTRAINT `f` FOREIGN KEY (`x`) REFERENCES `b` (`id`)'],
    views: [
      { name: 'v', ddl: 'CREATE ALGORITHM=UNDEFINED DEFINER=`r`@`l` SQL SECURITY DEFINER VIEW `v` AS SELECT 1' },
      { name: 'v2', ddl: 'CREATE VIEW `v2` AS SELECT 1' },
    ],
    routines: [
      { name: 'p', ddl: 'CREATE DEFINER=`r`@`l` PROCEDURE `p`() SELECT 1' },
      { name: 'f', ddl: 'CREATE FUNCTION `f`(x INT) RETURNS INT DETERMINISTIC RETURN x' },
    ],
    triggers: [{ name: 't', table: 'x', ddl: 'CREATE TRIGGER `t` BEFORE INSERT ON `x` FOR EACH ROW SET NEW.a = 1' }],
    events: [{ name: 'e', ddl: 'CREATE EVENT `e` ON SCHEDULE EVERY 1 DAY DO SELECT 1' }],
  };
  const negate = [
    'DROP DATABASE `altro`',
    'GRANT ALL PRIVILEGES ON *.* TO `chiunque`@`%`',
    'CREATE USER `x`@`%` IDENTIFIED BY "p"',
    'SELECT * INTO OUTFILE "/etc/passwd" FROM t',
    'ALTER TABLE `a` DROP COLUMN `b`',
    '',
  ];

  // `restoreSchemaObjects` è il solo punto d'ingresso: si prova attraverso di
  // esso, con una strategia finta, invece di esporre la regex.
  const provaOggetti = async (oggetti, { allowUnsafeSchema = false } = {}) => {
    const eseguite = [];
    const problems = [];
    const strategy = { collectionAggregate: async (_db, _c, p) => { eseguite.push(p.pipeline); } };
    try {
      await restoreSchemaObjects({
        strategy, targetDb: 'dst', dbType: 'mysql', dbOrigine: 'src',
        oggetti, problems, log: null, allowUnsafeSchema,
      });
      return { eseguite, problems, error: null };
    } catch (error) {
      return { eseguite, problems, error };
    }
  };

  return (async () => {
    const ok = await provaOggetti(ammesse);
    assert.ifError(ok.error);
    assert.strictEqual(ok.problems.length, 0, ok.problems.join('; '));
    assert.strictEqual(ok.eseguite.length, 7, 'tutti gli oggetti legittimi devono essere eseguiti');
    for (const sql of negate) {
      const { eseguite, error } = await provaOggetti({ routines: [{ name: 'x', ddl: sql }] });
      assert.strictEqual(eseguite.length, 0, `NON doveva essere eseguita: ${sql}`);
      assert.ok(error, `doveva essere rifiutata: ${sql}`);
    }
    const bypass = await provaOggetti(
      { routines: [{ name: 'x', ddl: 'DROP DATABASE `altro`' }] },
      { allowUnsafeSchema: true }
    );
    assert.ifError(bypass.error);
    assert.strictEqual(bypass.eseguite.length, 1,
      'il bypass esplicito deve raggiungere anche la validazione tardiva degli oggetti');
    console.log('  OK   DDL degli oggetti validate prima di eseguirle (CDB-A80, CDB-A85)');
    console.log('\nTutti i test degli oggetti di schema superati!');
  })().catch((err) => {
    console.error('\nTest degli oggetti di schema FALLITO:\n', err);
    process.exitCode = 1;
    throw err;
  });
}
