'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const mutantTarget = process.argv.includes('--mutant-target');
const dir = `test-reports/query-select-2026-10-12/${mutant || mutantTarget ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3231 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, hasTouch: true });
  const report = { layouts: [], errors: [] };
  page.on('pageerror', e => report.errors.push(e.message));
  page.setDefaultTimeout(5000);
  try {
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    if (mutant) await page.route('**/js/utils.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const original = "document.addEventListener('pointerdown', (e) => {";
      assert(source.includes(original));
      await route.fulfill({ response, body: source.replace(original, "document.addEventListener('click', (e) => {") });
    });
    if (mutantTarget) await page.route('**/js/query-tab.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const original = '${esc(coll)}</span>';
      assert(source.includes(original));
      await route.fulfill({ response, body: source.replace(original, '${coll}</span>') });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(() => {
      for (const id of ['welcome', 'placeholder']) document.getElementById(id).classList.add('hidden');
      for (const id of ['tab-body', 'workspace', 'view-query']) document.getElementById(id).classList.remove('hidden');
      for (const panel of document.querySelectorAll('#workspace .view-panel')) panel.classList.toggle('hidden', panel.id !== 'view-query');
    });
    const button = page.locator('#query-target-btn'), menu = page.locator('#query-target-menu');
    const context = async (db, coll) => page.evaluate(async ({ db, coll }) => {
      const { state } = await import('/js/state.js');
      Object.assign(state, { db, coll, queryDb: null, queryColl: null });
      (await import('/js/query-tab.js')).renderQueryTarget();
    }, { db, coll });
    await context('archivio_clienti_con_un_nome_molto_lungo', 'ordini <b>speciali</b>');
    assert.equal(await button.locator('b').count(), 0, 'I nomi dei database restano testo, mai markup');
    assert.equal(await button.locator('.query-target-current').textContent(), 'ordini <b>speciali</b>');
    assert((await button.getAttribute('title')).includes('archivio_clienti_con_un_nome_molto_lungo / ordini <b>speciali</b>'));
    await context('solo_database', null);
    assert.equal(await button.locator('.query-target-current').textContent(), 'solo_database');
    await context(null, null);
    assert((await button.textContent()).includes('nessun database selezionato'));
    await context('dropchecker', 'dailyhydrationstatuses');
    assert.equal(await button.locator('#query-target-label svg').count(), 1, 'La separazione tra database e collection è visibile');
    assert((await button.getAttribute('aria-labelledby')).includes('query-target-label'));
    const trigger = page.locator('[data-arc-for="query-target-engine"] [role="combobox"]');
    const popup = page.locator('[data-arc-select-popup]');
    const open = async (touch = false) => {
      if (!await menu.isVisible()) await button.click();
      if (touch) await trigger.tap(); else await trigger.click();
      await popup.waitFor(); await page.waitForTimeout(250);
      assert(await menu.isVisible(), 'Aprire la select deve mantenere aperto il menu che la contiene');
    };
    const checkPosition = async () => {
      const positions = await page.evaluate(() => {
        const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        return { trigger: rect(document.querySelector('[data-arc-for="query-target-engine"] [role="combobox"]')), popup: rect(document.querySelector('[data-arc-select-popup]')), width: innerWidth, height: innerHeight };
      });
      const { trigger: t, popup: p, width, height } = positions;
      assert(t.width > 0 && p.width > 0, 'Select e lista visibili');
      assert(p.right > t.x && p.x < t.right && Math.min(Math.abs(p.y - t.bottom), Math.abs(t.y - p.bottom)) < 12, `Lista ancorata alla select: ${JSON.stringify(positions)}`);
      assert(p.x >= 0 && p.right <= width + 1 && p.y >= 0 && p.bottom <= height + 1, `Lista dentro la finestra: ${JSON.stringify(positions)}`);
      assert(await popup.evaluate(el => Number(getComputedStyle(el.parentElement).zIndex) > Number(getComputedStyle(document.getElementById('query-target-menu')).zIndex)), 'La lista deve essere dipinta sopra il menu che la apre');
      return positions;
    };
    await open(); await checkPosition();
    for (const value of ['mysql', 'postgresql', 'mongodb', 'crossdb', 'auto']) {
      if (!await popup.count()) await open();
      const label = await page.locator('#query-target-engine').evaluate((el, value) => [...el.options].find(o => o.value === value).label, value);
      await page.getByRole('option', { name: label, exact: true }).click();
      await popup.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#query-target-engine').inputValue(), value);
      assert(await menu.isVisible(), 'La scelta mantiene accessibile il controllo');
    }
    await trigger.focus(); await trigger.press('ArrowDown');
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.activeElement?.textContent.includes('MySQL'));
    await page.keyboard.press('Enter');
    await popup.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#query-target-engine').inputValue(), 'mysql');
    await open(); await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'detached' });
    assert(await menu.isVisible(), 'Escape chiude prima la lista');
    assert(await trigger.evaluate(el => el === document.activeElement));
    await page.keyboard.press('Escape');
    assert(!await menu.isVisible());
    assert(await button.evaluate(el => el === document.activeElement));
    await open(); await page.mouse.click(1400, 650);
    await popup.waitFor({ state: 'detached' });
    assert(!await menu.isVisible(), 'Il clic esterno chiude entrambi i livelli');
    console.log('OK: tutte le opzioni, tastiera, Escape progressivo, focus e clic esterno.');
    for (const theme of ['dark', 'light']) for (const [width, height] of [[1440, 960], [390, 844], [320, 640], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      await page.locator('#query-target-engine').evaluate(el => { el.value = 'auto'; el.dispatchEvent(new Event('change', { bubbles: true })); });
      await context('dropchecker', 'dailyhydrationstatuses');
      await button.evaluate(el => el.blur());
      await page.locator('.query-topbar').screenshot({ path: `${dir}/barra-${theme}-${width}.png`, animations: 'disabled' });
      if (width === 1440) {
        const top = await page.locator('.query-topbar').boundingBox(), target = await button.boundingBox();
        await page.screenshot({ path: `${dir}/contesto-${theme}.png`, animations: 'disabled', clip: { x: top.x, y: top.y, width: target.x + target.width - top.x + 16, height: top.height } });
      }
      await context('archivio_clienti_con_un_nome_molto_lungo', 'dailyhydrationstatuses_con_un_nome_molto_lungo');
      const contextLayout = await button.evaluate(el => {
        const coll = el.querySelector('.query-target-current');
        const db = el.querySelector('.query-target-db');
        return { overflow: el.scrollWidth > el.clientWidth + 1, coll: coll.getBoundingClientRect().width, db: db.getBoundingClientRect().width };
      });
      assert(!contextLayout.overflow && contextLayout.coll > contextLayout.db && contextLayout.coll >= 44,
        `I nomi lunghi danno priorità alla collection: ${JSON.stringify(contextLayout)}`);
      assert((await button.getAttribute('title')).includes('dailyhydrationstatuses_con_un_nome_molto_lungo'));
      await context('dropchecker', 'dailyhydrationstatuses');
      await open(width < 600);
      report.layouts.push({ theme, ...await checkPosition() });
      const last = page.getByRole('option', { name: 'Cross-DB (Virtual JOIN)', exact: true });
      if (height < 450) {
        await page.keyboard.press('End');
        await page.waitForFunction(() => document.activeElement?.textContent.includes('Cross-DB'));
      } else await last.scrollIntoViewIfNeeded();
      assert(await last.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), 'Ultima opzione raggiungibile, senza ritagli o sovrapposizioni');
      await page.screenshot({ path: `${dir}/${theme}-${width}.png` });
      if (width < 600) await last.tap(); else await last.click();
      await popup.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#query-target-engine').inputValue(), 'crossdb');
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(report.errors, []);
    fs.writeFileSync(`${dir}/checks.json`, JSON.stringify(report, null, 2));
    console.log('OK: 8 layout chiari/scuri, mouse e tocco, posizione e opzioni non ritagliate.');
  } catch (error) {
    await page.screenshot({ path: `${dir}/failure.png` });
    throw error;
  } finally {
    await browser.close(); await server.stop();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
