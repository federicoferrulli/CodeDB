'use strict';

const assert = require('node:assert/strict');
const { MongoClient, Long } = require('mongodb');
const { chromium } = require('playwright');
const { createE2eTargetRegistry, startTestServer } = require('./e2e-harness');

// Wizard, socket e database reali. Due istanze separate permettono anche di
// distinguere un database omonimo su un altro server da un alias dell'origine.
(async () => {
  const porte = [process.env.EXPORT_MONGO_PORT, process.env.EXPORT_MONGO_TARGET_PORT].map(Number);
  assert(porte.every(p => p > 0) && porte[0] !== porte[1], 'Specificare le porte di due istanze MongoDB di prova distinte.');
  const bersagli = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_copia' });
  const nome = bersagli.target('vendite'), copia = bersagli.target('locale');
  bersagli.assertOwned(nome);
  const client = porte.map(porta => new MongoClient('mongodb://127.0.0.1:' + porta, { directConnection: true }));
  const origine = client[0].db(nome), replica = client[1].db(nome), locale = client[0].db(copia);
  const server = await startTestServer({ port: Number(process.env.E2E_PORT) || 3261 });
  let browser;
  try {
    await origine.collection('ordini').insertMany([
      { _id: 1, totale: Long.fromString('9007199254740993') }, { _id: 2, totale: 15 },
    ]);
    await origine.collection('ordini').createIndex({ totale: 1 }, { name: 'per_totale' });
    await origine.createCollection('totali', { viewOn: 'ordini', pipeline: [{ $project: { totale: 1 } }] });
    await replica.collection('ordini').insertOne({ _id: 1, totale: 1, consegna: 'domani' });
    browser = await chromium.launch();
    const page = await browser.newPage({ locale: 'it-IT', serviceWorkers: 'block' });
    await page.addInitScript(version => localStorage.setItem('codedb:onboarding',
      JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async ({ porte, nome }) => {
      const { socketReale } = await import('/js/socket.js');
      const { createTab, tabs } = await import('/js/tabs.js');
      const { exportDatabase } = await import('/js/exportimport.js');
      const socket = socketReale();
      for (const [i, port] of porte.entries()) {
        const tabId = i ? 'replica' : 'origine';
        const resp = await socket.timeout(15000).emitWithAck('mongo:connect', { tabId, dbType: 'mongodb',
          directConnection: true, host: '127.0.0.1', port, saveAs: tabId });
        if (!resp.ok) throw new Error(resp.error);
        const tab = createTab({ id: tabId, connName: tabId });
        Object.assign(tab.state, { dbType: 'mongodb', connected: true, db: nome });
      }
      tabs.activeId = 'origine';
      window.apriCopia = () => exportDatabase(nome);
    }, { porte, nome });
    const scegli = (id, value) => page.locator('#' + id).evaluate((select, v) => {
      if (![...select.options].some(o => o.value === v)) throw new Error('Opzione assente: ' + v);
      select.value = v;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    const anteprima = async (tab, db, struttura, documenti) => {
      await page.evaluate(() => window.apriCopia());
      await scegli('dbexport-formato', 'mongo-diretto');
      await scegli('dbexport-mongo-connessione', tab);
      await page.locator('#dbexport-mongo-database').fill(db);
      await scegli('dbexport-script-struttura', struttura);
      await scegli('dbexport-script-dati', documenti);
      await page.locator('#dbexport-run').click();
      await page.locator('#piano-ok').waitFor({ state: 'visible' });
      assert((await page.locator('#piano-voci').innerText()).includes(db));
    };
    const esegui = async stato => {
      await page.locator('#piano-ok').click();
      await page.locator('#dbexport-esito[data-stato="' + stato + '"]').waitFor({ state: 'visible' });
    };
    const conta = async (campo, numero) => assert.equal(
      (await page.locator('#dbexport-esito [data-conteggio="' + campo + '"]').textContent()).trim(), String(numero), campo);
    const scaricati = [];
    page.on('download', file => scaricati.push(file.suggestedFilename()));
    await anteprima('replica', nome, 'se-assente', 'aggiorna');
    assert.equal(await replica.collection('ordini').countDocuments(), 1, 'l’anteprima può solo leggere');
    await esegui('completata');
    await conta('inseriti', 1);
    await conta('aggiornati', 1);
    await conta('visteCreate', 1);
    assert.equal(await replica.collection('totali').countDocuments(), 2);
    const aggiornato = await replica.collection('ordini').findOne({ _id: 1 });
    assert.equal(aggiornato.consegna, 'domani');
    assert.equal(aggiornato.totale.toString(), '9007199254740993');
    assert.equal((await origine.collection('ordini').findOne({ _id: 1 })).consegna, undefined);
    await page.locator('#dbexport-cancel').click();

    await locale.collection('ordini').insertOne({ _id: 'da eliminare' });
    await locale.collection('estranea').insertOne({ _id: 'da conservare' });
    await anteprima('origine', copia, 'ricrea', 'inserisci');
    assert(await locale.collection('ordini').findOne({ _id: 'da eliminare' }));
    await esegui('completata');
    await conta('collectionRicreate', 1);
    await conta('inseriti', 2);
    assert.equal(await locale.collection('ordini').countDocuments(), 2);
    assert.equal(await locale.collection('ordini').findOne({ _id: 'da eliminare' }), null);
    assert.equal(await locale.collection('estranea').countDocuments(), 1);
    assert((await locale.collection('ordini').indexes()).some(i => i.name === 'per_totale'));
    await page.locator('#dbexport-cancel').click();

    // La prima riga entra, la seconda trova un _id esistente. Il resoconto
    // deve mostrare soltanto la scrittura confermata prima dell'errore.
    await replica.collection('ordini').deleteOne({ _id: 1 });
    await anteprima('replica', nome, 'se-assente', 'inserisci');
    await esegui('interrotta');
    await conta('inseriti', 1);
    assert.equal(await replica.collection('ordini').countDocuments(), 2);
    assert.equal(scaricati.length, 0);
    await page.locator('#dbexport-cancel').click();
    await page.locator('#btn-audit-log').evaluate(btn => btn.click());
    await scegli('audit-filter-event', 'database:export:execute');
    const storia = page.locator('#audit-log-list .audit-details').filter({ hasText: 'Documenti inseriti 1' });
    const errore = storia.filter({ hasText: /E11000|duplicate key/i });
    await errore.first().waitFor();
    assert((await errore.first().innerText()).includes('origine / ' + nome + ' → replica / ' + nome));
    assert((await storia.filter({ hasText: 'Documenti aggiornati 1' }).first().innerText()).includes('Viste create 1'));
    console.log('OK copia MongoDB dal wizard con socket reali, conferma, BSON, conteggi finali e parziali.');
  } finally {
    try {
      await browser?.close();
      await server.stop();
      await bersagli.cleanup(async db => {
        for (const c of client) await c.db(db).dropDatabase();
      });
    } finally {
      await Promise.all(client.map(c => c.close()));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
