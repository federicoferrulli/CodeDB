'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const mutantMirino = process.argv.includes('--mutant-mirino');
const checksOnly = process.argv.includes('--checks-only');
const dir = `test-reports/geomap-mirino-2026-10-11/${mutant || mutantMirino ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });
const polygon = { type: 'Polygon', coordinates: [[[12.9, 42.3], [14.1, 42.5], [13.8, 41.7], [12.9, 42.3]]] };

(async () => {
  const server = await startTestServer({ port: 3199 });
  const browser = await chromium.launch();
  const report = { layouts: [], checks: [], errors: [] };
  let page;
  try {
    for (const [width, height] of [[390, 844], [320, 740], [844, 390], [1440, 960]]) {
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: width <= 900, isMobile: width <= 900, reducedMotion: 'reduce' });
      page = await context.newPage();
      if (mutantMirino) await page.route('**/js/geomap.js', async route => {
        const response = await route.fetch();
        const source = await response.text();
        const rotto = source.replace('spostaAlMirino(geo, selezione);', '/* Mutante: il comando non sposta il vertice. */');
        assert.notEqual(rotto, source, 'La mutazione deve intercettare il comando');
        await route.fulfill({ response, body: rotto });
      });
      page.on('pageerror', e => report.errors.push(e.message));
      await page.addInitScript(version => {
        localStorage.setItem('codedb:geo:tiles', 'off');
        localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true }));
      }, require('../package.json').version);
      await page.goto(server.url);
      await page.waitForSelector('html[data-arc-ready="true"]');
      await page.evaluate(async () => {
        const L = await (await import('/js/geo-leaflet.js')).caricaLeaflet();
        const create = L.map;
        L.map = (...args) => (window.testMap = create(...args));
        window.geoEditor = await import('/js/geomap.js');
      });
      await page.evaluate(value => window.geoEditor.openGeoEditor({ value, campo: 'poligono', onSave: geo => { window.savedGeo = geo; } }), polygon);
      await page.waitForFunction(() => window.testMap && document.querySelector('#geomap-canvas canvas'));
      await page.waitForFunction(() => window.testMap.getZoom() > 5 && !window.testMap._animatingZoom && window.testMap.getSize().x === document.querySelector('#geomap-canvas').clientWidth);
      if (mutant && width <= 900) await page.addStyleTag({ content: '#geomap-overlay .geomap-azioni-vertice { position:absolute; bottom:22px; left:8px; right:8px; }' });
      const geometry = await page.evaluate(() => {
        const rect = selector => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        return { map: rect('#geomap-canvas'), rail: rect('#geomap-azioni-forma'), vertices: rect('#geomap-azioni'),
          body: rect('#geomap-overlay .geomap-body'), overflow: document.querySelector('#geomap-overlay .modal').scrollWidth > innerWidth };
      });
      assert(!geometry.overflow, 'Nessun overflow orizzontale');
      if (width <= 900) {
        assert(geometry.map.height >= (height < 600 ? 180 : width < 360 ? 200 : 280), 'Mappa sufficientemente alta');
        assert(geometry.map.bottom <= Math.min(geometry.body.bottom, height) + 1, 'Mappa interamente visibile all’apertura');
        assert(geometry.rail.y >= geometry.map.bottom - 1, 'Gli strumenti non coprono la mappa');
        assert(geometry.vertices.y >= geometry.rail.bottom - 1 || geometry.vertices.x >= geometry.map.right - 1, 'I comandi dei vertici non coprono mappa o strumenti');
        assert(!(await page.locator('#geomap-json').isVisible()), 'Su mobile si apre la mappa');
        assert.equal(await page.locator('#geomap-json-btn').getAttribute('aria-pressed'), 'false');
        assert(await page.evaluate(coords => {
          const zoom = document.querySelector('#geomap-canvas .leaflet-control-zoom').getBoundingClientRect();
          const map = document.querySelector('#geomap-canvas').getBoundingClientRect();
          return coords.every(([lon, lat]) => window.testMap.latLngToContainerPoint([lat, lon]).x + map.x > zoom.right + 7);
        }, polygon.coordinates[0]), 'I vertici restano fuori dai controlli dello zoom');
      } else {
        assert(await page.locator('#geomap-json').isVisible(), 'Desktop mantiene mappa e JSON affiancati');
        assert(!(await page.locator('#geomap-mirino').isVisible()), 'Il mirino è riservato al mobile');
      }
      for (const theme of checksOnly ? [] : ['dark', 'light']) {
        await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
        await page.screenshot({ path: `${dir}/${theme}-${width}.png`, animations: 'disabled' });
      }
      report.layouts.push({ width, height, ...geometry });

      if (width <= 900) {
        const leggi = () => page.locator('#geomap-json').evaluate(el => JSON.parse(el.value));
        const mira = async pos => {
          // Arc aggiorna le etichette e il ResizeObserver riallinea Leaflet nel frame successivo.
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await page.evaluate(([lon, lat]) => window.testMap.panTo([lat, lon], { animate: false }), pos);
          return page.evaluate(() => {
            const centro = window.testMap.getCenter().wrap();
            return [Number(centro.lng.toFixed(7)), Number(centro.lat.toFixed(7))];
          });
        };
        assert(await page.locator('#geomap-mirino').isVisible());
        const center = await page.locator('#geomap-mirino').boundingBox();
        assert(Math.abs(center.x + center.width / 2 - geometry.map.x - geometry.map.width / 2) < 1);
        assert(Math.abs(center.y + center.height / 2 - geometry.map.y - geometry.map.height / 2) < 1);
        await mira(polygon.coordinates[0][0]);
        await page.touchscreen.tap(geometry.map.x + geometry.map.width / 2, geometry.map.y + geometry.map.height / 2);
        assert.deepEqual(await leggi(), polygon, 'Un tocco sulla mappa non modifica i dati');
        if (width === 390) {
          const beforePan = await page.evaluate(() => window.testMap.getCenter());
          const cdp = await context.newCDPSession(page);
          const x = geometry.map.x + geometry.map.width / 2, y = geometry.map.y + geometry.map.height / 2;
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
          for (let step = 1; step <= 5; step++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + step * 10, y: y + step * 5 }] });
            await page.waitForTimeout(25);
          }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await page.waitForTimeout(350);
          await cdp.detach();
          assert.notDeepEqual(await page.evaluate(() => window.testMap.getCenter()), beforePan, 'Il trascinamento touch sul vertice sposta la mappa');
          assert.deepEqual(await leggi(), polygon, 'Il pan touch non trascina il vertice');
          await mira(polygon.coordinates[0][0]);
        }
        await page.locator('#geomap-mirino-apply').tap();
        await page.waitForFunction(() => !document.querySelector('#geomap-insert-vertex').disabled);
        for (const id of ['geomap-mirino-apply', 'geomap-mirino-select', 'geomap-insert-vertex', 'geomap-del-vertex']) {
          const action = await page.locator('#' + id).boundingBox();
          assert(action.y >= geometry.body.y && action.y + action.height <= Math.min(geometry.body.bottom, height) + 1, 'Azioni sul vertice visibili senza scorrere');
          assert(action.width >= 44 && action.height >= 44, 'Bersagli touch di almeno 44 pixel');
        }
        const nuova = await mira([13.1, 42.1]);
        assert.deepEqual(await leggi(), polygon, 'Spostare la mappa conserva la geometria fino alla conferma');
        await page.locator('#geomap-mirino-apply').tap();
        const spostato = await leggi();
        assert.deepEqual(spostato.coordinates[0][0], nuova, 'Il primo vertice si sposta al mirino');
        assert.deepEqual(spostato.coordinates[0].at(-1), nuova, 'Il poligono resta chiuso');
        await page.locator('#geomap-undo').tap();
        assert.deepEqual(await leggi(), polygon);
        await page.locator('#geomap-redo').tap();
        assert.deepEqual(await leggi(), spostato);
        await mira(nuova);
        await page.locator('#geomap-mirino-apply').tap();
        const inserita = await mira([13.3, 42.2]);
        await page.locator('#geomap-insert-vertex').tap();
        assert.equal((await leggi()).coordinates[0].length, 5);
        assert.deepEqual((await leggi()).coordinates[0][1], inserita, 'Inserimento al mirino dopo il vertice scelto');
        await page.locator('#geomap-del-vertex').tap();
        assert.deepEqual(await leggi(), spostato, 'Eliminazione del vertice inserito');
        await page.locator('#geomap-undo').tap();
        await page.locator('#geomap-undo').tap();
        await page.locator('#geomap-undo').tap();
        assert.deepEqual(await leggi(), polygon);
        await page.locator('#geomap-mode-draw').tap();
        const aggiunta = await mira([13.6, 41.8]);
        await page.locator('#geomap-mirino-apply').tap();
        assert.deepEqual((await leggi()).coordinates[0].at(-2), aggiunta, 'Disegna aggiunge al mirino prima della chiusura');
        await page.locator('#geomap-undo').tap();
        await page.locator('#geomap-json-btn').tap();
        assert(await page.locator('#geomap-json').isVisible());
        assert(!(await page.locator('#geomap-canvas').isVisible()), 'Il testo ha una vista propria');
        await page.locator('#geomap-json').fill('{');
        await page.locator('#geomap-json-btn').tap();
        await page.locator('#geomap-save').tap();
        assert(await page.locator('#geomap-json').isVisible(), 'Un errore nel JSON riapre la vista da correggere');
        assert.equal(await page.evaluate(() => window.savedGeo), undefined, 'Il JSON non valido non si salva');
        const modified = structuredClone(polygon); modified.coordinates[0][1][0] = 14.2;
        await page.locator('#geomap-json').fill(JSON.stringify(modified));
        await page.locator('#geomap-json-btn').tap();
        await page.waitForFunction(() => window.testMap.getSize().x === document.querySelector('#geomap-canvas').clientWidth);
        assert(await page.locator('#geomap-canvas').isVisible());
        await page.locator('#geomap-save').tap();
        assert.deepEqual(await page.evaluate(() => window.savedGeo), modified, 'Salvataggio conserva la modifica GeoJSON');
        report.checks.push(`Touch ${width}: mirino centrato, selezione, pan senza modifiche, spostamento con chiusura anello, inserimento, eliminazione, aggiunta, annulla/ripeti, cambio Mappa/GeoJSON e salvataggio`);
        if (width === 390) {
          const apri = async value => {
            await page.evaluate(value => window.geoEditor.openGeoEditor({ value }), value);
            await page.waitForTimeout(350);
            await page.waitForFunction(() => !window.testMap._animatingZoom);
          };
          const punto = { type: 'Point', coordinates: [12.5, 41.9, 180] };
          await apri(punto);
          assert.equal(await page.locator('#geomap-mirino-apply').innerText(), 'Posiziona qui');
          const destinazione = await mira([12.52, 41.91]);
          await page.locator('#geomap-mirino-apply').tap();
          assert.deepEqual((await leggi()).coordinates, [...destinazione, 180], 'Lo spostamento conserva la quota');
          await page.locator('#geomap-undo').tap();
          assert.deepEqual(await leggi(), punto);
          await page.locator('#geomap-redraw').tap();
          await page.locator('#geomap-mirino-apply').tap();
          assert.deepEqual((await leggi()).coordinates, destinazione, 'Un Point svuotato si riposiziona');
          await page.locator('#geomap-cancel').tap();
          const multi = { type: 'MultiLineString', coordinates: [[[12.5, 41.9], [12.6, 41.8]], [[12.7, 41.8], [12.8, 41.7]]] };
          await apri(multi);
          await mira(multi.coordinates[1][0]);
          await page.locator('#geomap-mirino-apply').tap();
          await mira(multi.coordinates[0][0]);
          await page.locator('#geomap-mirino-select').tap();
          await page.locator('#geomap-mode-draw').tap();
          const aggiuntaParte = await mira([12.55, 41.85]);
          await page.locator('#geomap-mirino-apply').tap();
          assert.deepEqual((await leggi()).coordinates[0].at(-1), aggiuntaParte, 'Aggiunta alla parte selezionata dal mirino');
          assert.deepEqual((await leggi()).coordinates[1], multi.coordinates[1], 'Le altre parti non cambiano');
          await page.locator('#geomap-cancel').tap();
          report.checks.push('Point: quota conservata, annulla, ridisegno; MultiLineString: cambio vertice e parte attiva');
        }
        await page.evaluate(value => window.geoEditor.openGeoEditor({ value, campo: 'sola lettura', readOnly: true }), polygon);
        assert(!(await page.locator('#geomap-save').isVisible()));
        assert(!(await page.locator('#geomap-azioni').isVisible()));
        assert(!(await page.locator('#geomap-mirino').isVisible()));
        await page.locator('#geomap-json-btn').tap();
        assert(await page.locator('#geomap-json').evaluate(el => el.readOnly));
        report.checks.push('Sola lettura: mappa e GeoJSON consultabili, nessuna modifica abilitata');
      }
      await page.locator('#geomap-cancel').click();
      await page.locator('#geomap-overlay').waitFor({ state: 'hidden' });
      await context.close();
    }
    assert.deepEqual(report.errors, []);
    console.log(`OK: ${report.layouts.length} formati, ${report.checks.length} scenari mappa`);
  } catch (error) {
    report.failure = error.stack;
    await page?.screenshot({ path: `${dir}/failure.png` }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(`${dir}/${checksOnly ? 'checks' : 'report'}.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
