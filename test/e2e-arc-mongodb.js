'use strict';
// Browser, Socket.IO e MongoDB reali; solo database e configurazione usa-e-getta.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { MongoClient, Long } = require('mongodb');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { scegliArc } = require('./arc-controls');
const dir = 'test-reports/arc/mongodb';
fs.mkdirSync(dir, { recursive: true });
(async () => {
  const client = new MongoClient('mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 3000 });
  const dbName = `arc_ui_e2e_${Date.now()}`;
  const server = await startTestServer({ port: 3174 });
  const browser = await chromium.launch();
  const report = { checks: [], errors: [] };
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.errors.push(error.message));
  try {
    await client.connect();
    const coll = client.db(dbName).collection('righe');
    await coll.insertOne({ _id: 'p1', nome: 'Prima', attivo: true, data: new Date('2026-10-07T10:00:00.123Z'), codice: Long.fromString('9007199254740993') });
    await page.goto(server.url); await page.waitForSelector('html[data-arc-ready="true"]');
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    if (await page.getByRole('button', { name: 'Nascondi i primi passi' }).isVisible()) await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await page.locator('#conn-add-btn').click();
    await scegliArc(page, '#conn-dbtype', 'mongodb');
    await page.locator('[name="host"]').fill('127.0.0.1');
    await page.locator('#wizard-next-btn').click();
    await page.locator('#connect-btn').click();
    await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
    await page.evaluate(async db => {
      const { state } = await import('/js/state.js');
      const { tabs } = await import('/js/tabs.js');
      const { emit } = await import('/js/utils.js');
      const { renderGrid } = await import('/js/grid.js');
      const { startEdit } = await import('/js/inlineEdit.js');
      Object.assign(state, { db, coll: 'righe' });
      const refresh = async () => {
        const res = await emit('collection:find', { tabId: tabs.activeId, db, coll: 'righe', limit: 50 });
        Object.assign(state, { docs: res.docs, columns: res.columns, total: res.total, exhausted: true });
        renderGrid();
      };
      await refresh();
      for (const id of ['tab-body', 'workspace', 'view-data']) document.getElementById(id).classList.remove('hidden');
      document.getElementById('placeholder').classList.add('hidden');
      window.arcRealEdit = field => startEdit(document.querySelector(`#grid td[data-c="${state.columns.indexOf(field)}"]`), state.docs[0], field,
        { relazione: null, ctx: { tabId: tabs.activeId, db, coll: 'righe', dbType: 'mongodb', onSaveSuccess: refresh }, onRender: renderGrid });
    }, dbName);
    report.checks.push('Connessione dal wizard Arc e lettura tramite Socket.IO reale');
    const editor = page.locator('#grid td.editing');
    await page.evaluate(() => window.arcRealEdit('nome'));
    await editor.getByRole('textbox').fill('Aggiornata con Arc');
    await editor.getByRole('textbox').press('Enter');
    await editor.waitFor({ state: 'detached' });
    assert.equal((await coll.findOne({ _id: 'p1' })).nome, 'Aggiornata con Arc');
    await page.evaluate(() => window.arcRealEdit('attivo'));
    await editor.getByRole('combobox').click(); await page.getByRole('option', { name: 'false', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    assert.equal((await coll.findOne({ _id: 'p1' })).attivo, false);
    await page.evaluate(() => window.arcRealEdit('data'));
    await editor.getByRole('textbox', { name: 'Ora UTC (ore, minuti, secondi e millisecondi)' }).fill('15:16:17.123');
    await editor.getByRole('button', { name: 'Data e ora in UTC', exact: true }).click();
    await page.getByRole('gridcell', { name: 'giovedì 8 ottobre 2026', exact: true }).click();
    await page.screenshot({ path: `${dir}/calendario-reale.png`, animations: 'disabled' });
    await editor.getByRole('textbox', { name: 'Ora UTC (ore, minuti, secondi e millisecondi)' }).press('Enter');
    await editor.waitFor({ state: 'detached' });
    const doc = await coll.findOne({ _id: 'p1' }, { promoteLongs: false });
    assert.equal(doc.data.toISOString(), '2026-10-08T15:16:17.123Z');
    assert.equal(doc.codice.toString(), '9007199254740993');
    report.checks.push('Input, Select e DatePicker: scritture reali, booleano false, UTC e millisecondi; BSON Long intatto');
    assert.deepEqual(report.errors, []);
    console.log(report.checks.join('\n'));
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
    await client.db(dbName).dropDatabase(); await client.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
