'use strict';

// Controllori e gesti reali; solo DB e ponte Android sono simulati.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutante = process.argv.includes('--mutante-preferenza');
const mutanteGriglia = process.argv.includes('--mutante-griglia');
const dir = 'test-reports/feedback';

(async () => {
  const server = await startTestServer({ port: 3248 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true, serviceWorkers: 'block' });
  const errori = [];
  page.on('pageerror', e => errori.push(e.stack));
  page.setDefaultTimeout(10000);
  const impulsi = () => page.evaluate(() => haptics.map(x => x.kind));
  const azzera = async () => {
    await page.waitForTimeout(150);
    await page.evaluate(() => { haptics.length = 0; });
  };
  try {
    await page.addInitScript(versione => {
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, checklistChiusa: true }));
      window.haptics = [];
      window.CodeDBShell = { postMessage(raw) {
        const msg = JSON.parse(raw);
        if (msg.op === 'haptic') haptics.push({ ...msg, time: performance.now() });
      } };
    }, require('../package.json').version);
    if (mutante) await page.route('**/js/feedback.js', async route => {
      const res = await route.fetch();
      const source = await res.text();
      assert(source.includes('!abilitato ||'));
      await route.fulfill({ response: res, body: source.replace('!abilitato ||', '') });
    });
    if (mutanteGriglia) await page.route('**/js/cellselect.js', async route => {
      const res = await route.fetch();
      const source = await res.text();
      assert(source.includes('if (leggero) {'));
      await route.fulfill({ response: res, body: source.replace('if (leggero) {', 'if (false) {') });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.waitForSelector('#feedback-live', { state: 'attached' });
    await page.evaluate(async () => {
      window.feedback = await import('/js/feedback.js');
      const b = document.createElement('button');
      b.id = 'prova-feedback'; b.textContent = 'Prova feedback';
      b.style.cssText = 'position:fixed;top:4px;right:4px;z-index:99999';
      document.body.append(b);
    });
    const bottone = page.locator('#prova-feedback');
    await bottone.click();
    assert.deepEqual(await impulsi(), ['pressione'], 'Un clic produce un solo impulso');
    await azzera();
    await bottone.focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await impulsi(), ['pressione'], 'Anche l’attivazione da tastiera riceve feedback');
    await azzera();
    await page.evaluate(() => document.querySelector('#prova-feedback').click());
    assert.deepEqual(await impulsi(), [], 'I clic programmatici non duplicano il feedback');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await bottone.click();
    assert.equal(await bottone.evaluate(b => b.getAnimations().length), 0, 'Riduci movimento esclude le animazioni');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => {
      window.animazioniFeedback = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        if (this.id === 'prova-feedback') animazioniFeedback.push(options.duration);
        return animate.call(this, frames, options);
      };
    });
    await bottone.click();
    assert.deepEqual(await page.evaluate(() => animazioniFeedback), [140], 'Transizione breve sul pulsante');
    await page.evaluate(() => document.querySelector('#prova-feedback').remove());

    // Il menu reale rende la preferenza raggiungibile e conferma la scelta.
    await page.locator('#conn-settings-btn').click();
    await page.getByRole('menuitem', { name: 'Feedback aptico: di sistema' }).click();
    await page.waitForFunction(() => localStorage.getItem('codedb:feedback-aptico') === 'off');
    await azzera();
    await page.evaluate(() => feedback.feedbackAptico('conferma'));
    assert.deepEqual(await impulsi(), [], 'La preferenza disattivata blocca gli impulsi');
    await page.reload();
    await page.waitForSelector('#feedback-live', { state: 'attached' });
    await page.evaluate(async () => {
      window.feedback = await import('/js/feedback.js');
      feedback.feedbackAptico();
    });
    assert.deepEqual(await impulsi(), [], 'La preferenza sopravvive al ricaricamento');
    await page.locator('#conn-settings-btn').click();
    await page.getByRole('menuitem', { name: 'Feedback aptico: disattivato' }).click();
    await page.waitForFunction(() => localStorage.getItem('codedb:feedback-aptico') === 'on');
    await azzera();
    await page.evaluate(() => {
      for (let i = 0; i < 40; i++) feedback.feedbackAptico('selezione');
    });
    assert.deepEqual(await impulsi(), ['selezione'], 'Gli impulsi della selezione sono diradati');
    console.log('OK pulsanti, tastiera, movimento ridotto, preferenza persistente e frequenza');

    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'feedback-fixture' });
      tab.dbType = 'postgresql'; tabs.activeId = tab.id;
      const collections = [{ name: 'righe' }];
      const databases = [{ name: 'prova', collections }];
      Object.assign(tab.state, { connected: true, dbType: tab.dbType, databases });
      window.prova = { queue: [], sent: [], handlers: {} };
      const fake = { connected: true, on(n, fn) { prova.handlers[n] = fn; return fake; }, off() { return fake; },
        emit(name, payload, ack) {
          prova.sent.push({ name, payload });
          if (name === 'query:execute') { prova.queue.push(ack); return; }
          if (name === 'script:execute') { ack({ ok: true, runId: payload.runId, total: 2 }); return; }
          if (name === 'script:resume') {
            if (prova.holdResume) { prova.resumeAck = ack; return; }
            ack({ ok: true, stato: { status: 'running', total: 2, eseguiti: 1 } }); return;
          }
          ack?.({ ok: true, databases, collections, fields: [], indexes: [], docs: [], columns: [], total: 0, relazioni: [] });
        } };
      (await import('/js/socket.js')).impostaSocket(fake);
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('prova', 'righe');
      (await import('/js/main.js')).setView('query');
      prova.query = await import('/js/query-tab.js');
      prova.script = await import('/js/script-run.js');
      prova.script.initScriptRun();
      prova.query.resetQueryView();
    });
    const editor = page.locator('#query-editor-input');
    const badge = page.locator('#query-status-badge');
    await editor.fill('SELECT 1');
    await azzera();
    await page.locator('#query-run-btn').click();
    assert.equal(await badge.textContent(), 'Esecuzione...');
    assert.deepEqual(await impulsi(), ['pressione'], 'Avvio query senza doppio impulso pulsante/query');
    await azzera();
    await page.evaluate(() => prova.queue.shift()({ ok: true, data: [{ id: 1 }], columns: ['id'] }));
    await page.waitForFunction(() => document.querySelector('#view-query').dataset.queryState === 'success');
    assert.deepEqual(await impulsi(), ['conferma']);
    assert.equal(await badge.textContent(), '✓ Completato');
    assert.equal(await badge.getAttribute('role'), 'status');
    await azzera();
    await page.evaluate(() => prova.query.restoreQueryView(prova.query.snapshotQueryView()));
    assert.deepEqual(await impulsi(), [], 'Ripristinare una scheda non simula un completamento');

    await editor.fill('SELECT errore');
    await page.locator('#query-run-btn').click();
    await azzera();
    await page.evaluate(() => prova.queue.shift()({ ok: false, error: 'Errore di prova' }));
    await page.waitForFunction(() => document.querySelector('#view-query').dataset.queryState === 'error');
    assert.deepEqual(await impulsi(), ['errore']);
    assert.match(await page.locator('#query-error-box').textContent(), /Errore di prova/);

    await editor.fill('SELECT 1');
    await page.locator('#query-run-btn').click();
    await azzera();
    await page.locator('#query-stop-btn').click();
    assert.equal(await badge.textContent(), 'Annullata');
    await azzera();
    await page.evaluate(() => prova.queue.shift()({ ok: true, data: [{ id: 9 }] }));
    assert.deepEqual(await impulsi(), [], 'Una risposta tardiva dopo l’annullamento rimane silenziosa');
    assert.equal(await badge.textContent(), 'Annullata');

    await page.locator('#query-run-btn').click();
    await page.evaluate(async () => (await import('/js/main.js')).setView('data'));
    await azzera();
    await page.evaluate(() => prova.queue.shift()({ ok: true, data: [{ id: 1 }], columns: ['id'] }));
    assert.deepEqual(await impulsi(), [], 'Nessun feedback della query mentre si guarda un’altra vista');
    await page.evaluate(async () => (await import('/js/main.js')).setView('query'));

    await editor.fill('SELECT 1; SELECT 2;');
    await page.locator('#query-run-btn').click();
    await azzera();
    await page.evaluate(() => {
      const runId = prova.sent.filter(s => s.name === 'script:execute').at(-1).payload.runId;
      prova.progress = (tipo, status, falliti = 0) => prova.handlers['script:progress']({
        runId, tipo, stato: { status, falliti, total: 2, eseguiti: 2, startedAt: 10, endedAt: 100 },
        ultimoRisultato: { docs: [{ id: 2 }], columns: ['id'] },
      });
      prova.progress('paused', 'paused');
    });
    assert.equal(await badge.textContent(), 'In pausa');
    await azzera();
    await page.evaluate(() => prova.script.resumeScript());
    assert.equal(await badge.textContent(), 'Esecuzione...');
    assert.deepEqual(await impulsi(), ['pressione']);
    await page.evaluate(() => {
      prova.progress('paused', 'paused');
      prova.holdResume = true;
      prova.resuming = prova.script.resumeScript();
    });
    await azzera();
    await page.evaluate(() => prova.progress('done', 'done'));
    assert.equal(await badge.textContent(), '✓ Completato');
    assert.deepEqual(await impulsi(), ['conferma']);
    await azzera();
    await page.evaluate(async () => {
      prova.resumeAck({ ok: true, stato: { status: 'running', total: 2, eseguiti: 1 } });
      await prova.resuming;
    });
    assert.equal(await badge.textContent(), '✓ Completato', 'Un ack tardivo di ripresa non riporta lo script in esecuzione');
    assert.deepEqual(await impulsi(), [], 'Nessun feedback di ripresa dopo la fine');
    await page.evaluate(() => prova.progress('done', 'done'));
    assert.deepEqual(await impulsi(), [], 'Nessun impulso per un evento finale duplicato');
    console.log('OK query e script: avvio, successo, errore, annullamento, pausa e ripristino');

    // La stessa selezione usata da Dati, risultati e pannelli, con vero touch Chromium.
    await page.evaluate(async () => {
      const { creaSelezioneCelle } = await import('/js/cellselect.js');
      const wrap = document.createElement('div');
      wrap.id = 'feedback-griglia';
      wrap.style.cssText = 'position:fixed;inset:80px 40px auto;z-index:9999;background:var(--bg);height:400px;overflow:auto';
      wrap.innerHTML = '<table style="width:100%"><tbody></tbody></table>';
      const tbody = wrap.querySelector('tbody');
      const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, valore: i * 2 }));
      tbody.innerHTML = rows.map((r, i) => `<tr><td data-r="${i}" data-c="0" style="height:42px">${r.id}</td><td data-r="${i}" data-c="1">${r.valore}</td></tr>`).join('');
      document.body.append(wrap);
      const info = document.createElement('div');
      info.id = 'feedback-conteggio';
      info.style.cssText = 'position:fixed;top:490px;left:40px;z-index:9999;background:var(--bg)';
      document.body.append(info);
      const stato = { anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 }, cells: new Set(['0:0']) };
      prova.griglia = creaSelezioneCelle({
        tbody, thead: () => null, contenitore: () => wrap, info: () => info,
        righe: () => rows, colonne: () => ['id', 'valore'], stato: () => stato, visibile: () => true,
        bersaglio: () => ({}), contesto: () => ({}), assicuraRiga() {}, ricarica() {}, modificaRiga() {}, eliminaRighe() {},
      });
      prova.griglia.applica();
      prova.contatori = (await import('/js/calcoli.js')).contatori;
    });
    const cdp = await page.context().newCDPSession(page);
    const cella = await page.locator('#feedback-griglia td').first().boundingBox();
    const x = Math.round(cella.x + 50), y = Math.round(cella.y + 20);
    const tocco = (type, yy = y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y: yy, id: 1 }] });
    await azzera();
    const calcoliPrima = await page.evaluate(() => prova.contatori.locali + prova.contatori.delegati);
    await tocco('touchStart');
    for (let dy = 20; dy <= 180; dy += 20) {
      await tocco('touchMove', y + dy);
      await page.waitForTimeout(30);
    }
    assert.match(await page.locator('#feedback-conteggio').textContent(), /Selezione in corso/);
    assert(await page.locator('#feedback-griglia tbody').evaluate(e => e.classList.contains('cell-selecting')));
    assert.equal(await page.evaluate(() => prova.contatori.locali + prova.contatori.delegati), calcoliPrima, 'Durante il trascinamento nessuna statistica completa');
    const segnali = await page.evaluate(() => haptics);
    assert.equal(segnali[0].kind, 'pressione');
    assert(segnali.some(s => s.kind === 'selezione'), 'Il passaggio tra celle riceve feedback');
    for (let i = 1; i < segnali.length; i++) assert(segnali[i].time - segnali[i - 1].time >= 119, 'Impulsi distanziati');
    await azzera();
    await tocco('touchEnd');
    assert.deepEqual(await impulsi(), ['conferma']);
    await page.waitForFunction(() => document.querySelector('#feedback-conteggio').textContent.includes('Σ'));
    assert.match(await page.locator('#feedback-live').textContent(), /Selezione completata/);
    assert.equal(await page.locator('#feedback-griglia tbody.cell-selecting').count(), 0);
    await azzera();
    await tocco('touchStart');
    await tocco('touchMove', y + 100);
    await azzera();
    await tocco('touchCancel');
    assert.deepEqual(await impulsi(), [], 'L’annullamento del gesto non conferma una riuscita');
    assert.match(await page.locator('#feedback-live').textContent(), /interrotto/);
    assert.equal(await page.locator('#feedback-griglia tbody.cell-selecting').count(), 0);
    console.log('OK trascinamento touch, conteggio, statistiche al rilascio e annullamento');

    await page.evaluate(() => { document.querySelector('#feedback-griglia').remove(); document.querySelector('#feedback-conteggio').remove(); });
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/query-desktop.png` });
    await page.setViewportSize({ width: 412, height: 915 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/query-mobile.png` });
    await azzera();
    await page.evaluate(() => {
      delete window.CodeDBShell;
      feedback.feedbackAptico();
      window.CodeDBShell = { postMessage() { throw Error('Ponte non disponibile'); } };
      feedback.feedbackAptico();
    });
    assert.deepEqual(await impulsi(), [], 'Browser senza ponte e ponte guasto restano utilizzabili');
    assert.deepEqual(errori, []);
    console.log('OK nessun errore JavaScript');
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
