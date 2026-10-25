'use strict';

// ACK e push controllati, editor/controller/Arc reali: nessun database esterno.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const mutantFallback = process.argv.includes('--mutant=fallback');
const mutantSurface = process.argv.includes('--mutant=surface');
const mutantErrorSurface = process.argv.includes('--mutant=error-surface');
const dir = `${process.env.CODEDB_REPORT_ROOT || 'test-reports'}/query-error-feedback`;
const version = require('../package.json').version;

(async () => {
  const server = await startTestServer({ port: 3184 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  page.setDefaultTimeout(15000);
  const errors = [];
  const checks = [];
  page.on('pageerror', error => errors.push(error.message));
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (mutantErrorSurface) await page.route('**/js/query-tab.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const original = "if (mark && mark.code === $('#query-editor-input')?.value && $('.query-main-panel')?.dataset.surface === 'results') {";
      assert(source.includes(original), 'Il mutante deve disattivare il ritorno all’Editor');
      await route.fulfill({ response, body: source.replace(original, 'if (false) {') });
    });
    if (mutantSurface) await page.route('**/js/query-tab.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const original = 'export function mostraRisultatiQueryRiuscita() {';
      assert(source.includes(original), 'Il mutante deve disattivare il passaggio ai risultati');
      await route.fulfill({ response, body: source.replace(original, original + ' return;') });
    });
    if (mutantFallback) await page.route('**/js/query-tab.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const original = 'errore.queryError || intervalloErroreQuery(errore, sorgente?.executedCode, sorgente?.dbms)';
      assert(source.includes(original), 'Il mutante deve rimuovere il recupero dal messaggio');
      await route.fulfill({ response, body: source.replace(original, 'errore.queryError') });
    });
    if (mutant) await page.route('**/js/trasporto.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const body = source.replace('error.queryError = res.queryError', 'error.queryError = undefined');
      assert.notEqual(body, source, 'Il mutante deve interrompere la propagazione della posizione');
      await route.fulfill({ response, body });
    });
    await page.addInitScript(version => {
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true }));
    }, version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    const onboarding = page.locator('#onboarding-overlay [data-azione="chiudi"]');
    if (await onboarding.isVisible()) await onboarding.click();
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const callbacks = new Map();
      window.qef = { queue: [], sent: [], notices: [], tabs };
      document.addEventListener('codedb:toast', event => window.qef.notices.push(event.detail.message));
      const fields = [{ name: 'id', types: ['integer'], presence: 100 }];
      const collections = ['prima', 'seconda'].map(name => ({ name, fields, indexes: [] }));
      const fake = {
        connected: true,
        on(name, callback) { if (!callbacks.has(name)) callbacks.set(name, new Set()); callbacks.get(name).add(callback); return fake; },
        off(name, callback) { callbacks.get(name)?.delete(callback); return fake; },
        timeout() { return { emit(name, payload, ack) { fake.emit(name, payload, result => ack(null, result)); } }; },
        emit(name, payload, ack) {
          window.qef.sent.push({ name, payload });
          if (name === 'query:execute' || name === 'script:execute') {
            window.qef.queue.push({ name, payload, ack });
            return;
          }
          if (name === 'script:resume') {
            ack?.({ ok: true, stato: { status: 'running', total: 2, cursor: 1, eseguiti: 1, falliti: 1 } });
            return;
          }
          ack?.({ ok: true, docs: [{ id: 1 }], columns: ['id'], total: 1, skip: 0, limit: 50,
            fields, indexes: [], collections, databases: [{ name: 'prova' }], relazioni: [], stats: { count: 1 }, sessions: [] });
        },
      };
      impostaSocket(fake);
      (await import('/js/script-run.js')).initScriptRun();
      window.qef.push = (name, event) => callbacks.get(name)?.forEach(callback => callback(event));
      window.qef.answer = (code, result) => {
        const index = window.qef.queue.findIndex(request => request.payload.code === code);
        if (index < 0) throw new Error(`ACK mancante per ${code}`);
        window.qef.queue.splice(index, 1)[0].ack(result);
      };
      const tab = createTab({ id: 'error-feedback' });
      tab.label = 'PostgreSQL di prova'; tab.dbType = 'postgresql';
      Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: tab.dbType, databases: [{ name: 'prova', collections }] });
      tabs.activeId = tab.id;
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('prova', 'prima');
      (await import('/js/main.js')).setView('query');
      window.qef.firstId = tab.state.activeCollId;
    });
    const editor = page.locator('#query-editor-input');
    const marks = page.locator('#query-editor-code .query-error-mark');
    const dialog = page.getByRole('dialog', { name: 'La query non è riuscita' });
    const reopen = page.getByRole('button', { name: 'Mostra errore', exact: true });
    const message = 'La tabella indicata non esiste in questo database. Controlla il nome e riprova.';
    const start = async text => {
      await editor.fill(text);
      await page.locator('#query-run-btn').click();
      await page.waitForFunction(code => window.qef.queue.some(request => request.payload.code === code), text.trim());
    };
    const answer = async (code, result) => {
      await page.evaluate(({ code, result }) => window.qef.answer(code.trim(), result), { code, result });
    };
    const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const assertMark = async (text, start) => {
      await page.waitForFunction(expected => Array.from(document.querySelectorAll('#query-editor-code .query-error-mark')).map(el => el.textContent).join('') === expected, text, { timeout: 5000 });
      const actual = await marks.first().evaluate(mark => {
        const prefix = document.createRange();
        prefix.setStart(document.getElementById('query-editor-code'), 0);
        prefix.setEndBefore(mark);
        return { start: prefix.toString().length, line: getComputedStyle(mark).textDecorationLine, style: getComputedStyle(mark).textDecorationStyle };
      });
      assert.equal(actual.start, start, 'La sottolineatura deve individuare il token giusto nel testo originale');
      assert(actual.line.includes('underline'), 'Il token deve essere sottolineato');
      assert.equal(await editor.getAttribute('aria-invalid'), 'true');
    };

    const initial = '  \n SELECT * FROM inesistente;  \n';
    await start(initial);
    const sent = initial.trim();
    await answer(initial, { ok: false, error: message, queryError: { start: sent.indexOf('inesistente'), end: sent.indexOf('inesistente') + 11 } });
    await assertMark('inesistente', initial.indexOf('inesistente'));
    await dialog.waitFor();
    assert(await dialog.locator('.data-empty-art').isVisible());
    assert(await dialog.getByText(message, { exact: true }).isVisible());
    const geometry = await dialog.evaluate(el => ({
      dialog: el.getBoundingClientRect().toJSON(),
      art: el.querySelector('.data-empty-art').getBoundingClientRect().toJSON(),
      title: el.querySelector('.illustrated-error-copy h2').getBoundingClientRect().toJSON(),
    }));
    assert(Math.abs(geometry.dialog.x + geometry.dialog.width / 2 - 195) < 3, 'Snackbar centrata orizzontalmente');
    assert(Math.abs(geometry.dialog.y + geometry.dialog.height / 2 - 422) < 3, 'Snackbar centrata verticalmente');
    assert(geometry.art.width >= 200 && geometry.art.height >= 120, 'L’illustrazione è l’elemento principale');
    assert(geometry.art.bottom <= geometry.title.top, 'Il testo compare sotto l’illustrazione');
    assert(geometry.dialog.bottom <= 844 && geometry.dialog.y >= 0, 'Il dialog rimane nel viewport mobile');
    assert.equal(await page.evaluate(async () => (await import('/js/query-document.js')).queryDocument().dirty), true, 'Un errore non salva né perde la bozza');
    assert(!(await page.evaluate(() => window.qef.notices)).some(notice => notice.includes(message)), 'Nessun toast duplicato dell’errore');
    await page.screenshot({ path: `${dir}/mobile-light.png` });
    await page.evaluate(async () => (await import('/js/theme.js')).applicaTema('dark'));
    await page.screenshot({ path: `${dir}/mobile-dark.png` });
    await dialog.getByRole('button', { name: 'Ho capito' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert((await page.locator('#query-error-box').boundingBox()).height <= 80, 'Il riepilogo mobile non occupa lo spazio di un secondo messaggio esteso');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => !document.querySelector('#query-error-box .query-error-summary'));
    assert((await page.locator('#query-error-box').textContent()).includes(message), 'Passando a desktop resta il messaggio inline completo');
    await page.setViewportSize({ width: 390, height: 844 });
    await reopen.waitFor();
    assert.equal(await dialog.count(), 0, 'Il cambio viewport non riapre un dialog già chiuso');
    await reopen.click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Modifica query' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert(await editor.evaluate(el => el === document.activeElement), 'Modifica query riporta il fuoco all’editor');
    await assertMark('inesistente', initial.indexOf('inesistente'));
    checks.push('Mobile: snackbar centrale, immagine dominante, messaggio sotto, temi chiaro/scuro, riapertura e ritorno all’editor');

    await editor.fill('SELECT 1');
    assert.equal(await marks.count(), 0, 'Una modifica invalida subito il segno precedente');
    assert.equal(await editor.getAttribute('aria-invalid'), null);
    await editor.fill(initial);
    assert.equal(await marks.count(), 0, 'Riscrivere il testo non riesuma il vecchio errore');
    await start('SELECT * FROM senza_posizione');
    await answer('SELECT * FROM senza_posizione', { ok: false, error: 'Errore privo di posizione attendibile.' });
    await dialog.waitFor();
    assert.equal(await marks.count(), 0, 'Nessuna posizione inventata quando manca il dato del motore');
    await dialog.getByRole('button', { name: 'Ho capito' }).click();
    checks.push('Modifiche e nuovo tentativo invalidano i segni; errori senza posizione restano leggibili senza sottolineature arbitrarie');

    // La risposta può contenere soltanto il messaggio parlante e il dettaglio
    // del driver (ad esempio con un server già avviato prima dell'aggiornamento).
    await start('SELECT * FROM sndasjkdn;');
    await answer('SELECT * FROM sndasjkdn;', { ok: false,
      error: 'La tabella indicata non esiste in questo database. Cosa fare: controlla il nome. (dettaglio tecnico: relation "sndasjkdn" does not exist)' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Modifica query' }).click();
    await dialog.waitFor({ state: 'detached' });
    await assertMark('sndasjkdn', 14);
    await page.screenshot({ path: `${dir}/mobile-editor-error.png` });
    checks.push('Errore reale di tabella inesistente senza metadati: nome sottolineato anche nella vista solo editor');

    await start('SELECT * FROM vecchia');
    await editor.fill('SELECT * FROM nuova');
    await answer('SELECT * FROM vecchia', { ok: false, error: 'Errore della query precedente.', queryError: { start: 14, end: 21 } });
    await settled();
    assert.equal(await marks.count(), 0);
    assert.equal(await dialog.count(), 0, 'Un errore tardivo non apre una snackbar sul testo già cambiato');
    assert.equal(await editor.inputValue(), 'SELECT * FROM nuova');
    checks.push('Risposta dopo una modifica: nessuna snackbar o sottolineatura attribuita al nuovo testo');

    // La stessa parola appare due volte: l’offset deve riferirsi alla selezione.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#query-show-both').click();
    const selection = 'SELECT * FROM sbagliata;\n\n  SELECT * FROM sbagliata;  ';
    await editor.fill(selection);
    await editor.evaluate(el => { el.focus(); el.setSelectionRange(el.value.indexOf('\n\n') + 2, el.value.length); });
    await editor.press('Control+Enter');
    const selected = 'SELECT * FROM sbagliata;';
    await page.waitForFunction(code => window.qef.queue.some(request => request.payload.code === code), selected);
    await answer(selected, { ok: false, error: message, queryError: { start: 14, end: 23 } });
    await assertMark('sbagliata', selection.lastIndexOf('sbagliata'));
    assert.equal(await dialog.count(), 0, 'Desktop mantiene l’errore inline');
    assert(await page.locator('#query-error-box').isVisible());
    assert((await page.locator('#query-error-box').textContent()).includes(message));
    await page.screenshot({ path: `${dir}/desktop-selection.png` });
    checks.push('Desktop: testo inline e sottolineatura precisa nella seconda occorrenza eseguita con Ctrl+Invio, inclusi gli spazi iniziali');

    // Il segno sparisce anche avviando il medesimo testo senza modificarlo.
    await editor.evaluate(el => el.setSelectionRange(el.value.indexOf('\n\n') + 2, el.value.length));
    await editor.press('Control+Enter');
    await page.waitForFunction(code => window.qef.queue.some(request => request.payload.code === code), selected);
    assert.equal(await marks.count(), 0, 'Nuova esecuzione: la segnalazione precedente viene rimossa');
    await answer(selected, { ok: true, data: [{ id: 1 }], columns: ['id'] });
    await page.waitForFunction(() => document.getElementById('view-query').dataset.queryState === 'success');
    checks.push('Riesecuzione dello stesso testo: azzeramento immediato, risultato valido senza residui');

    // Due documenti nella stessa connessione: il primo riceve l’errore in background.
    await page.setViewportSize({ width: 390, height: 844 });
    const background = 'SELECT * FROM assente';
    await start(background);
    await page.evaluate(async () => {
      (await import('/js/colltabs.js')).openCollTab('prova', 'seconda');
      (await import('/js/main.js')).setView('query');
    });
    await editor.fill('SELECT 2');
    await editor.press('Escape');
    await answer(background, { ok: false, error: message, queryError: { start: 14, end: 21 } });
    await settled();
    assert.equal(await dialog.count(), 0);
    assert.equal(await marks.count(), 0);
    assert.equal(await editor.inputValue(), 'SELECT 2');
    await page.evaluate(async () => {
      // Il cambio è pilotato dal controller: riproduce anche il blur del clic sulla scheda.
      document.activeElement?.blur?.();
      (await import('/js/colltabs.js')).switchCollTab(window.qef.firstId);
    });
    assert.equal(await editor.inputValue(), background);
    await assertMark('assente', 14);
    assert.equal(await dialog.count(), 0, 'Ripristinare la scheda conserva il segno senza riaprire il dialog');
    await reopen.click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Ho capito' }).click();
    checks.push('Errore in background isolato alla scheda d’origine; ripristino del segno e riapertura manuale del messaggio');

    // La posizione del push è nell’intero script inviato, non nella singola istruzione.
    const script = '  \nSELECT 1;\nSELECT * FROM script_assente;  ';
    await start(script);
    const scriptRequest = await page.evaluate(() => window.qef.queue.find(request => request.name === 'script:execute').payload);
    await answer(script, { ok: true, runId: scriptRequest.runId, total: 2 });
    const scriptError = { index: 1, line: 2, ok: false, error: 'La tabella script_assente non esiste.', queryError: { start: script.trim().indexOf('script_assente'), end: script.trim().indexOf('script_assente') + 14 } };
    await page.evaluate(({ runId, result }) => window.qef.push('script:progress', {
      runId, tipo: 'statement', result,
      stato: { status: 'running', total: 2, cursor: 2, eseguiti: 2, falliti: 1 },
    }), { runId: scriptRequest.runId, result: scriptError });
    await assertMark('script_assente', script.indexOf('script_assente'));
    await dialog.waitFor();
    assert(await dialog.getByText(scriptError.error, { exact: true }).isVisible());
    await dialog.getByRole('button', { name: 'Ho capito' }).click();
    await page.evaluate(({ runId, result }) => window.qef.push('script:progress', {
      runId, tipo: 'done', stato: { status: 'done', total: 2, cursor: 2, eseguiti: 2, falliti: 1, results: [result] },
    }), { runId: scriptRequest.runId, result: scriptError });
    await settled();
    assert.equal(await dialog.count(), 0, 'La fine dello script non ripropone un errore già mostrato');
    await assertMark('script_assente', script.indexOf('script_assente'));
    checks.push('Script: push con offset globale, messaggio dell’istruzione fallita e nessun duplicato a fine esecuzione');

    // Il server può diradare tutti gli eventi statement: resta il riepilogo finale.
    await start(script);
    const terminalRun = await page.evaluate(() => window.qef.queue.find(request => request.name === 'script:execute').payload.runId);
    await answer(script, { ok: true, runId: terminalRun, total: 2 });
    await page.evaluate(({ runId, result }) => window.qef.push('script:progress', {
      runId, tipo: 'done', stato: { status: 'done', total: 2, cursor: 2, eseguiti: 2, falliti: 1, results: [result] },
    }), { runId: terminalRun, result: scriptError });
    await dialog.waitFor();
    await assertMark('script_assente', script.indexOf('script_assente'));
    assert(await dialog.getByText(scriptError.error, { exact: true }).isVisible());
    await dialog.getByRole('button', { name: 'Ho capito' }).click();
    checks.push('Script con eventi intermedi diradati: errore e posizione recuperati dal solo riepilogo finale');

    // La ripresa nasconde il vecchio segno durante l’esecuzione e lo ripristina al termine.
    await start(script);
    const pausedRun = await page.evaluate(() => window.qef.queue.find(request => request.name === 'script:execute').payload.runId);
    await answer(script, { ok: true, runId: pausedRun, total: 2 });
    await page.evaluate(({ runId, result }) => window.qef.push('script:progress', {
      runId, tipo: 'paused', stato: { status: 'paused', total: 2, cursor: 1, eseguiti: 1, falliti: 1, results: [result] },
    }), { runId: pausedRun, result: scriptError });
    await dialog.waitFor();
    await assertMark('script_assente', script.indexOf('script_assente'));
    await dialog.getByRole('button', { name: 'Ho capito' }).click();
    await page.locator('#script-resume-btn').click();
    await settled();
    assert.equal(await marks.count(), 0, 'Durante la ripresa non resta un errore dell’esecuzione sospesa');
    await page.evaluate(({ runId, result }) => window.qef.push('script:progress', {
      runId, tipo: 'done', stato: { status: 'done', total: 2, cursor: 2, eseguiti: 2, falliti: 1, results: [result] },
    }), { runId: pausedRun, result: scriptError });
    await assertMark('script_assente', script.indexOf('script_assente'));
    assert.equal(await dialog.count(), 0, 'Il riepilogo dopo la ripresa non ripete il dialog già chiuso');
    checks.push('Pausa/ripresa script: segno azzerato durante il lavoro, ripristinato nel riepilogo senza snackbar duplicata');

    await page.setViewportSize({ width: 320, height: 480 });
    const longMessage = 'La tabella indicata non esiste in questo database. ' +
      'Se il nome contiene maiuscole, scrivilo fra doppi apici: PostgreSQL abbassa gli identificatori non quotati. Controlla il nome dello schema e della tabella, poi riprova. '.repeat(8);
    await start('SELECT * FROM lunghissima');
    await answer('SELECT * FROM lunghissima', { ok: false, error: longMessage, queryError: { start: 14, end: 25 } });
    await dialog.waitFor();
    const small = await dialog.evaluate(el => {
      const copy = el.querySelector('.illustrated-error-copy');
      return { rect: el.getBoundingClientRect().toJSON(), art: el.querySelector('.data-empty-art').getBoundingClientRect().toJSON(),
        copy: copy.getBoundingClientRect().toJSON(), scrolls: copy.scrollHeight > copy.clientHeight,
        actions: [...el.querySelectorAll('.illustrated-error-actions button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { rect: rect.toJSON(), reachable: button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
        }) };
    });
    assert(small.rect.x >= 0 && small.rect.y >= 0 && small.rect.right <= 320 && small.rect.bottom <= 480, 'Dialog interamente nel viewport 320×480');
    assert(small.art.bottom <= small.copy.top, 'Anche in poco spazio l’immagine precede l’errore');
    assert(small.scrolls, 'Il messaggio lungo scorre nel proprio spazio');
    assert(small.actions.every(action => action.reachable && action.rect.bottom <= 480), 'Azioni visibili e raggiungibili senza scorrere il messaggio');
    assert((await dialog.textContent()).includes(longMessage), 'Il messaggio completo resta disponibile');
    await page.screenshot({ path: `${dir}/mobile-small-long.png` });
    await dialog.getByRole('button', { name: 'Ho capito' }).click();
    checks.push('Viewport 320×480 e messaggio lungo: immagine sopra, testo scorrevole completo, dialog e azioni entro lo schermo');

    await page.setViewportSize({ width: 390, height: 844 });
    const surface = () => page.locator('.query-main-panel').getAttribute('data-surface');
    for (const mode of ['editor', 'both', 'results']) {
      await page.locator('#query-show-editor').click();
      await editor.fill('SELECT 42');
      await page.locator(`#query-show-${mode}`).click();
      await page.locator('#query-run-btn').click();
      await page.waitForFunction(() => window.qef.queue.some(q => q.payload.code === 'SELECT 42'));
      await answer('SELECT 42', { ok: true, docs: [{ valore: 42 }], columns: ['valore'] });
      await settled();
      assert.equal(await surface(), mode === 'editor' ? 'results' : mode, 'Il successo passa a Risultati solo dalla vista Editor');
    }
    await page.locator('#query-show-editor').click();
    await start('SELECT 42 WHERE false');
    await answer('SELECT 42 WHERE false', { ok: true, docs: [], columns: ['valore'] });
    await settled();
    assert.equal(await surface(), 'results', 'Anche zero righe è un risultato valido');
    await page.locator('#query-show-editor').click();
    await start('SELECT * FROM errore_editor');
    await answer('SELECT * FROM errore_editor', { ok: false, error: 'La query non è valida.' });
    await dialog.waitFor();
    assert.equal(await surface(), 'editor', 'Un errore conserva la vista Editor');
    await dialog.getByRole('button', { name: 'Ho capito' }).click();
    checks.push('Successo: Editor passa a Risultati anche senza righe; Entrambi, Risultati ed errori mantengono la vista');

    await start('SELECT 99');
    await page.evaluate(async () => {
      (await import('/js/colltabs.js')).openCollTab('prova', 'seconda');
      (await import('/js/main.js')).setView('query');
    });
    await page.locator('#query-show-editor').click();
    await answer('SELECT 99', { ok: true, docs: [{ valore: 99 }], columns: ['valore'] });
    await settled();
    assert.equal(await surface(), 'editor', 'Il successo in background non sposta il documento attivo');
    checks.push('Una risposta riuscita in background conserva la vista del documento attivo');

    await start('SELECT 1; SELECT 2;');
    const successfulRun = await page.evaluate(() => window.qef.queue.find(q => q.name === 'script:execute').payload.runId);
    await answer('SELECT 1; SELECT 2;', { ok: true, runId: successfulRun, total: 2 });
    await page.evaluate(runId => window.qef.push('script:progress', {
      runId, tipo: 'done', stato: { status: 'done', total: 2, eseguiti: 2, falliti: 0 },
      ultimoRisultato: { docs: [{ valore: 2 }], columns: ['valore'] },
    }), successfulRun);
    await settled();
    assert.equal(await surface(), 'results', 'Anche lo script concluso con successo apre i risultati dalla vista Editor');
    checks.push('Script completato senza errori: passaggio da Editor a Risultati');

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const mode of ['results', 'both', 'editor']) {
        await page.locator('#query-show-editor').click();
        await editor.fill('SELECT * FROM assente;');
        await page.locator(`#query-show-${mode}`).click();
        await page.locator('#query-run-btn').click();
        await page.waitForFunction(() => window.qef.queue.some(q => q.payload.code === 'SELECT * FROM assente;'));
        await answer('SELECT * FROM assente;', { ok: false, error: 'La tabella assente non esiste.', queryError: { start: 14, end: 21 } });
        await assertMark('assente', 14);
        assert.equal(await surface(), mode === 'results' ? 'editor' : mode, 'L’errore torna all’Editor solo dalla vista Risultati');
        assert(await editor.isVisible(), 'La parte sottolineata è visibile nell’editor');
        if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Ho capito' }).click();
      }
    }
    checks.push('Errore mobile/desktop: ritorno Risultati→Editor con token sottolineato; Editor ed Entrambi mantengono la vista');

    await page.locator('#query-show-results').click();
    await page.locator('#query-run-btn').click();
    await page.waitForFunction(() => window.qef.queue.some(q => q.payload.code === 'SELECT * FROM assente;'));
    await page.evaluate(async () => {
      (await import('/js/colltabs.js')).switchCollTab(window.qef.firstId);
      (await import('/js/main.js')).setView('query');
    });
    await page.locator('#query-show-results').click();
    await answer('SELECT * FROM assente;', { ok: false, error: 'La tabella assente non esiste.', queryError: { start: 14, end: 21 } });
    await settled();
    assert.equal(await surface(), 'results', 'Un errore in background non forza l’Editor nel documento attivo');
    checks.push('Errore in background: nessun cambio della vista del documento attivo');

    assert.deepEqual(errors, [], 'Nessun errore JavaScript o promise rifiutata non gestita');
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify({ transport: 'ACK/push simulati; controller, editor e Arc reali', checks, errors }, null, 2));
    console.log(`OK: ${checks.length} scenari query error feedback\n${checks.map(check => `- ${check}`).join('\n')}`);
  } catch (error) {
    await page.screenshot({ path: `${dir}/failure${mutant ? '-mutant' : ''}.png` }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
