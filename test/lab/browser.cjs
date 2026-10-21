'use strict';

// Percorsi browser con trasporto e database reali. Le API interne dell'app non
// vengono usate per creare risultati o aggirare connessione, query e scritture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const { Decimal128, Long } = require('bson');
const mysql = require('mysql2/promise');
const { Client: PgClient } = require('pg');
const { startTestServer, createE2eTargetRegistry } = require('../e2e-harness');
const { scegliArc } = require('../arc-controls');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/lab-reports/browser');
const report = { suite: 'browser-reale', iniziato: new Date().toISOString(), verifiche: [], browserErrors: [], richiesteFallite: [], consoleErrors: [] };
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'lab_browser' });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-browser-lab-'));
const ini = path.join(temp, 'connections.ini');
const fixtures = [];
let server, browser;
let scenarioAttivo = null;
const RIGHE = 1203;
const IMPORTO = '12345678901234567890.1234567890';
const INTERO = '9007199254740993';

async function prova(nome, page, action) {
  scenarioAttivo = nome;
  const start = Date.now();
  try {
    const dettagli = await action();
    report.verifiche.push({ nome, esito: 'PASS', ms: Date.now() - start, dettagli });
    console.log(`PASS ${nome} (${Date.now() - start} ms)`);
    return true;
  } catch (error) {
    const item = { nome, esito: 'FAIL', ms: Date.now() - start, errore: error.message, stack: error.stack };
    if (page && !page.isClosed()) {
      item.schermata = `errore-${report.verifiche.length}.png`;
      await page.screenshot({ path: path.join(reportDir, item.schermata), fullPage: true }).catch(() => {});
      item.testoPagina = (await page.locator('body').innerText().catch(() => '')).slice(-10000);
    }
    report.verifiche.push(item);
    process.exitCode = 1;
    console.error(`FAIL ${nome}: ${error.message}`);
    return false;
  }
}
async function eventually(action, label, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { return await action(); } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  throw new Error(`${label}: ${last?.message || 'scadenza superata'}`);
}
async function seed(type) {
  const db = targets.target(type === 'postgresql' ? 'pg' : type);
  targets.assertOwned(db);
  const config = { dbType: type, host: '127.0.0.1', port: Number(process.env[type === 'mongodb' ? 'MONGO_PORT' : type === 'mysql' ? 'MYSQL_PORT' : 'PG_PORT'] || (type === 'mongodb' ? 37017 : type === 'mysql' ? 33306 : 35432)),
    username: type === 'mysql' ? 'root' : type === 'postgresql' ? 'postgres' : '',
    password: type === 'mongodb' ? '' : process.env[type === 'mysql' ? 'MYSQL_PASSWORD' : 'PG_PASSWORD'] || (type === 'mysql' ? 'lab_mysql' : 'lab_postgres'),
    database: type === 'postgresql' ? 'postgres' : '', ...(type === 'mongodb' ? { directConnection: true } : {}) };
  const fixture = { type, db, config, connName: `Laboratorio ${type}` };
  fixtures.push(fixture);
  if (type === 'mongodb') {
    const client = new MongoClient(`mongodb://127.0.0.1:${config.port}/?directConnection=true`, { serverSelectionTimeoutMS: 6000 });
    fixture.close = () => client.close();
    await client.connect();
    fixture.drop = () => targets.drop(db, name => client.db(name).dropDatabase());
    const coll = client.db(db).collection('misure');
    await coll.insertMany(Array.from({ length: RIGHE }, (_, n) => ({ _id: n + 1, id: n + 1, nome: `Cliente ${n + 1}`,
      importo: Decimal128.fromString(IMPORTO), intero: Long.fromString(INTERO), quantita: n + 1,
      geo: { type: 'Point', coordinates: [12.49 + n * 0.00001, 41.89 + n * 0.00001] } })));
    fixture.read = async () => { const d = await coll.findOne({ _id: 1 }); return { nome: d.nome, importo: d.importo.toString(), intero: d.intero.toString() }; };
    fixture.query = 'db.misure.find({id: {$lte: 20}}).sort({id: 1})';
    fixture.largeQuery = 'db.misure.find({}).sort({id: 1})';
  } else {
    const isMysql = type === 'mysql';
    const client = isMysql
      ? await mysql.createConnection({ host: config.host, port: config.port, user: config.username, password: config.password, supportBigNumbers: true, bigNumberStrings: true })
      : new PgClient({ host: config.host, port: config.port, user: config.username, password: config.password, database: config.database });
    fixture.close = () => client.end();
    if (!isMysql) await client.connect();
    const q = async (sql, params) => { const r = await client.query(sql, params); return isMysql ? r[0] : r.rows; };
    const id = v => (isMysql ? '`' : '"') + v + (isMysql ? '`' : '"');
    const table = `${id(db)}.misure`;
    fixture.drop = () => targets.drop(db, name => q(`DROP ${isMysql ? 'DATABASE' : 'SCHEMA'} IF EXISTS ${id(name)}${isMysql ? '' : ' CASCADE'}`));
    await q(`CREATE ${isMysql ? 'DATABASE' : 'SCHEMA'} ${id(db)}`);
    await q(`CREATE TABLE ${table} (id INT PRIMARY KEY,nome VARCHAR(120),importo DECIMAL(40,10),intero BIGINT,quantita INT,geo ${isMysql ? 'JSON' : 'JSONB'})`);
    if (isMysql) {
      const rows = Array.from({ length: RIGHE }, (_, n) => [n + 1, `Cliente ${n + 1}`, IMPORTO, INTERO, n + 1,
        JSON.stringify({ type: 'Point', coordinates: [12.49 + n * 0.00001, 41.89 + n * 0.00001] })]);
      for (let i = 0; i < rows.length; i += 300) await q(`INSERT INTO ${table} VALUES ?`, [rows.slice(i, i + 300)]);
    } else await q(`INSERT INTO ${table} SELECT n,'Cliente '||n,${IMPORTO},${INTERO},n,jsonb_build_object('type','Point','coordinates',jsonb_build_array(12.49+n*0.00001,41.89+n*0.00001)) FROM generate_series(1,${RIGHE}) n`);
    fixture.read = async () => (await q(`SELECT nome,${isMysql ? 'CAST(importo AS CHAR)' : 'importo::text'} AS importo,${isMysql ? 'CAST(intero AS CHAR)' : 'intero::text'} AS intero FROM ${table} WHERE id=1`))[0];
    fixture.query = `SELECT * FROM ${table} WHERE id<=20 ORDER BY id`;
    fixture.largeQuery = `SELECT * FROM ${table} ORDER BY id`;
    fixture.slowQuery = isMysql ? 'SELECT SLEEP(1.2) AS attesa,42 AS risposta' : 'SELECT pg_sleep(1.2),42 AS risposta';
  }
  fs.appendFileSync(ini, `[${fixture.connName}]\n${Object.entries(config).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  return fixture;
}
async function runQuery(page, sql) {
  if (await page.locator('#query-show-editor').isVisible()) await page.locator('#query-show-editor').click();
  await page.locator('#query-editor-input').fill(sql);
  await page.locator('#query-run-btn').click();
  await page.waitForFunction(() => ['success', 'error'].includes(document.querySelector('#view-query')?.dataset.queryState), null, { timeout: 30000 });
  assert.equal(await page.locator('#view-query').getAttribute('data-query-state'), 'success', await page.locator('#view-query').innerText());
  await page.locator('#query-show-results').click();
  await page.locator('#res-mode-table').click();
}
async function gridCell(page, field) {
  const columns = await page.locator('#grid thead th').allTextContents();
  const index = columns.findIndex(name => name.trim() === field) - 1;
  assert(index >= 0, `Colonna ${field} assente: ${JSON.stringify(columns)}`);
  return page.locator(`#grid td[data-r="0"][data-c="${index}"]`);
}
async function ui(fixture) {
  const { type } = fixture;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true, serviceWorkers: 'block' });
  await context.addInitScript(version => {
    localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true }));
    localStorage.setItem('codedb:geo:tiles', 'off');
  }, require('../../package.json').version);
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.browserErrors.push({ type, scenario: scenarioAttivo, at: new Date().toISOString(), errore: error.stack || error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ type, testo: message.text() }); });
  page.on('requestfailed', request => report.richiesteFallite.push({ type, url: request.url(), errore: request.failure()?.errorText }));
  try {
    const connected = await prova(`${type}: apertura connessione e griglia da UI`, page, async () => {
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await page.locator('html[data-arc-ready="true"]').waitFor();
      await page.locator(`.conn-item[data-conn-name="${fixture.connName}"] > .node-label`).click();
      const dbNode = page.locator(`#db-tree .db > .node-label[data-db="${fixture.db}"]`);
      await dbNode.waitFor();
      await dbNode.click();
      await page.locator(`#db-tree .coll .node-label[data-db="${fixture.db}"][data-coll="misure"]`).click();
      await page.locator('#grid td[data-r="0"]').first().waitFor();
      assert.match(await (await gridCell(page, 'nome')).innerText(), /Cliente 1$/);
      assert.equal((await (await gridCell(page, 'intero')).innerText()).trim(), INTERO);
      await page.screenshot({ path: path.join(reportDir, `${type}-griglia-desktop.png`) });
    });
    if (!connected) return;
    await prova(`${type}: editing testo e decimale persistito e annullamento`, page, async () => {
      const nome = `Modificato ${type} 🧪`;
      const amount = '98765432109876543210.9876543210';
      for (const [field, value] of [['nome', nome], ['importo', amount]]) {
        await (await gridCell(page, field)).dblclick();
        const input = page.getByRole('textbox', { name: `Modifica ${field}`, exact: true });
        await input.fill(value);
        await input.press('Enter');
        await eventually(async () => assert.equal((await fixture.read())[field], value), `persistenza ${field}`);
        await page.locator('#grid td.editing').waitFor({ state: 'detached' });
      }
      await (await gridCell(page, 'nome')).dblclick();
      const input = page.getByRole('textbox', { name: 'Modifica nome', exact: true });
      await input.fill('DA ANNULLARE');
      await input.press('Escape');
      assert.equal((await fixture.read()).nome, nome);
      assert.equal((await fixture.read()).intero, INTERO);
      return { nome, importo: amount, intero: INTERO };
    });
    await page.locator('.view-tab[data-view="query"]').click();
    const queried = await prova(`${type}: query reale e precisione del risultato`, page, async () => {
      await runQuery(page, fixture.query);
      const row = page.locator('#query-result-table tbody tr').filter({ hasText: `Modificato ${type}` }).first();
      await row.waitFor();
      const values = await fixture.read();
      assert((await row.innerText()).includes(values.intero));
      assert((await row.innerText()).includes(values.importo));
      await page.screenshot({ path: path.join(reportDir, `${type}-query-desktop.png`) });
      return { intero: values.intero, importo: values.importo };
    });
    if (!queried) return;
    await prova(`${type}: sensibilita a arrotondamento nel browser`, page, async () => {
      const row = page.locator('#query-result-table tbody tr').filter({ hasText: `Modificato ${type}` }).first();
      const check = async () => assert((await row.innerText()).includes(INTERO), 'Il BIGINT deve mantenere tutte le cifre nel risultato');
      await check();
      const foundCell = row.locator('td').filter({ hasText: INTERO }).first();
      const cell = row.locator('td').nth(await foundCell.evaluate(el => el.cellIndex));
      const old = await cell.innerHTML();
      await cell.evaluate(el => { el.textContent = '9007199254740992'; });
      await assert.rejects(check, /BIGINT/, 'Il test deve fallire se il risultato visualizzato viene arrotondato');
      await cell.evaluate((el, html) => { el.innerHTML = html; }, old);
      await check();
      return { mutazione: 'BIGINT visualizzato arrotondato: oracolo fallisce; DOM originale ripristinato' };
    });
    await prova(`${type}: JSON Tree con numeri esatti`, page, async () => {
      await page.locator('#res-mode-json').click();
      await page.locator('#query-json-tree').waitFor();
      for (let i = 0; i < 12 && !(await page.locator('#query-json-tree').innerText()).includes(INTERO); i++) {
        const expand = page.locator('#query-json-tree .json-header[aria-expanded="false"]').first();
        await expand.click();
      }
      const text = await page.locator('#query-json-tree').innerText();
      assert(text.includes(INTERO), `BIGINT assente nel JSON: ${text.slice(0, 1000)}`);
    });
    await prova(`${type}: grafico su risultati reali`, page, async () => {
      await page.locator('#res-mode-chart').click();
      await page.locator('#query-chart-canvas canvas').first().waitFor();
      await scegliArc(page, '#chart-quickbar select[data-path="campoX"]', 'nome');
      await scegliArc(page, '#chart-quickbar select[data-path="campoY"]', 'quantita');
      await page.waitForFunction(() => window.echarts?.getInstanceByDom(document.getElementById('query-chart-canvas'))?.getOption()?.series?.[0]?.data?.length === 20);
      const values = await page.evaluate(() => {
        const option = window.echarts.getInstanceByDom(document.getElementById('query-chart-canvas')).getOption();
        return option.series[0].data.map(item => typeof item === 'object' ? (Array.isArray(item) ? item.at(-1) : item.value) : item);
      });
      assert.deepEqual(values.map(Number).sort((a,b) => a-b), Array.from({ length: 20 }, (_, n) => n + 1), 'Il grafico deve disegnare le venti quantità reali');
      const graph = await page.locator('#query-chart-canvas').boundingBox();
      assert(graph.width >= 200 && graph.height >= 200);
      await page.screenshot({ path: path.join(reportDir, `${type}-grafico.png`) });
      return { ...graph, quantitaDisegnate: values };
    });
    await prova(`${type}: geometrie dei risultati sulla mappa`, page, async () => {
      await page.locator('#res-mode-map').click();
      await page.locator('#qmap-canvas canvas').first().waitFor();
      assert.equal(await page.locator('#qmap-list button[data-i]').count(), 20);
      await page.locator('#qmap-list button[data-i="0"]').click();
      await page.screenshot({ path: path.join(reportDir, `${type}-mappa.png`) });
    });
    if (fixture.slowQuery) await prova(`${type}: browser reattivo durante query SQL lenta reale`, page, async () => {
      await page.evaluate(() => {
        window.labHeartbeat = { last: performance.now(), gaps: [] };
        window.labHeartbeat.timer = setInterval(() => { const now = performance.now(); window.labHeartbeat.gaps.push(now - window.labHeartbeat.last); window.labHeartbeat.last = now; }, 20);
      });
      await runQuery(page, fixture.slowQuery);
      const gaps = await page.evaluate(() => { clearInterval(window.labHeartbeat.timer); return window.labHeartbeat.gaps; });
      assert(gaps.length >= 20, `Heartbeat non osservato durante attesa SQL: ${gaps.length}`);
      const maximum = Math.max(...gaps);
      assert(maximum < 1000, `Blocco browser di ${maximum.toFixed(1)} ms`);
      return { campioni: gaps.length, massimoIntervalloMs: maximum };
    });
    await prova(`${type}: query e precisione su viewport mobile`, page, async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await runQuery(page, fixture.query);
      assert((await page.locator('#query-result-table').innerText()).includes(INTERO));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `Overflow orizzontale pagina mobile: ${overflow}px`);
      await page.screenshot({ path: path.join(reportDir, `${type}-query-mobile.png`), fullPage: true });
      return { width: 390, height: 844, overflow };
    });
    await prova(`${type}: mappa ancora utilizzabile dopo resize mobile e nuova query`, page, async () => {
      const before = report.browserErrors.length;
      await page.locator('#res-mode-map').click();
      await page.locator('#qmap-tab-elenco').click();
      assert.equal(await page.locator('#qmap-list button[data-i]').count(), 20);
      await page.locator('#qmap-list button[data-i="5"]').click();
      await page.locator('#qmap-tab-mappa').click();
      await page.locator('#qmap-canvas canvas').first().waitFor();
      // Si attende la fine della normale animazione Leaflet, non una risposta
      // di rete simulata; gli errori asincroni devono entrare nel rapporto.
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(reportDir, `${type}-mappa-mobile.png`) });
      assert.deepEqual(report.browserErrors.slice(before), [], 'La mappa non deve generare eccezioni dopo il resize');
    });
    await prova(`${type}: editing mobile con doppio tocco persistito`, page, async () => {
      await page.locator('.view-tab[data-view="data"]').tap();
      const cell = await gridCell(page, 'nome');
      await cell.scrollIntoViewIfNeeded();
      await cell.tap();
      await cell.tap();
      const input = page.getByRole('textbox', { name: 'Modifica nome', exact: true });
      const value = `Mobile ${type} 🧪`;
      await input.fill(value);
      await input.press('Enter');
      await eventually(async () => assert.equal((await fixture.read()).nome, value), 'Persistenza editing mobile');
      assert.equal((await fixture.read()).intero, INTERO);
      await page.screenshot({ path: path.join(reportDir, `${type}-editing-mobile.png`) });
      await page.locator('.view-tab[data-view="query"]').tap();
      return { nomePersistito: value, gesto: 'due tap touchscreen reali' };
    });
    await prova(`${type}: caricamento 1203 risultati e virtualizzazione`, page, async () => {
      await page.locator('.view-tab[data-view="query"]').click();
      await page.setViewportSize({ width: 1440, height: 1000 });
      const start = Date.now();
      await runQuery(page, fixture.largeQuery);
      const rows = page.locator('#query-result-table tbody tr');
      assert((await rows.count()) > 0);
      assert.equal(Number((await page.locator('#query-count-val').innerText()).replace(/[.,\s]/g, '')), RIGHE);
      const initialRows = await rows.count();
      assert(initialRows < 100, `La finestra virtuale non deve montare tutte le righe: ${initialRows}`);
      await page.locator('#query-table-view').hover();
      await page.mouse.wheel(0, 120000);
      await page.waitForFunction(() => document.querySelector('#query-result-table tbody')?.textContent.includes('Cliente 1203'));
      return { ms: Date.now() - start, righeDom: initialRows, righeDati: RIGHE, ultimaRigaRaggiunta: true };
    });
  } finally { await context.close(); }
}

(async () => {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1', 'Servono solo i DB Docker del laboratorio e CODEDB_E2E_DESTRUCTIVE=1.');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(ini, '');
  for (const type of ['mongodb', 'mysql', 'postgresql']) await prova(`${type}: seed via driver nativo`, null, () => seed(type));
  server = await startTestServer({ port: Number(process.env.LAB_BROWSER_PORT || 39040), env: { CODEDB_CONNECTIONS_FILE: ini } });
  const launch = { headless: true, ...(process.env.LAB_BROWSER_EXECUTABLE ? { executablePath: process.env.LAB_BROWSER_EXECUTABLE } : {}) };
  try { browser = await chromium.launch(launch); }
  catch (error) {
    if (process.env.LAB_BROWSER_EXECUTABLE) throw error;
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  }
  report.browserVersion = browser.version();
  for (const fixture of fixtures.filter(f => f.read)) await ui(fixture);
  await prova('browser: nessun errore JavaScript o risorsa locale fallita', null, async () => {
    assert.deepEqual(report.browserErrors, []);
    assert.deepEqual(report.richiesteFallite.filter(r => r.url.startsWith(server.url) && r.errore !== 'net::ERR_ABORTED'), []);
    assert.deepEqual(report.consoleErrors, []);
  });
})().catch(error => { report.erroreFatale = error.stack; process.exitCode = 1; console.error(error); }).finally(async () => {
  await browser?.close();
  await server?.stop();
  for (const f of fixtures.reverse()) {
    await prova(`${f.type}: pulizia fixture propria`, null, async () => { try { await f.drop?.(); } finally { await f.close?.(); } });
  }
  report.terminato = new Date().toISOString();
  report.totali = { pass: report.verifiche.filter(v => v.esito === 'PASS').length, fail: report.verifiche.filter(v => v.esito === 'FAIL').length };
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'browser.json'), JSON.stringify(report, (key, value) => key === 'password' ? '[omessa]' : value, 2));
  fs.rmSync(temp, { recursive: true, force: true });
  console.log(`Report browser: ${JSON.stringify(report.totali)}`);
});
