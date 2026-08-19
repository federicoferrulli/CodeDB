'use strict';

/* ---------------------------------------------------------------------------
 * Test E2E in browser: risultati PER ISTRUZIONE di uno script (tab ⚡).
 *
 *   MYSQL_PASSWORD=root node test/e2e-script-schede-ui.js
 *
 * PERCHÉ IN BROWSER. Le tre cose che questo prova non si vedono da nessun'altra
 * parte: che le linguette compaiano davvero, che aprirne una CAMBI la griglia,
 * e che il contenuto arrivi solo quando la si apre (è tutto il senso dei
 * result set su file: `script:result` deve partire al clic, non prima).
 *
 * Il difetto da cui è nato tutto — `USE Prova_; SELECT * FROM Pippo;` che
 * mostrava nella griglia il messaggio della USE — è qui in fondo, verificato
 * sulla griglia vera invece che sul payload del socket.
 * ------------------------------------------------------------------------- */

const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mysql = require('mysql2/promise');

const MYSQL_HOST = process.env.MYSQL_HOST || 'localhost';
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT, 10) || 3306;
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '';
const DB = 'codedb_e2e_schede';

let falliti = 0;
const ok = (cond, etichetta, dettaglio = '') => {
  if (cond) console.log(`  OK   ${etichetta}`);
  else { console.error(`  FAIL ${etichetta}${dettaglio ? `\n       ${dettaglio}` : ''}`); falliti++; }
};

// Prepara lo schema fuori dalla UI: qui si prova il pannello, non la DDL.
async function preparaSchema() {
  const c = await mysql.createConnection({
    host: MYSQL_HOST, port: MYSQL_PORT, user: MYSQL_USER, password: MYSQL_PASSWORD, connectTimeout: 4000,
  });
  await c.query(`DROP DATABASE IF EXISTS ${DB}`);
  await c.query(`CREATE DATABASE ${DB}`);
  await c.query(`USE ${DB}`);
  await c.query('CREATE TABLE alfa (id INT PRIMARY KEY, nome VARCHAR(20))');
  await c.query("INSERT INTO alfa VALUES (1,'uno'),(2,'due'),(3,'tre')");
  await c.query('CREATE TABLE beta (k INT PRIMARY KEY)');
  await c.query('INSERT INTO beta VALUES (7),(8)');
  await c.query('CREATE TABLE vuota (id INT PRIMARY KEY, addsa VARCHAR(20))');
  await c.end();
}

async function pulisciSchema() {
  try {
    const c = await mysql.createConnection({
      host: MYSQL_HOST, port: MYSQL_PORT, user: MYSQL_USER, password: MYSQL_PASSWORD, connectTimeout: 4000,
    });
    await c.query(`DROP DATABASE IF EXISTS ${DB}`);
    await c.end();
  } catch (_) { /* il database di prova resta: non è un fallimento del test */ }
}

// Testo della griglia dei risultati (intestazioni + prima colonna): basta a
// riconoscere QUALE result set si sta guardando.
async function grigliaVisibile(page) {
  return page.evaluate(() => {
    const t = document.querySelector('#query-result-table');
    if (!t) return { intestazioni: [], righe: 0, testo: '' };
    const intestazioni = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    const corpo = [...t.querySelectorAll('tbody tr')];
    return {
      intestazioni,
      righe: corpo.length,
      testo: corpo.map((tr) => tr.textContent.trim()).join(' | '),
    };
  });
}

async function eseguiScript(page, sql) {
  await page.evaluate((testo) => {
    const ed = document.querySelector('#query-editor-input');
    ed.value = testo;
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }, sql);
  await page.click('#query-run-btn');
  // Fine dello script: il pannello mostra il pulsante di chiusura.
  await page.waitForSelector('#script-close-btn:not(.hidden)', { timeout: 20000 });
}

(async () => {
  console.log('--- E2E (browser): risultati per istruzione di uno script ---');
  try {
    await preparaSchema();
  } catch (err) {
    console.log(`  SKIP Nessun MySQL utilizzabile su ${MYSQL_HOST}:${MYSQL_PORT} (${err.code || err.message})`);
    return;
  }

  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3149 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const erroriJs = [];
    page.on('pageerror', (e) => erroriJs.push(String(e && e.message)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#connect-btn');

    // Connessione a MySQL dal modulo vero.
    await page.selectOption('#conn-dbtype', 'mysql');
    await page.fill('input[name="host"]', MYSQL_HOST);
    await page.fill('input[name="port"]', String(MYSQL_PORT));
    await page.fill('input[name="username"]', MYSQL_USER);
    await page.fill('input[name="password"]', MYSQL_PASSWORD);
    await page.click('#connect-btn');
    await page.waitForSelector('#conn-sidebar', { state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => {
      const t = document.querySelector('#db-tree');
      return !!t && t.children.length > 0;
    }, { timeout: 20000 });

    // Tab ⚡ Query & Aggregate.
    await page.click('.view-tab[data-view="query"]');
    await page.waitForSelector('#query-editor-input', { timeout: 10000 });

    /* 1. Script con TRE result set fra istruzioni di scrittura. */
    await eseguiScript(page, [
      `USE ${DB};`,
      'SELECT * FROM alfa;',
      'INSERT INTO beta VALUES (99);',
      'SELECT k FROM beta ORDER BY k;',
      'SELECT * FROM vuota;',
    ].join('\n'));

    const barra = await page.evaluate(() => {
      const b = document.querySelector('#script-results-tabs');
      if (!b || b.classList.contains('hidden')) return null;
      return [...b.querySelectorAll('.script-result-tab')].map((t) => ({
        pos: t.dataset.pos,
        testo: t.textContent.replace(/\s+/g, ' ').trim(),
        attiva: t.classList.contains('attiva'),
      }));
    });
    ok(barra && barra.length === 3,
      'compare una linguetta per ciascun result set (3), non per le scritture',
      `barra: ${JSON.stringify(barra)}`);
    ok(barra && barra.every((t) => /riga \d+/.test(t.testo)),
      'ogni linguetta porta la riga dell\'istruzione nel sorgente');
    ok(barra && barra.some((t) => t.attiva),
      'la linguetta di ciò che la griglia sta mostrando è accesa');

    // La griglia, a fine script, mostra l'ultima SELECT: quella vuota.
    {
      const g = await grigliaVisibile(page);
      ok(g.righe === 0 && g.intestazioni.some((h) => /addsa/i.test(h)),
        'a fine script la griglia mostra l\'ULTIMO result set (vuoto, con le sue colonne)',
        `griglia: ${JSON.stringify(g)}`);
    }

    /* 2. Aprire una linguetta cambia davvero la griglia. */
    await page.click('.script-result-tab[data-pos="0"]');
    await page.waitForFunction(
      () => [...document.querySelectorAll('#query-result-table tbody tr')].length === 3,
      { timeout: 10000 },
    );
    {
      const g = await grigliaVisibile(page);
      ok(g.righe === 3 && /uno/.test(g.testo),
        'aprendo la prima scheda la griglia mostra le righe di quella SELECT',
        `griglia: ${JSON.stringify(g)}`);
      const attiva = await page.evaluate(() =>
        document.querySelector('.script-result-tab.attiva')?.dataset.pos);
      ok(attiva === '0', 'e la linguetta aperta diventa quella accesa', `attiva: ${attiva}`);
    }

    await page.click('.script-result-tab[data-pos="1"]');
    await page.waitForFunction(
      () => [...document.querySelectorAll('#query-result-table tbody tr')].length === 3
        && document.querySelector('#query-result-table tbody').textContent.includes('99'),
      { timeout: 10000 },
    );
    ok(true, 'e cambiando scheda cambia di nuovo (99 inserito dalla scrittura precedente)');

    /* 3. Il contatore dice le RIGHE MOSTRATE, non le istruzioni eseguite. */
    {
      const conteggio = await page.evaluate(() => ({
        valore: document.querySelector('#query-count-val')?.textContent.trim(),
        nascosto: document.querySelector('#query-count-metric')?.classList.contains('hidden'),
        istruzioni: document.querySelector('#script-run-counts')?.textContent.trim(),
      }));
      ok(conteggio.valore === '3' && !conteggio.nascosto,
        'il contatore «record» conta le righe della griglia',
        JSON.stringify(conteggio));
      ok(/5 \/ 5 istruzioni/.test(conteggio.istruzioni || ''),
        'e le istruzioni restano contate nel pannello, dove è il loro posto',
        JSON.stringify(conteggio));
    }

    /* 4. Il log elenca TUTTE le istruzioni, anche su uno script velocissimo:
     *    è il difetto del diradamento degli eventi. */
    {
      const righeLog = await page.evaluate(() =>
        [...document.querySelectorAll('#script-run-log .script-log-row')]
          .map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
      ok(righeLog.length === 5,
        'il log elenca tutte e cinque le istruzioni, non solo quelle sopravvissute al diradamento',
        `log: ${JSON.stringify(righeLog)}`);
    }

    /* 5. IL DIFETTO DI PARTENZA, sulla griglia vera: `USE db; SELECT` su una
     *    tabella vuota non deve mostrare il messaggio della USE. */
    await eseguiScript(page, `USE ${DB};\nSELECT * FROM vuota;`);
    {
      const g = await grigliaVisibile(page);
      ok(!/Database attivo cambiato/.test(g.testo),
        'USE + SELECT vuota: la griglia NON mostra più il messaggio della USE',
        `griglia: ${JSON.stringify(g)}`);
      ok(g.righe === 0 && g.intestazioni.some((h) => /addsa/i.test(h)),
        'mostra una tabella vuota con le colonne della SELECT',
        `griglia: ${JSON.stringify(g)}`);
      const conteggio = await page.evaluate(() => document.querySelector('#query-count-val')?.textContent.trim());
      ok(conteggio === '0', 'e il contatore dice 0, non «2 record»', `contatore: ${conteggio}`);
    }

    /* 6. Un solo result set non merita una barra di linguette. */
    {
      const nascosta = await page.evaluate(() =>
        document.querySelector('#script-results-tabs')?.classList.contains('hidden'));
      ok(nascosta === true, 'con un solo result set la barra delle linguette resta nascosta');
    }

    ok(erroriJs.length === 0, 'nessun errore JavaScript durante tutto il percorso',
      erroriJs.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
    await pulisciSchema();
  }

  if (falliti) { console.error(`\n${falliti} test falliti.`); process.exitCode = 1; }
  else console.log('Tutti i test E2E sulle schede di risultato superati!');
})().catch((err) => {
  console.error('FALLITO:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
