'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const dir = `test-reports/geomulti-2026-10-12/${mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: mutant ? 3216 : 3215 });
  const browser = await chromium.launch();
  const report = { checks: [], layouts: [], errors: [] };
  const check = text => { report.checks.push(text); console.log('OK', text); };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(7000);
    page.on('pageerror', e => report.errors.push(e.stack || e.message));
    if (mutant) await page.route('**/js/geo-vista.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const target = 'const precedente = stato.evidenziato;';
      assert(source.includes(target));
      await route.fulfill({ response, body: source.replace(target, `${target}\n    disegna();`) });
    });
    await page.addInitScript(versione => {
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true }));
      localStorage.setItem('codedb:geo:tiles', 'off');
    }, require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const L = await (await import('/js/geo-leaflet.js')).caricaLeaflet();
      const f = window.geoFixture = { layers: [], maps: [], costruzioni: 0 };
      const geoJSON = L.geoJSON, map = L.map;
      L.geoJSON = (...args) => { f.costruzioni++; const layer = geoJSON(...args); f.layers.push(layer); return layer; };
      L.map = (...args) => { const m = map(...args); f.maps.push(m); return m; };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { f.clipboard = text; } } });
      f.voci = [
        { colonna: 'sede', riga: 0, valore: { type: 'Point', coordinates: [12.495, 41.895, 25] } },
        { colonna: 'percorso', riga: 1, valore: { type: 'LineString', coordinates: [[12.49, 41.885], [12.503, 41.897], [12.525, 41.91]] } },
        { colonna: 'zona', riga: 2, valore: { type: 'Polygon', coordinates: [[[12.503, 41.89], [12.518, 41.89], [12.518, 41.901], [12.503, 41.901], [12.503, 41.89]]] } },
        { colonna: 'consegne', riga: 3, valore: { type: 'MultiPoint', coordinates: [[12.488, 41.913], [12.525, 41.893]] } },
        { colonna: 'zona_di_intervento_con_un_nome_molto_lungo', riga: 4, valore: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [12.511, 41.908] }, { type: 'LineString', coordinates: [[12.511, 41.908], [12.52, 41.92]] }] } },
        { colonna: '<img src=x onerror="window.geoInjected=1">', riga: 5, valore: { type: 'Point', coordinates: [12.487, 41.886] } },
      ];
      f.apri = (await import('/js/geomulti.js')).apriMappaSelezione;
      (await import('/js/theme.js')).scegliTema('dark');
      await f.apri({ voci: f.voci, titolo: 'Logistica · Roma' });
    });
    const settle = () => page.waitForTimeout(420);
    await page.locator('#geomulti-canvas canvas').waitFor();
    await settle();
    assert.equal(await page.locator('#geomulti-list button').count(), 6);
    assert.equal(await page.locator('#geomulti-tab-elenco').getAttribute('aria-selected'), 'true');
    assert(await page.locator('#geomulti-map-panel').isVisible());
    assert.equal(await page.locator('#geomulti-list img').count(), 0);
    assert.equal(await page.evaluate(() => window.geoInjected), undefined);
    check('Desktop: mappa ed elenco visibili, nomi arbitrari trattati come testo');

    const builds = await page.evaluate(() => geoFixture.costruzioni);
    await page.locator('#geomulti-list [data-i="0"]').click();
    await settle();
    assert.equal(await page.locator('#geomulti-list [data-i="0"]').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#geomulti-selection').textContent(), /sede · Riga 1/);
    const selected = await page.evaluate(() => ({ builds: geoFixture.costruzioni, radius: geoFixture.layers[0].getLayers()[0].getRadius() }));
    assert.equal(selected.builds, builds, 'Selezionare non deve ricostruire i layer');
    assert.equal(selected.radius, 9);
    await page.locator('#geomulti-list [data-i="3"]').click();
    await page.evaluate(() => geoFixture.layers[2].fire('click'));
    assert.equal(await page.locator('#geomulti-list [data-i="2"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => geoFixture.layers[0].getLayers()[0].getRadius()), 6);
    assert(await page.evaluate(() => {
      const radii = [];
      const visita = l => l.getRadius ? radii.push(l.getRadius()) : l.eachLayer(visita);
      visita(geoFixture.layers[3]);
      return radii.length === 2 && radii.every(r => r === 6);
    }));
    await page.evaluate(() => geoFixture.layers[2].fire('click'));
    assert.equal(await page.locator('#geomulti-list .attiva').count(), 0);
    assert.equal(await page.evaluate(() => geoFixture.costruzioni), builds);
    check('Selezione bidirezionale e deselezione senza ricreare layer, anche MultiPoint');

    const motionIn = await page.evaluate(() => {
      document.querySelector('#geomulti-tab-riepilogo').click();
      const animations = document.querySelector('#geomulti-summary-panel').getAnimations();
      return animations.map(a => a.effect.getTiming().duration);
    });
    assert.deepEqual(motionIn, [240], 'Il pannello deve avere una transizione breve');
    assert(await page.locator('#geomulti-summary-panel').isVisible());
    assert.match(await page.locator('#geomulti-summary').textContent(), /Lunghezza.*Area.*Perimetro/s);
    await page.locator('#geomulti-tab-riepilogo').press('ArrowLeft');
    assert.equal(await page.locator('#geomulti-tab-elenco').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#geomulti-summary-panel').evaluate(el => el.getAnimations().length), 0, 'Il cambio rapido interrompe il pannello precedente');
    await page.locator('#geomulti-copy').click();
    assert.match(await page.evaluate(() => geoFixture.clipboard), /Geometrie\t6/);
    const download = page.waitForEvent('download');
    await page.locator('#geomulti-export').click();
    const exported = JSON.parse(fs.readFileSync(await (await download).path(), 'utf8'));
    assert.equal(exported.features.length, 6);
    assert.deepEqual(exported.features.map(f => f.geometry), await page.evaluate(() => geoFixture.voci.map(v => v.valore)));
    assert.deepEqual(exported.features[0].properties, { n: 1, colonna: 'sede', riga: 1 });
    for (const close of await page.getByRole('button', { name: 'Chiudi notifica' }).all()) await close.click();
    check('Navigazione da tastiera, riepilogo, copia ed export con quota Z e geometrie originali');

    for (const theme of ['dark', 'light']) for (const [width, height] of [[1440, 900], [1024, 768], [390, 844], [320, 740], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      await settle();
      if (width <= 900) await page.locator('#geomulti-tab-mappa').click();
      await page.locator('#geomulti-fit').click();
      await settle();
      const layout = await page.evaluate(() => {
        const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        return { map: rect('#geomulti-canvas'), footer: rect('.geomulti-footer'), tabs: rect('#geomulti-tabs'), modal: rect('.geomulti-modal'), sheet: !!document.querySelector('#geomulti-overlay .arc-dialog-sheet'), overflow: document.querySelector('.geomulti-modal').scrollWidth > document.querySelector('.geomulti-modal').clientWidth + 1 };
      });
      report.layouts.push({ theme, width, height, ...layout });
      assert(!layout.overflow, `Nessun overflow a ${width}×${height}`);
      assert(layout.map.width > 200 && layout.map.height >= (height < 500 ? 70 : 200), `Mappa utilizzabile: ${JSON.stringify(layout)}`);
      assert(layout.map.bottom <= layout.footer.y || layout.footer.right <= layout.map.x, 'La mappa non copre le azioni');
      assert(layout.footer.bottom <= height + 1, 'Footer dentro lo schermo');
      assert.equal(layout.sheet, width <= 900);
      if (width <= 900) {
        assert(await page.locator('#geomulti-export').evaluate(el => el.getBoundingClientRect().height >= 44));
        await page.locator('#geomulti-tab-elenco').click();
        assert(!await page.locator('#geomulti-map-panel').isVisible());
        await page.locator('#geomulti-list [data-i="1"]').click();
        assert.equal(await page.locator('#geomulti-tab-mappa').getAttribute('aria-selected'), 'true');
        assert(await page.locator('#geomulti-map-panel').isVisible());
        assert.equal(await page.evaluate(() => document.activeElement.id), 'geomulti-tab-mappa');
      }
      await settle();
      if (!process.argv.includes('--checks-only')) {
        await page.evaluate(() => geoFixture.layers.forEach(l => l.closeTooltip()));
        await page.screenshot({ path: `${dir}/mappa-${theme}-${width}.png` });
        if (width === 1440 || width === 390) {
          for (const mode of ['elenco', 'riepilogo']) {
            await page.locator(`#geomulti-tab-${mode}`).click(); await settle();
            await page.screenshot({ path: `${dir}/${mode}-${theme}-${width}.png` });
          }
        }
      }
    }
    check('Layout scuro/chiaro su 1440, 1024, 390, 320 e 844×390; drawer Arc e focus al ritorno sulla mappa');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await settle();
    const motion = await page.evaluate(() => {
      document.querySelector('#geomulti-tab-riepilogo').click();
      return document.querySelector('#geomulti-tabs').getAnimations({ subtree: true }).length + document.querySelector('#geomulti-summary-panel').getAnimations().length;
    });
    assert.equal(motion, 0);
    await page.locator('#geomulti-close').click(); await settle();
    assert(!await page.locator('#geomulti-canvas').isVisible());
    check('Movimento ridotto rispettato e chiusura completata');

    const volume = await page.evaluate(async () => {
      const f = geoFixture;
      const voci = Array.from({ length: 1600 }, (_, i) => ({ colonna: 'posizione', riga: i, valore: { type: 'Point', coordinates: [12.49 + (i % 40) / 1000, 41.89 + Math.floor(i / 40) / 1000] } }));
      voci.push({ colonna: 'proiettata', riga: 1600, valore: { type: 'Point', coordinates: [1200000, 4100000] } });
      const start = performance.now();
      await f.apri({ voci, titolo: 'Selezione estesa' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { ms: performance.now() - start, builds: f.costruzioni, rows: document.querySelectorAll('#geomulti-list button').length, warning: document.querySelector('#geomulti-warning').textContent };
    });
    report.volume = volume;
    assert.equal(volume.rows, 500);
    assert.match(volume.warning, /1500 geometrie su 1601/);
    assert.match(volume.warning, /PROIETTATE/);
    await page.locator('#geomulti-list button').first().click();
    assert.equal(await page.evaluate(() => geoFixture.costruzioni), volume.builds, 'Anche con 1500 geometrie la selezione non ridisegna');
    const largeDownload = page.waitForEvent('download');
    await page.locator('#geomulti-export').click();
    const large = JSON.parse(fs.readFileSync(await (await largeDownload).path(), 'utf8'));
    assert.equal(large.features.length, 1601);
    assert.deepEqual(large.features[1600].geometry.coordinates, [1200000, 4100000]);
    check(`1601 geometrie: disegno limitato e dichiarato, selezione senza ricostruzioni, esportazione completa (${Math.round(volume.ms)} ms apertura)`);

    await page.locator('#geomulti-close').click(); await settle();
    assert.deepEqual(report.errors, [], 'Nessun errore nella modale, nel drawer o nel test di volume');
    const legacy = await page.evaluate(async () => {
      const { creaVistaGeo } = await import('/js/geo-vista.js');
      const host = document.createElement('div');
      host.innerHTML = '<div id="geo-test-map" style="width:500px;height:300px"></div><div id="geo-test-list"></div>';
      document.body.append(host);
      const view = creaVistaGeo({ canvas: '#geo-test-map', elenco: '#geo-test-list' });
      await view.mostra(geoFixture.voci); view.aggiorna();
      const builds = geoFixture.costruzioni;
      host.querySelector('[data-i="1"]').click();
      const result = { rows: host.querySelectorAll('tr[data-i]').length, selected: view.stato().evidenziato, buildsBefore: builds, buildsAfter: geoFixture.costruzioni, exportCount: view.geojson().features.length };
      // Leaflet completa il disegno Canvas prima di rimuovere la mappa usa-e-getta.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      geoFixture.maps.at(-1).remove(); host.remove();
      return result;
    });
    assert.equal(legacy.rows, 6); assert.equal(legacy.selected, 1);
    assert.equal(legacy.buildsBefore, legacy.buildsAfter); assert.equal(legacy.exportCount, 6);
    await page.evaluate(() => geoFixture.apri({ voci: [{ valore: 'non geometrico' }], titolo: 'Vuoto' }));
    assert(!await page.locator('#geomulti-canvas').isVisible());
    assert.deepEqual(report.errors, []);
    check('Motore condiviso: elenco tabellare ancora funzionante, istanze indipendenti, selezione vuota gestita e nessun errore JavaScript');
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
