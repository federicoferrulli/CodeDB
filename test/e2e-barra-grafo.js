'use strict';

/* ---------------------------------------------------------------------------
 * Test E2E: la barra del Grafo 3D e ciò che i suoi comandi chiedono al grafo.
 *
 * PERCHÉ ESISTE. Le regole della barra sono pure e provate senza browser
 * (`test/unit-grafo-comandi.js`), ma una regola giusta collegata a nulla è
 * indistinguibile da una regola sbagliata — ed è esattamente la forma dei tre
 * difetti che questo file sorveglia:
 *
 *   1. lo stato viveva in una classe CSS assegnata da otto gestori diversi, e
 *      quello INIZIALE non lo dipingeva nessuno: «Relazioni implicite» partiva
 *      acceso nel codice e spento sullo schermo;
 *   2. «Vista 2D» fissava `fz = 0` sui nodi e spostava la telecamera, ma le
 *      forze restavano a tre dimensioni: l'unico effetto visibile era un
 *      ridisegno;
 *   3. «Rotazione automatica» assegnava `controls().autoRotate`, che i
 *      TrackballControls — i controlli PREDEFINITI di 3d-force-graph — non
 *      hanno affatto: il comando non ha mai fatto nulla.
 *
 * Nessuno dei tre si vede da fuori guardando il canvas WebGL. Si mette quindi
 * un `ForceGraph3D` REGISTRANTE al posto di quello vero e si guarda che cosa il
 * grafo riceve: è l'unico posto in cui quei difetti sono osservabili.
 *
 * Non serve un database: lo schema è finto e sta in `state.dbSchema`.
 *
 * Uso: node test/e2e-barra-grafo.js
 * ------------------------------------------------------------------------- */

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

/*
 * Sedici tabelle, una delle quali al limite dei campi. È il caso reale
 * segnalato: `limitaSchema` marca `schemaPage.complete = false` per il solo
 * troncamento dei CAMPI, e da lì `incomplete` accendeva la modalità ridotta —
 * che spegneva etichette, particelle e rotazione su uno schema piccolissimo.
 */
const SCHEMA = {
  collections: [
    ...Array.from({ length: 15 }, (_, i) => ({
      name: `tabella_${i}`,
      rowsApprox: i === 3 ? 0 : 10 + i,
      fields: [{ name: 'id' }, { name: 'nome' }],
    })),
    {
      name: 'clienti',
      rowsApprox: 42,
      fields: Array.from({ length: 12 }, (_, j) => ({ name: `campo_${j}` })),
    },
  ],
  relations: [{ from: 'tabella_1', to: 'clienti', field: 'cliente_id' }],
  // È così che il server la dichiara quando ha troncato i campi di una tabella.
  schemaPage: { complete: false, cursor: 0, nextCursor: null },
};

/* Il registrante. Ogni metodo torna se stesso (l'API è concatenata) e annota
 * nome e forma degli argomenti; `controls()` restituisce sempre lo stesso
 * oggetto, che è dove la rotazione automatica va davvero a finire. */
const REGISTRANTE = `
  window.__reg = [];
  window.__controls = {
    autoRotate: false, autoRotateSpeed: 0,
    enableRotate: true, enablePan: false, enableZoom: false,
    screenSpacePanning: false, mouseButtons: null, touches: null,
  };
  window.__opts = null;
  window.__dati = { nodes: [], links: [] };
  const forma = (a) => (typeof a === 'function' ? 'fn' : (a && typeof a === 'object' ? 'obj' : a));
  const crea = () => {
    const g = new Proxy(function () {}, {
      apply: () => g,
      get(_t, prop) {
        if (prop === 'controls') return () => window.__controls;
        if (prop === 'graphData') return (d) => {
          if (d === undefined) return window.__dati;
          window.__dati = d; window.__reg.push(['graphData', ['obj']]); return g;
        };
        if (prop === 'nodeColor' || prop === 'linkWidth') return (v) => {
          if (v === undefined) return () => 0;
          window.__reg.push([String(prop), [forma(v)]]); return g;
        };
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return (...args) => { window.__reg.push([String(prop), args.map(forma)]); return g; };
      },
    });
    return g;
  };
  window.ForceGraph3D = (opts) => { window.__opts = opts; return () => crea(); };
`;

const ultimaChiamata = (nome) =>
  `(window.__reg.filter((r) => r[0] === ${JSON.stringify(nome)}).pop() || [])[1]`;

(async () => {
  console.log('--- E2E: barra del Grafo 3D ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_GRAFO_PORT, 10) || 3147 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errori = [];
    page.on('pageerror', (err) => errori.push(`pageerror: ${err && err.message ? err.message : err}`));

    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#graph3d-canvas', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1200);

    // --- 1. Lo stato INIZIALE è dipinto ------------------------------------
    const iniziale = await page.evaluate(() => ({
      implicite: document.getElementById('graph3d-toggle-implicit').getAttribute('aria-pressed'),
      vuote: document.getElementById('graph3d-toggle-empty').getAttribute('aria-pressed'),
      prefisso: document.querySelector('.grafo-seg[data-colore="prefix"]').getAttribute('aria-pressed'),
      centralita: document.querySelector('.grafo-seg[data-colore="degree"]').getAttribute('aria-pressed'),
      emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(document.querySelector('.graph3d-bar').textContent),
    }));
    ok(iniziale.implicite === 'true',
      '«Relazioni implicite» nasce premuto, come lo stato che rappresenta', `aria-pressed=${iniziale.implicite}`);
    ok(iniziale.vuote === 'false', '«Solo popolate» nasce non premuto');
    ok(iniziale.prefisso === 'true' && iniziale.centralita === 'false',
      'il segmentato del colore dichiara quale dei due è in vigore');
    ok(iniziale.emoji === false, 'nessuna emoji come icona nella barra');

    // --- 2. Un comando inutilizzabile è disattivato e dice perché ----------
    const hop = await page.evaluate(() => {
      const s = document.getElementById('graph3d-hop-btn');
      return { disabled: s.disabled, title: s.title };
    });
    ok(hop.disabled === true, 'senza una tabella scelta il filtro dei vicini è disattivato');
    ok(/Scegli prima una tabella/.test(hop.title),
      'il motivo sta nel title, prima del clic', hop.title);

    // La rotazione non è MAI disattivata: era spenta d'ufficio sui grafi
    // giudicati grandi, che è la cosa da non fare invece di farla funzionare.
    const rotDisabilitata = await page.evaluate(() => document.getElementById('graph3d-auto-rotate').disabled);
    ok(rotDisabilitata === false, 'la rotazione automatica non è mai disabilitata');

    // --- 3. Si mette il registrante e si disegna ---------------------------
    await page.evaluate(REGISTRANTE);
    await page.evaluate(async (schema) => {
      const { state } = await import('/js/state.js');
      const g = await import('/js/graph3d.js');
      // Senza connessione il workspace è nascosto (`#tab-body` compreso): qui
      // si rende visibile la sola vista in prova, come farebbe una connessione
      // vera, altrimenti nessun clic raggiungerebbe alcun elemento.
      // Su un profilo nuovo la guida introduttiva copre tutta la pagina e
      // intercetta i clic: qui non è in prova.
      const guida = document.getElementById('onboarding-overlay');
      if (guida) guida.remove();
      document.getElementById('welcome').classList.add('hidden');
      document.getElementById('tab-body').classList.remove('hidden');
      document.getElementById('workspace').classList.remove('hidden');
      for (const v of document.querySelectorAll('#workspace .view-panel')) v.classList.add('hidden');
      document.getElementById('view-graph3d').classList.remove('hidden');
      state.dbSchema = JSON.parse(JSON.stringify(schema));
      g.renderGraph3d();
    }, SCHEMA);
    await page.waitForTimeout(800);

    // --- 4. I controlli sono ORBIT, altrimenti autoRotate non esiste -------
    const opzioni = await page.evaluate(() => window.__opts);
    ok(!!opzioni && opzioni.controlType === 'orbit',
      'il grafo nasce con i controlli orbit: i TrackballControls predefiniti non hanno autoRotate',
      JSON.stringify(opzioni));

    // --- 4-bis. Il fondo della scena segue il tema -------------------------
    // Il canvas WebGL dipinge il PROPRIO fondo: la regola CSS sul contenitore
    // resta dietro a un canvas opaco e non si vede mai, quindi col tema chiaro
    // il grafo restava scuro — l'unico elemento della UI che il tema non
    // raggiungeva.
    // I due temi si IMPONGONO, non si presume quale sia in vigore: il profilo
    // di prova potrebbe già essere chiaro, e allora un confronto «prima e dopo»
    // troverebbe due volte lo stesso valore e passerebbe senza provare nulla.
    const sfondi = await page.evaluate(async () => {
      const g = await import('/js/graph3d.js');
      const misura = (tema) => {
        document.documentElement.setAttribute('data-theme', tema);
        g.renderGraph3d();
        const chiamata = window.__reg.filter((r) => r[0] === 'backgroundColor').pop();
        return {
          dato: chiamata && chiamata[1][0],
          atteso: getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim(),
        };
      };
      const scuro = misura('dark');
      const chiaro = misura('light');
      document.documentElement.setAttribute('data-theme', 'dark');
      g.renderGraph3d();
      return { scuro, chiaro };
    });
    ok(sfondi.scuro.dato === sfondi.scuro.atteso && !!sfondi.scuro.atteso,
      'il fondo della scena è il token del tema, non il blu quasi nero predefinito',
      JSON.stringify(sfondi.scuro));
    ok(sfondi.chiaro.dato === sfondi.chiaro.atteso
      && sfondi.chiaro.dato !== sfondi.scuro.dato,
      'passando al tema chiaro il fondo del grafo cambia con esso',
      JSON.stringify(sfondi));

    // --- 5. Le etichette restano accese su uno schema di 16 tabelle --------
    const etichette = await page.evaluate(`${ultimaChiamata('nodeThreeObject')}`);
    ok(Array.isArray(etichette) && etichette[0] === 'fn',
      'i nomi delle tabelle vengono disegnati anche con schemaPage.complete = false',
      JSON.stringify(etichette));

    // --- 6. «Vista 2D» cambia le DIMENSIONI della simulazione --------------
    const dim3d = await page.evaluate(`${ultimaChiamata('numDimensions')}`);
    ok(Array.isArray(dim3d) && dim3d[0] === 3, 'si parte a tre dimensioni', JSON.stringify(dim3d));

    await page.click('#graph3d-toggle-2d');
    await page.waitForTimeout(700);
    const dopo2d = await page.evaluate(() => ({
      dim: (window.__reg.filter((r) => r[0] === 'numDimensions').pop() || [])[1],
      premuto: document.getElementById('graph3d-toggle-2d').getAttribute('aria-pressed'),
      rotazioneBloccata: window.__controls.enableRotate === false,
      // In piano il trascinamento deve SPOSTARE: togliere la rotazione senza
      // rimappare il tasto sinistro lascia fermi, perché negli OrbitControls
      // quel gesto È la rotazione. I valori attesi si leggono da THREE, non si
      // riscrivono qui: due costanti scritte a mano concorderebbero fra loro
      // anche se il codice usasse quelle sbagliate.
      tastoSinistro: window.__controls.mouseButtons && window.__controls.mouseButtons.LEFT,
      unDito: window.__controls.touches && window.__controls.touches.ONE,
      spostamento: window.__controls.enablePan,
      ingrandimento: window.__controls.enableZoom,
      pan: window.THREE && window.THREE.MOUSE && window.THREE.MOUSE.PAN,
      panTocco: window.THREE && window.THREE.TOUCH && window.THREE.TOUCH.PAN,
    }));
    ok(Array.isArray(dopo2d.dim) && dopo2d.dim[0] === 2,
      '«Vista 2D» chiede al grafo due dimensioni, non solo un ridisegno',
      JSON.stringify(dopo2d.dim));
    ok(dopo2d.premuto === 'true', 'il bottone 2D dichiara di essere premuto');
    ok(dopo2d.rotazioneBloccata === true,
      'in 2D l\'orbita si blocca: altrimenti il primo trascinamento riporterebbe la scena di sbieco');
    // `pan` e `panTocco` devono esistere: se THREE non fosse caricata sarebbero
    // entrambi `undefined` e il confronto passerebbe da solo, cioè il test non
    // proverebbe nulla.
    ok(typeof dopo2d.pan === 'number' && typeof dopo2d.panTocco === 'number',
      'le costanti di THREE sono leggibili: il confronto qui sotto non è a vuoto',
      JSON.stringify(dopo2d));
    ok(dopo2d.tastoSinistro === dopo2d.pan && dopo2d.unDito === dopo2d.panTocco,
      'in 2D il trascinamento sposta sul piano X-Y invece di non fare nulla',
      JSON.stringify(dopo2d));
    ok(dopo2d.spostamento === true && dopo2d.ingrandimento === true,
      'in 2D spostamento e ingrandimento restano disponibili');

    // --- 7. La rotazione automatica arriva ai controlli --------------------
    // È il difetto reale: prima il valore veniva scritto su TrackballControls,
    // che non lo legge, quindi il comando non muoveva nulla.
    await page.click('#graph3d-auto-rotate');
    await page.waitForTimeout(700);
    const dopoRot = await page.evaluate(() => ({
      autoRotate: window.__controls.autoRotate,
      velocita: window.__controls.autoRotateSpeed,
      premuto: document.getElementById('graph3d-auto-rotate').getAttribute('aria-pressed'),
      // Chiedere la rotazione mentre si è in 2D è chiedere lo spazio: si esce
      // dal piano invece di disabilitare uno dei due comandi.
      duedi: document.getElementById('graph3d-toggle-2d').getAttribute('aria-pressed'),
    }));
    ok(dopoRot.autoRotate === true && dopoRot.velocita > 0,
      'la rotazione automatica arriva ai controlli che la implementano',
      JSON.stringify(dopoRot));
    ok(dopoRot.premuto === 'true', 'il bottone della rotazione dichiara di essere premuto');
    ok(dopoRot.duedi === 'false',
      'accendere la rotazione mentre si è in 2D riporta in 3D, invece di contraddirsi');

    // La rotazione sopravvive a un ridisegno: l'istanza viene ricreata a ogni
    // render, e senza riapplicarla cambiare colore la spegneva in silenzio.
    await page.click('.grafo-seg[data-colore="degree"]');
    await page.waitForTimeout(700);
    const dopoRidisegno = await page.evaluate(() => ({
      autoRotate: window.__controls.autoRotate,
      rotazioneLibera: window.__controls.enableRotate,
      tastoSinistro: window.__controls.mouseButtons && window.__controls.mouseButtons.LEFT,
      rotate: window.THREE && window.THREE.MOUSE && window.THREE.MOUSE.ROTATE,
      prefisso: document.querySelector('.grafo-seg[data-colore="prefix"]').getAttribute('aria-pressed'),
      centralita: document.querySelector('.grafo-seg[data-colore="degree"]').getAttribute('aria-pressed'),
    }));
    ok(dopoRidisegno.autoRotate === true, 'la rotazione sopravvive al ridisegno del grafo');
    ok(dopoRidisegno.rotazioneLibera === true && dopoRidisegno.tastoSinistro === dopoRidisegno.rotate,
      'tornati in 3D il trascinamento torna a ruotare la scena',
      JSON.stringify(dopoRidisegno));
    ok(dopoRidisegno.prefisso === 'false' && dopoRidisegno.centralita === 'true',
      'scegliere «Centralità» sposta lo stato premuto su un solo bottone');

    // --- 8. «Solo popolate» filtra sulle RIGHE, non sulle colonne ----------
    // `tabella_3` ha due colonne e zero righe: il vecchio criterio
    // (`fields.length === 0`) non l'avrebbe mai contata.
    const primaDelFiltro = await page.evaluate(() => window.__dati.nodes.length);
    await page.click('#graph3d-toggle-empty');
    await page.waitForTimeout(700);
    const dopoFiltro = await page.evaluate(() => ({
      nodi: window.__dati.nodes.length,
      nomi: window.__dati.nodes.map((n) => n.id),
      premuto: document.getElementById('graph3d-toggle-empty').getAttribute('aria-pressed'),
      toast: (document.querySelector('#toast') || {}).textContent || '',
    }));
    ok(primaDelFiltro === 16, 'lo schema di prova arriva intero al grafo', String(primaDelFiltro));
    ok(dopoFiltro.nodi === 15 && !dopoFiltro.nomi.includes('tabella_3'),
      'la tabella a zero righe sparisce davvero dal grafo', `${dopoFiltro.nodi} nodi`);
    ok(dopoFiltro.premuto === 'true', '«Solo popolate» dichiara di essere acceso');
    ok(/1 tabella nascosta/.test(dopoFiltro.toast) && /stima/.test(dopoFiltro.toast),
      'il messaggio dice quante tabelle sono sparite e che il conteggio è stimato',
      dopoFiltro.toast);

    await page.click('#graph3d-toggle-empty');
    await page.waitForTimeout(500);

    // --- 9. La ricerca dichiara che cosa ha trovato -----------------------
    await page.fill('#graph3d-search', 'zzzz');
    await page.waitForTimeout(400);
    const senzaEsito = await page.evaluate(() => {
      const e = document.getElementById('graph3d-search-esito');
      return {
        testo: e.textContent,
        assente: e.classList.contains('assente'),
        azzeraVisibile: !document.getElementById('graph3d-search-clear').classList.contains('hidden'),
      };
    });
    ok(senzaEsito.testo === 'Nessuna corrispondenza',
      'una ricerca a vuoto lo dice, invece di comportarsi come una ricerca non scritta',
      senzaEsito.testo);
    ok(senzaEsito.assente === true, 'l\'esito «assente» è distinto anche nello stile');
    ok(senzaEsito.azzeraVisibile === true, 'il bottone per azzerare compare col testo');

    // Il registrante non fa girare alcuna simulazione, quindi i nodi non hanno
    // coordinate: la corrispondenza si dichiara comunque, ed è il punto.
    await page.fill('#graph3d-search', 'clienti');
    await page.waitForTimeout(500);
    const conEsito = await page.evaluate(() =>
      document.getElementById('graph3d-search-esito').textContent);
    ok(conEsito === 'Tabella clienti', 'la corrispondenza dichiara che cosa ha trovato', conEsito);

    await page.click('#graph3d-search-clear');
    await page.waitForTimeout(300);
    const dopoAzzera = await page.evaluate(() => ({
      valore: document.getElementById('graph3d-search').value,
      esito: document.getElementById('graph3d-search-esito').textContent,
      azzeraVisibile: !document.getElementById('graph3d-search-clear').classList.contains('hidden'),
    }));
    ok(dopoAzzera.valore === '' && dopoAzzera.esito === '' && !dopoAzzera.azzeraVisibile,
      'azzerare la ricerca riporta campo, esito e bottone allo stato di partenza');

    // --- 10. Gli strumenti d'inquadratura si scansano dal pannello ---------
    // Lo spostamento è animato (`transition: right`), e `getComputedStyle`
    // restituisce il valore ISTANTANEO: leggerlo subito dopo aver messo la
    // classe darebbe ancora la posizione di partenza.
    const prima = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById('graph3d-rail')).right));
    await page.evaluate(() => document.querySelector('.graph3d-container').classList.add('pannello-aperto'));
    await page.waitForTimeout(500);
    const dopo = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById('graph3d-rail')).right));
    await page.evaluate(() => document.querySelector('.graph3d-container').classList.remove('pannello-aperto'));
    const rail = { prima, dopo };
    ok(rail.prima < 40 && rail.dopo > 300,
      'col pannello aperto gli strumenti si spostano a sinistra, invece di finirgli sotto',
      JSON.stringify(rail));

    // --- 10-bis. «Vicini» apre il MENU della barra, non quello di sistema --
    // Era una `<select>`: l'unico comando della barra la cui tendina la
    // disegnava il sistema operativo — fondo, carattere, spaziatura e freccia
    // venivano da fuori, e nessuna regola CSS poteva allinearla al resto.
    // Che sia diventato un menu come «Analisi» e «Schema» si prova su ciò che
    // il menu FA, non sulle sue classi.
    const campo = await page.evaluate(() => {
      const btn = document.getElementById('graph3d-hop-btn');
      const menu = document.getElementById('graph3d-hop-menu');
      const pill = document.getElementById('graph3d-toggle-empty');
      const rCampo = btn.getBoundingClientRect();
      const rPill = pill.getBoundingClientRect();
      return {
        // Nessuna `<select>` è sopravvissuta: se ne restasse una, la tendina di
        // sistema tornerebbe da qualche parte.
        selectRimaste: document.querySelectorAll('.graph3d-bar select').length,
        // Il menu è lo stesso componente degli altri due comandi della barra.
        classeMenu: menu.className.includes('toolbar-dropdown-menu'),
        stessaClasseDegliAltri: document.querySelectorAll(
          '.graph3d-bar .toolbar-dropdown-menu',
        ).length,
        // Scegliere fra alternative che si escludono non è eseguire un comando:
        // il ruolo giusto è `menuitemradio`, e `aria-checked` dice quale vale.
        ruoli: [...menu.querySelectorAll('[data-salti]')].map((v) => v.getAttribute('role')),
        // Stessa altezza delle pillole accanto, altrimenti la riga balla.
        dislivello: Math.abs(rCampo.height - rPill.height),
        // Una freccia sola, dallo sprite: quella di sistema non si può colorare
        // e non seguiva il tema.
        frecce: btn.querySelectorAll('svg').length,
        larghezzaValore: getComputedStyle(
          document.getElementById('graph3d-hop-valore'),
        ).textAlign,
      };
    });
    ok(campo.selectRimaste === 0,
      'nella barra non resta nessuna <select>: nessuna tendina di sistema',
      String(campo.selectRimaste));
    ok(campo.classeMenu === true && campo.stessaClasseDegliAltri === 3,
      'il filtro usa lo stesso menu di «Analisi» e «Schema»',
      JSON.stringify(campo));
    ok(campo.ruoli.length === 3 && campo.ruoli.every((r) => r === 'menuitemradio'),
      'le voci sono alternative che si escludono, non comandi', JSON.stringify(campo.ruoli));
    ok(campo.dislivello < 3,
      'il controllo è alto come le pillole che gli stanno accanto', `Δ=${campo.dislivello}px`);
    ok(campo.frecce === 1, 'una freccia sola, quella dello sprite', String(campo.frecce));
    ok(campo.larghezzaValore === 'right',
      'il valore è allineato contro la freccia — la cosa che una <select> non permetteva');

    // Il controllo funziona: si sceglie una voce e il grafo ridisegna col nuovo
    // criterio. Serve un nodo scelto, altrimenti il filtro è disattivato.
    // Il registrante non fa girare alcuna simulazione, quindi i nodi non hanno
    // coordinate e la ricerca non può portarci la telecamera — cioè non
    // sceglie nulla, e senza una tabella scelta il filtro resta giustamente
    // disattivato. Le coordinate si mettono a mano: qui è in prova il filtro,
    // non la disposizione delle forze.
    await page.evaluate(() => {
      window.__dati.nodes.forEach((n, i) => { n.x = i * 10; n.y = 0; n.z = 0; });
    });
    await page.fill('#graph3d-search', 'clienti');
    await page.waitForTimeout(600);
    await page.click('#graph3d-hop-btn');
    await page.waitForTimeout(300);
    await page.click('#graph3d-hop-menu [data-salti="1"]');
    await page.waitForTimeout(600);
    const dopoScelta = await page.evaluate(() => ({
      valore: document.getElementById('graph3d-hop-valore').textContent.trim(),
      spuntato: [...document.querySelectorAll('#graph3d-hop-menu [data-salti]')]
        .filter((v) => v.getAttribute('aria-checked') === 'true').map((v) => v.dataset.salti),
      menuChiuso: document.getElementById('graph3d-hop-menu').classList.contains('hidden'),
      espanso: document.getElementById('graph3d-hop-btn').getAttribute('aria-expanded'),
      // La prova che la scelta è ARRIVATA al grafo: con un salto solo restano
      // il nodo scelto e i suoi vicini diretti, non tutte e sedici le tabelle.
      nodi: window.__dati.nodes.length,
    }));
    ok(dopoScelta.valore === '1 salto',
      'il valore scelto si legge sul bottone a menu chiuso', dopoScelta.valore);
    ok(dopoScelta.spuntato.length === 1 && dopoScelta.spuntato[0] === '1',
      'una sola voce risulta scelta, e nel menu è quella spuntata',
      JSON.stringify(dopoScelta.spuntato));
    ok(dopoScelta.menuChiuso === true && dopoScelta.espanso === 'false',
      'scegliendo, il menu si chiude e il bottone lo dichiara', JSON.stringify(dopoScelta));
    ok(dopoScelta.nodi > 0 && dopoScelta.nodi < 16,
      'la scelta arriva al grafo: il filtro riduce davvero i nodi disegnati',
      `${dopoScelta.nodi} nodi`);

    // --- 10-ter. Il menu si percorre da TASTIERA --------------------------
    // La `<select>` di prima queste cose le faceva gratis: sostituirla senza
    // rimetterle sarebbe stato un peggioramento travestito da miglioramento
    // estetico. Vale per tutti e tre i menu della barra, non solo per questo.
    await page.focus('#graph3d-hop-btn');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    const primaVoce = await page.evaluate(() => ({
      fuoco: document.activeElement.dataset ? document.activeElement.dataset.salti : null,
      aperto: !document.getElementById('graph3d-hop-menu').classList.contains('hidden'),
    }));
    ok(primaVoce.aperto === true && primaVoce.fuoco === 'all',
      'freccia giù apre il menu e porta il fuoco sulla prima voce',
      JSON.stringify(primaVoce));

    await page.keyboard.press('ArrowDown');
    const secondaVoce = await page.evaluate(() => document.activeElement.dataset.salti);
    ok(secondaVoce === '1', 'le frecce percorrono le voci', secondaVoce);

    await page.keyboard.press('End');
    const ultimaVoce = await page.evaluate(() => document.activeElement.dataset.salti);
    ok(ultimaVoce === '2', 'Fine salta all\'ultima voce', ultimaVoce);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const dopoEsc = await page.evaluate(() => ({
      chiuso: document.getElementById('graph3d-hop-menu').classList.contains('hidden'),
      fuoco: document.activeElement.id,
    }));
    ok(dopoEsc.chiuso === true && dopoEsc.fuoco === 'graph3d-hop-btn',
      'Esc chiude e riporta il fuoco sul bottone: lasciarlo su una voce nascosta lo perderebbe',
      JSON.stringify(dopoEsc));

    // Lo stesso vale per gli altri menu della barra: la correzione sta nella
    // registrazione comune, non nel gestore di un menu solo.
    await page.focus('#graph3d-analysis-menu-btn');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    const menuAnalisi = await page.evaluate(() => ({
      aperto: !document.getElementById('graph3d-analysis-menu').classList.contains('hidden'),
      fuocoDentro: !!document.activeElement.closest('#graph3d-analysis-menu'),
    }));
    ok(menuAnalisi.aperto === true && menuAnalisi.fuocoDentro === true,
      'anche «Analisi» si apre e si percorre da tastiera', JSON.stringify(menuAnalisi));

    // --- 10-quater. Un menu aperto sta SOPRA pannello e strumenti ----------
    // La barra è un flex item, e su un flex item `z-index` fa contesto di
    // impilamento anche senza `position`: il `z-index: 300` del menu valeva
    // solo dentro quel contesto, e dall'esterno il menu contava quanto la
    // barra. A 10 finiva sotto al pannello laterale (20) e sotto agli
    // strumenti flottanti (16), cioè veniva tagliato a metà proprio dopo aver
    // scelto una tabella. Si misura CHI VIENE DIPINTO SOPRA nel punto in cui i
    // due si sovrappongono, non il numero dichiarato: un confronto fra
    // z-index non avrebbe visto il difetto, perché 300 > 20 era già vero.
    const copertura = await page.evaluate(() => {
      const bar = document.querySelector('.graph3d-bar');
      const pannello = document.getElementById('graph3d-side-panel');
      const rail = document.getElementById('graph3d-rail');
      // Il pannello si apre a mano: qui è in prova l'impilamento, non la via
      // che lo apre, e con il pannello chiuso non ci sarebbe sovrapposizione
      // e il controllo passerebbe a vuoto.
      const eraChiuso = pannello.classList.contains('hidden');
      pannello.classList.remove('hidden');
      document.querySelector('.graph3d-container').classList.add('pannello-aperto');

      // Il menu più a destra è quello che finisce davvero sopra al pannello.
      const btn = document.getElementById('graph3d-export-menu-btn');
      const menu = document.getElementById('graph3d-export-menu');
      btn.click();
      const rMenu = menu.getBoundingClientRect();
      const rPan = pannello.getBoundingClientRect();
      const x = Math.max(rMenu.left, rPan.left) + 4;
      const y = Math.max(rMenu.top, rPan.top) + 4;
      const sovrapposti = x < Math.min(rMenu.right, rPan.right) && y < Math.min(rMenu.bottom, rPan.bottom);
      const sopra = sovrapposti
        ? !!(document.elementFromPoint(x, y) || {}).closest
          && !!document.elementFromPoint(x, y).closest('.toolbar-dropdown-menu')
        : null;

      const numero = (el) => Number(getComputedStyle(el).zIndex) || 0;
      const esito = {
        sovrapposti,
        sopra,
        zBarra: numero(bar),
        zPannello: numero(pannello),
        zRail: numero(rail),
      };

      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      if (eraChiuso) {
        pannello.classList.add('hidden');
        document.querySelector('.graph3d-container').classList.remove('pannello-aperto');
      }
      return esito;
    });
    ok(copertura.sovrapposti === true,
      'il menu e il pannello si sovrappongono davvero: il controllo qui sotto non è a vuoto',
      JSON.stringify(copertura));
    ok(copertura.sopra === true,
      'il menu aperto viene dipinto SOPRA il pannello laterale',
      JSON.stringify(copertura));
    // La barra è il contesto di impilamento: il `z-index: 300` del menu conta
    // solo al suo interno, quindi è il numero della BARRA a decidere contro
    // pannello e strumenti. Confrontare 300 con 20 non avrebbe visto nulla:
    // era già vero mentre il difetto c'era.
    ok(copertura.zBarra > copertura.zPannello && copertura.zBarra > copertura.zRail,
      'la barra, che è il contesto di impilamento dei suoi menu, sta sopra pannello e strumenti',
      JSON.stringify(copertura));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Si riporta il filtro a «Tutti» per non lasciare il grafo filtrato ai
    // controlli che seguono.
    await page.evaluate(() => {
      document.getElementById('graph3d-search').value = '';
      document.getElementById('graph3d-search').dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Si chiude solo se è rimasto aperto: Esc, poco sopra, può averlo già
    // chiuso, e un clic su un bottone fuori schermo non fallisce «bene» — resta
    // appeso trenta secondi e poi accusa il test sbagliato.
    await page.evaluate(() => {
      const pannello = document.getElementById('graph3d-side-panel');
      if (!pannello.classList.contains('hidden')) document.getElementById('graph3d-panel-close').click();
    });
    await page.waitForTimeout(400);

    // --- 11. Gli strumenti icona hanno un nome accessibile ----------------
    const nomi = await page.evaluate(() => [...document.querySelectorAll('.grafo-rail .grafo-tool')]
      .map((b) => ({ label: b.getAttribute('aria-label'), testo: b.textContent.trim() })));
    ok(nomi.length === 3 && nomi.every((n) => n.label && n.label.length > 3),
      'ogni strumento icona dichiara un aria-label: senza, è un bottone senza nome');
    ok(nomi.every((n) => n.testo === ''), 'gli strumenti del rail sono icone SVG, non testo o emoji');

    ok(errori.length === 0, 'nessun errore JavaScript durante la prova', errori.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Barra del Grafo 3D: ${falliti} test falliti ---`);
    process.exitCode = 1;
  } else {
    console.log('\n--- Barra del Grafo 3D: tutti i test superati ---');
  }
})().catch((err) => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
