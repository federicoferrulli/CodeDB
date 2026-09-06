'use strict';

const assert = require('assert');
const fs = require('fs');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const { deserializeClientObject, toSqlValue, parseClientValue } = require('../db/sqlValori');

module.exports = (async () => {
  // DEFAULT_GENERATED descrive un default, non una colonna calcolata.
  const mysql = new MySqlStrategy();
  mysql.pool = { query: async () => [[
    { name: 'creato', type: 'timestamp', ctype: 'timestamp', extra: 'DEFAULT_GENERATED', nullable: 'NO' },
    { name: 'totale', type: 'int', ctype: 'int', extra: 'STORED GENERATED', nullable: 'YES' },
    { name: 'virtuale', type: 'int', ctype: 'int', extra: 'VIRTUAL GENERATED', nullable: 'YES' },
  ], []] };
  assert.deepStrictEqual([...await mysql.colonneScrivibili('db', 'righe')], ['creato']);
  assert.deepStrictEqual((await mysql.tableFields('db', 'righe')).map(c => c.generated), [false, true, true]);
  console.log('  OK   default MySQL conservati fra le colonne scrivibili');
  for (const Strategy of [MySqlStrategy, PostgreSqlStrategy]) {
    const strategy = new Strategy();
    const query = [];
    strategy.tableColumnsInfo = async () => ({ columns: [{ name: 'id', type: 'bigint' }], geo: new Map(), geoNativo: new Map() });
    strategy.pool = { query: async (sql, params) => {
      query.push({ sql, params });
      return Strategy === MySqlStrategy ? [{ affectedRows: 1 }, []] : { rows: [], rowCount: 1 };
    } };
    const result = await strategy.collectionImport('db', 'righe', {
      docs: [{ id: { $numberLong: '9007199254740993' } }],
    });
    assert.strictEqual(result.inserted, 1);
    assert.strictEqual(query.find(q => /^INSERT/.test(q.sql)).params[0], '9007199254740993', Strategy.name);
  }
  console.log('  OK   import BIGINT preserva tutte le cifre sui due motori');
  const json = { normale: 2147483648, annidato: [{ numero: { $numberLong: '9007199254740993' } }] };
  assert.deepStrictEqual(JSON.parse(toSqlValue(deserializeClientObject(json))), json,
    'un Long annidato nel JSON conserva EJSON senza esporre low/high del BSON');
  for (const Strategy of [MySqlStrategy, PostgreSqlStrategy]) {
    const strategy = new Strategy();
    const query = [];
    strategy.primaryKey = async () => ['id'];
    strategy.tableColumnsInfo = async () => ({ columns: [
      { name: 'id', type: 'integer' }, { name: 'valore', type: 'bigint' },
      { name: 'totale', type: 'integer', generated: true },
    ], geo: new Map(), geoNativo: new Map() });
    strategy.pool = { query: async (sql, params) => {
      query.push({ sql, params });
      return Strategy === MySqlStrategy ? [{ affectedRows: 1 }, []] : { rows: [], rowCount: 1 };
    } };
    await strategy.docReplace('db', 'righe', { id: '{"id":1}', doc: JSON.stringify({
      id: 1, valore: { $numberLong: '9007199254740993' }, totale: 2,
    }) });
    const update = query.find(q => /^UPDATE/.test(q.sql));
    assert.ok(!update.sql.includes('totale'), `${Strategy.name}: la colonna calcolata non va aggiornata`);
    assert.ok(update.params.includes('9007199254740993'), 'modificare un altro campo non deve arrotondare il BIGINT');
  }
  console.log('  OK   modifica intera riga con colonne calcolate e BIGINT');
  for (const Strategy of [MySqlStrategy, PostgreSqlStrategy]) {
    for (const [pk, identita] of [
      [['pk'], { pk: 7 }], [['_id'], { _id: 'dato reale' }],
      [['pk', '_id'], { pk: 7, _id: 'dato reale' }], [[], { pk: 7, _id: 'dato reale' }],
    ]) {
    const strategy = new Strategy({ env: { CODEDB_QUERY_TIMEOUT_MS: '0' } });
    strategy.primaryKey = async () => pk;
    strategy.tableColumnsInfo = async () => ({ columns: [
      { name: 'pk', type: 'integer' }, { name: '_id', type: 'text' },
    ], geo: new Map(), geoNativo: new Map() });
    const result = { rows: [{ pk: 7, _id: 'dato reale' }], fields: [{ name: 'pk' }, { name: '_id' }] };
    const calls = [];
    const connection = { query: async (sql, params) => {
      calls.push({ sql, params });
      return Strategy === MySqlStrategy ? [result.rows, result.fields] : result;
    }, release() {} };
    strategy.pool = { ...connection, connect: async () => connection, getConnection: async () => connection };
    const page = await strategy.collectionFind('db', 'righe', { deferCount: true });
    assert.strictEqual(page.docs[0]._id, 'dato reale', Strategy.name);
    assert.deepStrictEqual(page.rowIds, [identita], 'la chiave di scrittura viaggia fuori dalle colonne');
    const { preparaRighe, idOf, campoScrivibile, documentoModificabile } = await import('../public/js/righe.js');
    preparaRighe(page);
    assert.strictEqual(idOf(page.docs[0]), JSON.stringify(identita));
    assert.ok(campoScrivibile(page.docs[0], '_id'));
    assert.deepStrictEqual(documentoModificabile(page.docs[0]), { pk: 7, _id: 'dato reale' });
    await strategy.docUpdate('db', 'righe', { id: idOf(page.docs[0]), set: { _id: 'nuovo' } });
    const update = calls.find(c => /^UPDATE/.test(c.sql));
    assert.ok(update.sql.includes('_id'));
    assert.deepStrictEqual(update.params, ['nuovo', ...Object.values(identita)]);
    await strategy.docDelete('db', 'righe', { id: idOf(page.docs[0]) });
    assert.deepStrictEqual(calls.find(c => /^DELETE/.test(c.sql)).params, Object.values(identita));
    }
  }
  console.log('  OK   colonna _id reale distinta dalla chiave di scrittura');

  // --- Il BIGINT esatto lungo tutta la catena del backup -------------------
  // La perdita di precisione non comincia in EJSON: comincia nel driver, che
  // senza `supportBigNumbers` fa `Number(testo)` su un BIGINT di 14 cifre o
  // piu'. Il pool e' lo stesso che usano griglia, export e backup.
  const mysql2 = require('mysql2');
  const createPoolVero = mysql2.createPool;
  let configPool;
  mysql2.createPool = (cfg) => { configPool = cfg; throw new Error('stop'); };
  try { await new MySqlStrategy().connect({ host: 'x' }); } catch { /* atteso */ }
  finally { mysql2.createPool = createPoolVero; }
  assert.strictEqual(configPool.supportBigNumbers, true,
    'senza supportBigNumbers mysql2 arrotonda il BIGINT prima di qualunque giro EJSON');

  // La SCRITTURA del dump e' gia' coperta: db/MongoDbStrategy rattoppa
  // `Long.prototype.toExtendedJSON` (CDB-04) perche' un Long oltre i 53 bit
  // non attraversi Number in relaxed mode. Il valore ESATTO e' quindi nel
  // file; era la RILETTURA a distruggerlo, e li' il patch non arriva —
  // `EJSON.parse(riga, { relaxed: true })` rende 9007199254740992.
  require('../db/MongoDbStrategy');
  const { EJSON: EJSONb, Long } = require('bson');
  const riga = EJSONb.stringify({ n: Long.fromString('9007199254740993') }, { relaxed: true });
  assert.strictEqual(riga, '{"n":{"$numberLong":"9007199254740993"}}', 'il dump conserva il Long');
  assert.strictEqual(String(EJSONb.parse(riga, { relaxed: true }).n), '9007199254740992',
    'e questa e la lettura che il restore faceva');
  assert.strictEqual(toSqlValue(parseClientValue(riga).n), '9007199254740993',
    'la riga riletta dal restore arriva intera al parametro SQL');
  // Un backup gia' scritto resta ripristinabile: le forme relaxed si leggono
  // uguale, e un numero JSON ordinario resta un Number.
  assert.ok(parseClientValue('{"d":{"$date":"2020-01-01T00:00:00Z"}}').d instanceof Date);
  assert.strictEqual(parseClientValue('{"n":3}').n, 3);

  // Il restore non deve tenere una seconda copia della conversione, ne'
  // rileggere le righe dati in forma relaxed.
  const restore = fs.readFileSync(require.resolve('../backup/lib/restore.js'), 'utf8');
  assert.ok(!/function toSqlValue/.test(restore), 'restore.js non deve duplicare toSqlValue');
  assert.ok(!/EJSON\.parse\(line, \{ relaxed: true \}\)/.test(restore),
    'le righe dati del dump vanno lette in forma canonica');
  // Il ripiego di EXPLAIN aveva DUE return uno sopra l'altro: vinceva quello
  // che passava a serializeRow l'INDICE della riga al posto dei `fields`,
  // quindi il piano tornava senza la tipizzazione esatta delle colonne.
  const piano = new MySqlStrategy();
  const connPiano = {
    query: async (sql) => {
      if (/FORMAT=JSON/.test(sql)) throw new Error('non supportato');
      return [[{ rows_examined: '9007199254740993' }], [{ name: 'rows_examined', type: 'bigint' }]];
    },
    release() {},
  };
  piano.pool = { getConnection: async () => connPiano };
  piano.usaDatabase = async () => {};
  const esito = await piano.collectionExplain('db', 'righe', { mode: 'aggregate', pipeline: 'SELECT 1' });
  assert.strictEqual(esito.format, 'table');
  assert.deepStrictEqual(esito.rows[0], { rows_examined: { $numberLong: '9007199254740993' } },
    'il ripiego EXPLAIN deve ricevere i fields, non l indice della riga');
  console.log('  OK   BIGINT esatto dal driver al file di backup e ritorno');
})();
