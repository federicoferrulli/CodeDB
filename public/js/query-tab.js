import { state } from './state.js';
import { activeTab } from './tabs.js';
import { $, emit, displayValue, positionFixedDropdown, buildJsonNode, esc, showSkeletonGrid, toast, isForActiveTab } from './utils.js';
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
    schemaSearchInput.addEventListener('input', (e) => {
      filterQuerySchemaBrowser(e.target.value.toLowerCase());
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

let queryTableRows = [];
let queryTableCols = [];
let queryVScrollAttached = false;
const QUERY_ROW_H = 36;
const QUERY_OVERSCAN = 6;

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
      const res = displayValue(val);
      td.textContent = (res && typeof res === 'object') ? (res.text ?? '') : String(res ?? '');
      if (res && res.cls) td.className = res.cls;
      if (res && res.dataVal !== undefined) td.dataset.val = res.dataVal;
      td.title = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
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
    tbody.innerHTML = '<tr><td style="color: var(--fg-dim); text-align: center;">Nessun risultato da mostrare</td></tr>';
    return;
  }

  const cols = new Set();
  rows.forEach((r) => {
    if (r && typeof r === 'object') {
      Object.keys(r).forEach((k) => cols.add(k));
    }
  });

  queryTableRows = rows;
  queryTableCols = Array.from(cols);

  const headerTr = document.createElement('tr');
  queryTableCols.forEach((colName) => {
    const th = document.createElement('th');
    th.textContent = colName;
    headerTr.appendChild(th);
  });
  thead.appendChild(headerTr);

  attachQueryVScroll();
  container.scrollTop = 0;
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
}

function fetchCollectionsForSchemaBrowser(dbName, container) {
  container.innerHTML = '<div style="color: var(--fg-dim); padding: 4px;">Caricamento schema...</div>';
  emit('db:schema', { db: dbName })
    .then((res) => {
      // Schema Browser: il contenitore appartiene all'albero della connessione
      // mostrata; una risposta in ritardo di un altro tab lo riempirebbe di
      // tabelle inesistenti.
      if (!isForActiveTab(res)) return;
      renderSchemaTreeForDb(dbName, container, res.collections);
    })
    .catch(() => {
      // Fallback su db:collections in caso di errore
      emit('db:collections', { db: dbName })
        .then((res) => {
          if (!isForActiveTab(res)) return;
          renderSchemaTreeForDb(dbName, container, res.collections);
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

function filterQuerySchemaBrowser(query) {
  const nodes = document.querySelectorAll('#query-schema-tree .schema-node-label');
  nodes.forEach((node) => {
    const text = node.textContent.toLowerCase();
    const parentNode = node.closest('.schema-node');
    if (parentNode) {
      const match = !query || text.includes(query);
      parentNode.style.display = match ? 'block' : 'none';
    }
  });
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

let currentRunId = null;

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

  if (currentRunId) {
    const runIdToCancel = currentRunId;
    currentRunId = null;
    const curTab = activeTab();
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
  currentRunId = runId;

  const curTab = activeTab();
  const currentTabId = curTab ? curTab.id : undefined;
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
      if (currentRunId === runId) currentRunId = null;

      pendingHandle.done(res, elapsed);
      const rows = res.data || res.docs || res.rows || [];

      // Se il server segnala un cambio di database (es. via USE <dbname>)
      if (res && res.activeDb) {
        // `USE <db>` nel Query Engine: da qui in poi il bersaglio e' esplicito.
        setQueryTarget(res.activeDb, null);
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
      if (currentRunId === runId) currentRunId = null;

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

  const rows = currentResults;
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

  if (format === 'csv') {
    filename += '.csv';
    mimeType = 'text/csv';
    content = headers.join(',') + '\n';
    rows.forEach((r) => {
      const vals = headers.map((h) => {
        const val = r ? r[h] : '';
        const strVal = typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val ?? '');
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
      const rowCols = Object.keys(r).map((k) => `\`${k}\``).join(', ');
      const vals = Object.values(r).map((v) => {
        const strVal = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
        return `'${strVal.replace(/'/g, "\\'")}'`;
      }).join(', ');
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
