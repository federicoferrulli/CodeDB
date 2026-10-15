'use strict';
const assert = require('node:assert/strict');
if (process.argv.includes('--mutant')) require('node:module').registerHooks({ load(url, context, next) {
  const r = next(url, context);
  return url.endsWith('/sql-mongo-funzioni.mjs') ? { ...r, source: String(r.source).replace("UPPER: ['$toUpper'", "UPPER: ['$toLower'") } : r;
} });
const { translate, translateWrite } = require('../db/SqlToMql');

let falliti = 0;
function prova(nome, fn) {
  try { fn(); console.log(`  OK   ${nome}`); }
  catch (e) { falliti++; console.error(`  FAIL ${nome}: ${e.message}`); }
}
prova('Funzioni scalari annidate e aritmetica nella SELECT', () => {
  const p = translate('SELECT UPPER(TRIM(nome)) AS nome, prezzo * quantita AS totale FROM prodotti');
  assert.equal(p.kind, 'aggregate');
  assert(JSON.stringify(p.pipeline).includes('$toUpper'));
  assert(JSON.stringify(p.pipeline).includes('$multiply'));
});
prova('WITH riusa la query della CTE senza interrogare una collezione inesistente', () => {
  const p = translate('WITH attivi AS (SELECT nome FROM utenti WHERE attivo = TRUE) SELECT nome FROM attivi');
  assert.equal(p.coll, 'utenti');
  assert(p.pipeline.some(s => s.$match?.attivo === true));
});
prova('CROSS JOIN costruisce il prodotto cartesiano', () => {
  const p = translate('SELECT a.nome, b.codice FROM utenti a CROSS JOIN ruoli b');
  assert.deepEqual(p.pipeline[0], { $lookup: { from: 'ruoli', pipeline: [], as: 'b' } });
  assert.deepEqual(p.pipeline[1], { $unwind: '$b' });
});
prova('DISTINCT * deduplica prima del LIMIT', () => {
  const p = translate('SELECT DISTINCT * FROM utenti LIMIT 2');
  assert.deepEqual(p.pipeline.slice(0, 2), [{ $group: { _id: '$$ROOT' } }, { $replaceRoot: { newRoot: '$_id' } }]);
  assert.deepEqual(p.pipeline.at(-1), { $limit: 2 });
});
prova('Le scritture non ignorano una clausola finale', () => {
    assert.throws(() => translateWrite('DELETE FROM utenti WHERE attivo = FALSE LIMIT 1 CLAUSOLA_IGNOTA'), /LIMIT|fine|clausola/i);
  assert.throws(() => translateWrite('UPDATE utenti SET nome = 1 RETURNING nome CLAUSOLA_IGNOTA altro'), /fine|clausola/i);
});
prova('Predicati scalari, parentesi e NULL usano lo stesso interprete', () => {
  for (const where of ['(prezzo + 2) > quantita', "UPPER(nome) = 'ADA'", 'prezzo NOT IN (quantita, NULL)', 'prezzo BETWEEN quantita AND 99']) {
    assert(translate(`SELECT * FROM prodotti WHERE ${where}`).filter.$expr, where);
  }
  assert(translate('SELECT CASE WHEN nome IS NULL THEN 0 ELSE 1 END AS n FROM prodotti').pipeline);
});
prova('JOIN su CTE e derived table mantengono la pipeline della sorgente', () => {
  for (const sql of [
    'WITH r AS (SELECT id FROM ruoli WHERE attivo = TRUE) SELECT u.id FROM utenti u JOIN r ON u.ruolo = r.id',
    'SELECT u.id FROM utenti u JOIN (SELECT id FROM ruoli WHERE attivo = TRUE) r ON u.ruolo = r.id',
  ]) {
    const lookup = translate(sql).pipeline.find(s => s.$lookup).$lookup;
    assert.equal(lookup.from, 'ruoli');
    assert(lookup.pipeline.some(s => s.$match?.attivo === true));
  }
});
prova('DDL indici con nome, ordine composto e unicità', () => {
  assert.deepEqual(translateWrite('CREATE UNIQUE INDEX idx ON utenti (nome ASC, eta DESC)'), {
    kind: 'ddl', op: 'createIndex', coll: 'utenti', keys: { nome: 1, eta: -1 }, options: { name: 'idx', unique: true },
  });
  assert.equal(translateWrite('DROP INDEX idx ON utenti').op, 'dropIndex');
});
prova('UPDATE calcolato usa una pipeline, le stringhe dollar restano letterali', () => {
  const update = translateWrite("UPDATE prodotti SET prezzo = prezzo + 1, nome = '$valore' WHERE id = 1").update;
  assert(Array.isArray(update));
  assert.deepEqual(update[0].$set.nome, { $literal: '$valore' });
});
prova('Stringhe e identificatori incompleti non diventano scritture', () => {
  assert.throws(() => translateWrite("UPDATE t SET a = 'non chiusa"), /non chiusa/);
  assert.throws(() => translateWrite('DELETE FROM `non chiuso'), /non chiuso/);
  assert.equal(translate('SELECT `a``b` FROM t').projection['a`b'], 1);
});
if (falliti) process.exitCode = 1;
