'use strict';

const assert = require('assert');
const {
  canonicalSql, canonicalSqlForDb, canonicalSchemaInventory, canonicalMongoIndex, inventoryDifferences,
} = require('../db/schemaObjects');

module.exports = (() => {
  assert.strictEqual(
    canonicalSql("CREATE VIEW v AS SELECT  'a  b'  AS x;"),
    "CREATE VIEW v AS SELECT 'a  b' AS x",
    'la normalizzazione non modifica gli spazi dentro le stringhe',
  );
  const expected = canonicalSchemaInventory({
    views: [{ name: 'v', ddl: 'CREATE VIEW v AS SELECT 1 AS n' }],
    sequenceValues: [{ name: 'seq', sql: "SELECT setval('seq', 41, true)" }],
  });
  const same = canonicalSchemaInventory({
    views: [{ ddl: 'CREATE  VIEW v AS SELECT 1 AS n;', name: 'v' }],
    sequenceValues: [{ sql: "SELECT setval('seq', 41, true);", name: 'seq' }],
  });
  assert.deepStrictEqual(inventoryDifferences(expected, same), []);

  const changedView = canonicalSchemaInventory({
    views: [{ name: 'v', ddl: 'CREATE VIEW v AS SELECT 2 AS n' }],
    sequenceValues: [{ name: 'seq', sql: "SELECT setval('seq', 41, true)" }],
  });
  assert(inventoryDifferences(expected, changedView).length,
    'una view presente ma con definizione diversa deve fallire la verifica');

  const changedSequence = canonicalSchemaInventory({
    views: [{ name: 'v', ddl: 'CREATE VIEW v AS SELECT 1 AS n' }],
    sequenceValues: [{ name: 'seq', sql: "SELECT setval('seq', 40, true)" }],
  });
  assert(inventoryDifferences(expected, changedSequence).length,
    'il valore corrente di una sequenza fa parte dell\'integrita dello schema');

  /* --- La qualificazione del database non e' semantica ---------------------
   * MySQL qualifica una view con `SHOW CREATE VIEW` soltanto quando NON e' il
   * database corrente della connessione: la stessa view tornava percio' in due
   * forme, e l'import la dichiarava mancante sul proprio staging.
   * ---------------------------------------------------------------------- */
  const db = 'staging_x';
  const qualificataMysql = 'CREATE VIEW `staging_x`.`v` AS select `staging_x`.`t`.`id` AS `id` from `staging_x`.`t`';
  const nuda = 'CREATE VIEW `v` AS select `t`.`id` AS `id` from `t`';
  assert.strictEqual(
    canonicalSqlForDb(qualificataMysql, db), canonicalSqlForDb(nuda, db),
    'con gli apici inversi la qualificazione del database non deve contare',
  );
  assert.strictEqual(
    canonicalSqlForDb('CREATE VIEW "staging_x"."v" AS select 1', db),
    canonicalSqlForDb('CREATE VIEW "v" AS select 1', db),
    'e nemmeno con le virgolette doppie di PostgreSQL',
  );
  assert.strictEqual(
    canonicalSqlForDb('CREATE VIEW staging_x.v AS select 1', db),
    canonicalSqlForDb('CREATE VIEW v AS select 1', db),
    'e nemmeno senza quotatura',
  );
  // Un altro database resta un altro database: togliere la qualificazione
  // sbagliata renderebbe uguali due oggetti che non lo sono.
  assert.notStrictEqual(
    canonicalSqlForDb('CREATE VIEW `altro`.`v` AS select 1', db),
    canonicalSqlForDb('CREATE VIEW `v` AS select 1', db),
    'solo il database atteso viene tolto, non uno qualsiasi',
  );
  console.log('  OK   Qualificazione del database tolta in tutte e tre le quotature');

  /* --- La forma canonica di un indice MongoDB ------------------------------
   * Il server omette le opzioni al valore predefinito; l'artefatto esportato le
   * scriveva come `unique: false`. Confrontando la PRESENZA del campo, ogni
   * indice non univoco risultava divergente.
   * ---------------------------------------------------------------------- */
  assert.strictEqual(
    canonicalMongoIndex({ name: 'i', key: { a: 1 }, unique: false }),
    canonicalMongoIndex({ name: 'i', key: { a: 1 } }),
    "`unique: false` e l'assenza del campo sono lo stesso indice",
  );
  assert.strictEqual(
    canonicalMongoIndex({ name: 'i', key: { a: 1 }, sparse: false }),
    canonicalMongoIndex({ name: 'i', key: { a: 1 } }),
    'lo stesso vale per `sparse`',
  );
  assert.notStrictEqual(
    canonicalMongoIndex({ name: 'i', key: { a: 1 }, unique: true }),
    canonicalMongoIndex({ name: 'i', key: { a: 1 } }),
    'ma univoco e non univoco restano due indici diversi',
  );
  // Le opzioni con un VALORE contano: un TTL perso e' una scadenza che non
  // scade piu', non un dettaglio di presentazione.
  assert.notStrictEqual(
    canonicalMongoIndex({ name: 'ttl', key: { a: 1 }, expireAfterSeconds: 3600 }),
    canonicalMongoIndex({ name: 'ttl', key: { a: 1 } }),
    'un indice TTL non e uguale allo stesso indice senza scadenza',
  );
  assert.notStrictEqual(
    canonicalMongoIndex({ name: 'p', key: { a: 1 }, partialFilterExpression: { b: { $gt: 1 } } }),
    canonicalMongoIndex({ name: 'p', key: { a: 1 } }),
    'un indice parziale non e uguale a un indice completo',
  );
  // L'ordine delle chiavi non e' semantica: i due lati non lo scrivono uguale.
  assert.strictEqual(
    canonicalMongoIndex({ key: { a: 1 }, name: 'i', unique: true }),
    canonicalMongoIndex({ unique: true, name: 'i', key: { a: 1 } }),
    "l'ordine dei campi del descrittore non conta",
  );
  // Il formato interno non e' l'indice: `v` e `ns` non devono farlo divergere.
  assert.strictEqual(
    canonicalMongoIndex({ name: 'i', key: { a: 1 }, v: 2, ns: 'db.coll' }),
    canonicalMongoIndex({ name: 'i', key: { a: 1 } }),
    "il formato interno e il namespace non fanno parte dell'indice",
  );
  console.log('  OK   Indice MongoDB canonico: predefiniti omessi, opzioni con valore conservate');

  console.log('  OK   Inventario canonico oggetti: definizioni e sequenze passed');
})();
