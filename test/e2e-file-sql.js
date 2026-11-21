'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const mysql = require('mysql2/promise');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');

(async () => {
  const port = Number(process.env.EXPORT_MYSQL_PORT);
  assert.ok(port, 'Indicare EXPORT_MYSQL_PORT per il MySQL di prova');
  const password = require('./lab/credenziali.cjs')('mysql');
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_file_sql' });
  const db = targets.target('chunk');
  targets.assertOwned(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-file-sql-'));
  const giga = path.join(dir, 'anteprima.sql'), dump = path.join(dir, 'dati.sql');
  let server, browser, conn, creato = false;
  try {
    fs.writeFileSync(giga, 'SELECT 1 AS anteprima;\n');
    if (process.platform === 'win32') execFileSync('fsutil', ['sparse', 'setflag', giga], { windowsHide: true, stdio: 'ignore' });
    fs.truncateSync(giga, 6 * 1024 ** 3);
    const length = 6 * 1024 * 1024;
    fs.writeFileSync(dump, "BEGIN; INSERT INTO t VALUES (1,0); INSERT INTO t VALUES (1,0);\n" +
      "INSERT INTO t VALUES (2, LENGTH('" + 'x'.repeat(length) + "'));\n" +
      'COMMIT; /*!50001 CREATE VIEW v AS SELECT * FROM t */;');

    conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password });
    await conn.query('CREATE DATABASE ??', [db]); creato = true;
    await conn.query('CREATE TABLE ??.t (id INT PRIMARY KEY, n INT)', [db]);
    server = await startTestServer({ port: Number(process.env.E2E_PORT) || 3183 });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    if (process.argv.includes('--mutant=frammento')) {
      await page.route('**/js/script-upload.js', async route => {
        const response = await route.fetch();
        const code = await response.text();
        assert.ok(code.includes('chunk: code.slice(start, end)'));
        await route.fulfill({ response, body: code.replace('chunk: code.slice(start, end)', 'chunk: code.slice(start + 1, end)') });
      });
    }
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({
      visto: true, versioneVista: versione, checklistChiusa: true,
    })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async ({ port, password, db }) => {
      await (await import('/js/connection.js')).connectAndOpenTab({ dbType: 'mysql', host: '127.0.0.1', port, username: 'root', password });
      (await import('/js/colltabs.js')).openCollTab(db, 't');
      (await import('/js/main.js')).setView('query');
    }, { port, password, db });

    // Ferma la prima lettura per osservare anche su dischi veloci lo stato mostrato all'utente.
    await page.evaluate(async () => {
      const { SqlChunker } = await import('/js/sql-chunker.js');
      const leggi = SqlChunker.prototype.ensureChunk;
      SqlChunker.prototype.ensureChunk = async function (...args) {
        SqlChunker.prototype.ensureChunk = leggi;
        await new Promise(resolve => { window.proseguiLetturaSql = resolve; });
        return leggi.apply(this, args);
      };
    });
    await page.locator('#query-show-results').click();
    await page.locator('#query-open-sql-input').setInputFiles(giga);
    const barra = page.getByRole('progressbar', { name: /Caricamento del blocco 1/ });
    await barra.waitFor({ state: 'visible', timeout: 3500 });
    assert.equal(await barra.getAttribute('value'), null, 'la prima lettura ha durata indeterminata');
    const start = performance.now();
    await page.evaluate(() => window.proseguiLetturaSql());
    await page.waitForFunction(() => document.querySelector('#query-editor-input').value.includes('AS anteprima'));
    await barra.waitFor({ state: 'hidden' });
    assert.match(await page.locator('#chunk-progress-text').textContent(), /Blocco 1 pronto/);
    const elapsed = Math.round(performance.now() - start);
    const info = await page.evaluate(async () => {
      const { chunker } = (await import('/js/query-document.js')).queryDocument().file;
      return [chunker.complete, chunker.chunks.length, chunker.file.size, chunker.chunks[0].end];
    });
    assert.deepEqual(info, [false, 1, 6 * 1024 ** 3, 'SELECT 1 AS anteprima;'.length]);
    console.log(`Anteprima del file sparso da 6 GiB pronta in ${elapsed} ms, indicizzato il primo blocco.`);

    await page.locator('#query-open-sql-input').setInputFiles(dump);
    await page.waitForFunction(() => document.querySelector('#query-editor-input').value.includes('BEGIN;'));
    assert.equal(await page.locator('#query-stop-on-error').isChecked(), false);
    await page.evaluate(() => {
      const barra = document.querySelector('#chunk-progress-fill');
      window.avanzamentoUpload = [];
      new MutationObserver(() => {
        if (document.querySelector('#chunk-progress-text').textContent.includes('Invio al server')) {
          window.avanzamentoUpload.push(barra.value);
        }
      }).observe(barra, { attributes: true, attributeFilter: ['value'] });
    });
    await page.locator('#chunk-run-all-btn').click();
    await page.waitForFunction(() => /Completato|Interrotto|Sequenza interrotta/.test(document.querySelector('#chunk-progress-text').textContent), null, { timeout: 60000 });
    const esito = await page.locator('#chunk-progress-text').textContent();
    assert.match(esito, /Completato.*6 istruzioni.*1 error/, esito);
    assert(await page.evaluate(() => window.avanzamentoUpload.some(p => p > 0 && p < 100)),
      'durante l’invio di uno statement grande la barra mostra i frammenti ricevuti');
    const [rows] = await conn.query('SELECT id, n FROM ??.v ORDER BY id', [db]);
    assert.deepEqual(rows, [{ id: 1, n: 0 }, { id: 2, n: length }]);
    const entry = await page.evaluate(async () => {
      const items = (await import('/js/pending-queries.js')).listPending();
      const failed = items.find(i => i.fileChunk && i.status === 'error');
      return failed && { name: failed.fileChunk.name, index: failed.fileChunk.index, source: failed.sourceFile?.size };
    });
    assert.deepEqual(entry, { name: 'dati.sql', index: 0, source: fs.statSync(dump).size });
    fs.writeFileSync(dump, 'BEGIN; INSERT INTO t VALUES (3,0); INSERT INTO t VALUES (1,0);\n' +
      '/*' + 'x'.repeat(1024 * 1024) + '*/ INSERT INTO t VALUES (4,0); COMMIT;');
    await page.locator('#query-open-sql-input').setInputFiles(dump);
    await page.waitForFunction(() => document.querySelector('#query-editor-input').value.includes('VALUES (3,0)'));
    await page.locator('#query-stop-on-error-wrap [role="checkbox"]').click();
    assert.equal(await page.locator('#query-stop-on-error').isChecked(), true);
    await page.locator('#chunk-run-all-btn').click();
    await page.locator('#script-resume-btn').waitFor({ state: 'visible' });
    assert.deepEqual((await conn.query('SELECT id FROM ??.t WHERE id IN (3,4)', [db]))[0], []);
    await page.locator('#script-resume-btn').click();
    await page.waitForFunction(() => document.querySelector('#chunk-progress-text').textContent.includes('Completato'));
    assert.deepEqual((await conn.query('SELECT id FROM ??.t WHERE id IN (3,4) ORDER BY id', [db]))[0], [{ id: 3 }, { id: 4 }]);
    assert.deepEqual(errors, []);
    console.log('Editor, upload frammentato, pausa/ripresa, COMMIT, vista del dump e registro verificati sul database.');
  } finally {
    await browser?.close();
    await server?.stop();
    try { if (creato) await targets.drop(db, name => conn.query('DROP DATABASE ??', [name])); }
    finally { await conn?.end(); }
    fs.rmSync(giga, { force: true });
    fs.rmSync(dump, { force: true });
    fs.rmdirSync(dir);
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
