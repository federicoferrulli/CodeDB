'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const mutantScroll = process.argv.includes('--mutant-scroll');
const dir = `test-reports/pending-design-2026-10-12/${mutant ? 'mutante' : mutantScroll ? 'mutante-scroll' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

// Dati illustrativi, isolati dal registro e dalle connessioni dell'utente.
const fixture = [
  { id: 'errore', connName: 'PostgreSQL · Sviluppo', db: 'diego_2', coll: 'Prova', engine: 'postgresql', status: 'error', elapsedMs: 9, code: 'SELECT *\nFROM Prova\nWHERE attivo = true;', error: 'La tabella indicata non esiste in questo database.\nCosa fare: se il nome ha delle maiuscole, va scritto fra doppi apici. PostgreSQL abbassa gli identificatori non quotati: usa diego_2."Prova".' },
  { id: 'script', connName: 'PostgreSQL · Sviluppo', db: 'diego_2', coll: 'Importazione clienti', engine: 'postgresql', kind: 'script', status: 'paused', code: 'INSERT INTO clienti (nome) VALUES (\'Ada\');\nINSERT INTO clienti (nome) VALUES (\'Luca\');', total: 8, eseguiti: 3, cursor: 3, falliti: 0 },
  { id: 'mongo', connName: 'MongoDB · Analisi', db: 'analytics', coll: 'eventi', engine: 'mongodb', status: 'disconnected', code: 'db.eventi.aggregate([\n  { $match: { tipo: "acquisto" } },\n  { $group: { _id: "$giorno", totale: { $sum: 1 } } }\n])' },
  { id: 'abbandonata', connName: 'MySQL · Locale', db: 'vendite', coll: 'ordini', engine: 'mysql', status: 'abbandonata', code: 'SELECT cliente, SUM(importo) AS totale\nFROM ordini\nGROUP BY cliente;', elapsedMs: 482 },
].map((q, i) => ({ runId: q.id, kind: 'query', startedAt: Date.now() - 60000 * (i + 1), ...q }));

(async () => {
  const server = await startTestServer({ port: 3233 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const report = { layouts: [], errors: [] };
  page.on('pageerror', e => report.errors.push(e.message));
  page.setDefaultTimeout(6000);
  try {
    await page.addInitScript(({ fixture, version }) => {
      sessionStorage.setItem('codedb:pending', JSON.stringify(fixture));
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true }));
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedQuery = text; } } });
    }, { fixture, version: require('../package.json').version });
    if (mutant) await page.route('**/js/pending-queries.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const original = 'selectedPendingId = id;';
      assert(source.includes(original));
      await route.fulfill({ response, body: source.replace(original, 'selectedPendingId = "errore";') });
    });
    if (mutantScroll) await page.route('**/css/workbench.css', async route => {
      const response = await route.fetch(), source = await response.text();
      const original = '#modal-pending .modal.pending-studio { width: 100%; height: auto; max-height: none; overflow-x: hidden; overflow-y: auto; }';
      assert(source.includes(original));
      await route.fulfill({ response, body: source.replace(original, original.replace('overflow-x: hidden; overflow-y: auto;', 'overflow: visible;')) });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      window.pending = await import('/js/pending-queries.js');
      window.pending.trackPending({ runId: 'live', code: 'SELECT COUNT(*) FROM fatture;', connName: 'MySQL · Produzione', db: 'vendite', coll: 'fatture', engine: 'mysql' });
    });
    await page.locator('#btn-pending-queries').click();
    await page.waitForSelector('#modal-pending[data-arc-dialog="open"]');
    await page.locator('.pending-item[data-id="errore"]').click();
    assert.equal(await page.locator('#pending-detail h3').textContent(), 'Prova');
    assert.equal(await page.locator('.pending-error p').textContent(), fixture[0].error);
    assert.equal(await page.locator('.pending-code code').textContent(), fixture[0].code);
    await page.locator('.btn-copy-pending').click();
    assert.equal(await page.evaluate(() => copiedQuery), fixture[0].code);
    await page.locator('.pending-item[data-id="script"]').click();
    assert.equal(await page.locator('#pending-detail h3').textContent(), 'Importazione clienti');
    assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '38');
    assert.match(await page.locator('.pending-progress-text').textContent(), /3\/8.*istruzione 4/);
    await page.locator('#pending-queries-list').press('ArrowDown');
    assert.equal(await page.locator('#pending-detail h3').textContent(), 'eventi');
    await page.locator('[data-pending-filter="running"]').click();
    assert.equal(await page.locator('.pending-item').count(), 1);
    assert.equal(await page.locator('#pending-detail h3').textContent(), 'fatture');
    assert.match(await page.locator('.btn-resume-pending').textContent(), /Apri nell’editor/);
    await page.locator('[data-pending-filter="review"]').click();
    assert.equal(await page.locator('.pending-item').count(), 4);
    await page.locator('#pending-search-input').fill('analytics');
    assert.equal(await page.locator('.pending-item').count(), 1);
    assert.equal(await page.locator('#pending-detail h3').textContent(), 'eventi');
    await page.locator('#pending-search-input').fill('nessuna-corrispondenza');
    assert.match(await page.locator('.pending-empty').textContent(), /Nessuna corrispondenza/);
    await page.locator('#pending-search-input').fill('');
    await page.locator('[data-pending-filter="all"]').click();
    await page.locator('.pending-item[data-id="errore"]').click();
    for (const theme of ['dark', 'light']) for (const [width, height] of [[1440, 1000], [1024, 768], [390, 844], [320, 640], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      await page.waitForTimeout(380);
      const geometry = await page.locator('.pending-studio').evaluate(el => {
        const r = el.getBoundingClientRect(), detail = document.querySelector('#pending-detail');
        return { x: r.x, right: r.right, width: innerWidth, overflow: el.scrollWidth > el.clientWidth + 2, detailOverflow: detail.scrollWidth > detail.clientWidth + 2,
          overlap: [...document.querySelectorAll('.pending-item')].some(row => row.scrollHeight > row.clientHeight + 2) };
      });
      assert(geometry.x >= -1 && geometry.right <= width + 1 && !geometry.overflow && !geometry.detailOverflow && !geometry.overlap, `Layout ${theme} ${width}: ${JSON.stringify(geometry)}`);
      report.layouts.push({ theme, width, ...geometry });
      await page.locator('.pending-heading').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${dir}/${theme}-${width}-registro.png`, animations: 'disabled' });
      await page.locator('.btn-resume-pending').scrollIntoViewIfNeeded();
      const actionVisible = await page.locator('.btn-resume-pending').evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth
          && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      });
      assert(actionVisible, `Riprendi raggiungibile e non coperta: ${theme} ${width}`);
      await page.locator('.btn-resume-pending').click();
      await page.getByText(/La sessione PostgreSQL.*è stata chiusa/).waitFor();
      await page.locator('#toast-container button[aria-label="Chiudi notifica"]').last().click();
      await page.getByText(/La sessione PostgreSQL.*è stata chiusa/).waitFor({ state: 'hidden' });
      await page.screenshot({ path: `${dir}/${theme}-${width}-dettaglio.png`, animations: 'disabled' });
      if (width === 1440) await page.locator('.pending-studio').screenshot({ path: `${dir}/finestra-${theme}.png`, animations: 'disabled' });
      if (width === 390) {
        await page.locator('.pending-back').click();
        await page.locator('.pending-item[data-id="script"]').click();
        await page.waitForFunction(() => {
          const r = document.querySelector('#pending-detail h3').getBoundingClientRect();
          return r.top > 0 && r.bottom < innerHeight;
        });
        assert.equal(await page.locator('#pending-detail h3').textContent(), 'Importazione clienti');
        await page.locator('.pending-back').click();
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'pending-queries-list');
        await page.locator('.pending-item[data-id="errore"]').click();
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.btn-resume-pending').click();
    await page.getByText(/La sessione PostgreSQL.*è stata chiusa/).waitFor();
    assert.equal(await page.evaluate(() => pending.listPending().length), 5, 'La ripresa senza connessione conserva il registro');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.pending-emblem').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.locator('.pending-item[data-id="mongo"]').click();
    assert.equal(await page.locator('#pending-detail').evaluate(el => el.getAnimations().length), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.pending-item[data-id="script"]').click();
    assert.equal(await page.locator('#pending-detail').evaluate(el => el.getAnimations()[0]?.effect.getTiming().duration), 220);
    await page.locator('.btn-resolve-pending').click();
    assert(!await page.evaluate(() => pending.listPending().some(q => q.id === 'script')));
    await page.locator('.pending-item[data-id="abbandonata"]').click();
    await page.locator('.btn-remove-pending').click();
    assert(!await page.evaluate(() => pending.listPending().some(q => q.id === 'abbandonata')));
    page.once('dialog', d => d.dismiss());
    await page.locator('#btn-clear-all-pending').click();
    assert.equal(await page.evaluate(() => pending.listPending().length), 3);
    page.once('dialog', d => d.accept());
    await page.locator('#btn-clear-resolved-pending').click();
    assert.deepEqual(await page.evaluate(() => pending.listPending().map(q => q.id)), ['live']);
    page.once('dialog', d => d.accept());
    await page.locator('#btn-clear-all-pending').click();
    assert.match(await page.locator('.pending-empty').textContent(), /Tutto in ordine/);
    assert(await page.locator('#btn-clear-all-pending').isDisabled());
    await page.screenshot({ path: `${dir}/vuoto.png` });
    await page.evaluate(() => {
      for (let i = 0; i < 160; i++) pending.trackPending({ runId: `volume-${i}`, db: 'volume', coll: `tabella_${i}`, code: `SELECT ${i}`, connName: 'Fixture' });
    });
    assert(await page.locator('.pending-item').count() < 20, 'Il registro conserva la virtualizzazione');
    await page.locator('#pending-queries-list').focus();
    await page.keyboard.press('End');
    assert.equal(await page.locator('#pending-detail h3').textContent(), 'tabella_0');
    assert(await page.locator('.pending-item').count() < 20);
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#pending-detail h3').textContent(), 'tabella_159');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#modal-pending.hidden', { state: 'attached' });
    await page.waitForFunction(() => document.activeElement?.id === 'btn-pending-queries');
    assert.deepEqual(report.errors, []);
    fs.writeFileSync(`${dir}/checks.json`, JSON.stringify(report, null, 2));
    console.log('OK: 10 layout, selezione, copia esatta, filtri, script, tastiera, pulizia annullabile, registro vuoto, 160 query virtualizzate e movimento ridotto.');
  } catch (e) { await page.screenshot({ path: `${dir}/failure.png` }); throw e; }
  finally { await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
