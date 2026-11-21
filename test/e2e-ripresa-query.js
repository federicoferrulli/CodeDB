'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const mysql = require('mysql2/promise');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');

// Socket.IO sull'Engine.IO WebSocket: 42 è un evento, 43 il suo ack numerato.
// Interrompiamo la rete dopo l'accettazione sul server e prima che il browser
// riceva la risposta. Alla riconnessione i messaggi tornano a passare normalmente.
async function interrompiUnaVolta(page, caso) {
  let caduta = false;
  const upload = caso === 'upload' || caso === 'singola_lunga';
  await page.routeWebSocket('**/socket.io/**', route => {
    const server = route.connectToServer();
    let ack;
    route.onMessage(message => {
      if (typeof message === 'string') {
        const match = /^42(\d+)\["(query:execute|script:execute|script:upload)"/.exec(message);
        if (match && upload && match[2] === 'script:upload') {
          const [, dati] = JSON.parse(message.slice(2 + match[1].length));
          if (dati.action === 'append' && dati.index === 0) {
            ack = '43' + match[1] + '[';
          }
        } else if (match && !upload && match[2] !== 'script:upload' && ack === undefined) {
          ack = '43' + match[1] + '[';
        }
      }
      server.send(message);
    });
    server.onMessage(message => {
      if (!caduta && ack && typeof message === 'string') {
        const progresso = message.startsWith('42["script:progress",') && JSON.parse(message.slice(2))[1];
        const interrompi = caso === 'fra_blocchi' ? progresso.tipo === 'done'
          : ['in_corso', 'script_editor'].includes(caso) ? progresso.tipo === 'statement' : message.startsWith(ack);
        if (interrompi) {
          caduta = true;
          if (caso === 'fra_blocchi') route.send(message);
          route.close({ code: 1001 });
          server.close({ code: 1001 });
          return;
        }
      }
      route.send(message);
    });
  });
  return () => caduta;
}

async function verifica(browser, url, conn, configurazione, caso) {
  const { db } = configurazione;
  const singola = caso === 'singola' || caso === 'singola_lunga';
  const upload = caso === 'upload' || caso === 'singola_lunga';
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  try {
    const caduta = await interrompiUnaVolta(page, caso);
    if (process.argv.includes('--mutant=sessione')) {
      await page.route('**/js/socket.js', async route => {
        const originale = await route.fetch();
        const js = await originale.text();
        const handshake = 'token: getToken(), recoveryKey';
        assert.ok(js.includes(handshake), 'Il mutante deve privare il socket della chiave di ripresa');
        await route.fulfill({ response: originale, body: js.replace(handshake, 'token: getToken()') });
      });
    }
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({
      visto: true, versioneVista: versione, checklistChiusa: true,
    })), require('../package.json').version);
    await page.goto(url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async ({ db, ...cfg }) => {
      await (await import('/js/connection.js')).connectAndOpenTab(cfg);
      (await import('/js/colltabs.js')).openCollTab(db, 't');
      (await import('/js/main.js')).setView('query');
    }, configurazione);
    await page.waitForFunction(async () => (await import('/js/socket.js')).socket.io.engine.transport.name === 'websocket');
    if (upload) {
      // Dopo la riconnessione il primo invio può viaggiare sul polling prima del nuovo WebSocket.
      await page.evaluate(async () => {
        window.primiFrammenti = [];
        (await import('/js/socket.js')).socket.onAnyOutgoing((nome, dati) => {
          if (nome === 'script:upload' && dati.action === 'append' && dati.index === 0) window.primiFrammenti.push(dati.uploadId);
        });
      });
    }

    let sessionePrima;
    if (caso === 'singola_lunga') {
      sessionePrima = await page.evaluate(async () => {
        const { runQuery } = await import('/js/query-tab.js');
        const res = await runQuery({ code: 'SELECT CONNECTION_ID() AS sessione' });
        return res.docs[0].sessione;
      });
      await page.evaluate(async () => {
        const { runQuery } = await import('/js/query-tab.js');
        const code = 'SELECT /*' + 'x'.repeat(5 * 1024 * 1024) + "*/ scrivi_una_riga('singola_lunga') AS risultato";
        const badge = document.querySelector('#query-status-badge');
        window.conteggiVisibili = new Set();
        new MutationObserver(() => {
          if (badge.checkVisibility() && badge.textContent.startsWith('Invio al server')) window.conteggiVisibili.add(badge.textContent);
        }).observe(badge, { childList: true });
        void runQuery({ code });
      });
    } else if (caso === 'singola') {
      await page.locator('#query-editor-input').fill("SELECT scrivi_una_riga('singola') AS risultato");
      await page.locator('#query-run-btn').click();
    } else {
      const sql = [
        `INSERT INTO t VALUES ('${caso}', 1, CONNECTION_ID());`,
        'BEGIN;',
        'SET @origine = CONNECTION_ID();',
        `INSERT INTO t VALUES ('${caso}', 2, @origine);`,
        'DO SLEEP(0.15);',
        caso === 'script_editor' ? '' : '/*' + 'x'.repeat((caso === 'upload' ? 5 : 1) * 1024 * 1024) + '*/',
        `INSERT INTO t VALUES ('${caso}', 3, @origine);`,
        'COMMIT;',
        `SELECT CONCAT('righe-', COUNT(*)) AS risultato FROM t WHERE caso = '${caso}';`,
      ].join('\n');
      if (caso === 'script_editor') {
        await page.locator('#query-editor-input').fill(sql);
        await page.locator('#query-run-btn').click();
      } else {
        await page.locator('#query-open-sql-input').setInputFiles({
          name: caso + '.sql', mimeType: 'text/plain', buffer: Buffer.from(sql),
        });
        await page.waitForFunction(() => document.querySelector('#query-editor-input').value.includes('SET @origine'));
        await page.locator('#chunk-run-all-btn').click();
      }
    }
    await page.waitForFunction(() => /righe-3|singola(?:_lunga)?-terminata/.test(document.querySelector('#query-table-view').textContent)
      || document.querySelector('#view-query').dataset.queryState === 'error'
      || /Interrotto|Sequenza interrotta/.test(document.querySelector('#chunk-progress-text').textContent),
    null, { timeout: 15000 }).catch(err => { if (err.name !== 'TimeoutError') throw err; });
    const esito = await page.locator('#chunk-progress-text').textContent();
    const errore = await page.locator('#view-query').innerText();
    assert.ok(caduta(), 'Il WebSocket non ha attraversato il punto di caduta previsto: ' + esito + ' ' + errore.slice(-1200));
    if (!singola && caso !== 'script_editor') assert.match(esito, /Completato.*8 istruzioni.*0 errori/, esito);
    const griglia = await page.locator('#query-table-view').textContent();
    assert.ok(griglia.includes(singola ? caso + '-terminata' : 'righe-3'), errore.slice(-1200));
    if (upload) {
      const ids = await page.evaluate(() => window.primiFrammenti);
      assert.ok(ids.length === 2 && ids[0] === ids[1], 'Il frammento senza ack viene ripetuto sullo stesso caricamento');
    }
    const [rows] = await conn.query('SELECT passo, origine FROM ??.t WHERE caso = ? ORDER BY passo', [db, caso]);
    assert.deepEqual(rows.map(r => r.passo), singola ? [1] : [1, 2, 3], 'Ogni scrittura avviene una volta');
    if (caso === 'singola_lunga') {
      assert.equal(rows[0].origine, sessionePrima, 'La SELECT recupera la sessione SQL di partenza');
      assert.ok(await page.evaluate(() => window.conteggiVisibili.size >= 2), 'Il badge mostra i byte inviati mentre il testo arriva al server');
    }
    assert.ok(rows[0].origine > 0 && rows.every(r => r.origine === rows[0].origine), 'La stessa sessione arriva al COMMIT');
    console.log(`OK ${caso}: risultato in griglia e scritture verificate dal driver MySQL.`);
  } finally { await page.close(); }
}

(async () => {
  const port = Number(process.env.EXPORT_MYSQL_PORT);
  assert.ok(port, 'Indicare EXPORT_MYSQL_PORT per il MySQL di prova');
  const password = require('./lab/credenziali.cjs')('mysql');
  const registry = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_ripresa' });
  const db = registry.target('query');
  registry.assertOwned(db);
  const conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password });
  let creato = false, server, browser;
  try {
    await conn.query('CREATE DATABASE ??', [db]);
    creato = true;
    await conn.query('CREATE TABLE ??.t (caso VARCHAR(24), passo INT, origine BIGINT)', [db]);
    await conn.query(`CREATE FUNCTION ??.scrivi_una_riga(nome VARCHAR(24)) RETURNS VARCHAR(40) DETERMINISTIC MODIFIES SQL DATA
      BEGIN INSERT INTO ??.t VALUES (nome, 1, CONNECTION_ID()); RETURN CONCAT(nome, '-terminata'); END`, [db, db]);
    server = await startTestServer({ port: Number(process.env.E2E_PORT) || 3187 });
    browser = await chromium.launch();
    for (const caso of ['singola_lunga', 'fra_blocchi', 'in_corso', 'ack_blocco', 'singola', 'upload', 'script_editor']) {
      try {
        await verifica(browser, server.url, conn, { db, dbType: 'mysql', host: '127.0.0.1', port, username: 'root', password }, caso);
      } catch (err) {
        console.error(`FAIL ${caso}:`, err.message);
        process.exitCode = 1;
      }
    }
  } finally {
    await browser?.close();
    await server?.stop();
    try { if (creato) await registry.drop(db, name => conn.query('DROP DATABASE ??', [name])); }
    finally { await conn.end(); }
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
