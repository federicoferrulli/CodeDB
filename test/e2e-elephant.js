'use strict';

// Prova offline del grafo versionato. Con --mutant la selezione da tastiera
// viene disattivata nel solo browser di prova e la verifica deve fallire.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const radice = path.resolve(__dirname, '..');
const pagina = pathToFileURL(path.join(radice, 'ELEPHANT.html')).href;
const grafo = JSON.parse(fs.readFileSync(path.join(radice, 'ELEPHANT.json'), 'utf8'));

async function apriBrowser() {
  if (process.env.LAB_BROWSER_EXECUTABLE) return chromium.launch({ executablePath: process.env.LAB_BROWSER_EXECUTABLE });
  if (process.env.LAB_BROWSER_CHANNEL) return chromium.launch({ channel: process.env.LAB_BROWSER_CHANNEL });
  const canali = process.platform === 'win32' ? [undefined, 'chrome', 'msedge'] : [undefined];
  const cause = [];
  for (const channel of canali) {
    try { return await chromium.launch({ channel }); }
    catch (err) { cause.push(err); }
  }
  throw new AggregateError(cause, `Browser indisponibile. ${cause.map(e => e.message.split('\n')[0]).join(' / ')}`);
}

async function verificaNodo(page, id) {
  await page.waitForFunction(atteso => new URLSearchParams(location.hash.slice(1)).get('node') === atteso, id);
  assert.equal((await page.locator('#inspector h2').innerText()).trim(), grafo.nodes[id].title);
}

async function verificaLarghezza(page) {
  const misure = await page.evaluate(() => ({
    vista: document.documentElement.clientWidth,
    documento: document.documentElement.scrollWidth,
    corpo: document.body.scrollWidth,
  }));
  assert.ok(Math.max(misure.corpo, misure.documento) <= misure.vista + 1, `Pagina oltre il viewport: ${JSON.stringify(misure)}`);
}

async function scenario(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, acceptDownloads: true });
  page.setDefaultTimeout(5000);
  const errori = [];
  const rete = [];
  page.on('pageerror', err => errori.push(err.message));
  page.on('console', msg => { if (msg.type() === 'error') errori.push(msg.text()); });
  page.on('request', req => { if (/^https?:/.test(req.url())) rete.push(req.url()); });
  try {
    if (process.argv.includes('--mutant')) {
      await page.addInitScript(() => window.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target.closest?.('#map g[data-id]')) event.stopImmediatePropagation();
      }, true));
    }

    await page.goto(pagina);
    const mappa = page.locator('#map');
    const primo = mappa.locator('g[data-id]:not([data-id="codedb"]):visible').first();
    await primo.waitFor();
    const destinazione = await primo.getAttribute('data-id');
    assert.ok(grafo.nodes[destinazione], `Nodo reale atteso nella mappa: ${destinazione}`);
    await verificaLarghezza(page);
    await primo.focus();
    await page.keyboard.press('Enter');
    const idDaTastiera = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('node'));
    assert.equal(idDaTastiera, destinazione, 'Invio sul nodo SVG deve aprire il dettaglio del nodo selezionato');
    await verificaNodo(page, destinazione);

    const ricerca = page.locator('#search');
    await ricerca.fill('public/js/inlineEdit.js');
    await page.locator('#results button[data-id="cell-write"]').click();
    await verificaNodo(page, 'cell-write');
    const { sources, tests } = grafo.nodes['cell-write'];
    const href = await page.locator('#inspector a[href]').evaluateAll(links => links.map(a => a.href));
    for (const [tipo, attesi] of [['sorgente', sources], ['test', tests]]) {
      assert.ok(attesi.some(file => href.includes(pathToFileURL(path.resolve(radice, file)).href)),
        `Almeno un collegamento ${tipo} del nodo deve aprire il file corretto`);
    }

    await page.goBack();
    await verificaNodo(page, destinazione);
    await page.goForward();
    await verificaNodo(page, 'cell-write');
    await page.reload();
    await verificaNodo(page, 'cell-write');

    await page.locator('#list-mode').click();
    const altraVoce = page.locator('#node-list button[data-id]:not([data-id="cell-write"]):visible').first();
    const idElenco = await altraVoce.getAttribute('data-id');
    await altraVoce.click();
    await verificaNodo(page, idElenco);
    await page.locator('#graph-mode').click();

    const zoom = page.locator('#zoom-level');
    await page.locator('#fit').click();
    const prima = (await zoom.innerText()).trim();
    await page.locator('#zoom-in').click();
    const ingrandito = (await zoom.innerText()).trim();
    assert.notEqual(ingrandito, prima, 'Zoom avanti deve cambiare la scala');
    await page.locator('#zoom-out').click();
    assert.notEqual((await zoom.innerText()).trim(), ingrandito, 'Zoom indietro deve cambiare la scala');
    await page.locator('#zoom-in').click();
    await page.locator('#fit').click();
    assert.equal((await zoom.innerText()).trim(), prima, 'Inquadra deve ripristinare la scala della mappa');

    const route = page.locator('#route');
    const corrente = await route.inputValue();
    const idPercorso = Object.keys(grafo.entrypoints).find(id => id !== corrente);
    assert.ok(idPercorso, 'Servono più percorsi di lettura');
    await route.selectOption(idPercorso);
    const passi = grafo.entrypoints[idPercorso].steps;
    assert.deepEqual(await page.locator('#steps button[data-id]').evaluateAll(buttons => buttons.map(b => b.dataset.id)), passi);
    await page.locator('#steps button[data-id]').last().click();
    await verificaNodo(page, passi.at(-1));

    const scarica = page.locator('a[download][href$="ELEPHANT.json"]').first();
    const [download] = await Promise.all([page.waitForEvent('download'), scarica.click()]);
    assert.equal(download.suggestedFilename(), 'ELEPHANT.json');
    const blocchi = [];
    for await (const blocco of await download.createReadStream()) blocchi.push(blocco);
    assert.deepEqual(JSON.parse(Buffer.concat(blocchi).toString('utf8')), grafo);

    await verificaLarghezza(page);
    assert.deepEqual(rete, [], 'La consultazione locale deve funzionare senza richieste di rete');
    assert.deepEqual(errori, [], 'La pagina deve avviarsi e navigare senza errori JavaScript');
    console.log(`OK ELEPHANT a ${width}px: mappa, tastiera, ricerca, cronologia, elenco, zoom, percorsi e download.`);
  } finally {
    await page.close();
  }
}

(async () => {
  const browser = await apriBrowser();
  try {
    for (const width of [1400, 390]) await scenario(browser, width);
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
