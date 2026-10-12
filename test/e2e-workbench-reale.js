'use strict';
// Tre motori reali, database casuali posseduti dalla fixture e vault usa e getta.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { generateKeyPairSync } = require('node:crypto');
const { Server: SshServer, utils: sshUtils } = require('ssh2');
const { hostKeyFingerprint } = require('../db/SshTunnel');
const { MongoClient, Decimal128 } = require('mongodb');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const { chromium } = require('playwright');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');
const dir = `${process.env.CODEDB_REPORT_ROOT || 'test-reports'}/workbench`;
const mongoPort = Number(process.env.WORKBENCH_MONGO_PORT || 27017);

(async () => {
  process.env.CODEDB_E2E_DESTRUCTIVE = '1';
  const owned = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_wb' });
  const mongoDb = owned.target('mongo'), archiveDb = owned.target('archivio'), sqlDb = owned.target('mysql');
  const restoredDbs = [owned.target('ripristino_a'), owned.target('ripristino_b')];
  const mongo = new MongoClient(`mongodb://127.0.0.1:${mongoPort}`, { serverSelectionTimeoutMS: 4000 });
  let sql, pg, server, browser, ssh;
  const sshClients = new Set(), forwards = new Set();
  const report = { engines: ['MongoDB reale', 'MySQL reale'], checks: [], errors: [] };
  fs.mkdirSync(dir, { recursive: true });
  try {
    await mongo.connect();
    sql = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.WORKBENCH_MYSQL_PORT || 13318), user: 'root', password: process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '' });
    for (const db of [mongoDb, archiveDb]) await mongo.db(db).collection('ordini').insertMany([
      { _id: 1, cliente: 'Acme', totale: Decimal128.fromString('12345678901234567890.123456789') },
      { _id: 2, cliente: 'Beta', totale: Decimal128.fromString('245.50') },
    ]);
    await sql.query(`CREATE DATABASE \`${sqlDb}\``);
    await sql.query(`CREATE TABLE \`${sqlDb}\`.ordini (id INT PRIMARY KEY, cliente VARCHAR(100), totale DECIMAL(30,9))`);
    await sql.query(`INSERT INTO \`${sqlDb}\`.ordini VALUES (1, 'Acme', 12345678901234567890.123456789), (2, 'Beta', 245.50)`);
    server = await startTestServer({ port: 3178 });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => report.errors.push(e.message));
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    if (await page.getByRole('button', { name: 'Nascondi i primi passi' }).isVisible()) await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await page.evaluate(async ({ mongoDb, archiveDb, sqlDb, password, sqlPort, mongoPort }) => {
      const { connectAndOpenTab } = await import('/js/connection.js');
      const { activeTab, switchTab } = await import('/js/tabs.js');
      const { openCollTab } = await import('/js/colltabs.js');
      await connectAndOpenTab({ dbType: 'mongodb', host: '127.0.0.1', port: mongoPort });
      const mongo = activeTab(); mongo.label = 'Sviluppo · MongoDB';
      openCollTab(mongoDb, 'ordini');
      openCollTab(archiveDb, 'ordini');
      await connectAndOpenTab({ dbType: 'mysql', host: '127.0.0.1', port: sqlPort, username: 'root', password });
      const sql = activeTab(); sql.label = 'Analisi · MySQL';
      openCollTab(sqlDb, 'ordini');
      (await import('/js/workspace.js')).saveWorkspaceInputs(); switchTab(mongo.id);
      const split = await import('/js/splitview.js');
      split.addOrSplitPane(null, 'right', { tabId: sql.id, db: sqlDb, coll: 'ordini', view: 'query' });
      window.realWb = { mongoId: mongo.id, sqlId: sql.id, mongoDb, archiveDb, sqlDb };
      const snap = split.getSplitStateSnapshot();
      window.realWb.panes = snap.panes.map(([id, p]) => ({ id, tabId: p.tabId }));
      for (const [id] of snap.panes) split.setPaneView(id, 'query');
    }, { mongoDb, archiveDb, sqlDb, mongoPort, sqlPort: Number(process.env.WORKBENCH_MYSQL_PORT || 13318), password: process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '' });
    await page.waitForFunction(() => [...document.querySelectorAll('.pane-runtime')].length === 2 && [...document.querySelectorAll('.pane-runtime')].every(f => f.codedbPanel.ready));
    const frames = {};
    for (const frame of page.frames().filter(f => f.parentFrame())) frames[await frame.evaluate(() => window.frameElement.codedbPanel.dbType)] = frame;
    const m = frames.mongodb, s = frames.mysql;
    await s.locator('#query-editor-input').fill('SELECT SLEEP(1) AS attesa, cliente, totale FROM ordini');
    await s.locator('#query-run-btn').click();
    await m.locator('#query-editor-input').fill('db.ordini.find({})');
    await m.locator('#query-run-btn').click();
    await m.locator('#query-status-badge').filter({ hasText: 'Completato' }).waitFor();
    await s.locator('#query-status-badge').filter({ hasText: 'Completato' }).waitFor();
    assert((await m.locator('#query-table-view').textContent()).includes('12345678901234567890.123456789'));
    assert((await s.locator('#query-table-view').textContent()).includes('Acme'));
    report.checks.push('Query parallele MongoDB/MySQL, cambio focus prima della risposta MySQL, precisione Decimal128');
    await s.locator('#query-editor-input').fill('SELECT SLEEP(15) AS attesa');
    await s.locator('#query-run-btn').click();
    await m.locator('#query-editor-input').click();
    await s.locator('#query-stop-btn').click();
    assert.equal(await s.locator('#query-status-badge').textContent(), 'Annullata');
    await s.locator('#query-editor-input').fill('SELECT cliente, totale FROM ordini');
    await s.locator('#query-run-btn').click();
    await s.locator('#query-status-badge').filter({ hasText: 'Completato' }).waitFor();
    report.checks.push('Annullamento reale MySQL e nuova query sulla stessa sessione');
    await page.evaluate(async () => {
      const { setPaneView } = await import('/js/splitview.js');
      setPaneView(window.realWb.panes.find(p => p.tabId === window.realWb.mongoId).id, 'data');
    });
    const mongoPane = m;
    await mongoPane.locator('#filter-input').fill('Acme');
    await mongoPane.locator('#filter-input').press('Enter');
    await m.waitForFunction(() => document.querySelector('#grid tbody')?.textContent.includes('Acme'));
    assert(!(await mongoPane.locator('#grid tbody').textContent()).includes('Beta'));
    // Modifica reale tramite il controller, poi focus sull'altra sessione prima dell'ack.
    await page.evaluate(async () => {
      const { emit } = await import('/js/utils.js');
      const { setFocusedPane } = await import('/js/splitview.js');
      const req = emit('doc:update', { tabId: window.realWb.mongoId, db: window.realWb.archiveDb, coll: 'ordini', id: '1', set: { cliente: 'Acme aggiornata' } });
      setFocusedPane(window.realWb.panes.find(p => p.tabId === window.realWb.sqlId).id);
      await req;
    });
    assert.equal((await mongo.db(archiveDb).collection('ordini').findOne({ _id: 1 })).cliente, 'Acme aggiornata');
    assert.equal((await mongo.db(mongoDb).collection('ordini').findOne({ _id: 1 })).cliente, 'Acme');
    const [sqlRows] = await sql.query(`SELECT cliente FROM \`${sqlDb}\`.ordini WHERE id = 1`);
    assert.equal(sqlRows[0].cliente, 'Acme');
    report.checks.push('Filtro di un pannello e scrittura: database originale invariato, modifica solo nel secondo database MongoDB, MySQL invariato');
    await page.evaluate(async () => (await import('/js/splitview.js')).setPaneView(window.realWb.panes.find(p => p.tabId === window.realWb.mongoId).id, 'query'));
    await page.screenshot({ path: `${dir}/mongo-mysql-reali.png`, animations: 'disabled' });
    pg = new Client({ host: '127.0.0.1', port: Number(process.env.WORKBENCH_PG_PORT || 15438), user: 'postgres', password: process.env.WORKBENCH_PG_PASSWORD || 'codedb_fixture', database: 'postgres' });
    await pg.connect();
    const schemas = [owned.target('pg_vendite'), owned.target('pg_archivio')];
    for (const [i, schema] of schemas.entries()) {
      await pg.query(`CREATE SCHEMA "${schema}"`);
      await pg.query(`CREATE TABLE "${schema}"."OrdiniLunghi" (id INT PRIMARY KEY, cliente TEXT)`);
      await pg.query(`INSERT INTO "${schema}"."OrdiniLunghi" VALUES (1, $1)`, [`SCHEMA_${i}`]);
    }
    await page.evaluate(async ({ schemas, port, password }) => {
      const { connectAndOpenTab } = await import('/js/connection.js');
      await connectAndOpenTab({ dbType: 'postgresql', host: '127.0.0.1', port, username: 'postgres', password, database: 'postgres' });
      const tab = (await import('/js/tabs.js')).activeTab();
      window.realWb.pgId = tab.id;
      (await import('/js/colltabs.js')).openCollTab(schemas[0], 'OrdiniLunghi');
      (await import('/js/main.js')).setView('query');
    }, { schemas, port: Number(process.env.WORKBENCH_PG_PORT || 15438), password: process.env.WORKBENCH_PG_PASSWORD || 'codedb_fixture' });
    await page.locator('#query-editor-input').fill('SELECT pg_sleep(1), cliente FROM "OrdiniLunghi"');
    await page.locator('#query-run-btn').click();
    await page.evaluate(async schema => {
      (await import('/js/colltabs.js')).openCollTab(schema, 'OrdiniLunghi');
      (await import('/js/main.js')).setView('query');
    }, schemas[1]);
    await page.locator('#query-editor-input').fill('SELECT cliente FROM "OrdiniLunghi"');
    await page.locator('#query-run-btn').click();
    await page.locator('#query-status-badge').filter({ hasText: 'Completato' }).waitFor();
    assert((await page.locator('#query-table-view').textContent()).includes('SCHEMA_1'));
    await page.waitForTimeout(1200);
    assert(!(await page.locator('#query-table-view').textContent()).includes('SCHEMA_0'));
    await page.evaluate(async () => {
      const tab = (await import('/js/tabs.js')).activeTab();
      (await import('/js/colltabs.js')).switchCollTab(tab.state.collTabs[0].id);
    });
    assert((await page.locator('#query-table-view').textContent()).includes('SCHEMA_0'));
    report.engines.push('PostgreSQL reale');
    report.checks.push('PostgreSQL: schemi distinti della stessa connessione, identificatori con maiuscole, risposte concorrenti e risultati ripristinati');
    for (const [id, db, coll, text] of [['pgId', schemas[0], 'OrdiniLunghi', 'PostgreSQL modificato'], ['sqlId', sqlDb, 'ordini', 'MySQL modificato']]) {
      await page.evaluate(async ({ id, db, coll }) => {
        (await import('/js/workspace.js')).saveWorkspaceInputs();
        (await import('/js/tabs.js')).switchTab(window.realWb[id]);
        (await import('/js/colltabs.js')).openCollTab(db, coll);
        (await import('/js/main.js')).setView('data');
      }, { id, db, coll });
      await page.locator('#grid tbody tr:not(.v-spacer)').first().waitFor();
      const column = await page.evaluate(async () => (await import('/js/state.js')).state.columns.indexOf('cliente'));
      const cell = page.locator(`#grid td[data-r="0"][data-c="${column}"]`);
      await cell.dblclick(); await cell.locator('input').fill(text); await cell.locator('input').press('Enter');
      await page.locator('#grid td.editing').waitFor({ state: 'detached' });
    }
    assert.equal((await pg.query(`SELECT cliente FROM "${schemas[0]}"."OrdiniLunghi" WHERE id=1`)).rows[0].cliente, 'PostgreSQL modificato');
    assert.equal((await pg.query(`SELECT cliente FROM "${schemas[1]}"."OrdiniLunghi" WHERE id=1`)).rows[0].cliente, 'SCHEMA_1');
    assert.equal((await sql.query(`SELECT cliente FROM \`${sqlDb}\`.ordini WHERE id=1`))[0][0].cliente, 'MySQL modificato');
    report.checks.push('Editing inline reale MySQL/PostgreSQL e isolamento dello schema omonimo');
    const progress = await page.evaluate(async ({ restoredDbs, mutant }) => {
      const { socket } = await import('/js/socket.js');
      const send = (name, payload) => new Promise((resolve, reject) => socket.emit(name, payload, result => result.ok ? resolve(result) : reject(new Error(result.error))));
      const tabId = window.realWb.mongoId;
      const { summary } = await send('backup:run', { tabId, db: window.realWb.mongoDb, type: 'full' });
      const { groups } = await send('backup:list', {});
      const group = Object.keys(groups).find(key => groups[key].some(backup => backup.id === summary.id));
      const progress = [];
      const listener = packet => progress.push(mutant ? { ...packet, operationId: undefined } : packet);
      socket.on('backup:progress', listener);
      try {
        await Promise.all(restoredDbs.map((targetDb, index) => send('backup:restore', { tabId, group, backupId: summary.id, targetDb, operationId: `fixture-${index}` })));
      } finally { socket.off('backup:progress', listener); }
      const invalid = await new Promise(resolve => socket.emit('backup:restore', { tabId, operationId: '<non valido>' }, resolve));
      return { progress, invalid };
    }, { restoredDbs, mutant: process.argv.includes('--mutant-progresso') });
    assert(progress.progress.length > 0);
    assert.deepEqual([...new Set(progress.progress.map(packet => packet.operationId))].sort(), ['fixture-0','fixture-1'], 'Il backend distingue i progressi dei ripristini concorrenti');
    assert.equal(progress.invalid.ok, false);
    assert.match(progress.invalid.error, /Identificatore del ripristino non valido/);
    for (const db of restoredDbs) {
      const doc = await mongo.db(db).collection('ordini').findOne({ _id: 1 });
      assert.equal(doc.totale.toString(), '12345678901234567890.123456789');
    }
    report.checks.push('Backup e due restore reali concorrenti: progressi per operationId, validazione identificatore e Decimal128 intatto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
    let authentications = 0, forwarded = 0;
    ssh = new SshServer({ hostKeys: [privateKey] }, client => {
      sshClients.add(client);
      client.on('close', () => sshClients.delete(client));
      client.on('error', () => {});
      client.on('authentication', ctx => {
        if (ctx.method === 'password') authentications++;
        if (ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'solo-fixture') ctx.accept();
        else ctx.reject();
      });
      client.on('tcpip', (accept, reject, info) => {
        // La fixture inoltra soltanto al MongoDB posseduto dal test.
        if (info.destIP !== '127.0.0.1' || info.destPort !== mongoPort) return reject();
        const upstream = net.connect({ host: '127.0.0.1', port: mongoPort });
        forwards.add(upstream);
        let channel;
        upstream.once('connect', () => {
          forwarded++;
          channel = accept();
          channel.on('error', () => upstream.destroy());
          channel.on('close', () => upstream.destroy());
          channel.pipe(upstream).pipe(channel);
        });
        upstream.on('error', () => channel ? channel.destroy() : reject());
        upstream.on('close', () => { forwards.delete(upstream); channel?.destroy(); });
      });
    });
    await new Promise((resolve, reject) => { ssh.once('error', reject); ssh.listen(0, '127.0.0.1', resolve); });
    const sshConfig = { dbType: 'mongodb', host: '127.0.0.1', port: mongoPort, ssh: 'true', sshHost: '127.0.0.1', sshPort: ssh.address().port, sshUser: 'fixture', sshPassword: 'solo-fixture', sshHostKey: hostKeyFingerprint(sshUtils.parseKey(privateKey).getPublicSSH()) };
    const rejected = await page.evaluate(async cfg => {
      const { socket } = await import('/js/socket.js');
      return new Promise(resolve => socket.emit('mongo:connect', { ...cfg, tabId: 'ssh-pin-errato', sshHostKey: 'SHA256:impronta-non-corrispondente' }, resolve));
    }, sshConfig);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /NON corrisponde/);
    assert.equal(authentications, 0, 'Il pin errato interrompe il collegamento prima delle credenziali');
    await page.evaluate(async ({ cfg, db }) => {
      await (await import('/js/connection.js')).connectAndOpenTab(cfg);
      (await import('/js/colltabs.js')).openCollTab(db, 'ordini');
      (await import('/js/main.js')).setView('query');
    }, { cfg: process.argv.includes('--mutant-ssh') ? { ...sshConfig, ssh: '' } : sshConfig, db: mongoDb });
    await page.locator('#query-editor-input').fill('db.ordini.find({})');
    await page.locator('#query-run-btn').click();
    await page.locator('#query-status-badge').filter({ hasText: 'Completato' }).waitFor();
    assert((await page.locator('#query-table-view').textContent()).includes('12345678901234567890.123456789'));
    assert(authentications > 0 && forwarded > 0, 'Autenticazione e traffico MongoDB passano nel tunnel reale');
    report.checks.push('SSH reale su loopback: pin errato rifiutato prima delle credenziali, pin corretto e query MongoDB con Decimal128 intatto');
    assert.deepEqual(report.errors, []);
    console.log(`OK: ${report.checks.length} scenari con MongoDB, MySQL e PostgreSQL reali`);
  } catch (e) { report.failure = e.stack; throw e; }
  finally {
    await browser?.close(); await server?.stop();
    for (const socket of forwards) socket.destroy();
    for (const client of sshClients) client.end();
    if (ssh) await new Promise(resolve => ssh.close(resolve));
    for (const db of [mongoDb, archiveDb, ...restoredDbs]) await owned.drop(db, name => mongo.db(name).dropDatabase()).catch(() => {});
    if (sql) await owned.drop(sqlDb, name => sql.query(`DROP DATABASE IF EXISTS \`${name}\``));
    if (pg) {
      for (const name of owned.targets().filter(name => name.includes('_pg_'))) await owned.drop(name, schema => pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
      await pg.end();
    }
    await sql?.end(); await mongo.close();
    fs.writeFileSync(`${dir}/reale.json`, JSON.stringify(report, null, 2));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
