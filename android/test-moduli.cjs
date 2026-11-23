'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, 'build/node-project');

function verificaPontiStatici(projectRoot) {
  const dirs = ['auth', 'backup', 'db', 'mcp', 'server'];
  const walk = dir => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.isFile() && /\.(?:c?js)$/.test(entry.name)) out.push(full);
    }
    return out;
  };
  for (const d of dirs) {
    const base = path.join(projectRoot, d);
    if (!fs.existsSync(base)) continue;
    for (const file of walk(base)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/require\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
        const spec = match[2];
        if (!spec.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), spec);
        if (spec.endsWith('.mjs') || resolved.includes(`${path.sep}public${path.sep}`)) {
          // Deve risultare risolvibile sincronamente in Node 18 dopo il precaricamento.
          require(resolved);
        }
      }
      for (const match of source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
        const spec = match[2];
        assert(!spec.endsWith('.js'), `${path.relative(projectRoot, file)}: import() dinamico verso .js (${spec}) non supportato su Node 18 senza .mjs`);
      }
    }
  }
}

(async () => {
  assert.equal(Number(process.versions.node.split('.')[0]), 18, 'Esegui questa prova con Node 18, come il runtime mobile.');
  const { precaricaModuliCondivisi, MODULI_CONDIVISI } = require(path.join(root, 'mobile.cjs'));
  await precaricaModuliCondivisi();
  assert.equal(require(path.join(root, 'db/SqlToMql')).translate('SELECT SUM(prezzo) FROM prodotti').kind, 'aggregate');
  assert.equal(require(path.join(root, 'db/sqlText')).splitStatements('SELECT 1; SELECT 2;').length, 2);
  assert.ok(require(path.join(root, 'server/createServer')).createServer, 'Il server completo deve caricarsi su Node 18');
  assert.deepEqual(
    require(path.join(root, 'db/queryError')).intervalloErroreQuery(
      Object.assign(new Error('relation "x" does not exist'), { code: '42P01', position: '15' }),
      'SELECT * FROM x',
      'postgresql'
    ),
    { start: 14, end: 15 }
  );
  const { buildGraphData } = require(path.join(root, 'mcp/risorse-e-prompt'));
  const graph = await buildGraphData({ collections: [{ name: 'users', fields: [] }, { name: 'orders', fields: [{ name: 'userId' }] }], relations: [] }, true);
  assert.equal(graph.nodes.length, 2);
  for (const mod of ['public/js/riepilogo-uri.mjs', 'public/js/insert-json.mjs', 'public/js/schema-analisi.mjs']) {
    await import(pathToFileURL(path.join(root, mod)).href);
  }
  verificaPontiStatici(root);
  for (const name of MODULI_CONDIVISI) {
    const file = path.join(root, `public/js/${name}.mjs`), cached = require.cache[file];
    assert(cached, `Ponte non precaricato: ${name}`);
    delete require.cache[file];
    try { assert.throws(() => require(file), { code: 'ERR_REQUIRE_ESM' }); }
    finally { require.cache[file] = cached; }
    assert(require(file));
  }
  console.log('OK Node 18: traduzione SQL, splitter, createServer, queryError, MCP, ponti statici e controprova per ogni ponte ESM.');
})().catch(e => { console.error(e); process.exitCode = 1; });
