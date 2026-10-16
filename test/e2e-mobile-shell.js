'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.find(a => a.startsWith('--mutant='))?.split('=')[1];
const dir = `test-reports/mobile-shell/${mutant ? `mutante-${mutant}` : 'dopo'}`;

(async () => {
  const server = await startTestServer({ port: 3216 });
  const browser = await chromium.launch();
  fs.mkdirSync(dir, { recursive: true });
  let page;
  const errors = [];
  try {
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(7000);
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.shellMessages = [];
      window.CodeDBShell = { postMessage: message => window.shellMessages.push(JSON.parse(message)) };
    });
    await page.goto(server.url);
    await page.waitForSelector('#onboarding-overlay[data-arc-dialog="open"] .onb-scelta');
    await page.waitForTimeout(500);
    if (mutant === 'welcome') await page.addStyleTag({ content: '.onb-scelta-nota { grid-column: 1 !important; }' });
    const layout = await page.locator('.onb-scelta').evaluateAll(buttons => buttons.map(button => {
      const note = button.querySelector('.onb-scelta-nota').getBoundingClientRect();
      const title = button.querySelector('.onb-scelta-titolo').getBoundingClientRect();
      return { note: note.width, title: title.width, aligned: Math.abs(note.left - title.left) < 2 };
    }));
    await page.screenshot({ path: `${dir}/benvenuto.png` });
    assert(layout.every(b => b.note > 200 && b.aligned), `Descrizioni del benvenuto leggibili nella colonna del titolo: ${JSON.stringify(layout)}`);
    console.log('OK benvenuto mobile: descrizioni larghe e allineate');
    for (const [width, height, theme] of [[320, 740, 'light'], [844, 430, 'dark'], [1440, 900, 'dark']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      await page.waitForTimeout(400);
      const bounds = await page.locator('.onb-scelte').evaluate(el => ({
        overflow: el.scrollWidth > el.clientWidth + 1,
        buttons: [...el.querySelectorAll('button')].map(b => ({ h: b.clientHeight, bottom: b.getBoundingClientRect().bottom })),
        notes: [...el.querySelectorAll('.onb-scelta-nota')].map(n => n.clientWidth),
      }));
      assert(!bounds.overflow && bounds.notes.every(w => w > 150), `Testo integro a ${width}px`);
      assert(bounds.buttons.every(b => b.h >= 44), 'Bersagli tattili accessibili');
      if (height >= 700) assert(bounds.buttons.every(b => b.bottom <= height), 'Azioni visibili senza scorrimento iniziale');
      await page.screenshot({ path: `${dir}/benvenuto-${width}.png` });
    }
    await page.locator('[data-azione="chiudi"]').click();
    await page.waitForFunction(() => !document.querySelector('#onboarding-overlay').dataset.arcDialog);
    await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await page.setViewportSize({ width: 390, height: 844 });

    if (mutant === 'theme') await page.evaluate(() => { window.CodeDBShell.postMessage = () => {}; });
    for (const theme of ['light', 'dark', 'custom', 'auto']) {
      await page.evaluate(async id => {
        if (id === 'custom') {
          const { scelteIniziali } = await import('/js/theme-colori.js');
          localStorage.setItem('codedb:temi', JSON.stringify({ custom: { id: 'custom', nome: 'Bosco', base: 'dark', scelte: { ...scelteIniziali('dark'), bg: '#123b2c' } } }));
        }
        (await import('/js/theme.js')).scegliTema(id);
      }, theme);
      const colors = await page.evaluate(() => ({
        css: getComputedStyle(document.documentElement).getPropertyValue('--bg-surface').trim(),
        meta: document.querySelector('meta[name="theme-color"]').content,
        message: window.shellMessages.filter(m => m.op === 'theme').at(-1),
      }));
      assert.equal(colors.meta, colors.css, 'Barra browser sincronizzata al tema');
      assert.equal(colors.message.background, colors.css, 'Colore inoltrato al contenitore Android');
      assert.equal(colors.message.automatic, theme === 'auto');
    }
    assert(await page.evaluate(() => window.shellMessages.some(m => m.op === 'ready')), 'Splash rilasciato solo quando main ha inizializzato la UI');
    console.log('OK temi chiaro/scuro/personalizzato/automatico e segnale di interfaccia pronta');

    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'mobile-shell' });
      tab.label = 'Prova mobile'; tab.dbType = 'postgresql'; tabs.activeId = tab.id;
      const fields = [{ name: 'Nome Cliente', type: 'text' }, ...Array.from({ length: 40 }, (_, i) => ({ name: `campo_${i}`, type: 'text' }))];
      const collections = [{ name: 'Ordini', fields }], databases = [{ name: 'laboratorio', collections }];
      Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: tab.dbType, databases });
      const fake = { connected: true, on() { return fake; }, off() { return fake; }, emit(name, payload, ack) {
        ack?.({ ok: true, databases, collections, fields, indexes: [], docs: [], total: 0, columns: fields.map(f => f.name), relazioni: [] });
      } };
      (await import('/js/socket.js')).impostaSocket(fake);
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('laboratorio', 'Ordini');
      (await import('/js/main.js')).setView('query');
      (await import('/js/query-tab.js')).resetQueryView();
    });
    const editor = page.locator('#query-editor-input');
    await editor.fill('SELECT * FROM ');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      const q = (await import('/js/query-document.js')).queryDocument();
      q.savedCode = q.code; q.dirty = false;
    });
    await page.locator('#query-toggle-schema-btn').tap();
    const table = page.locator('[data-tipo="coll"][data-nome="Ordini"] > .schema-node-label');
    if (mutant === 'schema') await table.evaluate(el => el.addEventListener('click', e => { if (e.pointerType === 'touch') e.stopImmediatePropagation(); }, true));
    await table.tap(); await table.tap();
    await page.getByText('Inserito «"Ordini"» nella query.', { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), 'SELECT * FROM "Ordini"');
    assert(await page.evaluate(async () => (await import('/js/query-document.js')).queryDocument().dirty), 'Inserimento tracciato come modifica');
    assert(!await editor.evaluate(el => el === document.activeElement), 'Nessuna tastiera aperta dietro il drawer');
    await table.dispatchEvent('dblclick');
    assert.equal(await editor.inputValue(), 'SELECT * FROM "Ordini"', 'Nessun doppione dal dblclick sintetizzato dalla WebView');
    const field = page.locator('[data-tipo="campo"][data-nome="Nome Cliente"] > .schema-node-label');
    await field.tap(); await field.tap();
    assert.equal(await editor.inputValue(), 'SELECT * FROM "Ordini""Nome Cliente"');
    await page.getByText('Inserito «"Nome Cliente"» nella query.', { exact: true }).waitFor();
    console.log('OK doppio tocco su tabelle e campi: quoting, toast, stato modificato e nessun duplicato');

    const cdp = await page.context().newCDPSession(page);
    const swipe = async (x, y, dx, dy, cancel = false) => {
      const point = (a, b) => [{ x: a, y: b, id: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x, y) });
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x + dx * i / 12, y + dy * i / 12) });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(400);
    };
    await swipe(240, 470, 0, -180);
    assert(await page.locator('#query-schema-sidebar.open').count(), 'Scorrere i campi non chiude lo schema');
    assert(await page.locator('#query-schema-tree').evaluate(el => el.scrollTop > 0), 'Scorrimento nativo conservato');
    await swipe(240, 470, -150, 4, true);
    assert(await page.locator('#query-schema-sidebar.open').count(), 'Swipe annullato conserva lo schema');
    await swipe(240, 470, -22, 2);
    assert(await page.locator('#query-schema-sidebar.open').count(), 'Swipe breve torna al punto di partenza');
    if (mutant === 'swipe') await page.addStyleTag({ content: '.query-sidebar, .query-schema-tree { touch-action: auto !important; }' });
    await swipe(240, 470, -170, 4);
    assert.equal(await page.locator('#query-schema-sidebar.open').count(), 0, 'Swipe verso sinistra chiude lo schema');
    // Chromium assorbe talvolta il tap dopo touchMove CDP anche su una pagina vuota.
    // L'apertura usa la tastiera; trascinamento e annullamento restano veri eventi touch.
    await page.locator('#mobile-nav-conns').press('Enter');
    await page.waitForTimeout(400);
    if (mutant === 'cancel') await page.locator('.arc-navigation-sheet > div:first-child').evaluate(header => {
      header.addEventListener('pointercancel', e => header.dispatchEvent(new PointerEvent('pointerup', { pointerId: e.pointerId, pointerType: 'touch', bubbles: true })), true);
    });
    const handle = await page.locator('.arc-navigation-sheet [data-grabber]').boundingBox();
    await swipe(handle.x + handle.width / 2, handle.y + handle.height / 2, 0, 350, true);
    assert.equal(await page.locator('.arc-navigation-sheet').count(), 1, 'Gesto interrotto non chiude il pannello');
    const handle2 = await page.locator('.arc-navigation-sheet [data-grabber]').boundingBox();
    await swipe(handle2.x + handle2.width / 2, handle2.y + handle2.height / 2, 0, 350);
    assert.equal(await page.locator('.arc-navigation-sheet').count(), 0, 'Trascinamento verso il basso chiude il pannello');
    console.log('OK swipe schema, scroll nativo, soglie e annullamento; trascinamento dei pannelli');

    await page.locator('#query-toggle-schema-btn').press('Enter');
    assert(await page.evaluate(() => window.__codedbBack()), 'Indietro intercettato dal pannello aperto');
    await page.waitForFunction(() => !document.querySelector('#query-schema-sidebar').classList.contains('open'));
    assert.equal(await page.evaluate(() => window.__codedbBack()), false, 'Nessun pannello: Indietro torna al sistema');
    assert.equal(await editor.inputValue(), 'SELECT * FROM "Ordini""Nome Cliente"', 'Navigazione conserva il lavoro');
    assert.deepEqual(errors, []);
    console.log('OK Indietro: prima chiude il pannello, conserva la query, poi restituisce il controllo al sistema');
  } catch (error) {
    await page?.screenshot({ path: `${dir}/errore.png` }).catch(() => {});
    console.error('Errori browser:', errors);
    throw error;
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
