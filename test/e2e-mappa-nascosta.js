'use strict';
const { formattaOutputMutante } = require('./lab/output-mutanti.cjs');

// LAB010: Leaflet vero, senza tile o database. Le operazioni restano quelle
// pubbliche di geo-vista; il solo hook legge l'istanza Leaflet per l'oracolo.
// LAB_BROWSER_CHANNEL=msedge node test/e2e-mappa-nascosta.js [--sensitivity]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/lab-010/mappa-nascosta');
const sourcePath = path.resolve(__dirname, '../public/js/geo-vista.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const production = fs.readFileSync(sourcePath, 'utf8');
const report = { suite: 'mappa-nascosta', iniziato: new Date().toISOString(), sorgenti: {
  'public/js/geo-vista.js': hash(production), 'test/e2e-mappa-nascosta.js': hash(fs.readFileSync(__filename)),
}, risultati: [], sensibilita: [] };
let browser, server;
async function fixture(width, mutant) {
  const context = await browser.newContext({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(7000); page.labErrors = [];
  page.on('pageerror', error => page.labErrors.push(error.message));
  if (mutant) {
    if (mutant === 'viewport') {
      const needle = 'const richiesta = inquadraturaPendente;';
      assert.equal(production.split(needle).length - 1, 1, 'Il mutante deve trovare il resize osservato');
      const mutated = production.replace(needle, `// Mutante: ogni resize forza nuovamente l'inquadratura dei dati.
    if (window.labMutateResize) { window.labMutationHits++; inquadraturaPendente = 'tutto'; }
    ${needle}`);
      await page.route('**/js/geo-vista.js*', route => route.fulfill({ contentType: 'text/javascript', body: mutated }));
    } else if (mutant === 'pendente') {
      const needle = 'const richiesta = inquadraturaPendente;';
      assert.equal(production.split(needle).length - 1, 1, 'Il mutante deve trovare il consumo del fit pendente');
      const mutated = production.replace(needle, `${needle}
    if (window.labDropPending && richiesta !== null) { window.labMutationHits++; inquadraturaPendente = null; return; }`);
      await page.route('**/js/geo-vista.js*', route => route.fulfill({ contentType: 'text/javascript', body: mutated }));
    } else {
      const needle = 'aggiorna({ inquadra = true } = {}) {';
      assert.equal(production.split(needle).length - 1, 1, 'Il mutante deve trovare il metodo pubblico aggiorna');
      const mutated = production.replace(needle, `${needle}
      // Mutante nella sola risposta HTTP: ripristina il fitBounds nativo a 0×0.
      if (mappa && stato && (!canvas.clientWidth || !canvas.clientHeight)) {
        window.labMutationHits++;
        mappa.invalidateSize();
        const punti = stato.disegnate.flatMap(g => g.bbox ? [[g.bbox[1],g.bbox[0]],[g.bbox[3],g.bbox[2]]] : []);
        mappa.fitBounds(L.latLngBounds(punti), { padding:[30,30], animate:false });
      }`);
      await page.route('**/js/geo-vista.js*', route => route.fulfill({ contentType: 'text/javascript', body: mutated }));
    }
  }
  await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({
    visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true,
  })), require('../package.json').version);
  await page.goto(server.url); await page.waitForSelector('html[data-arc-ready="true"]');
  await page.evaluate(async () => {
    const { caricaLeaflet, impostaTile } = await import('/js/geo-leaflet.js');
    impostaTile(false); const L = await caricaLeaflet();
    window.labMaps = {}; window.labMutationHits = 0; window.labSelections = []; window.labMutateResize = false;
    L.Map.addInitHook(function () { if (this.getContainer().id.startsWith('lab-map-')) window.labMaps[this.getContainer().id] = this; });
    const root = document.createElement('section'); root.id = 'lab-map-fixture';
    root.style.cssText = 'position:fixed;inset:0;z-index:99999;background:white;overflow:auto;color:black;';
    root.innerHTML = '<div id="lab-map-owner" style="width:calc(100% - 20px);height:420px"><div id="lab-map-main" style="width:100%;height:100%"></div></div>'
      + '<div id="lab-map-list"></div><div id="lab-map-summary"></div><div id="lab-map-warning"></div>'
      + '<div id="lab-map-other" style="width:220px;height:140px"></div>';
    document.body.append(root);
    window.labEntries = Array.from({ length: 20 }, (_, i) => ({ valore: { type: 'Point', coordinates: [12.49 + i * .00001, 41.89 + i * .00001] }, colonna: 'posizione', riga: i }));
    window.labEntries.push({ valore: { type: 'Polygon', coordinates: [[[12.49002,41.89002],[12.49008,41.89002],[12.49008,41.89008],[12.49002,41.89002]]] }, colonna: 'area', riga: 20 });
    const { creaVistaGeo } = await import('/js/geo-vista.js');
    window.labView = creaVistaGeo({ canvas: '#lab-map-main', elenco: '#lab-map-list', riepilogo: '#lab-map-summary',
      avvisi: '#lab-map-warning', elencoCompatto: true, onSelezione: geometry => window.labSelections.push(geometry?.indice ?? null) });
    window.labOther = creaVistaGeo({ canvas: '#lab-map-other' });
    await window.labOther.mostra([{ valore: { type: 'Point', coordinates: [9.19,45.46] }, colonna: 'indipendente', riga: 0 }]);
    window.labOther.aggiorna();
    await window.labView.mostra(window.labEntries);
    window.labNativeRead = id => {
      const map = window.labMaps[id]; if (!map) return { exists: false };
      try {
        const container = map.getContainer(), center = map.getCenter(), bounds = map.getBounds(), size = map.getSize();
        const projected = map.latLngToContainerPoint(center); let geometries = 0, selectedPoints = 0;
        map.eachLayer(layer => { if (layer instanceof L.CircleMarker || layer instanceof L.Polygon) geometries++;
          if (layer instanceof L.CircleMarker && layer.getRadius() === 9) selectedPoints++; });
        const values = [map.getZoom(), center.lat, center.lng, bounds.getSouth(), bounds.getNorth(), bounds.getWest(), bounds.getEast(), size.x, size.y, projected.x, projected.y];
        return { exists: true, finite: values.every(Number.isFinite), zoom: String(map.getZoom()), center,
          projectedCenter: map.project(center, map.getZoom()),
          size: { x: size.x, y: size.y }, container: { width: container.clientWidth, height: container.clientHeight },
          geometries, selectedPoints, canvas: [...container.querySelectorAll('canvas')].map(node => ({ width: node.width, height: node.height })) };
      } catch (error) { return { exists: true, finite: false, error: error.message, zoom: String(map.getZoom()) }; }
    };
    window.labRead = () => ({ native: window.labNativeRead('lab-map-main'), other: window.labNativeRead('lab-map-other'),
      geojson: window.labView.geojson(), selected: window.labView.stato()?.evidenziato,
      selectedDom: [...document.querySelectorAll('#lab-map-list [aria-pressed="true"]')].map(node => Number(node.dataset.i)),
      entries: document.querySelectorAll('#lab-map-list [data-i]').length,
      summary: document.getElementById('lab-map-summary').textContent, selections: [...window.labSelections] });
    window.labExpectedFitZoom = () => {
      const map = window.labMaps['lab-map-main'], size = map.getSize();
      return map.getBoundsZoom(L.geoJSON(window.labView.geojson()).getBounds(), false,
        L.point(Math.min(60, size.x - 1), Math.min(60, size.y - 1)));
    };
  });
  return { page, context };
}
async function visible(page) {
  await page.waitForFunction(() => {
    const value = window.labNativeRead('lab-map-main');
    return value.exists && (!value.finite || (value.container.width > 0 && value.container.height > 0
      && value.size.x === value.container.width && value.size.y === value.container.height
      && value.canvas.length > 0 && value.canvas.every(canvas => canvas.width > 0 && canvas.height > 0)));
  });
  const native = await page.evaluate(() => window.labNativeRead('lab-map-main'));
  assert(native.finite, `[MAPPA-FINITA] ripresa visibile: ${JSON.stringify(native)}`);
}
function corretto(value, expected, label, { hidden = false } = {}) {
  assert(value.native.exists && value.native.finite, `[MAPPA-FINITA] ${label}: ${JSON.stringify(value.native)}`);
  assert.equal(value.native.geometries, 21, `[MAPPA-CONTENUTI] ${label}: 20 punti e un poligono`);
  assert.deepEqual(value.geojson, expected.geojson, `[MAPPA-CONTENUTI] ${label}: GeoJSON invariato`);
  assert.equal(value.entries, 21); assert.equal(value.summary, expected.summary);
  assert.equal(value.selected, expected.selected, `[MAPPA-SELEZIONE] ${label}: selezione conservata`);
  assert.deepEqual(value.selectedDom, expected.selectedDom); assert.equal(value.native.selectedPoints, expected.native.selectedPoints);
  assert.deepEqual(value.other, expected.other, `[MAPPA-INDIPENDENTE] ${label}: l’altra istanza resta invariata`);
  if (!hidden) {
    assert.equal(value.native.size.x, value.native.container.width); assert.equal(value.native.size.y, value.native.container.height);
    assert(value.native.canvas.every(canvas => canvas.width > 0 && canvas.height > 0));
  }
}
function viewportInvariato(value, expected, label) {
  assert.equal(value.native.zoom, expected.native.zoom, `[MAPPA-VIEWPORT] ${label}: zoom scelto conservato`);
  const dx = value.native.projectedCenter.x - expected.native.projectedCenter.x;
  const dy = value.native.projectedCenter.y - expected.native.projectedCenter.y;
  assert(Math.hypot(dx, dy) <= 1, `[MAPPA-VIEWPORT] ${label}: centro scelto conservato entro un pixel (${dx}, ${dy})`);
}
async function runCase(width, mode, mutant) {
  const item = { id: `${width}-${mode}`, width, mode, mutante: mutant, cicli: [], ok: false }; let current;
  try {
    current = await fixture(width, mutant); const { page } = current;
    if (mutant === 'pendente') await page.evaluate(() => { window.labDropPending = true; });
    const soloCss = mode === 'riapertura-solo-css', conservaViewport = mode === 'viewport-preservato';
    if (mode === 'inizialmente-nascosta' || soloCss) await page.evaluate(() => { document.getElementById('lab-map-owner').style.display = 'none'; });
    const errors = await page.evaluate(() => { try { window.labView.aggiorna(); return []; } catch (error) { return [error.message]; } });
    item.iniziale = await page.evaluate(() => window.labRead());
    if (mode === 'inizialmente-nascosta' || soloCss) {
      assert.equal(errors.length, 0, `[MAPPA-FINITA] la prima apertura nascosta non deve fallire: ${errors}`);
      assert(!item.iniziale.native.exists || item.iniziale.native.finite, `[MAPPA-FINITA] nessuna mappa corrotta prima della visibilità: ${JSON.stringify(item.iniziale.native)}`);
      await page.evaluate(soloCss => {
        document.getElementById('lab-map-owner').style.display = '';
        if (!soloCss) window.labView.aggiorna();
      }, soloCss);
    }
    await visible(page);
    if (soloCss) assert.equal(Number((await page.evaluate(() => window.labRead())).native.zoom), await page.evaluate(() => window.labExpectedFitZoom()),
      '[MAPPA-FIT-PENDENTE] prima visibilità solo CSS: inquadratura iniziale applicata');
    await page.locator('#lab-map-list [data-i="4"]').click();
    if (conservaViewport) await page.evaluate(() => {
      // Inquadratura scelta dall'utente, distinta dal fit automatico dei dati.
      window.labMaps['lab-map-main'].setView([41.8912, 12.4921], 17, { animate: false });
      window.labMutateResize = true;
    });
    const expected = await page.evaluate(() => window.labRead()); item.atteso = expected;
    assert.equal(expected.selected, 4); assert.equal(expected.native.selectedPoints, 1);
    corretto(expected, expected, 'sorgente');
    for (let cycle = 0; cycle < 4; cycle++) {
      const outcome = await page.evaluate(({ cycle, mode, conservaViewport }) => {
        const owner = document.getElementById('lab-map-owner'), errors = [];
        owner.style.display = 'none';
        owner.style.width = cycle === 0 ? '20px' : 'calc(100% - 20px)';
        owner.style.height = cycle === 0 ? '20px' : `${300 + cycle * 35}px`;
        const apply = fn => { try { fn(); } catch (error) { errors.push(error.message); } };
        apply(() => window.labView.invalidateSize());
        if (!conservaViewport) {
          if (mode === 'inquadra-nascosta') apply(() => window.labView.inquadraTutto());
          else apply(() => window.labView.aggiorna());
        }
        return { errors, hidden: window.labRead() };
      }, { cycle, mode, conservaViewport });
      item.cicli.push({ cycle, ...outcome });
      assert.equal(outcome.hidden.native.container?.width || 0, 0, '[MAPPA-PRECONDIZIONE] il contenitore deve essere davvero nascosto');
      assert.equal(outcome.errors.length, 0, `[MAPPA-FINITA] operazioni nascoste senza errori: ${outcome.errors}`);
      corretto(outcome.hidden, expected, `nascosta-${cycle}`, { hidden: true });
      await page.setViewportSize({ width: cycle % 2 ? width : Math.max(320, width - 70), height: 960 });
      await page.evaluate(({ soloCss, conservaViewport }) => {
        document.getElementById('lab-map-owner').style.display = '';
        if (!soloCss && !conservaViewport) window.labView.aggiorna({ inquadra: false });
      }, { soloCss, conservaViewport });
      await visible(page);
      const shown = await page.evaluate(() => window.labRead()); item.cicli.at(-1).shown = shown;
      corretto(shown, expected, `riaperta-${cycle}`);
      if (soloCss) assert.equal(Number(shown.native.zoom), await page.evaluate(() => window.labExpectedFitZoom()),
        `[MAPPA-FIT-PENDENTE] riapertura solo CSS-${cycle}: inquadratura rimandata applicata`);
      if (conservaViewport) viewportInvariato(shown, expected, `riaperta-${cycle}`);
      if (cycle === 0 && mode === 'inquadra-nascosta') {
        // Anche il margine dell'inquadratura di una singola area deve lasciare
        // spazio utile nel canvas 20×20, senza alterare geometria o selezione.
        await page.evaluate(() => document.querySelector('#lab-map-list [data-i="20"]').click());
        await visible(page);
        const piccola = await page.evaluate(() => window.labRead());
        assert.equal(piccola.selected, 20); assert(piccola.native.finite);
        assert.deepEqual(piccola.geojson, expected.geojson);
        item.poligonoPiccolo = piccola;
        await page.evaluate(() => document.querySelector('#lab-map-list [data-i="4"]').click());
        await visible(page);
      }
      const primaResize = await page.evaluate(() => window.labRead());
      await page.evaluate(cycle => { document.getElementById('lab-map-owner').style.height = `${450 - cycle * 20}px`; }, cycle);
      await visible(page);
      const resized = await page.evaluate(() => window.labRead()); item.cicli.at(-1).resized = resized;
      corretto(resized, expected, `ridimensionata-${cycle}`);
      viewportInvariato(resized, primaResize, `ridimensionata-${cycle}`);
    }
    if (soloCss) {
      // Lascia consegnare le misure precedenti: il cambio nascosto/visibile
      // seguente avviene interamente nello stesso task, a dimensioni finali uguali.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      // L'ultima intenzione è la geometria zero: non va confusa con null o
      // sovrascritta dalla precedente richiesta di inquadrare tutto.
      const selezionataNascosta = await page.evaluate(() => {
        document.getElementById('lab-map-owner').style.display = 'none';
        window.labView.inquadraTutto();
        document.querySelector('#lab-map-list [data-i="0"]').click();
        window.labView.aggiorna({ inquadra: false });
        const hidden = window.labRead();
        document.getElementById('lab-map-owner').style.display = '';
        return hidden;
      });
      assert.equal(selezionataNascosta.selected, 0);
      assert.equal(selezionataNascosta.native.container.width, 0);
      await visible(page);
      await page.waitForFunction(() => {
        const map = window.labMaps['lab-map-main'], [lng, lat] = window.labEntries[0].valore.coordinates;
        return map.project(map.getCenter(), map.getZoom()).distanceTo(map.project([lat, lng], map.getZoom())) <= 1;
      }, null, { timeout: 2000 }).catch(error => {
        throw new Error(`[MAPPA-FIT-PENDENTE] hide/show nello stesso task: ultima geometria non centrata entro due secondi; ${error.message}`);
      });
      const selezionataVisibile = await page.evaluate(() => window.labRead());
      corretto(selezionataVisibile, selezionataNascosta, 'ultima-richiesta-geometria-zero');
      const distanza = await page.evaluate(() => {
        const map = window.labMaps['lab-map-main'], [lng, lat] = window.labEntries[0].valore.coordinates;
        return map.project(map.getCenter(), map.getZoom()).distanceTo(map.project([lat, lng], map.getZoom()));
      });
      assert(distanza <= 1, `[MAPPA-FIT-PENDENTE] ultima geometria selezionata centrata (${distanza} px)`);
      item.ultimaRichiesta = { stato: selezionataVisibile, distanza };
      item.resetPendente = [];
      for (const azzera of ['pulisci', 'nuovi-dati']) {
        const prima = await page.evaluate(() => {
          window.labMaps['lab-map-main'].setView([40, 10], 9, { animate: false });
          return window.labRead();
        });
        await page.evaluate(async azzera => {
          document.getElementById('lab-map-owner').style.display = 'none';
          window.labView.inquadraTutto();
          if (azzera === 'pulisci') {
            window.labView.pulisci();
            window.labView.aggiorna({ inquadra: false });
          } else {
            await window.labView.mostra(window.labEntries);
            window.labView.aggiorna({ inquadra: false });
          }
          document.getElementById('lab-map-owner').style.display = '';
        }, azzera);
        await visible(page);
        const dopo = await page.evaluate(() => window.labRead());
        viewportInvariato(dopo, prima, `richiesta-cancellata-${azzera}`);
        if (azzera === 'pulisci') {
          assert.equal(dopo.geojson, null); assert.equal(dopo.native.geometries, 0); assert.equal(dopo.entries, 0);
          // Prepara il successivo cambio dati senza introdurre un nuovo fit.
          await page.evaluate(async () => { await window.labView.mostra(window.labEntries); window.labView.aggiorna({ inquadra: false }); });
        } else {
          assert.deepEqual(dopo.geojson, expected.geojson); assert.equal(dopo.native.geometries, 21);
          assert.equal(dopo.selected, null); assert.deepEqual(dopo.selectedDom, []);
        }
        item.resetPendente.push({ azzera, prima, dopo });
      }
    }
    assert.deepEqual(current.page.labErrors, [], '[MAPPA-RUNTIME] nessun errore runtime durante apertura/chiusura'); item.ok = true;
  } catch (error) {
    item.errore = error.stack;
    await current?.page.screenshot({ path: path.join(reportDir, `${mutant ? 'mutante' : 'controllo'}-${item.id}.png`), fullPage: true }).catch(() => {});
  } finally {
    item.erroriPagina = current?.page.labErrors || [];
    item.mutazioni = current ? await current.page.evaluate(() => window.labMutationHits).catch(() => 0) : 0;
    await current?.context.close();
  }
  console.log(formattaOutputMutante(mutant ? (mutant === true ? 'fit' : mutant) : null,
    `${item.ok ? 'OK' : 'FAIL'} ${mutant ? 'mutante' : 'controllo'}/${item.id}${item.ok ? '' : ': ' + item.errore.split('\n')[0]}`));
  return item;
}
(async () => {
  fs.mkdirSync(reportDir, { recursive: true });
  const save = () => fs.writeFileSync(path.join(reportDir, 'mappa-nascosta.json'), JSON.stringify(report, null, 2));
  try {
    server = await startTestServer({ port: Number(process.env.LAB_MAP_HIDDEN_PORT || 39370) });
    browser = await chromium.launch(process.env.LAB_BROWSER_CHANNEL ? { channel: process.env.LAB_BROWSER_CHANNEL } : {});
    for (const width of [1440, 390]) for (const mode of ['aggiorna-nascosta', 'inquadra-nascosta', 'inizialmente-nascosta', 'riapertura-solo-css', 'viewport-preservato']) {
      report.risultati.push(await runCase(width, mode, false)); save();
    }
    if (process.argv.includes('--sensitivity')) for (const width of [1440, 390]) {
      const result = await runCase(width, 'aggiorna-nascosta', true);
      const controlloFit = report.risultati.find(item => item.width === width && item.mode === 'aggiorna-nascosta').ok;
      report.sensibilita.push({ risultato: result, controlloVerde: controlloFit,
        rilevata: controlloFit && !result.ok && result.mutazioni > 0 && result.errore.includes('[MAPPA-FINITA]') }); save();
      const viewport = await runCase(width, 'viewport-preservato', 'viewport');
      const controlloViewport = report.risultati.find(item => item.width === width && item.mode === 'viewport-preservato').ok;
      report.sensibilita.push({ risultato: viewport, controlloVerde: controlloViewport,
        rilevata: controlloViewport && !viewport.ok && viewport.mutazioni > 0 && viewport.errore.includes('[MAPPA-VIEWPORT]') }); save();
      const pending = await runCase(width, 'riapertura-solo-css', 'pendente');
      const controlloPending = report.risultati.find(item => item.width === width && item.mode === 'riapertura-solo-css').ok;
      report.sensibilita.push({ risultato: pending, controlloVerde: controlloPending,
        rilevata: controlloPending && !pending.ok && pending.mutazioni > 0 && pending.errore.includes('[MAPPA-FIT-PENDENTE]') }); save();
    }
    report.ok = report.risultati.length === 10 && report.risultati.every(item => item.ok) && report.sensibilita.every(item => item.rilevata);
  } catch (error) { report.erroreFatale = error.stack; report.ok = false; console.error(error.stack); }
  finally {
    await browser?.close(); await server?.stop();
    report.fontiIntatte = hash(fs.readFileSync(sourcePath)) === report.sorgenti['public/js/geo-vista.js'];
    report.ok &&= report.fontiIntatte; report.terminato = new Date().toISOString(); save(); if (!report.ok) process.exitCode = 1;
  }
})();
