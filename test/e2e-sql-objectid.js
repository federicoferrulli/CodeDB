'use strict';

const assert = require('node:assert/strict');
// Controprove in memoria: il file del motore sul disco resta intatto.
const mutant = process.argv.find(a => a.startsWith('--mutant='))?.slice(9);
let mutated = false;
if (mutant) require('node:module').registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/sqlObjectId.js')) return result;
  const from = { filtro: '? [valore, new ObjectId(valore)] : [valore]', espressione: 'return [adatta(a, b), adatta(b, a)];' }[mutant];
  assert.ok(from && String(result.source).includes(from), 'Mutazione ObjectId non applicata');
  mutated = true;
  return { ...result, source: String(result.source).replace(from, mutant === 'filtro' ? '? [valore] : [valore]' : 'return [a, b];') };
} });
const { MongoClient, ObjectId } = require('mongodb');
const { EJSON } = require('bson');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const { translate, planToPipeline } = require('../db/SqlToMql');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');

const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_sql_objectid' });
const db = targets.target('mongo');
const client = new MongoClient(`mongodb://127.0.0.1:${process.env.MONGO_PORT || 27017}`, { serverSelectionTimeoutMS: 4000 });
const strategy = new MongoDbStrategy({ env: {} });
strategy.client = client;
let connected = false, checks = 0, server, browser;
const ids = ['668bde07922aa72f6275dcf5', '672fd5550c70051e2bbcbf3c'];
const list = ids.map(id => JSON.stringify(id)).join(', ');
async function query(sql) {
  return EJSON.deserialize((await strategy.mongoSqlRead(db, 'geometries', { sql })).docs, { relaxed: true });
}
async function prova(sql, expected) {
  assert.deepEqual(await query(sql), expected, sql); checks++;
}

(async () => {
  targets.assertOwned(db);
  await client.connect(); connected = true;
  const collection = client.db(db).collection('geometries');
  await collection.insertMany(ids.map((id, i) => ({ _id: new ObjectId(id), n: i + 1, ref: new ObjectId(id), meta: { ref: new ObjectId(id) }, testo: id })));
  assert.equal(await collection.countDocuments({ _id: { $in: ids.map(id => new ObjectId(id)) } }), 2,
    'Controprova MQL: entrambi i documenti esistono con il tipo BSON corretto');
  const sql = `SELECT * FROM geometries WHERE _id IN (${list})`;
  const docs = await query(sql);
  assert.equal(docs.length, 2, 'La IN dello screenshot deve ritrovare i due ObjectId');
  assert.deepEqual(docs.map(doc => doc._id.toHexString()).sort(), ids.slice().sort());
  checks++;
  // La forma indicizzata deve leggere due sole chiavi, senza scansione.
  const explain = await collection.aggregate(planToPipeline(translate(sql))).explain('executionStats');
  const stats = explain.executionStats || explain.stages?.find(s => s.$cursor)?.$cursor.executionStats;
  assert.equal(stats.nReturned, 2); assert.equal(stats.totalDocsExamined, 2);
  assert.ok(stats.totalKeysExamined >= 2, 'La IN deve usare l’indice _id'); checks++;

  for (const field of ['_id', 'ref', 'meta.ref']) {
    for (const condition of [
      `${field} = '${ids[0]}'`, `'${ids[0]}' = ${field}`, `${field} IN ('${ids[0]}', NULL)`,
      `${field} IN ('${ids[0].toUpperCase()}')`, `${field} NOT IN ('${ids[1]}')`,
      `NOT (${field} = '${ids[1]}')`, `${field} != '${ids[1]}'`, `${field} <> '${ids[1]}'`,
      `${field} < '${ids[1]}'`, `${field} <= '${ids[0]}'`, `${field} BETWEEN '${ids[0]}' AND '${ids[0]}'`,
      `${field} IS NOT DISTINCT FROM '${ids[0]}'`,
      `${field} = ANY(ARRAY['${ids[0]}'])`, `${field} <> ALL(ARRAY['${ids[1]}'])`,
    ]) await prova(`SELECT n FROM geometries WHERE ${condition}`, [{ n: 1 }]);
    await prova(`SELECT n FROM geometries WHERE ${field} > '${ids[0]}'`, [{ n: 2 }]);
    await prova(`SELECT n FROM geometries WHERE ${field} >= '${ids[1]}'`, [{ n: 2 }]);
    await prova(`SELECT n FROM geometries WHERE ${field} NOT IN ('${ids[1]}', NULL)`, []);
    await prova(`SELECT n FROM geometries WHERE ${field} IN ('non-valido', '123')`, []);
    await prova(`SELECT n FROM geometries WHERE ${field} IN (${list}) AND n=2`, [{ n: 2 }]);
  }
  await prova(`SELECT n FROM geometries g WHERE g._id IN (${list}) ORDER BY n`, [{ n: 1 }, { n: 2 }]);
  await prova(`SELECT COUNT(*) AS totale FROM geometries WHERE _id IN (${list})`, [{ totale: 2 }]);
  await prova(`WITH scelti AS (SELECT _id AS id, n FROM geometries) SELECT n FROM scelti WHERE id IN (${list}) ORDER BY n`, [{ n: 1 }, { n: 2 }]);
  await prova(`SELECT g.n FROM geometries g JOIN geometries h ON g.n=h.n AND h._id='${ids[0]}'`, [{ n: 1 }]);
  await prova(`SELECT n, _id IN ('${ids[0]}', NULL) AS scelto, _id NOT IN ('${ids[0]}', NULL) AS escluso FROM geometries ORDER BY n`,
    [{ n: 1, scelto: true, escluso: false }, { n: 2, scelto: null, escluso: null }]);
  await prova(`SELECT CASE WHEN _id='${ids[0]}' THEN 10 ELSE 20 END AS n FROM geometries ORDER BY n`, [{ n: 10 }, { n: 20 }]);
  await prova(`SELECT _id BETWEEN '${ids[0]}' AND '${ids[0]}' AS scelto FROM geometries ORDER BY n`, [{ scelto: true }, { scelto: false }]);
  await prova(`SELECT '${ids[0]}' AS testo FROM geometries LIMIT 1`, [{ testo: ids[0] }]);
  await prova(`SELECT n FROM geometries g WHERE '${ids[0]}' IN (SELECT ref FROM geometries h WHERE h.n=g.n)`, [{ n: 1 }]);

  // Riproduzione dall'editor: browser, socket e database veri, senza mock.
  server = await startTestServer({ port: 3279 });
  browser = await require('playwright').chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
  await page.goto(server.url);
  await page.waitForSelector('html[data-arc-ready="true"]');
  await page.evaluate(async ({ db, port }) => {
    const { socket } = await import('/js/socket.js');
    const r = await new Promise(resolve => socket.emit('mongo:connect', { tabId: 'objectid', dbType: 'mongodb', host: '127.0.0.1', port }, resolve));
    if (!r.ok) throw new Error(r.error);
    const { tabs, createTab } = await import('/js/tabs.js');
    const tab = createTab({ id: 'objectid' }); tab.dbType = 'mongodb'; tab.label = 'ObjectId E2E';
    Object.assign(tab.state, { dbType: 'mongodb', connected: true, databases: r.databases, collTabs: [] });
    tabs.activeId = tab.id;
    (await import('/js/tabbar.js')).renderTabBar();
    (await import('/js/workspace.js')).renderWorkspace();
    (await import('/js/colltabs.js')).openDbTab(db);
  }, { db, port: Number(process.env.MONGO_PORT || 27017) });
  await page.locator('#query-editor-input').fill(sql);
  await page.locator('#query-run-btn').click();
  await page.waitForFunction(() => ['success', 'error'].includes(document.querySelector('#view-query')?.dataset.queryState));
  assert.equal(await page.locator('#view-query').getAttribute('data-query-state'), 'success');
  assert.equal(await page.locator('#query-count-val').textContent(), '2');
  const table = await page.locator('#query-result-table').textContent();
  for (const id of ids) assert.ok(table.includes(id), `ObjectId visibile nella griglia: ${id}`);
  assert.deepEqual(errors, []); checks++;
  await browser.close(); browser = null;
  await server.stop(); server = null;

  // Lo stesso testo può essere un _id stringa, un ObjectId o un normale campo.
  await collection.insertMany([
    { _id: ids[0], n: 3, ref: ids[0], testo: ids[0] },
    { _id: ids[0].toUpperCase(), n: 4, ref: ids[0].toUpperCase(), testo: ids[0].toUpperCase() },
    { _id: 42, n: 5, ref: null }, { _id: 'mancante', n: 6 },
  ]);
  for (const field of ['_id', 'ref']) {
    await prova(`SELECT n FROM geometries WHERE ${field} IN ('${ids[0]}') ORDER BY n`, [{ n: 1 }, { n: 3 }]);
    await prova(`SELECT n FROM geometries WHERE '${ids[0]}'=${field} ORDER BY n`, [{ n: 1 }, { n: 3 }]);
    await prova(`SELECT n FROM geometries WHERE ${field} IN ('${ids[0].toUpperCase()}') ORDER BY n`, [{ n: 1 }, { n: 4 }]);
  }
  await prova(`SELECT n FROM geometries WHERE ref != '${ids[0]}' ORDER BY n`, [{ n: 2 }, { n: 4 }]);
  await prova(`SELECT n FROM geometries WHERE ref NOT IN ('${ids[0]}') ORDER BY n`, [{ n: 2 }, { n: 4 }]);
  await prova(`SELECT n FROM geometries WHERE testo IN ('${ids[0]}') ORDER BY n`, [{ n: 1 }, { n: 3 }]);
  await prova('SELECT n FROM geometries WHERE _id IN (42, NULL)', [{ n: 5 }]);
  await prova('SELECT n FROM geometries WHERE ref IS NULL ORDER BY n', [{ n: 5 }, { n: 6 }]);

  // UPDATE e DELETE condividono i predicati; SET/INSERT conservano le stringhe.
  const write = sql => strategy.mongoSqlReturning(db, 'geometries', { sql });
  await write(`UPDATE geometries SET salvato='${ids[1]}' WHERE _id IN ('${ids[0]}')`);
  const saved = await collection.find({ salvato: ids[1] }).sort({ n: 1 }).toArray();
  assert.deepEqual(saved.map(d => d.n), [1, 3]); assert.ok(saved.every(d => typeof d.salvato === 'string')); checks++;
  await write(`INSERT INTO geometries (_id, testo) VALUES ('abcdef0123456789abcdef01', '${ids[0]}')`);
  assert.ok(await collection.findOne({ _id: 'abcdef0123456789abcdef01', testo: ids[0] })); checks++;
  await write(`DELETE FROM geometries WHERE _id IN ('${ids[0]}')`);
  assert.equal(await collection.countDocuments({ _id: { $in: [ids[0], new ObjectId(ids[0])] } }), 0);
  assert.equal(await collection.countDocuments({ n: { $in: [2, 4, 5, 6] } }), 4); checks++;
  if (mutant) { assert.ok(mutated); throw new Error(`Mutazione ${mutant} sopravvissuta`); }
  console.log(`OK: ${checks} prove SQL/ObjectId su MongoDB reale, compreso indice, NULL, tipi misti e scritture`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await server?.stop();
  try { if (connected) { targets.assertOwned(db); await client.db(db).dropDatabase(); } }
  finally { await client.close(); }
});
