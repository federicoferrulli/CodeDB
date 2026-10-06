'use strict';
// Prova del modulo di progettazione isolato: la vista UML pubblica è di sola lettura.
const assert = require('assert');
const fs = require('fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { prepara, applica } = require('../db/umlProgetto');
const DbStrategy = require('../db/DbStrategy');

(async () => {
  const server = await startTestServer({ port: 3158 });
  const browser = await chromium.launch();
  try {
    for (const type of ['mysql', 'postgresql']) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
      const errors = [], calls = [];
      page.on('pageerror', (err) => errors.push(err.message));
      let plan;
      const schema = { collections: [{ name: 'clienti', fields: [{ name: 'id', types: ['integer'], key: 'PRI' }] }], relations: [], schemaPage: { complete: true } };
      const strategy = {
        type, applySchemaStatement: DbStrategy.prototype.applySchemaStatement,
        async listCollections() { return schema.collections; },
        async tableDdl(_db, table) { return `CREATE TABLE ${table} (id integer primary key)`; },
        async tableAuxDdl() { return { indexes: [], foreignKeys: [] }; },
        async collectionAggregate(_db, _coll, p) { calls.push(p.pipeline); return {}; },
      };
      await page.exposeFunction('umlServer', async (event, p) => {
        try {
          if (event === 'db:schema') return { ok: true, ...schema };
          if (event === 'uml:table') return { ok: true, fields: schema.collections.find((c) => c.name === p.coll)?.fields || [], relazioni: [] };
          if (event === 'uml:preview') { plan = await prepara(strategy, p.db, p.operations, () => {}); return { ok: true, token: plan.token, steps: plan.steps }; }
          if (event === 'uml:apply') {
            assert.strictEqual(p.token, plan.token);
            const result = await applica(strategy, plan, () => {});
            if (result.status === 'completato') {
              for (const op of plan.operations) {
                if (op.kind === 'createTable') schema.collections.push({ name: op.table, fields: op.columns.map((c) => ({ name: c.name, types: [c.type], key: c.primaryKey ? 'PRI' : '' })) });
                if (op.kind === 'addForeignKey') schema.relations.push({ from: op.table, to: op.target, field: op.columns[0], toField: op.references[0], constraint: op.name, origine: 'vincolo' });
              }
            }
            return { ok: true, ...result };
          }
          if (event === 'collection:stats') return { ok: true, fields: schema.collections.find((c) => c.name === p.coll)?.fields || [], indexes: [], stats: {} };
          if (event === 'db:list') return { ok: true, databases: [] };
          if (event === 'db:collections') return { ok: true, collections: schema.collections };
          return { ok: true };
        } catch (err) { return { ok: false, error: err.message }; }
      });
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#uml-canvas', { state: 'attached' });
      await page.waitForTimeout(600);
      await page.evaluate(async (type) => {
        const { impostaSocket } = await import('/js/socket.js');
        const { createTab, tabs } = await import('/js/tabs.js');
        impostaSocket({ emit: (e, p, cb) => window.umlServer(e, p).then((r) => cb?.(r)), on() {}, off() {} });
        document.getElementById('onboarding-overlay').classList.add('hidden');
        const tab = createTab({ id: `uml-${type}`, connName: null });
        Object.assign(tab.state, { connected: true, dbType: type, db: 'vendite', connId: `test-${type}`, view: 'uml' });
        tabs.activeId = tab.id;
        document.getElementById('welcome').classList.add('hidden');
        document.getElementById('placeholder').classList.add('hidden');
        document.getElementById('tab-body').classList.remove('hidden');
        document.getElementById('workspace').classList.remove('hidden');
        document.querySelectorAll('#workspace .view-panel').forEach((v) => v.classList.add('hidden'));
        document.getElementById('view-uml').classList.remove('hidden');
        window.__uml = await import('/js/uml.js');
        window.__uml.loadUml(true);
        const panel = document.createElement('section');
        panel.id = 'uml-progetto'; panel.className = 'uml-progetto hidden';
        panel.style.cssText = 'position:fixed;inset:0;z-index:50;max-height:none';
        const button = document.createElement('button'); button.id = 'uml-progetta-btn';
        document.body.append(panel, button);
        window.draft = { progetto: [] };
        window.designer = (await import('/js/uml-progetto.js')).creaProgettista({
          contesto: () => ({ tabId: tab.id, connId: `test-${type}`, db: 'vendite', dbType: type }),
          documento: () => window.draft, tabelle: () => ['clienti'],
          modifica: ops => { window.draft.progetto = ops; },
          aggiornaSchema: async (_target, applied, doc) => {
            const ids = new Set(applied.map(o => o.id));
            doc.progetto = doc.progetto.filter(o => !ids.has(o.id));
          },
        });
        window.designer.apri();
      }, type);
      await page.waitForSelector('#uml-canvas .joint-element');
      await page.fill('#uml-progetto [data-name]', 'ordini');
      await page.click('#uml-progetto [data-add-column]');
      await page.locator('#uml-progetto tbody tr').nth(1).locator('[data-col="name"]').fill('cliente_id');
      await page.click('#uml-progetto button[type="submit"]');
      await page.waitForFunction(() => window.draft.progetto?.length === 1);
      assert.ok(await page.locator('#uml-progetto [data-queue]').textContent().then((s) => s.includes('ordini')));
      assert.strictEqual(calls.length, 0, 'salvare la bozza non esegue SQL');

      // La colonna esiste soltanto nella bozza: nessuna lettura dal DB può trovarla.
      await page.selectOption('#uml-progetto [data-kind]', 'alterColumn');
      await page.selectOption('#uml-progetto [data-table]', 'ordini');
      await page.waitForSelector('#uml-progetto [data-field] option[value="cliente_id"]', { state: 'attached' });
      await page.selectOption('#uml-progetto [data-field]', 'cliente_id');
      await page.fill('#uml-progetto [data-col="type"]', 'bigint');
      await page.click('#uml-progetto button[type="submit"]');
      await page.click('#uml-progetto [data-preview]');
      await page.waitForFunction(() => !document.querySelector('#uml-progetto [data-apply]').disabled);
      assert.match(await page.locator('#uml-progetto [data-sql]').textContent(), /ALTER TABLE[\s\S]*bigint/i);
      assert.strictEqual(calls.length, 0, 'CREATE e ALTER della bozza restano un’anteprima');
      await page.click('#uml-progetto [data-remove="1"]');

      await page.selectOption('#uml-progetto [data-kind]', 'addForeignKey');
      await page.selectOption('#uml-progetto [data-table]', 'ordini');
      await page.fill('#uml-progetto [data-name]', 'fk_cliente');
      await page.fill('#uml-progetto [data-key]', 'cliente_id');
      await page.selectOption('#uml-progetto [data-target]', 'clienti');
      await page.fill('#uml-progetto [data-references]', 'id');
      await page.click('#uml-progetto button[type="submit"]');
      await page.waitForFunction(() => window.draft.progetto?.length === 2);
      await page.click('#uml-progetto [data-preview]');
      await page.waitForFunction(() => !document.querySelector('#uml-progetto [data-apply]').disabled);
      const sql = await page.locator('#uml-progetto [data-sql]').textContent();
      assert.ok(sql.includes(type === 'mysql' ? '`vendite`.`ordini`' : '"vendite"."ordini"'));
      assert.ok(sql.includes('FOREIGN KEY'));
      assert.strictEqual(calls.length, 0, 'l’anteprima non esegue SQL');
      fs.mkdirSync('test-reports/screenshots', { recursive: true });
      await page.screenshot({ path: `test-reports/screenshots/uml-progetto-${type}.png` });
      await page.click('#uml-progetto [data-apply]');
      await page.fill('#askinput-value', 'APPLICA');
      await page.click('#askinput-ok');
      await page.waitForFunction(() => document.querySelector('#uml-progetto [data-error]').textContent.includes('Progetto applicato'));
      assert.strictEqual(calls.length, 2);
      const remaining = await page.evaluate(() => window.draft.progetto);
      assert.strictEqual(remaining.length, 0, JSON.stringify({ remaining, planned: plan.operations, steps: plan.steps, results: plan.results }));
      assert.equal(await page.locator('#uml-progetto [data-queue] [data-edit]').count(), 0);
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.screenshot({ path: `test-reports/screenshots/uml-progetto-${type}-compatto.png` });
      assert.deepStrictEqual(errors, [], 'nessun errore JavaScript');
      console.log(`✓ ${type}: modulo isolato: bozza, FK, anteprima, conferma e applicazione`);
      await page.close();
    }
  } finally { await browser.close(); await server.stop(); }
})().catch((err) => { console.error(err); process.exitCode = 1; });
