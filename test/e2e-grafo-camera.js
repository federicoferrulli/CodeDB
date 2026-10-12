'use strict';

// Camera e controlli Three.js reali, schema locale: nessun database necessario.
// Uso: node test/e2e-grafo-camera.js [--mutant]
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: Number(process.env.E2E_GRAFO_CAMERA_PORT) || 3237 });
  let browser;
  try {
    browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errori = [];
    page.on('pageerror', err => errori.push(err.message));
    if (process.argv.includes('--mutant')) {
      await page.route('**/js/graph3d.js', async route => {
        const response = await route.fetch();
        const originale = await response.text();
        const mutato = originale.replace(
          'const direzione = { x: camera.x - bersaglio.x, y: camera.y - bersaglio.y, z: camera.z - bersaglio.z };',
          'const direzione = { ...bersaglio };',
        );
        assert.notEqual(mutato, originale, 'Il mutante deve ripristinare la direzione errata dall’origine');
        await route.fulfill({ response, body: mutato });
      });
    }
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const originale = window.ForceGraph3D;
      window.ForceGraph3D = (...args) => (...mount) => {
        window.__grafo = originale(...args)(...mount);
        return window.__grafo;
      };
      document.getElementById('onboarding-overlay')?.remove();
      document.getElementById('welcome').classList.add('hidden');
      document.getElementById('tab-body').classList.remove('hidden');
      document.getElementById('workspace').classList.remove('hidden');
      for (const v of document.querySelectorAll('#workspace .view-panel')) v.classList.add('hidden');
      document.getElementById('view-graph3d').classList.remove('hidden');
      const { state } = await import('/js/state.js');
      state.dbSchema = { collections: [{ name: 'Prova', fields: [{ name: 'id' }] }], relations: [] };
      const { renderGraph3d } = await import('/js/graph3d.js');
      renderGraph3d();
      window.__grafo.cooldownTicks(0);
      window.__attendi = ms => new Promise(resolve => setTimeout(resolve, ms));
      window.__nodo = (g, indice, p) => {
        const n = g.graphData().nodes[indice];
        Object.assign(n, p, { fx: p.x, fy: p.y, fz: p.z });
        return n;
      };
    });
    // Esaurisce l'inquadratura iniziale prima del clic da riprodurre.
    await page.waitForTimeout(900);
    const misure = await page.evaluate(async () => {
      const g = window.__grafo;
      const nodo = g.graphData().nodes[0];
      const risultati = [];
      for (const z of [0, 0.01, -80, 80]) {
        Object.assign(nodo, { x: 0, y: 0, z, fx: 0, fy: 0, fz: z });
        g.cameraPosition({ x: 0, y: 0, z: 300 }, { x: 0, y: 0, z }, 0);
        g.onNodeClick()(nodo);
        const fine = performance.now() + 1400;
        let minima = Infinity;
        while (performance.now() < fine) {
          await new Promise(requestAnimationFrame);
          minima = Math.min(minima, g.camera().position.distanceTo(nodo));
        }
        const p = g.camera().position;
        risultati.push({ z, camera: p.toArray(), minima, distanza: Math.hypot(p.x, p.y, p.z - z), stessoLato: p.z > z });
      }
      let inquadrature = 0;
      const fit = g.zoomToFit;
      g.zoomToFit = (...args) => { inquadrature++; return fit(...args); };
      g.onEngineStop()();
      g.zoomToFit = fit;
      return { risultati, inquadratureDopoClic: inquadrature };
    });
    console.log('Camera dopo il clic:', JSON.stringify(misure));
    assert(misure.risultati.every(m => m.minima >= 100 && m.distanza >= 100 && m.stessoLato),
      'Il clic deve mantenere una distanza leggibile senza attraversare il nodo durante il tragitto');
    assert.equal(misure.inquadratureDopoClic, 0, 'La fine della simulazione non deve sostituire la selezione dell’utente');
    console.log('OK: origine, vicinanza al centro e lati opposti; nessun secondo adattamento automatico');

    const interazioni = await page.evaluate(async () => {
      const { state } = await import('/js/state.js');
      const { renderGraph3d } = await import('/js/graph3d.js');
      state.dbSchema.collections.push({ name: 'Collegata', fields: [{ name: 'prova_id' }] });
      state.dbSchema.relations = [{ from: 'Prova', to: 'Collegata', field: 'prova_id' }];
      renderGraph3d();
      const g = window.__grafo;
      g.cooldownTime(Infinity).cooldownTicks(Infinity).d3AlphaMin(0);
      const a = window.__nodo(g, 0, { x: 0, y: 0, z: 0 });
      const b = window.__nodo(g, 1, { x: -60, y: 40, z: -80 });
      await window.__attendi(80);
      g.cameraPosition({ x: 0, y: 0, z: 300 }, a, 0);
      let fit = 0;
      const originaleFit = g.zoomToFit;
      g.zoomToFit = (...args) => { fit++; return originaleFit(...args); };
      g.onNodeClick()(a);
      // È il PRIMO arresto: anche se il layout si ferma dopo il clic, la scelta resta.
      g.onEngineStop()();
      g.zoomToFit = originaleFit;
      await window.__attendi(160);
      const partenza = g.camera().position.clone();
      document.querySelector('[data-jump-node="Collegata"]').click();
      const attesa = partenza.clone().sub(b).normalize().multiplyScalar(120).add(b);
      await window.__attendi(1400);
      const salto = g.camera().position.distanceTo(attesa);
      const bersaglio = g.controls().target.distanceTo(b);
      const input = document.getElementById('graph3d-search');
      input.value = 'Prova';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await window.__attendi(1400);
      const ricerca = g.camera().position.distanceTo(a);

      // Il gesto manuale deve interrompere subito il movimento automatico.
      g.cameraPosition({ x: 0, y: 0, z: 300 }, a, 0);
      g.onNodeClick()(a);
      await window.__attendi(160);
      g.controls().dispatchEvent({ type: 'start' });
      const manuale = { x: 30, y: 20, z: 260 };
      g.cameraPosition(manuale, a, 0);
      await window.__attendi(1400);
      const interrotto = g.camera().position.distanceTo(manuale);

      // Stessa posizione di camera e nodo: la normalizzazione non deve produrre NaN.
      g.cameraPosition(a, a, 0);
      g.onNodeClick()(a);
      await window.__attendi(1400);
      return { fit, salto, bersaglio, ricerca, interrotto, coincidente: g.camera().position.distanceTo(a) };
    });
    assert.equal(interazioni.fit, 0, 'Il primo arresto dopo un clic deve rispettare il focus');
    assert(interazioni.salto < 0.01 && interazioni.bersaglio < 0.01, 'Il collegamento deve sostituire un clic ancora animato');
    assert(Math.abs(interazioni.ricerca - 100) < 0.01, 'La ricerca deve usare la stessa distanza sicura');
    assert(interazioni.interrotto < 0.01, 'Il gesto manuale deve prevalere sull’animazione');
    assert(Math.abs(interazioni.coincidente - 120) < 0.01, 'La camera coincidente deve avere una direzione di ripiego finita');
    console.log('OK: clic ravvicinati, collegamento, ricerca, interruzione manuale e camera coincidente');

    await page.click('#graph3d-toggle-2d');
    const piano = await page.evaluate(async () => {
      const g = window.__grafo;
      g.cooldownTicks(0);
      await window.__attendi(800);
      const a = window.__nodo(g, 0, { x: 50, y: -30, z: 0 });
      const b = window.__nodo(g, 1, { x: -80, y: 40, z: 0 });
      const misure = [];
      for (const azione of ['clic', 'collegamento', 'ricerca']) {
        if (azione === 'clic') g.onNodeClick()(a);
        if (azione === 'collegamento') document.querySelector('[data-jump-node="Collegata"]').click();
        if (azione === 'ricerca') {
          const input = document.getElementById('graph3d-search');
          input.value = 'Prova';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await window.__attendi(1400);
        const nodo = azione === 'collegamento' ? b : a;
        const p = g.camera().position;
        misure.push({ azione, errore: Math.hypot(p.x - nodo.x, p.y - nodo.y, p.z - 300) });
      }
      return misure;
    });
    assert(piano.every(m => m.errore < 0.01), `Il focus 2D deve restare perpendicolare al piano: ${JSON.stringify(piano)}`);
    console.log('OK: clic, collegamenti e ricerca allineati al nodo anche in 2D');

    await page.click('#graph3d-toggle-2d');
    await page.evaluate(() => window.__grafo.cooldownTicks(0));
    await page.waitForTimeout(900);
    // Un clic fisico sul canvas verifica anche il collegamento con il raycaster.
    const punto = await page.evaluate(async () => {
      const g = window.__grafo;
      const a = window.__nodo(g, 0, { x: 0, y: 0, z: 0 });
      window.__nodo(g, 1, { x: -80, y: 40, z: 0 });
      document.getElementById('graph3d-panel-close').click();
      g.cameraPosition({ x: 0, y: 0, z: 300 }, a, 0);
      await window.__attendi(100);
      const r = g.renderer().domElement.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(punto.x, punto.y);
    await page.waitForTimeout(1400);
    const clicReale = await page.evaluate(() => ({
      nome: document.getElementById('graph3d-panel-title').textContent,
      aperto: document.querySelector('.graph3d-container').classList.contains('pannello-aperto'),
      distanza: window.__grafo.camera().position.length(),
    }));
    assert(clicReale.aperto && clicReale.nome === 'Prova' && Math.abs(clicReale.distanza - 120) < 0.01,
      `Il clic fisico deve selezionare e inquadrare il nodo: ${JSON.stringify(clicReale)}`);
    console.log('OK: clic fisico sul nodo con raycaster e renderer WebGL reali');

    await page.evaluate(() => {
      const g = window.__grafo;
      const a = g.graphData().nodes[0];
      g.cameraPosition({ x: 0, y: 0, z: 300 }, a, 0);
      g.onNodeClick()(a);
    });
    await page.waitForTimeout(160);
    await page.mouse.move(punto.x, punto.y);
    await page.mouse.wheel(0, 150);
    await page.waitForTimeout(100);
    const dopoRotella = await page.evaluate(() => window.__grafo.camera().position.toArray());
    await page.waitForTimeout(1400);
    const fineRotella = await page.evaluate(() => window.__grafo.camera().position.toArray());
    assert(Math.hypot(...fineRotella.map((v, i) => v - dopoRotella[i])) < 0.01,
      'La rotellina reale deve annullare il movimento del clic');
    console.log('OK: la rotellina reale interrompe l’animazione senza movimenti successivi');

    await page.click('#graph3d-auto-rotate');
    const rotazione = await page.evaluate(async () => {
      const g = window.__grafo;
      g.onNodeClick()(g.graphData().nodes[0]);
      const durante = g.controls().autoRotate;
      await window.__attendi(1400);
      return { durante, dopo: g.controls().autoRotate };
    });
    assert.equal(rotazione.durante, false, 'La rotazione automatica non deve spostare la camera durante il focus');
    assert.equal(rotazione.dopo, true, 'La preferenza di rotazione deve riprendere alla fine del focus');
    await page.click('#graph3d-auto-rotate');
    console.log('OK: la rotazione automatica riprende dopo il focus');

    // Reinquadrare ricrea il grafo: i suoi oggetti non esistono ancora al momento del clic.
    await page.click('#graph3d-reset-cam');
    const reset = await page.evaluate(async () => {
      const g = window.__grafo;
      g.cooldownTicks(2);
      window.__nodo(g, 0, { x: 250, y: 50, z: 0 });
      window.__nodo(g, 1, { x: -250, y: -50, z: 0 });
      await window.__attendi(1600);
      const prima = g.camera().position.clone();
      g.zoomToFit(0, 60);
      return { scarto: prima.distanceTo(g.camera().position), distanza: prima.length() };
    });
    assert(reset.distanza > 300 && reset.scarto < 0.01,
      `Reinquadrare deve includere tutto il nuovo grafo dopo la disposizione: ${JSON.stringify(reset)}`);
    console.log('OK: reinquadratura completa dopo la creazione della scena');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const ridotta = await page.evaluate(() => {
      const g = window.__grafo;
      const a = g.graphData().nodes[0];
      g.cameraPosition({ x: 0, y: 0, z: 500 }, a, 0);
      g.onNodeClick()(a);
      return g.camera().position.distanceTo(a);
    });
    assert(Math.abs(ridotta - 120) < 0.01, 'Con movimento ridotto il focus deve essere immediato');
    assert.deepEqual(errori, [], 'Nessun errore JavaScript durante la navigazione');
    console.log('OK: movimento ridotto e nessun errore JavaScript');
  } finally {
    await browser?.close();
    await server.stop();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
