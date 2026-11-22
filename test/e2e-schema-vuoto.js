'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.env.EMPTY_SCHEMA_MUTANT;
const dir = `test-reports/schema-vuoto/${mutant || 'dopo'}`;

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const server = await startTestServer({ port: 3198 });
  const browser = await chromium.launch();
  try {
    for (const [width, height, theme, dbType] of [
      [1440, 900, 'dark', 'mysql'], [1440, 900, 'light', 'mongodb'],
      [390, 844, 'dark', 'postgresql'], [320, 740, 'custom', 'mongodb'],
    ]) {
      const mobile = width <= 900;
      const titoloElenco = dbType === 'postgresql' ? 'Nessuno schema visibile' : 'Nessun database visibile';
      const tipo = dbType === 'mongodb' ? 'collection' : 'tabella';
      const page = await browser.newPage({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
      await page.goto(server.url);
      await page.waitForSelector('html[data-arc-ready="true"]');
      await page.evaluate(async ({ theme, dbType }) => {
        const { createTab, tabs } = await import('/js/tabs.js');
        const tab = createTab({ id: 'schema-vuoto' }); tabs.activeId = tab.id;
        tab.label = 'Archivio di lavoro'; tab.dbType = dbType;
        Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType, databases: [] });
        window.__dbs = []; window.__lists = 0;
        const fake = { connected: true, on() { return fake; }, off() { return fake; }, emit(event, payload, ack) {
          if (event === 'db:list') window.__lists++;
          ack?.({ ok: true, databases: event === 'db:search' ? [] : window.__dbs, collections: [], fields: [], docs: [], total: 0 });
        } };
        (await import('/js/socket.js')).impostaSocket(fake);
        if (theme === 'custom') {
          const { scelteIniziali } = await import('/js/theme-colori.js');
          localStorage.setItem('codedb:temi', JSON.stringify({ custom: { id: 'custom', nome: 'Bosco', base: 'dark', scelte: { ...scelteIniziali('dark'), bg: '#123b2c' } } }));
        }
        (await import('/js/theme.js')).scegliTema(theme);
        (await import('/js/tabbar.js')).renderTabBar();
        (await import('/js/workspace.js')).renderWorkspace();
      }, { theme, dbType });
      const gridArt = await page.locator('#welcome .data-empty-table').innerHTML();
      assert.equal(await page.locator('#placeholder .data-empty-table').innerHTML(), gridArt, 'Esplora i dati usa la stessa illustrazione della griglia');
      if (mobile) await page.locator('#explore-schema-open').tap();
      const art = page.locator('#db-tree > li > .data-empty-host .data-empty-art');
      await art.waitFor();
      if (mutant === 'immagine') await art.evaluate(el => { el.style.display = 'none'; });
      assert(await art.isVisible(), 'Lo stato vuoto deve mostrare l’illustrazione');
      assert.equal(await art.locator('.data-empty-table').innerHTML(), gridArt, 'Database vuoto e griglia condividono la stessa illustrazione');
      assert.equal(await art.locator('.data-empty-symbol').evaluate(el => getComputedStyle(el).color), await page.locator('#welcome .data-empty-symbol').evaluate(el => getComputedStyle(el).color), 'Il simbolo segue lo stesso tema della griglia');
      await page.getByRole('heading', { name: titoloElenco, exact: true }).waitFor();
      const empty = page.locator('#db-tree > li > .data-empty-host .data-empty');
      assert(await empty.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Testo e immagine non escono dal pannello');
      await empty.getByRole('button', { name: 'Aggiorna elenco' }).scrollIntoViewIfNeeded();
      assert(await empty.getByRole('button', { name: 'Aggiorna elenco' }).evaluate(el => {
        const b = el.getBoundingClientRect(); return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('button') === el;
      }), 'Il pulsante resta raggiungibile, senza essere coperto dai comandi del pannello');
      await page.screenshot({ path: `${dir}/database-${width}-${theme}.png` });
      await page.evaluate(() => { window.__dbs = [{ name: 'vendite', collections: [] }]; });
      await empty.getByRole('button', { name: 'Aggiorna elenco' }).click();
      await page.locator('#db-tree .db > [data-db="vendite"]').waitFor();
      assert.equal(await page.getByRole('heading', { name: titoloElenco, exact: true }).count(), 0, 'I dati sostituiscono l’illustrazione');
      const collectionEmpty = page.locator('#db-tree .node-empty');
      const etichetta = `Nuova ${tipo}`;
      const crea = collectionEmpty.getByRole('button', { name: etichetta, exact: true });
      const azioniDatabase = page.getByRole('button', { name: 'Azioni vendite', exact: true });
      if (mutant === 'azione') await collectionEmpty.evaluate(el => {
        const extra = document.createElement('button');
        extra.textContent = 'Apri query';
        el.append(extra);
      });
      assert.equal(await collectionEmpty.getByRole('button').count(), 1, 'Il ramo vuoto offre soltanto la creazione');
      assert.equal((await collectionEmpty.innerText()).trim(), etichetta, 'Il ramo mostra soltanto l’etichetta del pulsante');
      if (!mobile) await page.locator('#navigator').evaluate(el => { el.style.width = '200px'; });
      if (mutant === 'ramo') await collectionEmpty.evaluate(el => { el.style.minHeight = '240px'; });
      assert(await collectionEmpty.evaluate(el => el.scrollWidth <= el.clientWidth && el.offsetHeight < 72),
        'Il pulsante occupa una sola riga, anche nella sidebar stretta');
      if (mutant === 'larghezza') await crea.evaluate(el => { el.style.width = 'fit-content'; });
      const riga = await crea.evaluate(button => {
        const ramo = button.parentElement, stileRamo = getComputedStyle(ramo);
        const stile = getComputedStyle(button), box = button.getBoundingClientRect();
        const contenuto = document.createRange();
        contenuto.selectNodeContents(button);
        return {
          utile: ramo.clientWidth - parseFloat(stileRamo.paddingLeft) - parseFloat(stileRamo.paddingRight),
          larghezza: box.width, altezza: box.height, bordo: stile.borderStyle,
          scartoSinistro: contenuto.getBoundingClientRect().left - box.left - button.clientLeft - parseFloat(stile.paddingLeft),
        };
      });
      assert(Math.abs(riga.larghezza - riga.utile) <= 1, 'Il pulsante copre tutta la larghezza utile del ramo');
      assert.equal(riga.bordo, 'dashed', 'Il bordo del pulsante è tratteggiato');
      assert(Math.abs(riga.scartoSinistro) <= 1, 'Icona e testo partono dal margine interno sinistro del pulsante');
      const position = { x: Math.floor(riga.larghezza) - 5, y: Math.floor(riga.altezza / 2) };
      if (mobile) {
        assert(riga.larghezza >= 44 && riga.altezza >= 44, 'Il pulsante touch misura almeno 44 × 44 px');
        await crea.tap({ position });
      } else if (dbType === 'mysql') {
        await azioniDatabase.focus();
        await page.keyboard.press('Tab');
        assert(await crea.evaluate(el => el.matches(':focus-visible')), 'Tab porta il focus sul pulsante di creazione');
        await page.keyboard.press('Enter');
      } else {
        await crea.click({ position });
      }
      await page.getByRole('dialog', { name: `Nuova ${tipo}`, exact: true }).waitFor();
      assert.match(await page.locator('#collcreate-subtitle').innerText(), /vendite/);
      await page.locator('#collcreate-cancel').click();
      await page.locator('#db-search').fill('inesistente');
      await page.getByRole('heading', { name: 'Nessun risultato', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Azzera ricerca', exact: true }).click();
      assert.equal(await page.locator('#db-search').inputValue(), '');
      await page.locator('#db-tree .db > [data-db="vendite"]').waitFor();
      const query = page.getByRole('menuitem', { name: /^Query & Aggregate/ });
      await azioniDatabase.click();
      await query.click();
      await page.locator('#query-editor-input:focus').waitFor();
      assert.equal(await page.locator('#query-target-label .query-target-db').textContent(), 'vendite');
      assert.equal(await page.locator('.arc-navigation-sheet').count(), 0);
      if (!mobile) {
        await page.evaluate(async () => {
          document.getElementById('query-show-results').click();
          (await import('/js/main.js')).setView('uml');
        });
        await azioniDatabase.click();
        await query.click();
        await page.locator('#query-editor-input:focus').waitFor();
        assert.equal(await page.locator('#query-show-editor').getAttribute('aria-selected'), 'true');
      }
      await page.evaluate(async () => {
        (await import('/js/responsive.js')).closeDrawers({ immediate: true });
        const tab = (await import('/js/tabs.js')).activeTab();
        tab.state.dbType = 'postgresql'; tab.state.databases = []; window.__dbs = [];
        (await import('/js/workspace.js')).renderWorkspace();
        document.getElementById('placeholder').classList.add('hidden');
        document.getElementById('workspace').classList.remove('hidden');
        (await import('/js/main.js')).setView('query');
        (await import('/js/query-tab.js')).renderQuerySchemaBrowser();
      });
      if (mobile) await page.locator('#query-toggle-schema-btn').click();
      const schema = page.locator('#query-schema-tree');
      await schema.getByRole('heading', { name: 'Nessuno schema visibile' }).waitFor();
      assert.equal(await schema.locator('.data-empty-table').innerHTML(), gridArt, 'Anche Schema Browser usa l’illustrazione condivisa');
      assert.equal(await page.locator('#query-table-view .data-empty-table').innerHTML(), gridArt, 'I risultati query vuoti usano la stessa tabella illustrata');
      if (mobile) await page.screenshot({ path: `${dir}/schema-${width}-${theme}.png` });
      const requests = await page.evaluate(() => window.__lists);
      await page.evaluate(() => { window.__dbs = [{ name: 'laboratorio' }]; });
      if (mutant === 'ricarica') await page.locator('#query-schema-refresh').evaluate(el => el.addEventListener('click', e => e.stopImmediatePropagation(), true));
      await schema.getByRole('button', { name: 'Ricarica schema' }).click();
      await schema.locator('.schema-node[data-nome="laboratorio"]').waitFor();
      assert.equal(await page.evaluate(() => window.__lists), requests + 1, 'La ricarica interroga il server');
      assert.equal(await schema.locator('.data-empty').count(), 0);
      assert.deepEqual(errors, []);
      console.log(`OK ${width} ${theme} ${dbType}: ramo compatto, creazione, editor query, ricerca e ricarica schema`);
      await page.close();
    }
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
