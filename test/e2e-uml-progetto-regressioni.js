'use strict';
const assert = require('assert');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { prepara } = require('../db/umlProgetto');

(async () => {
  const server = await startTestServer({ port: 3163 });
  let browser;
  try {
    browser = await chromium.launch();
    for (const type of ['mysql', 'postgresql']) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      page.setDefaultTimeout(10000);
      let external = false;
      const reads = [];
      const fields = [{ name: 'id', types: ['integer'], nullable: false, key: 'PRI' }, { name: 'parent_id', types: ['integer'], nullable: true }];
      const relations = () => [{ nome: 'fk', db: external ? 'common' : 'sales', tabella: 'parent', coppie: [{ campo: 'parent_id', colonna: 'id' }],
        onDelete: type === 'postgresql' ? 'SET DEFAULT' : 'CASCADE', onUpdate: type === 'postgresql' ? 'SET DEFAULT' : 'RESTRICT' }];
      const strategy = { type,
        async listCollections() { return [{ name: 'child' }, { name: 'parent' }]; },
        async tableDdl(_db, table) { return `CREATE TABLE ${table} (id integer PRIMARY KEY, parent_id integer)`; },
        async tableAuxDdl() { return { indexes: [], foreignKeys: [] }; },
        async tableFields() { return fields; },
        async columnRelations(_db, table) { return table === 'child' ? relations() : []; },
      };
      await page.exposeFunction('testUml', async (event, payload) => {
        try {
          if (event === 'uml:table') {
            reads.push(payload.coll);
            assert(['child', 'parent'].includes(payload.coll), 'i nomi della bozza non esistono ancora nel DB');
            return { ok: true, fields, relazioni: await strategy.columnRelations('sales', payload.coll) };
          }
          if (event === 'uml:preview') return { ok: true, ...await prepara(strategy, 'sales', payload.operations, () => {}) };
          return { ok: true };
        } catch (err) { return { ok: false, error: err.message }; }
      });
      await page.goto(server.url);
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--pagina-altezza'));
      await page.evaluate(async (type) => {
        const { impostaSocket } = await import('/js/socket.js');
        const { createTab, tabs } = await import('/js/tabs.js');
        impostaSocket({ emit: (e, p, cb) => window.testUml(e, p).then(r => cb?.(r)), on() {}, off() {} });
        const tab = createTab({ id: 'review', connName: null });
        tabs.activeId = tab.id;
        Object.assign(tab.state, { connected: true, dbType: type, db: 'sales' });
        document.querySelectorAll('.overlay').forEach(el => el.classList.add('hidden'));
        const el = document.createElement('section');
        el.id = 'uml-progetto';
        el.className = 'uml-progetto hidden';
        const button = document.createElement('button'); button.id = 'uml-progetta-btn';
        document.body.append(el, button);
        el.style.cssText = 'position:fixed;inset:0;z-index:100';
        window.draft = { progetto: [] };
        window.designer = (await import('/js/uml-progetto.js')).creaProgettista({
          contesto: () => ({ tabId: tab.id, connId: 'test', db: 'sales', dbType: type }),
          documento: () => window.draft, tabelle: () => ['child', 'parent'],
          modifica: ops => { window.draft.progetto = ops; }, aggiornaSchema() {},
        });
        window.designer.apri();
      }, type);
      const form = page.locator('#uml-progetto');
      const choose = async kind => { await form.locator('[data-kind]').selectOption(kind); await form.locator('[data-table]').selectOption('child'); };
      const save = () => form.locator('button[type=submit]').click();
      await choose('replaceForeignKey');
      await form.locator('[data-fk] option[value=fk]').waitFor({ state: 'attached' });
      assert.strictEqual(await form.locator('[data-ondelete]').inputValue(), type === 'postgresql' ? 'SET DEFAULT' : 'CASCADE');
      assert.strictEqual(await form.locator('[data-onupdate]').inputValue(), type === 'postgresql' ? 'SET DEFAULT' : 'RESTRICT');
      await save();
      await form.locator('[data-preview]').click();
      await page.waitForFunction(() => !document.querySelector('#uml-progetto [data-apply]').disabled);
      assert((await form.locator('[data-sql]').textContent()).includes(type === 'postgresql' ? 'ON DELETE SET DEFAULT ON UPDATE SET DEFAULT' : 'ON DELETE CASCADE ON UPDATE RESTRICT'));
      external = true;
      await page.evaluate(() => { window.draft.progetto = []; window.designer.apri(); });
      await choose('replaceForeignKey');
      await page.waitForFunction(() => document.querySelector('#uml-progetto [data-error]').textContent.includes('altro schema'));
      await save();
      assert.strictEqual(await page.evaluate(() => window.draft.progetto.length), 0, 'non si salva un cambio involontario di schema');
      external = false;
      await page.evaluate(() => window.designer.apri());
      await choose('renameTable');
      await form.locator('[data-name]').fill('renamed'); await save();
      await form.locator('[data-kind]').selectOption('addColumn');
      await form.locator('[data-table]').selectOption('renamed');
      await form.locator('[data-col=name]').fill('nota'); await save();
      await form.locator('[data-kind]').selectOption('replaceForeignKey');
      await form.locator('[data-table]').selectOption('renamed');
      await form.locator('[data-fk] option[value=fk]').waitFor({ state: 'attached' });
      await form.locator('[data-name]').fill('fk_nuova'); await save();
      await form.locator('[data-kind]').selectOption('dropForeignKey');
      await form.locator('[data-fk] option[value=fk_nuova]').waitFor({ state: 'attached' });
      assert.strictEqual(await form.locator('[data-fk] option[value=fk]').count(), 0);
      await save();
      await form.locator('[data-preview]').click();
      await page.waitForFunction(() => !document.querySelector('#uml-progetto [data-apply]').disabled);
      assert.match(await form.locator('[data-sql]').textContent(), /renamed.*ADD COLUMN[\s\S]*fk_nuova/);
      assert(!reads.includes('renamed'), 'i metadati di una tabella rinominata provengono ancora dalla sua origine');
      await form.locator('[data-edit="0"]').click();
      assert.strictEqual(await form.locator('[data-table]').inputValue(), 'child', 'modificare il primo passo mostra lo schema precedente');
      console.log(`  OK ${type}: azioni FK conservate, schema esterno protetto, rinomina e metadati della bozza`);
      await page.close();
    }
  } finally { await browser?.close(); await server.stop(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
