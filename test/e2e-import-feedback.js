'use strict';

// UI reale, stato e trasporto simulati: nessuna scrittura nei database utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3218 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'it-IT', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    if (process.argv.includes('--mutant')) await page.route('**/js/exportimport.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const original = "$('#dbimport-form').classList.add('hidden');";
      assert(source.includes(original));
      await route.fulfill({ response, body: source.replace(original, '') });
    });
    await page.addInitScript(version => {
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
      localStorage.setItem('codedb:tema', 'dark');
    }, require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const [{ createTab, tabs }, { impostaSocket }] = await Promise.all(['tabs', 'socket'].map(n => import(`/js/${n}.js`)));
      const t = createTab({ id: 'import-feedback' });
      t.dbType = 'postgresql'; t.connName = 'PostgreSQL locale';
      Object.assign(t.state, { connected: true, dbType: 'postgresql' }); tabs.activeId = t.id;
      const f = window.importFixture = { operation: null, sent: [], notices: [], pending: null };
      document.addEventListener('codedb:toast', e => f.notices.push(e.detail.message));
      const fake = { connected: true, on() {}, off() {}, timeout() { return { emit: (n, p, cb) => fake.emit(n, p, r => cb(null, r)) }; }, emit(name, p, cb) {
        f.sent.push({ name, ...p });
        let reply = { ok: true, databases: [], collections: [] };
        if (name === 'database:import:list') reply.operations = f.operation ? [f.operation] : [];
        if (name === 'database:import:upload:start') Object.assign(reply, { uploadId: 'upload-feedback', maxBytes: 1048576, maxChunkBytes: 1024 });
        if (name === 'database:import:upload:finish') reply.artifact = { db: 'origine', dbType: 'postgresql', collections: [{ name: 't', rows: 1 }] };
        if (name === 'database:import:start') {
          if (p.previewOnly) reply.plan = { kind: 'import-database', fingerprint: 'piano-feedback', dbType: 'postgresql', sourceDb: 'origine', targetDb: p.targetDb, connection: 'PostgreSQL locale', collections: [{ name: 't', rows: 1 }] };
          else { f.set('in_corso'); reply.accepted = f.operation; }
        }
        if (name === 'database:import:state') { f.pending = cb; return; }
        if (name === 'database:import:cleanup') {
          f.operation.cleanupAt = '2026-10-27T10:20:00Z'; reply.operation = f.operation;
        }
        cb?.(reply);
      } };
      impostaSocket(fake);
      f.set = status => {
        f.operation = {
          operationId: 'feedback-op', status, phase: status === 'in_corso' ? 'verifica_finale' : 'terminata',
          connection: 'PostgreSQL locale', targetDb: 'diego', startedAt: '2026-10-27T10:00:00Z',
          endedAt: status === 'in_corso' ? null : '2026-10-27T10:12:00Z',
          recovery: { id: '20261027-101200_full' },
          staging: { retained: true, db: 'diego__codedb_staging_e77307cfa2' },
          error: status.includes('errore') || status === 'intervento_richiesto' ? 'Verifica non riuscita: controlla i dati importati.' : null,
          recoveryError: status === 'intervento_richiesto' ? 'Ripristino non riuscito: conserva la copia di recupero.' : null,
        };
      };
    });
    const open = async status => {
      await page.evaluate(async status => {
        if (status) importFixture.set(status); else importFixture.operation = null;
        (await import('/js/exportimport.js')).openDbImportModal();
      }, status);
      await page.waitForSelector('#dbimport-overlay[data-arc-dialog="open"]');
      if (status) await page.waitForSelector(`#dbimport-report.esito-${status}:visible`);
      await page.waitForTimeout(250);
    };
    const close = async () => {
      await page.locator('#dbimport-cancel').click();
      await page.waitForSelector('#dbimport-overlay[data-arc-dialog="open"]', { state: 'hidden' });
    };
    const fits = async () => assert(await page.locator('#dbimport-overlay .modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Nessun overflow orizzontale nella modale');
    fs.mkdirSync('test-reports/import-feedback', { recursive: true });

    await open();
    assert(await page.locator('#dbimport-form').isVisible());
    assert.match(await page.locator('#dbimport-run').textContent(), /anteprima/);
    await page.locator('#dbimport-run').click();
    assert.match(await page.locator('#dbimport-error').textContent(), /Seleziona prima/);
    await fits();
    await close();

    await open('completato');
    assert(!await page.locator('#dbimport-form').isVisible(), 'L’esito non mostra un form vuoto');
    assert(!await page.locator('#dbimport-run').isVisible(), 'L’esito non invita a ripetere l’import');
    assert(!await page.locator('#dbimport-progress').isVisible(), 'Nessuna barra di avanzamento a operazione terminata');
    assert.match(await page.locator('.dbimport-summary').textContent(), /diego.*PostgreSQL locale/s);
    assert.equal(await page.locator('.dbimport-recovery').getAttribute('open'), null);
    await page.screenshot({ path: 'test-reports/import-feedback/desktop-success.png' });
    await page.locator('.dbimport-recovery summary').focus();
    await page.keyboard.press('Enter');
    assert(await page.locator('[data-dbimport-cleanup]').isVisible());
    await page.screenshot({ path: 'test-reports/import-feedback/desktop-recovery.png' });
    // La pulizia resta esplicita e cancellabile; usa sempre la connessione d’origine.
    await page.evaluate(async () => { (await import('/js/tabs.js')).tabs.activeId = 'altro-tab'; });
    page.once('dialog', d => d.dismiss());
    await page.locator('[data-dbimport-cleanup]').click();
    assert.equal(await page.evaluate(() => importFixture.sent.filter(e => e.name.endsWith(':cleanup')).length), 0);
    const notices = await page.evaluate(() => importFixture.notices.length);
    page.once('dialog', d => d.accept());
    await page.locator('[data-dbimport-cleanup]').click();
    await page.waitForFunction(() => document.getElementById('dbimport-report').textContent.includes('Risorse di recupero eliminate'));
    assert.equal(await page.evaluate(() => importFixture.sent.find(e => e.name.endsWith(':cleanup')).tabId), 'import-feedback');
    assert.equal(await page.evaluate(() => importFixture.notices.length), notices, 'La pulizia non ripete la notifica di completamento');
    assert(!await page.locator('[data-dbimport-cleanup]').count());
    await page.evaluate(async () => { (await import('/js/tabs.js')).tabs.activeId = 'import-feedback'; });
    await page.locator('#dbimport-new').click();
    assert(await page.locator('#dbimport-form').isVisible());
    assert(!await page.locator('#dbimport-report').isVisible());
    assert.equal(await page.locator('#dbimport-file').inputValue(), '');
    await page.locator('#dbimport-file').setInputFiles({ name: 'dump.sql', mimeType: 'text/plain', buffer: Buffer.from('CREATE TABLE t (id integer);') });
    await page.waitForFunction(() => document.getElementById('dbimport-progress-label').textContent.includes('File validato'));
    await page.locator('#dbimport-target').fill('diego');
    await page.locator('#dbimport-run').click();
    await page.waitForSelector('#piano-overlay[data-arc-dialog="open"]');
    await page.locator('#piano-ok').click();
    await page.waitForFunction(() => !!importFixture.pending);
    assert.equal(await page.evaluate(() => importFixture.sent.filter(e => e.name === 'database:import:start').at(-1).expectedFingerprint), 'piano-feedback');
    await page.evaluate(() => {
      importFixture.set('completato'); const answer = importFixture.pending; importFixture.pending = null;
      answer({ ok: true, operation: importFixture.operation });
    });
    await page.waitForSelector('#dbimport-overlay[data-state="result"]');
    await close();

    await open('in_corso');
    assert(await page.locator('#dbimport-cancel').isDisabled());
    assert(!await page.locator('#dbimport-new').isVisible());
    assert.equal(await page.getByRole('progressbar', { name: 'Avanzamento importazione' }).getAttribute('aria-valuenow'), null);
    assert.match(await page.locator('#dbimport-progress-label').textContent(), /Verifica finale/);
    await page.keyboard.press('Escape');
    assert(await page.locator('#dbimport-report').isVisible());
    await page.waitForFunction(() => !!importFixture.pending);
    await page.evaluate(() => {
      importFixture.set('completato'); const answer = importFixture.pending; importFixture.pending = null;
      answer({ ok: true, operation: importFixture.operation });
    });
    await page.waitForFunction(() => !document.getElementById('dbimport-cancel').disabled);
    assert(!await page.locator('#dbimport-progress').isVisible());
    await close();

    for (const status of ['ripristinato_dopo_errore', 'intervento_richiesto']) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await open(status);
      assert(await page.locator('.dbimport-recovery').getAttribute('open') !== null);
      assert.match(await page.locator('#dbimport-report').textContent(), /Verifica non riuscita/);
      if (status === 'intervento_richiesto') assert.match(await page.locator('#dbimport-report').textContent(), /Ripristino non riuscito/);
      await fits();
      await page.locator('[data-dbimport-cleanup]').hover();
      assert.equal(await page.locator('[data-dbimport-cleanup]').evaluate(el => getComputedStyle(el).color), await page.locator('#dbimport-report').evaluate(el => getComputedStyle(el).getPropertyValue('--danger').trim()).then(hex => {
        const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
      }), 'Il testo dell’azione distruttiva resta leggibile anche all’hover');
      await page.screenshot({ path: `test-reports/import-feedback/mobile-${status}.png` });
      await page.locator('#dbimport-new').scrollIntoViewIfNeeded();
      assert(await page.locator('#dbimport-new').isEnabled());
      await close();
    }
    await page.setViewportSize({ width: 320, height: 740 });
    await open('completato');
    await page.locator('.dbimport-recovery summary').click();
    await page.evaluate(() => document.querySelector('.dbimport-recovery code').textContent = 'recupero_' + 'x'.repeat(180));
    await fits();
    await close();
    await open();
    await fits();
    await page.screenshot({ path: 'test-reports/import-feedback/mobile-form.png' });
    await page.locator('#dbimport-run').scrollIntoViewIfNeeded();
    assert(await page.locator('#dbimport-run').isEnabled());
    assert.deepEqual(errors, []);
    console.log('  OK import: form, tre esiti, monitoraggio, tastiera, nuovo import, pulizia confermata sulla connessione d’origine, mobile 320/390 e tema chiaro/scuro');
  } finally { await browser.close(); await server.stop(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
