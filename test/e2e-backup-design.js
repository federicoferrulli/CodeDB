'use strict';
// Interfaccia reale, catalogo sintetico e trasporto simulato: nessun backup viene eseguito.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { scegliArc, spuntaArc } = require('./arc-controls');
const mutant = process.argv.includes('--mutant');
const mutantHistory = process.argv.includes('--mutant-history');
const catalogOnly = process.argv.includes('--catalog');
const checksOnly = process.argv.includes('--checks-only');
const mutantSelection = process.argv.includes('--mutant-selection');
const loadingOnly = process.argv.includes('--loading');
const mutantLoading = process.argv.includes('--mutant-loading');
const dir = loadingOnly ? `test-reports/backup-loading-2026-10-12${mutantLoading ? '/mutante' : ''}` : `test-reports/${catalogOnly ? 'catalogo-backup' : 'backup-design'}-2026-10-12/${mutantSelection ? 'mutante-selezione' : mutantHistory ? 'mutante-storico' : mutant ? 'mutante' : process.argv.includes('--confirm') ? 'conferma' : 'dopo'}`;

(async () => {
  const server = await startTestServer({ port: 3210 });
  const browser = await chromium.launch();
  const report = { environment: 'Chromium, risposte simulate', checks: [], layouts: [], motion: [], errors: [] };
  fs.mkdirSync(dir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => report.errors.push(e.message));
  const ok = message => { report.checks.push(message); console.log('OK', message); };
  try {
    await page.addInitScript(version => {
      localStorage.setItem('codedb:tema', 'dark');
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
    }, require('../package.json').version);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('html[data-arc-ready="true"]');
    const open = async () => {
      await page.locator('#btn-backup-manager').evaluate(el => el.click());
      await page.waitForSelector('#modal-backup-manager[data-arc-dialog="open"]');
      await page.waitForTimeout(360);
    };
    const close = async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('modal-backup-manager').dataset.arcDialog);
    };
    await open();
    assert.match(await page.locator('#backup-source-hint').textContent(), /Apri una connessione/);
    await close();
    await page.evaluate(async () => {
      const [{ createTab, tabs }, { impostaSocket }, tabbar, workspace] = await Promise.all(['tabs', 'socket', 'tabbar', 'workspace'].map(name => import(`/js/${name}.js`)));
      const groups = { Collaudo_contabilita: [
        { id: '20261011-full', type: 'full', db: 'contabilita', dbType: 'postgresql', startedAt: '2026-10-11T10:00:00Z' },
        { id: '20261012-inc', type: 'incremental', baseId: '20261011-full', db: 'contabilita', dbType: 'postgresql', startedAt: '2026-10-12T10:00:00Z' },
      ] };
      for (const name of ['Analisi', 'Archivio', 'Sviluppo']) groups[`${name}_ordini`] = [{ id: '20261011-full', type: 'full', db: 'ordini', dbType: 'mysql', startedAt: '2026-10-11T09:00:00Z' }];
      for (const day of ['09', '08', '07']) groups.Collaudo_contabilita.push({ id: `202610${day}-full`, type: 'full', db: 'contabilita', dbType: 'postgresql', startedAt: `2026-10-${day}T10:00:00Z` });
      groups['Origine_<img src=x>'] = [{ id: 'copia-senza-data', type: 'incremental', baseId: 'mancante', db: 'nome_database_molto_lungo_per_verificare_il_layout', dbType: 'mongodb', startedAt: 'sconosciuta' }];
      groups.Vuoto = [];
      window.backupFixture = { groups, sent: [], pending: {}, lists: [], holdList: false, holdVerify: false, fail: null };
      window.backupFixture.collections = ['utenti', 'ordini', 'vendite, archivio', 'tabella_con_un_nome_molto_lungo_per_verificare_il_layout_su_mobile', '<img src=x>'];
      window.backupFixture.collectionRequests = [];
      const fake = { connected: true, on() {}, off() {}, timeout() { return { emit: (name, payload, cb) => fake.emit(name, payload, r => cb(null, r)) }; }, emit(name, payload, cb) {
        const f = window.backupFixture; f.sent.push({ name, payload });
        if (['backup:run', 'backup:restore'].includes(name)) { f.pending[name] = cb; return; }
        if (f.fail === name) return cb?.({ ok: false, error: 'Permessi insufficienti per questa operazione.' });
        const response = { ok: true, databases: [{ name: 'contabilita' }], collections: payload.db === 'analisi' ? [{ name: 'statistiche' }] : f.collections.map(name => ({ name })),
          ...(name === 'backup:list' ? { groups: f.groups } : {}),
          ...(name === 'backup:verify' ? { valid: false, failedCount: 1, details: [{ file: 'ordini.ndjson.gz', status: 'checksum diverso' }] } : {}) };
        if (name === 'backup:list' && f.holdList) { const saved = structuredClone(response); f.lists.push(() => cb(saved)); return; }
        if (name === 'db:collections' && f.holdCollections) { f.collectionRequests.push(() => cb(response)); return; }
        if (name === 'backup:verify' && f.holdVerify) { f.pending[name] = () => cb(response); return; }
        cb?.(response);
      } };
      impostaSocket(fake);
      for (const id of ['a', 'b']) {
        const t = createTab({ id }); t.label = id === 'a' ? 'Collaudo' : 'Archivio'; t.dbType = 'postgresql';
        Object.assign(t.state, { connected: true, connLabel: t.label, dbType: 'postgresql', databases: [{ name: 'contabilita' }, { name: 'analisi' }] });
      }
      tabs.activeId = 'a'; tabbar.renderTabBar(); workspace.renderWorkspace();
    });
    await open();
    if (loadingOnly) {
      await page.evaluate(() => { window.backupFixture.holdList = true; });
      await page.locator('#tab-btn-backup-catalog').click();
      const list = page.locator('#backup-catalog-list');
      await page.waitForFunction(() => window.backupFixture.lists.length === 1);
      assert.equal(await list.getAttribute('aria-busy'), 'true', 'Il primo caricamento espone lo stato occupato');
      assert.equal(await list.locator('.backup-group-card').count(), 3, 'Scheletro iniziale con la forma del catalogo');
      await page.evaluate(() => window.backupFixture.lists.shift()());
      await page.waitForFunction(() => document.getElementById('backup-catalog-list').getAttribute('aria-busy') === 'false');
      const card = page.locator('.backup-group-card').filter({ hasText: 'Collaudo_contabilita' });
      await card.locator('.backup-history-toggle').click();
      await page.waitForTimeout(350);
      const capture = () => page.evaluate(() => {
        const list = document.getElementById('backup-catalog-list');
        const ancestors = []; for (let el = list.parentElement; el; el = el.parentElement) ancestors.push(el);
        const scroller = ancestors.find(el => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight);
        return { height: list.getBoundingClientRect().height, scroll: scroller?.scrollTop || 0, modal: document.querySelector('#modal-backup-manager .modal').getBoundingClientRect().height };
      });
      for (const [width, theme] of [[1440, 'dark'], [390, 'dark'], [320, 'light']]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.waitForTimeout(350);
        await page.locator('#btn-refresh-backups').scrollIntoViewIfNeeded();
        await list.evaluate(list => {
          for (let el = list.parentElement; el; el = el.parentElement) {
            if (/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) { el.scrollTop = 100; break; }
          }
        });
        const before = await capture();
        await list.evaluate(el => { window.loadingRows = [...el.children]; });
        await page.locator('#btn-refresh-backups').evaluate(el => el.click());
        await page.waitForFunction(() => window.backupFixture.lists.length === 1);
        if (mutantLoading) await list.evaluate(el => { el.innerHTML = '<div>Caricamento del catalogo…</div>'; });
        assert(await page.evaluate(() => window.loadingRows.every(el => el.isConnected)), 'Aggiornare mantiene montate tutte le righe');
        assert.deepEqual(await capture(), before, 'Lo skeleton conserva altezza e posizione di scorrimento');
        assert(await list.evaluate(el => el.inert), 'I comandi delle copie in aggiornamento sono esclusi dal focus');
        assert.equal(await card.locator('.backup-group-title strong').evaluate(el => getComputedStyle(el).visibility), 'hidden');
        assert.equal(await card.locator('.backup-group-title strong').evaluate(el => getComputedStyle(el, '::after').visibility), 'visible');
        assert(await page.locator('#btn-refresh-backups').isDisabled());
        const shots = 'test-reports/backup-loading-2026-10-12'; fs.mkdirSync(shots, { recursive: true });
        if (!checksOnly) await page.screenshot({ path: `${shots}/loading-${theme}-${width}.png` });
        await page.evaluate(() => window.backupFixture.lists.shift()());
        await page.waitForFunction(() => document.getElementById('backup-catalog-list').getAttribute('aria-busy') === 'false');
        assert.equal(await card.locator('.backup-history-toggle').getAttribute('aria-expanded'), 'true');
        assert(!(await list.evaluate(el => el.inert)));
        assert(!(await page.locator('#btn-refresh-backups').isDisabled()));
      }
      await page.locator('#btn-refresh-backups').click();
      await page.locator('#tab-btn-backup-new').click();
      await page.locator('#tab-btn-backup-catalog').click();
      await page.waitForFunction(() => window.backupFixture.lists.length === 2);
      await page.evaluate(() => window.backupFixture.lists.shift()());
      assert.equal(await list.getAttribute('aria-busy'), 'true', 'La risposta superata non chiude lo skeleton');
      assert(await page.locator('#btn-refresh-backups').isDisabled());
      await page.evaluate(() => window.backupFixture.lists.shift()());
      await page.waitForFunction(() => document.getElementById('backup-catalog-list').getAttribute('aria-busy') === 'false');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.locator('#btn-refresh-backups').click();
      assert.equal(await list.evaluate(el => getComputedStyle(el).animationName), 'none');
      await page.locator('#backup-catalog-filter').fill('Analisi');
      assert.equal(await list.getAttribute('aria-busy'), 'true');
      await page.evaluate(() => window.backupFixture.lists.shift()());
      await page.waitForFunction(() => document.getElementById('backup-catalog-list').getAttribute('aria-busy') === 'false');
      assert.equal(await list.locator('.backup-group-card').count(), 1, 'Il filtro digitato durante il caricamento si applica alla risposta');
      await page.locator('#backup-catalog-filter').fill('');
      await page.evaluate(() => { window.backupFixture.fail = 'backup:list'; });
      await page.locator('#btn-refresh-backups').click();
      await page.getByText('Errore nel caricamento del catalogo:', { exact: false }).waitFor();
      assert.equal(await list.locator('.backup-group-card').count(), 5, 'Un errore di rete conserva il catalogo precedente');
      assert.equal(await list.getAttribute('aria-busy'), 'false');
      assert(!(await page.locator('#btn-refresh-backups').isDisabled()));
      assert.deepEqual(report.errors, []);
      ok('Skeleton iniziale e refresh stabile desktop/mobile, storici e scroll conservati, filtro, errore e movimento ridotto');
      return;
    }
    assert.equal(await page.locator('#backup-db').inputValue(), 'contabilita');
    assert.match(await page.locator('#backup-source-hint').textContent(), /Collaudo/);
    assert.equal(await page.locator('#backup-options').getAttribute('open'), null);
    const picker = page.locator('#backup-collections');
    const choices = page.locator('#backup-scope-list');
    await picker.locator('summary').click();
    await choices.getByRole('checkbox', { name: 'utenti', exact: true }).click();
    await page.locator('#backup-scope-search').fill('ord');
    await choices.getByRole('checkbox', { name: 'ordini', exact: true }).click();
    assert.equal(await page.locator('#backup-scope-selection').textContent(), '2 selezionate');
    await page.locator('#backup-scope-search').fill('nessuna-corrispondenza');
    assert.equal(await choices.getByRole('checkbox').count(), 0);
    assert.match(await page.locator('#backup-scope-status').textContent(), /Nessuna corrispondenza/);
    await page.locator('#backup-scope-search').press('Enter');
    assert.equal(await page.evaluate(() => window.backupFixture.sent.filter(r => r.name === 'backup:run').length), 0);
    await page.locator('#backup-scope-search').fill('');
    assert.equal(await choices.getByRole('checkbox', { checked: true }).count(), 2, 'Il filtro conserva tutte le scelte');
    assert.equal(await choices.locator('img').count(), 0, 'I nomi vengono mostrati come testo');
    await page.locator('#backup-scope-search').press('Escape');
    assert.equal(await picker.evaluate(el => el.open), false);
    assert.equal(await page.locator('#modal-backup-manager').getAttribute('data-arc-dialog'), 'open');
    await close(); await open();
    assert.equal(await page.locator('#backup-scope-selection').textContent(), '2 selezionate', 'Riaprire conserva la bozza');
    // Il mutante elimina volutamente il collegamento tra selezione e payload.
    if (mutantSelection) await page.evaluate(async () => {
      const { socket } = await import('/js/socket.js');
      const emit = socket.emit;
      socket.emit = (name, payload, cb) => emit(name, name === 'backup:run' ? { ...payload, collections: undefined } : payload, cb);
    });
    if (mutant) await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) { return animate.call(this, frames, this.matches('.backup-tabs .tab-selection') ? { ...options, duration: 0 } : options); };
    });
    report.motion = await page.evaluate(async () => {
      const frames = [], start = performance.now(); document.getElementById('tab-btn-backup-catalog').click();
      await new Promise(resolve => { function sample(now) {
        frames.push(getComputedStyle(document.querySelector('.backup-tabs .tab-selection')).transform);
        if (now - start < 360) requestAnimationFrame(sample); else resolve();
      } requestAnimationFrame(sample); });
      return frames;
    });
    assert(new Set(report.motion).size > 3, 'L’indicatore deve attraversare posizioni intermedie reali');
    await page.locator('#tab-btn-backup-catalog').focus();
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#tab-btn-backup-new').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#backup-scope-selection').textContent(), '2 selezionate');
    ok('Schede animate, tastiera e bozza conservata');
    await scegliArc(page, '#backup-type', 'incremental');
    assert.match(await page.locator('#backup-type-hint').textContent(), /ultimo backup\./);
    await page.locator('#backup-options summary').click();
    await page.locator('#backup-compress-level').fill('3');
    await spuntaArc(page, '#backup-no-compress', true);
    assert(await page.locator('#backup-compress-level').isDisabled());
    assert.match(await page.locator('#backup-summary').textContent(), /Senza compressione/);
    await spuntaArc(page, '#backup-no-compress', false);
    await page.locator('#backup-since').fill('updated_at');
    await page.locator('#backup-storage').fill('archivio-test');
    await page.locator('#backup-slack').fill('indirizzo-non-valido');
    await page.locator('#backup-options summary').click();
    await page.locator('#btn-submit-backup').click();
    assert(await page.locator('#backup-options').evaluate(el => el.open), 'La validazione apre le opzioni chiuse');
    assert.equal(await page.evaluate(() => window.backupFixture.sent.filter(r => r.name === 'backup:run').length), 0);
    await page.locator('#backup-slack').fill('https://hooks.slack.com/services/fixture');
    await page.locator('#btn-submit-backup').click();
    await page.waitForFunction(() => window.backupFixture.pending['backup:run']);
    assert.deepEqual(await page.evaluate(() => window.backupFixture.sent.findLast(r => r.name === 'backup:run').payload), {
      tabId: 'a', db: 'contabilita', type: 'incremental', collections: ['utenti', 'ordini'], sinceField: 'updated_at', noCompress: false, compressLevel: 3, storage: 'archivio-test', slackWebhook: 'https://hooks.slack.com/services/fixture', connName: 'Collaudo',
    });
    await page.evaluate(() => window.backupFixture.pending['backup:run']({ ok: false, error: 'Destinazione non disponibile.' }));
    await page.getByText('Errore: Destinazione non disponibile.', { exact: true }).waitFor();
    await page.locator('#btn-submit-backup').click();
    await close();
    await page.evaluate(async () => { (await import('/js/tabs.js')).switchTab('b'); });
    await open();
    assert.match(await page.locator('#backup-source-hint').textContent(), /Archivio/);
    assert.equal(await page.locator('#backup-scope-selection').textContent(), 'Tutto il database', 'Una connessione diversa azzera le scelte');
    await page.evaluate(() => window.backupFixture.pending['backup:run']({ ok: true, summary: { id: 'fixture', totalDocs: 10, totalBytes: 1024 } }));
    await page.getByText('Backup completato di Collaudo / contabilita:', { exact: false }).waitFor();
    ok('Validazione, tutti i parametri, errore/riprova e origine dell’operazione dopo cambio connessione');
    await page.locator('#tab-btn-backup-catalog').click();
    const card = page.locator('.backup-group-card').filter({ hasText: 'Collaudo_contabilita' });
    await card.locator('.btn-verify-backup').first().click();
    await page.getByText('Verifica FALLITA:', { exact: false }).waitFor();
    if (mutantHistory) await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) { return animate.call(this, frames, this.matches('.backup-history') ? { ...options, duration: 0 } : options); };
    });
    await card.locator('.backup-history-toggle').focus();
    report.historyMotion = await card.evaluate(async el => {
      const toggle = el.querySelector('.backup-history-toggle'), history = el.querySelector('.backup-history');
      window.backupStable = { toggle, history, first: el.querySelector('.btn-verify-backup') };
      const frames = [], start = performance.now(); toggle.click();
      await new Promise(resolve => { function sample(now) {
        frames.push(getComputedStyle(history).clipPath);
        if (now - start < 340) requestAnimationFrame(sample); else resolve();
      } requestAnimationFrame(sample); });
      return frames;
    });
    assert(new Set(report.historyMotion).size > 3, 'Lo storico attraversa fotogrammi intermedi reali');
    assert(await page.evaluate(() => document.activeElement === window.backupStable.toggle && window.backupStable.first.isConnected && window.backupStable.history.isConnected));
    assert.equal(await card.locator('.backup-history-toggle').getAttribute('aria-expanded'), 'true');
    await card.locator('.backup-history .btn-verify-backup').first().click();
    assert.match(await card.locator('.backup-history .verify-result-cell').first().textContent(), /Verifica FALLITA/);
    await card.locator('.backup-history-toggle').click();
    assert(await card.locator('.backup-history').evaluate(el => el.inert), 'Le azioni in uscita sono subito escluse dal focus');
    await card.locator('.backup-history').waitFor({ state: 'hidden' });
    await card.locator('.backup-history-toggle').click();
    await page.waitForTimeout(30);
    await card.locator('.backup-history-toggle').click();
    await page.waitForTimeout(30);
    await card.locator('.backup-history-toggle').click();
    await page.waitForTimeout(400);
    assert.equal(await card.locator('.backup-history-toggle').getAttribute('aria-expanded'), 'true');
    assert(await card.locator('.backup-history').isVisible());
    assert(!(await card.locator('.backup-history').evaluate(el => el.inert)));
    assert.match(await card.locator('.backup-history .verify-result-cell').first().textContent(), /Verifica FALLITA/);
    assert.equal(await page.locator('#backup-catalog-list img').count(), 0);
    const broken = page.locator('.backup-group-card').filter({ hasText: 'Origine_<img src=x>' });
    assert.match(await broken.textContent(), /Data non disponibile/);
    assert.match(await broken.textContent(), /catena incompleta/);
    assert(await broken.getByRole('button', { name: 'Ripristina', exact: true }).isDisabled());
    assert.equal(await page.locator('.backup-group-card').filter({ hasText: /^Vuoto$/ }).count(), 0);
    await card.locator('.btn-restore-backup').first().click();
    await page.waitForSelector('#restore-overlay[data-arc-dialog="open"]');
    assert.equal(await page.locator('#restore-conn').textContent(), 'Archivio');
    assert(!(await page.locator('#restore-drop').isChecked()));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('restore-overlay').dataset.arcDialog);
    assert.equal(await page.evaluate(() => window.backupFixture.sent.filter(r => r.name === 'backup:restore').length), 0);
    ok('Verifica, storico e conferma del ripristino: destinazione esplicita, annullamento senza scritture');
    ok('Storico animato e interrompibile, focus e nodi stabili, esiti conservati, date sconosciute e catene incomplete esplicite');
    await page.locator('#backup-catalog-filter').fill('inesistente');
    await page.getByText('Nessuna copia corrispondente', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Azzera filtro', exact: true }).click();
    assert.equal(await page.locator('#backup-catalog-filter').inputValue(), '');
    await page.evaluate(() => { window.backupFixture.savedGroups = window.backupFixture.groups; window.backupFixture.groups = {}; });
    await page.locator('#btn-refresh-backups').click();
    await page.getByRole('button', { name: 'Crea un backup', exact: true }).click();
    assert.equal(await page.locator('#tab-btn-backup-new').getAttribute('aria-selected'), 'true');
    await page.evaluate(() => { window.backupFixture.groups = window.backupFixture.savedGroups; window.backupFixture.fail = 'backup:list'; });
    await page.locator('#tab-btn-backup-catalog').click();
    await page.getByText('Errore nel caricamento del catalogo:', { exact: false }).waitFor();
    await page.evaluate(() => { window.backupFixture.fail = null; });
    await page.locator('#btn-refresh-backups').click();
    await card.waitFor();
    ok('Catalogo vuoto, filtro senza corrispondenze, errore e ricaricamento');
    await page.evaluate(() => { window.backupFixture.holdList = true; });
    await page.locator('#btn-refresh-backups').click();
    await page.waitForFunction(() => window.backupFixture.lists.length === 1);
    await page.evaluate(() => { const f = window.backupFixture; f.groups.Lettura_recente = [{ ...f.groups.Collaudo_contabilita[0], db: 'lettura_recente' }]; });
    await page.locator('#tab-btn-backup-new').click();
    await page.locator('#tab-btn-backup-catalog').click();
    await page.waitForFunction(() => window.backupFixture.lists.length === 2);
    await page.evaluate(() => { window.backupFixture.lists.pop()(); });
    await page.getByText('lettura_recente', { exact: true }).waitFor();
    await page.evaluate(() => { window.backupFixture.lists.shift()(); });
    assert(await page.getByText('lettura_recente', { exact: true }).isVisible(), 'Il catalogo più recente non viene sostituito dalla risposta superata');
    await page.evaluate(() => { window.backupFixture.holdList = false; delete window.backupFixture.groups.Lettura_recente; });
    await page.locator('#btn-refresh-backups').click();
    await card.waitFor();
    await page.evaluate(() => { window.backupFixture.holdVerify = true; });
    await card.locator('.btn-verify-backup').first().click();
    await page.waitForFunction(() => window.backupFixture.pending['backup:verify']);
    await page.locator('#backup-catalog-filter').fill('Analisi');
    await page.locator('#backup-catalog-filter').fill('Collaudo');
    await page.evaluate(() => { window.backupFixture.pending['backup:verify'](); window.backupFixture.holdVerify = false; });
    await card.locator(':scope > .verify-result-cell').getByText('Verifica FALLITA:', { exact: false }).waitFor();
    await page.locator('#backup-catalog-filter').fill('');
    ok('Risposta del catalogo superata scartata e verifica in corso recuperata dopo il filtro');
    await page.waitForTimeout(4000);

    await page.locator('#tab-btn-backup-new').click();
    await picker.locator('summary').click();
    await page.evaluate(() => { window.backupFixture.holdCollections = true; });
    await scegliArc(page, '#backup-db', 'analisi');
    assert.match(await page.locator('#backup-scope-status').textContent(), /Caricamento/);
    assert(await page.locator('#backup-scope-search').isDisabled());
    await page.evaluate(() => { window.backupFixture.holdCollections = false; });
    await scegliArc(page, '#backup-db', 'contabilita');
    await choices.getByRole('checkbox', { name: 'utenti', exact: true }).waitFor();
    await page.evaluate(() => window.backupFixture.collectionRequests.shift()());
    assert.equal(await choices.getByRole('checkbox', { name: 'statistiche', exact: true }).count(), 0, 'Una risposta superata non cambia le opzioni');
    await page.evaluate(() => { window.backupFixture.fail = 'db:collections'; });
    await scegliArc(page, '#backup-db', 'analisi');
    await page.locator('#backup-scope-retry').waitFor();
    assert.match(await page.locator('#backup-scope-status').textContent(), /Impossibile caricare/);
    await page.evaluate(() => { window.backupFixture.fail = null; });
    await page.locator('#backup-scope-retry').click();
    await choices.getByRole('checkbox', { name: 'statistiche', exact: true }).click();
    await picker.locator('summary').click();
    await close(); await open();
    assert.equal(await page.locator('#backup-db').inputValue(), 'analisi', 'La riapertura conserva il database scelto');
    assert.equal(await page.locator('#backup-scope-selection').textContent(), 'statistiche');
    await page.evaluate(() => { window.backupFixture.savedCollections = window.backupFixture.collections; window.backupFixture.collections = []; });
    await scegliArc(page, '#backup-db', 'contabilita');
    await picker.locator('summary').click();
    assert.match(await page.locator('#backup-scope-status').textContent(), /non contiene/);
    await page.evaluate(() => { window.backupFixture.collections = window.backupFixture.savedCollections; });
    await scegliArc(page, '#backup-db', 'analisi');
    await scegliArc(page, '#backup-db', 'contabilita');
    await choices.getByRole('checkbox', { name: 'vendite, archivio', exact: true }).click();
    await page.locator('#btn-submit-backup').click();
    assert.deepEqual(await page.evaluate(() => window.backupFixture.sent.findLast(r => r.name === 'backup:run').payload.collections), ['vendite, archivio']);
    await page.evaluate(() => window.backupFixture.pending['backup:run']({ ok: false, error: 'Simulazione conclusa.' }));
    await page.getByText('Errore: Simulazione conclusa.', { exact: true }).waitFor();
    await page.locator('#backup-scope-clear').click();
    assert.equal(await choices.getByRole('checkbox', { checked: true }).count(), 0);
    await page.locator('#btn-submit-backup').click();
    assert.equal(await page.evaluate(() => window.backupFixture.sent.findLast(r => r.name === 'backup:run').payload.collections), undefined);
    await page.evaluate(() => window.backupFixture.pending['backup:run']({ ok: false, error: 'Simulazione conclusa.' }));
    await page.getByText('Errore: Simulazione conclusa.', { exact: true }).waitFor();
    assert(await page.evaluate(() => window.backupFixture.sent.filter(r => r.name === 'db:collections' && r.payload._bg).every(r => r.payload.includeCounts === false)));
    await choices.getByRole('checkbox', { name: 'utenti', exact: true }).click();
    await choices.getByRole('checkbox', { name: 'ordini', exact: true }).click();
    ok('Multiselezione: ricerca, tastiera, nomi letterali, tutto il database, caricamento leggero, errori/riprova, vuoto e risposte superate');
    await page.locator('#backup-status-msg').evaluate(el => el.classList.add('hidden'));
    await page.waitForTimeout(4000);

    // Un solo lotto di acquisizioni per passaggio; le prove funzionali possono escluderlo.
    for (const [width, height, theme] of [[1440, 900, 'dark'], [1440, 900, 'light'], [390, 844, 'dark'], [320, 720, 'light'], [844, 390, 'dark']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const view of catalogOnly ? ['catalog'] : ['new', 'advanced', 'catalog']) {
        await page.locator(`#tab-btn-backup-${view === 'catalog' ? 'catalog' : 'new'}`).click();
        await page.locator('#backup-options').evaluate((el, value) => { el.open = value; }, view === 'advanced');
        await picker.evaluate((el, value) => { el.open = value; }, view === 'new');
        if (view === 'catalog' && catalogOnly) for (const toggle of await page.locator('.backup-history-toggle[aria-expanded="true"]').all()) await toggle.click();
        await page.waitForTimeout(360);
        await page.locator('#modal-backup-manager .modal').evaluate(el => { el.scrollTop = 0; });
        const layout = await page.locator('#modal-backup-manager .modal').evaluate(el => {
          const b = el.getBoundingClientRect();
          return { x: b.x, y: b.y, width: b.width, height: b.height, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, shellWidth: document.documentElement.scrollWidth };
        });
        assert(layout.x >= -1 && layout.x + layout.width <= width + 1 && layout.y >= -1, `${width}/${view}: pannello nel viewport`);
        assert(layout.scrollWidth <= layout.clientWidth + 1 && layout.shellWidth <= width + 1, `${width}/${view}: nessun overflow orizzontale`);
        if (view === 'new' && width <= 900) {
          for (const label of await choices.locator('label').all()) assert((await label.boundingBox()).height >= 44, 'Scelte toccabili su mobile');
        }
        if (width <= 900) {
          for (const selector of ['#tab-btn-backup-new', '#tab-btn-backup-catalog', view === 'catalog' ? '#btn-refresh-backups' : '#btn-submit-backup']) {
            assert((await page.locator(selector).boundingBox()).height >= 44, `Bersaglio touch ${selector} a ${width}`);
          }
          if (view !== 'catalog') assert((await page.locator('[data-arc-for="backup-db"] [role="combobox"]').boundingBox()).height >= 44, 'Selettore touch anche in landscape');
          assert(await page.locator('#modal-backup-manager .arc-dialog-sheet').isVisible(), 'Drawer Arc su mobile');
        }
        report.layouts.push({ width, height, theme, view, ...layout });
        if (!checksOnly) await page.screenshot({ path: `${dir}/${view}-${theme}-${width}.png` });
        if (view === 'catalog' && catalogOnly) {
          const contrast = await page.evaluate(() => {
            const ctx = document.createElement('canvas').getContext('2d');
            const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
            const lum = rgb => { const v = rgb.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4); return .2126 * v[0] + .7152 * v[1] + .0722 * v[2]; };
            return [...document.querySelectorAll('#backup-catalog-list .backup-group-meta, #backup-catalog-list .backup-id, #backup-catalog-list .backup-copy-date, #backup-catalog-list .backup-chain')].map(el => {
              const parents = []; for (let p = el; p; p = p.parentElement) parents.unshift(p);
              let bg = [255, 255, 255]; for (const p of parents) { const c = rgba(getComputedStyle(p).backgroundColor), a = c[3] / 255; bg = bg.map((n, i) => n * (1 - a) + c[i] * a); }
              const fg = rgba(getComputedStyle(el).color), a = fg[3] / 255, l1 = lum(fg.slice(0, 3).map((n, i) => n * a + bg[i] * (1 - a))), l2 = lum(bg);
              return { text: el.textContent.slice(0, 60), ratio: (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05) };
            });
          });
          assert(contrast.every(c => c.ratio >= 4.5), JSON.stringify(contrast.filter(c => c.ratio < 4.5)));
          report.layouts.at(-1).contrast = contrast;
          await page.locator('#backup-catalog-filter').fill('Collaudo');
          const group = page.locator('.backup-group-card');
          if (await group.locator('.backup-history-toggle').getAttribute('aria-expanded') !== 'true') await group.locator('.backup-history-toggle').click();
          await group.locator('.backup-history-toggle').scrollIntoViewIfNeeded();
          await page.waitForTimeout(350);
          assert(await group.locator('.backup-history').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Storico senza scorrimento orizzontale');
          if (width <= 900) for (const control of await group.locator('.backup-history button').all()) assert((await control.boundingBox()).height >= 44);
          if (!checksOnly) await page.screenshot({ path: `${dir}/history-${theme}-${width}.png` });
          await page.locator('#backup-catalog-filter').fill('');
        }
        if (view !== 'catalog' && width <= 900) {
          await page.locator('#btn-submit-backup').scrollIntoViewIfNeeded();
          await page.waitForTimeout(80);
          assert(await page.locator('#btn-submit-backup').isVisible());
          if (!checksOnly) await page.screenshot({ path: `${dir}/${view}-bottom-${theme}-${width}.png` });
        }
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#tab-btn-backup-new').click();
    await page.locator('#tab-btn-backup-catalog').click();
    await card.waitFor();
    await card.locator('.backup-history-toggle').click();
    assert.equal(await card.locator('.backup-history').evaluate(el => el.getAnimations().length), 0);
    assert.equal(await page.locator('.backup-tabs').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await close();
    assert.equal(await page.locator('#modal-backup-manager').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#mobile-nav-conns').click();
    await page.locator('#conn-settings-btn').click();
    await page.getByRole('menuitem', { name: /Backup/ }).click();
    await page.waitForSelector('#modal-backup-manager[data-arc-dialog="open"]');
    assert.equal(await page.locator('.arc-navigation-sheet').count(), 0, 'Il drawer di navigazione viene rilasciato');
    await close();
    assert.deepEqual(report.errors, []);
    ok('Chiaro/scuro, 320–1440px, landscape, drawer Arc, touch, moto ridotto e chiusura senza animazioni residue');
  } catch (e) { report.failure = e.stack; throw e; }
  finally { fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
