import { state } from './state.js';
import { activeTab } from './tabs.js';
import { $, emit, displayValue, displayValueBreve, ejsonKind, positionFixedDropdown, buildJsonNode, esc, showSkeletonGrid, toast, isForActiveTab } from './utils.js';
import { initSnippetManager } from './snippet-manager.js';
import { trackPending, markPaused } from './pending-queries.js';
import { SqlChunker, formatBytes } from './sql-chunker.js';
import { highlightQueryCode } from './query-highlighter.js';
import { isScript, countStatements } from './sql-split.js';
import { runScript, runScriptAndWait } from './script-run.js';
import { refreshDbTree } from './dbtree.js';
import { formatCode } from './query-formatter.js';
import {
  initQueryEditor, aggiornaNumeriRiga, segnalaRigaErrore, rigaDaMessaggio, selezioneEditor,
} from './query-editor.js';
import { initCharts, renderChart, resizeChart } from './charts.js';
import { ordinaRighe, larghezzeColonne, LARGH_MIN } from './table-cols.js';
import { segnaTraguardo } from './onboarding-stato.js';

const escapeHtml = esc;

let activeViewMode = 'table'; // 'table' | 'json' | 'chart'
let currentResults = [];
let executionStartTime = 0;

// Stato per il Chunking File SQL
let activeSqlChunker = null;
let currentChunkIndex = 0;
let isChunkRunning = false;
let stopChunkRunRequested = false;

export function updateEditorHighlight() {
  const editorInput = $('#query-editor-input');
  const highlightCode = $('#query-editor-code');
  const highlightPre = $('#query-editor-highlight');
  if (!editorInput || !highlightCode) return;

  const code = editorInput.value;
  const engine = $('#query-target-engine')?.value || 'auto';
  highlightCode.innerHTML = highlightQueryCode(code, engine) + (code.endsWith('\n') ? ' ' : '');

  if (highlightPre) {
    highlightPre.scrollTop = editorInput.scrollTop;
    highlightPre.scrollLeft = editorInput.scrollLeft;
  }

  aggiornaModalitaScript(code);
  // Il testo dell'editor cambia anche senza digitazione (snippet, ripresa di
  // una query in sospeso, caricamento di un chunk): la numerazione deve
  // seguirlo comunque, non solo sull'evento `input`.
  aggiornaNumeriRiga();
}

/**
 * Il codice appena eseguito ha modificato la STRUTTURA (database, tabelle,
 * collezioni)? In quel caso la sidebar va ricaricata, altrimenti mostra un
 * albero che non corrisponde più al database.
 */
function cambiaStruttura(code) {
  const s = String(code || '');
  if (/\b(CREATE|DROP|ALTER|RENAME|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|COLLECTION|VIEW)\b/i.test(s)) return true;
  // Equivalenti nella sintassi shell/script MongoDB.
  return /\.(drop|createCollection|dropDatabase|renameCollection)\s*\(/.test(s)
    || /\bdb\.createCollection\s*\(/.test(s);
}

/**
 * L'editor con più istruzioni verrà eseguito come SCRIPT: dirlo PRIMA di
 * premere Esegui evita la sorpresa di un'esecuzione che si comporta in modo
 * diverso da quella attesa, e mostra l'opzione "ferma al primo errore" solo
 * quando ha senso.
 */
function aggiornaModalitaScript(code) {
  const label = $('#query-run-label');
  const wrap = $('#query-stop-on-error-wrap');
  const testo = String(code || '').trim();
  // Il conteggio percorre il testo carattere per carattere: su un chunk da 1 MB
  // non va fatto a ogni tasto premuto. Oltre la soglia si assume "script" senza
  // contare (un testo così lungo non è mai una query sola) e il numero resta
  // ignoto finché non lo dice il server all'avvio.
  const troppoLungo = testo.length > 200000;
  const n = troppoLungo ? null : countStatements(testo);
  const script = troppoLungo || n > 1;

  if (label) label.textContent = script ? (n ? `Esegui Script (${n})` : 'Esegui Script') : 'Esegui Query';
  if (wrap) wrap.classList.toggle('hidden', !script);
}

export function initQueryTab() {
  initSnippetManager();
  initSqlChunking();
  const targetEngineSelect = $('#query-target-engine');
  const runBtn = $('#query-run-btn');
  const stopBtn = $('#query-stop-btn');
  const formatBtn = $('#query-format-btn');
  const clearBtn = $('#query-clear-btn');
  const schemaRefreshBtn = $('#query-schema-refresh');
  const schemaSearchInput = $('#query-schema-search');
  const resModeTableBtn = $('#res-mode-table');
  const resModeJsonBtn = $('#res-mode-json');
  const editorInput = $('#query-editor-input');
  const highlightPre = $('#query-editor-highlight');

  if (targetEngineSelect) {
    targetEngineSelect.addEventListener('change', updateEditorHighlight);
  }

  // Toggle Schema Browser Drawer (Mobile)
  const toggleSchemaBtn = $('#query-toggle-schema-btn');
  const closeSchemaBtn = $('#query-schema-close');
  const schemaSidebar = $('#query-schema-sidebar');

  if (toggleSchemaBtn && schemaSidebar) {
    toggleSchemaBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      schemaSidebar.classList.toggle('open');
    });
  }

  if (closeSchemaBtn && schemaSidebar) {
    closeSchemaBtn.addEventListener('click', () => {
      schemaSidebar.classList.remove('open');
    });
  }

  // Export Dropdown Menu (Mobile)
  const exportMenuBtn = $('#query-export-menu-btn');
  const exportMenu = $('#query-export-menu');
  if (exportMenuBtn && exportMenu) {
    exportMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = exportMenu.classList.contains('hidden');
      document.querySelectorAll('.toolbar-dropdown-menu').forEach((m) => m.classList.add('hidden'));
      if (isHidden) {
        positionFixedDropdown(exportMenuBtn, exportMenu);
      }
    });

    const bindExportClick = (mobId, mainId) => {
      const mobBtn = $(mobId);
      const mainBtn = $(mainId);
      if (mobBtn && mainBtn) {
        mobBtn.addEventListener('click', () => {
          exportMenu.classList.add('hidden');
          mainBtn.click();
        });
      }
    };
    bindExportClick('#query-export-csv-mob', '#query-export-csv');
    bindExportClick('#query-export-json-mob', '#query-export-json');
    bindExportClick('#query-export-sql-mob', '#query-export-sql');
  }

  // Switch vista risultati (Tabella / JSON Tree / Grafici)
  if (resModeTableBtn && resModeJsonBtn) {
    resModeTableBtn.addEventListener('click', () => setResultsViewMode('table'));
    resModeJsonBtn.addEventListener('click', () => setResultsViewMode('json'));
  }
  const resModeChartBtn = $('#res-mode-chart');
  if (resModeChartBtn) resModeChartBtn.addEventListener('click', () => setResultsViewMode('chart'));
  initCharts();

  // Azioni editor e sincronizzazione highlight
  if (editorInput) {
    editorInput.addEventListener('input', updateEditorHighlight);
    editorInput.addEventListener('scroll', () => {
      if (highlightPre) {
        highlightPre.scrollTop = editorInput.scrollTop;
        highlightPre.scrollLeft = editorInput.scrollLeft;
      }
    });
    updateEditorHighlight();
  }

  if (formatBtn && editorInput) {
    formatBtn.addEventListener('click', () => {
      const val = editorInput.value;
      if (!val.trim()) return;
      // `formatCode` sceglie da sé fra SQL, JSON/MQL e script JavaScript, e in
      // caso di sintassi non analizzabile restituisce il testo invariato: una
      // formattazione che corrompe il codice sarebbe molto peggio di una
      // formattazione mancata. Prima qui funzionava solo il ramo JSON, e su
      // SQL il pulsante non faceva nulla senza dirlo.
      const formattato = formatCode(val);
      if (formattato === val) {
        toast('Niente da formattare (o codice non analizzabile).');
        return;
      }
      editorInput.value = formattato;
      updateEditorHighlight();
    });
  }

  if (clearBtn && editorInput) {
    clearBtn.addEventListener('click', () => {
      editorInput.value = '';
      updateEditorHighlight();
    });
  }

  // Shortcut tastiera per l'esecuzione (Ctrl+Enter / Cmd+Enter)
  if (editorInput) {
    editorInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        // Con del testo selezionato si esegue SOLO quello: è il modo naturale
        // di provare una riga dentro uno script lungo senza rilanciarlo tutto.
        const selezione = selezioneEditor();
        if (selezione) {
          toast('Eseguo solo la selezione');
          runQuery({ code: selezione });
        } else {
          runQuery();
        }
      }
    });
  }

  // Numeri di riga, Tab che indenta, evidenziazione della riga in errore.
  initQueryEditor({ onCambio: updateEditorHighlight });

  if (runBtn) {
    runBtn.addEventListener('click', () => runQuery());
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => cancelActiveQuery());
  }

  if (schemaRefreshBtn) {
    schemaRefreshBtn.addEventListener('click', () => renderQuerySchemaBrowser());
  }

  const targetReset = $('#query-target-reset');
  if (targetReset) {
    targetReset.addEventListener('click', () => {
      setQueryTarget(null, null);
      toast('La query torna a seguire la collection aperta');
    });
  }

  if (schemaSearchInput) {
    // Debounce: l'albero può avere migliaia di nodi campo e il filtro li visita
    // tutti; a ogni tasto premuto sarebbe una visita completa.
    let attesaFiltro = 0;
    schemaSearchInput.addEventListener('input', (e) => {
      const valore = e.target.value;
      clearTimeout(attesaFiltro);
      attesaFiltro = setTimeout(() => filterQuerySchemaBrowser(valore), 120);
    });
    // Esc svuota la ricerca senza dover cancellare a mano.
    schemaSearchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !schemaSearchInput.value) return;
      e.stopPropagation();
      schemaSearchInput.value = '';
      clearTimeout(attesaFiltro);
      filterQuerySchemaBrowser('');
    });
  }

  initVerticalResizer();
}

// Inizializza ed aggancia la gestione del Chunking per File SQL Grandi
function initSqlChunking() {
  const openBtn = $('#query-open-sql-btn');
  const fileInput = $('#query-open-sql-input');
  const chunkPanel = $('#query-sql-chunk-panel');
  const fileNameEl = $('#chunk-file-name');
  const fileSizeEl = $('#chunk-file-size');
  const countBadgeEl = $('#chunk-count-badge');
  const chunkSelect = $('#chunk-select');
  const prevBtn = $('#chunk-prev-btn');
  const nextBtn = $('#chunk-next-btn');
  const loadEditorBtn = $('#chunk-load-editor-btn');
  const closeBtn = $('#chunk-close-btn');
  const runAllBtn = $('#chunk-run-all-btn');
  const cancelRunBtn = $('#chunk-cancel-run-btn');
  const progressContainer = $('#chunk-progress-container');
  const progressFill = $('#chunk-progress-fill');
  const progressText = $('#chunk-progress-text');
  const byteInfoEl = $('#chunk-byte-info');
  const editorInput = $('#query-editor-input');

  if (!openBtn || !fileInput) return;

  openBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    fileInput.value = '';

    // File piccolo (<= 1MB): caricamento diretto nell'editor
    if (file.size <= 1024 * 1024) {
      try {
        const reader = new FileReader();
        reader.onload = () => {
          if (editorInput) {
            editorInput.value = String(reader.result || '');
            updateEditorHighlight();
          }
          if (chunkPanel) chunkPanel.classList.add('hidden');
          toast(`File "${file.name}" caricato nell'editor (${formatBytes(file.size)})`);
        };
        reader.onerror = () => toast('Impossibile leggere il file selezionato', 'error');
        reader.readAsText(file);
      } catch (err) {
        toast(`Errore durante la lettura del file: ${err.message}`, 'error');
      }
      return;
    }

    // File grande (> 1MB): attivazione SqlChunker
    try {
      toast(`Caricamento e analisi file "${file.name}" (${formatBytes(file.size)})...`);
      activeSqlChunker = new SqlChunker(file, 1024 * 1024);
      await activeSqlChunker.init();

      const info = activeSqlChunker.getFileInfo();
      if (fileNameEl) fileNameEl.textContent = info.name;
      if (fileSizeEl) fileSizeEl.textContent = info.formattedSize;
      if (countBadgeEl) countBadgeEl.textContent = `${info.chunkCount} chunk`;

      if (chunkSelect) {
        chunkSelect.innerHTML = '';
        activeSqlChunker.chunks.forEach((c) => {
          const opt = document.createElement('option');
          opt.value = c.index;
          opt.textContent = `Chunk ${c.index + 1} / ${info.chunkCount} (${formatBytes(c.size)})`;
          chunkSelect.appendChild(opt);
        });
      }

      if (chunkPanel) chunkPanel.classList.remove('hidden');
      if (progressContainer) progressContainer.classList.add('hidden');

      await selectAndPreviewChunk(0);
      toast(`File "${file.name}" (${info.formattedSize}) suddiviso in ${info.chunkCount} chunk.`);
    } catch (err) {
      toast(`Errore nella suddivisione a chunk: ${err.message}`, 'error');
    }
  });

  async function selectAndPreviewChunk(index, updateEditor = true) {
    if (!activeSqlChunker) return;
    const total = activeSqlChunker.getChunkCount();
    if (index < 0 || index >= total) return;

    currentChunkIndex = index;
    if (chunkSelect) chunkSelect.value = index;

    const chunkData = await activeSqlChunker.readChunk(index);
    if (byteInfoEl) {
      byteInfoEl.textContent = `Byte ${formatBytes(chunkData.startByte)} - ${formatBytes(chunkData.endByte)} (Tot. ${formatBytes(chunkData.totalBytes)})`;
    }

    if (updateEditor && editorInput) {
      editorInput.value = chunkData.text;
      updateEditorHighlight();
    }
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', () => selectAndPreviewChunk(currentChunkIndex - 1));
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => selectAndPreviewChunk(currentChunkIndex + 1));
  }

  if (chunkSelect) {
    chunkSelect.addEventListener('change', (e) => {
      selectAndPreviewChunk(parseInt(e.target.value, 10));
    });
  }

  if (loadEditorBtn) {
    loadEditorBtn.addEventListener('click', () => selectAndPreviewChunk(currentChunkIndex, true));
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      activeSqlChunker = null;
      currentChunkIndex = 0;
      if (chunkPanel) chunkPanel.classList.add('hidden');
      toast('File SQL chiuso.');
    });
  }

  if (runAllBtn) {
    runAllBtn.addEventListener('click', async () => {
      if (!activeSqlChunker || isChunkRunning) return;
      isChunkRunning = true;
      stopChunkRunRequested = false;

      if (runAllBtn) runAllBtn.classList.add('hidden');
      if (cancelRunBtn) cancelRunBtn.classList.remove('hidden');
      if (progressContainer) progressContainer.classList.remove('hidden');

      const totalChunks = activeSqlChunker.getChunkCount();
      let totalRows = 0;
      const tStart = performance.now();

      for (let i = currentChunkIndex; i < totalChunks; i++) {
        if (stopChunkRunRequested) {
          toast('Esecuzione sequenziale dei chunk interrotta dall\'utente.');
          break;
        }

        const pct = Math.round(((i + 1) / totalChunks) * 100);
        if (progressFill) progressFill.style.width = `${pct}%`;
        if (progressText) {
          progressText.textContent = `Esecuzione Chunk ${i + 1}/${totalChunks} (${pct}%) — ${totalRows} righe/record elaborati...`;
        }

        try {
          await selectAndPreviewChunk(i, true);
          // Un chunk contiene quasi sempre MOLTE istruzioni: va eseguito come
          // script e ATTESO fino alla fine, altrimenti i blocchi successivi
          // partirebbero tutti insieme (`runScript` ritorna all'avvio).
          const testoChunk = ($('#query-editor-input')?.value || '').trim();
          if (isScript(testoChunk)) {
            const stato = await runScriptAndWait({
              code: testoChunk,
              engine: $('#query-target-engine')?.value || 'auto',
              ...queryTarget(),
              stopOnError: !!$('#query-stop-on-error')?.checked,
            });
            if (stato) {
              totalRows += stato.eseguiti || 0;
              // Uno script interrotto (pausa/abort) ferma anche la sequenza:
              // proseguire coi blocchi successivi ignorerebbe la volontà
              // dell'utente di fermarsi.
              if (stato.status === 'aborted' || stato.status === 'paused') {
                stopChunkRunRequested = true;
                if (progressText) progressText.textContent = `⏸ Sequenza fermata al Chunk ${i + 1}/${totalChunks}`;
                break;
              }
            }
          } else {
            const res = await runQuery();
            if (res && (res.data || res.docs)) {
              const list = res.data || res.docs;
              totalRows += Array.isArray(list) ? list.length : 1;
            }
          }
        } catch (err) {
          toast(`Errore durante l'esecuzione del Chunk ${i + 1}: ${err.message}`, 'error');
          if (progressText) {
            progressText.textContent = `✖ Interrotto per errore al Chunk ${i + 1}/${totalChunks}`;
          }
          break;
        }
      }

      isChunkRunning = false;
      const elapsed = Math.round(performance.now() - tStart);
      if (runAllBtn) runAllBtn.classList.remove('hidden');
      if (cancelRunBtn) cancelRunBtn.classList.add('hidden');

      if (!stopChunkRunRequested) {
        if (progressFill) progressFill.style.width = '100%';
        if (progressText) {
          progressText.textContent = `✓ Esecuzione completata in ${elapsed} ms! Totale ${totalRows} righe/record elaborati su ${totalChunks} chunk.`;
        }
        toast(`Esecuzione completata! ${totalRows} righe elaborate su ${totalChunks} chunk (${elapsed} ms).`);
      }
    });
  }

  if (cancelRunBtn) {
    cancelRunBtn.addEventListener('click', () => {
      stopChunkRunRequested = true;
      if (cancelRunBtn) cancelRunBtn.classList.add('hidden');
      if (runAllBtn) runAllBtn.classList.remove('hidden');
    });
  }
}

// Inizializza la tab Query
export function loadQueryTab() {
  renderQuerySchemaBrowser();
  renderQueryTarget();
}

// Resizer verticale tra editor e pannello risultati
function initVerticalResizer() {
  const resizer = $('#query-editor-resizer');
  const topPanel = $('#query-editor-container');
  const bottomPanel = $('#query-results-container');
  if (!resizer || !topPanel || !bottomPanel) return;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startTopH = topPanel.getBoundingClientRect().height;
    const startBottomH = bottomPanel.getBoundingClientRect().height;
    resizer.classList.add('dragging');

    const onMouseMove = (ev) => {
      const dy = ev.clientY - startY;
      const newTopH = Math.max(80, startTopH + dy);
      const newBottomH = Math.max(80, startBottomH - dy);
      topPanel.style.flex = 'none';
      topPanel.style.height = `${newTopH}px`;
      bottomPanel.style.flex = 'none';
      bottomPanel.style.height = `${newBottomH}px`;
    };

    const onMouseUp = () => {
      resizer.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// Gestione modalità vista risultati (Tabella / JSON / Grafici)
export function setResultsViewMode(mode) {
  activeViewMode = mode;
  const viste = {
    table: { btn: '#res-mode-table', view: '#query-table-view' },
    json: { btn: '#res-mode-json', view: '#query-json-view' },
    chart: { btn: '#res-mode-chart', view: '#query-chart-view' },
  };
  for (const [nome, sel] of Object.entries(viste)) {
    const btn = $(sel.btn);
    const view = $(sel.view);
    if (btn) btn.classList.toggle('active', nome === mode);
    if (view) view.classList.toggle('hidden', nome !== mode);
  }

  // Il traguardo è "disegna un grafico DAI RISULTATI": aprire la vista con il
  // pannello vuoto non è averlo fatto, ed è proprio il caso in cui la guida
  // dovrebbe ancora suggerirlo.
  if (mode === 'chart' && currentResults.length) segnaTraguardo('grafico');

  if (mode === 'chart') allargaRisultatiPerGrafico();
  renderResults(currentResults);
  // Il canvas del grafico era nascosto (larghezza 0) mentre si guardava un'altra
  // vista: ECharts ha bisogno di rimisurarlo, altrimenti resta disegnato sulla
  // dimensione precedente o non compare affatto.
  if (mode === 'chart') requestAnimationFrame(resizeChart);
}

// Un grafico ha bisogno di più altezza di una tabella: con la ripartizione di
// default il pannello dei risultati è alto ~230px, e fra toolbar, assi e
// legenda al disegno restano cento pixel. Alla PRIMA apertura dei Grafici si
// sposta il divisorio una volta sola — poi decide l'utente, e la sua scelta non
// viene più toccata (altrimenti ogni ritorno alla vista rimetterebbe tutto
// dov'era, che è il modo più sicuro di far sembrare rotto un divisorio).
let spazioGraficoDato = false;
function allargaRisultatiPerGrafico() {
  if (spazioGraficoDato) return;
  const editor = $('#query-editor-container');
  const risultati = $('#query-results-container');
  if (!editor || !risultati) return;
  const hRis = risultati.getBoundingClientRect().height;
  const hEd = editor.getBoundingClientRect().height;
  spazioGraficoDato = true;
  if (hRis >= 340 || hEd <= 170) return; // spazio già sufficiente

  // Si fissa l'altezza SOLO dell'editor e i risultati restano elastici: il
  // resto dello spazio è quello che c'è, qualunque sia (divisorio compreso).
  // Assegnando due altezze calcolate a mano, la somma superava di qualche pixel
  // l'altezza del contenitore e la colonna finiva sotto il bordo della finestra
  // — cioè il difetto che si stava correggendo, spostato di un passo.
  const totale = hRis + hEd;
  editor.style.flex = 'none';
  editor.style.height = `${Math.max(150, Math.round(totale * 0.32))}px`;
  risultati.style.flex = '1 1 auto';
  risultati.style.height = '';
}

// Aggiorna badge e metriche
export function updateQueryMetrics(status, timeMs = null, count = null, errorMsg = null) {
  const statusBadge = $('#query-status-badge');
  const timeMetric = $('#query-time-metric');
  const timeVal = $('#query-time-val');
  const countMetric = $('#query-count-metric');
  const countVal = $('#query-count-val');
  const errorBox = $('#query-error-box');

  if (statusBadge) {
    statusBadge.className = `badge badge-${status}`;
    if (status === 'idle') statusBadge.textContent = '● In attesa';
    else if (status === 'running') {
      statusBadge.textContent = '⏳ Esecuzione...';
      const tableView = $('#query-table-view');
      if (tableView) showSkeletonGrid(tableView, 8, 5);
    }
    else if (status === 'success') statusBadge.textContent = '✓ Completato';
    else if (status === 'error') statusBadge.textContent = '✖ Errore';
  }

  if (timeMs !== null && timeMetric && timeVal) {
    timeVal.textContent = timeMs;
    timeMetric.classList.remove('hidden');
  }

  if (count !== null && countMetric && countVal) {
    countVal.textContent = count;
    countMetric.classList.remove('hidden');
  }

  if (errorBox) {
    if (errorMsg) {
      errorBox.textContent = errorMsg;
      errorBox.classList.remove('hidden');
    } else {
      errorBox.classList.add('hidden');
    }
  }
}

// Renderizza i risultati nella vista attiva
export function renderResults(data) {
  currentResults = Array.isArray(data) ? data : (data ? [data] : []);

  if (activeViewMode === 'table') {
    renderResultsTable(currentResults);
  } else if (activeViewMode === 'chart') {
    // `renderChart` è asincrona solo al primo uso (carica ECharts da
    // public/vendor): il risultato non serve a nessuno qui, ma un errore di
    // caricamento non deve restare una promessa rifiutata in silenzio.
    renderChart(currentResults).catch((err) => {
      console.error('[QueryTab] Errore nel rendering del grafico:', err);
      toast(`Impossibile disegnare il grafico: ${err.message}`, true);
    });
  } else {
    renderResultsJsonTree(currentResults);
  }
}

/* --------------------------------------------------------------------------
 * Tabella dei risultati: colonne misurate, ordinabili e ridimensionabili.
 * La logica pura (chiavi di confronto EJSON, calcolo delle larghezze) sta in
 * `table-cols.js`; qui restano DOM ed eventi.
 * ------------------------------------------------------------------------ */

let queryTableRows = [];   // righe NELL'ORDINE MOSTRATO (≠ currentResults se ordinate)
let queryTableCols = [];
let queryVScrollAttached = false;
let queryHeaderAttached = false;
let queryOrdine = { col: null, dir: 1 };   // dir: 1 crescente, -1 decrescente
let queryLarghezze = new Map();            // colonna → px
let queryLarghezzeManuali = new Set();     // colonne allargate a mano: non si ricalcolano
let queryColsSig = '';                     // firma del set di colonne
let queryRigheRef = null;                  // riferimento all'ultimo result set reso
let queryResizeInCorso = false;
const QUERY_ROW_H = 36;
const QUERY_OVERSCAN = 6;

/** Il testo che finisce in cella: identico a quello disegnato dalla griglia.
 *  Per la MISURA delle colonne bastano pochi caratteri — oltre il tetto di
 *  larghezza il resto non cambia il risultato e costerebbe una serializzazione
 *  completa del valore. */
function testoCella(val) {
  return displayValueBreve(val, 200).text ?? '';
}

/**
 * Misuratore di testo per le larghezze: un canvas fuori dal documento con lo
 * stesso font della tabella. Serve un canvas e non un nodo di prova perché
 * misurare 200 righe × N colonne inserendo elementi nel DOM significherebbe
 * altrettanti reflow a ogni query.
 */
let ctxMisura = null;
function misuratoreTesto(tabella) {
  if (ctxMisura === null) {
    try { ctxMisura = document.createElement('canvas').getContext('2d'); } catch { ctxMisura = false; }
  }
  // Nessun canvas (ambiente esotico): stima grossolana, meglio di niente.
  if (!ctxMisura) return (t) => String(t ?? '').length * 7;
  const cs = getComputedStyle(tabella);
  ctxMisura.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const ctx = ctxMisura;
  return (t) => ctx.measureText(String(t ?? '')).width;
}

/** Ricalcola le larghezze, rispettando quelle già scelte a mano dall'utente. */
function calcolaLarghezze(righe, colonne, tabella) {
  const daMisurare = colonne.filter((c) => !queryLarghezzeManuali.has(c));
  const nuove = larghezzeColonne(righe, daMisurare, {
    misura: misuratoreTesto(tabella),
    testo: testoCella,
  });
  colonne.forEach((c) => {
    if (nuove.has(c)) queryLarghezze.set(c, nuove.get(c));
    else if (!queryLarghezze.has(c)) queryLarghezze.set(c, LARGH_MIN);
  });
}

/** Scrive le larghezze correnti nel <colgroup> (creandolo se manca). */
function applicaColgroup(table) {
  let cg = table.querySelector('colgroup');
  if (!cg) {
    cg = document.createElement('colgroup');
    table.insertBefore(cg, table.firstChild);
  }
  cg.innerHTML = '';
  queryTableCols.forEach((c) => {
    const col = document.createElement('col');
    col.style.width = `${queryLarghezze.get(c) || LARGH_MIN}px`;
    cg.appendChild(col);
  });
}

/** Intestazione: etichetta, freccia di ordinamento e maniglia di larghezza. */
function costruisciIntestazione(thead) {
  thead.innerHTML = '';
  const tr = document.createElement('tr');
  queryTableCols.forEach((colName) => {
    const th = document.createElement('th');
    th.dataset.col = colName;
    th.title = `${colName} — clic per ordinare, trascina il bordo destro per allargare (doppio clic: adatta al contenuto)`;

    const label = document.createElement('span');
    label.textContent = colName;
    th.appendChild(label);

    if (queryOrdine.col === colName) {
      th.classList.add('qt-sorted');
      const ind = document.createElement('span');
      ind.className = 'qt-sort-ind';
      ind.textContent = queryOrdine.dir < 0 ? '▼' : '▲';
      th.appendChild(ind);
    }

    const rz = document.createElement('div');
    rz.className = 'qt-col-resizer';
    rz.dataset.col = colName;
    th.appendChild(rz);

    tr.appendChild(th);
  });
  thead.appendChild(tr);
}

/**
 * Ordinamento a TRE stati: crescente → decrescente → nessuno. Il terzo stato
 * non è un vezzo: senza, l'ordine con cui il database ha restituito le righe
 * (che in una query con ORDER BY o in una pipeline è il risultato voluto) non
 * si potrebbe più recuperare se non rieseguendo la query.
 */
function ordinaPer(col) {
  if (queryOrdine.col !== col) queryOrdine = { col, dir: 1 };
  else if (queryOrdine.dir === 1) queryOrdine = { col, dir: -1 };
  else queryOrdine = { col: null, dir: 1 };

  queryTableRows = queryOrdine.col
    ? ordinaRighe(currentResults, queryOrdine.col, queryOrdine.dir)
    : currentResults;

  const table = $('#query-result-table');
  if (!table) return;
  costruisciIntestazione(table.querySelector('thead'));
  const container = $('#query-table-view');
  if (container) container.scrollTop = 0;
  renderQueryVirtualWindow();
}

/** Larghezza della colonna adattata al contenuto del campione (doppio clic). */
function autoAdatta(col) {
  const table = $('#query-result-table');
  const idx = queryTableCols.indexOf(col);
  if (!table || idx < 0) return;
  const w = larghezzeColonne(queryTableRows, [col], {
    misura: misuratoreTesto(table),
    testo: testoCella,
    max: 800, // a mano si concede più del tetto automatico: l'ha chiesto l'utente
  }).get(col);
  if (!w) return;
  queryLarghezze.set(col, w);
  queryLarghezzeManuali.add(col);
  const colEl = table.querySelectorAll('colgroup col')[idx];
  if (colEl) colEl.style.width = `${w}px`;
}

function iniziaRidimensiona(handle, ev) {
  const col = handle.dataset.col;
  const idx = queryTableCols.indexOf(col);
  const table = $('#query-result-table');
  if (!table || idx < 0) return;
  ev.preventDefault();

  const colEl = table.querySelectorAll('colgroup col')[idx];
  const startX = ev.clientX;
  const startW = queryLarghezze.get(col) || LARGH_MIN;
  handle.classList.add('dragging');
  document.body.classList.add('qt-resizing');

  const onMove = (e) => {
    const w = Math.max(48, Math.round(startW + (e.clientX - startX)));
    queryLarghezze.set(col, w);
    queryLarghezzeManuali.add(col);
    if (colEl) colEl.style.width = `${w}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    handle.classList.remove('dragging');
    document.body.classList.remove('qt-resizing');
    // Il `click` arriva subito dopo il `mouseup`: senza questa bandiera, il
    // rilascio della maniglia ordinerebbe anche la colonna.
    queryResizeInCorso = true;
    setTimeout(() => { queryResizeInCorso = false; }, 0);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/* Gestori DELEGATI e registrati una volta sola: l'intestazione viene riscritta
   a ogni query e a ogni cambio di ordinamento. */
function attachQueryHeaderEvents() {
  const table = $('#query-result-table');
  if (!table || queryHeaderAttached) return;
  const thead = table.querySelector('thead');
  if (!thead) return;
  queryHeaderAttached = true;

  thead.addEventListener('click', (e) => {
    if (queryResizeInCorso) return;
    if (e.target.classList.contains('qt-col-resizer')) return;
    const th = e.target.closest('th');
    if (!th || !th.dataset.col) return;
    ordinaPer(th.dataset.col);
  });

  thead.addEventListener('mousedown', (e) => {
    if (!e.target.classList.contains('qt-col-resizer')) return;
    iniziaRidimensiona(e.target, e);
  });

  thead.addEventListener('dblclick', (e) => {
    if (!e.target.classList.contains('qt-col-resizer')) return;
    e.preventDefault();
    autoAdatta(e.target.dataset.col);
  });
}

function renderQueryVirtualWindow() {
  const container = $('#query-table-view');
  if (!container) return;
  const table = $('#query-result-table');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  const N = queryTableRows.length;
  if (N === 0) {
    tbody.innerHTML = '';
    return;
  }

  const viewport = container.clientHeight || 400;
  const scrollTop = container.scrollTop || 0;
  const start = Math.max(0, Math.floor(scrollTop / QUERY_ROW_H) - QUERY_OVERSCAN);
  const visible = Math.ceil(viewport / QUERY_ROW_H);
  const end = Math.min(N, start + visible + QUERY_OVERSCAN * 2);
  const numCols = queryTableCols.length || 1;

  const frag = document.createDocumentFragment();

  if (start > 0) {
    const topSpacer = document.createElement('tr');
    topSpacer.className = 'v-spacer';
    topSpacer.innerHTML = `<td colspan="${numCols}" style="height:${start * QUERY_ROW_H}px; padding:0; border:none; background:none;"></td>`;
    frag.appendChild(topSpacer);
  }

  for (let i = start; i < end; i++) {
    const row = queryTableRows[i];
    const tr = document.createElement('tr');
    tr.style.height = `${QUERY_ROW_H}px`;
    queryTableCols.forEach((col) => {
      const td = document.createElement('td');
      const val = row ? row[col] : undefined;
      // Testo LIMITATO: la cella ne mostra al massimo una sessantina di
      // caratteri, e questo codice gira per ~20 righe a ogni fotogramma di
      // scorrimento. Il `title` usa lo stesso testo: prima era un secondo
      // `JSON.stringify` del valore intero — su un documento da 25 MB, 60 ms
      // per cella per costruire un fumetto illeggibile.
      const res = displayValueBreve(val);
      td.textContent = res.text ?? '';
      if (res.cls) td.className = res.cls;
      if (res.dataVal !== undefined) td.dataset.val = res.dataVal;
      td.title = res.text ?? '';
      tr.appendChild(td);
    });
    frag.appendChild(tr);
  }

  if (end < N) {
    const botSpacer = document.createElement('tr');
    botSpacer.className = 'v-spacer';
    botSpacer.innerHTML = `<td colspan="${numCols}" style="height:${(N - end) * QUERY_ROW_H}px; padding:0; border:none; background:none;"></td>`;
    frag.appendChild(botSpacer);
  }

  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

function attachQueryVScroll() {
  const container = $('#query-table-view');
  if (!container || queryVScrollAttached) return;
  queryVScrollAttached = true;
  let raf = 0;
  container.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(renderQueryVirtualWindow);
  });
}

// Render Tabella
function renderResultsTable(rows) {
  const container = $('#query-table-view');
  if (container) {
    container.querySelectorAll('.skeleton-grid-table').forEach((t) => t.remove());
  }
  const table = $('#query-result-table');
  if (!table || !container) return;
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  if (!rows || rows.length === 0) {
    const cg = table.querySelector('colgroup');
    if (cg) cg.remove();
    queryTableRows = [];
    queryTableCols = [];
    queryColsSig = '';
    queryRigheRef = rows;
    tbody.innerHTML = '<tr><td style="color: var(--fg-dim); text-align: center;">Nessun risultato da mostrare</td></tr>';
    return;
  }

  const cols = new Set();
  rows.forEach((r) => {
    if (r && typeof r === 'object') {
      Object.keys(r).forEach((k) => cols.add(k));
    }
  });

  queryTableCols = Array.from(cols);
  const sig = queryTableCols.join('\u0000');
  const nuoveColonne = sig !== queryColsSig;
  const nuoviDati = rows !== queryRigheRef;
  queryColsSig = sig;
  queryRigheRef = rows;

  if (nuoveColonne) {
    // Result set di un'altra forma: larghezze scelte a mano e ordinamento non
    // hanno più un riferimento: si riparte da zero.
    queryLarghezze = new Map();
    queryLarghezzeManuali = new Set();
    queryOrdine = { col: null, dir: 1 };
  } else if (queryOrdine.col && !queryTableCols.includes(queryOrdine.col)) {
    queryOrdine = { col: null, dir: 1 };
  }

  // Le larghezze si misurano sui dati nuovi; a parità di dati (cambio di vista,
  // ordinamento) si riusano quelle già calcolate, altrimenti le colonne
  // cambierebbero larghezza sotto gli occhi senza motivo.
  if (nuoveColonne || nuoviDati) calcolaLarghezze(rows, queryTableCols, table);

  // L'ordinamento è una vista: `currentResults` resta nell'ordine del database.
  queryTableRows = queryOrdine.col
    ? ordinaRighe(rows, queryOrdine.col, queryOrdine.dir)
    : rows;

  applicaColgroup(table);
  costruisciIntestazione(thead);

  attachQueryVScroll();
  attachQueryHeaderEvents();
  container.scrollTop = 0;
  if (nuoveColonne || nuoviDati) container.scrollLeft = 0;
  renderQueryVirtualWindow();
}

// Render JSON Tree View
function renderResultsJsonTree(data) {
  const container = $('#query-json-tree');
  if (!container) return;
  container.innerHTML = '';

  if (!data || (Array.isArray(data) && data.length === 0)) {
    container.innerHTML = '<span style="color: var(--fg-dim);">Nessun risultato da mostrare</span>';
    return;
  }

  const tree = buildJsonNode(data, 'root', true);
  container.appendChild(tree);
}



// Render Schema Browser (Task 2)
export function renderQuerySchemaBrowser() {
  const container = $('#query-schema-tree');
  if (!container) return;
  container.innerHTML = '';

  const dbs = state.databases || [];
  if (dbs.length === 0) {
    container.innerHTML = '<div style="color: var(--fg-dim); padding: 10px;">Nessun database caricato.</div>';
    return;
  }

  dbs.forEach((dbObj) => {
    const dbName = typeof dbObj === 'string' ? dbObj : (dbObj && dbObj.name ? dbObj.name : String(dbObj));
    const dbNode = document.createElement('div');
    dbNode.className = 'schema-node';
    // Nome "nudo" per la ricerca: il testo dell'etichetta porta con sé icone e
    // tipo delle colonne, che nel confronto sono rumore.
    dbNode.dataset.nome = dbName;
    dbNode.dataset.tipo = 'db';

    const dbLabel = document.createElement('div');
    dbLabel.className = 'schema-node-label';
    dbLabel.innerHTML = `<span>🗄 <strong>${escapeHtml(dbName)}</strong></span>`;

    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'schema-node-children hidden';

    dbLabel.addEventListener('click', () => {
      const isHidden = childrenContainer.classList.contains('hidden');
      childrenContainer.classList.toggle('hidden', !isHidden);

      if (isHidden && childrenContainer.children.length === 0) {
        // Carica collezioni/tabelle
        fetchCollectionsForSchemaBrowser(dbName, childrenContainer);
      }
    });

    dbNode.appendChild(dbLabel);
    dbNode.appendChild(childrenContainer);
    container.appendChild(dbNode);

    // Auto-espandi il DB attivo corrente se corrisponde
    if (state.db && dbName === state.db) {
      childrenContainer.classList.remove('hidden');
      fetchCollectionsForSchemaBrowser(dbName, childrenContainer);
    }
  });

  // L'albero è appena stato ricostruito: se una ricerca è in corso va
  // ri-applicata, altrimenti la casella resta piena e il filtro sparito.
  filtroSchemaAttivo = '';
  riapplicaFiltroSchema();
}

/* Restituisce una promessa che si risolve a caricamento finito (anche in caso
   di errore): serve al filtro, che dopo aver caricato i database mancanti deve
   ri-applicarsi sui nodi appena comparsi. */
function fetchCollectionsForSchemaBrowser(dbName, container) {
  container.innerHTML = '<div style="color: var(--fg-dim); padding: 4px;">Caricamento schema...</div>';
  return emit('db:schema', { db: dbName })
    .then((res) => {
      // Schema Browser: il contenitore appartiene all'albero della connessione
      // mostrata; una risposta in ritardo di un altro tab lo riempirebbe di
      // tabelle inesistenti.
      if (!isForActiveTab(res)) return;
      renderSchemaTreeForDb(dbName, container, res.collections);
      riapplicaFiltroSchema();
    })
    .catch(() => {
      // Fallback su db:collections in caso di errore
      return emit('db:collections', { db: dbName })
        .then((res) => {
          if (!isForActiveTab(res)) return;
          renderSchemaTreeForDb(dbName, container, res.collections);
          riapplicaFiltroSchema();
        })
        .catch((err) => {
          if (!isForActiveTab(err)) return;
          container.innerHTML = `<div style="color: var(--danger); font-size: 0.85em;">${escapeHtml(err.message || 'Errore caricamento')}</div>`;
        });
    });
}

function renderSchemaTreeForDb(dbName, container, collections) {
  container.innerHTML = '';
  if (!collections || !collections.length) {
    container.innerHTML = '<div style="color: var(--fg-dim); font-size: 0.85em; padding-left: 6px;">(Nessuna collezione/tabella)</div>';
    return;
  }

  collections.forEach((item) => {
    const collName = typeof item === 'string' ? item : (item && item.name ? item.name : String(item));
    const fields = (item && Array.isArray(item.fields)) ? item.fields : [];

    const collNode = document.createElement('div');
    collNode.className = 'schema-node';
    collNode.dataset.nome = collName;
    collNode.dataset.tipo = 'coll';

    const collLabel = document.createElement('div');
    collLabel.className = 'schema-node-label';
    collLabel.draggable = true;
    const icon = state.dbType === 'mysql' ? '📋' : '📁';
    collLabel.innerHTML = `<span>${icon} <strong>${escapeHtml(collName)}</strong></span>`;

    // Drag & Drop
    collLabel.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', collName);
    });

    // Click per inserire nome nell'editor
    collLabel.addEventListener('dblclick', () => {
      insertTextInEditor(collName);
    });

    const fieldsContainer = document.createElement('div');
    fieldsContainer.className = 'schema-node-children hidden';

    if (fields.length > 0) {
      fields.forEach((field) => {
        const fieldName = typeof field === 'string' ? field : (field.name || field.column || JSON.stringify(field));
        const fieldType = typeof field === 'object' ? (field.type || (Array.isArray(field.types) ? field.types.join('|') : (field.dataType || ''))) : '';

        const fieldNode = document.createElement('div');
        fieldNode.className = 'schema-node';
        fieldNode.dataset.nome = fieldName;
        fieldNode.dataset.tipo = 'campo';

        const fieldLabel = document.createElement('div');
        fieldLabel.className = 'schema-node-label';
        fieldLabel.draggable = true;
        fieldLabel.style.fontSize = '0.85em';
        fieldLabel.innerHTML = `<span>🔹 ${escapeHtml(fieldName)}</span> ${fieldType ? `<span class="schema-node-type">${escapeHtml(fieldType)}</span>` : ''}`;

        fieldLabel.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', fieldName);
        });

        fieldLabel.addEventListener('dblclick', () => {
          insertTextInEditor(fieldName);
        });

        fieldNode.appendChild(fieldLabel);
        fieldsContainer.appendChild(fieldNode);
      });
    } else {
      fieldsContainer.innerHTML = '<div style="color: var(--fg-dim); font-size: 0.85em; padding-left: 6px;">(Nessun campo rilevato)</div>';
    }

    collLabel.addEventListener('click', (e) => {
      if (e.target.closest('.mini-btn')) return;
      setQueryTarget(dbName, collName);
      fieldsContainer.classList.toggle('hidden');
    });

    collNode.appendChild(collLabel);
    collNode.appendChild(fieldsContainer);
    container.appendChild(collNode);
  });
}

/* ---------------------------------------------------------------------------
 * Filtro dello Schema Browser.
 *
 * L'albero ha tre livelli (database ▸ tabella/collezione ▸ campo) e la versione
 * precedente confrontava la stringa cercata con l'etichetta di OGNI nodo,
 * nascondendo quelli che non corrispondevano — senza mai guardare i figli. Su
 * un albero gerarchico è il difetto peggiore possibile: cercando il nome di una
 * tabella, il database che la contiene non corrisponde, viene nascosto, e con
 * lui sparisce la tabella trovata. In pratica il filtro funzionava solo per i
 * nomi di database.
 *
 * Le regole ora sono quelle che ci si aspetta da un albero:
 *   1. un nodo resta visibile se corrisponde lui, un suo ANTENATO o un suo
 *      DISCENDENTE (quindi il percorso verso un risultato non si interrompe);
 *   2. i rami che portano a un risultato si APRONO da soli, altrimenti il match
 *      resterebbe dentro un nodo chiuso;
 *   3. cancellando la ricerca l'albero torna com'era, aperture comprese;
 *   4. il confronto è sul NOME (dataset.nome), non sul testo dell'etichetta:
 *      quello contiene anche il tipo della colonna, e cercare "int" tirava su
 *      ogni colonna intera del database.
 * Resta un limite dichiarato: i database non ancora espansi non hanno figli nel
 * DOM (le tabelle si caricano su richiesta), quindi non sono cercabili finché
 * non li si carica — e il pannello lo dice, con un pulsante che li carica.
 * ------------------------------------------------------------------------- */

let filtroSchemaAttivo = '';

/**
 * Ricorsione sull'albero. Restituisce DUE informazioni, e tenerle distinte è il
 * punto: `visibile` (il nodo resta a schermo) e `trovato` (il nodo o qualcosa
 * sotto di lui corrisponde davvero). Un discendente di un nodo trovato è
 * visibile ma NON trovato — confondere le due cose fa aprire da solo l'intero
 * sottoalbero di ogni risultato: cercata una tabella, si spalancano tutti i suoi
 * campi, e cercato un database si spalanca tutto il database.
 */
function visitaNodoSchema(nodo, q, antenatoTrovato) {
  const nome = (nodo.dataset.nome || '').toLowerCase();
  const proprio = !!q && nome.includes(q);
  const dentroUnMatch = antenatoTrovato || proprio;

  const cont = nodo.querySelector(':scope > .schema-node-children');
  let discendenteTrovato = false;
  if (cont) {
    cont.querySelectorAll(':scope > .schema-node').forEach((figlio) => {
      if (visitaNodoSchema(figlio, q, dentroUnMatch).trovato) discendenteTrovato = true;
    });
  }

  const visibile = !q || proprio || discendenteTrovato || antenatoTrovato;
  nodo.classList.toggle('schema-nascosto', !visibile);
  nodo.classList.toggle('schema-hit', proprio);

  // Si apre solo il ramo che PORTA a un risultato; il nodo che corrisponde di
  // suo resta com'era (trovata la tabella, i suoi campi non si spalancano).
  if (cont && q && discendenteTrovato) cont.classList.remove('hidden');

  return { visibile, trovato: proprio || discendenteTrovato };
}

function filterQuerySchemaBrowser(query) {
  const albero = $('#query-schema-tree');
  if (!albero) return;
  const q = String(query || '').trim().toLowerCase();

  const contenitori = albero.querySelectorAll('.schema-node-children');

  if (q && !filtroSchemaAttivo) {
    // Inizio di una ricerca: si annota lo stato di apertura per poterlo
    // ripristinare quando la casella viene svuotata.
    contenitori.forEach((c) => { c.dataset.eraChiuso = c.classList.contains('hidden') ? '1' : '0'; });
  }

  albero.querySelectorAll(':scope > .schema-node').forEach((nodo) => {
    visitaNodoSchema(nodo, q, false);
  });
  const trovati = q ? albero.querySelectorAll('.schema-hit').length : 0;

  if (!q && filtroSchemaAttivo) {
    contenitori.forEach((c) => {
      // Chi non ha l'attributo è nato DURANTE la ricerca — i database caricati
      // da "Cerca anche negli altri N database", o l'espansione automatica del
      // database attivo — e il suo stato di apertura non è mai stato deciso
      // dall'utente: il predefinito è chiuso. Saltarli li lasciava spalancati
      // dopo aver svuotato la casella.
      const eraChiuso = c.dataset.eraChiuso === undefined ? '1' : c.dataset.eraChiuso;
      c.classList.toggle('hidden', eraChiuso === '1');
      delete c.dataset.eraChiuso;
    });
  }

  filtroSchemaAttivo = q;
  aggiornaNotaFiltroSchema(albero, q, trovati);
}

/**
 * Nota sotto l'albero: quanti risultati, e soprattutto quanti database NON sono
 * stati cercati perché le loro tabelle non sono ancora state caricate. Senza
 * questa riga, "nessun risultato" sarebbe una risposta falsa: la tabella cercata
 * può benissimo esserci, in un database mai aperto.
 */
function aggiornaNotaFiltroSchema(albero, q, trovati) {
  let nota = $('#query-schema-filtro-nota');
  if (!nota) {
    nota = document.createElement('div');
    nota.id = 'query-schema-filtro-nota';
    nota.className = 'query-schema-filtro-nota';
    albero.parentNode.insertBefore(nota, albero.nextSibling);
  }

  if (!q) {
    nota.classList.add('hidden');
    nota.innerHTML = '';
    return;
  }

  const daCaricare = [...albero.querySelectorAll(':scope > .schema-node')].filter((n) => {
    const c = n.querySelector(':scope > .schema-node-children');
    return c && c.children.length === 0;
  });

  nota.classList.remove('hidden');
  nota.innerHTML = '';

  const riga = document.createElement('div');
  riga.textContent = trovati > 0
    ? `${trovati} corrispondenz${trovati === 1 ? 'a' : 'e'}`
    : 'Nessuna corrispondenza fra gli elementi già caricati';
  nota.appendChild(riga);

  if (daCaricare.length) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini-btn';
    btn.textContent = `Cerca anche negli altri ${daCaricare.length} database`;
    btn.title = 'Le tabelle si caricano su richiesta: i database mai aperti non sono ancora cercabili';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Caricamento…';
      Promise.all(daCaricare.map((n) => {
        const c = n.querySelector(':scope > .schema-node-children');
        c.classList.remove('hidden');
        return fetchCollectionsForSchemaBrowser(n.dataset.nome, c);
      })).then(() => {
        filterQuerySchemaBrowser($('#query-schema-search')?.value || q);
      });
    });
    nota.appendChild(btn);
  }
}

/** Ri-applica il filtro corrente: l'albero viene ricostruito di continuo
 *  (nuovi database, tabelle caricate su richiesta) e i nodi nuovi nascono
 *  senza sapere che c'è una ricerca in corso. */
function riapplicaFiltroSchema() {
  const input = $('#query-schema-search');
  if (input && input.value.trim()) filterQuerySchemaBrowser(input.value);
}

function insertTextInEditor(text) {
  const input = $('#query-editor-input');
  if (!input) return;
  const start = input.selectionStart || 0;
  const end = input.selectionEnd || 0;
  const val = input.value;
  input.value = val.substring(0, start) + text + val.substring(end);
  input.selectionStart = input.selectionEnd = start + text.length;
  input.focus();
  updateEditorHighlight();
}

// La query in volo vive nello stato del TAB (`state.queryRunId`, freshState in
// tabs.js): come variabile di modulo, runId e tabId potevano appartenere a due
// tab diversi. Vedi la nota lì e la migrazione già fatta per queryDb.

/* ---------------------------------------------------------------------------
 * Bersaglio della tab Query & Aggregate.
 *
 * Il default e' il contesto del workspace (la collection aperta): `state.db` /
 * `state.coll`. Cliccando una tabella nello Schema Browser, o eseguendo un
 * `USE <db>`, si fissa un bersaglio ESPLICITO che vince sul contesto.
 *
 * Quel bersaglio pero' deve decadere quando il contesto cambia, e viveva in due
 * variabili di MODULO: una volta scelto un database restava per sempre, per
 * tutti i tab di connessione e per tutte le collection aperte dopo — la query
 * continuava a girare sul primo database toccato. Ora sta nello stato del tab
 * (`state.queryDb`/`state.queryColl`, vedi freshState in tabs.js) e viene
 * azzerato all'attivazione di un coll-tab (colltabs.js), cosi' la tab segue di
 * nuovo cio' che l'utente sta guardando.
 * ------------------------------------------------------------------------- */

/** Imposta il bersaglio esplicito (null/undefined = torna a seguire il contesto). */
export function setQueryTarget(db, coll) {
  state.queryDb = db || null;
  state.queryColl = coll || null;
  renderQueryTarget();
}

/** Bersaglio effettivo su cui girera' la prossima query. */
export function queryTarget() {
  return { db: state.queryDb || state.db || null, coll: state.queryColl || state.coll || null };
}

// Indicatore sempre visibile nella barra della tab: prima non c'era modo di
// sapere su quale database si stesse per eseguire.
export function renderQueryTarget() {
  const el = $('#query-target-label');
  if (!el) return;
  const { db, coll } = queryTarget();
  const explicit = !!state.queryDb;
  el.textContent = db ? `${db}${coll ? ' \u25b8 ' + coll : ''}` : 'nessun database selezionato';
  el.classList.toggle('query-target-explicit', explicit);
  el.title = db
    ? (explicit
      ? `Bersaglio scelto a mano nello Schema Browser. Clicca per tornare al contesto della collection aperta (${state.db || 'nessuna'}).`
      : 'Bersaglio: la collection aperta nel workspace.')
    : 'Apri una collection oppure scegli una tabella nello Schema Browser.';
  const reset = $('#query-target-reset');
  if (reset) reset.classList.toggle('hidden', !explicit);
}

export function cancelActiveQuery() {
  const stopBtn = $('#query-stop-btn');
  if (stopBtn) stopBtn.classList.add('hidden');

  // runId e tabId devono venire dallo STESSO tab: si legge il tab attivo una
  // volta sola e da lì il suo runId, invece di incrociare una variabile di
  // modulo con il tab del momento.
  const curTab = activeTab();
  const st = (curTab && curTab.state) || state;
  const runIdToCancel = st.queryRunId;
  if (runIdToCancel) {
    st.queryRunId = null;
    const currentTabId = curTab ? curTab.id : undefined;
    emit('query:cancel', { tabId: currentTabId, runId: runIdToCancel })
      .catch((err) => console.warn('[QueryTab] Errore invio query:cancel:', err));
    markPaused(runIdToCancel);
    updateQueryMetrics('idle');
    toast('Query annullata dall\'utente');
  }
}

/**
 * Esecuzione della query o dello script.
 *
 * @param {{code?: string}} [opzioni] `code` esegue QUEL testo invece del
 *   contenuto dell'editor: serve a "esegui solo la selezione" (Ctrl+Invio su
 *   un pezzo di script) senza duplicare tutto il percorso di esecuzione.
 */
export function runQuery(opzioni = {}) {
  const editorInput = $('#query-editor-input');
  if (!editorInput) return;
  const code = String(opzioni.code || editorInput.value).trim();
  if (!code) return;

  // Una nuova esecuzione azzera la segnalazione precedente.
  segnalaRigaErrore(0);

  const engine = $('#query-target-engine')?.value || 'auto';

  // Più istruzioni = SCRIPT: percorso diverso (esecuzione a passi lato server,
  // con progresso, pausa e ripresa) invece dell'ack unico di `query:execute`.
  // Il conteggio qui serve solo a scegliere la strada: quante siano davvero lo
  // decide il server, che è l'unico a dividere il testo per l'esecuzione.
  if (isScript(code)) {
    const { db: scriptDb, coll: scriptColl } = queryTarget();
    return runScript({
      code,
      engine,
      db: scriptDb,
      coll: scriptColl,
      stopOnError: !!$('#query-stop-on-error')?.checked,
    });
  }
  updateQueryMetrics('running');
  executionStartTime = performance.now();

  const stopBtn = $('#query-stop-btn');
  if (stopBtn) stopBtn.classList.remove('hidden');

  const runId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : (Date.now() + '-' + Math.random().toString(36).slice(2));
  const curTab = activeTab();
  const currentTabId = curTab ? curTab.id : undefined;
  // Il run appartiene al tab che lo lancia: il tab d'origine è quello a cui
  // andranno l'annullamento e l'azzeramento alla risposta.
  const statoRun = (curTab && curTab.state) || state;
  statoRun.queryRunId = runId;
  const { db: targetDb, coll: targetColl } = queryTarget();
  const connName = state.connName || state.connId || 'Default';
  const collTabId = state.activeCollId || null;

  const pendingHandle = trackPending({
    runId,
    code,
    engine,
    db: targetDb,
    coll: targetColl,
    connName,
    tabId: currentTabId,
    collTabId
  });

  // Emissione evento socket query:execute
  return emit('query:execute', {
    code,
    engine,
    db: targetDb,
    coll: targetColl,
    dbType: state.dbType,
    tabId: currentTabId,
    runId
  })
    .then((res) => {
      const elapsed = Math.round(performance.now() - executionStartTime);
      if (stopBtn) stopBtn.classList.add('hidden');
      // Si azzera nello stato del TAB D'ORIGINE (res._state), non in quello
      // attivo al ritorno della risposta.
      const stRun = (res && res._state) || statoRun;
      if (stRun.queryRunId === runId) stRun.queryRunId = null;

      pendingHandle.done(res, elapsed);
      segnaTraguardo('query'); // primi passi della guida (no-op se già fatto)
      const rows = res.data || res.docs || res.rows || [];

      // Se il server segnala un cambio di database (es. via USE <dbname>).
      // Il bersaglio appartiene al tab CHE HA ESEGUITO, non a quello attivo al
      // ritorno della risposta: `state` è un Proxy sul tab attivo, quindi
      // scriverci direttamente spostava il bersaglio del tab sbagliato — e la
      // query successiva partiva verso un altro database senza alcun avviso.
      if (res && res.activeDb) {
        const st = res._state || state;
        st.queryDb = res.activeDb;
        st.queryColl = null;
        if (isForActiveTab(res)) renderQueryTarget();
      }

      // Il pannello dei risultati è unico: i risultati di un tab passato in
      // background restano nello storico delle query in sospeso, ma non devono
      // sostituire ciò che l'utente sta guardando su un'altra connessione.
      if (isForActiveTab(res)) {
        updateQueryMetrics('success', elapsed, rows.length);
        renderResults(rows);
        // Un DDL riuscito cambia l'albero: senza questo l'oggetto creato
        // esisteva davvero ma non compariva nella sidebar finché non si
        // riapriva la connessione, e sembrava che il comando non avesse
        // fatto nulla.
        if (cambiaStruttura(code)) refreshDbTree();
      }
      return res;
    })
    .catch((err) => {
      const elapsed = Math.round(performance.now() - executionStartTime);
      if (stopBtn) stopBtn.classList.add('hidden');
      const stRunErr = (err && err._state) || statoRun;
      if (stRunErr.queryRunId === runId) stRunErr.queryRunId = null;

      pendingHandle.fail(err, elapsed);
      if (isForActiveTab(err)) {
        updateQueryMetrics('error', elapsed, 0, err.message || 'Errore durante l\'esecuzione della query');
        renderResults([]);
        // "… (riga 12)" nel messaggio: la riga viene evidenziata nel gutter e
        // portata in vista, invece di lasciarla cercare a mano.
        if (!opzioni.code) segnalaRigaErrore(rigaDaMessaggio(err.message));
      }
      throw err;
    });
}

// Esportazione dei risultati raw da memoria (tutti i record caricati)
export function exportQueryResults(format) {
  if (!currentResults || !currentResults.length) {
    alert('Nessun dato da esportare.');
    return;
  }

  // Si esporta quello che si VEDE: se la tabella è ordinata per una colonna, un
  // CSV nell'ordine originale del database sarebbe una sorpresa silenziosa.
  const rows = (queryOrdine.col && queryTableRows.length === currentResults.length)
    ? queryTableRows
    : currentResults;
  const cols = new Set();
  rows.forEach((r) => {
    if (r && typeof r === 'object') {
      Object.keys(r).forEach((k) => cols.add(k));
    }
  });
  const headers = Array.from(cols);

  let content = '';
  let filename = `query_result_${Date.now()}`;
  let mimeType = 'text/plain';

  // "Quello che si vede" vale anche per i VALORI, non solo per l'ordine delle
  // righe: la tabella disegna un ObjectId come 507f… e una data come istante
  // leggibile, mentre l'export scriveva la forma EJSON grezza. displayValue è
  // la forma esatta e non troncata — la stessa che la griglia dati copia negli
  // appunti (cellselect.js), così due export della stessa cella coincidono.
  // L'EJSON integrale resta nel solo formato JSON, dove è il contenuto giusto.
  const testoCella = (val) => (val === null || val === undefined ? '' : displayValue(val).text);

  // Letterali SQL, non stringhe infilate fra apici. Tre difetti distinti da
  // chiudere: NULL fra apici diventava la stringa vuota e i numeri diventavano
  // stringhe; l'apice veniva protetto con la barra rovesciata, che è
  // un'estensione MySQL (su PostgreSQL, uno dei tre DBMS supportati, lo
  // standard è il RADDOPPIO e lo script risultava errato o interpretato
  // diversamente); e la barra rovesciata nel valore non veniva raddoppiata,
  // quindi un valore che finisce con "\" spostava la fine della stringa e
  // concatenava il valore successivo.
  const letteraleSql = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    const testo = testoCella(v);
    // Un $numberLong/$numberDecimal è un numero, non un testo.
    if (ejsonKind(v) === 'number' && testo !== '' && Number.isFinite(Number(testo))) return testo;
    return `'${testo.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  };

  if (format === 'csv') {
    filename += '.csv';
    mimeType = 'text/csv';
    content = headers.join(',') + '\n';
    rows.forEach((r) => {
      const vals = headers.map((h) => {
        const strVal = testoCella(r ? r[h] : '');
        return `"${strVal.replace(/"/g, '""')}"`;
      });
      content += vals.join(',') + '\n';
    });
  } else if (format === 'json') {
    filename += '.json';
    mimeType = 'application/json';
    content = JSON.stringify(rows, null, 2);
  } else if (format === 'sql') {
    filename += '.sql';
    mimeType = 'application/sql';
    content = rows.map((r) => {
      const rowCols = Object.keys(r).map((k) => `\`${k.replace(/`/g, '``')}\``).join(', ');
      const vals = Object.values(r).map(letteraleSql).join(', ');
      return `INSERT INTO \`query_result\` (${rowCols}) VALUES (${vals});`;
    }).join('\n');
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
