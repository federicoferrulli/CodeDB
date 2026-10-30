'use strict';

// Interfaccia e File.stream reali; risposte socket simulate senza scritture DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3214 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: true, serviceWorkers: 'block' });
  const errors = [];
  const reportDir = process.env.CODEDB_TEST_REPORT_DIR || 'test-reports/import-export-2026-10-12';
  page.on('pageerror', e => errors.push(e.message));
  try {
    if (process.argv.includes('--mutant')) await page.route('**/js/exportimport.js', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace('index: index++, chunk });', "index: index++, chunk: chunk.replaceAll('🦊', '') });");
      await route.fulfill({ response, body });
    });
    if (process.argv.includes('--mutant-file')) await page.route('**/js/exportimport.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const original = 'if (importReader !== reader) return;';
      assert(source.includes(original));
      await route.fulfill({ response, body: source.replaceAll(original, '') });
    });
    await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const [{ createTab, tabs }, { impostaSocket }] = await Promise.all(['tabs', 'socket'].map(n => import(`/js/${n}.js`)));
      const t = createTab({ id: 'import-ui' }); t.dbType = 'mysql'; t.connName = 'Collaudo';
      Object.assign(t.state, { connected: true, dbType: 'mysql' }); tabs.activeId = t.id;
      const f = window.uploadFixture = { uploads: {}, sent: [], next: 0, pending: [], hold: false };
      const fake = { connected: true, on() {}, off() {}, timeout() { return { emit: (name, p, cb) => fake.emit(name, p, r => cb(null, r)) }; }, emit(name, p, cb) {
        f.sent.push({ name, ...p });
        let reply = { ok: true, operations: [] };
        if (name === 'database:import:upload:start') {
          const id = String(++f.next); f.uploads[id] = [];
          reply = { ok: true, uploadId: id, maxBytes: 8 * 1024 * 1024, maxChunkBytes: 1024 };
        }
        if (name === 'database:import:upload:chunk') {
          f.uploads[p.uploadId].push(p.chunk);
          if (new TextEncoder().encode(p.chunk).length > 1024) reply = { ok: false, error: 'Blocco troppo grande' };
          if (f.hold) { f.pending.push(() => cb(reply)); return; }
        }
        if (name === 'database:import:upload:finish') reply.artifact = { db: 'origine', dbType: 'mysql', collections: [{ name: 't', rows: 2 }], avvisi: ['Privilegi non trasferiti.'] };
        cb?.(reply);
      } };
      impostaSocket(fake);
    });
    const open = async () => {
      await page.evaluate(async () => (await import('/js/exportimport.js')).openDbImportModal());
      await page.waitForSelector('#dbimport-overlay[data-arc-dialog="open"]');
      await page.waitForTimeout(350);
    };
    const file = { name: 'dump.sql', mimeType: 'text/plain', buffer: Buffer.from("INSERT INTO t VALUES ('à 🦊');\n".repeat(5000)) };
    await open();
    await page.locator('#dbimport-file').setInputFiles(file);
    await page.waitForFunction(() => document.getElementById('dbimport-progress-label').textContent.includes('File validato'));
    assert.equal(await page.evaluate(() => window.uploadFixture.uploads['1'].join('')), file.buffer.toString());
    assert.equal(await page.locator('#dbimport-target').inputValue(), 'origine');
    assert.match(await page.locator('#dbimport-file-notes').textContent(), /Privilegi/);
    assert.equal(await page.evaluate(() => window.uploadFixture.sent.find(e => e.name.endsWith('upload:start')).format), 'sql');
    fs.mkdirSync(reportDir, { recursive: true });
    await page.screenshot({ path: path.join(reportDir, 'import-desktop.png') });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.uploadFixture.sent.some(e => e.name.endsWith('upload:cancel') && e.uploadId === '1'));
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await page.locator('#dbimport-file').setInputFiles({ ...file, name: 'database.codedb.json' });
    await page.waitForFunction(() => document.getElementById('dbimport-progress-label').textContent.includes('File validato'));
    assert.equal(await page.evaluate(() => window.uploadFixture.sent.filter(e => e.name.endsWith('upload:start')).at(-1).format), 'codedb-json');
    await page.screenshot({ path: path.join(reportDir, 'import-mobile.png') });
    await page.locator('#dbimport-file').setInputFiles({ name: 'invalid.sql', mimeType: 'text/plain', buffer: Buffer.from([0xFF, 0xFE, 0x00]) });
    await page.waitForFunction(() => document.getElementById('dbimport-error').textContent.includes('UTF-8'));
    assert.equal(await page.locator('#dbimport-file-notes').textContent(), '');
    assert(!await page.evaluate(() => window.uploadFixture.sent.some(e => e.name.endsWith('upload:finish') && e.uploadId === '3')));
    await page.evaluate(() => { window.uploadFixture.hold = true; });
    await page.locator('#dbimport-file').setInputFiles(file);
    await page.waitForFunction(() => window.uploadFixture.pending.length > 0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.uploadFixture.hold = false; window.uploadFixture.pending.splice(0).forEach(cb => cb()); });
    await page.waitForFunction(() => window.uploadFixture.sent.some(e => e.name.endsWith('upload:cancel') && e.uploadId === '4'));
    assert(!await page.evaluate(() => window.uploadFixture.sent.some(e => e.name.endsWith('upload:finish') && e.uploadId === '4')));

    // Selettore file reale del browser; nessun dato viene scritto nel database.
    await page.evaluate(async () => (await import('/js/exportimport.js')).openImportModal('origine', 't'));
    await page.waitForSelector('#import-overlay[data-arc-dialog="open"]');
    const csv = 'id,nome\n1,città 🦊\n';
    const pickerPromise = page.waitForEvent('filechooser');
    await page.locator('#import-file').tap();
    await (await pickerPromise).setFiles({ name: 'righe.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForFunction(csv => document.getElementById('import-text').value === csv, csv);
    assert(await page.locator('#import-run').isEnabled());
    // Simula un provider lento/illeggibile: il file precedente non è una riserva valida.
    await page.evaluate(() => {
      const native = FileReader.prototype.readAsText;
      FileReader.prototype.readAsText = function(file) {
        if (file.name === 'lento.csv') { window.finishSlowFile = () => this.onload?.({ target: { result: 'id,nome\n9,vecchio\n' } }); return; }
        if (file.name.startsWith('errore.')) { queueMicrotask(() => { this.onerror?.(); this.onloadend?.(); }); return; }
        return native.call(this, file);
      };
    });
    await page.locator('#import-file').setInputFiles({ name: 'lento.csv', mimeType: 'text/csv', buffer: Buffer.from('id,nome\n9,vecchio\n') });
    assert(await page.locator('#import-run').isDisabled(), 'Importa attende la lettura del nuovo file');
    assert.equal(await page.locator('#import-text').inputValue(), '', 'Il contenuto precedente viene rimosso');
    await page.locator('#import-file').setInputFiles({ name: 'nuovo.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForFunction(csv => document.getElementById('import-text').value === csv, csv);
    await page.evaluate(() => finishSlowFile());
    assert.equal(await page.locator('#import-text').inputValue(), csv, 'Una lettura sorpassata non sostituisce l’ultima scelta');
    await page.locator('#import-file').setInputFiles({ name: 'errore.csv', mimeType: 'text/csv', buffer: Buffer.from('errore') });
    await page.waitForFunction(() => document.getElementById('import-error').textContent.includes('leggere'));
    assert.equal(await page.locator('#import-text').inputValue(), '', 'Errore di lettura: nessun dato precedente importabile');
    assert(await page.locator('#import-text').isEnabled(), 'Si può ancora incollare il contenuto');
    const before = await page.evaluate(() => uploadFixture.sent.filter(e => e.name === 'collection:import').length);
    await page.locator('#import-run').click();
    assert.equal(await page.evaluate(() => uploadFixture.sent.filter(e => e.name === 'collection:import').length), before);
    await page.locator('#import-file').setInputFiles({ name: 'lento.csv', mimeType: 'text/csv', buffer: Buffer.from('vecchio') });
    await page.locator('#import-cancel').click();
    await page.waitForSelector('#import-overlay[data-arc-dialog="open"]', { state: 'hidden' });
    await page.evaluate(async () => (await import('/js/exportimport.js')).openImportModal('origine', 'nuova'));
    await page.evaluate(() => finishSlowFile());
    assert.equal(await page.locator('#import-text').inputValue(), '', 'Riaprire la finestra non recupera una lettura annullata');
    assert(await page.locator('#import-run').isEnabled());
    await page.locator('#import-cancel').click();
    await page.waitForSelector('#import-overlay[data-arc-dialog="open"]', { state: 'hidden' });
    await page.evaluate(() => {
      const native = File.prototype.text;
      File.prototype.text = function() {
        return this.name === 'errore.ini' ? Promise.reject(new Error('File non accessibile')) : native.call(this);
      };
    });
    await page.locator('#conn-import-file').setInputFiles({ name: 'errore.ini', mimeType: 'text/plain', buffer: Buffer.from('non letto') });
    await page.waitForFunction(() => document.getElementById('toast-container').textContent.includes('Impossibile importare il file'));
    assert(!await page.evaluate(() => uploadFixture.sent.some(e => e.name === 'connections:import')));
    await page.locator('#diff-file-input').setInputFiles({ name: 'errore.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
    await page.waitForFunction(() => document.getElementById('toast-container').textContent.includes('Impossibile leggere il file selezionato'));
    await page.evaluate(async () => {
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openDbTab('origine');
    });
    const sql = "SELECT 'città 🦊';\n";
    await page.locator('#query-open-sql-input').setInputFiles({ name: 'query.sql', mimeType: 'text/plain', buffer: Buffer.from(sql) });
    await page.waitForFunction(sql => document.getElementById('query-editor-input').value === sql, sql);
    await page.locator('#query-open-sql-input').setInputFiles({ name: 'grande.sql', mimeType: 'text/plain', buffer: Buffer.from(sql.repeat(60000)) });
    await page.waitForFunction(() => parseInt(document.getElementById('chunk-count-badge').textContent, 10) > 1);
    assert((await page.locator('#query-editor-input').inputValue()).startsWith(sql));
    assert(!await page.evaluate(() => uploadFixture.sent.some(e => ['query:execute', 'script:run', 'collection:import'].includes(e.name))), 'Aprire un file non esegue query o importazioni');
    assert.deepEqual(errors, []);
    console.log('  OK UI: SQL/JSON/CSV, selettore touch, UTF-8 integro, SQL grande a blocchi, chiusura, letture sorpassate e file illeggibili (dati, connessioni, snapshot)');
  } finally { await browser.close(); await server.stop(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
