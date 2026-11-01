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
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  page.on('pageerror', error => errors.push(error.message));
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (process.argv.includes('--mutant=posizione-messaggio')) await page.route(`${server.url}/`, async route => {
      const response = await route.fetch(), source = await response.text();
      const box = '<div id="query-error-box" class="hidden" role="alert" aria-atomic="true"></div>';
      const surface = '<div id="query-surface-content"';
      assert(source.includes(box) && source.includes(surface), 'Il mutante deve ripristinare il messaggio sopra l’editor');
      await route.fulfill({ response, body: source.replace(box, '').replace(surface, `${box}\n${surface}`) });
    });
    if (mutantErrorSurface) await page.route('**/js/query-tab.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const original = "if ($('.query-main-panel')?.dataset.surface === 'results') setQuerySurface('editor');";
      assert(source.includes(original), 'Il mutante deve forzare la vista Editor anche da Entrambi');
      await route.fulfill({ response, body: source.replace(original, "setQuerySurface('editor');") });
    });
    if (process.argv.includes('--mutant=ridondanza')) await page.route('**/js/query-tab.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const original = "statusBadge.classList.toggle('hidden', status === 'error');";
      assert(source.includes(original), 'Il mutante deve ripristinare il badge Errore duplicato');
      await route.fulfill({ response, body: source.replace(original, "statusBadge.classList.toggle('hidden', false);") });
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
      window.qef = { queue: [], sent: [], notices: [], tabs, resultRequests: [] };
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
          if (name === 'script:result') {
            window.qef.resultRequests.push({ payload, ack });
            return;
          }
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
    const dialog = page.locator('#query-error-box .data-empty');
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
    await page.evaluate(async () => {
      const tab = (await import('/js/tabs.js')).activeTab();
      tab.dbType = tab.state.dbType = 'mongodb';
      tab.label = tab.state.connLabel = 'MongoDB di prova';
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      document.getElementById('query-target-engine').value = 'auto';
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async width => (await import('/js/theme.js')).applicaTema(width > 900 ? 'dark' : 'light'), width);
      const sql = 'SELECT * FROM "sadkmaskmd"';
      await start(sql);
      await answer(sql, { ok: false, error: 'Traduzione SQL→MongoDB non riuscita: Atteso un identificatore, trovato "sadkmaskmd".' });
      await assertMark('"sadkmaskmd"', sql.indexOf('"sadkmaskmd"'));
      assert(await page.locator('#query-results-container #query-error-box').count(), 'Il messaggio specifico deve stare nel pannello risultati');
      assert.equal(await page.locator('#query-status-badge').isVisible(), false, 'Il badge Errore non deve duplicare il messaggio');
      assert.equal(await page.locator('#query-count-metric').isVisible(), false, 'Zero record non descrive una query fallita');
      const underline = await marks.first().evaluate(el => {
        const probe = document.createElement('span'); probe.style.color = 'var(--danger)'; el.append(probe);
        const expected = getComputedStyle(probe).color; probe.remove();
        return { expected, actual: getComputedStyle(el).textDecorationColor, style: getComputedStyle(el).textDecorationStyle };
      });
      assert.equal(underline.actual, underline.expected, 'La sottolineatura usa il rosso di errore del tema');
      assert.equal(underline.style, 'wavy');
      assert.equal(await page.locator('#query-results-body').getByText('La query non è riuscita', { exact: true }).count(), 1, 'Un solo riepilogo di errore');
      assert.equal(await page.locator('#query-error-box .feedback-message').count(), 0, 'Nessun banner di notifica nei risultati');
      const controls = await dialog.getByRole('button', { name: 'Vai all’editor query' }).boundingBox();
      const body = await page.locator('#query-results-body').boundingBox();
      assert(controls.y >= body.y && controls.y + controls.height <= body.y + body.height + 1, 'Il pulsante deve restare visibile anche nei risultati bassi');
      await page.screenshot({ path: `${dir}/sql-mongo-${width}.png` });
      const copyError = dialog.getByRole('button', { name: 'Copia errore', exact: true });
      assert.equal((await copyError.textContent()).trim(), '', 'Copia errore deve mostrare solo l’icona');
      await copyError.locator('.lucide-copy').waitFor();
      await copyError.click();
      await copyError.locator('span:not([aria-hidden="true"]) > .lucide-check').waitFor();
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /sadkmaskmd/);
      await copyError.locator('span:not([aria-hidden="true"]) > .lucide-copy').waitFor({ timeout: 3000 });
      assert.equal(await page.locator('#toast-container').getByText('Errore copiato.', { exact: true }).count(), 0, 'La spunta sostituisce il toast di conferma');
    }
    checks.push('SQL→MongoDB: token fra apici sottolineato, unico errore nei risultati e copia, su desktop e mobile');
    await page.evaluate(async () => {
      const tab = (await import('/js/tabs.js')).activeTab();
      tab.dbType = tab.state.dbType = 'postgresql';
      tab.label = tab.state.connLabel = 'PostgreSQL di prova';
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await start(initial);
    const sent = initial.trim();
    await answer(initial, { ok: false, error: message, queryError: { start: sent.indexOf('inesistente'), end: sent.indexOf('inesistente') + 11 } });
    await assertMark('inesistente', initial.indexOf('inesistente'));
    await dialog.waitFor({ state: 'attached' });
    assert(await dialog.getByText(message, { exact: true }).isVisible());
    assert.equal(await page.locator('.illustrated-error-snackbar').count(), 0, 'Nessun dialog per un errore query');
    assert.equal(await page.evaluate(async () => (await import('/js/query-document.js')).queryDocument().dirty), true, 'L’errore conserva la bozza');
    await page.screenshot({ path: `${dir}/mobile-light.png` });
    await page.evaluate(async () => (await import('/js/theme.js')).applicaTema('dark'));
    await page.screenshot({ path: `${dir}/mobile-dark.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
    assert(await dialog.getByText(message, { exact: true }).isVisible(), 'Stesso errore inline su desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole('button', { name: 'Vai all’editor query' }).click();
    assert.equal(await page.locator('.query-main-panel').getAttribute('data-surface'), 'both', 'Il pulsante conserva Entrambi');
    assert(await editor.evaluate(el => el === document.activeElement), 'Modifica query riporta il focus all’editor');
    await assertMark('inesistente', initial.indexOf('inesistente'));
    checks.push('Errore inline mobile/desktop, temi chiaro/scuro, bozza conservata e ritorno all’editor');

    await editor.fill('SELECT 1');
    assert.equal(await marks.count(), 0, 'Una modifica invalida subito il segno precedente');
    assert.equal(await editor.getAttribute('aria-invalid'), null);
    await editor.fill(initial);
    assert.equal(await marks.count(), 0, 'Riscrivere il testo non riesuma il vecchio errore');
    await start('SELECT * FROM senza_posizione');
    await answer('SELECT * FROM senza_posizione', { ok: false, error: 'Errore privo di posizione attendibile.' });
    await dialog.waitFor({ state: 'attached' });
    assert.equal(await marks.count(), 0, 'Nessuna posizione inventata quando manca il dato del motore');
    checks.push('Modifiche e nuovo tentativo invalidano i segni; errori senza posizione restano leggibili senza sottolineature arbitrarie');

    // La risposta può contenere soltanto il messaggio parlante e il dettaglio
    // del driver (ad esempio con un server già avviato prima dell'aggiornamento).
    await start('SELECT * FROM sndasjkdn;');
    await answer('SELECT * FROM sndasjkdn;', { ok: false,
      error: 'La tabella indicata non esiste in questo database. Cosa fare: controlla il nome. (dettaglio tecnico: relation "sndasjkdn" does not exist)' });
    await dialog.waitFor({ state: 'attached' });
    await dialog.getByRole('button', { name: 'Vai all’editor query' }).click();
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
    assert.equal(await dialog.count(), 1, 'Desktop mantiene l’errore inline');
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
    assert.equal(await dialog.count(), 1, 'Ripristinare la scheda conserva l’errore inline');
    await dialog.waitFor({ state: 'attached' });
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
    assert.equal(await dialog.count(), 0, 'Durante lo script l’errore resta nel log e nell’editor');
    await page.evaluate(({ runId, result }) => window.qef.push('script:progress', {
      runId, tipo: 'done', stato: { status: 'done', total: 2, cursor: 2, eseguiti: 2, falliti: 1, results: [result] },
      ultimoRisultato: { ...result, docs: [], columns: [] },
      risultati: { schede: [{ pos: 0, index: 0, line: 1, sql: 'SELECT 1', rows: 1 },
        { pos: 1, index: 1, line: 2, sql: 'SELECT * FROM script_assente', error: result.error }] },
    }), { runId: scriptRequest.runId, result: scriptError });
    await settled();
    const resultTabs = page.locator('#script-results-tabs [role="tab"]');
    assert.equal(await resultTabs.count(), 2, 'La query fallita ha una scheda accanto a quella riuscita');
    assert.equal(await resultTabs.nth(1).getAttribute('aria-selected'), 'true');
    assert(await resultTabs.nth(1).getByText('Errore', { exact: true }).isVisible());
    assert.equal(await dialog.count(), 1);
    assert.equal(await page.locator('#query-results-body').getAttribute('data-query-error'), 'empty');
    const answerResult = (pos, result) => page.evaluate(({ pos, result }) => {
      const index = window.qef.resultRequests.findIndex(r => r.payload.pos === pos);
      if (index < 0) throw new Error(`Richiesta scheda ${pos} mancante`);
      window.qef.resultRequests.splice(index, 1)[0].ack({ ok: true, ...result });
    }, { pos, result });
    await resultTabs.nth(0).click();
    await answerResult(0, { index: 0, docs: [{ id: 7 }], columns: ['id'] });
    await settled();
    assert.equal(await dialog.count(), 0, 'L’errore non invade la scheda riuscita');
    assert.equal(await page.locator('#query-result-table tbody').getByText('7', { exact: true }).count(), 1);
    assert(await page.locator('#query-count-metric').isVisible());
    await page.evaluate(async () => {
      const query = await import('/js/query-tab.js');
      query.updateQueryMetrics('success', 5, 1);
      query.setResultsViewMode('json');
    });
    assert.equal(await dialog.count(), 0, 'Un risultato riuscito non riesuma il vecchio messaggio cambiando formato');
    await assertMark('script_assente', script.indexOf('script_assente'));
    await resultTabs.nth(1).click();
    await answerResult(1, { ...scriptError, ok: true, docs: [], columns: [] });
    await settled();
    assert.equal(await dialog.count(), 1, 'La scheda fallita ripristina il proprio errore');
    assert.equal(await page.locator('#query-results-body').getAttribute('data-query-error'), 'empty');
    await assertMark('script_assente', script.indexOf('script_assente'));
    // Due clic ravvicinati: la risposta più vecchia arriva per ultima.
    await resultTabs.nth(1).click();
    await resultTabs.nth(0).click();
    await answerResult(0, { index: 0, docs: [{ id: 7 }], columns: ['id'] });
    await answerResult(1, { ...scriptError, ok: true, docs: [], columns: [] });
    await settled();
    assert.equal(await resultTabs.nth(0).getAttribute('aria-selected'), 'true', 'Vince l’ultima scheda richiesta');
    assert.equal(await dialog.count(), 0, 'Una risposta tardiva non sostituisce i dati con un errore');
    checks.push('Script misto: schede separate, errore isolato, sottolineatura e risposte fuori ordine');

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const ultimaFallita of [false, true]) {
        const mixedCode = `SELECT * FROM prima_assente;\nSELECT * FROM ${ultimaFallita ? 'seconda_assente' : 'valida'};`;
        await start(mixedCode);
        const runId = await page.evaluate(() => window.qef.queue.find(r => r.name === 'script:execute').payload.runId);
        await answer(mixedCode, { ok: true, runId, total: 2 });
        const failures = ['prima_assente', ...(ultimaFallita ? ['seconda_assente'] : [])].map((nome, index) => ({
          index, line: index + 1, ok: false, sql: `SELECT * FROM ${nome}`,
          error: `La tabella ${nome} non esiste.`, queryError: { start: mixedCode.indexOf(nome), end: mixedCode.indexOf(nome) + nome.length },
        }));
        const ultimo = ultimaFallita ? { ...failures[1], docs: [], columns: [] }
          : { index: 1, docs: [], columns: ['id'] };
        await page.evaluate(({ runId, failures, ultimo }) => window.qef.push('script:progress', {
          runId, tipo: 'done', stato: { status: 'done', total: 2, cursor: 2, eseguiti: 2,
            falliti: failures.length, results: failures }, ultimoRisultato: ultimo,
          risultati: { schede: [
            { ...failures[0], pos: 0, rows: 0 },
            { ...ultimo, pos: 1, line: 2, sql: 'SELECT * FROM ultima', rows: 0 },
          ] },
        }), { runId, failures, ultimo });
        await settled();
        assert.equal(await resultTabs.count(), 2);
        assert.equal(await resultTabs.nth(1).getAttribute('aria-selected'), 'true');
        if (ultimaFallita) {
          assert(await dialog.getByText(failures[1].error, { exact: true }).isVisible(), 'Ogni errore conserva il proprio messaggio');
          await assertMark('seconda_assente', mixedCode.indexOf('seconda_assente'));
        } else {
          assert.equal(await dialog.count(), 0, 'Una SELECT riuscita senza righe resta separata dall’errore precedente');
          assert.equal(await page.locator('#query-results-body').getAttribute('data-query-error'), '');
          assert.equal(await resultTabs.nth(1).getByText('0 righe', { exact: true }).count(), 1);
        }
        await page.screenshot({ path: `${dir}/script-${width}-${ultimaFallita ? 'errore' : 'vuota'}.png` });
        await resultTabs.nth(0).click();
        await answerResult(0, { ...failures[0], ok: true, docs: [], columns: [] });
        await settled();
        assert(await dialog.getByText(failures[0].error, { exact: true }).isVisible());
        await assertMark('prima_assente', mixedCode.indexOf('prima_assente'));
        const toastCount = await page.evaluate(() => window.qef.notices.length);
        await dialog.getByRole('button', { name: 'Copia errore', exact: true }).click();
        await page.waitForFunction(text => navigator.clipboard.readText().then(value => value === text), failures[0].error);
        assert.equal(await page.evaluate(() => window.qef.notices.length), toastCount, 'Anche la copia dalla scheda errore resta senza toast');
      }
    }
    checks.push('Desktop/mobile: errore seguito da SELECT vuota, errori distinti per scheda e copia senza toast');

    // Il server può diradare tutti gli eventi statement: resta il riepilogo finale.
    await start(script);
    const terminalRun = await page.evaluate(() => window.qef.queue.find(request => request.name === 'script:execute').payload.runId);
    await answer(script, { ok: true, runId: terminalRun, total: 2 });
    await page.evaluate(({ runId, result }) => window.qef.push('script:progress', {
      runId, tipo: 'done', stato: { status: 'done', total: 2, cursor: 2, eseguiti: 2, falliti: 1, results: [result] },
    }), { runId: terminalRun, result: scriptError });
    await dialog.waitFor({ state: 'attached' });
    await assertMark('script_assente', script.indexOf('script_assente'));
    assert(await dialog.getByText(scriptError.error, { exact: true }).isVisible());
    checks.push('Script con eventi intermedi diradati: errore e posizione recuperati dal solo riepilogo finale');

    // La ripresa nasconde il vecchio segno durante l’esecuzione e lo ripristina al termine.
    await start(script);
    const pausedRun = await page.evaluate(() => window.qef.queue.find(request => request.name === 'script:execute').payload.runId);
    await answer(script, { ok: true, runId: pausedRun, total: 2 });
    await page.evaluate(({ runId, result }) => window.qef.push('script:progress', {
      runId, tipo: 'paused', stato: { status: 'paused', total: 2, cursor: 1, eseguiti: 1, falliti: 1, results: [result] },
    }), { runId: pausedRun, result: scriptError });
    await dialog.waitFor({ state: 'attached' });
    await assertMark('script_assente', script.indexOf('script_assente'));
    await page.locator('#script-resume-btn').click();
    await settled();
    assert.equal(await marks.count(), 0, 'Durante la ripresa non resta un errore dell’esecuzione sospesa');
    await page.evaluate(({ runId, result }) => window.qef.push('script:progress', {
      runId, tipo: 'done', stato: { status: 'done', total: 2, cursor: 2, eseguiti: 2, falliti: 1, results: [result] },
    }), { runId: pausedRun, result: scriptError });
    await assertMark('script_assente', script.indexOf('script_assente'));
    assert.equal(await dialog.count(), 1, 'Il riepilogo dopo la ripresa resta inline, senza dialog');
    checks.push('Pausa/ripresa script: segno azzerato durante il lavoro, ripristinato nel riepilogo senza snackbar duplicata');

    await page.setViewportSize({ width: 320, height: 480 });
    const longMessage = 'La tabella indicata non esiste in questo database. ' +
      'Se il nome contiene maiuscole, scrivilo fra doppi apici: PostgreSQL abbassa gli identificatori non quotati. Controlla il nome dello schema e della tabella, poi riprova. '.repeat(8);
    await start('SELECT * FROM lunghissima');
    await answer('SELECT * FROM lunghissima', { ok: false, error: longMessage, queryError: { start: 14, end: 25 } });
    await dialog.waitFor({ state: 'attached' });
    const copy = dialog.locator('p').first();
    assert.equal(await copy.textContent(), longMessage, 'Il messaggio lungo resta completo');
    const bounds = await dialog.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 320, 'L’errore inline non esce orizzontalmente');
    assert(await copy.evaluate(el => el.scrollHeight > el.clientHeight), 'Il messaggio lungo ha uno scorrimento locale');
    checks.push('Viewport 320×480: testo completo scorrevole e azioni locali');

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
    await dialog.waitFor({ state: 'attached' });
    assert.equal(await surface(), 'editor', 'Un errore conserva la vista Editor');
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
        assert.equal(await surface(), mode, 'L’errore conserva la modalità scelta');
        const go = dialog.getByRole('button', { name: 'Vai all’editor query', includeHidden: true });
        if (mode === 'editor') await go.evaluate(button => button.click());
        else await go.click();
        assert.equal(await surface(), mode === 'results' ? 'editor' : mode, 'Il pulsante apre Editor solo da Risultati');
        assert(await editor.evaluate(el => el === document.activeElement), 'Il pulsante porta il focus al testo della query');
      }
    }
    checks.push('Errore mobile/desktop: modalità conservata; il pulsante apre Editor solo da Risultati e mette a fuoco il codice');

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
