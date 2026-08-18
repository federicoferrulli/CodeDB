'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari della scelta della collation di connessione (MySqlStrategy) e
 * della sua spiegazione parlante (db/errors.js).
 *
 * Perché esistono: mysql2, se `charset` non è indicato, impone una collation
 * COMPILATA NEL DRIVER (utf8mb4_unicode_ci) che nessuno ha scelto. Tutto ciò
 * che eredita `collation_connection` — `@variabili`, `CAST(… AS CHAR)`,
 * `DATE_FORMAT()` — ha coercibilità IMPLICIT come una colonna, quindi
 * confrontarlo con una colonna di collation diversa dà l'errore 1267. La
 * regola qui provata è quella che decide a COSA allinearsi, e il caso che
 * conta è il ripiego: adottare una collation non-utf8mb4 (su un server vecchio
 * `collation_server` è latin1_swedish_ci) porterebbe
 * `character_set_connection` fuori da utf8mb4 mentre il client continua a
 * scrivere utf8mb4 — cioè caratteri persi in silenzio, che è molto peggio di
 * un errore.
 *
 * L'allineamento vero (che il server accetti gli SET, che l'errore sparisca)
 * è provato contro un MySQL reale da test/e2e-collazione-mysql.js: qui non
 * c'è database.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const MySqlStrategy = require('../db/MySqlStrategy');
const { spiegaErrore } = require('../db/errors');

const { scegliCollazione } = MySqlStrategy;

console.log('--- Test Unitari: collation di connessione ---');

// 1. Ordine di specificità: il database batte il server, il server batte la
//    predefinita di utf8mb4. È l'ordine che riduce di più i confronti misti:
//    le colonne ereditano dal database, non dal server.
assert.strictEqual(
  scegliCollazione({ database: 'utf8mb4_general_ci', server: 'utf8mb4_0900_ai_ci', utf8mb4: 'utf8mb4_0900_ai_ci' }),
  'utf8mb4_general_ci'
);
assert.strictEqual(
  scegliCollazione({ database: null, server: 'utf8mb4_0900_ai_ci', utf8mb4: 'utf8mb4_general_ci' }),
  'utf8mb4_0900_ai_ci'
);
console.log('  OK   Ordine di specificità: database → server → predefinita utf8mb4');

// 2. Il ripiego SALTA le candidate non-utf8mb4 invece di fermarsi su di esse.
//    Questo è il caso del server 5.7 tipico: database e server sono latin1, ma
//    la connessione deve restare utf8mb4.
assert.strictEqual(
  scegliCollazione({ database: 'latin1_swedish_ci', server: 'latin1_swedish_ci', utf8mb4: 'utf8mb4_general_ci' }),
  'utf8mb4_general_ci'
);
assert.strictEqual(
  scegliCollazione({ database: 'utf8_general_ci', server: 'utf8mb3_general_ci', utf8mb4: 'utf8mb4_0900_ai_ci' }),
  'utf8mb4_0900_ai_ci'
);
console.log('  OK   Le collation di altri charset vengono scartate, non adottate');

// 3. Nessuna candidata utilizzabile ⇒ null, cioè "non toccare niente": si resta
//    al default del driver. Meglio il comportamento di prima che una SET a
//    caso su un server che non sappiamo leggere.
assert.strictEqual(scegliCollazione({ database: 'latin1_swedish_ci', server: 'latin1_swedish_ci', utf8mb4: null }), null);
assert.strictEqual(scegliCollazione({}), null);
assert.strictEqual(scegliCollazione(), null);
console.log('  OK   Senza candidate utf8mb4 non si tocca la connessione');

// 4. Il nome finisce dentro uno `SET`: quello che non ha forma di
//    identificatore non passa, anche se arriva dal server.
assert.strictEqual(scegliCollazione({ database: "utf8mb4_x'; DROP DATABASE a; --", utf8mb4: 'utf8mb4_general_ci' }), 'utf8mb4_general_ci');
assert.strictEqual(scegliCollazione({ database: 'utf8mb4 general ci', utf8mb4: 'utf8mb4_general_ci' }), 'utf8mb4_general_ci');
console.log('  OK   Nomi non conformi scartati prima di comporre lo SET');

// 5. L'errore 1267 diventa italiano e dice cosa fare. Il messaggio ORIGINALE
//    resta in coda: senza, una segnalazione non è diagnosticabile (è la
//    coercibilità fra parentesi a dire se il problema è nello schema o nella
//    connessione).
{
  const grezzo = "Illegal mix of collations (utf8mb4_general_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='";
  const err = new Error(grezzo);
  err.code = 'ER_CANT_AGGREGATE_2COLLATIONS';
  const spiegato = spiegaErrore(err);
  assert.ok(/collation/i.test(spiegato), 'deve nominare la collation');
  assert.ok(spiegato.includes('Cosa fare:'), 'deve dire cosa fare');
  assert.ok(/COLLATE/.test(spiegato), 'deve suggerire COLLATE');
  assert.ok(spiegato.includes(grezzo), 'deve conservare il messaggio originale');
  // Idempotenza: spiegaErrore viene applicata anche a messaggi già passati di qui.
  assert.strictEqual(spiegaErrore(new Error(spiegato)), spiegato);
  // Anche senza `code` (driver che non lo propaga) il testo basta a riconoscerlo.
  assert.ok(spiegaErrore(new Error(grezzo)).includes('Cosa fare:'));
}
console.log('  OK   Errore 1267 spiegato in italiano, originale conservato');

console.log('Tutti i test unitari sulla collation superati!');
