'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_native_ui' });
const db = registry.target('dati');
let server, browser, my, pgConnected = false, mongoConnected = false;
const pg = new Client({ host: '127.0.0.1', port: 55439, user: 'postgres', database: 'postgres' });
const mongo = new MongoClient('mongodb://127.0.0.1:27039');
(async () => {
  registry.assertOwned(db);
  await pg.connect(); pgConnected = true;
  await pg.query(`CREATE SCHEMA "${db}"`);
  my = await mysql.createConnection({ host: '127.0.0.1', port: 33339, user: 'root' });
  await my.query(`CREATE DATABASE \`${db}\``);
  await mongo.connect(); mongoConnected = true;
  await mongo.db(db).collection('origine').insertOne({ id: 1 });
  server = await startTestServer({ port: 3182 });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('html[data-arc-ready="true"]');
  await page.evaluate(async db => {
    const { socket } = await import('/js/socket.js');
    const { tabs, createTab } = await import('/js/tabs.js');
    for (const [type, port] of [['mongodb', 27039], ['postgresql', 55439], ['mysql', 33339]]) {
      const result = await new Promise(resolve => socket.emit('mongo:connect', { tabId: type, dbType: type, host: '127.0.0.1', port,
        username: type === 'postgresql' ? 'postgres' : type === 'mysql' ? 'root' : '', database: type === 'postgresql' ? 'postgres' : db }, resolve));
      if (!result.ok) throw new Error(result.error);
      const t = createTab({ id: type });
      t.dbType = type; t.label = `Motore ${type}`;
      Object.assign(t.state, { dbType: type, connLabel: t.label, connected: true, databases: result.databases,
        collTabs: type === 'mongodb' ? [] : [{ id: `bozza-${type}`, db, coll: null, isDbTab: true, snapQuery: { code: 'SELECT 999 AS bozza', dirty: true } }] });
    }
    tabs.activeId = 'mongodb';
    (await import('/js/tabbar.js')).renderTabBar();
    (await import('/js/workspace.js')).renderWorkspace();
    (await import('/js/colltabs.js')).openDbTab(db);
  }, db);
  const scegli = async (nome, valore) => {
    await page.getByRole('combobox', { name: nome, exact: true }).click();
    await page.getByRole('option', { name: valore, exact: true }).click();
  };
  for (const type of ['postgresql', 'mysql']) {
    const sql = `CREATE TABLE destinazione_${type}(id INT)`;
    await page.locator('#query-editor-input').fill(sql);
    await page.evaluate(async ({ type, db }) => {
      (await import('/js/workspace.js')).saveWorkspaceInputs();
      (await import('/js/tabs.js')).switchTab(type);
      (await import('/js/colltabs.js')).openDbTab(db, { query: { code: '', engine: 'auto' } });
    }, { type, db });
    await page.locator('#query-editor-input').fill(sql);
    await page.locator('#query-target-btn').click();
    assert.equal(await page.locator('[id^="query-native-"]').count(), 0);
    await scegli('Motore di esecuzione', type === 'mysql' ? 'MySQL nativo' : 'PostgreSQL nativo');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#query-editor-input').inputValue(), sql);
    assert.equal(await page.locator('#query-target-engine').inputValue(), type);
    const snapshots = await page.evaluate(async type => {
      const { tabs, activeTab } = await import('/js/tabs.js');
      return { original: tabs.list.find(t => t.id === 'mongodb').state.collTabs[0].snapQuery.code,
        bozza: activeTab().state.collTabs.find(c => c.id === `bozza-${type}`).snapQuery.code,
        documenti: activeTab().state.collTabs.length };
    }, type);
    assert.deepEqual(snapshots, { original: sql, bozza: 'SELECT 999 AS bozza', documenti: 2 });
    await page.locator('#query-run-btn').click();
    await page.locator('#view-query[data-query-state="success"]').waitFor();
    if (type === 'postgresql') assert.equal((await pg.query('SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', [db, `destinazione_${type}`])).rowCount, 1);
    else {
      const tables = (await my.query(`SHOW TABLES FROM \`${db}\``))[0];
      const doc = await page.evaluate(async () => (await import('/js/query-document.js')).queryDocument());
      assert.equal(tables.filter(t => Object.values(t).includes('destinazione_mysql')).length, 1, JSON.stringify({ tables, doc }));
    }
    assert.equal((await mongo.db(db).listCollections({ name: `destinazione_${type}` }).toArray()).length, 0);
    await page.evaluate(async () => {
      (await import('/js/workspace.js')).saveWorkspaceInputs();
      (await import('/js/tabs.js')).switchTab('mongodb');
    });
    assert.equal(await page.locator('#query-editor-input').inputValue(), sql);
    console.log(`OK UI → ${type} reale: destinazione corretta, origine e bozze conservate, MongoDB intatto`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#query-target-btn').click();
  await scegli('Motore di esecuzione', 'Cross-DB (Virtual JOIN)');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[id^="query-native-"]').count(), 0);
  const rect = await page.locator('#query-target-menu').boundingBox();
  assert(rect.x >= 0 && rect.x + rect.width <= 391, 'Destinazione entro la finestra mobile');
  await page.screenshot({ path: 'test-reports/query-languages/native-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('OK selezione nativa mobile, nessun errore JavaScript');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await server?.stop();
  if (pgConnected) await registry.drop(db, n => pg.query(`DROP SCHEMA IF EXISTS "${n}" CASCADE`));
  if (my) await registry.drop(db, n => my.query(`DROP DATABASE IF EXISTS \`${n}\``));
  if (mongoConnected) await registry.drop(db, n => mongo.db(n).dropDatabase());
  await Promise.allSettled([pg.end(), my?.end(), mongo.close()]);
});
