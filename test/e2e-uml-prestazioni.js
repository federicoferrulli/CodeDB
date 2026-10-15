'use strict';

// Chromium e JointJS reali; lo schema simulato isola il costo del diagramma dal DB.
// E2E_UML_TABELLE=1000 estende la prova; UML_LOAD_MUTATION=sincrono o piatti deve fallire.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

const TABELLE = Number(process.env.E2E_UML_TABELLE) || 400;
function schemaGrande(n) {
  return {
    collections: Array.from({ length: n }, (_, i) => ({
      name: `tab_${i}`, fields: Array.from({ length: 12 }, (_, j) => ({ name: `c${j}`, types: ['int'] })),
    })),
    relations: Array.from({ length: n * 2 }, (_, i) => ({
      from: `tab_${i % n}`, to: `tab_${(i * 7 + 13) % n}`,
      field: i % 2 ? 'c1' : 'c0', toField: 'c0', constraint: `fk_${i}`, origine: 'vincolo',
    })),
    schemaPage: { complete: true },
  };
}

(async () => {
  const server = await startTestServer({ port: Number(process.env.E2E_UML_PERF_PORT) || 3153 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errori = [];
    page.on('pageerror', e => errori.push(e.message));
    if (process.env.UML_LOAD_MUTATION) {
      await page.route('**/js/uml-paper.js', async route => {
        const response = await route.fetch();
        const source = await response.text();
        assert(source.includes('const LOTTO_VISTE = 4;'));
        const body = process.env.UML_LOAD_MUTATION === 'piatti'
          ? source.replace('|| !!this._areaVisibile.intersect(vista.model.getBBox())',
            '|| (vista.model.getBBox().height > 0 && !!this._areaVisibile.intersect(vista.model.getBBox()))')
          : source.replace('const LOTTO_VISTE = 4;', 'const LOTTO_VISTE = Infinity;')
            .replace('await cedi();', 'await Promise.resolve();');
        await route.fulfill({ response, body });
      });
    }
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#uml-canvas', { state: 'attached' });
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async schema => {
      const { impostaSocket } = await import('/js/socket.js');
      const { createTab, tabs } = await import('/js/tabs.js');
      const { caricaJoint, Tavola } = await import('/js/uml-paper.js');
      await caricaJoint();
      impostaSocket({ emit(evento, msg, cb) {
        cb?.(evento === 'db:schema' ? { ok: true, ...schema } : { ok: true, fields: [], indexes: [] });
      }, on() {}, off() {} });
      document.getElementById('onboarding-overlay')?.remove();
      const tab = createTab({ id: 'uml-prestazioni', connName: null });
      window.__tabUml = tab;
      Object.assign(tab.state, { connected: true, db: 'grande', coll: null, connId: 'prova', view: 'uml',
        dbSchema: schema, dbSchemaFor: 'grande' });
      tabs.activeId = tab.id;
      for (const id of ['tab-body', 'workspace', 'view-uml']) document.getElementById(id).classList.remove('hidden');
      document.getElementById('welcome').classList.add('hidden');
      for (const el of document.querySelectorAll('#workspace .view-panel:not(#view-uml)')) el.classList.add('hidden');
      window.__uml = await import('/js/uml.js');
      window.__misure = { metodi: {}, blocchi: [], battiti: 0, inizio: performance.now() };
      for (const nome of ['monta', 'montaMinimappa', 'applicaDettaglio']) {
        const originale = Tavola.prototype[nome];
        Tavola.prototype[nome] = function (...args) {
          const t = performance.now();
          const risultato = originale.apply(this, args);
          window.__misure.metodi[nome] = performance.now() - t;
          if (nome === 'monta' && window.__dopoAvvio) window.__dopoAvvio(this);
          return risultato;
        };
      }
      window.__osservatore = new PerformanceObserver(lista => {
        window.__misure.blocchi.push(...lista.getEntries().map(e => Math.round(e.duration)));
      });
      window.__osservatore.observe({ type: 'longtask' });
      window.__battito = setInterval(() => window.__misure.battiti++, 16);
      window.__uml.loadUml(false);
    }, schemaGrande(TABELLE));
    await page.waitForFunction(n => {
      const t = window.__uml.statoUml().tavola;
      return t && t.graph.getElements().length === n
        && t.graph.getLinks().length === n * 2
        && !t.paper.hasScheduledUpdates() && !t._miniFrame
        && document.getElementById('uml-canvas').getAttribute('aria-busy') === 'false';
    }, TABELLE, { timeout: 120000 });
    await page.waitForTimeout(350);
    const misure = await page.evaluate(() => {
      clearInterval(window.__battito);
      window.__osservatore.disconnect();
      return { ...window.__misure, durata: Math.round(performance.now() - window.__misure.inizio) };
    });
    console.log(`${TABELLE} tabelle / ${TABELLE * 2} relazioni: ${JSON.stringify({
      durata: misure.durata, bloccoMassimo: Math.max(0, ...misure.blocchi),
      battiti: misure.battiti, metodi: misure.metodi,
    })}`);
    assert.equal(await page.locator('#uml-catalogo-lista [data-chiave]').count(), TABELLE);
    assert.deepEqual(errori, [], 'nessun errore di pagina');
    assert.ok(Math.max(0, ...misure.blocchi) < 200,
      `caricamento non bloccante: lavoro più lungo ${Math.max(...misure.blocchi)} ms (budget 200 ms)`);
    console.log('OK: schema completo e caricamento senza blocchi prolungati.');

    const geometria = await page.evaluate(() => {
      const t = window.__uml.statoUml().tavola;
      const visibili = t.graph.getLinks().filter(link => t.paper.findViewByModel(link)?.el.isConnected).slice(0, 30);
      return visibili.length > 0 && visibili.every(link => {
        const vista = t.paper.findViewByModel(link);
        const da = link.getSourceCell().getPortCenter(link.source().port);
        const a = link.getTargetCell().getPortCenter(link.target().port);
        return da.distance(vista.sourcePoint) < 1 && a.distance(vista.targetPoint) < 1;
      });
    });
    assert(geometria, 'le frecce rimangono ancorate alle colonne corrette');
    assert(await page.evaluate(() => {
      const t = window.__uml.statoUml().tavola;
      const { x, y, w, h } = t.vistaCorrente();
      const dentro = p => p.x > x && p.x < x + w && p.y > y && p.y < y + h;
      const orizzontali = t.graph.getLinks().filter(link => {
        const da = link.getSourcePoint(), a = link.getTargetPoint();
        return da.y === a.y && dentro(da) && dentro(a);
      });
      return orizzontali.length > 0 && orizzontali.every(link => t.paper.findViewByModel(link)?.el.isConnected);
    }), 'gli archi orizzontali nell’area visibile non spariscono');
    assert(await page.locator('#uml-canvas .joint-element').count() < TABELLE,
      'il DOM non disegna inutilmente tutte le tabelle fuori schermo');
    await page.locator('#uml-cerca').fill(`tab_${TABELLE - 1}`);
    await page.locator('#uml-catalogo-lista [data-chiave]').first().click();
    await page.waitForFunction(nome => [...document.querySelectorAll('#uml-canvas .joint-element')]
      .some(el => el.textContent.includes(nome)), `tab_${TABELLE - 1}`);
    await page.locator('#uml-cerca').fill('');
    await page.locator('#uml-adatta').click();
    const svg = await page.evaluate(() => window.__uml.statoUml().tavola.esportaSvg());
    assert.equal((svg.match(/class="[^"]*joint-element\b/g) || []).length, TABELLE, 'export completo');
    assert(svg.includes('c11') && !svg.includes('display="none"'), 'export con campi anche dalla sagoma');
    const prima = await page.evaluate(() => window.__uml.statoUml().tavola.paper.translate());
    await page.locator('#uml-minimap').click({ position: { x: 10, y: 10 } });
    const dopo = await page.evaluate(() => window.__uml.statoUml().tavola.paper.translate());
    assert.notDeepEqual(dopo, prima, 'la minimappa continua a navigare il diagramma');

    await page.evaluate(() => {
      window.__dopoAvvio = tavola => {
        window.__dopoAvvio = null;
        window.__vecchia = tavola;
        setTimeout(() => {
          window.__annullataDurante = tavola._costruzione;
          Object.assign(window.__tabUml.state, { db: 'piccolo', dbSchemaFor: 'piccolo', dbSchema: {
            collections: [{ name: 'unica', fields: [{ name: 'id', types: ['int'] }] }],
            relations: [], schemaPage: { complete: true },
          } });
          window.__uml.loadUml(false);
        }, 0);
      };
      window.__uml.loadUml(true);
    });
    await page.waitForFunction(() => window.__uml.statoUml().contesto?.db === 'piccolo'
      && document.querySelectorAll('#uml-canvas .joint-element').length === 1
      && document.getElementById('uml-canvas').getAttribute('aria-busy') === 'false');
    assert(await page.evaluate(() => window.__annullataDurante && window.__vecchia.smontato),
      'cambiare database interrompe la preparazione in corso');
    assert.equal(await page.locator('#uml-canvas .joint-link').count(), 0, 'nessun arco del vecchio database');

    await page.evaluate(() => {
      window.__dopoAvvio = () => {
        window.__dopoAvvio = null;
        setTimeout(() => document.getElementById('view-uml').classList.add('hidden'), 0);
      };
      window.__uml.loadUml(true);
    });
    await page.waitForFunction(() => !window.__uml.statoUml().tavola && !window.__uml.statoUml().caricamento);
    await page.evaluate(() => {
      document.getElementById('view-uml').classList.remove('hidden');
      window.__uml.loadUml(false);
    });
    await page.waitForFunction(() => window.__uml.statoUml().tavola
      && document.getElementById('uml-canvas').getAttribute('aria-busy') === 'false');
    await page.evaluate(async () => {
      window.__dopoAvvio = () => {
        window.__dopoAvvio = null;
        setTimeout(() => document.dispatchEvent(new CustomEvent('codedb:tema')), 0);
      };
      await window.__uml.loadUml(true);
      await window.__uml.statoUml().tavola.pronta;
    });
    assert.equal(await page.locator('#uml-canvas').getAttribute('aria-busy'), 'false',
      'cambiare tema durante la preparazione non lascia il caricamento appeso');
    assert.deepEqual(errori, [], 'nessun errore dopo interruzione e riapertura');
    console.log('OK: porte, export, minimappa, cambio database, uscita e tema durante il caricamento.');
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
