'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const dir = `${process.env.CODEDB_REPORT_ROOT || 'test-reports/dialog-drawer-2026-10-11'}/dialog${mutant ? '-mutante' : ''}`;
fs.mkdirSync(dir, { recursive: true });
(async () => {
  const server = await startTestServer({ port: 3191 }), browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const report = { checks: [], errors: [], defects: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('dialog', async dialog => { report.errors.push(`Dialog nativo inatteso: ${dialog.message()}`); await dialog.dismiss(); });
  try {
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    const ids = await page.locator('.overlay').evaluateAll(nodes => nodes.filter(node => node.querySelector('.modal')).map(node => node.id));
    for (const [width, height] of [[320, 650], [390, 844], [844, 390]]) {
      await page.setViewportSize({ width, height });
      for (const id of ids) {
        report.phase = `${id} ${width}×${height}`;
        await page.evaluate(async id => {
          const overlay = document.getElementById(id); window.drawerPanel = overlay.querySelector('.modal');
          (await import('/js/utils.js')).openModal(overlay);
        }, id);
        const sheet = page.locator(`#${id} .arc-dialog-sheet`);
        await sheet.waitFor();
        if (!await sheet.evaluate(el => el.hasAttribute('data-fit-content'))) await sheet.locator('[data-grabber]').press('Home');
        await page.waitForTimeout(160);
        if (mutant) await sheet.evaluate(el => el.style.width = '180px');
        const geometry = await sheet.evaluate(el => {
          const r = el.getBoundingClientRect(), panel = el.querySelector('.modal'), p = panel.getBoundingClientRect();
          const viewport = el.hasAttribute('data-fit-content') ? el.children[1].getBoundingClientRect() : p;
          return { width: r.width, top: r.top, bottom: viewport.bottom, same: panel === window.drawerPanel, overflow: panel.scrollWidth > panel.clientWidth + 1 };
        });
        if (!(geometry.same && !geometry.overflow && geometry.width >= width - 2 && geometry.top >= 0 && geometry.bottom <= height + 1)) {
          report.defects.push({ phase: report.phase, geometry });
          await page.screenshot({ path: `${dir}/${id}-${width}.png` });
        }
        if (['onboarding-overlay', 'modal-backup-manager', 'modal-audit-log'].includes(id)) await page.screenshot({ path: `${dir}/${id}-${width}.png` });
        await page.evaluate(async id => (await import('/js/utils.js')).closeModal(id, { saved: true }), id);
        await sheet.waitFor({ state: 'detached' });
      }
      report.checks.push(`${ids.length} dialog nel BottomSheet Arc a ${width}×${height}: identità, larghezza, limiti e scroll`);
    }
    assert.deepEqual(report.defects, [], 'Tutti i dialog devono rientrare nel drawer senza overflow');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.getElementById('conn-add-btn').click());
    await page.locator('#connect-overlay .arc-dialog-sheet').waitFor();
    const host = page.locator('#connect-form [name="host"]');
    await host.fill('bozza.example');
    await host.evaluate(el => { window.drawerInput = el; el.setSelectionRange(2, 5); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#connect-overlay .arc-dialog-shell').waitFor({ state: 'attached' });
    assert.equal(await host.inputValue(), 'bozza.example');
    assert(await host.evaluate(el => el === window.drawerInput && el.selectionStart === 2 && el.selectionEnd === 5));
    assert(await host.evaluate(el => document.activeElement === el), 'Il cambio a desktop conserva il focus nel campo');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#connect-overlay .arc-dialog-sheet').waitFor();
    assert(await host.evaluate(el => el === window.drawerInput));
    assert(await host.evaluate(el => document.activeElement === el), 'Il ritorno mobile conserva il focus nel campo');
    await page.screenshot({ path: `${dir}/connessione-390.png` });
    await page.evaluate(() => { import('/js/utils.js').then(m => m.chiediTesto({ titolo: 'Nome di prova', valore: 'bozza' })).then(value => window.drawerValue = value); });
    await page.locator('#askinput-overlay .arc-dialog-sheet').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.drawerValue === null);
    await page.waitForFunction(() => document.getElementById('connect-overlay').contains(document.activeElement));
    assert.equal(await host.inputValue(), 'bozza.example');
    await page.keyboard.press('Escape');
    report.checks.push('Cambio desktop/mobile: stesso input, bozza, selezione; dialog annidato e focus restituito');

    for (const close of ['pulsante', 'Escape']) {
      await page.locator('#command-palette-open').click();
      const palette = page.locator('#palette-overlay .arc-dialog-sheet');
      await palette.waitFor();
      await palette.locator('[data-grabber]').focus();
      if (close === 'pulsante') await palette.getByRole('button', { name: 'Chiudi finestra' }).click();
      else await page.keyboard.press('Escape');
      await page.locator('#palette-overlay').waitFor({ state: 'detached' });
    }
    report.checks.push('Palette dinamica nel drawer: chiusura dal pulsante e con Escape, riapertura del controller');

    await page.evaluate(async () => {
      const [{ createTab, tabs }, { impostaSocket }, workspace, colltabs] = await Promise.all(['tabs', 'socket', 'workspace', 'colltabs'].map(x => import(`/js/${x}.js`)));
      window.drawerWrites = [];
      impostaSocket({ on() {}, off() {}, emit(name, payload, cb) { if (name === 'doc:delete') window.drawerWrites.push(payload); cb?.({ ok: true, docs: [{ _id: 7, nome: 'Prova' }], total: 1, columns: ['_id', 'nome'], fields: [], indexes: [], relazioni: [] }); } });
      const t = createTab({ id: 'drawer-test' }); t.dbType = 'mongodb'; t.label = 'Fixture'; tabs.activeId = t.id;
      Object.assign(t.state, { connected: true, dbType: 'mongodb', databases: [{ name: 'origine', collections: [{ name: 'documenti' }] }] });
      workspace.renderWorkspace(); colltabs.openCollTab('origine', 'documenti');
    });
    for (const accept of [false, true]) {
      await page.evaluate(async () => { const grid = await import('/js/grid.js'); void grid.deleteDoc({ _id: 7 }); });
      await page.locator('#confirm-overlay .arc-dialog-sheet').waitFor();
      assert.equal(await page.evaluate(() => window.drawerWrites.length), 0);
      if (accept) {
        await page.screenshot({ path: `${dir}/conferma-390.png` });
        await page.evaluate(async () => { const { state } = await import('/js/state.js'); state.db = 'altro'; state.coll = 'altra'; });
        await page.locator('#confirm-ok').click();
        await page.waitForFunction(() => window.drawerWrites.length === 1);
        const write = await page.evaluate(() => window.drawerWrites[0]);
        assert.equal(write.db, 'origine'); assert.equal(write.coll, 'documenti'); assert.equal(write.id, '7');
      } else await page.locator('#confirm-cancel').click();
      await page.locator('#confirm-overlay .arc-dialog-sheet').waitFor({ state: 'detached' });
    }
    report.checks.push('Conferma mobile: nessuna cancellazione prima del consenso; annullamento e bersaglio conservato durante l’attesa');

    await page.evaluate(async () => {
      const { openModal, proteggiModifiche } = await import('/js/utils.js');
      proteggiModifiche('editdoc-overlay', 'drawer-test', 'documenti');
      openModal('editdoc-overlay');
      document.getElementById('editdoc-overlay').dataset.unsaved = 'true';
    });
    for (const accept of [false, true]) {
      await page.locator('#editdoc-overlay .arc-dialog-sheet').getByRole('button', { name: 'Chiudi finestra' }).click();
      await page.locator('#confirm-overlay .arc-dialog-sheet').waitFor();
      await page.locator(accept ? '#confirm-ok' : '#confirm-cancel').click();
      await page.locator('#confirm-overlay .arc-dialog-sheet').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#editdoc-overlay .arc-dialog-sheet').isVisible(), !accept);
    }
    await page.evaluate(async () => {
      const { tabs, closeTab } = await import('/js/tabs.js');
      tabs.list.find(t => t.id === 'drawer-test').state.collTabs[0].snapQuery = { dirty: true, code: 'bozza' };
      void closeTab('drawer-test');
    });
    await page.locator('#confirm-overlay .arc-dialog-sheet').waitFor();
    await page.locator('#confirm-cancel').click();
    assert(await page.evaluate(async () => (await import('/js/tabs.js')).tabs.list.some(t => t.id === 'drawer-test')));
    await page.evaluate(async () => { void (await import('/js/tabs.js')).closeTab('drawer-test'); });
    await page.locator('#confirm-overlay .arc-dialog-sheet').waitFor();
    await page.locator('#confirm-ok').click();
    await page.waitForFunction(async () => !(await import('/js/tabs.js')).tabs.list.some(t => t.id === 'drawer-test'));
    report.checks.push('Scarto bozza e disconnessione: annullamento conserva i dati, chiusura solo dopo conferma');
    await page.evaluate(async () => (await import('/js/utils.js')).openModal('vault-overlay'));
    const vault = page.locator('#vault-overlay .arc-dialog-sheet');
    await vault.waitFor(); await page.keyboard.press('Escape');
    assert(await vault.isVisible()); assert.equal(await vault.getByRole('button', { name: 'Chiudi finestra' }).count(), 0);
    report.checks.push('Vault nel drawer: la barriera non viene aggirata con Escape o chiusura');
    assert.deepEqual(report.errors, []);
    console.log('OK', report.checks.join('\nOK '));
  } catch (error) { report.failure = error.stack; await page.screenshot({ path: `${dir}/failure.png` }); throw error; }
  finally { fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
