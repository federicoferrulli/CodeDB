import { state } from './state.js';
import { $, emit, esc, toast, positionFixedDropdown, isForActiveTab } from './utils.js';
import { openCollTab } from './colltabs.js';
import { activeTab } from './tabs.js';
// Le euristiche di analisi dello schema stanno in un modulo condiviso col
// gateway MCP: erano due copie scritte a mano, e l'euristica PII era gia'
// divergente fra le due (vedi la nota in testa a schema-analisi.js).
import {
  detectImplicitRelations, analyzeDependencies as calcolaDipendenze,
  auditSchema as calcolaSalute, terminePii,
} from './schema-analisi.js';
// Generatori e lettori di schema: funzioni pure, quindi fuori dal modulo di
// interfaccia e provate in Node (test/unit-schema-export.js). Producono un
// artefatto che l'utente PORTA VIA: un DDL con due PRIMARY KEY nella stessa
// CREATE TABLE si scopre solo quando qualcuno prova a eseguirlo.
import {
  parseSchemaInput,
  buildMermaidDiagram as generaMermaid, buildDbmlDiagram as generaDbml,
  buildSqlDdl as generaDdl,
} from './schema-export.js';
import { setView } from './main.js';
import { tokenTema } from './theme.js';
import { GRAFO_BUDGET, degradaSchemaGrafo, unisciPagineSchema } from './grafo-budget.js';
// Le regole della barra sono dati puri: chi le usa dipinge, non decide.
import { tabellaVuota, contaVuote, statoComandi, cercaNodo, messaggioRicerca } from './grafo-comandi.js';

let graphInstance = null;
let graphResizeObserver = null;
// Le texture delle etichette sono identiche a parità di nome del nodo e vengono
// ricreate a ogni ridisegno: su uno schema da 60 tabelle sono 60 canvas 256×128
// per volta, mai liberati. Si memoizzano per nome e si liberano con l'istanza.
let textTextureCache = new Map();

// Il grafo viene ridisegnato da molti comandi (modalità colore, filtro salti,
// cammino minimo, sua cancellazione): senza distruggere l'istanza precedente
// ogni ridisegno lascia vivo un contesto WebGL e il suo loop di animazione, e
// oltre il tetto del browser (~16 in Chrome) il canvas diventa nero fino a un
// ricaricamento della pagina.
function distruggiGrafo() {
  const vecchia = graphInstance;
  graphInstance = null;
  if (vecchia) {
    try {
      if (typeof vecchia._destructor === 'function') {
        vecchia._destructor();
      } else {
        if (typeof vecchia.pauseAnimation === 'function') vecchia.pauseAnimation();
        const r = typeof vecchia.renderer === 'function' ? vecchia.renderer() : null;
        if (r) {
          if (typeof r.forceContextLoss === 'function') r.forceContextLoss();
          if (typeof r.dispose === 'function') r.dispose();
        }
      }
    } catch (err) {
      console.warn('Chiusura del grafo 3D precedente non riuscita:', err);
    }
  }
  for (const t of textTextureCache.values()) {
    try {
      if (t && typeof t.dispose === 'function') t.dispose();
    } catch {
      /* una texture già liberata non è un problema */
    }
  }
  textTextureCache = new Map();
}
let currentSchemaData = null;
let selectedNodeId = null;
let autoRotateActive = false;
let is2DMode = false;
let showImplicitRelations = true;
let hideEmptyTables = false;
let currentSearchQuery = '';
let activeShortestPath = null; // Set di nodi del cammino minimo
// La modalità di colorazione era il `value` di una <select> il cui nome stava
// dentro le opzioni («Colore: Prefisso»): a tendina chiusa si leggeva un valore
// senza sapere di che cosa. Ora è un controllo segmentato, e lo stato vive qui.
let colorMode = 'prefix';
// Il filtro dei vicini era il `value` di una <select>, cioè uno stato che
// viveva nel DOM: leggerlo voleva dire interrogare l'elemento, e la sua tendina
// la disegnava il sistema operativo. Ora è un menu come gli altri, quindi lo
// stato sta qui accanto a quello del colore.
let hopFilter = 'all';
// L'ultima politica di degrado applicata.
let ultimaPolicy = { reducedEffects: false, etichette: true };

/*
 * Dipinge i comandi che dipendono dal contesto. È l'unico punto che tocca
 * `aria-pressed` e `disabled`: prima lo stato viveva in una classe `.active`
 * assegnata da otto gestori diversi, e `showImplicitRelations` partiva a `true`
 * senza che nessuno lo dipingesse — la funzione era accesa e il bottone diceva
 * di no.
 */
function aggiornaComandi() {
  const stato = statoComandi({
    selezione: selectedNodeId,
    autoRotazione: autoRotateActive,
  });

  // Un filtro rimasto su «2 salti» mentre nessun nodo è scelto mostrerebbe un
  // criterio che non è in vigore: senza selezione il valore torna a Tutti.
  if (!stato.vicini.abilitato) hopFilter = 'all';
  const hopBtn = $('#graph3d-hop-btn');
  if (hopBtn) {
    hopBtn.disabled = !stato.vicini.abilitato;
    hopBtn.title = stato.vicini.motivo;
  }
  dipingiVicini();

  const rot = $('#graph3d-auto-rotate');
  if (rot) {
    rot.disabled = !stato.autoRotazione.abilitato;
    rot.setAttribute('aria-pressed', String(stato.autoRotazione.premuto));
    rot.title = stato.autoRotazione.motivo;
  }

  const piatto = $('#graph3d-toggle-2d');
  if (piatto) piatto.setAttribute('aria-pressed', String(is2DMode));

  const vuote = $('#graph3d-toggle-empty');
  if (vuote) vuote.setAttribute('aria-pressed', String(hideEmptyTables));

  const implicite = $('#graph3d-toggle-implicit');
  if (implicite) implicite.setAttribute('aria-pressed', String(showImplicitRelations));

  for (const b of document.querySelectorAll('.graph3d-bar .grafo-seg[data-colore]')) {
    b.setAttribute('aria-pressed', String(b.dataset.colore === colorMode));
  }
}

/*
 * Il valore scelto va scritto in DUE posti — sul bottone, che è ciò che si
 * legge a menu chiuso, e sulla voce del menu, che è ciò che si legge a menu
 * aperto. Scriverli in due punti diversi del codice significa poterne
 * dimenticare uno, e uno stato che si contraddice fra chiuso e aperto è
 * peggio di uno stato assente.
 */
function dipingiVicini() {
  const valore = $('#graph3d-hop-valore');
  const voci = document.querySelectorAll('#graph3d-hop-menu [data-salti]');
  for (const voce of voci) {
    const scelta = voce.dataset.salti === hopFilter;
    voce.classList.toggle('active', scelta);
    voce.setAttribute('aria-checked', String(scelta));
    if (scelta && valore) valore.textContent = voce.textContent.trim();
  }
}

/*
 * Come si NAVIGA, in piano e nello spazio.
 *
 * In 2D la rotazione va tolta — altrimenti «piatto» sarebbe solo una
 * disposizione piana guardata di sbieco dopo il primo trascinamento — ma
 * toglierla e basta lascia l'utente FERMO: negli OrbitControls il trascinamento
 * col tasto sinistro È la rotazione, quindi disattivarla senza rimappare
 * significa che il gesto principale non fa più niente. In piano il trascinamento
 * diventa quindi uno SPOSTAMENTO sul piano X-Y, che è il gesto giusto quando
 * l'asse Z non esiste; la rotellina continua a ingrandire, e il tasto destro a
 * spostare come in 3D.
 *
 * Le costanti stanno in THREE (`MOUSE`, `TOUCH`); i numeri sono il ripiego se
 * la libreria non è stata caricata, e sono quelli che THREE stessa usa.
 */
function applicaNavigazione(controlli) {
  if (!controlli) return;
  const M = (typeof THREE !== 'undefined' && THREE.MOUSE) || { ROTATE: 0, DOLLY: 1, PAN: 2 };
  const T = (typeof THREE !== 'undefined' && THREE.TOUCH) || { ROTATE: 0, PAN: 1, DOLLY_PAN: 2 };
  controlli.enableRotate = !is2DMode;
  controlli.enablePan = true;
  controlli.enableZoom = true;
  // Lo spostamento segue lo schermo e non il piano dell'orizzonte: in una vista
  // dall'alto l'altra modalità sposterebbe lungo un asse che non si vede.
  controlli.screenSpacePanning = true;
  controlli.mouseButtons = {
    LEFT: is2DMode ? M.PAN : M.ROTATE,
    MIDDLE: M.DOLLY,
    RIGHT: M.PAN,
  };
  controlli.touches = {
    ONE: is2DMode ? T.PAN : T.ROTATE,
    TWO: T.DOLLY_PAN,
  };
}

/*
 * Il pannello laterale copre 340px sulla destra. Gli strumenti d'inquadratura
 * stanno sopra al canvas, in alto a destra: senza spostarsi finirebbero SOTTO
 * al pannello appena si sceglie una tabella, cioè proprio quando servono.
 */
function mostraPannelloLaterale(aperto) {
  const panel = $('#graph3d-side-panel');
  const container = panel && panel.closest('.graph3d-container');
  if (panel) panel.classList.toggle('hidden', !aperto);
  if (container) container.classList.toggle('pannello-aperto', !!aperto);
}

function updatePathUI() {
  const clearBtn = $('#graph3d-clear-path');
  const findBtn = $('#graph3d-find-path');
  const badge = $('#graph3d-path-badge');
  const badgeText = $('#graph3d-path-badge-text');
  const modalClearBtn = $('#path-modal-clear');

  if (activeShortestPath && activeShortestPath.nodes && activeShortestPath.nodes.length > 0) {
    if (clearBtn) clearBtn.classList.remove('hidden');
    if (findBtn) findBtn.classList.add('active');
    if (modalClearBtn) modalClearBtn.classList.remove('hidden');
    if (badge) {
      badge.classList.remove('hidden');
      if (badgeText) {
        badgeText.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Cammino (${activeShortestPath.nodes.length - 1} passaggi): ` +
          activeShortestPath.nodes.map((n) => `<b style="color:var(--status-ok);">${esc(n)}</b>`).join(' → ');
      }
    }
  } else {
    if (clearBtn) clearBtn.classList.add('hidden');
    if (findBtn) findBtn.classList.remove('active');
    if (modalClearBtn) modalClearBtn.classList.add('hidden');
    if (badge) badge.classList.add('hidden');
  }
}

export function clearShortestPath(silent = false) {
  activeShortestPath = null;
  const resDiv = $('#path-result');
  if (resDiv) resDiv.innerHTML = '';
  updatePathUI();
  renderGraph3d();
  if (!silent) {
    toast('Evidenziazione cammino rimossa.');
  }
}

const SCHEMA_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minuti

export function loadGraph3d(force) {
  if (!state.db) return;
  // La chiave deve contenere la CONNESSIONE: due tab aperti su database
  // omonimi (tipicamente "app" in produzione e in sviluppo) si scambiavano lo
  // schema, e il grafo mostrava le tabelle dell'altra macchina senza dirlo. Il
  // tabId non basta come sostituto — è la connessione a determinare lo schema —
  // ma è la chiave giusta per un tab su una connessione non salvata.
  const tab = activeTab();
  const chiaveConn = (tab && (tab.connName || tab.id)) || 'default';
  const cacheKey = `gui-db:schema-cache:${chiaveConn}:${state.db}`;

  if (!force) {
    const cachedText = sessionStorage.getItem(cacheKey);
    if (cachedText) {
      try {
        const cached = JSON.parse(cachedText);
        if (Date.now() - cached.timestamp < SCHEMA_CACHE_TTL_MS) {
          state.dbSchema = cached.data;
          state.dbSchemaFor = state.db;
          renderGraph3d();
          return;
        }
      } catch {
        sessionStorage.removeItem(cacheKey);
      }
    }
  }

  const canvas = $('#graph3d-canvas');
  if (canvas) {
    canvas.innerHTML = '<div class="uml-msg" style="color:var(--fg-dim); padding:20px;">Caricamento schema database…</div>';
  }

  emit('db:schema', {
    db: state.db, progressive: true,
    collectionLimit: GRAFO_BUDGET.nodes,
    fieldLimit: GRAFO_BUDGET.fields,
    relationLimit: GRAFO_BUDGET.links,
  })
    .then((res) => {
      if (res._tab && res._tab.state) {
        res._tab.state.dbSchema = res;
        res._tab.state.dbSchemaFor = res._tab.state.db;
      } else {
        state.dbSchema = res;
        state.dbSchemaFor = state.db;
      }
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify({
          timestamp: Date.now(),
          data: res,
        }));
      } catch (err) {
        console.warn('Impossibile salvare lo schema nella cache di sessione:', err);
      }
      // Il canvas 3D è unico: lo schema di un tab passato in background resta in
      // cache e verrà disegnato al ritorno, non sopra il grafo di un'altra
      // connessione.
      if (!isForActiveTab(res)) return;
      renderGraph3d();
    })
    .catch((err) => {
      if (canvas && isForActiveTab(err)) {
        canvas.innerHTML = `<div class="error" style="padding:20px;">${esc(err.message)}</div>`;
      }
    });
}

export function renderGraph3d({ preserveInstance = false } = {}) {
  const canvas = $('#graph3d-canvas');
  const sourceSchema = state.dbSchema || currentSchemaData;
  const { schema, policy } = degradaSchemaGrafo(sourceSchema);
  if (!schema || !schema.collections || !schema.collections.length) {
    if (canvas) {
      distruggiGrafo();
      canvas.innerHTML = '<div class="uml-msg" style="color:var(--fg-dim); padding:20px;">Nessuna tabella/collection trovata nello schema.</div>';
    }
    return;
  }

  currentSchemaData = sourceSchema;
  ultimaPolicy = policy;
  updatePathUI();
  aggiornaComandi();
  const aggiornaInPosto = preserveInstance && !!graphInstance;
  if (!aggiornaInPosto) {
    distruggiGrafo();
    canvas.innerHTML = '';
  } else {
    canvas.querySelector('.graph3d-budget-badge')?.remove();
  }

  // `hopFilter` è lo stato del modulo: qui si legge e basta.

  const neighborsMap = new Map();
  const degreeMap = new Map();
  for (const c of schema.collections) {
    neighborsMap.set(c.name, new Set());
    degreeMap.set(c.name, 0);
  }

  const allRelations = [...(schema.relations || [])];

  if (showImplicitRelations) {
    const implicitRels = detectImplicitRelations(schema.collections, allRelations);
    allRelations.push(...implicitRels);
  }

  for (const r of allRelations) {
    if (neighborsMap.has(r.from)) neighborsMap.get(r.from).add(r.to);
    if (neighborsMap.has(r.to)) neighborsMap.get(r.to).add(r.from);
    degreeMap.set(r.from, (degreeMap.get(r.from) || 0) + 1);
    degreeMap.set(r.to, (degreeMap.get(r.to) || 0) + 1);
  }

  let activeNodesSet = null;
  if (selectedNodeId && hopFilter !== 'all') {
    const maxHops = parseInt(hopFilter, 10) || 1;
    activeNodesSet = getNodesWithinHops(selectedNodeId, maxHops, neighborsMap);
  }

  const nodes = schema.collections
    .filter((c) => {
      if (hideEmptyTables && tabellaVuota(c)) return false;
      if (activeNodesSet && !activeNodesSet.has(c.name)) return false;
      return true;
    })
    .map((c) => {
      const degree = degreeMap.get(c.name) || 0;
      let val = 5;
      if (colorMode === 'degree') {
        val = Math.max(4, Math.min(22, 4 + degree * 3.5));
      } else {
        val = Math.max(3, Math.min(15, (c.fields && c.fields.length) || 5));
      }
      const nodeObj = {
        id: c.name,
        name: c.name,
        degree,
        fieldCount: (c.fields && c.fields.length) || 0,
        fields: c.fields || [],
        val,
      };
      return nodeObj;
    });

  const nodeIdsSet = new Set(nodes.map((n) => n.id));
  const edges = allRelations
    .filter((r) => nodeIdsSet.has(r.from) && nodeIdsSet.has(r.to))
    .map((r) => ({
      source: r.from,
      target: r.to,
      label: r.field,
      many: r.many,
      implicit: !!r.implicit,
    }));

  const graphData = { nodes, links: edges };

  if (typeof ForceGraph3D === 'undefined') {
    canvas.innerHTML = '<div class="error" style="padding:20px;">Libreria 3D Force Graph non disponibile.</div>';
    return;
  }

  /*
   * Tavolozza dei nodi: NON segue il tema, come quella dei grafici. Sono
   * colori d'identità (un colore per prefisso di tabella) scelti per essere
   * distinguibili fra loro, mentre i token del tema li sceglie l'utente: un
   * tema personalizzato non deve poter rendere due tabelle dello stesso
   * colore. Sono tinte sature di media luminosità, leggibili sia sul fondo
   * scuro sia su quello chiaro.
   */
  const prefixColors = ['#4a9eff', '#50e3c2', '#f5a623', '#b8e986', '#bd10e0', '#9013fe', '#e65100', '#ff4081', '#00e676'];

  /*
   * Ciò che invece il tema DEVE decidere è come si spegne un nodo fuori
   * selezione: era un grigio-blu scuro fisso, cioè "quasi il fondo" solo
   * finché il fondo era scuro. Sul tema chiaro quegli stessi valori sono
   * macchie scure su bianco — l'esatto contrario dell'attenuare.
   */
  const spento = tokenTema('--graph-dim', 'rgba(50, 55, 65, 0.25)');
  const spentoForte = tokenTema('--graph-dim-strong', 'rgba(40, 45, 55, 0.2)');
  const spentoArco = tokenTema('--graph-dim-link', 'rgba(40, 45, 55, 0.15)');
  const spentoArcoDebole = tokenTema('--graph-dim-link-weak', 'rgba(30, 35, 45, 0.12)');
  const coloreArco = tokenTema('--graph-link-active', '#4a9eff');
  /*
   * Il fondo della scena lo dipinge il RENDERER WebGL, non il CSS: la regola
   * `.graph3d-canvas { background: var(--bg-1) }` sta dietro a un canvas che è
   * opaco, quindi non si vede mai. Il predefinito di 3d-force-graph è un blu
   * quasi nero, ed è la ragione per cui col tema chiaro il grafo restava scuro:
   * l'unico elemento della UI che il tema non raggiungeva. `backgroundColor`
   * vuole un colore che THREE sappia leggere — i token del tema sono `#rrggbb`,
   * e `Color` li accetta.
   */
  const sfondo = tokenTema('--bg-1', '#0b0f14');

  const pathNodeSet = activeShortestPath ? new Set(activeShortestPath.nodes) : null;
  const pathEdgeSet = activeShortestPath ? new Set(activeShortestPath.edges) : null;

  /*
   * `controlType: 'orbit'`. Il predefinito di 3d-force-graph è «trackball», e
   * i TrackballControls **non hanno `autoRotate`**: assegnare
   * `controls().autoRotate = true` scriveva una proprietà che nessuno legge,
   * quindi il comando «Rotazione automatica» non ha mai fatto assolutamente
   * nulla — non era una questione di grafi troppo grandi. Gli OrbitControls
   * quella proprietà la implementano, e `tick()` chiama `controls.update()` a
   * ogni fotogramma, che è ciò che la rotazione richiede per avanzare.
   * In più l'orbita è il modello di navigazione giusto per un grafo: si gira
   * intorno a un centro, non si fa rotolare la scena.
   */
  graphInstance = (aggiornaInPosto
    ? graphInstance.graphData(graphData)
    : ForceGraph3D({ preserveDrawingBuffer: true, controlType: 'orbit' })(canvas).graphData(graphData))
    .nodeId('id')
    .backgroundColor(sfondo)
    /*
     * La vista 2D è una proprietà della SIMULAZIONE, non della telecamera.
     * Prima si fissava `fz = 0` su ogni nodo e si spostava la telecamera: le
     * forze restavano a tre dimensioni, quindi il grafo continuava a essere
     * disposto nello spazio e l'unico effetto visibile era un ridisegno.
     * `numDimensions(2)` fa girare la disposizione sul piano.
     */
    .numDimensions(is2DMode ? 2 : 3)
    .nodeLabel((node) => `<div style="background:var(--bg-elevated); padding:8px 12px; border-radius:6px; border:1px solid var(--accent); font-family:sans-serif; color:var(--fg); font-size:12px;"><b>${esc(node.name)}</b><br/><small style="color:var(--fg-dim);">${node.fieldCount} campi • ${node.degree} relazioni</small></div>`)
    .nodeColor((node) => {
      if (pathNodeSet) {
        return pathNodeSet.has(node.id) ? '#00e676' : spentoForte;
      }
      if (selectedNodeId && selectedNodeId !== node.id && !isNeighbor(selectedNodeId, node.id, neighborsMap)) {
        return spento;
      }
      if (colorMode === 'degree') {
        return getDegreeColor(node.degree);
      }
      const prefix = getTablePrefix(node.name);
      return prefixColors[Math.abs(hashString(prefix)) % prefixColors.length];
    })
    .nodeRelSize(4)
    .linkDirectionalParticles((link) => {
      const edgeKey = `${typeof link.source === 'object' ? link.source.id : link.source}->${typeof link.target === 'object' ? link.target.id : link.target}`;
      if (policy.reducedEffects) return 0;
      if (pathEdgeSet && pathEdgeSet.has(edgeKey)) return 6;
      return link.implicit ? 4 : 2;
    })
    .linkDirectionalParticleSpeed((link) => (link.implicit ? 0.012 : 0.006))
    .linkLabel((link) => `<span style="color:var(--fg-dim);">${esc(link.label)}${link.implicit ? ' (Implicita)' : ''}${link.many ? ' [N]' : ''}</span>`)
    .linkColor((link) => {
      const srcId = typeof link.source === 'object' ? link.source.id : link.source;
      const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
      const edgeKeyForward = `${srcId}->${tgtId}`;
      const edgeKeyBackward = `${tgtId}->${srcId}`;

      if (pathEdgeSet && (pathEdgeSet.has(edgeKeyForward) || pathEdgeSet.has(edgeKeyBackward))) {
        return '#00e676';
      }
      if (pathEdgeSet) {
        return spentoArcoDebole;
      }
      if (link.implicit) return '#bd10e0';
      if (selectedNodeId && srcId !== selectedNodeId && tgtId !== selectedNodeId) {
        return spentoArco;
      }
      return coloreArco;
    })
    .linkWidth((link) => {
      const srcId = typeof link.source === 'object' ? link.source.id : link.source;
      const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
      const edgeKeyForward = `${srcId}->${tgtId}`;
      const edgeKeyBackward = `${tgtId}->${srcId}`;

      if (pathEdgeSet && (pathEdgeSet.has(edgeKeyForward) || pathEdgeSet.has(edgeKeyBackward))) {
        return 4.2;
      }
      return selectedNodeId && (srcId === selectedNodeId || tgtId === selectedNodeId) ? 2.8 : 1.2;
    })
    .onNodeClick((node) => {
      selectedNodeId = node.id;
      const distance = is2DMode ? 200 : 120;
      const distRatio = 1 + distance / Math.hypot(node.x, node.y, (is2DMode ? 0 : node.z) || 1);
      graphInstance.cameraPosition(
        { x: node.x * distRatio, y: node.y * distRatio, z: is2DMode ? 300 : (node.z || 0) * distRatio },
        { x: node.x, y: node.y, z: is2DMode ? 0 : node.z || 0 },
        1200
      );

      showTableDetailsPanel(node.name, currentSearchQuery);
      // Con una tabella scelta il filtro dei vicini diventa esprimibile.
      aggiornaComandi();
      graphInstance.nodeColor(graphInstance.nodeColor()).linkWidth(graphInstance.linkWidth());
    });

  const controlli = graphInstance.controls && graphInstance.controls();
  if (is2DMode) {
    graphInstance.cameraPosition({ x: 0, y: 0, z: 350 }, { x: 0, y: 0, z: 0 }, 500);
  }
  applicaNavigazione(controlli);
  // Quando la disposizione si ferma si inquadra tutto: passando a 2D il grafo
  // si distende sul piano e occupa un'area diversa da quella di prima.
  if (typeof graphInstance.onEngineStop === 'function') {
    const mia = graphInstance;
    graphInstance.onEngineStop(() => {
      if (graphInstance === mia && typeof mia.zoomToFit === 'function') mia.zoomToFit(600, 60);
    });
  }

  // Le etichette sono l'informazione del grafo: un grafo di tabelle senza i
  // nomi delle tabelle non è alleggerito, è illeggibile. Restano accese fino
  // a un tetto proprio, molto più alto di quello degli effetti.
  if (typeof THREE !== 'undefined' && policy.etichette !== false) {
    graphInstance.nodeThreeObject((node) => {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: createTextTexture(node.name),
          depthTest: false,
        })
      );
      sprite.scale.set(36, 18, 1);
      sprite.position.y = 12;
      return sprite;
    });
    graphInstance.nodeThreeObjectExtend(true);
  } else if (graphInstance.nodeThreeObject) {
    graphInstance.nodeThreeObject(null);
    graphInstance.nodeThreeObjectExtend(false);
  }

  // La rotazione automatica non dipende dalla dimensione del grafo. Sopravvive
  // al ridisegno perché l'istanza viene ricreata a ogni render: senza questa
  // riapplicazione, cambiare colore o filtro la spegneva in silenzio.
  if (controlli) {
    controlli.autoRotate = !!autoRotateActive;
    controlli.autoRotateSpeed = 1.5;
  }

  if (policy.incomplete) {
    const badge = document.createElement('div');
    badge.className = 'uml-msg graph3d-budget-badge';
    badge.style.cssText = 'position:absolute;z-index:3;left:12px;top:12px;padding:8px 10px;';
    const page = sourceSchema.schemaPage || {};
    badge.innerHTML = `Vista ridotta entro budget (${schema.collections.length} nodi, ${schema.relations.length} relazioni). `
      + (page.nextCursor != null ? '<button type="button">Carica la porzione successiva</button>' : 'Seleziona un nodo per caricarne i dettagli.');
    const button = badge.querySelector('button');
    if (button) button.onclick = async () => {
      button.disabled = true;
      try {
        const next = await emit('db:schema', {
          db: state.db, progressive: true, cursor: page.nextCursor,
          collectionLimit: GRAFO_BUDGET.nodes, fieldLimit: GRAFO_BUDGET.fields,
          relationLimit: GRAFO_BUDGET.links,
        });
        state.dbSchema = unisciPagineSchema(state.dbSchema, next);
        renderGraph3d({ preserveInstance: true });
      } catch (err) { button.textContent = err.message; }
    };
    canvas.appendChild(badge);
  }

  // Un solo osservatore per tutta la vita della pagina: crearne uno per
  // ridisegno lasciava in vita quelli precedenti, che continuavano a chiamare
  // .width()/.height() su istanze ormai orfane.
  if (graphResizeObserver) graphResizeObserver.disconnect();
  graphResizeObserver = new ResizeObserver(() => {
    if (graphInstance && canvas && canvas.clientWidth > 0) {
      graphInstance.width(canvas.clientWidth);
      graphInstance.height(canvas.clientHeight);
    }
  });
  graphResizeObserver.observe(canvas);
}

// L'euristica vive nel modulo condiviso: qui basta sapere SE il campo e'
// sensibile. La ricerca per sottostringa marcava "author", "passenger" e
// "authorized_at" come dati personali (`pass`, `auth`), e la stessa regola
// esisteva in una seconda versione, più ampia, nel gateway MCP.
function isPIIField(fieldName) {
  return terminePii(fieldName) !== null;
}

function getTablePrefix(name) {
  const parts = name.split('_');
  return parts.length > 1 ? parts[0] : name;
}

function getDegreeColor(degree) {
  if (degree <= 1) return '#4a9eff';
  if (degree <= 3) return '#50e3c2';
  if (degree <= 5) return '#f5a623';
  return '#e5534b';
}

function isNeighbor(id1, id2, map) {
  const set = map.get(id1);
  return set ? set.has(id2) : false;
}

function getNodesWithinHops(startId, maxHops, map) {
  const result = new Set([startId]);
  let currentLevel = new Set([startId]);

  for (let hop = 0; hop < maxHops; hop++) {
    const nextLevel = new Set();
    for (const nodeId of currentLevel) {
      const neighbors = map.get(nodeId);
      if (neighbors) {
        for (const n of neighbors) {
          if (!result.has(n)) {
            result.add(n);
            nextLevel.add(n);
          }
        }
      }
    }
    currentLevel = nextLevel;
  }
  return result;
}

function showTableDetailsPanel(tableName, highlightQuery) {
  const panel = $('#graph3d-side-panel');
  const title = $('#graph3d-panel-title');
  const content = $('#graph3d-panel-content');
  const schema = state.dbSchema || currentSchemaData;
  if (!panel || !schema) return;

  const collection = schema.collections.find((c) => c.name === tableName);
  if (!collection) return;

  title.textContent = collection.name;

  let html = '';

  html += `<div class="side-panel-section">
    <h4>Campi / Colonne (${collection.fields.length})</h4>
    <ul class="side-panel-fields">`;
  for (const f of collection.fields) {
    const isPk = f.pk || f.name === '_id';
    const isPii = isPIIField(f.name);
    const typeStr = (f.types || []).join(' | ') || 'any';
    const isMatched = highlightQuery && f.name.toLowerCase().includes(highlightQuery.toLowerCase());
    const highlightStyle = isMatched ? 'style="background: var(--status-info-bg); border: 1px solid var(--status-info);"' : '';

    html += `<li ${highlightStyle}>
      <span class="field-name">${esc(f.name)} ${isPii ? '<span title="Campo sensibile (PII/GDPR)" style="color:var(--status-warn);font-size:0.75rem;font-weight:600;border:1px solid var(--status-warn-bd);border-radius:2px;padding:1px 4px;">PII</span>' : ''} ${isMatched ? '<span style="color:var(--status-info);font-size:0.75rem;">●</span>' : ''}</span>
      <span>
        ${isPk ? '<span class="field-badge pk">PK</span> ' : ''}
        <span class="field-badge">${esc(typeStr)}</span>
      </span>
    </li>`;
  }
  html += `</ul>`;
  if (collection.fieldsPage && !collection.fieldsPage.complete) {
    html += `<button type="button" id="graph3d-load-node-fields">Carica gli altri ${collection.fieldsPage.omitted} campi</button>`;
  }
  html += `</div>`;

  const rels = (schema.relations || []).filter((r) => r.from === tableName || r.to === tableName);
  if (rels.length) {
    html += `<div class="side-panel-section">
      <h4>Relazioni (${rels.length})</h4>
      <ul class="side-panel-fields">`;
    for (const r of rels) {
      const isOutgoing = r.from === tableName;
      const target = isOutgoing ? r.to : r.from;
      const arrow = isOutgoing ? '→' : '←';
      html += `<li>
        <span><strong style="color:var(--status-info)">${arrow}</strong> ${esc(target)}</span>
        <span class="field-badge" style="cursor:pointer;" data-jump-node="${esc(target)}" title="Centra nel grafo 3D">${esc(r.field)}</span>
      </li>`;
    }
    html += `</ul></div>`;
  }

  html += `<div class="side-panel-actions">
    <button type="button" id="panel-btn-open-grid" class="primary" style="flex:1;">▤ Apri Tab Dati</button>
    <button type="button" id="panel-btn-open-uml" class="ghost" style="flex:1;">◫ Apri Tab UML</button>
  </div>`;

  content.innerHTML = html;
  mostraPannelloLaterale(true);
  const loadFields = $('#graph3d-load-node-fields');
  if (loadFields) loadFields.onclick = async () => {
    loadFields.disabled = true;
    try {
      const page = await emit('db:schema', {
        db: state.db, progressive: true, focus: tableName,
        collectionLimit: 1, fieldLimit: 200, relationLimit: GRAFO_BUDGET.links,
      });
      state.dbSchema = unisciPagineSchema(state.dbSchema, page, { preservePagination: true });
      currentSchemaData = state.dbSchema;
      const data = graphInstance && graphInstance.graphData();
      const node = data && data.nodes.find((item) => item.id === tableName);
      const updated = state.dbSchema.collections.find((item) => item.name === tableName);
      if (node && updated) {
        node.fields = updated.fields;
        node.fieldCount = updated.fields.length;
        graphInstance.graphData(data);
      }
      showTableDetailsPanel(tableName, highlightQuery);
    } catch (err) {
      loadFields.disabled = false;
      loadFields.textContent = err.message;
    }
  };

  content.querySelectorAll('[data-jump-node]').forEach((el) => {
    el.addEventListener('click', () => {
      const targetName = el.dataset.jumpNode;
      selectedNodeId = targetName;
      if (!graphInstance) return;
      const targetNode = graphInstance.graphData().nodes.find((n) => n.name === targetName);
      if (targetNode && targetNode.x != null) {
        const distance = 120;
        const distRatio = 1 + distance / Math.hypot(targetNode.x, targetNode.y, targetNode.z || 1);
        graphInstance.cameraPosition(
          { x: targetNode.x * distRatio, y: targetNode.y * distRatio, z: (targetNode.z || 0) * distRatio },
          { x: targetNode.x, y: targetNode.y, z: targetNode.z || 0 },
          1200
        );
        showTableDetailsPanel(targetName, currentSearchQuery);
      }
    });
  });

  const openGridBtn = $('#panel-btn-open-grid');
  if (openGridBtn) {
    openGridBtn.addEventListener('click', () => {
      if (state.db) {
        openCollTab(state.db, tableName);
        setView('data');
      }
    });
  }

  const openUmlBtn = $('#panel-btn-open-uml');
  if (openUmlBtn) {
    openUmlBtn.addEventListener('click', () => {
      if (state.db) {
        openCollTab(state.db, tableName);
        setView('uml');
      }
    });
  }
}

// 1. Shortest Path Finder (BFS Algorithm)
function computeShortestPath(startNode, endNode) {
  const schema = state.dbSchema || currentSchemaData;
  if (!schema || !schema.collections) return null;

  const adj = new Map();
  for (const c of schema.collections) adj.set(c.name, []);

  const rels = [...(schema.relations || [])];
  if (showImplicitRelations) {
    rels.push(...detectImplicitRelations(schema.collections, rels));
  }

  for (const r of rels) {
    if (adj.has(r.from)) adj.get(r.from).push({ to: r.to, field: r.field });
    if (adj.has(r.to)) adj.get(r.to).push({ to: r.from, field: r.field });
  }

  const queue = [[startNode]];
  const visited = new Set([startNode]);

  while (queue.length > 0) {
    const path = queue.shift();
    const curr = path[path.length - 1];

    if (curr === endNode) {
      const edges = [];
      for (let i = 0; i < path.length - 1; i++) {
        edges.push(`${path[i]}->${path[i + 1]}`);
      }
      return { nodes: path, edges };
    }

    const neighbors = adj.get(curr) || [];
    for (const n of neighbors) {
      if (!visited.has(n.to)) {
        visited.add(n.to);
        queue.push([...path, n.to]);
      }
    }
  }
  return null;
}

// 3. Matrice delle Dipendenze (Topological Sort / Root & Leaf)
function analyzeDependencies() {
  const schema = state.dbSchema || currentSchemaData;
  if (!schema || !schema.collections || !schema.collections.length) {
    toast('Nessuno schema disponibile per le dipendenze.', true);
    return;
  }

  // Il calcolo sta nel modulo condiviso: qui resta solo il disegno. Prima era
  // scritto due volte — qui e nel gateway MCP — con lo stesso ordinamento
  // topologico sbagliato in entrambe le copie.
  const dip = calcolaDipendenze(schema, showImplicitRelations);
  const rootTables = dip.root_tables;
  const leafTables = dip.leaf_tables;
  const seedOrder = dip.seeding_order;
  const inCiclo = dip.cyclic_tables;

  let html = `<div style="margin-bottom:14px;">
    <h3 style="margin:0 0 4px 0; color:var(--fg,#e1e4e8);">Analisi Architetturale Dipendenze</h3>
    <small style="color:var(--fg-dim,#8b949e);">Identificazione tabelle Root/Leaf e sequenza ottima per seeding e svuotamento.</small>
  </div>`;

  html += `<div class="audit-issue-item" style="border-left-color:var(--status-ok); margin-bottom:12px;">
    <div class="audit-issue-title" style="color:var(--status-ok);">▸ ROOT — Tabelle indipendenti (${rootTables.length}) senza FK uscenti</div>
    <div class="audit-issue-desc">${rootTables.map((r) => `<b>${esc(r)}</b>`).join(', ') || 'Nessuna'}</div>
  </div>`;

  html += `<div class="audit-issue-item" style="border-left-color:var(--status-info); margin-bottom:12px;">
    <div class="audit-issue-title" style="color:var(--status-info);">▸ LEAF — Tabelle terminali (${leafTables.length})</div>
    <div class="audit-issue-desc">${leafTables.map((l) => `<b>${esc(l)}</b>`).join(', ') || 'Nessuna'}</div>
  </div>`;

  html += `<div class="audit-issue-item" style="border-left-color:var(--status-warn);">
    <div class="audit-issue-title" style="color:var(--status-warn);">⟳ Sequenza Ottima di Popolamento (Seeding)</div>
    <div class="audit-issue-desc">
      <ol style="margin:6px 0 0 18px; padding:0; color:var(--fg,#e1e4e8);">
        ${seedOrder.map((s) => `<li style="padding:2px 0;"><b>${esc(s)}</b></li>`).join('')}
      </ol>
    </div>
  </div>`;

  if (inCiclo.length) {
    html += `<div class="audit-issue-item" style="border-left-color:var(--danger); margin-top:12px;">
      <div class="audit-issue-title" style="color:var(--danger);">⚠ Ciclo di chiavi esterne (${inCiclo.length} tabelle)</div>
      <div class="audit-issue-desc">
        Queste tabelle dipendono l'una dall'altra e <b>non hanno un ordine di popolamento valido</b>:
        ${inCiclo.map((n) => `<b>${esc(n)}</b>`).join(', ')}.<br/>
        Vanno inserite in più passaggi (prima le righe con la FK a NULL, poi l'aggiornamento) oppure
        con i vincoli temporaneamente disattivati.
      </div>
    </div>`;
  }

  if (dip.blocked_by_cycles.length) {
    html += `<div class="audit-issue-item" style="border-left-color:var(--status-warn); margin-top:12px;">
      <div class="audit-issue-title" style="color:var(--status-warn);">Tabelle bloccate da un ciclo (${dip.blocked_by_cycles.length})</div>
      <div class="audit-issue-desc">
        Non appartengono al ciclo, ma dipendono da una tabella ciclica e quindi non entrano nella sequenza di popolamento:
        ${dip.blocked_by_cycles.map((n) => `<b>${esc(n)}</b>`).join(', ')}.
      </div>
    </div>`;
  }

  if (dip.external_dependencies.length) {
    const etichettaRelazione = (r) => {
      const origine = [r.fromDb, r.from].filter(Boolean).map(esc).join('.');
      const destinazione = [r.toDb, r.to].filter(Boolean).map(esc).join('.');
      return `<li><b>${origine || 'origine esterna'}</b> → <b>${destinazione || 'destinazione esterna'}</b></li>`;
    };
    html += `<div class="audit-issue-item" style="border-left-color:var(--status-info); margin-top:12px;">
      <div class="audit-issue-title" style="color:var(--status-info);">Dipendenze esterne allo schema (${dip.external_dependencies.length})</div>
      <div class="audit-issue-desc">
        Sono mostrate separatamente e non alterano root, leaf o ordine di popolamento dello schema corrente.
        <ul style="margin:6px 0 0 18px; padding:0;">${dip.external_dependencies.map(etichettaRelazione).join('')}</ul>
      </div>
    </div>`;
  }

  const depsContent = $('#deps-content');
  if (depsContent) {
    depsContent.innerHTML = html;
    $('#deps-modal').classList.remove('hidden');
  }
}

function runSchemaAudit() {
  const schema = state.dbSchema || currentSchemaData;
  if (!schema || !schema.collections || !schema.collections.length) {
    toast('Nessuno schema disponibile per la diagnostica.', true);
    return;
  }

  // Il calcolo sta nel modulo condiviso col gateway MCP (una copia sola), e le
  // penalità sono PROPORZIONALI alla dimensione dello schema: con quelle
  // assolute il punteggio non poteva scendere sotto 20 e tre tabelle orfane
  // costavano uguale su tre tabelle e su trecento.
  //
  // Le relazioni IMPLICITE contano davvero quando l'opzione è attiva: il testo
  // diceva «alcuna relazione dichiarata o implicita» ma il conteggio usava le
  // sole schema.relations, quindi una tabella collegata da un `cliente_id`
  // risultava orfana e faceva perdere punti per un difetto che non ha.
  const relazioni = [...(schema.relations || [])];
  if (showImplicitRelations) relazioni.push(...detectImplicitRelations(schema.collections, relazioni));
  const salute = calcolaSalute({ collections: schema.collections, relations: relazioni });
  let score = salute.health_score;
  const issues = salute.issues.map((x) => ({ type: x.type, title: x.title, desc: esc(x.description) }));

  score = Math.max(0, score);
  let scoreClass = 'audit-score-good';
  if (score < 80) scoreClass = 'audit-score-warn';
  if (score < 50) scoreClass = 'audit-score-bad';

  let html = `<div class="audit-score-card">
    <div class="audit-score-val ${scoreClass}">${score}%</div>
    <div>
      <h3 style="margin:0; color:var(--fg,#e1e4e8);">Punteggio Salute Schema</h3>
      <small style="color:var(--fg-dim,#8b949e);">${schema.collections.length} tabelle analizzate, ${relazioni.length} relazioni controllate${showImplicitRelations ? ' (implicite comprese)' : ''}.</small>
    </div>
  </div>`;

  if (!issues.length) {
    html += `<div class="audit-issue-item" style="border-left-color:var(--status-ok);">
      <div class="audit-issue-title" style="color:var(--status-ok);">✓ Nessun problema rilevato!</div>
      <div class="audit-issue-desc">Lo schema rispetta tutte le best practice di strutturazione.</div>
    </div>`;
  } else {
    for (const issue of issues) {
      html += `<div class="audit-issue-item ${issue.type}">
        <div class="audit-issue-title">${issue.title}</div>
        <div class="audit-issue-desc">${issue.desc}</div>
      </div>`;
    }
  }

  const modalContent = $('#audit-content');
  if (modalContent) {
    modalContent.innerHTML = html;
    $('#audit-modal').classList.remove('hidden');
  }
}

function saveSchemaSnapshotLocal() {
  const schema = state.dbSchema || currentSchemaData;
  if (!schema) {
    toast('Nessuno schema disponibile da salvare.', true);
    return;
  }
  const payload = {
    db: state.db || 'database',
    dbType: state.dbType || 'mysql',
    timestamp: new Date().toISOString(),
    collections: schema.collections,
    relations: schema.relations || [],
  };

  const jsonText = JSON.stringify(payload, null, 2);
  const blob = new Blob([jsonText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `schema-snapshot-${state.db || 'db'}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`File snapshot "schema-snapshot-${state.db || 'db'}.json" salvato sul tuo computer!`);
}

function renderDiffReport(snapshot) {
  const activeSchema = state.dbSchema || currentSchemaData;
  if (!activeSchema || !snapshot || !snapshot.collections) return;

  const snapTables = new Map(snapshot.collections.map((c) => [c.name, c]));
  const activeTables = new Map(activeSchema.collections.map((c) => [c.name, c]));

  const addedTables = [];
  const removedTables = [];
  const modifiedTables = [];

  for (const [name, activeCol] of activeTables.entries()) {
    if (!snapTables.has(name)) {
      addedTables.push(name);
    } else {
      const snapCol = snapTables.get(name);
      const snapFields = new Set((snapCol.fields || []).map((f) => f.name));
      const activeFields = new Set((activeCol.fields || []).map((f) => f.name));
      const addedFields = [...activeFields].filter((f) => !snapFields.has(f));
      const removedFields = [...snapFields].filter((f) => !activeFields.has(f));

      if (addedFields.length || removedFields.length) {
        modifiedTables.push({ name, addedFields, removedFields });
      }
    }
  }

  for (const name of snapTables.keys()) {
    if (!activeTables.has(name)) {
      removedTables.push(name);
    }
  }

  let html = `<div style="font-size:0.95rem; margin-bottom:12px; color:var(--fg-dim,#8b949e);">Risultato del confronto tra lo schema corrente ed il file JSON locale.</div>`;

  if (!addedTables.length && !removedTables.length && !modifiedTables.length) {
    html += `<div class="audit-issue-item" style="border-left-color:var(--status-ok);">
      <div class="audit-issue-title" style="color:var(--status-ok);">✓ Schemi identici</div>
      <div class="audit-issue-desc">Nessuna differenza trovata rispetto al file JSON selezionato.</div>
    </div>`;
  } else {
    for (const t of addedTables) {
      html += `<div class="audit-issue-item" style="border-left-color:var(--status-ok);">
        <div class="audit-issue-title"><span class="diff-tag diff-added">+ TABELLA AGGIUNTA</span> ${esc(t)}</div>
      </div>`;
    }
    for (const t of removedTables) {
      html += `<div class="audit-issue-item" style="border-left-color:var(--danger);">
        <div class="audit-issue-title"><span class="diff-tag diff-removed">- TABELLA RIMOSSA</span> ${esc(t)}</div>
      </div>`;
    }
    for (const m of modifiedTables) {
      html += `<div class="audit-issue-item" style="border-left-color:var(--status-warn);">
        <div class="audit-issue-title"><span class="diff-tag diff-changed">~ TABELLA MODIFICATA</span> ${esc(m.name)}</div>
        <div class="audit-issue-desc">
          ${m.addedFields.length ? `<span style="color:var(--status-ok);">+ Campi aggiunti: ${m.addedFields.map(esc).join(', ')}</span><br/>` : ''}
          ${m.removedFields.length ? `<span style="color:var(--danger);">- Campi rimossi: ${m.removedFields.map(esc).join(', ')}</span>` : ''}
        </div>
      </div>`;
    }
  }

  const diffContent = $('#diff-content');
  if (diffContent) {
    diffContent.innerHTML = html;
  }
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function createTextTexture(text) {
  const inCache = textTextureCache.get(text);
  if (inCache) return inCache;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  // Targhetta del nodo: è un canvas vero, quindi i colori vanno LETTI dai
  // token. Con i valori fissi di prima, sul tema chiaro ogni etichetta restava
  // una placca blu-notte con scritta bianca in mezzo a un grafo chiaro.
  ctx.fillStyle = tokenTema('--graph-label-bg', 'rgba(15, 20, 28, 0.85)');
  ctx.strokeStyle = tokenTema('--graph-label-bd', '#4a9eff');
  ctx.lineWidth = 4;
  if (ctx.roundRect) {
    ctx.roundRect(4, 4, 248, 120, 12);
  } else {
    ctx.rect(4, 4, 248, 120);
  }
  ctx.fill();
  ctx.stroke();

  ctx.font = 'Bold 28px sans-serif';
  ctx.fillStyle = tokenTema('--graph-label-fg', '#ffffff');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const truncated = text.length > 15 ? text.slice(0, 13) + '…' : text;
  ctx.fillText(truncated, 128, 64);

  const texture = new THREE.CanvasTexture(canvas);
  textTextureCache.set(text, texture);
  return texture;
}

export function initGraph3d() {
  /*
   * Al cambio tema il grafo va RICOSTRUITO, non solo ridisegnato: i colori
   * spenti e quelli degli archi vengono letti una volta sola quando si crea
   * l'istanza, e le targhette dei nodi sono texture memorizzate per nome —
   * senza svuotare la cache resterebbero le placche del tema precedente anche
   * dopo il ridisegno, che è il difetto più difficile da attribuire al tema.
   * `renderGraph3d` chiama `distruggiGrafo`, che la svuota già.
   * Solo se il grafo è davvero in vita: altrimenti ogni cambio tema pagherebbe
   * la ricostruzione di una vista che nessuno sta guardando.
   */
  document.addEventListener('codedb:tema', () => {
    if (graphInstance && $('#graph3d-canvas')) renderGraph3d();
  });

  const searchInput = $('#graph3d-search');
  const searchClear = $('#graph3d-search-clear');
  const searchEsito = $('#graph3d-search-esito');

  const eseguiRicerca = () => {
    if (!searchInput) return;
    currentSearchQuery = searchInput.value.trim().toLowerCase();
    if (searchClear) searchClear.classList.toggle('hidden', !searchInput.value);

    const schema = state.dbSchema || currentSchemaData;
    if (!graphInstance || !schema) {
      if (searchEsito) { searchEsito.textContent = ''; searchEsito.classList.remove('assente'); }
      return;
    }

    const risultato = cercaNodo(graphInstance.graphData().nodes, currentSearchQuery);
    if (searchEsito) {
      searchEsito.textContent = messaggioRicerca(risultato);
      // «Nessuna corrispondenza» è un esito, non un errore: si dichiara, non
      // si urla. Prima non veniva detto affatto, e una ricerca a vuoto era
      // indistinguibile da una non ancora scritta.
      searchEsito.classList.toggle('assente', risultato.esito === 'assente');
    }

    const targetNode = risultato.nodo;
    if (targetNode && targetNode.x != null) {
      selectedNodeId = targetNode.id;
      const distance = 100;
      const distRatio = 1 + distance / Math.hypot(targetNode.x, targetNode.y, targetNode.z || 1);
      graphInstance.cameraPosition(
        { x: targetNode.x * distRatio, y: targetNode.y * distRatio, z: (targetNode.z || 0) * distRatio },
        { x: targetNode.x, y: targetNode.y, z: targetNode.z || 0 },
        1200
      );
      showTableDetailsPanel(targetNode.name, currentSearchQuery);
      aggiornaComandi();
    }
  };

  if (searchInput) searchInput.addEventListener('input', eseguiRicerca);
  if (searchClear) {
    searchClear.addEventListener('click', () => {
      if (!searchInput) return;
      searchInput.value = '';
      searchInput.focus();
      eseguiRicerca();
    });
  }
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && searchInput.value) {
        e.stopPropagation();
        searchInput.value = '';
        eseguiRicerca();
      }
    });
  }

  // Colorazione: due bottoni che dichiarano insieme quale dei due è in vigore.
  for (const btn of document.querySelectorAll('.graph3d-bar .grafo-seg[data-colore]')) {
    btn.addEventListener('click', () => {
      if (colorMode === btn.dataset.colore) return;
      colorMode = btn.dataset.colore;
      aggiornaComandi();
      renderGraph3d();
    });
  }

  const hopMenu = $('#graph3d-hop-menu');
  if (hopMenu) {
    hopMenu.addEventListener('click', (e) => {
      const voce = e.target.closest('[data-salti]');
      if (!voce || voce.dataset.salti === hopFilter) return;
      hopFilter = voce.dataset.salti;
      dipingiVicini();
      renderGraph3d();
    });
  }

  // Inizializzazione dropdown della toolbar del Grafo 3D
  const setupToolbarDropdown = (btnId, menuId) => {
    const btn = $(btnId);
    const menu = $(menuId);
    if (!btn || !menu) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = menu.classList.contains('hidden');
      document.querySelectorAll('.toolbar-dropdown-menu, .app-menu').forEach((m) => m.classList.add('hidden'));
      // `aria-expanded` va riportato su TUTTI i trigger, non solo su questo:
      // la riga sopra ha appena chiuso anche il menu dell'altro.
      document.querySelectorAll('.dropdown-trigger-btn[aria-expanded]').forEach((t) => t.setAttribute('aria-expanded', 'false'));

      if (isHidden) {
        positionFixedDropdown(btn, menu);
        btn.setAttribute('aria-expanded', 'true');
      }
    });

    menu.addEventListener('click', (e) => {
      if (e.target.closest('.dropdown-item')) {
        menu.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
      }
    });

    /*
     * Da tastiera questi menu si aprivano e poi non si potevano percorrere: il
     * fuoco restava sul bottone e le frecce non facevano nulla. Non era un
     * difetto del solo filtro dei vicini — valeva per «Analisi» e «Schema»
     * dallo stesso giorno in cui sono nati — quindi la correzione sta qui,
     * dove i tre menu si registrano, e non nel gestore di uno solo.
     * La <select> che il filtro aveva prima queste cose le faceva gratis:
     * sostituirla senza rimetterle sarebbe stato un peggioramento travestito
     * da miglioramento estetico.
     */
    const voci = () => [...menu.querySelectorAll('.dropdown-item')]
      .filter((v) => !v.disabled && !v.classList.contains('hidden'));

    const muovi = (da, passo) => {
      const elenco = voci();
      if (!elenco.length) return;
      const i = elenco.indexOf(da);
      // Da fuori (`i < 0`) si entra dal capo giusto: dal primo scendendo,
      // dall'ultimo salendo.
      const prossimo = i < 0
        ? (passo > 0 ? 0 : elenco.length - 1)
        : (i + passo + elenco.length) % elenco.length;
      elenco[prossimo].focus();
    };

    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      if (menu.classList.contains('hidden')) btn.click();
      // Il menu viene posizionato al clic: si aspetta il fotogramma dopo,
      // altrimenti si darebbe il fuoco a un elemento ancora nascosto.
      requestAnimationFrame(() => muovi(null, e.key === 'ArrowDown' ? 1 : -1));
    });

    menu.addEventListener('keydown', (e) => {
      const corrente = e.target.closest('.dropdown-item');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        muovi(corrente, e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        muovi(null, e.key === 'Home' ? 1 : -1);
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        // Chiudendo, il fuoco torna DA DOVE era partito: lasciarlo su una voce
        // ormai nascosta lo perde, e il tasto seguente non si sa dove va.
        menu.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
        if (e.key === 'Escape') { e.preventDefault(); btn.focus(); }
      }
    });
  };

  setupToolbarDropdown('#graph3d-analysis-menu-btn', '#graph3d-analysis-menu');
  setupToolbarDropdown('#graph3d-export-menu-btn', '#graph3d-export-menu');
  // Il filtro dei vicini passa dalla stessa registrazione degli altri due: è
  // ciò che gli dà l'apertura, il posizionamento, la chiusura al clic fuori e
  // la navigazione da tastiera senza riscriverli.
  setupToolbarDropdown('#graph3d-hop-btn', '#graph3d-hop-menu');

  const chiudiMenu = () => {
    document.querySelectorAll('.toolbar-dropdown-menu').forEach((m) => m.classList.add('hidden'));
    document.querySelectorAll('.dropdown-trigger-btn[aria-expanded]').forEach((t) => t.setAttribute('aria-expanded', 'false'));
  };

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.toolbar-dropdown-wrap') && !e.target.closest('.toolbar-dropdown-menu')) {
      chiudiMenu();
    }
  });
  // Un menu aperto si chiude con Esc: era raggiungibile da tastiera e non
  // abbandonabile da tastiera.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') chiudiMenu();
  });

  window.addEventListener('resize', chiudiMenu);
  window.addEventListener('scroll', chiudiMenu, true);

  // 1. Shortest Path Modal Trigger & Handler
  const pathBtn = $('#graph3d-find-path');
  if (pathBtn) {
    pathBtn.addEventListener('click', () => {
      const schema = state.dbSchema || currentSchemaData;
      if (!schema || !schema.collections || !schema.collections.length) {
        toast('Nessuno schema disponibile.', true);
        return;
      }

      const fromSel = $('#path-from-select');
      const toSel = $('#path-to-select');
      if (fromSel && toSel) {
        const optionsHtml = schema.collections.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
        fromSel.innerHTML = optionsHtml;
        toSel.innerHTML = optionsHtml;
        if (schema.collections.length > 1) {
          toSel.selectedIndex = 1;
        }
      }
      if (!activeShortestPath) {
        $('#path-result').innerHTML = '';
      }
      updatePathUI();
      $('#path-modal').classList.remove('hidden');
    });
  }

  const pathCalcBtn = $('#path-modal-calc');
  if (pathCalcBtn) {
    pathCalcBtn.addEventListener('click', () => {
      const start = $('#path-from-select').value;
      const end = $('#path-to-select').value;

      if (start === end) {
        toast('Seleziona due tabelle differenti.', true);
        return;
      }

      const res = computeShortestPath(start, end);
      const resDiv = $('#path-result');

      if (!res) {
        activeShortestPath = null;
        if (resDiv) resDiv.innerHTML = `<div style="color:var(--danger);">Nessun cammino trovato tra <b>${esc(start)}</b> e <b>${esc(end)}</b>.</div>`;
        updatePathUI();
        renderGraph3d();
      } else {
        activeShortestPath = res;
        if (resDiv) {
          resDiv.innerHTML = `<div class="audit-issue-item" style="border-left-color:var(--status-ok);">
            <div class="audit-issue-title" style="color:var(--status-ok);">✓ Cammino Minimo Trovato (${res.nodes.length - 1} passaggi)</div>
            <div class="audit-issue-desc" style="font-size:0.95rem; margin-top:6px;">
              ${res.nodes.map((n) => `<b style="color:var(--status-ok);">${esc(n)}</b>`).join(' → ')}
            </div>
          </div>`;
        }
        $('#path-modal').classList.add('hidden');
        updatePathUI();
        renderGraph3d();
        toast(`Cammino tra "${start}" e "${end}" evidenziato in verde nel 3D!`);
      }
    });
  }

  const pathModalClearBtn = $('#path-modal-clear');
  if (pathModalClearBtn) {
    pathModalClearBtn.addEventListener('click', () => {
      clearShortestPath();
      $('#path-modal').classList.add('hidden');
    });
  }

  const pathCloseBtn = $('#path-modal-close');
  if (pathCloseBtn) {
    pathCloseBtn.addEventListener('click', () => $('#path-modal').classList.add('hidden'));
  }

  const graphClearPathBtn = $('#graph3d-clear-path');
  if (graphClearPathBtn) {
    graphClearPathBtn.addEventListener('click', () => clearShortestPath());
  }

  const badgeClearBtn = $('#graph3d-path-badge-clear');
  if (badgeClearBtn) {
    badgeClearBtn.addEventListener('click', () => clearShortestPath());
  }

  // 3. Matrice Dipendenze Trigger
  const depsBtn = $('#graph3d-deps');
  if (depsBtn) depsBtn.addEventListener('click', () => analyzeDependencies());
  const depsCloseBtn = $('#deps-modal-close');
  if (depsCloseBtn) depsCloseBtn.addEventListener('click', () => $('#deps-modal').classList.add('hidden'));

  // 5. Filtro Tabelle Vuote
  const toggleEmptyBtn = $('#graph3d-toggle-empty');
  if (toggleEmptyBtn) {
    toggleEmptyBtn.addEventListener('click', () => {
      hideEmptyTables = !hideEmptyTables;
      renderGraph3d();
      aggiornaComandi();
      if (!hideEmptyTables) {
        toast('Tutte le tabelle visibili');
        return;
      }
      // Il conteggio è una STIMA del motore: dichiararlo è ciò che permette a
      // chi guarda di capire perché una tabella che sa piena è sparita — o
      // perché una che sa vuota è rimasta.
      const schema = state.dbSchema || currentSchemaData;
      const { vuote, ignote } = contaVuote((schema && schema.collections) || []);
      if (vuote === 0) {
        toast(ignote > 0
          ? 'Nessuna tabella risulta vuota (il motore non stima le righe di ' + ignote + ' tabelle)'
          : 'Nessuna tabella vuota da nascondere');
      } else {
        toast(vuote + (vuote === 1 ? ' tabella nascosta' : ' tabelle nascoste') + ' secondo la stima delle righe del motore');
      }
    });
  }

  const implicitBtn = $('#graph3d-toggle-implicit');
  if (implicitBtn) {
    implicitBtn.addEventListener('click', () => {
      showImplicitRelations = !showImplicitRelations;
      renderGraph3d();
      aggiornaComandi();
      toast(showImplicitRelations ? 'Relazioni implicite visibili' : 'Relazioni implicite nascoste');
    });
  }

  const toggle2dBtn = $('#graph3d-toggle-2d');
  if (toggle2dBtn) {
    toggle2dBtn.addEventListener('click', () => {
      is2DMode = !is2DMode;
      renderGraph3d();
      aggiornaComandi();
      toast(is2DMode ? 'Vista 2D piatta attivata' : 'Vista 3D attivata');
    });
  }

  const autoRotateBtn = $('#graph3d-auto-rotate');
  if (autoRotateBtn) {
    autoRotateBtn.addEventListener('click', () => {
      autoRotateActive = !autoRotateActive;
      /*
       * Far girare la telecamera attorno a una vista dichiarata PIATTA la
       * porterebbe fuori dal piano: i due comandi si contraddicono. Non si
       * disabilita nessuno dei due — chiedere la rotazione è chiedere lo
       * spazio, quindi si esce dal 2D e lo si dice.
       */
      if (autoRotateActive && is2DMode) {
        is2DMode = false;
        renderGraph3d();
        aggiornaComandi();
        toast('Rotazione automatica attivata: la vista torna in 3D');
        return;
      }
      const c = graphInstance && graphInstance.controls && graphInstance.controls();
      if (c) {
        c.autoRotate = autoRotateActive;
        c.autoRotateSpeed = 1.5;
      }
      applicaNavigazione(c);
      aggiornaComandi();
      toast(autoRotateActive ? 'Rotazione automatica attivata' : 'Rotazione automatica disattivata');
    });
  }

  const auditBtn = $('#graph3d-audit');
  if (auditBtn) auditBtn.addEventListener('click', () => runSchemaAudit());
  const auditCloseBtn = $('#audit-modal-close');
  if (auditCloseBtn) auditCloseBtn.addEventListener('click', () => $('#audit-modal').classList.add('hidden'));

  const saveSnapBtn = $('#graph3d-save-snapshot');
  if (saveSnapBtn) saveSnapBtn.addEventListener('click', () => saveSchemaSnapshotLocal());

  const diffBtn = $('#graph3d-diff');
  if (diffBtn) {
    diffBtn.addEventListener('click', () => {
      const diffContent = $('#diff-content');
      if (diffContent) {
        diffContent.innerHTML = '<div style="color:var(--fg-dim,#8b949e);">Seleziona un file snapshot JSON salvato in precedenza per visualizzare il report delle modifiche.</div>';
      }
      $('#diff-modal').classList.remove('hidden');
    });
  }

  const diffFileInput = $('#diff-file-input');
  if (diffFileInput) {
    diffFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const snapshot = JSON.parse(evt.target.result);
          renderDiffReport(snapshot);
        } catch (err) {
          toast('Impossibile leggere il file JSON: ' + err.message, true);
        }
      };
      reader.readAsText(file);
    });
  }

  const diffCloseBtn = $('#diff-modal-close');
  if (diffCloseBtn) diffCloseBtn.addEventListener('click', () => $('#diff-modal').classList.add('hidden'));

  const importBtn = $('#graph3d-import-schema');
  if (importBtn) {
    importBtn.addEventListener('click', () => $('#import-schema-modal').classList.remove('hidden'));
  }
  const importCloseBtn = $('#import-schema-close');
  if (importCloseBtn) {
    importCloseBtn.addEventListener('click', () => $('#import-schema-modal').classList.add('hidden'));
  }
  const importRenderBtn = $('#import-schema-render');
  if (importRenderBtn) {
    importRenderBtn.addEventListener('click', () => {
      const textarea = $('#import-schema-textarea');
      const format = $('#import-schema-format').value;
      if (!textarea || !textarea.value.trim()) {
        toast('Incolla uno script SQL o DBML valido.', true);
        return;
      }
      const parsed = parseSchemaInput(textarea.value, format);
      if (!parsed.collections.length) {
        toast('Impossibile interpretare lo schema fornito.', true);
        return;
      }
      state.dbSchema = parsed;
      state.dbSchemaFor = 'imported';
      $('#import-schema-modal').classList.add('hidden');
      renderGraph3d();
      toast(`Schema importato (${parsed.collections.length} tabelle visualizzate)!`);
    });
  }

  const closePanelBtn = $('#graph3d-panel-close');
  if (closePanelBtn) {
    closePanelBtn.addEventListener('click', () => {
      mostraPannelloLaterale(false);
      selectedNodeId = null;
      // Senza selezione il filtro dei vicini non è più esprimibile: se restava
      // su «2 salti» il grafo mostrava un criterio che non era più in vigore.
      const filtroAttivo = hopFilter !== 'all';
      aggiornaComandi();
      if (filtroAttivo) {
        renderGraph3d();
      } else if (graphInstance) {
        graphInstance.nodeColor(graphInstance.nodeColor()).linkWidth(graphInstance.linkWidth());
      }
    });
  }

  const resetBtn = $('#graph3d-reset-cam');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      selectedNodeId = null;
      mostraPannelloLaterale(false);
      // `clearShortestPath` ridisegna: da lì in poi `graphInstance` è la nuova
      // istanza, ed è quella che va inquadrata.
      clearShortestPath(true);
      aggiornaComandi();
      if (graphInstance) {
        graphInstance.zoomToFit(1000, 50);
        graphInstance.nodeColor(graphInstance.nodeColor()).linkWidth(graphInstance.linkWidth());
      }
    });
  }

  const refreshBtn = $('#graph3d-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadGraph3d(true));
  }

  const exportPngBtn = $('#graph3d-export-png');
  if (exportPngBtn) {
    exportPngBtn.addEventListener('click', () => {
      if (!graphInstance) return;
      try {
        const renderer = graphInstance.renderer();
        const scene = graphInstance.scene();
        const camera = graphInstance.camera();
        renderer.render(scene, camera);
        const dataUrl = renderer.domElement.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = `schema-${state.db || 'db'}-3d.png`;
        link.href = dataUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        toast('Immagine PNG esportata con successo!');
      } catch (err) {
        console.error('Errore export PNG:', err);
        toast('Impossibile esportare l\'immagine PNG.', true);
      }
    });
  }

  const exportMermaidBtn = $('#graph3d-export-mermaid');
  if (exportMermaidBtn) {
    exportMermaidBtn.addEventListener('click', () => {
      const mermaidText = generaMermaid(state.dbSchema || currentSchemaData);
      if (!mermaidText) {
        toast('Nessun dato di schema disponibile per Mermaid.', true);
        return;
      }
      const textarea = $('#mermaid-textarea');
      const modal = $('#mermaid-modal');
      if (textarea && modal) {
        textarea.value = mermaidText;
        modal.classList.remove('hidden');
      }
    });
  }

  const mermaidCloseBtn = $('#mermaid-modal-close');
  if (mermaidCloseBtn) {
    mermaidCloseBtn.addEventListener('click', () => $('#mermaid-modal').classList.add('hidden'));
  }

  const mermaidCopyBtn = $('#mermaid-modal-copy');
  if (mermaidCopyBtn) {
    mermaidCopyBtn.addEventListener('click', () => {
      const textarea = $('#mermaid-textarea');
      if (!textarea) return;
      textarea.select();
      navigator.clipboard.writeText(textarea.value).then(() => {
        toast('Diagramma Mermaid copiato negli appunti!');
      }).catch(() => {
        document.execCommand('copy');
        toast('Diagramma Mermaid copiato negli appunti!');
      });
    });
  }

  const exportDbmlBtn = $('#graph3d-export-dbml');
  if (exportDbmlBtn) {
    exportDbmlBtn.addEventListener('click', () => {
      const dbmlText = generaDbml(state.dbSchema || currentSchemaData, { db: state.db || 'database', dbType: state.dbType || 'MySQL' });
      if (!dbmlText) {
        toast('Nessun dato di schema disponibile per DBML.', true);
        return;
      }
      const textarea = $('#dbml-textarea');
      const modal = $('#dbml-modal');
      if (textarea && modal) {
        textarea.value = dbmlText;
        modal.classList.remove('hidden');
      }
    });
  }

  const dbmlCloseBtn = $('#dbml-modal-close');
  if (dbmlCloseBtn) {
    dbmlCloseBtn.addEventListener('click', () => $('#dbml-modal').classList.add('hidden'));
  }

  const dbmlCopyBtn = $('#dbml-modal-copy');
  if (dbmlCopyBtn) {
    dbmlCopyBtn.addEventListener('click', () => {
      const textarea = $('#dbml-textarea');
      if (!textarea) return;
      textarea.select();
      navigator.clipboard.writeText(textarea.value).then(() => {
        toast('Schema DBML copiato negli appunti!');
      }).catch(() => {
        document.execCommand('copy');
        toast('Schema DBML copiato negli appunti!');
      });
    });
  }

  const exportSqlBtn = $('#graph3d-export-sql');
  if (exportSqlBtn) {
    exportSqlBtn.addEventListener('click', () => {
      const sqlText = generaDdl(state.dbSchema || currentSchemaData, { db: state.db || 'db' });
      if (!sqlText) {
        toast('Nessun dato di schema disponibile per SQL DDL.', true);
        return;
      }
      const textarea = $('#sql-textarea');
      const modal = $('#sql-modal');
      if (textarea && modal) {
        textarea.value = sqlText;
        modal.classList.remove('hidden');
      }
    });
  }

  const sqlCloseBtn = $('#sql-modal-close');
  if (sqlCloseBtn) {
    sqlCloseBtn.addEventListener('click', () => $('#sql-modal').classList.add('hidden'));
  }

  const sqlCopyBtn = $('#sql-modal-copy');
  if (sqlCopyBtn) {
    sqlCopyBtn.addEventListener('click', () => {
      const textarea = $('#sql-textarea');
      if (!textarea) return;
      textarea.select();
      navigator.clipboard.writeText(textarea.value).then(() => {
        toast('Script SQL DDL copiato negli appunti!');
      }).catch(() => {
        document.execCommand('copy');
        toast('Script SQL DDL copiato negli appunti!');
      });
    });
  }

  // Lo stato iniziale va DIPINTO, non presupposto: `showImplicitRelations`
  // parte a `true` e il suo bottone nasceva spento, cioè dichiarava il
  // contrario di ciò che il grafo stava facendo.
  aggiornaComandi();
}
