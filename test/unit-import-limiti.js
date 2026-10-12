'use strict';

const assert = require('assert');
const MySql = require('../db/MySqlStrategy');
const Pg = require('../db/PostgreSqlStrategy');

module.exports = (async () => {
  for (const Strategy of [MySql, Pg]) {
    const st = new Strategy();
    const writes = [];
    let columns = [{ name: 'id' }, { name: 'calcolata', generated: true }];
    st.tableColumnsInfo = async () => ({ columns, geo: new Map() });
    st.pool = { query: async (sql, params = []) => {
      if (process.argv.includes('--mutant-colonne')) sql = sql.replace(/["`]sconosciuta["`]/g, 'id');
      if (sql.includes('sconosciuta')) throw new Error('Colonna sconosciuta');
      writes.push({ sql, params });
      return Strategy === MySql ? [{ affectedRows: 1 }] : { rows: [], rowCount: 1 };
    } };
    if (Strategy === MySql) require('./mysql-session-fixture')(st.pool);
    const invalid = await st.collectionImport('db', 't', { docs: [{ id: 1, sconosciuta: 'da non perdere' }] });
    assert.strictEqual(invalid.inserted, 0, 'le colonne inattese non spariscono silenziosamente');
    assert.strictEqual(invalid.failed, 1);
    assert.strictEqual(writes.length, 0);
    const valid = await st.collectionImport('db', 't', { docs: [{ id: 1, calcolata: 2 }] });
    assert.strictEqual(valid.inserted, 1);
    assert(!writes.at(-1).sql.includes('calcolata'));

    writes.length = 0;
    columns = Array.from({ length: 400 }, (_, i) => ({ name: 'c' + i }));
    const row = Object.fromEntries(columns.map(c => [c.name, 'dati 🦊 '.repeat(60)]));
    const result = await st.collectionImport('db', 't', { docs: Array.from({ length: 200 }, () => row) });
    assert.strictEqual(result.inserted, 200);
    assert(writes.length > 1 && writes.length < 200, 'batch limitati, non una query per riga');
    for (const write of writes) {
      assert(write.params.length <= 60000);
      assert(Buffer.byteLength(JSON.stringify(write.params), 'utf8') <= 1024 * 1024);
    }
  }
  console.log('  OK   Import: colonne inattese segnalate, generate escluse, batch limitati in byte e parametri');
})().catch(err => { console.error(err); process.exitCode = 1; });
