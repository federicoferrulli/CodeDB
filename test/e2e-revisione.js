'use strict';
// UI e renderer reali; dataset e trasporto sintetici, senza dati dell'utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.find(x => x.startsWith('--mutant='))?.split('=')[1];
const dir = `${process.env.CODEDB_REPORT_ROOT || 'test-reports/revisione-2026-10-09'}/copertura${mutant ? `-${mutant}` : ''}`;
const sizes = [[1280,720],[1440,900],[1920,1080],[768,1024],[1024,768],[360,800],[390,844],[430,932],[320,800],[844,390],[720,450]];
const report = { environment: 'Chromium, viewport simulati; trasporto controllato, renderer reali', checks: [], layouts: [], errors: [], requests: [] };
fs.mkdirSync(dir, { recursive: true });
(async () => {
  const server = await startTestServer({ port: 3182 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('response', r => { if (r.url().startsWith(server.url) && r.status() >= 400) report.requests.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', r => { if (r.url().startsWith(server.url) && r.failure()?.errorText !== 'net::ERR_ABORTED') report.requests.push(r.url()); });
  const check = name => { report.checks.push(name); console.log('OK', name); };
  try {
    const mutations = {
      densita: ['grid.js', "const rowH = altezzaRigaGriglia($('#grid'));", 'const rowH = vctx.rowH;'],
      valori: ['utils.js', "if (v === undefined) return { text: 'mancante', cls: 'type-null' };", "if (v === undefined) return { text: 'NULL', cls: 'type-null' };"],
      separatore: ['maniglia.js', 'sposta(delta, prima, e);', '/* mutazione: nessun ridimensionamento da tastiera */'],
      menu: ['utils.js', 'next.focus();', '/* mutazione: focus fermo */'],
      schede: ['document-switcher.js', 'if (doc) switchCollTab(doc.id);', '/* mutazione: documento non selezionato */'],
      risultati: ['query-tab.js', 'panel.dataset.surface = surface;', "panel.dataset.surface = 'both';"],
      drawer: ['responsive.js', 'el.inert = mq.matches && !open;', 'el.inert = false;'],
      focus_drawer: ['responsive.js', 'if (restoreFocus && drawerOpener?.isConnected)', 'if (false)'],
      focus_schede: ['document-switcher.js', 'if (focusId) (list.querySelector', 'if (false) (list.querySelector'],
      schema: ['../css/style.css', 'max-width: min(85vw, var(--area-larghezza));', 'max-width: min(85vw, var(--area-larghezza)); z-index: 80;'],
    };
    if (mutant) {
      assert(mutations[mutant], 'Mutazione conosciuta');
      const [file, from, to] = mutations[mutant];
      await page.route(`**/${file.startsWith('../')?file.slice(3):'js/'+file}`, async route => {
        const response = await route.fetch(), code = await response.text();
        assert(code.includes(from), `Punto di mutazione presente: ${file}`);
        await route.fulfill({ response, body: code.replace(from, to) });
      });
    }
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.waitForFunction(() => document.querySelector('#documents-panel'));
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    if (await page.getByRole('button', { name: 'Nascondi i primi passi' }).isVisible()) await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await page.evaluate(async () => {
      window.revisioneModuli = await Promise.all(['tabs','socket','tabbar','workspace','colltabs'].map(name => import(`/js/${name}.js`)));
    });
    await page.evaluate(() => {
      window.fixturePhase = 'importazioni';
      const [{ createTab, tabs }, { impostaSocket }, tabbar, workspace, colltabs] = window.revisioneModuli;
      window.fixturePhase = 'dati';
      const collections = ['ordini', 'clienti', ...Array.from({ length: 12 }, (_, i) => `oggetto_${i}_con_nome_lungo_e_spazi`)].map(name => ({ name }));
      const docs = Array.from({ length: 1200 }, (_, i) => ({ _id: i, nome: `Riga ${i}`, nullo: null, vuoto: '', zero: 0, falso: false, preciso: { $numberLong: '9007199254740993' }, decimale: { $numberDecimal: '12345678901234567890.123456789' }, data: { $date: '2026-10-09T12:34:56.789Z' }, lungo: 'Testo integrale '.repeat(300), oggetto: { valore: i } }));
      const columns = ['_id','nome','nullo','mancante','vuoto','zero','falso','preciso','decimale','data','lungo','oggetto'];
      const fields = columns.map(name => ({ name, types: [name === '_id' ? 'int' : 'string'], presence: 100 }));
      window.revisione = { sent: [], docs, columns };
      const fake = { connected: true, on() {}, off() {},
        timeout() { return { emit(name, payload, ack) { fake.emit(name, payload, res => ack(null, res)); } }; },
        emit(name, payload, ack) {
        window.revisione.sent.push({ name, payload });
        if (name === 'doc:update') return ack?.({ ok: false, error: 'Vincolo della fixture: bozza conservata' });
        ack?.({ ok: true, docs, data: docs, columns, total: docs.length, skip: 0, limit: 2000, fields, indexes: [], stats: { count: docs.length }, collections: collections.map(c => ({ ...c, fields, indexes: [] })), databases: [{ name: 'schema_lungo', collections }], relazioni: [] });
      } };
      impostaSocket(fake);
      for (const [id, dbType] of [['a','mongodb'],['b','postgresql']]) {
        const tab = createTab({ id }); tab.label = `Connessione ${id.toUpperCase()}`; tab.dbType = dbType;
        Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType, databases: [{ name: 'schema_lungo', collections }], limit: 2000 });
      }
      tabs.activeId = 'a';
      window.fixturePhase = 'barra';
      tabbar.renderTabBar();
      window.fixturePhase = 'workspace';
      workspace.renderWorkspace();
      window.fixturePhase = 'documento';
      colltabs.openCollTab('schema_lungo', 'ordini');
      window.fixturePhase = 'pronta';
      return true;
    });
    await page.locator('#grid.virtual tbody tr:not(.v-spacer)').first().waitFor();
    const values = await page.evaluate(async () => {
      const { displayValueBreve, displayValue } = await import('/js/utils.js');
      return { drawn: [null, undefined, '', 0, false].map(v => displayValueBreve(v).text), emptyCopied: displayValue('').text, longCopied: displayValue(window.revisione.docs[0].lungo).text };
    });
    assert.equal(new Set(values.drawn).size, 5, 'NULL, mancante, vuoto, zero e false sono distinguibili');
    assert.equal(values.emptyCopied, ''); assert.equal(values.longCopied, 'Testo integrale '.repeat(300));
    check('Cinque valori distinti; testo copiabile completo e stringa vuota invariata');

    const handle = page.locator('[data-resize="conn-sidebar"]');
    await handle.focus(); const initial = Number(await handle.getAttribute('aria-valuenow'));
    await handle.press('ArrowRight');
    assert(Number(await handle.getAttribute('aria-valuenow')) > initial, 'Il separatore modifica la larghezza da tastiera');
    await handle.press('Home'); assert.equal(Number(await handle.getAttribute('aria-valuenow')), 150);
    await handle.press('ArrowRight');
    check('Separatore tastiera, limiti e valore accessibile aggiornato');

    const menu = page.locator('#db-tree > .db > .node-actions').first();
    await menu.click();
    const first = await page.evaluate(() => document.activeElement.textContent);
    await page.keyboard.press('ArrowDown');
    assert.notEqual(await page.evaluate(() => document.activeElement.textContent), first, 'Freccia sposta il focus del menu');
    await page.keyboard.press('Escape'); assert(await menu.evaluate(el => document.activeElement === el));
    check('Menu visibile dell’esploratore, frecce, Escape e ritorno al comando');

    const cell = page.locator('#grid td[data-r="0"][data-c="1"]');
    await cell.dblclick(); await cell.locator('input').fill('Bozza durante rotazione');
    const editor = await cell.locator('input').elementHandle();
    await page.setViewportSize({ width:390, height:844 });
    await page.waitForTimeout(150);
    assert(await editor.evaluate(el => el.isConnected && el.value === 'Bozza durante rotazione'), 'Rotazione conserva l’editor montato');
    await editor.press('Escape');
    const geometry = () => page.evaluate(() => {
      const table = document.getElementById('grid');
      return { body: table.tBodies[0].getBoundingClientRect().height, row: table.querySelector('tbody tr:not(.v-spacer)').getBoundingClientRect().height, count: window.revisione.docs.length,
        heights: [...table.tBodies[0].rows].map(r=>({row:r.querySelector('[data-r]')?.dataset.r,actual:r.getBoundingClientRect().height,spacer:r.classList.contains('v-spacer')?r.cells[0].style.height:undefined})) };
    });
    const g = await geometry();
    assert(Math.abs(g.body - g.row * g.count) < 2, `Geometria touch virtuale ${JSON.stringify(g)}`);
    check('Cambio densità durante editing: bozza integra e spaziatori coerenti');
    assert(await page.locator('#sidebar').evaluate(el => el.inert), 'Drawer chiuso escluso dalla tastiera');
    await page.locator('#menu-dbs-btn').click();
    assert.equal(await page.locator('#menu-dbs-btn').getAttribute('aria-expanded'), 'true');
    assert(await page.locator('.arc-navigation-sheet').evaluate(el => el.contains(document.activeElement)));
    await page.keyboard.press('Escape');
    assert(await page.locator('#menu-dbs-btn').evaluate(el => document.activeElement === el), 'La scelta nel drawer restituisce il focus al comando Database');
    await page.locator('#menu-dbs-btn').click();
    await page.locator('#db-tree .coll .node-label').first().focus();await page.keyboard.press('Enter');
    assert(await page.locator('#menu-dbs-btn').evaluate(el=>document.activeElement===el),'La scelta nel drawer restituisce il focus fuori dal contenuto inert');
    check('Drawer: stato, focus iniziale, chiusura e focus restituito');

    await page.evaluate(async () => {
      const { openCollTab } = await import('/js/colltabs.js');
      for (let i=0;i<12;i++) openCollTab('schema_lungo', `oggetto_${i}_con_nome_lungo_e_spazi`);
      (await import('/js/main.js')).setView('query');
    });
    await page.locator('#query-editor-input').fill('SELECT bozza_del_documento');
    await page.setViewportSize({width:1440,height:900});
    assert.equal(await page.locator('#documents-open').isVisible(), false, 'Schede non duplica le barre desktop');
    assert(await page.locator('#tab-bar').isVisible() && await page.locator('#coll-tab-bar').isVisible(), 'Desktop conserva le barre delle schede');
    await page.setViewportSize({width:390,height:844});
    for (const selector of ['#tab-bar', '#coll-tab-bar', '#session-count']) assert.equal(await page.locator(selector).isVisible(), false, `Su mobile resta solo Schede: ${selector}`);
    await page.locator('#documents-open').click();
    const sheet = page.getByRole('dialog', {name:'Schede aperte',exact:true});
    await sheet.waitFor();
    assert(await sheet.locator('[data-grabber]').isVisible(), 'Schede usa il BottomSheet Arc con maniglia');
    assert.equal(await page.locator('#documents-open').getAttribute('aria-expanded'), 'true');
    await page.screenshot({path:`${dir}/schede-mobile.png`});
    assert((await page.locator('#documents-panel').textContent()).includes('Modifiche non salvate'));
    const order = await page.evaluate(async () => (await import('/js/tabs.js')).activeTab().state.collTabs.map(c => c.id));
    await page.locator('#documents-panel').getByRole('button', { name: 'Azioni oggetto_11_con_nome_lungo_e_spazi', exact:true }).click();
    await page.getByRole('menuitem', { name: 'Sposta prima', exact:true }).click();
    const afterOrder = await page.evaluate(async () => (await import('/js/tabs.js')).activeTab().state.collTabs.map(c => c.id));
    assert.equal(afterOrder.at(-2), order.at(-1));
    assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Azioni oggetto_11_con_nome_lungo_e_spazi','Il riordino mantiene il focus sul documento');
    await page.locator('#documents-panel .document-row > button:first-child').filter({ hasText: /^ordini/ }).click();
    assert.equal(await page.evaluate(async () => (await import('/js/state.js')).state.coll), 'ordini', 'Lo switcher attiva il documento scelto');
    assert.equal(await sheet.count(), 0, 'Selezionare un documento chiude il drawer');
    assert(await page.locator('#documents-open').evaluate(el=>el===document.activeElement), 'La selezione restituisce il focus a Schede');
    await page.locator('#documents-open').click();
    await page.keyboard.press('Control+b');
    await page.getByRole('dialog',{name:'Connessioni',exact:true}).waitFor();
    assert.equal(await page.locator('#documents-open').getAttribute('aria-expanded'), 'false', 'Passare a Connessioni chiude anche lo stato del drawer Schede');
    await page.keyboard.press('Escape');
    assert(await page.locator('#documents-open').evaluate(el=>el===document.activeElement), 'Chiudere Connessioni dopo il cambio di drawer restituisce il focus a Schede');
    await page.locator('#documents-open').click();
    await page.locator('#documents-panel').getByRole('button', {name:'Azioni oggetto_0_con_nome_lungo_e_spazi',exact:true}).click();
    await page.keyboard.press('Escape');
    assert(await sheet.isVisible(), 'Escape dal menu azioni conserva il drawer Schede');
    await page.locator('#documents-panel').getByRole('button', {name:'Azioni oggetto_0_con_nome_lungo_e_spazi',exact:true}).click();
    await page.getByRole('menuitem',{name:'Chiudi documento',exact:true}).click();
    assert.equal(await page.locator('#documents-panel').getByRole('button', {name:'Azioni oggetto_0_con_nome_lungo_e_spazi',exact:true}).count(), 0, 'Si può chiudere un documento dal drawer');
    check('Molte schede: bozze, contesto, riordino senza trascinamento e selezione separata dalle azioni');
    await page.setViewportSize({width:1440,height:900});
    await sheet.waitFor({state:'detached'});
    assert(await page.locator('#tab-bar').isVisible() && await page.locator('#coll-tab-bar').isVisible(), 'Il ritorno desktop ripristina le barre e chiude il drawer');
    await page.evaluate(async () => (await import('/js/query-tab.js')).renderResults(window.revisione.docs, window.revisione.columns));

    for (const theme of ['light','dark','custom']) {
      await page.evaluate(async theme => {
        const { applicaTema } = await import('/js/theme.js');
        if (theme === 'custom') {
          const { scelteIniziali } = await import('/js/theme-colori.js');
          const { chiaveStorage } = await import('/js/utils.js');
          localStorage.setItem(chiaveStorage('temi'), JSON.stringify({fixture:{id:'fixture',nome:'Tema di prova',base:'dark',scelte:{...scelteIniziali('dark'),accent:'#a78bfa'}}}));
        }
        applicaTema(theme === 'custom' ? 'fixture' : theme);
      }, theme);
      for (const [width,height] of sizes) {
        await page.setViewportSize({ width,height }); await page.waitForTimeout(70);
        const bounds = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth+1, overflowY: document.documentElement.scrollHeight > innerHeight+1 }));
        assert(!bounds.overflow && !bounds.overflowY, `Shell ${theme} ${width}×${height}: ${JSON.stringify(bounds)}`);
        await page.waitForFunction(() => {
          const table = document.getElementById('grid');
          const row = table.querySelector('tbody tr:not(.v-spacer)');
          return Math.abs(table.tBodies[0].getBoundingClientRect().height - row.getBoundingClientRect().height * window.revisione.docs.length) < 2;
        }, null, { timeout: 5000 });
        const g = await geometry(); assert(Math.abs(g.body-g.row*g.count)<2, `Griglia ${theme} ${width}×${height}: ${JSON.stringify(g)}`);
        report.layouts.push({ theme, width,height, ...bounds, rowHeight:g.row });
        for (const view of ['query','details']) {
          await page.evaluate(async view => (await import('/js/main.js')).setView(view), view);
          assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${view}: reflow ${width}`);
          if(view==='query') for(const id of ['query-target-btn','query-run-btn','query-status-badge']) {
            const box=await page.locator(`#${id}`).boundingBox();
            assert(box && box.x>=-1 && box.x+box.width<=width+1,`Comando ${id} raggiungibile a ${width}`);
          }
        }
        await page.evaluate(async () => (await import('/js/main.js')).setView('data'));
      }
    }
    check('Shell, griglia, query e dettagli: 11 viewport, tre temi, landscape e reflow a 320px; geometria virtuale coerente');
    await page.setViewportSize({ width:390,height:844 });
    await page.evaluate(async () => {
      (await import('/js/main.js')).setView('query');
      (await import('/js/query-tab.js')).renderResults(window.revisione.docs, window.revisione.columns);
    });
    await page.locator('#query-editor-input').fill('SELECT codice_esatto FROM ordini');
    await page.locator('#query-toggle-schema-btn').click();
    assert(await page.locator('#query-schema-close').evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'Il drawer schema resta sopra il backdrop');
    await page.locator('#query-schema-close').click();
    await page.locator('#query-show-editor').click();
    assert.equal(await page.locator('#query-results-container').isVisible(), false, 'Editor occupa la superficie scelta');
    await page.locator('#query-editor-input').focus();
    const beforeSelection = await page.locator('#query-editor-input').evaluate(el => { el.setSelectionRange(7,20); return [el.selectionStart,el.selectionEnd]; });
    await page.screenshot({path:`${dir}/query-editor-390.png`});
    await page.locator('#query-show-results').click();
    assert.equal(await page.locator('#query-editor-container').isVisible(), false);
    assert(await page.locator('#query-result-table').isVisible());
    await page.screenshot({path:`${dir}/query-risultati-390.png`});
    await page.locator('#query-show-editor').click();
    assert.deepEqual(await page.locator('#query-editor-input').evaluate(el => [el.selectionStart,el.selectionEnd]),beforeSelection);
    assert.equal(await page.locator('#query-editor-input').inputValue(),'SELECT codice_esatto FROM ordini');
    await page.setViewportSize({width:1440,height:900});
    assert(await page.locator('#query-editor-container').isVisible() && await page.locator('#query-results-container').isVisible());
    check('Editor/Risultati mobile: stessi nodi, codice e selezione; desktop ripristina entrambe le regioni');
    const vertical = page.locator('#query-editor-resizer');
    await vertical.focus(); const h = Number(await vertical.getAttribute('aria-valuenow'));
    await vertical.press('ArrowDown'); assert(Number(await vertical.getAttribute('aria-valuenow')) > h);
    check('Separatore verticale editor/risultati da tastiera');
    for (const [width,height] of [[320,800],[390,844],[768,1024],[844,390]]) {
      await page.setViewportSize({width,height});
      await page.locator('#documents-open').click();
      await sheet.waitFor();
      assert(await sheet.getByRole('button',{name:'Chiudi',exact:true}).evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}), `Chiusura Schede raggiungibile ${width}×${height}`);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:`${dir}/schede-${width}.png`});
      await sheet.getByRole('button',{name:'Chiudi',exact:true}).click();
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('#documents-open').click();
    await page.locator('#documents-panel .document-row > button:first-child').filter({hasText:/^Connessione B/}).click();
    assert.equal(await page.evaluate(async()=>(await import('/js/tabs.js')).tabs.activeId), 'b', 'Schede cambia connessione');
    await page.locator('#documents-open').click();
    await page.locator('#documents-panel .document-row > button:first-child').filter({hasText:/^Connessione A/}).click();
    assert.equal(await page.locator('#query-editor-input').inputValue(), 'SELECT codice_esatto FROM ordini', 'Cambiare connessione conserva la bozza');
    await page.locator('#documents-open').click();
    await page.locator('#documents-panel').getByRole('button',{name:'Azioni Connessione B',exact:true}).click();
    await page.getByRole('menuitem',{name:'Disconnetti',exact:true}).click();
    assert.equal(await page.evaluate(async()=>(await import('/js/tabs.js')).tabs.list.some(t=>t.id==='b')), false, 'Disconnessione disponibile nel drawer');
    await page.keyboard.press('Escape');
    await page.evaluate(async()=>{(await import('/js/tabs.js')).closeAllTabs();});
    await page.locator('#documents-open').click();
    assert.equal(await page.locator('#documents-panel .documents-list').textContent(), 'Nessuna connessione aperta.');
    await page.locator('#documents-new-connection').click();
    await page.locator('#connect-overlay').waitFor({state:'visible'});
    assert.equal(await sheet.count(), 0, 'Nuova connessione chiude il drawer prima di aprire il form');
    await page.locator('#conn-cancel-btn').click();
    check('BottomSheet Schede: portrait e landscape, cambio connessione, disconnessione, stato vuoto e nuova connessione');
    assert.deepEqual(report.errors,[]); assert.deepEqual(report.requests,[]);
  } catch(e) { report.failure=e.stack; report.phase=await page.evaluate(()=>window.fixturePhase).catch(()=>null); await page.screenshot({path:`${dir}/failure.png`}).catch(()=>{}); throw e; }
  finally { fs.writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2)); await browser.close(); await server.stop(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
