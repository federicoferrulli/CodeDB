'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, 'build/node-project');
(async () => {
  assert.equal(Number(process.versions.node.split('.')[0]), 18, 'Esegui questa prova con Node 18, come il runtime mobile.');
  await require(path.join(root, 'mobile.cjs')).precaricaModuliCondivisi();
  assert.equal(require(path.join(root, 'db/SqlToMql')).translate('SELECT SUM(prezzo) FROM prodotti').kind, 'aggregate');
  assert.equal(require(path.join(root, 'db/sqlText')).splitStatements('SELECT 1; SELECT 2;').length, 2);
  for (const name of ['identificatori', 'sql-mongo-funzioni', 'sql-blocchi']) {
    const file = path.join(root, `public/js/${name}.mjs`), cached = require.cache[file];
    assert(cached, `Ponte non precaricato: ${name}`);
    delete require.cache[file];
    try { assert.throws(() => require(file), { code: 'ERR_REQUIRE_ESM' }); }
    finally { require.cache[file] = cached; }
    assert(require(file));
  }
  console.log('OK Node 18: traduzione SQL, splitter e controprova per ogni ponte ESM.');
})().catch(e => { console.error(e); process.exitCode = 1; });
