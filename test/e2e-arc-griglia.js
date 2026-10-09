'use strict';

// UI e payload reali, trasporto controllato: nessuna scrittura sui DB dell'utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const dir = 'test-reports/arc/griglia';
const mutant = process.argv.includes('--mutant');
const mutantCalendar = process.argv.includes('--mutant-calendar');
const mutantDate = process.argv.includes('--mutant-date');
const variant = mutantDate ? 'date-mutant' : mutantCalendar ? 'calendar-mutant' : mutant ? 'mutant' : '';
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync('test-reports/arc/datepicker', { recursive: true });
const report = { checks: [], layouts: [], errors: [], requests: [] };
const checked = name => { report.checks.push(name); console.log('OK', name); };

(async () => {
  const server = await startTestServer({ port: Number(process.env.E2E_ARC_GRID_PORT) || 3167 });
  const browser = await chromium.launch();
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => report.errors.push(e.stack));
    page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) report.errors.push(m.text()); });
    page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(server.url)) report.requests.push([r.url(), r.status()]); });
    if (mutant) await page.route('**/js/inlineEdit.js', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync('public/js/inlineEdit.js', 'utf8').replace("if (input.dataset.arcComponent === 'select' && input.dataset.state === 'open') return;", '') }));
    if (mutantDate) await page.route('**/js/inlineEdit.js', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync('public/js/inlineEdit.js', 'utf8').replace("if (input.dataset.arcComponent === 'select') input.addEventListener('change', save);", "if (input.dataset.arcComponent === 'select' || input.classList.contains('arc-inline-date-model')) input.addEventListener('change', save);") }));
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    if (mutantCalendar) await page.addStyleTag({ content: '[data-arc-calendar-highlight] { height: auto !important; aspect-ratio: 1 !important; }' });
    await page.waitForTimeout(1000);
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    if (await page.getByRole('button', { name: 'Nascondi i primi passi' }).isVisible()) await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { state } = await import('/js/state.js');
      const { impostaSocket } = await import('/js/socket.js');
      const { renderGrid } = await import('/js/grid.js');
      const { startEdit } = await import('/js/inlineEdit.js');
      const tab = createTab({ id: 'arc-grid-origin', connName: null });
      tab.dbType = 'mongodb'; tabs.activeId = tab.id;
      Object.assign(state, { connected: true, db: 'catalogo', coll: 'prodotti', dbType: 'mongodb',
        docs: [{ _id: 'p1', nome: 'Sensore', attivo: true, prezzo: { $numberDecimal: '123.456789012345678' },
          creato: { $date: '2026-10-07T10:00:00.123Z' }, riferimento: { $oid: '0123456789abcdef01234567' } }],
        columns: ['_id', 'nome', 'attivo', 'prezzo', 'creato', 'riferimento'], total: 1, exhausted: true });
      window.arcWrites = [];
      window.arcPreviews = [];
      window.arcFields = [
        { name: 'nome', types: ['string'], nullable: false },
        { name: 'attivo', types: ['boolean'], nullable: true },
        { name: 'codice', types: ['long'], nullable: true },
        { name: 'creato', types: ['date'], nullable: true },
        { name: 'posizione', types: ['geojson'], nullable: true },
      ];
      impostaSocket({ on() {}, off() {}, emit(event, msg, cb) {
        if (!cb) return;
        if (event === 'doc:duplicate') {
          window.arcPreviews.push(structuredClone(msg));
          cb({ ok: true, doc: JSON.stringify({ nome: 'Sensore copia', codice: { $numberLong: '9007199254740993' } }) }); return;
        }
        if (/^(doc:|column:)/.test(event)) {
          window.arcWrites.push({ event, ...structuredClone(msg) });
          if (window.arcHold) { window.arcAck = cb; return; }
          if (event === 'doc:update') Object.assign(state.docs[0], msg.set);
          cb({ ok: true }); return;
        }
        if (event === 'collection:stats') { cb({ ok: true, fields: window.arcFields }); return; }
        if (event === 'collection:relations') { cb({ ok: true, relazioni: [] }); return; }
        if (event === 'collection:find') { cb({ ok: true, docs: state.docs, columns: state.columns, total: 1 }); return; }
        cb({ ok: true });
      } });
      window.arcContext = { tabId: tab.id, db: 'catalogo', coll: 'prodotti', dbType: 'mongodb', isStillActive: () => false, onSaveSuccess: () => renderGrid() };
      window.arcEdit = field => {
        const td = document.querySelector(`#grid tbody td[data-c="${state.columns.indexOf(field)}"]`);
        startEdit(td, state.docs[0], field, { ctx: window.arcContext, relazione: null, onRender: () => renderGrid() });
      };
      for (const id of ['tab-body', 'workspace', 'view-data']) document.getElementById(id)?.classList.remove('hidden');
      for (const id of ['welcome', 'placeholder']) document.getElementById(id)?.classList.add('hidden');
      renderGrid();
    });
    const editor = page.locator('#grid td.editing');
    const countWrites = () => page.evaluate(() => window.arcWrites.length);
    await page.evaluate(() => window.arcEdit('nome'));
    assert.equal(await editor.locator('[data-arc-component="input"]').count(), 1);
    await editor.locator('input').fill('Da annullare');
    await page.keyboard.press('Escape');
    assert.equal(await countWrites(), 0);
    await page.evaluate(() => window.arcEdit('nome'));
    await editor.locator('input').fill('Sensore aggiornato');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.arcWrites.length === 1);
    assert.deepEqual(await page.evaluate(() => window.arcWrites[0].set), { nome: 'Sensore aggiornato' });
    assert.equal(await page.evaluate(() => window.arcWrites[0].coll), 'prodotti');
    await page.evaluate(() => window.arcEdit('prezzo'));
    await editor.locator('input').fill('999.123456789012345678');
    await page.locator('#filter-input').focus();
    await page.waitForFunction(() => window.arcWrites.length === 2);
    assert.deepEqual(await page.evaluate(() => window.arcWrites[1].set.prezzo), { $numberDecimal: '999.123456789012345678' });
    checked('Input inline: Escape annulla, Enter e blur salvano valore esatto e contesto');

    await page.evaluate(() => window.arcEdit('attivo'));
    await editor.getByRole('combobox').press('Enter');
    await page.getByRole('option', { name: 'false', exact: true }).waitFor();
    assert.equal(await countWrites(), 2, 'Aprire le opzioni non deve salvare o smontare la cella');
    await page.keyboard.press('Escape');
    assert.equal(await editor.count(), 1);
    assert(await editor.getByRole('combobox').evaluate(e => e === document.activeElement));
    await editor.getByRole('combobox').click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.activeElement?.textContent === 'false');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.arcWrites.length === 3);
    assert.deepEqual(await page.evaluate(() => window.arcWrites[2].set), { attivo: false });
    checked('Select booleano: tastiera, popup, Escape e scelta senza salvataggio al blur interno');

    await page.evaluate(() => window.arcEdit('creato'));
    const calendar = page.locator('[data-arc-calendar-popup]:popover-open');
    const dateTrigger = editor.getByRole('button', { name: 'Data UTC', exact: true });
    const timeInput = editor.getByRole('textbox', { name: 'Ora UTC (ore, minuti, secondi e millisecondi)' });
    await page.waitForFunction(() => document.querySelector('#grid td.editing .arc-time-input')?.value === '10:00:00.123');
    assert.equal(await timeInput.getAttribute('data-arc-component'), 'input');
    const rowHeight = await editor.evaluate(e => e.parentElement.getBoundingClientRect().height);
    assert(rowHeight <= 34, `Il datepicker allarga la riga a ${rowHeight}px`);
    await dateTrigger.click();
    await calendar.waitFor();
    assert.equal(await calendar.getByRole('gridcell', { name: 'mercoledì 7 ottobre 2026', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await calendar.locator('input').count(), 0, 'Nessun form aggiuntivo nel calendario');
    assert.equal(await calendar.getByRole('button', { name: /Applica|Annulla|ISO/ }).count(), 0);
    const writesBeforeCalendar = await countWrites();
    await page.screenshot({ path: `${dir}/calendario-inline-1440.png`, animations: 'disabled' });
    await calendar.getByRole('gridcell', { name: 'giovedì 8 ottobre 2026', exact: true }).click();
    await calendar.waitFor({ state: 'detached' });
    assert.equal(await countWrites(), writesBeforeCalendar, 'Scegliere la data deve lasciare modificabile anche l’ora');
    await timeInput.fill('15:16:17.456');
    assert.equal(await countWrites(), writesBeforeCalendar, 'Scrivere l’ora non deve inviare valori parziali');
    await timeInput.press('Enter');
    await editor.waitFor({ state: 'detached' });
    assert.equal(await countWrites(), writesBeforeCalendar + 1);
    assert.deepEqual(await page.evaluate(() => window.arcWrites.at(-1).set.creato), { $date: '2026-10-08T15:16:17.456Z' });
    const beforeCancelDate = await countWrites();
    await page.evaluate(() => window.arcEdit('creato'));
    await timeInput.fill('20:21:22.789');
    await dateTrigger.click();
    await page.keyboard.press('Escape');
    await calendar.waitFor({ state: 'detached' });
    assert(await dateTrigger.evaluate(e => e === document.activeElement));
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'detached' });
    assert.equal(await countWrites(), beforeCancelDate, 'Escape esce senza scrivere');
    await page.evaluate(() => window.arcEdit('creato'));
    for (const theme of ['light', 'dark']) for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
      await dateTrigger.click();
      await calendar.waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const rect = await calendar.boundingBox();
      assert(rect.x >= 0 && rect.x + rect.width <= width + 1 && rect.y >= 0 && rect.y + rect.height <= 961, JSON.stringify(rect));
      const selected = await calendar.locator('[data-present] [aria-selected="true"]').boundingBox();
      const disc = await calendar.locator('[data-present] [data-arc-calendar-highlight]').boundingBox();
      assert(Math.abs(selected.y + selected.height / 2 - disc.y - disc.height / 2) < 1, `Selezione calendario disallineata a ${width}px`);
      assert(await timeInput.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'L’ora completa deve essere leggibile');
      await page.screenshot({ path: `test-reports/arc/datepicker/inline-${theme}-${width}.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await calendar.waitFor({ state: 'detached' });
      assert(await editor.isVisible(), 'Escape chiude il pannello, non salva la cella');
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await dateTrigger.press('ArrowDown');
    await calendar.waitFor();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await calendar.waitFor({ state: 'detached' });
    await timeInput.fill('23:59:59.999');
    await timeInput.press('Enter');
    await editor.waitFor({ state: 'detached' });
    assert.equal(await countWrites(), beforeCancelDate + 1);
    assert.equal(await page.evaluate(() => window.arcWrites.at(-1).set.creato.$date), '2026-10-09T23:59:59.999Z');
    await page.evaluate(() => window.arcEdit('creato'));
    const beforeInvalidTime = await countWrites();
    await timeInput.fill('24:61');
    await timeInput.press('Enter');
    assert.equal(await countWrites(), beforeInvalidTime);
    assert.equal(await timeInput.inputValue(), '24:61', 'L’ora invalida resta correggibile');
    await editor.getByRole('alert').waitFor();
    assert.equal(await editor.evaluate(e => e.parentElement.getBoundingClientRect().height), rowHeight, 'L’errore non deve alterare l’altezza della riga');
    await timeInput.fill('00:00:00.001');
    await page.locator('#filter-input').focus();
    await editor.waitFor({ state: 'detached' });
    assert.equal(await countWrites(), beforeInvalidTime + 1);
    assert.equal(await page.evaluate(() => window.arcWrites.at(-1).set.creato.$date), '2026-10-09T00:00:00.001Z');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    checked('Data e ora inline: precisione UTC, Invio/blur, Escape, validazione correggibile, tastiera e due temi a tre larghezze');
    await page.evaluate(async () => {
      const { state } = await import('/js/state.js');
      state.docs = Array.from({ length: 201 }, (_, i) => ({ ...state.docs[0], _id: `p${i + 1}` }));
      state.total = 201;
      (await import('/js/grid.js')).renderGrid();
      window.arcEdit('creato');
    });
    assert(await page.locator('#grid').evaluate(e => e.classList.contains('virtual')));
    await timeInput.fill('12:34:56.789');
    await timeInput.scrollIntoViewIfNeeded();
    assert(await timeInput.evaluate(el => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.right - 4, r.y + r.height / 2) === el;
    }), 'La griglia virtualizzata non deve tagliare il campo ora');
    assert.equal(await editor.evaluate(e => e.parentElement.getBoundingClientRect().height), rowHeight);
    await timeInput.press('Enter');
    await editor.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.arcWrites.at(-1).set.creato.$date), '2026-10-09T12:34:56.789Z');
    await page.evaluate(async () => {
      const { state } = await import('/js/state.js');
      state.docs = state.docs.slice(0, 1); state.total = 1;
      (await import('/js/grid.js')).renderGrid();
    });
    checked('Griglia virtualizzata: ora modificabile e non tagliata, altezza riga invariata');
    const beforeInvalid = await countWrites();
    await page.evaluate(() => window.arcEdit('riferimento'));
    await editor.locator('input').fill('non valido');
    await page.keyboard.press('Enter');
    assert.equal(await countWrites(), beforeInvalid);
    await page.getByRole('alert').filter({ hasText: 'ObjectId non valido' }).waitFor();
    checked('Date UTC e ObjectId: conversione conservata, valore invalido non inviato');

    await page.evaluate(async () => {
      const { openEditDoc } = await import('/js/inlineEdit.js');
      openEditDoc({ _id: 'p1', nome: 'Sensore' }, window.arcContext);
    });
    await page.waitForSelector('#editdoc-overlay[data-arc-dialog="open"]');
    assert.equal(await page.locator('#editdoc-json').getAttribute('data-arc-component'), 'textarea');
    await page.locator('#editdoc-json').fill('{ nome:');
    await page.locator('#editdoc-save').click();
    await page.locator('#editdoc-error [role="alert"]').waitFor();
    assert.equal(await countWrites(), beforeInvalid);
    await page.locator('#editdoc-json').fill('{"nome":"Sensore","codice":{"$numberLong":"9007199254740993"}}');
    await page.locator('#editdoc-format').click();
    assert.match(await page.locator('#editdoc-json').inputValue(), /9007199254740993/);
    await page.locator('#editdoc-minify').click();
    await page.locator('#editdoc-save').click();
    await page.waitForSelector('#editdoc-overlay.hidden', { state: 'attached' });
    assert.equal(await page.evaluate(() => window.arcWrites.at(-1).event), 'doc:replace');
    checked('Textarea documento: lint, formattazione, minificazione e payload doc:replace');

    // Il dialogo di duplicazione è creato dal menu al primo utilizzo.
    const openDuplicate = async () => {
      await page.locator('#grid tbody td[data-c="1"]').click({ button: 'right' });
      await page.locator('#context-menu li').filter({ hasText: 'Duplica riga' }).click();
      await page.locator('#context-menu li').filter({ hasText: 'Duplica e modifica' }).click();
      await page.waitForSelector('#duprow-overlay[data-arc-dialog="open"]');
      await page.waitForFunction(() => document.getElementById('duprow-json').value.includes('Sensore copia'));
    };
    await openDuplicate();
    assert.equal(await page.locator('#duprow-json').getAttribute('data-arc-component'), 'textarea');
    assert.equal(await page.locator('#duprow-ok').getAttribute('data-arc-component'), 'button');
    assert(await page.locator('#duprow-chiavi').isChecked());
    await page.locator('#duprow-chiavi').click();
    await page.waitForFunction(() => window.arcPreviews.length === 2);
    assert.equal(await page.evaluate(() => window.arcPreviews.at(-1).conChiavi), false);
    await page.locator('#duprow-json').fill('{');
    await page.locator('#duprow-ok').click();
    await page.locator('#duprow-error [role="alert"]').waitFor();
    await page.locator('#duprow-cancel').click();
    await openDuplicate();
    const beforeDuplicate = await countWrites();
    await page.locator('#duprow-ok').click();
    await page.waitForSelector('#duprow-overlay.hidden', { state: 'attached' });
    assert.equal(await countWrites(), beforeDuplicate + 1, 'Riaprire non deve duplicare il listener di invio');
    assert.equal(await page.evaluate(() => JSON.parse(window.arcWrites.at(-1).doc).codice.$numberLong), '9007199254740993');
    checked('Duplica e modifica: Arc dinamico, anteprima, checkbox, validazione e riapertura senza doppi invii');

    await page.evaluate(async () => (await import('/js/insert.js')).openInsertDocForContext(window.arcContext));
    await page.waitForSelector('#insert-form tbody tr:nth-child(5)');
    const row = name => page.locator('#insert-form tbody tr').filter({ has: page.locator('td:first-child', { hasText: name }) });
    await row('nome').locator('input').fill('Nuovo sensore');
    await row('codice').locator('input').fill('9007199254740993');
    await row('attivo').getByRole('combobox').click();
    await page.getByRole('option', { name: 'false', exact: true }).click();
    assert.equal(await row('attivo').getByRole('combobox').evaluate(e => e.value), 'false');
    await row('attivo').getByRole('combobox').click();
    await page.keyboard.press('Escape');
    assert(await page.locator('#insert-overlay').isVisible(), 'Escape del Select non chiude il form');
    await page.locator('#insert-addfield').click();
    const extra = page.locator('#insert-form tbody tr').last();
    await extra.getByRole('textbox', { name: 'Nome del campo' }).fill('disponibile');
    await extra.getByRole('combobox').click();
    await page.getByRole('option', { name: 'booleano', exact: true }).click();
    await extra.locator('.insert-value').getByRole('combobox').click();
    await page.getByRole('option', { name: 'true', exact: true }).click();
    assert.deepEqual(await page.evaluate(async () => (await import('/js/insert.js')).buildInsertDoc()),
      { nome: 'Nuovo sensore', attivo: false, codice: { $numberLong: '9007199254740993' }, disponibile: true });
    await extra.getByRole('button', { name: 'Rimuovi campo' }).click();
    assert.equal(await page.locator('#insert-form tbody tr').count(), 5);
    checked('Inserimento: campi Arc dinamici, valore false distinto dal vuoto, cambio tipo e rimozione');

    await row('posizione').getByRole('button').click();
    await page.waitForSelector('#geomap-overlay[data-arc-dialog="open"]');
    assert.equal(await page.getByRole('dialog').count(), 1, 'Solo il dialogo superiore deve essere esposto');
    await page.locator('#geomap-type').click();
    await page.getByRole('option', { name: 'MultiPoint', exact: true }).click();
    assert.equal(await page.locator('#geomap-type').evaluate(e => e.value), 'MultiPoint');
    const geo = { type: 'MultiPoint', coordinates: [[12.5, 41.9], [9.2, 45.4]] };
    await page.locator('#geomap-json').fill(JSON.stringify(geo));
    await page.locator('#geomap-save').click();
    await page.waitForSelector('#geomap-overlay.hidden', { state: 'attached' });
    assert.equal(await page.getByRole('dialog').count(), 1, 'Il form deve tornare accessibile dopo la geometria');
    assert.deepEqual(await page.evaluate(async () => (await import('/js/insert.js')).buildInsertDoc().posizione), geo);
    checked('Geometria: Arc Button/Select/Textarea nel dialogo annidato, GeoJSON restituito alla bozza');

    await row('creato').getByRole('button', { name: 'Modifica data e ora in formato ISO' }).click();
    const iso = row('creato').getByRole('textbox', { name: 'Data ISO', exact: true });
    await iso.fill('2026-13-40T99:99');
    const beforeInvalidDate = await countWrites();
    await page.locator('#insert-save').click();
    await page.locator('#insert-error [role="alert"]').waitFor();
    assert.equal(await countWrites(), beforeInvalidDate, 'La data invalida non deve essere omessa né inviata');
    assert.equal(await iso.inputValue(), '2026-13-40T99:99');
    await iso.fill('2026-10-07T15:16:17.123');
    await row('creato').getByRole('textbox', { name: 'Ora UTC (ore, minuti, secondi e millisecondi)' }).fill('15:');
    assert(await page.evaluate(async () => { try { (await import('/js/insert.js')).buildInsertDoc(); return false; } catch { return true; } }));
    checked('Date invalide e ore incomplete: nessun invio, nessuna omissione silenziosa, bozza conservata');

    for (const theme of ['light', 'dark']) for (const width of [390, 768, 1440]) {
      await page.locator('[data-arc-select-popup]').waitFor({ state: 'detached' });
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
      if (!await row('creato').getByRole('textbox', { name: 'Data ISO', exact: true }).isVisible()) await row('creato').getByRole('button', { name: 'Modifica data e ora in formato ISO' }).click();
      await row('creato').getByRole('textbox', { name: 'Data ISO', exact: true }).fill('2026-10-07T15:16:17.123');
      await row('creato').getByRole('button', { name: 'Data e ora in UTC', exact: true }).click();
      await calendar.getByRole('gridcell', { name: 'giovedì 8 ottobre 2026', exact: true }).waitFor();
      const rect = await calendar.boundingBox();
      assert(rect.x >= 0 && rect.x + rect.width <= width + 1 && rect.y >= 0 && rect.y + rect.height <= 961, JSON.stringify(rect));
      await page.screenshot({ path: `${dir}/calendario-${theme}-${width}.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await calendar.waitFor({ state: 'detached' });
      assert(await page.locator('#insert-overlay').isVisible(), 'Escape chiude il calendario, non il form');
      await row('attivo').getByRole('combobox').click();
      await page.getByRole('option', { name: 'false', exact: true }).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.evaluate(() => {
        const modal = document.querySelector('#insert-overlay .modal').getBoundingClientRect();
        const menu = document.querySelector('[data-arc-select-popup]').getBoundingClientRect();
        const wrap = document.querySelector('.insert-form-wrap');
        return { width: innerWidth, page: document.documentElement.scrollWidth, formOverflow: wrap.scrollWidth - wrap.clientWidth, modal: [modal.left, modal.right], menu: [menu.left, menu.right] };
      });
      report.layouts.push({ theme, ...layout });
      assert(layout.page <= width + 1 && layout.modal[0] >= 0 && layout.modal[1] <= width + 1 && layout.menu[0] >= 0 && layout.menu[1] <= width + 1, JSON.stringify(layout));
      assert(layout.formOverflow <= 1, `Campi tagliati nel form: ${JSON.stringify(layout)}`);
      await page.screenshot({ path: `${dir}/inserimento-${theme}-${width}.png` });
      await page.keyboard.press('Escape');
    }
    await page.evaluate(() => { window.arcHold = true; });
    await page.locator('#insert-save').click();
    assert(await page.locator('#insert-save').isDisabled());
    await page.evaluate(() => { window.arcAck({ ok: false, error: 'Vincolo univoco: nome già presente' }); window.arcHold = false; });
    await page.locator('#insert-error [role="alert"]').waitFor();
    assert.equal(await row('nome').locator('input').inputValue(), 'Nuovo sensore');
    assert.equal(await page.locator('#insert-save').isDisabled(), false);
    await page.locator('#insert-save').click();
    await page.waitForSelector('#insert-overlay.hidden', { state: 'attached' });
    assert.equal(await page.evaluate(() => window.arcWrites.at(-1).event), 'doc:insert');
    checked('Form e popup a 390/768/1440, due temi; errore server conserva bozza e permette riprova');

    await page.evaluate(async () => {
      const { state } = await import('/js/state.js'); state.dbType = 'mysql';
      (await import('/js/schema-ops.js')).openColumnModal({ name: 'nome', types: ['varchar(255)'], nullable: true });
    });
    await page.waitForSelector('#coledit-overlay[data-arc-dialog="open"]');
    const nullable = page.locator('#coledit-null');
    assert.equal(await nullable.getAttribute('data-arc-component'), 'checkbox');
    assert(await nullable.isChecked());
    await nullable.focus();
    await page.keyboard.press('Space');
    assert.equal(await nullable.isChecked(), false);
    await page.locator('#coledit-save').click();
    await page.waitForSelector('#coledit-overlay.hidden', { state: 'attached' });
    assert.equal(await page.evaluate(() => window.arcWrites.at(-1).column.nullable), false);
    await page.evaluate(async () => {
      const { state } = await import('/js/state.js'); state.dbType = 'mongodb';
      (await import('/js/schema-ops.js')).openColumnModal({ name: 'nome', types: ['string'] });
    });
    await page.locator('#coledit-bsontype').click();
    await page.getByRole('option', { name: 'long', exact: true }).click();
    assert.equal(await page.locator('#coledit-bsontype').evaluate(e => e.value), 'long');
    await page.locator('#coledit-cancel').click();
    checked('Modifica colonna: Checkbox NULL e Select conversione BSON');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => window.arcEdit('attivo'));
    await editor.getByRole('combobox').click();
    await page.getByRole('option', { name: 'true', exact: true }).waitFor();
    await page.screenshot({ path: `${dir}/inline-1440.png` });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      window.arcEdit('nome');
      const input = document.querySelector('#grid td.editing input');
      window.arcDetachedHost = (await import('/arc/ui.js')).controlElement(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await page.waitForFunction(() => !window.arcDetachedHost.isConnected && window.arcDetachedHost.childNodes.length === 0);
    checked('Smontaggio React quando la griglia elimina la cella in modifica');
    await page.waitForTimeout(350);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.requests, []);
    checked('Movimento standard e ridotto; nessun errore JS o risorsa locale mancante');
  } catch (error) {
    if (page) report.editing = await page.locator('#grid td.editing').evaluateAll(nodes => nodes.map(node => node.outerHTML));
    if (page) await page.screenshot({ path: `${dir}/${variant ? `${variant}-` : ''}failure.png` }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(`${dir}/report${variant ? `-${variant}` : ''}.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
