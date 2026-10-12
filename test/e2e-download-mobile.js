'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');

(async () => {
  const server = await startTestServer({ port: 3241 });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true })), require('../package.json').version);
    if (mutant) await page.route('**/js/query-tab.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const original = "if (!await scaricaFile(blob, nome)) return;";
      assert(source.includes(original));
      await route.fulfill({ response, body: source.replace(original, 'void scaricaFile(blob, nome);') });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'download-fixture' });
      tab.dbType = 'postgresql'; tabs.activeId = tab.id;
      Object.assign(tab.state, { connected: true, dbType: 'postgresql', databases: ['vuoto'] });
      const fake = { connected: true, on() { return fake; }, off() { return fake; }, emit(name, payload, ack) {
        ack?.({ ok: true, databases: ['vuoto'], collections: [], fields: [], indexes: [], docs: [], total: 0 });
      } };
      (await import('/js/socket.js')).impostaSocket(fake);
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openDbTab('vuoto');
      window.fileTest = { sent: [], alerts: [], mode: 'attesa', tab };
      window.alert = text => fileTest.alerts.push(text);
      // Il ponte Java è simulato; fetch Blob e l'intero trasferimento JS sono reali.
      window.CodeDBFiles = { postMessage(raw) {
        const command = JSON.parse(raw);
        fileTest.sent.push(command);
        if (command.op === 'start' && fileTest.mode === 'attesa') return;
        const response = command.op === 'start' && fileTest.mode === 'annulla' ? 'annullato'
          : command.op === 'chunk' && fileTest.mode === 'errore' ? 'Spazio esaurito' : 'ok';
        queueMicrotask(() => CodeDBFiles.onmessage({ data: response }));
      } };
      fileTest.query = (await import('/js/query-document.js')).queryDocument();
    });
    await page.addScriptTag({ path: 'android/app/src/main/assets/download.js' });
    const editor = page.locator('#query-editor-input');
    const salva = async () => {
      await page.locator('#query-editor-more-btn').click();
      await page.locator('#query-save-sql-btn').click();
      await page.waitForFunction(() => fileTest.sent.some(c => c.op === 'start'));
    };
    await editor.fill('SELECT 1;');
    await salva();
    assert.equal(await page.evaluate(() => fileTest.query.dirty), true, 'La query resta modificata mentre il selettore Android è aperto');
    await page.evaluate(() => CodeDBFiles.onmessage({ data: 'annullato' }));
    await page.waitForFunction(() => fileTest.sent.some(c => c.op === 'abort'));
    assert.equal(await page.evaluate(() => fileTest.query.dirty), true, 'Annullare non salva la query');
    assert.equal(await page.evaluate(() => fileTest.sent.some(c => c.op === 'chunk')), false);
    assert.deepEqual(await page.evaluate(() => fileTest.alerts), []);
    await page.evaluate(() => { fileTest.sent = []; fileTest.mode = 'ok'; });
    await salva();
    await page.waitForFunction(() => !fileTest.query.dirty);
    assert.equal(await page.evaluate(() => fileTest.query.savedCode), 'SELECT 1;');
    assert.equal(await page.evaluate(() => fileTest.sent.filter(c => c.op === 'chunk').map(c => atob(c.data)).join('')), 'SELECT 1;');
    console.log('OK query mobile: attesa, annullamento e salvataggio reale dei byte tramite ponte JS');

    // L'utente può cambiare documento o testo durante un salvataggio asincrono.
    await page.evaluate(() => { fileTest.sent = []; fileTest.mode = 'attesa'; });
    await editor.fill('SELECT 2;');
    await salva();
    await editor.fill('SELECT 3;');
    await page.evaluate(async () => {
      (await import('/js/colltabs.js')).openDbTab('altro');
      fileTest.other = (await import('/js/query-document.js')).queryDocument();
      CodeDBFiles.onmessage({ data: 'ok' });
    });
    await page.waitForFunction(() => fileTest.query.savedCode === 'SELECT 2;');
    assert.equal(await page.evaluate(() => fileTest.query.dirty), true, 'Le modifiche successive restano da salvare');
    assert.equal(await page.evaluate(() => fileTest.other.savedCode), undefined, 'Il completamento non modifica un altro documento');

    await page.evaluate(() => { fileTest.mode = 'ok'; fileTest.sent = []; });
    const binary = Array.from({ length: 100000 }, (_, i) => i % 256);
    assert.equal(await page.evaluate(async bytes => {
      const { scaricaFile } = await import('/js/utils.js');
      return scaricaFile(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), 'dati.bin');
    }, binary), true);
    const sent = await page.evaluate(() => fileTest.sent);
    assert.equal(sent[0].name, 'dati.bin');
    assert(sent.filter(c => c.op === 'chunk').every(c => Buffer.from(c.data, 'base64').length <= 32768));
    assert.deepEqual(Buffer.concat(sent.filter(c => c.op === 'chunk').map(c => Buffer.from(c.data, 'base64'))), Buffer.from(binary));
    for (const mode of ['annulla', 'errore', 'ok']) {
      await page.evaluate(mode => { fileTest.sent = []; fileTest.mode = mode; }, mode);
      assert.equal(await page.evaluate(async () => (await import('/js/utils.js')).scaricaFile(new Blob(['città 😀']), 'dati.csv')), mode === 'ok');
    }
    assert.equal(await page.evaluate(() => fileTest.alerts.length), 1, 'Errore di scrittura segnalato, annullamento silenzioso');
    console.log('OK file mobile: chunk, byte binari, Unicode, errore e ripresa dopo annullamento');

    await page.route('**/download-fixture', route => route.fulfill({ headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="righe.csv"' }, body: 'nome\ncittà 😀\n' }));
    await page.evaluate(() => { fileTest.sent = []; });
    assert.equal(await page.evaluate(async () => (await import('/js/utils.js')).scaricaFile('/download-fixture', 'righe.csv')), true, JSON.stringify(await page.evaluate(() => fileTest.alerts)));
    assert.equal(Buffer.concat((await page.evaluate(() => fileTest.sent)).filter(c => c.op === 'chunk').map(c => Buffer.from(c.data, 'base64'))).toString(), 'nome\ncittà 😀\n');
    await page.evaluate(() => {
      fileTest.sent = [];
      const frame = document.createElement('iframe');
      frame.id = 'download-panel'; frame.src = location.href;
      document.body.appendChild(frame);
    });
    const frame = page.frames().find(frame => frame.parentFrame());
    await frame.waitForSelector('html[data-arc-ready="true"]');
    await frame.evaluate(() => {
      frameElement.codedbPanel = {};
      window.__codedbDownload = () => { throw new Error('Ponte non autorizzato nel frame secondario'); };
    });
    assert.equal(await frame.evaluate(async () => (await import('/js/geo-vista.js')).scaricaGeoJson({ type: 'FeatureCollection', features: [] }, 'mappa.geojson')), true);
    assert.equal(await page.evaluate(() => fileTest.sent[0].name), 'mappa.geojson');
    await page.locator('#download-panel').evaluate(el => el.remove());
    console.log('OK esportazione dal server e GeoJSON da un pannello incorporato tramite ponte principale');
    // Un contesto pulito verifica anche i download del browser, senza il ponte.
    const web = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true, serviceWorkers: 'block' });
    await web.goto(server.url);
    await web.waitForSelector('html[data-arc-ready="true"]');
    for (const [name, body, mime] of [['dati.csv', 'nome\ncittà 😀\n', 'text/csv'], ['tipi.json', '{"n":{"$numberLong":"9223372036854775807"}}', 'application/json']]) {
      const pending = web.waitForEvent('download');
      assert.equal(await web.evaluate(async ({ name, body, mime }) => (await import('/js/utils.js')).scaricaFile(new Blob([body], { type: mime }), name), { name, body, mime }), true);
      const download = await pending;
      assert.equal(download.suggestedFilename(), name);
      assert.equal(fs.readFileSync(await download.path(), 'utf8'), body);
    }
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
    const pendingImage = web.waitForEvent('download');
    await web.evaluate(async png => (await import('/js/utils.js')).scaricaFile(`data:image/png;base64,${png}`, 'grafico.png'), png);
    const image = await pendingImage;
    assert.equal(image.suggestedFilename(), 'grafico.png');
    assert.deepEqual(fs.readFileSync(await image.path()), Buffer.from(png, 'base64'));
    await web.close();
    assert.deepEqual(errors, []);
    console.log('OK browser mobile Chromium: nome e contenuto dei file CSV/JSON/PNG scaricati; nessun errore JS');
  } finally {
    await browser?.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
