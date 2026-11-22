'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { creaPianoExport } = require('../db/exportPlan');

// Wizard, selettori Arc e anteprima reali. Il catalogo in memoria consente di
// cambiare motore e di ispezionare il piano senza eseguire gli script generati.
(async () => {
  const server = await startTestServer({ port: Number(process.env.E2E_PORT) || 3253 });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ locale: 'it-IT', reducedMotion: 'reduce', serviceWorkers: 'block' });
    await page.addInitScript(version => {
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
    }, require('../package.json').version);
    const mutanteMongo = process.argv.includes('--mutant-mongo');
    const mutanteCopia = process.argv.includes('--mutant-copia');
    if (mutanteCopia || mutanteMongo || process.argv.includes('--mutant')) await page.route('**/js/exportimport.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const originale = mutanteCopia ? 'planHash: plan.fingerprint' : mutanteMongo ? "documenti: dati.disabled ? 'inserisci' : dati.value" : "tabelle: struttura.disabled ? 'crea' : struttura.value";
      assert(source.includes(originale));
      await route.fulfill({ response, body: source.replace(originale, mutanteCopia ? "planHash: 'piano-obsoleto'" : mutanteMongo ? "documenti: 'inserisci'" : "tabelle: 'crea'") });
    });
    if (process.argv.includes('--mutant-etichetta')) await page.route('**/js/riepilogo-piano.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const body = source.replace("nomeCopiaMongo = 'Copia in un altro database MongoDB'", "nomeCopiaMongo = 'Esegui in CodeDB'");
      assert.notEqual(body, source, 'la mutazione deve cambiare il nome della copia servito al browser');
      await route.fulfill({ response, body });
    });
    if (process.argv.includes('--mutant-download')) await page.route('**/js/exportimport.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const avvio = "const started = await emit('database:export:start'";
      const body = source.replace(avvio, "if (plan.formato === 'mongosh') socket.emit('database:export:execute', { tabId, planHash: plan.fingerprint });\n    " + avvio);
      assert.notEqual(body, source, 'la mutazione deve eseguire una copia anche al download nella fixture');
      await route.fulfill({ response, body });
    });
    let richiesta, impronta;
    await page.exposeFunction('pianificaExport', (payload, dbType) => {
      richiesta = payload;
      const tipo = dbType === 'mongodb' ? 'collection' : 'tabella';
      const catalogo = [{ id: tipo + ':clienti', tipo, nome: 'clienti' }];
      if (dbType === 'mongodb') catalogo.push({ id: 'vista:attivi', tipo: 'vista', nome: 'attivi' });
      const dipendenze = dbType === 'mongodb' ? [{ da: 'vista:attivi', a: 'collection:clienti', tipo: 'vista' }] : [];
      const plan = creaPianoExport({ ...payload, formato: payload.formato || 'codedb-json',
        ...(payload.destinazioneMongo && { destinazioneMongo: { ...payload.destinazioneMongo,
          connection: payload.destinazioneMongo.tabId === 'arrivo' ? 'Mongo archivio' : 'Mongo origine' }, idConfermaMongo: require('node:crypto').randomUUID() }),
        catalogo: { dbType, db: payload.db, oggetti: catalogo, dipendenze }, connection: 'prova' });
      impronta = plan.fingerprint;
      return { ok: true, catalogo, plan };
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const { exportDatabase, exportImportMenuItems } = await import('/js/exportimport.js');
      const tab = createTab({ id: 'export-opzioni', connName: 'Mongo origine' });
      const arrivo = createTab({ id: 'arrivo', connName: 'Mongo archivio' });
      arrivo.state.connected = true;
      const altro = createTab({ id: 'mysql-esterno', connName: 'MySQL escluso' });
      Object.assign(altro.state, { dbType: 'mysql', connected: true });
      window.copieRichieste = [];
      const formati = new Map();
      let formatoDownload;
      const eventi = new Map();
      window.notificaExport = (nome, valore) => eventi.get(nome)?.(valore);
      impostaSocket({ connected: true, on(nome, fn) { eventi.set(nome, fn); }, off(nome, fn) { if (eventi.get(nome) === fn) eventi.delete(nome); }, async emit(nome, payload, ack) {
        if (nome === 'database:export:plan') {
          const risposta = await window.pianificaExport(payload, tab.state.dbType);
          formati.set(risposta.plan.fingerprint, risposta.plan.formato);
          ack(risposta);
        }
        else if (nome === 'database:export:execute') {
          window.copieRichieste.push(payload);
          window.terminaCopia = ack;
        }
        else if (nome === 'database:export:start') {
          window.improntaEseguita = payload.fingerprint;
          formatoDownload = formati.get(payload.fingerprint);
          ack({ ok: true, operation: { id: 'export' } });
        } else if (nome === 'database:export:status') {
          const file = formatoDownload === 'mongosh'
            ? { filename: 'negozio.mongosh.js', url: 'data:text/javascript,db.getName()%3B' }
            : { filename: 'negozio.sql', url: 'data:text/plain,SELECT%201%3B' };
          ack({ ok: true, operation: { status: 'completato', ...file, rows: 1, collections: 1, views: 0 } });
        } else ack?.({ ok: true, databases: [], collections: [] });
      } });
      window.apriExport = async ({ dbType, singola }) => {
        tabs.activeId = tab.id;
        Object.assign(tab.state, { connected: true, dbType });
        if (singola) await exportImportMenuItems('negozio', singola).find(voce => voce.label.includes('con opzioni')).action();
        else await exportDatabase('negozio');
      };
    });
    const apri = async (dbType, singola = null) => {
      await page.evaluate(ctx => window.apriExport(ctx), { dbType, singola });
      await page.waitForSelector('#dbexport-overlay[data-arc-dialog="open"]');
    };
    const scegli = async (campo, valore) => {
      await page.getByRole('combobox', { name: campo, exact: true }).click();
      await page.getByRole('option', { name: valore, exact: true }).click();
    };
    const anteprima = async () => {
      await page.locator('#dbexport-run').click();
      await page.waitForSelector('#piano-overlay[data-arc-dialog="open"]');
    };
    const indietro = () => page.getByRole('button', { name: 'Indietro', exact: true }).click();
    const chiudi = async () => {
      await indietro();
      await page.locator('#dbexport-cancel').click();
    };

    await apri('mysql');
    await scegli('Tabelle nello script', 'Elimina e ricrea (DROP TABLE IF EXISTS)');
    await scegli('Righe nello script', 'Sostituisci i duplicati (REPLACE INTO)');
    assert.match(await page.locator('#dbexport-script-hint').innerText(), /perde tutti i dati.*REPLACE elimina/);
    await scegli('Formato del file', 'CodeDB · tipi completi (.codedb.json)');
    assert(!await page.locator('#dbexport-opzioni-script').isVisible());
    await scegli('Formato del file', 'Script SQL (.sql)');
    await anteprima();
    assert.deepEqual(richiesta.opzioniSql, { tabelle: 'ricrea', righe: 'replace' });
    assert.match(await page.locator('#piano-voci').innerText(), /Tabelle da ricreare\s+clienti/);
    assert.match(await page.locator('#piano-avvisi').innerText(), /REPLACE elimina/);
    const primaImpronta = impronta;
    await indietro();
    assert.equal(await page.locator('#dbexport-script-dati').inputValue(), 'replace');
    await scegli('Tabelle nello script', 'Crea solo se assente (IF NOT EXISTS)');
    await scegli('Righe nello script', 'Mantieni la riga esistente');
    await anteprima();
    assert.match(await page.locator('#piano-avvisi').innerText(), /trigger di aggiornamento/);
    assert.deepEqual(richiesta.opzioniSql, { tabelle: 'se-assente', righe: 'ignora' });
    assert.notEqual(impronta, primaImpronta);
    const download = page.waitForEvent('download');
    await page.locator('#piano-ok').click();
    assert.equal((await download).suggestedFilename(), 'negozio.sql');
    assert.equal(await page.evaluate(() => window.improntaEseguita), impronta);

    await page.setViewportSize({ width: 390, height: 844 });
    await apri('postgresql');
    const righe = page.locator('#dbexport-script-dati');
    assert.equal(await page.locator('#dbexport-formato option[value="mongosh"]').count(), 0);
    assert.equal(await righe.inputValue(), 'insert');
    assert.equal(await righe.locator('option[value="replace"]').count(), 0);
    await scegli('Tabelle nello script', 'Elimina e ricrea (DROP TABLE IF EXISTS)');
    await scegli('Righe nello script', 'Aggiorna i duplicati (ON CONFLICT DO UPDATE)');
    assert(await page.locator('#dbexport-overlay .modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1),
      'Le opzioni SQL rientrano nella modale su telefono');
    await page.getByRole('button', { name: 'Solo dati', exact: true }).click();
    assert(!await page.getByRole('combobox', { name: 'Tabelle nello script' }).isVisible());
    await anteprima();
    assert.deepEqual(richiesta.opzioniSql, { tabelle: 'crea', righe: 'aggiorna' });
    assert.match(await page.locator('#piano-voci').innerText(), /ON CONFLICT DO UPDATE/);
    assert.doesNotMatch(await page.locator('#piano-voci').innerText(), /Tabelle da ricreare/);
    await chiudi();

    await apri('postgresql');
    await scegli('Righe nello script', 'Mantieni la riga esistente');
    await page.getByRole('button', { name: 'Solo struttura', exact: true }).click();
    await anteprima();
    assert.equal(richiesta.opzioniSql.righe, 'insert');
    assert.doesNotMatch(await page.locator('#piano-voci').innerText(), /Righe nello script/);
    await chiudi();

    for (const motore of ['mysql', 'mongodb']) {
      await apri(motore);
      if (motore === 'mysql') {
        await scegli('Righe nello script', 'Sostituisci i duplicati (REPLACE INTO)');
        await scegli('Formato del file', 'CodeDB · tipi completi (.codedb.json)');
      }
      assert(!await page.locator('#dbexport-opzioni-script').isVisible());
      await anteprima();
      assert.equal(richiesta.formato, 'codedb-json');
      assert(!Object.hasOwn(richiesta, 'opzioniSql'));
      assert(!Object.hasOwn(richiesta, 'opzioniMongo'));
      assert.doesNotMatch(await page.locator('#piano-voci').innerText(), /nello script/);
      await chiudi();
    }
    await apri('mongodb', 'clienti');
    assert.equal(await page.locator('#dbexport-formato').inputValue(), 'codedb-json');
    const nomeCopia = 'Copia in un altro database MongoDB';
    const nomeScript = 'Scarica lo script di copia per mongosh (.js)';
    assert.equal(await page.locator('#dbexport-formato option[value="mongo-diretto"]').textContent(), nomeCopia);
    assert.equal(await page.locator('#dbexport-titolo').innerText(), 'Esporta o copia il database');
    const scegliMongo = () => scegli('Formato o operazione', nomeCopia);
    assert.equal(await page.locator('#dbexport-formato option[value="mongosh"]').textContent(), nomeScript);
    await scegli('Formato o operazione', nomeScript);
    assert.equal(await page.locator('#dbexport-run').innerText(), 'Anteprima dello script');
    const hintScript = await page.locator('#dbexport-formato-hint').innerText();
    assert.match(hintScript, /Scarichi un file \.js\./);
    assert.match(hintScript, /La copia avviene solo quando lo esegui con mongosh.*«negozio»/);
    await scegli('Collection e viste nello script', 'Elimina e ricrea');
    await scegli('Documenti nello script', 'Aggiorna i campi del documento');
    await anteprima();
    const operazione = page.locator('#piano-voci dt').filter({ hasText: /^Operazione$/ });
    assert.equal(await operazione.locator('+ dd').innerText(), nomeScript);
    assert.equal(await page.locator('#piano-ok').innerText(), 'Scarica script');
    assert.deepEqual(richiesta.opzioniMongo, { collection: 'ricrea', documenti: 'aggiorna' });
    assert(!Object.hasOwn(richiesta, 'opzioniSql'));
    assert.match(await page.locator('#piano-voci').innerText(), /Oggetti da ricreare\s+clienti \(collection\)/);
    assert.match(await page.locator('#piano-avvisi').innerText(), /primo livello/);
    assert.match(await page.locator('#piano-avvisi').innerText(), /perdono tutti i documenti/);
    assert(!richiesta.selezione['vista:attivi'].struttura);
    await indietro();
    await scegli('Documenti nello script', 'Sostituisci l’intero documento');
    await page.getByRole('button', { name: 'Solo dati', exact: true }).click();
    await anteprima();
    assert.deepEqual(richiesta.opzioniMongo, { collection: 'crea', documenti: 'sostituisci' });
    assert.match(await page.locator('#piano-avvisi').innerText(), /eliminando anche i campi assenti/);
    assert.doesNotMatch(await page.locator('#piano-voci').innerText(), /Oggetti da ricreare/);
    await indietro();
    await scegli('Documenti nello script', 'Mantieni il documento esistente');
    await anteprima();
    assert.equal(richiesta.opzioniMongo.documenti, 'mantieni');
    await indietro();
    await scegli('Formato o operazione', 'CodeDB · BSON completo (.codedb.json)');
    await anteprima();
    assert(!Object.hasOwn(richiesta, 'opzioniMongo'));
    await chiudi();

    await apri('mongodb', 'attivi');
    await scegli('Formato o operazione', nomeScript);
    await scegli('Collection e viste nello script', 'Elimina e ricrea');
    await anteprima();
    assert.deepEqual(richiesta.opzioniMongo, { collection: 'ricrea', documenti: 'inserisci' });
    const vociVista = await page.locator('#piano-voci').innerText();
    assert.match(vociVista, /Oggetti da ricreare\s+attivi \(vista\)/);
    assert.doesNotMatch(vociVista, /clienti \(collection\)|Documenti nello script/);
    assert.doesNotMatch(await page.locator('#piano-avvisi').innerText(), /perdono tutti i documenti/);
    const invii = () => page.evaluate(() => window.copieRichieste);
    assert(!Object.hasOwn(richiesta, 'destinazioneMongo'));
    assert.deepEqual(await invii(), []);
    const downloadMongo = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Scarica script', exact: true }).click();
    const fileMongo = await downloadMongo;
    assert.equal(fileMongo.suggestedFilename(), 'negozio.mongosh.js');
    assert.equal(await require('node:fs/promises').readFile(await fileMongo.path(), 'utf8'), 'db.getName();');
    assert.equal(await page.evaluate(() => window.improntaEseguita), impronta);
    assert.deepEqual(await invii(), [], 'scaricare lo script lascia la copia su MongoDB in attesa di esecuzione esterna');

    const report = page.locator('#dbexport-esito');
    const destinazione = page.locator('#dbexport-mongo-database');
    await apri('mongodb', 'clienti');
    await scegliMongo();
    assert.equal(await page.locator('#dbexport-formato').inputValue(), 'mongo-diretto');
    assert.equal(await page.locator('#dbexport-run').innerText(), 'Anteprima della copia');
    assert.equal(await page.locator('#dbexport-mongo-connessione').inputValue(), 'export-opzioni');
    assert.equal(await page.locator('#dbexport-mongo-connessione option[value="mysql-esterno"]').count(), 0);
    assert.equal(await destinazione.inputValue(), '');
    await page.locator('#dbexport-run').click();
    assert.match(await page.locator('#dbexport-error').innerText(), /Indica il database/);
    await destinazione.fill('negozio');
    await page.locator('#dbexport-run').click();
    assert.match(await page.locator('#dbexport-error').innerText(), /diverso/);
    await scegli('Connessione di destinazione', 'Mongo archivio · scheda 2');
    assert.equal(await destinazione.inputValue(), '');
    await destinazione.fill('archivio');
    await scegli('Collection e viste', 'Elimina e ricrea');
    await anteprima();
    assert.deepEqual(await invii(), []);
    assert.equal(await operazione.locator('+ dd').innerText(), nomeCopia);
    assert.match(await page.locator('#piano-voci').innerText(), /Destinazione\s+Mongo archivio · archivio/);
    assert.match(await page.locator('#piano-voci').innerText(), /Oggetti da ricreare\s+clienti \(collection\)/);
    assert.deepEqual(richiesta.destinazioneMongo, { tabId: 'arrivo', db: 'archivio' });
    const vecchia = impronta;
    await indietro();
    await destinazione.fill('archivio_2');
    await anteprima();
    assert.notEqual(impronta, vecchia);
    await page.getByRole('button', { name: 'Avvia copia', exact: true }).click();
    await page.waitForSelector('#dbexport-esito[data-stato="in_corso"]');
    assert(await page.locator('#dbexport-cancel').isDisabled());
    assert.deepEqual(await invii(), [{ tabId: 'export-opzioni', planHash: impronta }]);
    const avanzamento = { tabId: 'export-opzioni', planHash: impronta, collection: 'clienti', rows: 2, risultato: { inseriti: 2 } };
    await page.evaluate(p => window.notificaExport('database:export:progress', p), { ...avanzamento, planHash: vecchia });
    assert.equal(await report.locator('[data-conteggio="inseriti"]').count(), 0);
    await page.evaluate(p => window.notificaExport('database:export:progress', p), avanzamento);
    assert.equal(await report.locator('[data-conteggio="inseriti"]').innerText(), '2');
    const conteggi = { inseriti: 3, aggiornati: 1, sostituiti: 0, mantenuti: 2, collectionCreate: 0, collectionRicreate: 1, visteCreate: 0, visteRicreate: 0 };
    await page.evaluate(risultato => window.terminaCopia({ ok: true, risultato }), conteggi);
    await page.waitForSelector('#dbexport-esito[data-stato="completata"]');
    for (const [campo, numero] of Object.entries(conteggi)) assert.equal(await report.locator(`[data-conteggio="${campo}"]`).innerText(), String(numero));
    await page.locator('#dbexport-cancel').click();

    await apri('mongodb');
    await scegliMongo();
    await destinazione.fill('parziale');
    await anteprima();
    await page.locator('#piano-ok').click();
    await page.waitForSelector('#dbexport-esito[data-stato="in_corso"]');
    await page.evaluate(() => window.terminaCopia({ ok: false, error: 'Chiave duplicata in clienti.',
      risultato: { inseriti: 2, aggiornati: 0 } }));
    await page.waitForSelector('#dbexport-esito[data-stato="interrotta"]');
    assert.match(await report.innerText(), /Chiave duplicata/);
    assert.equal(await report.locator('[data-conteggio="inseriti"]').innerText(), '2');
    assert.equal(await report.locator('[data-conteggio="mantenuti"]').count(), 0);
    assert.equal((await invii()).length, 2);
    await page.locator('#dbexport-cancel').click();
    for (const disconnessa of [false, true]) {
      await apri('mongodb');
      await scegliMongo();
      await destinazione.fill('copia');
      await anteprima();
      await page.locator('#piano-ok').click();
      await page.waitForSelector('#dbexport-esito[data-stato="in_corso"]');
      await page.evaluate(disconnessa => {
        if (disconnessa) window.notificaExport('disconnect');
        else window.terminaCopia({ ok: false, error: 'Permesso revocato.' });
      }, disconnessa);
      await page.waitForSelector('#dbexport-esito[data-stato="interrotta"]');
      assert.match(await report.innerText(), disconnessa ? /Esito della copia da verificare/ : /Copia non completata.*Permesso revocato/s);
      assert.equal(await report.locator('[data-conteggio]').count(), 0);
      await page.locator('#dbexport-cancel').click();
    }
    assert.equal((await invii()).length, 4, 'un clic di conferma genera un solo invio, anche dopo aver perso la connessione');
    console.log('OK Wizard SQL, BSON, download mongosh e copia diretta con destinazione confermata e conteggi reali o parziali.');
  } finally {
    await browser?.close();
    await server.stop();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
