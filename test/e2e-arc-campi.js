'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { scegliArc, spuntaArc } = require('./arc-controls');
const dir = 'test-reports/arc/campi';
const mutant = process.argv.includes('--mutant');
fs.mkdirSync(dir, { recursive: true });
const report = { checks: [], coverage: [], layouts: [], errors: [], requests: [] };
const ok = name => { report.checks.push(name); console.log('OK', name); };

(async () => {
  const server = await startTestServer({ port: 3172 });
  const browser = await chromium.launch();
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => report.errors.push(e.stack));
    page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) report.errors.push(m.text()); });
    page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(server.url)) report.requests.push([r.url(), r.status()]); });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    if (await page.getByRole('button', { name: 'Nascondi i primi passi' }).isVisible()) await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    async function coverage(name) {
      await page.waitForTimeout(80);
      const result = await page.evaluate(() => {
        const fields = [...document.querySelectorAll('input,select,textarea')].filter(e => e.type !== 'hidden');
        return { total: fields.length, models: fields.filter(e => e.hasAttribute('data-arc-model')).length,
          missing: fields.filter(e => !e.dataset.arcComponent && !e.hasAttribute('data-arc-model') && !e.closest('[data-arc-owned]')).map(e => e.outerHTML.slice(0, 180)) };
      });
      report.coverage.push({ name, ...result });
      assert.deepEqual(result.missing, [], name);
    }
    await coverage('Tutti i form statici, file e textarea compresi');
    ok('Nessun input, select o textarea applicativo iniziale privo di Arc');

    await page.locator('#conn-add-btn').click();
    await scegliArc(page, '#conn-dbtype', 'postgresql');
    assert.equal(await page.locator('[name="port"]').inputValue(), '5432');
    await spuntaArc(page, '#conn-ssh-toggle', true);
    await page.locator('#wizard-next-btn').click();
    assert.match(await page.locator('#wizard-subtitle').textContent(), /Passo 2/);
    await page.locator('#wizard-prev-btn').click();
    await page.evaluate(() => document.getElementById('connect-form').reset());
    await page.waitForFunction(() => document.querySelector('[data-arc-for="conn-ssh-toggle"] [role="checkbox"]').getAttribute('aria-checked') === 'false');
    assert.equal(await page.locator('#conn-dbtype').inputValue(), 'mongodb');
    if (mutant) await page.evaluate(() => {
      // Mutazione della sola pagina di prova: elimina la sincronizzazione del
      // setter, lasciando intatta la logica applicativa e il bundle sul disco.
      delete document.getElementById('conn-dbtype').value;
    });
    await page.evaluate(() => { document.getElementById('conn-dbtype').value = 'mysql'; });
    await page.waitForFunction(() => document.querySelector('[data-arc-for="conn-dbtype"] [role="combobox"]').textContent.includes('MySQL'), null, { timeout: 3000 });
    await page.evaluate(() => { document.getElementById('conn-dbtype').disabled = true; });
    await page.waitForFunction(() => document.querySelector('[data-arc-for="conn-dbtype"] button').disabled);
    await page.evaluate(() => { document.getElementById('conn-dbtype').disabled = false; });
    await page.keyboard.press('Escape');
    ok('Select e Checkbox: controller reale, reset, assegnazioni e disabilitazione');

    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { state } = await import('/js/state.js');
      const { impostaSocket } = await import('/js/socket.js');
      const tab = createTab({ id: 'arc-campi', connName: null }); tabs.activeId = tab.id;
      Object.assign(state, { dbType: 'mongodb', connected: true, db: 'catalogo', coll: 'prodotti',
        docs: [{ _id: 'a', nome: 'Uno' }, { _id: 'b', nome: 'Due' }], columns: ['_id', 'nome'], total: 2, exhausted: true });
      window.arcMessages = [];
      impostaSocket({ on() {}, off() {}, emit(event, payload, cb) {
        window.arcMessages.push({ event, payload: structuredClone(payload) });
        if (event === 'collection:create') { cb({ ok: false, error: 'Errore controllato: bozza conservata' }); return; }
        cb?.({ ok: true, databases: [{ name: 'catalogo' }], collections: [{ name: 'prodotti' }], fields: [], relazioni: [] });
      } });
      for (const id of ['tab-body', 'workspace', 'view-data']) document.getElementById(id)?.classList.remove('hidden');
      for (const id of ['welcome', 'placeholder']) document.getElementById(id)?.classList.add('hidden');
      (await import('/js/grid.js')).renderGrid();
    });
    const encryptedFile = { name: 'connections.ini', mimeType: 'text/plain', buffer: Buffer.from('[__codedb_export__]\nversion=2\n') };
    await page.locator('#conn-import-file').setInputFiles(encryptedFile);
    await page.locator('#askinput-value').fill('passphrase di prova');
    assert.equal(await page.locator('#askinput-value').getAttribute('type'), 'password');
    await page.locator('#askinput-value').press('Enter');
    await page.waitForFunction(() => window.arcMessages.some(m => m.event === 'connections:import'));
    assert.equal(await page.evaluate(() => window.arcMessages.find(m => m.event === 'connections:import').payload.passphrase), 'passphrase di prova');
    await page.locator('#conn-import-file').setInputFiles(encryptedFile);
    await page.locator('#askinput-value').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('conn-import-btn').disabled);
    assert.equal(await page.evaluate(() => window.arcMessages.filter(m => m.event === 'connections:import').length), 1);
    ok('Import connessioni cifrate: passphrase Arc mascherata, invio reale del controller e annullamento senza import');
    await coverage('Griglia con checkbox di riga e selezione parziale');
    const selectAll = page.locator('#grid thead [role="checkbox"]');
    await page.locator('#grid tbody [role="checkbox"]').first().click();
    assert.equal(await selectAll.getAttribute('aria-checked'), 'mixed');
    assert.equal(await page.evaluate(async () => (await import('/js/state.js')).state.selectedDocs.size), 1);
    await selectAll.press('Space');
    assert.equal(await page.evaluate(async () => (await import('/js/state.js')).state.selectedDocs.size), 2);
    await selectAll.press('Space');
    assert.equal(await page.evaluate(async () => (await import('/js/state.js')).state.selectedDocs.size), 0);
    ok('Checkbox griglia: selezione reale, stato misto, tastiera e seleziona tutti');

    await page.evaluate(async () => {
      (await import('/js/state.js')).state.dbType = 'mysql';
      (await import('/js/schema-ops.js')).openCreateColl('catalogo');
    });
    await page.locator('#collcreate-name').fill('nuova_tabella');
    await coverage('DDL: righe dinamiche, datalist, default, NULL e chiavi');
    await page.locator('#collcreate-cols .col-name').fill('codice');
    await page.locator('#collcreate-cols .col-type').fill('BIGINT');
    await spuntaArc(page, '#collcreate-cols .col-null', true);
    await page.locator('#collcreate-save').click();
    await page.locator('#collcreate-error:not(.hidden)').waitFor();
    const ddl = await page.evaluate(() => window.arcMessages.find(m => m.event === 'collection:create'));
    assert.equal(ddl.payload.columns[0].name, 'codice');
    assert.equal(ddl.payload.columns[0].type, 'BIGINT');
    assert.equal(ddl.payload.columns[0].nullable, true);
    await page.keyboard.press('Escape');
    ok('Form DDL dinamico: payload reale e bozza conservata su errore');

    await page.evaluate(() => document.getElementById('btn-theme').click());
    await page.locator('#btn-tema-nuovo').click();
    await coverage('Editor tema: nome, base, colori, valori esadecimali');
    const swatch = page.locator('[data-scelta="accent"] + .arc-field-host [data-arc-component="color-picker"]');
    for (const theme of ['light', 'dark']) for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await scegliArc(page, '#tema-base', theme);
      await page.locator('#tema-nome').fill(`Tema Arc ${theme}`);
      await swatch.click();
      const popup = page.locator('[data-arc-color-popup]:popover-open');
      await popup.getByRole('textbox').fill('#146abc');
      await popup.getByRole('textbox').press('Enter');
      assert.equal(await page.locator('[data-scelta="accent"]').inputValue(), '#146abc');
      assert.equal(await page.locator('[data-scelta-hex="accent"]').inputValue(), '#146abc');
      await popup.getByRole('slider', { name: 'Tonalità', exact: true }).press('ArrowRight');
      assert.notEqual(await page.locator('[data-scelta="accent"]').inputValue(), '#146abc');
      const rect = await popup.boundingBox();
      report.layouts.push({ theme, width, rect });
      assert(rect.x >= 0 && rect.x + rect.width <= width + 1 && rect.y >= 0 && rect.y + rect.height <= 961, JSON.stringify(rect));
      await page.screenshot({ path: `${dir}/colore-${theme}-${width}.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      assert(await page.locator('#modal-theme').isVisible(), 'Escape deve chiudere solo ColorPicker');
      assert(await swatch.evaluate(e => e === document.activeElement));
      await coverage(`Tema ${theme}, ${width}px`);
    }
    await page.locator('[data-editor="salva"]').click();
    assert(await page.evaluate(() => localStorage.getItem('codedb:temi').includes('Tema Arc dark')));
    await page.keyboard.press('Escape');
    ok('ColorPicker: input Hex, slider, tema persistente, Escape e tre larghezze');

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.keyboard.press('Control+p');
    await page.locator('#palette-input').fill('>tema');
    await coverage('Palette dinamica');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => (await import('/js/snippet-manager.js')).openSnippetModal());
    await coverage('Snippet: Select e Textarea readonly');
    const snippetValue = await page.locator('#snippet-preset-select option').last().getAttribute('value');
    await scegliArc(page, '#snippet-preset-select', snippetValue);
    assert((await page.locator('#snippet-preview').inputValue()).length > 0);
    await page.keyboard.press('Escape');
    ok('Controlli dinamici di palette e snippet collegati ai rispettivi controller');

    await page.evaluate(async () => {
      document.getElementById('view-data').classList.add('hidden');
      for (const id of ['view-query', 'query-chart-view']) document.getElementById(id).classList.remove('hidden');
      for (const id of ['query-table-view', 'query-json-view']) document.getElementById(id)?.classList.add('hidden');
      await (await import('/js/charts.js')).renderChart([{ categoria: 'Nord', importo: 20 }, { categoria: 'Sud', importo: 30 }]);
    });
    await coverage('Grafici: barra rapida e configuratore completo');
    await scegliArc(page, '#chart-quickbar select[data-path="tipo"]', 'line');
    await page.waitForFunction(async () => (await import('/js/state.js')).state.chartCfg.serie[0].tipo === 'line');
    if (await page.locator('#chart-builder-panel').evaluate(e => e.classList.contains('collassato'))) await page.locator('#chart-toggle-builder').click();
    await page.locator('#chart-builder summary').filter({ hasText: /^Titolo$/ }).click();
    await coverage('Grafici ricostruiti dopo cambio tipo');
    const title = page.locator('#chart-builder input[data-path="titolo"]');
    await title.fill('Vendite per area'); await title.press('Tab');
    assert.equal(await page.evaluate(async () => (await import('/js/state.js')).state.chartCfg.titolo), 'Vendite per area');
    await page.screenshot({ path: `${dir}/grafici-1440.png`, animations: 'disabled' });
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Overflow grafici a ${width}px`);
      await page.screenshot({ path: `${dir}/grafici-${width}.png`, animations: 'disabled' });
    }
    ok('Select del grafico: cambio reale di tipo e ricostruzione dei controlli');

    await page.evaluate(async () => {
      const { createArcInput, controlElement } = await import('/arc/ui.js');
      const form = document.createElement('form'); form.id = 'arc-reset-date';
      const input = createArcInput({ type: 'date', 'aria-label': 'Data limite', min: '2026-10-07', max: '2026-10-09' });
      input.id = 'arc-reset-model';
      form.append(controlElement(input)); document.body.append(form);
      form.style.cssText = 'position:fixed;inset:100px 24px auto;z-index:9999;background:var(--surface);padding:16px';
    });
    const dateForm = page.locator('#arc-reset-date');
    await dateForm.getByRole('button', { name: 'Modifica data e ora in formato ISO' }).click();
    await dateForm.getByRole('textbox', { name: 'Data ISO', exact: true }).fill('2026-10-08');
    await dateForm.getByRole('button', { name: 'Data limite', exact: true }).click();
    const datePopup = page.locator('[data-arc-calendar-popup]:popover-open');
    assert(await datePopup.getByRole('gridcell', { name: 'martedì 6 ottobre 2026', exact: true }).isDisabled());
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#arc-reset-model').inputValue(), '2026-10-09');
    await dateForm.getByRole('textbox', { name: 'Data ISO', exact: true }).fill('non valida');
    await page.evaluate(() => document.getElementById('arc-reset-date').reset());
    await page.waitForFunction(() => document.getElementById('arc-reset-model').validity.valid && document.querySelector('#arc-reset-date [aria-label="Data ISO"]').value === '');
    await dateForm.getByRole('button', { name: 'Data limite', exact: true }).click();
    await datePopup.waitFor();
    await page.evaluate(() => { document.getElementById('arc-reset-date').hidden = true; });
    await datePopup.waitFor({ state: 'detached' });
    await page.evaluate(() => document.getElementById('arc-reset-date').remove());
    ok('DatePicker: limiti, frecce/Enter, data senza ora, reset e pulizia della bozza invalida');
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.requests, []);
    ok('Nessun errore JavaScript, hydration o risorsa locale mancante');
  } catch (error) {
    if (page) await page.screenshot({ path: `${dir}/${mutant ? 'mutant-' : ''}failure.png` }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(`${dir}/${mutant ? 'report-mutant' : 'report'}.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
