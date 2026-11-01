'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

const mutant = process.argv.includes('--mutant');

(async () => {
  const server = await startTestServer({ port: 3183 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.stack || err.message));
  try {
    await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    if (mutant) await page.route('**/js/query-editor.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      assert(source.includes('range.surroundContents(segno);'));
      await route.fulfill({ response, body: source.replace('range.surroundContents(segno);', '/* Mutazione: il token errato non viene segnato. */') });
    });
    if (process.argv.includes('--mutant=tooltip')) await page.route('**/js/query-editor.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const original = 'mostraSuggerimentoErrore(erroreQuery.messaggio, anchor)';
      assert(source.includes(original));
      await route.fulfill({ response, body: source.replace(original, 'void 0') });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'errore-editor-fixture' });
      tab.dbType = 'postgresql'; tabs.activeId = tab.id;
      const fields = [{ name: 'id', type: 'integer' }];
      const collections = [{ name: 'Prova', fields }];
      const databases = [{ name: 'diego', collections }];
      Object.assign(tab.state, { connected: true, dbType: tab.dbType, databases });
      const fake = { connected: true, on() { return fake; }, off() { return fake; }, emit(name, payload, ack) {
        ack?.({ ok: true, databases, collections, fields, columns: fields.map(f => f.name), indexes: [], docs: [], total: 0, relazioni: [] });
      } };
      (await import('/js/socket.js')).impostaSocket(fake);
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('diego', 'Prova');
      (await import('/js/main.js')).setView('query');
      window.queryMark = await import('/js/query-editor.js');
      window.queryView = await import('/js/query-tab.js');
    });

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const code = `-- 😀 conserva UTF-16 e caratteri < > &\nSELECT id\n${'-- riga intermedia\n'.repeat(25)}FROM ${'schema_lungo_'.repeat(15)}."nome&inesistente";`;
      const start = code.indexOf('"nome&inesistente"');
      await page.locator('#query-editor-input').fill(code);
      const state = await page.evaluate(({ code, start }) => {
        const editor = document.getElementById('query-editor-input');
        editor.setSelectionRange(7, 12);
        document.getElementById('query-run-btn').focus();
        queryMark.segnalaErroreQuery({ start, end: start + '"nome&inesistente"'.length }, '<img src=x> Nome tabella errato', code);
        queryMark.aggiornaSegnalazioneErrore();
        const marks = [...document.querySelectorAll('.query-error-mark')];
        const first = marks[0];
        const rect = first?.getBoundingClientRect();
        const editorRect = editor.getBoundingClientRect();
        return {
          code: document.getElementById('query-editor-code').textContent,
          marked: marks.map(el => el.textContent).join(''),
          style: first && getComputedStyle(first).textDecorationStyle,
          underline: first && getComputedStyle(first).textDecorationLine,
          selection: [editor.selectionStart, editor.selectionEnd],
          focus: document.activeElement.id,
          accessible: document.getElementById('query-editor-error-message')?.textContent,
          valid: editor.getAttribute('aria-invalid'),
          injection: !!document.querySelector('#query-editor-error-message img'),
          inView: !!rect && rect.top >= editorRect.top && rect.bottom <= editorRect.bottom && rect.left >= editorRect.left && rect.right <= editorRect.right,
          scroll: [editor.scrollTop, editor.scrollLeft, document.getElementById('query-editor-highlight').scrollTop, document.getElementById('query-editor-highlight').scrollLeft],
        };
      }, { code, start });
      assert.equal(state.marked, '"nome&inesistente"', 'Viene sottolineato soltanto il token indicato');
      assert.equal(state.code, code, 'Il rendering conserva il codice alla lettera');
      assert.equal(state.style, 'wavy'); assert.equal(state.underline, 'underline');
      assert.deepEqual(state.selection, [7, 12]); assert.equal(state.focus, 'query-run-btn');
      assert.equal(state.accessible, '<img src=x> Nome tabella errato'); assert.equal(state.injection, false); assert.equal(state.valid, 'true');
      assert(state.inView, `Errore raggiungibile a ${width}px`);
      assert(state.scroll[0] > 0 && state.scroll[1] > 0);
      assert.deepEqual(state.scroll.slice(0, 2), state.scroll.slice(2));
      const rect = await page.locator('.query-error-mark').first().boundingBox();
      await page.mouse.move(rect.x + Math.min(4, rect.width / 2), rect.y + rect.height / 2);
      const tooltip = page.getByRole('tooltip');
      if (width > 900) {
        await tooltip.waitFor({ timeout: 3000 });
        assert.equal(await tooltip.textContent(), '<img src=x> Nome tabella errato');
        assert.equal(await tooltip.locator('img').count(), 0, 'Il messaggio viene mostrato come testo');
        const bounds = await tooltip.boundingBox();
        assert(bounds.x >= 12 && bounds.y >= 12 && bounds.x + bounds.width <= width - 12 && bounds.y + bounds.height <= 888);
        assert(bounds.width <= 320 && bounds.height <= 180, 'Il tooltip resta compatto');
      } else assert.equal(await tooltip.count(), 0, 'Nessun tooltip mobile');
      await page.locator('#query-editor-input').evaluate(el => el.dispatchEvent(new Event('scroll')));
      assert.equal(await tooltip.count(), 0, 'Lo scroll rimuove il messaggio dal vecchio punto');
      await page.mouse.move(rect.x + Math.min(5, rect.width / 2), rect.y + rect.height / 2);
      await page.locator('#query-editor-input').dispatchEvent('pointermove', { pointerType: 'touch', clientX: rect.x + 4, clientY: rect.y + rect.height / 2 });
      assert.equal(await tooltip.count(), 0, 'Il tocco non apre tooltip neppure su desktop');
      await page.mouse.move(0, 0);
      await tooltip.waitFor({ state: 'detached' });
      await page.evaluate(() => { queryView.updateEditorHighlight(); queryMark.aggiornaSegnalazioneErrore(); });
      assert.equal(await page.locator('.query-error-mark').allTextContents().then(texts => texts.join('')), '"nome&inesistente"');

      await page.locator('#query-editor-input').press('End');
      await page.locator('#query-editor-input').press(' ');
      assert.equal(await page.locator('.query-error-mark').count(), 0, 'Digitare rimuove il segno obsoleto');
      assert.equal(await page.locator('#query-editor-input').getAttribute('aria-invalid'), null);
    }

    const further = await page.evaluate(() => {
      const editor = document.getElementById('query-editor-input');
      editor.value = 'SELECT '; queryView.updateEditorHighlight();
      queryMark.segnalaErroreQuery({ start: 7, end: 7 }, 'Manca un’espressione', editor.value);
      const eof = document.querySelectorAll('.query-error-caret').length;
      const text = document.getElementById('query-editor-code').textContent;
      queryMark.segnalaErroreQuery({ start: 0, end: 2 }, 'Risposta precedente', 'ALTRA QUERY');
      const old = document.querySelectorAll('.query-error-mark').length;
      queryMark.segnalaErroreQuery({ start: -1, end: 4 });
      const invalid = document.querySelectorAll('.query-error-mark').length;
      queryMark.segnalaErroreQuery({ start: 0, end: 6 });
      editor.value = 'SELECT id'; queryView.updateEditorHighlight(); queryMark.aggiornaSegnalazioneErrore();
      const changed = document.querySelectorAll('.query-error-mark').length;
      queryMark.segnalaErroreQuery({ start: 7, end: 9 });
      queryMark.segnalaErroreQuery(null);
      return { eof, text, old, invalid, changed, cleared: document.querySelectorAll('.query-error-mark').length };
    });
    assert.deepEqual(further, { eof: 1, text: 'SELECT ', old: 0, invalid: 0, changed: 0, cleared: 0 });
    assert.deepEqual(errors, []);
    if (!mutant) {
      fs.mkdirSync('test-reports/query-error-mark', { recursive: true });
      await page.locator('#query-editor-input').fill('SELECT *\nFROM nome_inesistente;');
      await page.evaluate(() => queryMark.segnalaErroreQuery({ start: 14, end: 30 }, 'La tabella indicata non esiste.'));
      await page.screenshot({ path: 'test-reports/query-error-mark/mobile.png' });
      await page.setViewportSize({ width: 1100, height: 760 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.locator('#query-show-editor').click();
      const originalLayout = await page.locator('.query-editor-wrapper').evaluate(el => {
        const old = el.style.cssText;
        el.style.cssText = 'position:fixed;inset:auto 12px 12px auto;width:480px;height:70px;z-index:800';
        return old;
      });
      const message = 'La tabella indicata non esiste. Controlla nome e schema. ' + 'dettaglio_molto_lungo_'.repeat(60);
      await page.locator('#query-editor-input').fill('SELECT * FROM nome_inesistente;');
      await page.evaluate(message => queryMark.segnalaErroreQuery({ start: 14, end: 30 }, message), message);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(async theme => (await import('/js/theme.js')).applicaTema(theme), theme);
        const mark = await page.locator('.query-error-mark').boundingBox();
        await page.mouse.move(mark.x + mark.width - 2, mark.y + mark.height / 2);
        const tooltip = page.getByRole('tooltip');
        await tooltip.waitFor();
        const bounds = await tooltip.boundingBox();
        assert(bounds.x >= 12 && bounds.x + bounds.width <= 1088 && bounds.y >= 12 && bounds.y + bounds.height <= 748, 'Il messaggio lungo resta dentro i bordi dello schermo');
        assert(bounds.y + bounds.height <= mark.y, 'Vicino al bordo inferiore il tooltip si apre sopra');
        assert(await tooltip.evaluate(el => el.scrollHeight > el.clientHeight), 'Il contenuto lungo resta disponibile tramite scroll');
        assert.equal(await tooltip.textContent(), message);
        await page.mouse.move(bounds.x + 15, bounds.y + 15);
        await page.waitForTimeout(160);
        assert(await tooltip.isVisible(), 'Il tooltip resta aperto mentre si legge o si scorre il messaggio');
        await tooltip.evaluate(el => { el.scrollTop = 40; });
        assert(await tooltip.isVisible());
        await tooltip.evaluate(el => { el.scrollTop = 0; });
        await page.screenshot({ path: `test-reports/query-error-mark/tooltip-${theme}.png` });
        await page.keyboard.press('Escape');
        await tooltip.waitFor({ state: 'detached' });
      }
      await page.locator('.query-editor-wrapper').evaluate((el, style) => { el.style.cssText = style; }, originalLayout);
    }
    console.log('OK: token preciso, UTF-16, colori, scroll, cursore, accessibilità, modifica, snapshot e fine query su desktop/mobile.');
  } finally { await browser.close(); await server.stop(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
