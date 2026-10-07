'use strict';
const { scegliArc } = require('./arc-controls');

// Browser reale, schema simulato: paginazione completa, contesti, campioni e archivio in sola lettura.

const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

let falliti = 0;
const ok = (cond, etichetta, dettaglio = '') => {
  if (cond) console.log(`  \x1b[32m✔ OK\x1b[0m   ${etichetta}`);
  else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${etichetta}${dettaglio ? `\n         ${dettaglio}` : ''}`);
    falliti++;
  }
};

/* Costruisce 250 tabelle con 300 relazioni in pagina (il socket è finto). */
function schemaGrande() {
  const nomi = Array.from({ length: 250 }, (_, i) => `tabella_${String(i).padStart(3, '0')}`);
  return {
    collections: nomi.map((name) => ({
      name,
      rowsApprox: 10,
      fields: Array.from({ length: 5 }, (_, j) => ({ name: `c${j}`, types: ['int'] })),
    })),
    relations: Array.from({ length: 300 }, (_, i) => ({
      from: nomi[i % 250],
      field: `f${i}`,
      to: nomi[(i + 1) % 250],
      toField: 'id',
      constraint: `fk_${i}`,
      ordine: 1,
      origine: 'vincolo',
    })),
  };
}

/* Paginatore stupido: affetta per cursore. La fusione è del client vero. */
const PAGER = `{
  consumati: {},
  pagina(full, msg) {
    // Il budget chiesto è un MASSIMO: qui si impongono pagine piccole per
    // esercitare davvero il giro dei cursori.
    const taglia = (v, d, tetto) => Math.min(Number.isSafeInteger(v) && v > 0 ? v : d, tetto);
    const coll = taglia(msg.collectionLimit, 80, 80);
    const camp = taglia(msg.fieldLimit, 2, 2);
    const rel = taglia(msg.relationLimit, 100, 100);
    const daC = Number.isSafeInteger(msg.cursor) && msg.cursor > 0 ? msg.cursor : 0;
    const daR = Number.isSafeInteger(msg.relationCursor) && msg.relationCursor > 0 ? msg.relationCursor : 0;
    const fc = (msg.fieldCursors && typeof msg.fieldCursors === 'object') ? msg.fieldCursors : {};
    const fetta = full.collections.slice(daC, daC + coll).map((c) => {
      const off = Math.min(Number.isSafeInteger(fc[c.name]) && fc[c.name] > 0 ? fc[c.name] : 0, c.fields.length);
      const campi = c.fields.slice(off, off + camp);
      const fine = off + campi.length >= c.fields.length;
      this.consumati[c.name] = Math.max(this.consumati[c.name] || 0, off + campi.length);
      return { ...c, fields: campi, fieldsPage: { total: c.fields.length, cursor: off, nextCursor: fine ? null : off + campi.length, omitted: 0, complete: fine } };
    });
    const relazioni = full.relations.slice(daR, daR + rel);
    const fineC = daC + fetta.length >= full.collections.length;
    const fineR = daR + relazioni.length >= full.relations.length;
    const pendenti = full.collections.some((c) => (this.consumati[c.name] || 0) < c.fields.length);
    const avanzoC = fineC ? null : daC + fetta.length;
    const avanzoR = fineR ? null : daR + relazioni.length;
    return {
      collections: fetta,
      relations: relazioni,
      schemaPage: {
        complete: fineC && fineR && !pendenti,
        cursor: daC, nextCursor: avanzoC, budget: { collections: coll, fields: camp, relations: rel },
        revisione: 'fissa', revisioneCambiata: false, scadenza: null, campionamento: null,
        cursori: {
          collezioni: avanzoC, relazioni: avanzoR,
          campi: Object.fromEntries(fetta.filter((c) => c.fieldsPage.nextCursor != null).map((c) => [c.name, c.fieldsPage.nextCursor])),
        },
        fine: { collezioni: fineC, relazioni: fineR, campi: !pendenti },
        totals: { collections: full.collections.length, fields: full.collections.length * 5, relations: full.relations.length },
        omitted: { collections: 0, fields: 0, relations: 0 },
      },
    };
  }
}`;

async function apriUml(page, server, { db, schema, rispondi, pagine, guastaStorage }) {
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#uml-canvas', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(500);
  await page.evaluate(async ({ dbName, schemaJson, pagerSrc, modo, usaPager, guasta }) => {
    if (guasta) {
      // IndexedDB rotto PRIMA di qualunque apertura, al livello del
      // prototipo (l'istanza `window.indexedDB` è un getter senza setter:
      // riassegnarla fallisce in silenzio). `apri()` riceve il rifiuto e la
      // vista deve dichiararlo senza andare in crash.
      IDBFactory.prototype.open = function aprituraGuasta() {
        throw new DOMException('Spazio di archiviazione esaurito (simulato).', 'QuotaExceededError');
      };
    }
    const { impostaSocket } = await import('/js/socket.js');
    const { createTab, tabs } = await import('/js/tabs.js');
    window.__richieste = [];
    window.__full = schemaJson ? JSON.parse(schemaJson) : null;
    window.__pager = usaPager && pagerSrc ? eval(`(${pagerSrc})`) : null;
    window.__attese = [];
    impostaSocket({
      emit: (evento, msg, cb) => {
        window.__richieste.push({ evento });
        if (!cb) return;
        if (evento === 'db:schema') {
          if (modo === 'differita') { window.__attese.push({ msg: JSON.parse(JSON.stringify(msg || {})), cb }); return; }
          const copia = JSON.parse(JSON.stringify(window.__full));
          if (window.__pager) cb({ ok: true, ...window.__pager.pagina(window.__full, msg) });
          else {
            // Come `limitaSchema` a pagina unica: il campionamento viaggia
            // DENTRO schemaPage, non al livello del catalogo.
            const pagina = copia.schemaPage || { complete: true };
            if (copia.campionamento && !pagina.campionamento) pagina.campionamento = copia.campionamento;
            cb({ ok: true, ...copia, schemaPage: pagina });
          }
          return;
        }
        if (evento === 'collection:stats') { cb({ ok: true, fields: [], indexes: [], stats: null }); return; }
        cb({ ok: true });
      },
      on: () => {}, off: () => {},
    });
    const guida = document.getElementById('onboarding-overlay');
    if (guida) guida.remove();
    const tab = createTab({ id: 'tab-uml', connName: null });
    tab.state.connected = true;
    tab.state.db = dbName;
    tab.state.coll = null;
    tab.state.connId = 'conn-prova';
    tab.state.view = 'uml';
    tabs.activeId = tab.id;
    document.getElementById('welcome').classList.add('hidden');
    document.getElementById('tab-body').classList.remove('hidden');
    document.getElementById('workspace').classList.remove('hidden');
    for (const v of document.querySelectorAll('#workspace .view-panel')) v.classList.add('hidden');
    document.getElementById('view-uml').classList.remove('hidden');
    const uml = await import('/js/uml.js');
    window.__uml = uml;
    uml.loadUml(true);
  }, { dbName: db, schemaJson: schema ? JSON.stringify(schema) : null, pagerSrc: PAGER, modo: rispondi || 'pagine', usaPager: pagine === true, guasta: guastaStorage === true });
}

(async () => {
  console.log('--- E2E: scenari UML (drenaggio, contesti, storage) ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UML_SCENARI_PORT, 10) || 3152 });
  const browser = await chromium.launch();
  try {
    /* --- 1. Drenaggio grande -------------------------------------------- */
    {
      const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
      const errori = [];
      page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
      await apriUml(page, server, { db: 'magazzino', schema: schemaGrande(), pagine: true });
      await page.waitForSelector('#uml-canvas .joint-element', { timeout: 30000 });
      await page.waitForTimeout(800);
      const dopo = await page.evaluate(() => ({
        voci: document.querySelectorAll('#uml-catalogo-lista [data-chiave]').length,
        richieste: window.__richieste.filter((r) => r.evento === 'db:schema').length,
        nodi: Object.keys(window.__uml.statoUml().doc.nodi).length,
        piede: document.getElementById('uml-catalogo-piede').textContent || '',
      }));
      ok(dopo.voci === 250, 'ogni tabella è raggiungibile nel catalogo', `voci=${dopo.voci}`);
      ok(dopo.richieste <= 25, 'il giro termina senza cicli infiniti', `richieste=${dopo.richieste}`);
      ok(dopo.nodi === 250, 'il diagramma contiene anche i nodi delle pagine successive', `nodi=${dopo.nodi}`);
      // La ricerca centra una tabella già presente, senza modificare il documento.
      await page.fill('#uml-cerca', 'tabella_249');
      await page.waitForTimeout(300);
      const trovata = await page.evaluate(() =>
        document.querySelectorAll('#uml-catalogo-lista [data-chiave]').length);
      ok(trovata === 1, 'la ricerca trova l’ultima tabella', `voci=${trovata}`);
      await page.click('#uml-catalogo-lista [data-chiave]');
      await page.waitForTimeout(400);
      const dentro = await page.evaluate(() => {
        const st = window.__uml.statoUml();
        return Object.keys(st.doc.nodi).filter((k) => JSON.parse(k)[3] === 'tabella_249').length;
      });
      ok(dentro === 1, 'l’ultima tabella è già nel diagramma', `nodi=${dentro}`);
      ok(errori.length === 0, 'nessun errore durante il drenaggio', errori.join(' | '));
      await page.close();
    }

    /* --- 2. Cambio di database in volo ----------------------------------- */
    {
      const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
      const errori = [];
      page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
      await apriUml(page, server, { db: 'dbA', schema: null, rispondi: 'differita' });
      await page.waitForTimeout(400);
      // Due tab, due database; la risposta di A resta appesa.
      await page.evaluate(async () => {
        const { createTab, tabs } = await import('/js/tabs.js');
        const tab = createTab({ id: 'tab-b', connName: null });
        tab.state.connected = true;
        tab.state.db = 'dbB';
        tab.state.coll = null;
        tab.state.connId = 'conn-prova';
        tab.state.view = 'uml';
        tabs.activeId = tab.id;
        window.__uml.loadUml();
      });
      await page.waitForTimeout(400);
      const schemaA = {
        collections: [{ name: 'soloA', fields: [{ name: 'id' }] }],
        relations: [],
        schemaPage: { complete: true },
      };
      const schemaB = {
        collections: [{ name: 'soloB', fields: [{ name: 'id' }] }],
        relations: [],
        schemaPage: { complete: true },
      };
      // La risposta TARDIVA di A arriva mentre si guarda B: non deve toccare nulla.
      await page.evaluate((s) => {
        const attesa = window.__attese.find((a) => a.msg.db === 'dbA');
        attesa.cb({ ok: true, ...JSON.parse(JSON.stringify(s)) });
      }, schemaA);
      await page.waitForTimeout(400);
      const dopoA = await page.evaluate(() => ({
        catalogo: document.getElementById('uml-catalogo-lista').textContent,
        db: window.__uml.statoUml().contesto && window.__uml.statoUml().contesto.db,
      }));
      ok(!/soloA/.test(dopoA.catalogo), 'la risposta tardiva di A non entra nel diagramma di B');
      ok(dopoA.db === 'dbB', 'il contesto resta quello guardato', `db=${dopoA.db}`);
      await page.evaluate((s) => {
        const attesa = window.__attese.find((a) => a.msg.db === 'dbB');
        attesa.cb({ ok: true, ...JSON.parse(JSON.stringify(s)) });
      }, schemaB);
      await page.waitForFunction(
        () => /soloB/.test(document.getElementById('uml-catalogo-lista').textContent || ''),
        { timeout: 15000 });
      const ambito = await page.evaluate(() => window.__uml.statoUml().ambito);
      ok(/dbB/.test(ambito || ''), 'l’archivio consultato appartiene al database guardato', ambito);
      ok(errori.length === 0, 'nessun errore nel cambio in volo', errori.join(' | '));
      await page.close();
    }

    /* --- 3. Campionamento dichiarato -------------------------------------- */
    {
      const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
      const errori = [];
      page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
      await apriUml(page, server, {
        db: 'mongo',
        schema: {
          collections: [{ name: 'eventi', fields: [{ name: 'tipo', types: ['string'] }] }],
          relations: [],
          schemaPage: { complete: true },
          campionamento: { documenti: 50, collezioni: 1, quando: '2026-09-16T10:00:00.000Z' },
        },
      });
      await page.waitForSelector('#uml-canvas .joint-element', { timeout: 15000 });
      await page.waitForTimeout(600);
      const nodo = await page.evaluate(() => {
        const el = [...document.querySelectorAll('#uml-canvas .joint-element')][0];
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + 40), y: Math.round(r.top + 10) };
      });
      await page.mouse.click(nodo.x, nodo.y);
      await page.waitForTimeout(500);
      const testo = await page.evaluate(() => document.getElementById('uml-ispettore-corpo').textContent);
      ok(/osservati/.test(testo) && /50/.test(testo),
        'l’ispettore dice che i campi sono osservati su 50 documenti', testo.slice(0, 160));
      ok(errori.length === 0, 'nessun errore sul campionamento', errori.join(' | '));
      await page.close();
    }

    /* --- 4. Rilettura di un diagramma salvato da un’altra finestra -------- */
    {
      const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
      const schema = { collections: [{ name: 'ordini', fields: [{ name: 'id' }] }], relations: [], schemaPage: { complete: true } };
      await apriUml(page, server, { db: 'ufficio', schema });
      await page.waitForSelector('#uml-canvas .joint-element');
      await page.evaluate(async () => {
        const st = window.__uml.statoUml();
        const archivio = await import('/js/uml-store.js');
        const doc = structuredClone(st.doc);
        doc.nome = 'Diagramma condiviso';
        await archivio.salva(st.ambito, 'condiviso', { nome: doc.nome, doc });
        window.__uml.loadUml(true);
      });
      await page.waitForSelector('#uml-diagrammi option[value="condiviso"]', { state: 'attached' });
      await scegliArc(page, '#uml-diagrammi', 'condiviso');
      await page.waitForFunction(() => window.__uml.statoUml().idDiagramma === 'condiviso');
      await page.evaluate(async () => {
        const st = window.__uml.statoUml();
        const archivio = await import('/js/uml-store.js');
        const record = await archivio.leggi(st.ambito, 'condiviso');
        record.doc.nome = 'Aggiornato da altra finestra';
        await archivio.salva(st.ambito, 'condiviso', { nome: record.doc.nome, doc: record.doc, baseRevisione: record.revisione });
      });
      await page.click('#uml-refresh');
      await page.waitForFunction(() => window.__uml.statoUml().doc.nome === 'Aggiornato da altra finestra');
      ok(true, 'rileggere il diagramma carica la versione aggiornata senza sovrascriverla');
      await apriUml(page, server, { db: 'ufficio', schema });
      await page.waitForSelector('#uml-diagrammi option[value="condiviso"]', { state: 'attached' });
      await scegliArc(page, '#uml-diagrammi', 'condiviso');
      await page.waitForFunction(() => window.__uml.statoUml().doc.nome === 'Aggiornato da altra finestra');
      ok(true, 'il diagramma salvato resta consultabile dopo la ricarica');
      await page.close();
    }

    /* --- 5. Storage indisponibile ------------------------------------------ */
    {
      const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
      const errori = [];
      page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
      await apriUml(page, server, {
        db: 'ufficio',
        schema: { collections: [{ name: 't', fields: [] }], relations: [], schemaPage: { complete: true } },
        guastaStorage: true,
      });
      await page.waitForSelector('.toast-warning', { timeout: 5000 });
      const stato = await page.evaluate(() => ({
        avviso: document.querySelector('.toast-warning')?.textContent || '',
        nodi: document.querySelectorAll('#uml-canvas .joint-element').length,
        esporta: !!document.getElementById('uml-esporta-btn'),
      }));
      ok(/archiviazione/.test(stato.avviso) && stato.nodi >= 1 && stato.esporta,
        'senza storage: errore dichiarato, diagramma in memoria, export disponibile',
        JSON.stringify(stato));
      ok(errori.length === 0, 'nessun crash senza storage', errori.join(' | '));
      await page.close();
    }
  } finally {
    await browser.close();
    await server.stop();
  }

  console.log(falliti === 0 ? '\n--- Scenari UML: tutti i test superati ---' : `\n--- Scenari UML: ${falliti} test falliti ---`);
  process.exit(falliti === 0 ? 0 : 1);
})();
