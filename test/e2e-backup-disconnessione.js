'use strict';

// AUD013 UI: browser reale, trasporto deterministico, nessuna connessione DB.
// Il test del lifecycle server e dei dati vive in lab/backup-disconnessione.cjs.
// LAB_BROWSER_CHANNEL=msedge node test/e2e-backup-disconnessione.js [--sensitivity]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const repo = path.resolve(__dirname, '..');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/aud-013/ui-host');
const hash = data => createHash('sha256').update(data).digest('hex');
const sources = ['public/js/backupmanager.js', 'public/js/trasporto.js', 'public/js/socket.js', 'public/js/tabs.js', 'test/e2e-backup-disconnessione.js'];
const report = { suite: 'backup-disconnessione-ui', iniziato: new Date().toISOString(), sorgenti: {}, verifiche: [], scenari: [], mutanti: [] };
for (const file of sources) report.sorgenti[file] = hash(fs.readFileSync(path.join(repo, file)));
let server, browser;

async function fixture(mutant) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  page.labErrors = []; page.on('pageerror', error => page.labErrors.push(error.message));
  await page.addInitScript(version => {
    localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
    window.__labMutationHits = 0;
  }, require('../package.json').version);
  if (mutant) await page.route('**/js/backupmanager.js*', async route => {
    const response = await route.fetch(), source = await response.text();
    const from = "$, emit, toast, openModal";
    assert.equal(source.split(from).length - 1, 1, 'Un solo import emit nella UI sottoposta al mutante');
    let body = source.replace(from, '$, emit as emitOriginaleLab, toast, openModal');
    body += `\n// Mutazione esclusivamente della copia servita al browser di test.\nlet ultimaRichiestaLab;\n`
      + `async function emit(event, payload, options) {\n`
      + ` if (event === 'backup:restore') ultimaRichiestaLab = payload;\n`
      + (mutant === 'stato-ignorato' ? ` if (/^backup:restore:(state|list)$/.test(event)) { window.__labMutationHits++; return new Promise(() => {}); }\n` : '')
      + ` const response = await emitOriginaleLab(event, payload, options);\n`
      + (mutant === 'errore-successo' ? ` if (/^backup:restore:(state|list)$/.test(event)) for (const op of response.operation ? [response.operation] : response.operations || []) { if (['ripristinato_dopo_errore','intervento_richiesto'].includes(op.status)) { window.__labMutationHits++; op.status='completato'; op.error=null; op.recovery=null; op.staging=null; } }\n` : '')
      + ` return response;\n}\n`
      + (mutant === 'ripristino-ripetuto' ? `socket.on('connect', () => { if (ultimaRichiestaLab) { window.__labMutationHits++; socket.emit('backup:restore', ultimaRichiestaLab, () => {}); } });\n` : '');
    await route.fulfill({ response, body });
  });
  await page.goto(server.url); await page.waitForSelector('html[data-arc-ready="true"]');
  await page.evaluate(async () => {
    const [{ createTab, tabs }, { socketReale, impostaSocket }, tabbar, workspace] = await Promise.all([
      import('/js/tabs.js'), import('/js/socket.js'), import('/js/tabbar.js'), import('/js/workspace.js'),
    ]);
    const bus = socketReale();
    const f = window.restoreFixture = {
      sent: [], operations: new Map(), pending: new Map(), originalTab: 'lab-restore-origine',
      connected: true, socketId: 'lab-socket-originale', stateReads: [], listReads: [], heldReads: [], holdReads: false,
      groups: { Collaudo_origine: [{ id: '20261023-full', type: 'full', db: 'origine', dbType: 'postgresql', startedAt: '2026-10-23T08:00:00Z' }] },
    };
    const fake = {
      get connected() { return f.connected; }, get id() { return f.socketId; },
      on(...args) { bus.on(...args); return fake; }, once(...args) { bus.once(...args); return fake; }, off(...args) { bus.off(...args); return fake; },
      timeout() { return { emit: (event, payload, cb) => fake.emit(event, payload, result => cb(null, result)) }; },
      emit(event, payload = {}, cb) {
        f.sent.push({ event, payload: structuredClone(payload), socketId: f.socketId, connected: f.connected });
        if (event === 'backup:restore') {
          f.operationId = payload.operationId;
          if (!f.operations.has(payload.operationId)) f.operations.set(payload.operationId, {
            operationId: payload.operationId, tabId: payload.tabId, connection: 'Collaudo', targetDb: payload.targetDb,
            backupId: payload.backupId, status: 'in_corso', phase: 'applicazione', startedAt: '2026-10-23T08:01:00Z', endedAt: null,
            progress: [{ phase: 'applicazione', status: 'in_corso' }], totalDocs: 2, layers: 1,
          });
          f.pending.set(payload.operationId, cb); return;
        }
        if (event === 'backup:restore:state' || event === 'backup:restore:list') {
          const response = event.endsWith(':state')
            ? (f.operations.has(payload.operationId) ? { ok: true, operation: structuredClone(f.operations.get(payload.operationId)) } : { ok: false, error: 'Operazione non trovata' })
            : { ok: true, operations: structuredClone([...f.operations.values()]) };
          (event.endsWith(':state') ? f.stateReads : f.listReads).push({ payload: structuredClone(payload), socketId: f.socketId });
          if (f.holdReads) f.heldReads.push(() => cb?.(response)); else queueMicrotask(() => cb?.(response));
          return;
        }
        cb?.({ ok: true, connections: {}, conns: {}, groups: f.groups, operations: [],
          databases: [{ name: 'origine' }, { name: 'destinazione' }], collections: [{ name: 'righe' }], docs: [], total: 0 });
      },
    };
    f.receive = (event, ...args) => bus.emitEvent([event, ...args]);
    f.disconnect = () => { f.connected = false; if (bus.connected) bus.disconnect(); else f.receive('disconnect', 'transport close'); };
    f.reconnect = () => { f.socketId = 'lab-socket-nuova'; f.connected = true; f.receive('connect'); };
    f.releaseReads = () => { f.holdReads = false; f.heldReads.splice(0).forEach(done => done()); };
    f.terminal = (operationId, status) => {
      const old = f.operations.get(operationId);
      if (!old) throw new Error('Operazione fixture mancante');
      const operation = { ...old, status, phase: 'terminata', endedAt: '2026-10-23T08:02:00Z',
        recovery: status === 'completato' ? null : { id: 'recupero-lab-013', verified: true, physicalDb: null },
        staging: status === 'completato' ? null : { db: 'staging-lab-013', retained: true },
        error: status === 'completato' ? null : status === 'ripristinato_dopo_errore' ? 'Indice ix_nome mancante nello staging' : 'Rollback non riuscito: connessione interrotta',
        recoveryError: status === 'intervento_richiesto' ? 'Impossibile completare il recupero' : null,
        equivalenza: { completa: true }, verification: status === 'completato' ? { ok: true } : { ok: false },
      };
      f.operations.set(operationId, operation); return structuredClone(operation);
    };
    impostaSocket(fake);
    const tab = createTab({ id: f.originalTab }); tab.label = 'Collaudo'; tab.dbType = 'postgresql';
    Object.assign(tab.state, { connected: true, dbType: 'postgresql', connLabel: 'Collaudo', databases: [{ name: 'origine' }] });
    tabs.activeId = tab.id; tabbar.renderTabBar(); workspace.renderWorkspace();
  });
  return { context, page };
}
async function open(page) {
  await page.locator('#btn-backup-manager').evaluate(button => button.click());
  await page.waitForSelector('#modal-backup-manager[data-arc-dialog="open"]');
  await page.locator('#tab-btn-backup-catalog').click();
  await page.locator('.btn-restore-backup').first().waitFor();
}
async function begin(page) {
  await open(page); await page.locator('.btn-restore-backup').first().click();
  await page.waitForSelector('#restore-overlay[data-arc-dialog="open"]');
  await page.locator('#restore-target-db').fill('destinazione'); await page.locator('#restore-ok').click();
  await page.waitForFunction(() => window.restoreFixture.operationId);
  await page.waitForSelector('#restore-progress .restore-progress');
  return page.evaluate(() => window.restoreFixture.operationId);
}
const readUi = page => page.evaluate(() => ({
  text: document.getElementById('restore-progress').innerText,
  heads: [...document.querySelectorAll('#restore-progress .restore-progress-head')].map(node => node.textContent),
  ok: document.querySelectorAll('#restore-progress .esito-ok').length,
  ko: document.querySelectorAll('#restore-progress .esito-ko').length,
}));
async function frame(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function runScenario(kind, status, mutant) {
  const label = `${kind}-${status}`, checks = [], { context, page } = await fixture(mutant);
  const evidence = { id: label, mutante: mutant, verifiche: checks };
  const check = async (id, action) => {
    try { const detail = await action(); checks.push({ id: label + '/' + id, ok: true, dettaglio: detail }); console.log(`OK ${label}/${id}`); }
    catch (error) { checks.push({ id: label + '/' + id, ok: false, errore: error.message }); console.error(`FAIL ${label}/${id}: ${error.message.split('\n')[0]}`); }
  };
  try {
    if (kind === 'elenco') {
      await page.evaluate(status => {
        const f = window.restoreFixture, id = 'ripristino-server-preesistente';
        f.operations.set(id, { operationId: id, tabId: 'sessione-server-chiusa', connection: 'Collaudo', targetDb: 'destinazione',
          backupId: '20261023-full', status: 'in_corso', phase: 'applicazione', startedAt: '2026-10-23T08:01:00Z', totalDocs: 2, layers: 1 });
        f.operationId = id; f.terminal(id, status);
      }, status);
      await open(page);
      await check('lettura-elenco-server', async () => {
        await page.waitForFunction(() => window.restoreFixture.listReads.length > 0, null, { timeout: 2500 });
      });
    } else {
      const operationId = await begin(page);
      await check('avvio-correlato-una-volta', async () => {
        const sent = await page.evaluate(() => window.restoreFixture.sent.filter(item => item.event === 'backup:restore'));
        assert.equal(sent.length, 1); assert.equal(sent[0].payload.operationId, operationId); assert.equal(sent[0].payload.tabId, 'lab-restore-origine');
      });
      if (kind === 'controllo') {
        await page.evaluate(({ operationId, status }) => {
          const f = window.restoreFixture; f.pending.get(operationId)({ ok: true, summary: f.terminal(operationId, status) });
        }, { operationId, status });
      } else {
        await page.evaluate(() => window.restoreFixture.disconnect()); await frame(page);
        evidence.disconnesso = await readUi(page);
        await check('disconnessione-esito-da-verificare', async () => {
          const ui = await readUi(page); assert.match(ui.text, /verific|riconnession|connessione.*persa|attesa/i,
            'Il pannello deve dichiarare l’esito da verificare, non lasciare un progresso apparentemente connesso');
          assert.equal(ui.ok + ui.ko, 0, 'La sola caduta del socket non è un esito terminale');
        });
        await page.evaluate(async () => {
          const { closeTab, tabs } = await import('/js/tabs.js');
          await closeTab(window.restoreFixture.originalTab);
          if (tabs.list.some(tab => tab.id === window.restoreFixture.originalTab)) throw new Error('Il tab originale deve essere realmente chiuso');
        });
        await frame(page); evidence.tabChiuso = await readUi(page);
        await check('tab-chiuso-non-significa-restore-fallito', async () => {
          const ui = await readUi(page); assert.equal(ui.ok + ui.ko, 0, 'Chiudere il tab non conclude un ripristino ancora attivo sul server');
        });
        await page.evaluate(() => { window.restoreFixture.holdReads = true; window.restoreFixture.reconnect(); });
        await check('nuova-socket-legge-stato-originale', async () => {
          await page.waitForFunction(id => window.restoreFixture.stateReads.some(read => read.payload.operationId === id
            && read.socketId === 'lab-socket-nuova'), operationId, { timeout: 2500 });
          assert(await page.evaluate(async () => !(await import('/js/tabs.js')).tabs.list.some(tab => tab.id === 'lab-restore-origine')));
        });
        // Le letture già inviate conservano l'esito in_corso; una successiva
        // lettura deve ottenere il termine autorevole, senza usare l'ack perso.
        await page.evaluate(({ operationId, status }) => { const f = window.restoreFixture; f.terminal(operationId, status); f.releaseReads(); }, { operationId, status });
      }
    }
    await check('esito-terminale-visibile', async () => {
      await page.waitForFunction(status => {
        const box = document.getElementById('restore-progress');
        return status === 'completato' ? !!box.querySelector('.esito-ok') && /completat/i.test(box.innerText)
          : !!box.querySelector('.esito-ko') && /Indice ix_nome|Rollback non riuscito/.test(box.innerText);
      }, status, { timeout: 3500 });
      const ui = await readUi(page);
      assert.match(ui.text, /destinazione/i); assert.equal(status === 'completato' ? ui.ko : ui.ok, 0);
      return ui;
    });
    if (status !== 'completato') await check('errore-e-recupero-visibili', async () => {
      const ui = await readUi(page); assert.match(ui.text, status === 'ripristinato_dopo_errore' ? /Indice ix_nome mancante/ : /Rollback non riuscito/);
      assert.match(ui.text, /recupero-lab-013/); assert.match(ui.text, /staging-lab-013/); assert.equal(ui.ok, 0);
    });
    await check('nessun-secondo-ripristino', async () => {
      const writes = await page.evaluate(() => window.restoreFixture.sent.filter(item => item.event === 'backup:restore'));
      assert.equal(writes.length, kind === 'elenco' ? 0 : 1, 'Recuperare lo stato non deve ripetere la mutazione');
    });
    await check('nessun-errore-javascript', async () => assert.deepEqual(page.labErrors, []));
    evidence.finale = await readUi(page);
    evidence.sent = await page.evaluate(() => window.restoreFixture.sent);
    evidence.letture = await page.evaluate(() => ({ state: window.restoreFixture.stateReads, list: window.restoreFixture.listReads }));
  } catch (error) { evidence.erroreFixture = error.stack; }
  finally {
    evidence.mutazioni = await page.evaluate(() => window.__labMutationHits).catch(() => 0);
    evidence.erroriPagina = page.labErrors;
    evidence.ok = !evidence.erroreFixture && checks.length > 0 && checks.every(item => item.ok);
    const dir = path.join(reportDir, mutant || 'base'); fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, label + '.png'), fullPage: true });
    fs.writeFileSync(path.join(dir, label + '.json'), JSON.stringify(evidence, null, 2));
    await context.close();
  }
  return evidence;
}
(async () => {
  fs.mkdirSync(reportDir, { recursive: true });
  try {
    server = await startTestServer({ port: Number(process.env.LAB_BACKUP_DISCONNESSIONE_UI_PORT || 39374) });
    browser = await chromium.launch(process.env.LAB_BROWSER_CHANNEL ? { channel: process.env.LAB_BROWSER_CHANNEL } : {});
    for (const [kind, status] of [['controllo', 'completato'], ['disconnessione', 'completato'], ['disconnessione', 'ripristinato_dopo_errore'],
      ['disconnessione', 'intervento_richiesto'], ['elenco', 'ripristinato_dopo_errore']]) report.scenari.push(await runScenario(kind, status, null));
    report.verifiche = report.scenari.flatMap(scenario => scenario.verifiche);
    const baseOk = report.scenari.every(scenario => scenario.ok);
    if (process.argv.includes('--sensitivity') && baseOk) for (const mutant of ['stato-ignorato', 'errore-successo', 'ripristino-ripetuto']) {
      const scenario = await runScenario('disconnessione', mutant === 'errore-successo' ? 'ripristinato_dopo_errore' : 'completato', mutant);
      const wanted = mutant === 'ripristino-ripetuto' ? '/nessun-secondo-ripristino' : '/esito-terminale-visibile';
      report.mutanti.push({ nome: mutant, rilevato: !scenario.erroreFixture && scenario.mutazioni > 0
        && scenario.verifiche.some(check => !check.ok && check.id.endsWith(wanted)), scenario });
    }
    if (process.argv.includes('--sensitivity') && !baseOk) report.sensibilitaNonEseguita = 'Baseline rossa: correggere la produzione prima dei mutanti';
    report.ok = baseOk && report.mutanti.every(mutant => mutant.rilevato);
  } catch (error) { report.erroreFatale = error.stack; report.ok = false; console.error(error.stack); }
  finally {
    await browser?.close(); await server?.stop();
    report.sorgentiStabili = sources.every(file => report.sorgenti[file] === hash(fs.readFileSync(path.join(repo, file))));
    report.ok &&= report.sorgentiStabili; report.terminato = new Date().toISOString();
    report.totali = { verifiche: report.verifiche.length, fallite: report.verifiche.filter(check => !check.ok).length };
    fs.writeFileSync(path.join(reportDir, 'backup-disconnessione-ui.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
})();
