'use strict';

// Browser, socket e DBMS reali. I container sono nuovi, senza volumi o dati utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const suffix = randomBytes(5).toString('hex');
const owned = [];
const clients = [];
const dir = process.env.CODEDB_REPORT_DIR || 'test-reports/schema-dialogs';
const db = 'codedb_dialog_test', coll = 'persone', password = 'codedb_test_temporaneo';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, browser;

async function container(engine, image, internalPort, env) {
  const name = `codedb-dialog-${engine}-${suffix}`;
  const id = docker(['run', '--pull=never', '--rm', '-d', '--name', name, '--label', 'codedb.test=schema-dialogs',
    '-p', `127.0.0.1::${internalPort}`, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), image]);
  owned.push({ id, name });
  const port = Number(docker(['port', name, `${internalPort}/tcp`]).split(':').at(-1));
  console.log(`Container isolato ${engine} avviato sulla porta ${port}`);
  return engine === 'mongodb'
    ? { engine, host: '127.0.0.1', port }
    : { engine, host: '127.0.0.1', port, username: engine === 'mysql' ? 'root' : 'postgres', password, database: engine === 'mysql' ? db : 'postgres' };
}

async function ready(config) {
  const deadline = Date.now() + 100000;
  let error;
  while (Date.now() < deadline) {
    let client;
    try {
      if (config.engine === 'mysql') {
        client = await require('mysql2/promise').createConnection({ host: config.host, port: config.port, user: 'root', password, connectTimeout: 2000 });
        await client.query('SELECT 1');
      } else if (config.engine === 'postgresql') {
        client = new (require('pg').Client)({ host: config.host, port: config.port, user: 'postgres', password, database: 'postgres', connectionTimeoutMillis: 2000 });
        client.on('error', () => {}); await client.connect();
      } else {
        client = new (require('mongodb').MongoClient)(`mongodb://${config.host}:${config.port}`, { serverSelectionTimeoutMS: 1500 });
        await client.connect();
      }
      clients.push(client); return client;
    } catch (err) {
      error = err;
      await client?.end?.().catch(() => {});
      await client?.close?.().catch(() => {});
      await pause(400);
    }
  }
  throw error;
}

async function seed(config, client) {
  if (config.engine === 'mongodb') {
    await client.db(db).collection(coll).insertMany([{ id: 1, email: 'uno@example.test' }, { id: 2, email: 'due@example.test' }]);
  } else {
    if (config.engine === 'mysql') await client.query(`CREATE DATABASE ${db}`);
    else await client.query(`CREATE SCHEMA ${db}`);
    await client.query(`CREATE TABLE ${db}.${coll} (id INTEGER PRIMARY KEY, email VARCHAR(120) NOT NULL)`);
    await client.query(`INSERT INTO ${db}.${coll} (id,email) VALUES (1,'uno@example.test'),(2,'due@example.test')`);
  }
}

async function verifyColumn(config, client) {
  if (config.engine === 'mongodb') {
    assert.equal(await client.db(db).collection(coll).countDocuments({ nota: 'iniziale' }), 2);
  } else {
    const result = await client.query(`SELECT nota FROM ${db}.${coll} ORDER BY id`);
    assert.deepEqual((config.engine === 'mysql' ? result[0] : result.rows).map(r => r.nota), ['iniziale', 'iniziale']);
    const query = `SELECT is_nullable AS nullable, data_type AS tipo FROM information_schema.columns WHERE table_schema='${db}' AND table_name='${coll}' AND column_name='nota'`;
    const metadata = await client.query(query);
    assert.equal((config.engine === 'mysql' ? metadata[0] : metadata.rows)[0].nullable, 'NO');
    assert.equal((config.engine === 'mysql' ? metadata[0] : metadata.rows)[0].tipo, config.engine === 'mysql' ? 'varchar' : 'text');
  }
}

async function verifyIndex(config, client) {
  if (config.engine === 'mongodb') {
    const indexes = await client.db(db).collection(coll).indexes();
    const index = indexes.find(i => i.name === 'idx_email_nota');
    assert.equal(index.unique, true); assert.deepEqual(index.key, { email: 1, nota: -1 });
    await assert.rejects(client.db(db).collection(coll).insertOne({ id: 3, email: 'uno@example.test', nota: 'iniziale' }), err => err.code === 11000);
  } else if (config.engine === 'mysql') {
    const [rows] = await client.query(`SHOW INDEX FROM ${db}.${coll} WHERE Key_name='idx_email_nota'`);
    assert.deepEqual(rows.map(r => [r.Column_name, r.Non_unique, r.Collation]), [['email', 0, 'A'], ['nota', 0, 'D']]);
    await assert.rejects(client.query(`INSERT INTO ${db}.${coll} (id,email,nota) VALUES (3,'uno@example.test','iniziale')`), err => err.code === 'ER_DUP_ENTRY');
  } else {
    const result = await client.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='${db}' AND indexname='idx_email_nota'`);
    assert.match(result.rows[0].indexdef, /CREATE UNIQUE INDEX.*\(email, nota DESC\)/);
    await assert.rejects(client.query(`INSERT INTO ${db}.${coll} (id,email,nota) VALUES (3,'uno@example.test','iniziale')`), err => err.code === '23505');
  }
}

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  try {
    const configs = [];
    configs.push(await container('postgresql', 'postgres:latest', 5432, { POSTGRES_PASSWORD: password }));
    if (!process.argv.includes('--mutant')) {
      configs.push(await container('mysql', 'mysql:8', 3306, { MYSQL_ROOT_PASSWORD: password, MYSQL_ROOT_HOST: '%' }));
      configs.push(await container('mongodb', 'mongo:6.0', 27017, {}));
    }
    const databases = await Promise.all(configs.map(async config => {
      const client = await ready(config); await seed(config, client); console.log(`${config.engine}: dati di prova pronti`); return { config, client };
    }));
    server = await startTestServer({ port: Number(process.env.E2E_PORT) || 3222 });
    browser = await chromium.launch();
    for (const { config, client } of databases) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', locale: 'it-IT', serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      if (process.argv.includes('--mutant')) await page.route('**/js/schema-ops.js', async route => {
        const response = await route.fetch(), source = await response.text();
        const original = "const operation = oldName ? 'column:alter' : 'column:add';";
        assert(source.includes(original));
        await route.fulfill({ response, body: source.replace(original, "const operation = 'column:alter';") });
      });
      await page.addInitScript(version => {
        localStorage.setItem('codedb:tema', 'dark');
        localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
      }, require('../package.json').version);
      await page.goto(server.url); await page.waitForSelector('html[data-arc-ready="true"]');
      await page.evaluate(async ({ config, db, coll }) => {
        await (await import('/js/connection.js')).connectAndOpenTab({ ...config, dbType: config.engine });
        (await import('/js/socket.js')).socket.onAnyOutgoing((event, payload) => {
          if (['column:add', 'column:alter', 'index:create'].includes(event)) window.ddlEvents.push({ event, payload });
        });
        window.ddlEvents = [];
        await (await import('/js/grid.js')).selectCollection(db, coll);
        (await import('/js/main.js')).setView('details');
      }, { config, db, coll });
      await page.waitForFunction(() => document.getElementById('view-details').getAttribute('aria-busy') === 'false' && document.querySelector('#schema-table .details-field-name')?.textContent);
      const closed = async prefix => page.waitForFunction(prefix => !document.getElementById(`${prefix}-overlay`).dataset.arcDialog, prefix);
      const fits = async prefix => assert(await page.locator(`#${prefix}-form`).evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${prefix}: nessun overflow`);
      const compact = async () => {
        const bounds = await page.locator('.arc-dialog-sheet').evaluate(el => {
          const r = el.getBoundingClientRect();
          return { visible: Math.min(r.bottom, innerHeight) - Math.max(r.top, 0), fit: el.hasAttribute('data-fit-content') };
        });
        // Il pannello include un'estensione fuori schermo per il trascinamento.
        assert(bounds.fit && bounds.visible < 760, JSON.stringify(bounds));
      };
      const openColumn = async () => {
        await page.locator('#column-add-btn').click();
        await page.waitForSelector('#coledit-overlay[data-arc-dialog="open"]');
        assert.match(await page.locator('#coledit-target').textContent(), /codedb_dialog_test \/ persone/);
      };
      await openColumn();
      await page.locator('#coledit-save').click();
      assert.match(await page.locator('#coledit-error').textContent(), /nome/);
      assert.equal(await page.evaluate(() => ddlEvents.length), 0);
      await page.locator('#coledit-name').fill('nota');
      if (config.engine !== 'mongodb') {
        await page.locator('#coledit-save').click();
        assert.match(await page.locator('#coledit-error').textContent(), /tipo/);
        await page.locator('#coledit-type').fill(config.engine === 'mysql' ? 'VARCHAR(80)' : 'TEXT');
        await page.locator('#coledit-null-row').getByRole('checkbox').click();
      } else {
        assert(await page.locator('#coledit-type-row').isHidden());
        assert(await page.locator('#coledit-null-row').isHidden());
      }
      await page.locator('#coledit-default').fill('iniziale');
      assert(await page.locator('#coledit-error').isHidden(), 'Correggere i dati rimuove l’errore precedente');
      await fits('coledit');
      await page.screenshot({ path: `${dir}/${config.engine}-colonna-desktop.png` });
      await page.locator('#coledit-default').press('Enter');
      await closed('coledit');
      await verifyColumn(config, client);
      await page.locator('#schema-table .details-field-name').filter({ hasText: /^nota$/ }).waitFor();

      await openColumn();
      await page.locator('#coledit-name').fill(config.engine === 'mongodb' ? '_id' : 'email');
      if (config.engine !== 'mongodb') await page.locator('#coledit-type').fill('TEXT');
      await page.locator('#coledit-save').click();
      await page.waitForSelector('#coledit-error:not(.hidden)');
      assert((await page.locator('#coledit-error').textContent()).length > 10);
      assert(await page.locator('#coledit-save').isEnabled());
      await page.locator('#coledit-cancel').click(); await closed('coledit');

      await page.locator('#index-add-btn').click();
      await page.waitForSelector('#idxcreate-overlay[data-arc-dialog="open"]');
      await page.locator('#idxcreate-save').click();
      assert.match(await page.locator('#idxcreate-error').textContent(), /almeno un campo/);
      await page.locator('#idxcreate-fields').fill('[]'); await page.locator('#idxcreate-save').click();
      await page.waitForSelector('#idxcreate-error:not(.hidden)');
      await page.waitForFunction(() => !document.getElementById('idxcreate-options').disabled);
      await page.locator('#idxcreate-fields').fill('{\n  "email": 1,\n  "nota": -1\n}');
      await page.locator('#idxcreate-name').fill('idx_email_nota');
      await page.locator('#idxcreate-form').getByRole('checkbox').click();
      assert(await page.locator('#idxcreate-error').isHidden());
      await fits('idxcreate');
      await page.screenshot({ path: `${dir}/${config.engine}-indice-desktop.png` });
      const before = await page.evaluate(() => ddlEvents.filter(x => x.event === 'index:create').length);
      await page.evaluate(() => { const f = document.getElementById('idxcreate-form'); f.requestSubmit(); f.requestSubmit(); });
      await closed('idxcreate'); await verifyIndex(config, client);
      assert.equal(await page.evaluate(() => ddlEvents.filter(x => x.event === 'index:create').length), before + 1, 'Un solo invio anche con doppio submit');
      await page.locator('#index-table .details-index-name').filter({ hasText: 'idx_email_nota' }).waitFor();

      await page.locator('#index-add-btn').click();
      await page.locator('#idxcreate-fields').fill('{"nota": 1}');
      await page.locator('#idxcreate-name').press('Enter'); await closed('idxcreate');
      const autoName = config.engine === 'mongodb' ? 'nota_1' : 'nota_idx';
      await page.locator('#index-table .details-index-name').filter({ hasText: new RegExp(`^${autoName}$`) }).waitFor();

      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await openColumn(); await fits('coledit');
      await compact();
      await page.screenshot({ path: `${dir}/${config.engine}-colonna-mobile.png` });
      await page.locator('#coledit-cancel').click(); await closed('coledit');
      await page.locator('#index-add-btn').click(); await fits('idxcreate');
      await compact();
      await page.screenshot({ path: `${dir}/${config.engine}-indice-mobile.png` });
      await page.locator('#idxcreate-cancel').click(); await closed('idxcreate');
      assert.deepEqual(errors, []);
      console.log(`OK ${config.engine}: creazione reale, metadati aggiornati, default/NULL, indice composto e univoco, rifiuto duplicati, nome automatico, errori, tastiera e mobile`);
      await context.close();
    }
  } finally {
    await browser?.close(); await server?.stop();
    await Promise.allSettled(clients.map(c => c.close ? c.close() : c.end()));
    for (const { id, name } of owned.reverse()) {
      // L'ID proviene soltanto dal docker run di questa esecuzione.
      assert(name.startsWith('codedb-dialog-') && name.endsWith(suffix));
      docker(['rm', '-f', id]);
    }
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
