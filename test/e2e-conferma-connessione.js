'use strict';

// Controller e componenti Arc reali; trasporto controllato, nessun database utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { scegliArc, spuntaArc } = require('./arc-controls');
const mutant = process.argv.includes('--mutant');
const dir = `test-reports/conferma-connessione-2026-10-11/${mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3197 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const report = { checks: [], layouts: [], errors: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  const field = name => page.locator(`#connect-form [name="${name}"]`);
  const requests = () => page.evaluate(() => window.connectionTest.requests);
  const open = async () => {
    await page.evaluate(async () => (await import('/js/connection.js')).openConnModal());
    await page.locator('#connect-overlay[data-arc-dialog="open"]').waitFor();
  };
  try {
    if (mutant) await page.route('**/js/connection.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const body = source.replace(/    if \(currentStep !== 3\) \{[\s\S]*?      return;\n    \}/, '');
      assert.notEqual(body, source, 'Il mutante deve togliere il passaggio obbligatorio');
      await route.fulfill({ response, body });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    await page.evaluate(async () => {
      window.connectionTest = { requests: [], fail: false, hold: false, saved: [] };
      const fake = {
        connected: true, on() { return fake; }, off() { return fake; },
        timeout() { return { emit(name, payload, ack) { fake.emit(name, payload, res => ack(null, res)); } }; },
        emit(name, payload, ack) {
          const test = window.connectionTest;
          if (name === 'mongo:connect') {
            test.requests.push(payload);
            const answer = () => ack(test.fail ? { ok: false, error: 'Errore di prova: verifica i parametri.' }
              : { ok: true, dbType: payload.dbType, label: payload.host || 'URI', databases: [] });
            if (test.hold) test.answer = answer;
            else answer();
            return;
          }
          if (name === 'connections:get') {
            ack({ ok: true, fields: { dbType: 'mongodb', host: 'db.salvato', port: '27017', username: 'utente-salvato',
              ssh: 'true', sshHost: 'bastion.salvato', sshPort: '22', sshUser: 'tunnel', sshAuth: 'path', sshKeyFile: '/chiave' },
              hasPassword: true, hasUri: false, hasSshPassword: true, hasSshPassphrase: true });
            return;
          }
          ack?.({ ok: true, connections: test.saved, databases: [], collections: [], docs: [], fields: [] });
        },
      };
      (await import('/js/socket.js')).impostaSocket(fake);
    });

    await open();
    await field('host').fill('db.interno');
    await field('username').fill('analista');
    await field('password').fill('segreto-da-non-mostrare');
    await field('authSource').fill('autenticazione');
    await page.locator('#connect-btn').click();
    assert.equal((await requests()).length, 0, 'Il primo Connetti non deve aprire né salvare la connessione');
    assert.equal(await page.locator('#connect-btn').textContent(), 'Conferma e connetti');
    assert(await page.locator('#wizard-summary-title').evaluate(el => el === document.activeElement));
    const summary = await page.locator('#wizard-summary-box').textContent();
    for (const value of ['MongoDB', 'db.interno', '27017', 'analista', 'autenticazione', 'Disattivato']) assert(summary.includes(value), value);
    assert(!summary.includes('segreto-da-non-mostrare'));
    assert.match(await page.locator('#conn-save-status').textContent(), /non verrà salvata/);
    await field('saveAs').fill('   ');
    assert.match(await page.locator('#conn-save-status').textContent(), /non verrà salvata/);
    await page.evaluate(async () => {
      window.connectionTest.saved = [{ name: 'Nome esistente', dbType: 'mongodb', label: 'db.esistente' }];
      (await import('/js/connmanager.js')).loadSavedConnections();
    });
    await field('saveAs').fill('Nome esistente');
    assert.match(await page.locator('#conn-save-status').textContent(), /connessione salvata verrà aggiornata/);
    await page.locator('#wizard-prev-btn').click();
    assert.equal(await field('host').inputValue(), 'db.interno');
    await field('host').fill('db.corretto');
    await field('host').press('Enter');
    assert.equal((await requests()).length, 0, 'Anche Invio dai parametri apre il riepilogo');
    assert.match(await page.locator('#wizard-summary-box').textContent(), /db.corretto/);
    await page.locator('#conn-cancel-btn').click();
    assert.equal((await requests()).length, 0, 'Annulla non invia la configurazione');
    report.checks.push('Connetti e Invio aprono il riepilogo; nome esistente dichiarato; Indietro conserva i dati; Annulla non connette');

    for (const type of ['mysql', 'postgresql']) {
      await open();
      await scegliArc(page, '#conn-dbtype', type);
      await field('database').fill('applicazione');
      await page.locator('#connect-btn').click();
      assert.match(await page.locator('#wizard-summary-box').textContent(), type === 'mysql' ? /3306/ : /5432/);
      assert.match(await page.locator('#wizard-summary-box').textContent(), /applicazione/);
      await page.locator('#connect-btn').click();
      await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
      assert.equal((await requests()).at(-1).saveAs, '');
    }
    report.checks.push('MySQL e PostgreSQL: parametri e porte corretti, connessione non salvata dopo conferma');

    await open();
    await spuntaArc(page, '#conn-ssh-toggle', true);
    await page.locator('#wizard-next-btn').click();
    await scegliArc(page, '#conn-ssh-auth', 'path');
    for (const [name, value] of Object.entries({ sshHost: 'bastion.interno', sshPort: '2222', sshUser: 'amministratore',
      sshKeyFile: 'C:\\chiavi\\produzione\\chiave-privata', sshPassphrase: 'segreto-chiave',
      sshHostKey: `SHA256:${'abcdefghij'.repeat(6)}` })) await field(name).fill(value);
    const before = (await requests()).length;
    await page.locator('#connect-btn').click();
    assert.equal((await requests()).length, before, 'Connetti dal passo SSH richiede conferma');
    await field('saveAs').fill('  Produzione principale  ');
    await field('folder').fill('  Lavoro  ');
    assert.match(await page.locator('#conn-save-status').textContent(), /verrà salvata come “Produzione principale” nella cartella “Lavoro”, solo se il collegamento riesce/);
    const sshSummary = await page.locator('#wizard-summary-box').textContent();
    for (const value of ['bastion.interno', '2222', 'amministratore', 'chiave-privata', 'SHA256:']) assert(sshSummary.includes(value), value);
    for (const value of ['segreto-ssh', 'segreto-chiave']) assert(!sshSummary.includes(value));

    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      for (const width of [1440, 768, 390, 320]) {
        const height = width > 900 ? 1000 : 844;
        await page.setViewportSize({ width, height });
        await page.locator(`#connect-overlay ${width <= 900 ? '.arc-dialog-sheet' : '.arc-dialog-shell'}`).waitFor();
        await page.locator('#wizard-summary-title').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${dir}/riepilogo-${theme}-${width}.png`, animations: 'disabled' });
        await page.locator('#connect-btn').scrollIntoViewIfNeeded();
        const geometry = await page.locator('#connect-overlay .modal').evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth }));
        assert(geometry.content <= geometry.width + 1, `Overflow a ${width}: ${JSON.stringify(geometry)}`);
        const controls = await page.locator('#connect-form .connect-actions button:visible').all();
        for (let i = 0; i < controls.length; i++) {
          const a = await controls[i].boundingBox();
          assert(a.x >= 0 && a.x + a.width <= width + 1);
          for (let j = i + 1; j < controls.length; j++) {
            const b = await controls[j].boundingBox();
            assert(!(a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1), 'Azioni sovrapposte');
          }
        }
        await page.screenshot({ path: `${dir}/conferma-${theme}-${width}.png`, animations: 'disabled' });
        report.layouts.push({ theme, width, height });
      }
    }
    await page.evaluate(() => { window.connectionTest.fail = true; });
    await page.locator('#connect-btn').click();
    await page.locator('#connect-error:not(.hidden)').waitFor();
    assert.match(await page.locator('#connect-error').textContent(), /Errore di prova/);
    assert.equal(await field('saveAs').inputValue(), '  Produzione principale  ');
    assert.equal(await page.locator('#connect-btn').textContent(), 'Conferma e connetti');
    await page.evaluate(() => { window.connectionTest.fail = false; window.connectionTest.hold = true; });
    await page.locator('#connect-btn').click();
    assert(await page.locator('#connect-btn').isDisabled());
    assert.equal((await requests()).at(-1).saveAs, 'Produzione principale');
    assert.equal((await requests()).at(-1).folder, 'Lavoro');
    await page.evaluate(() => { window.connectionTest.answer(); window.connectionTest.hold = false; });
    await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
    report.checks.push('SSH completo e segreti mascherati; salvataggio esplicito; errore conserva il form e conferma in caricamento');

    await page.setViewportSize({ width: 1440, height: 1000 });
    await open();
    await page.locator('#tab-uri-btn').click();
    await field('uri').fill('mongodb://utente:p%40ssword@host-a:27017,host-b:27018/app?authSource=admin&tls=true&authMechanismProperties=AWS_SESSION_TOKEN:segreto-token');
    await page.locator('#connect-btn').click();
    const uriSummary = await page.locator('#wizard-summary-box').textContent();
    for (const value of ['utente:', 'host-a:27017,host-b:27018/app', 'authSource=admin', 'tls=true']) assert(uriSummary.includes(value), value);
    assert(!uriSummary.includes('p%40ssword') && !uriSummary.includes('segreto-token'));
    await page.keyboard.press('Escape');
    report.checks.push('URI multi-host leggibile con password e opzioni sensibili mascherate');

    await page.evaluate(async () => (await import('/js/connection.js')).startEditConn('Connessione esistente'));
    await page.locator('#connect-overlay[data-arc-dialog="open"]').waitFor();
    await page.locator('#connect-btn').click();
    assert.match(await page.locator('#conn-save-status').textContent(), /connessione salvata verrà aggiornata/);
    assert.equal((await page.locator('#wizard-summary-box').textContent()).match(/Invariata · Già salvata/g).length, 2);
    await field('saveAs').fill('');
    assert.match(await page.locator('#conn-save-status').textContent(), /non verrà salvata/);
    await page.locator('#connect-btn').click();
    await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
    assert.equal((await requests()).at(-1).keepPasswordFrom, 'Connessione esistente');
    assert.equal((await requests()).at(-1).saveAs, '');
    report.checks.push('Modifica esistente: segreti mantenuti dichiarati, stato aggiornato se si cancella il nome');
    assert.deepEqual(report.errors, []);
    console.log(`OK: ${report.checks.length} scenari conferma connessione e ${report.layouts.length} layout`);
  } catch (error) {
    report.failure = error.stack;
    await page.screenshot({ path: `${dir}/failure.png` }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    await browser.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
