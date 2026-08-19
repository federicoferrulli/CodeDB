/**
 * CodeDB — Esecuzione di SCRIPT dalla tab ⚡ Query & Aggregate (lato client)
 *
 * Uno script non è una query più lunga: è un'esecuzione che DURA, quindi qui
 * non si aspetta un ack e si disegna il risultato. Si avvia (`script:execute`),
 * si segue l'avanzamento con gli eventi push `script:progress` e si può
 * mettere in pausa e riprendere dal punto esatto — esattamente il trattamento
 * che Keus ha chiesto: gli script sono **query in sospeso** a tutti gli
 * effetti, e infatti ogni run ha la sua voce nel registro di
 * `pending-queries.js`.
 *
 * Divisione del lavoro col server: il client decide solo COME instradare
 * (query singola o script) e come mostrare; quante e quali istruzioni vengano
 * eseguite lo decide il server, che è l'unico a dividere il testo per davvero.
 */

import { $, esc, toast, emit } from './utils.js';
import { socket } from './socket.js';
import { activeTab } from './tabs.js';
import { state } from './state.js';
import { countStatements } from './sql-split.js';
import {
  trackPending, updateScriptProgress, removePending,
} from './pending-queries.js';
import { renderResults, updateQueryMetrics } from './query-tab.js';
import { refreshDbTree } from './dbtree.js';
import { segnalaRigaErrore } from './query-editor.js';
import {
  unisciLog, righeDaMostrare, haRisultato,
  etichettaScheda, schedaAttiva, notaScartate,
} from './script-esito.js';

// Run seguiti da questo browser: runId → { tabId, collTabId, total, stato }.
const runs = new Map();
// Run mostrato nel pannello (l'ultimo avviato o ripreso dall'utente).
let runVisibile = null;

const MAX_LOG = 200;

/** Identificativo di run, come per le query singole. */
function nuovoRunId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : (Date.now() + '-' + Math.random().toString(36).slice(2));
}

/**
 * Avvia uno script. Ritorna una promise che si risolve all'AVVIO (non alla
 * fine): la fine arriva con gli eventi di progresso.
 */
export function runScript({ code, engine, db, coll, stopOnError = false } = {}) {
  const testo = String(code || '').trim();
  if (!testo) return Promise.resolve(null);

  const tab = activeTab();
  const tabId = tab ? tab.id : undefined;
  const runId = nuovoRunId();
  const totalePrevisto = countStatements(testo);

  const handle = trackPending({
    runId,
    code: testo,
    engine: engine || 'auto',
    db,
    coll,
    connName: state.connName || state.connId || 'Default',
    tabId,
    collTabId: state.activeCollId || null,
    kind: 'script',
    total: totalePrevisto,
  });

  // Promise che si risolve quando il run FINISCE (o viene interrotto): serve a
  // chi esegue script in sequenza — il pannello dei file .sql a blocchi — che
  // altrimenti li lancerebbe tutti insieme, visto che `runScript` ritorna
  // all'avvio e non alla fine.
  const attesa = {};
  attesa.promise = new Promise((resolve) => { attesa.resolve = resolve; });

  runs.set(runId, {
    runId, tabId, total: totalePrevisto, handle, log: [], stato: null, attesa,
    // Elenco delle schede di risultato (arriva a fine script) e quale è aperta.
    risultati: null, schedaAperta: null,
  });
  runVisibile = runId;

  mostraPannello();
  aggiornaPannello({ status: 'running', cursor: 0, total: totalePrevisto, eseguiti: 0, falliti: 0 });
  updateQueryMetrics('running');

  return emit('script:execute', {
    code: testo,
    engine,
    db,
    coll,
    tabId,
    runId,
    stopOnError,
  })
    .then((res) => {
      const r = runs.get(runId);
      if (r && res && res.total) r.total = res.total;
      toast(`Script avviato: ${res.total} istruzioni`);
      aggiornaPannello({ status: 'running', cursor: 0, total: res.total, eseguiti: 0, falliti: 0 });
      return res;
    })
    .catch((err) => {
      // L'avvio è fallito: il run non esiste lato server, quindi la voce in
      // sospeso va chiusa come errore invece di restare "in esecuzione".
      handle.fail(err);
      attesa.resolve({ status: 'error', error: err.message, eseguiti: 0, falliti: 0, total: 0 });
      runs.delete(runId);
      if (runVisibile === runId) nascondiPannello();
      updateQueryMetrics('error', null, 0, err.message || 'Avvio dello script non riuscito');
      throw err;
    });
}

/**
 * Avvia uno script e attende che FINISCA (o venga interrotto). Usato dove
 * l'esecuzione dev'essere sequenziale, come i blocchi di un file .sql grande:
 * con `runScript` partirebbero tutti insieme.
 */
export function runScriptAndWait(meta) {
  return runScript(meta).then((res) => {
    if (!res || !res.runId) return null;
    const r = runs.get(res.runId);
    return r && r.attesa ? r.attesa.promise : null;
  });
}

/** Pausa (dolce o forzata) del run mostrato o di quello indicato. */
export function pauseScript(runId = runVisibile, force = false) {
  if (!runId) return Promise.resolve(null);
  const r = runs.get(runId);
  return emit('script:pause', { runId, tabId: r && r.tabId, force })
    .then((res) => {
      if (res && !res.paused) {
        toast('Lo script era già concluso o già in pausa');
      } else if (force) {
        toast('Pausa forzata: l\'istruzione in corso è stata interrotta e verrà rilanciata alla ripresa');
      } else {
        toast('Pausa richiesta: si ferma dopo l\'istruzione in corso');
      }
      return res;
    })
    .catch((err) => {
      toast(`Impossibile mettere in pausa: ${err.message}`, true);
    });
}

/** Ripresa dal cursore conservato lato server. */
export function resumeScript(runId = runVisibile) {
  if (!runId) return Promise.resolve(null);
  const r = runs.get(runId);
  runVisibile = runId;
  mostraPannello();
  return emit('script:resume', { runId, tabId: r && r.tabId })
    .then((res) => {
      if (res && res.stato) aggiornaPannello(res.stato);
      toast('Script ripreso');
      return res;
    })
    .catch((err) => {
      toast(`Ripresa non riuscita: ${err.message}`, true);
      throw err;
    });
}

/** Interruzione definitiva. */
export function abortScript(runId = runVisibile) {
  if (!runId) return Promise.resolve(null);
  const r = runs.get(runId);
  return emit('script:abort', { runId, tabId: r && r.tabId })
    .then((res) => {
      // Il server cancella subito il run: l'evento `aborted` può non arrivare
      // (il ciclo era fermo in pausa), quindi lo stato finale lo scriviamo qui.
      // Deve risultare "interrotto" e non "in pausa", altrimenti il registro
      // offrirebbe una ripresa che il server non può più onorare.
      const finale = { ...(r && r.stato), status: 'aborted' };
      updateScriptProgress(runId, finale);
      toast('Script interrotto');
      if (runVisibile === runId) aggiornaPannello(finale);
      if (r && r.attesa) r.attesa.resolve(finale);
      return res;
    })
    .catch(() => {});
}

/** Il run è ancora attivo (in esecuzione o in pausa)? */
export function isScriptActive(runId = runVisibile) {
  const r = runs.get(runId);
  return !!r && r.stato && (r.stato.status === 'running' || r.stato.status === 'paused');
}

/* --- Eventi push ----------------------------------------------------------- */

function onProgress(ev) {
  if (!ev || !ev.runId) return;
  const r = runs.get(ev.runId);
  if (!r) return; // run di un'altra scheda del browser o già dimenticato

  const stato = ev.stato || {};
  r.stato = stato;
  r.total = stato.total || r.total;

  // Il registro delle query in sospeso segue lo stato reale: è da lì che
  // l'utente riprende uno script lasciato a metà.
  updateScriptProgress(ev.runId, stato);

  // Il resoconto completo degli eventi terminali rimpiazza il log raccolto
  // per strada, che il diradamento degli eventi lascia incompleto (vedi
  // script-esito.js).
  r.log = unisciLog(r.log, stato, MAX_LOG);

  if (ev.tipo === 'statement' && ev.result) {
    r.log.push(ev.result);
    if (r.log.length > MAX_LOG) r.log.splice(0, r.log.length - MAX_LOG);
    // Prima istruzione fallita: si evidenzia la riga nel sorgente. È il punto
    // in cui l'utente deve guardare, e con uno script lungo trovarlo a mano
    // è il lavoro più noioso.
    if (!ev.result.ok && !ev.result.interrupted && runVisibile === ev.runId) {
      segnalaRigaErrore(ev.result.line);
    }
  }

  // Solo il run mostrato tocca il pannello: gli altri aggiornano comunque il
  // registro (badge e modale delle query in sospeso).
  if (runVisibile !== ev.runId) return;

  aggiornaPannello(stato);

  // Righe MOSTRATE nella griglia: sono quelle che il contatore deve dire.
  let righeMostrate = null;
  if (ev.tipo === 'done' || ev.tipo === 'paused') {
    // L'ultimo result set prodotto è ciò che l'utente si aspetta di vedere.
    // Un result set VUOTO si disegna (tabella vuota); "niente da disegnare"
    // svuota la griglia invece di lasciarci il risultato dell'esecuzione
    // precedente, che sembrerebbe la risposta a questo script.
    renderResults(haRisultato(ev.ultimoRisultato) ? ev.ultimoRisultato.docs : []);
    righeMostrate = righeDaMostrare(ev.ultimoRisultato);

    // Risultati per istruzione: arriva l'ELENCO, non le righe. Le righe di una
    // scheda si chiedono quando l'utente la apre (vedi apriScheda).
    if (ev.risultati) {
      r.risultati = ev.risultati;
      r.schedaAperta = schedaAttiva(ev.risultati.schede, ev.ultimoRisultato);
      disegnaSchede();
    }
  }

  if ((ev.tipo === 'done' || stato.status === 'aborted') && r.attesa) {
    r.attesa.resolve(stato);
  }

  if (ev.tipo === 'done') {
    // Uno script è il posto in cui il DDL capita più spesso (creare collezioni,
    // eliminarne): a fine esecuzione l'albero va riallineato, altrimenti mostra
    // una struttura che non esiste più.
    refreshDbTree();
    const falliti = stato.falliti || 0;
    // Il contatore è etichettato «record»: passargli le ISTRUZIONI eseguite
    // faceva leggere «2 record» sopra una griglia che ne mostrava una — e il
    // numero di istruzioni è già scritto due righe sotto, nel pannello. Qui va
    // ciò che la griglia contiene davvero; se nessuna istruzione ha prodotto un
    // result set la griglia è vuota, e il contatore dice zero.
    updateQueryMetrics(
      falliti ? 'error' : 'success',
      stato.endedAt && stato.startedAt ? stato.endedAt - stato.startedAt : null,
      righeMostrate != null ? righeMostrate : 0,
      falliti ? `Script terminato con ${falliti} istruzioni fallite su ${stato.eseguiti}.` : null
    );
    toast(falliti
      ? `Script terminato: ${falliti} istruzioni fallite su ${stato.eseguiti}`
      : `Script completato: ${stato.eseguiti} istruzioni`);
  }
}

/* --- Pannello -------------------------------------------------------------- */

function mostraPannello() {
  const p = $('#script-run-panel');
  if (p) p.classList.remove('hidden');
  const log = $('#script-run-log');
  if (log) log.innerHTML = '';
  // Le linguette dell'esecuzione PRECEDENTE non devono sopravvivere all'avvio
  // di una nuova: sarebbero risultati di un altro script offerti come se
  // fossero di questo, e il server intanto ne ha già chiuso il deposito.
  const barra = $('#script-results-tabs');
  if (barra) { barra.classList.add('hidden'); barra.innerHTML = ''; }
}

function nascondiPannello() {
  const p = $('#script-run-panel');
  if (p) p.classList.add('hidden');
  // Le linguette appartengono al resoconto: lasciarle senza il pannello
  // significherebbe offrire i risultati di uno script che non si vede più.
  const barra = $('#script-results-tabs');
  if (barra) { barra.classList.add('hidden'); barra.innerHTML = ''; }
}

/**
 * Chiude il pannello al cambio di contesto (altra collection, altra
 * connessione): chiamata da `resetQueryView` in `query-tab.js`.
 *
 * Azzera anche `runVisibile`, che è una variabile di modulo unica per tutta
 * l'applicazione: senza, Pausa/Riprendi/Interrompi resterebbero puntati sul run
 * di un'altra connessione e agirebbero da un pannello che non è più visibile.
 *
 * NON abortisce lo script: quello vive lato server e resta raggiungibile dal
 * registro delle query in sospeso, che è il posto giusto per ritrovarlo.
 */
export function nascondiPannelloScript() {
  runVisibile = null;
  nascondiPannello();
}

const ETICHETTA_STATO = {
  running: { cls: 'status-running', testo: '⏳ In esecuzione' },
  paused: { cls: 'status-paused', testo: '⏸ In pausa' },
  done: { cls: 'status-completed', testo: '✓ Completato' },
  aborted: { cls: 'status-abandoned', testo: '🛑 Interrotto' },
  idle: { cls: '', testo: '● In attesa' },
};

function aggiornaPannello(stato) {
  if (!stato) return;
  const statusEl = $('#script-run-status');
  const countsEl = $('#script-run-counts');
  const errEl = $('#script-run-errors');
  const fill = $('#script-run-progress-fill');

  const total = stato.total || 0;
  const eseguiti = stato.eseguiti || 0;
  const falliti = stato.falliti || 0;

  if (statusEl) {
    const et = ETICHETTA_STATO[stato.status] || ETICHETTA_STATO.idle;
    statusEl.className = `badge-status ${et.cls}`;
    statusEl.textContent = et.testo;
  }
  if (countsEl) countsEl.textContent = `${Math.min(eseguiti, total)} / ${total} istruzioni`;
  if (errEl) {
    if (falliti) {
      errEl.textContent = `${falliti} ${falliti === 1 ? 'errore' : 'errori'}`;
      errEl.classList.remove('hidden');
    } else {
      errEl.classList.add('hidden');
    }
  }
  if (fill) fill.style.width = total ? `${Math.round((eseguiti / total) * 100)}%` : '0%';

  aggiornaBottoni(stato.status);
  disegnaLog();
}

function aggiornaBottoni(status) {
  const inCorso = status === 'running';
  const inPausa = status === 'paused';
  const finito = status === 'done' || status === 'aborted';

  const mostra = (sel, visibile) => {
    const el = $(sel);
    if (el) el.classList.toggle('hidden', !visibile);
  };
  mostra('#script-pause-btn', inCorso);
  mostra('#script-force-pause-btn', inCorso);
  mostra('#script-resume-btn', inPausa);
  mostra('#script-abort-btn', inCorso || inPausa);
  mostra('#script-close-btn', finito);
}

// Nel log si mostrano gli ERRORI (sono il motivo per cui lo si guarda) e le
// ultime istruzioni riuscite, così si vede che lo script sta avanzando.
function disegnaLog() {
  const logEl = $('#script-run-log');
  const r = runs.get(runVisibile);
  if (!logEl || !r) return;

  const errori = r.log.filter((v) => !v.ok && !v.interrupted);
  const ultimi = r.log.slice(-6);
  const daMostrare = [...errori.slice(-20), ...ultimi.filter((v) => v.ok || v.interrupted)];

  if (!daMostrare.length) {
    logEl.innerHTML = '<div class="script-log-empty">Nessuna istruzione completata.</div>';
    return;
  }

  logEl.innerHTML = daMostrare.map((v) => {
    const icona = v.interrupted ? '⏸' : (v.ok ? '✓' : '✖');
    const cls = v.interrupted ? 'interrupted' : (v.ok ? 'ok' : 'ko');
    const misure = v.ok
      ? `${v.rows != null ? `${v.rows} righe` : ''}${v.affected != null ? ` · ${v.affected} modificate` : ''} · ${v.ms} ms`
      : esc(v.error || '');
    return `
      <div class="script-log-row ${cls}">
        <span class="script-log-icon">${icona}</span>
        <span class="script-log-line" title="Riga nel sorgente">riga ${v.line != null ? v.line : '?'}</span>
        <code class="script-log-sql" title="${esc(v.sql || '')}">${esc(cutStr(v.sql || '', 90))}</code>
        <span class="script-log-meta">${misure}</span>
      </div>`;
  }).join('');
  logEl.scrollTop = logEl.scrollHeight;
}

/* --- Risultati per istruzione ---------------------------------------------
 * Una linguetta per ogni result set prodotto dallo script. Il contenuto NON
 * arriva con gli eventi: sta su file sul server (db/ScriptResults.js) e si
 * chiede una scheda alla volta. È la ragione per cui uno script con cinquanta
 * SELECT non spedisce cinquanta result set a chi ne guarderà uno.
 * ------------------------------------------------------------------------- */

function disegnaSchede() {
  const barra = $('#script-results-tabs');
  if (!barra) return;
  const r = runs.get(runVisibile);
  const schede = (r && r.risultati && r.risultati.schede) || [];

  // Una sola scheda non è una scelta: la barra sarebbe una riga di cromatura
  // sopra la griglia che mostra già quel risultato.
  if (schede.length < 2) {
    barra.classList.add('hidden');
    barra.innerHTML = '';
    return;
  }

  barra.innerHTML = schede.map((sc) => {
    const et = etichettaScheda(sc);
    const attiva = r.schedaAperta === sc.pos ? ' attiva' : '';
    return `
      <button type="button" role="tab" class="script-result-tab${attiva}" data-pos="${sc.pos}"
              aria-selected="${r.schedaAperta === sc.pos ? 'true' : 'false'}"
              title="${esc(sc.sql || '')}">
        <span class="tab-riga">${esc(et.riga)}</span>
        <span class="tab-testo">${esc(et.testo)}</span>
        <span class="tab-righe">${esc(et.righe)}</span>
      </button>`;
  }).join('') + (() => {
    const nota = notaScartate(r.risultati);
    return nota ? `<span class="script-results-nota">${esc(nota)}</span>` : '';
  })();

  barra.classList.remove('hidden');
  barra.querySelectorAll('.script-result-tab').forEach((b) => {
    b.addEventListener('click', () => apriScheda(Number(b.dataset.pos)));
  });
}

/** Chiede al server le righe di una scheda e le disegna. */
function apriScheda(pos) {
  const runId = runVisibile;
  const r = runs.get(runId);
  if (!r) return;
  emit('script:result', { runId, pos, tabId: r.tabId })
    .then((res) => {
      // Nel frattempo l'utente può aver cambiato run o scheda: la risposta di
      // una richiesta sorpassata non deve sovrascrivere ciò che sta guardando.
      if (runVisibile !== runId) return;
      r.schedaAperta = pos;
      disegnaSchede();
      renderResults(res.docs || []);
      updateQueryMetrics('success', null, (res.docs || []).length);
    })
    .catch((err) => {
      toast(`Impossibile aprire il risultato: ${err.message}`, true);
    });
}

function cutStr(s, n) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/**
 * Riporta il pannello su un run già noto (usato dal registro delle query in
 * sospeso quando l'utente preme "Riprendi" su uno script).
 */
export function focusScriptRun(runId) {
  if (!runs.has(runId)) return false;
  runVisibile = runId;
  mostraPannello();
  const r = runs.get(runId);
  if (r.stato) aggiornaPannello(r.stato);
  disegnaSchede();
  return true;
}

/** Il run è conosciuto da questa pagina? (dopo un F5 non lo è più) */
export function knowsScriptRun(runId) {
  return runs.has(runId);
}

export function initScriptRun() {
  if (socket) socket.on('script:progress', onProgress);

  const bind = (sel, fn) => {
    const el = $(sel);
    if (el) el.addEventListener('click', fn);
  };

  bind('#script-pause-btn', () => pauseScript(runVisibile, false));
  bind('#script-force-pause-btn', () => pauseScript(runVisibile, true));
  bind('#script-resume-btn', () => resumeScript(runVisibile));
  bind('#script-abort-btn', () => {
    if (confirm('Interrompere definitivamente lo script? Le istruzioni già eseguite restano applicate.')) {
      abortScript(runVisibile);
    }
  });
  bind('#script-close-btn', () => {
    // Chiudere il resoconto di uno script concluso lo toglie anche dal registro
    // delle query in sospeso: non è più "in sospeso", l'utente l'ha visto.
    if (runVisibile) {
      removePending(runVisibile);
      runs.delete(runVisibile);
      runVisibile = null;
    }
    nascondiPannello();
  });
}
