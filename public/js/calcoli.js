/**
 * CodeDB — Calcoli pesanti fuori dal thread dell'interfaccia
 *
 * Facciata unica per statistiche, campi e precalcolo dei grafici. Decide da sé
 * **dove** eseguire:
 *
 *  - sotto le 50.000 celle → subito, su questo thread. Spostare un lavoro da
 *    due millisecondi costerebbe più del lavoro stesso, e il risultato
 *    arriverebbe un fotogramma dopo: la barra di stato che segue il
 *    trascinamento diventerebbe *meno* reattiva, non più;
 *  - sopra → su un Web Worker, così la finestra continua a rispondere mentre
 *    si sommano centomila celle.
 *
 * Tre proprietà tenute per costruzione:
 *
 *  1. **Stesso codice, stesso risultato.** Le due vie chiamano `eseguiCompito`
 *     di `calcoli-protocollo.js`. Non esiste una versione "veloce" che calcola
 *     in modo diverso.
 *  2. **Il Worker non è un requisito.** Se non si può creare (ambiente senza
 *     `Worker`, module worker non supportato, file bloccato) o se muore, si
 *     ricade sul calcolo locale e l'applicazione continua a funzionare
 *     esattamente come prima. Un'ottimizzazione non può diventare un punto di
 *     rottura.
 *  3. **Le risposte in ritardo si scartano.** Ogni chiamata è asincrona:
 *     durante un trascinamento ne partono molte, e senza un ordine esplicito
 *     l'ultima a rispondere non è l'ultima chiesta. `sequenziatore()` dà un
 *     token con cui il chiamante verifica di essere ancora quello attuale.
 */

import { eseguiCompito, conviene, celleGrafico, SOGLIA_CELLE } from './calcoli-protocollo.js';

export { SOGLIA_CELLE, conviene, celleGrafico };

/* ==========================================================================
 * Il Worker
 * ========================================================================== */

let worker = null;
let workerRotto = false;   // creato ma inutilizzabile: non si riprova
let prossimoId = 1;
const inAttesa = new Map(); // id → { risolvi, rifiuta }

// Diagnostica: quanti compiti sono finiti di là e quanti sono rimasti qui.
// Serve al collaudo (e a chi si chiede se il Worker sta davvero lavorando).
export const contatori = { locali: 0, delegati: 0, ricaduti: 0, riusati: 0 };

function creaWorker() {
  if (worker || workerRotto) return worker;
  try {
    if (typeof Worker === 'undefined') { workerRotto = true; return null; }
    worker = new Worker(new URL('./calcoli-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, ok, risultato, errore } = e.data || {};
      const attesa = inAttesa.get(id);
      if (!attesa) return;
      inAttesa.delete(id);
      if (ok) { attesa.risolvi(risultato); return; }
      // Errore DEL CALCOLO, non del Worker: rifarlo qui fallirebbe allo stesso
      // modo, e nel frattempo bloccherebbe la finestra per il tempo di un
      // lavoro che si sa già come finisce. Si propaga e basta.
      const err = new Error(errore || 'errore nel calcolo');
      err.dalCalcolo = true;
      attesa.rifiuta(err);
    };
    worker.onerror = (e) => {
      // Il Worker è morto (o non è mai partito): chi aspetta viene servito
      // sul posto, e da qui in avanti si calcola tutto qui.
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      workerRotto = true;
      worker = null;
      const pendenti = [...inAttesa.values()];
      inAttesa.clear();
      for (const p of pendenti) p.rifiuta(new Error('worker non disponibile'));
    };
  } catch (_err) {
    workerRotto = true;
    worker = null;
  }
  return worker;
}

/** Il Worker è già attivo? (solo per diagnosi e collaudo) */
export function workerAttivo() {
  return !!worker && !workerRotto;
}

/**
 * Esegue un compito nel posto giusto.
 * @param {object} compito  messaggio per `eseguiCompito`
 * @param {number} celle    quantità di lavoro, per decidere dove eseguirlo
 */
function esegui(compito, celle) {
  if (!conviene(celle)) {
    contatori.locali++;
    return Promise.resolve(eseguiCompito(compito));
  }

  const w = creaWorker();
  if (!w) {
    contatori.locali++;
    return Promise.resolve(eseguiCompito(compito));
  }

  const id = prossimoId++;
  contatori.delegati++;
  return new Promise((risolvi, rifiuta) => {
    inAttesa.set(id, { risolvi, rifiuta });
    try {
      w.postMessage({ id, ...compito });
    } catch (_err) {
      // Dati non clonabili (non dovrebbe accadere: sono EJSON e configurazioni
      // pure) o Worker già morto: si calcola qui invece di perdere il risultato.
      inAttesa.delete(id);
      contatori.ricaduti++;
      risolvi(eseguiCompito(compito));
    }
  }).catch((err) => {
    // Un errore del calcolo non si ripete: sarebbe lavoro sprecato e la stessa
    // eccezione un istante dopo. Si ricade solo quando è il TRASPORTO ad aver
    // ceduto (Worker morto o mai partito), perché lì il calcolo non è stato
    // nemmeno tentato.
    if (err && err.dalCalcolo) throw err;
    contatori.ricaduti++;
    return eseguiCompito(compito);
  });
}

/* ==========================================================================
 * Compiti
 * ========================================================================== */

/** Statistiche di un elenco di valori di cella (EJSON). */
export function statisticheAsync(valori) {
  const v = valori || [];
  return esegui({ tipo: 'statistiche', valori: v }, v.length);
}

/** Statistiche colonna per colonna: `colonne` = [{ nome, valori }]. */
export function statistichePerColonnaAsync(colonne) {
  const cols = colonne || [];
  const celle = cols.reduce((n, c) => n + ((c && c.valori) ? c.valori.length : 0), 0);
  return esegui({ tipo: 'statistichePerColonna', colonne: cols }, celle);
}

/** Campi (nome e tipo) presenti nelle righe: è una scansione EJSON completa. */
export function campiAsync(righe) {
  const r = righe || [];
  // `campiDisponibili` guarda un campione di righe ma tutte le loro chiavi:
  // il peso si stima con il numero di righe per le chiavi della prima.
  const chiavi = r.length && r[0] && typeof r[0] === 'object' ? Object.keys(r[0]).length : 1;
  return esegui({ tipo: 'campiDisponibili', righe: r }, r.length * Math.max(chiavi, 1));
}

/*
 * Il grafico si ridisegna anche quando i DATI non cambiano: a ogni
 * ridimensionamento del riquadro, perché margini e barra di zoom dipendono
 * dall'altezza. Rifare il precalcolo lì significherebbe ricopiare trentamila
 * righe verso l'altro thread per ottenere gli stessi identici numeri.
 *
 * Si tiene quindi l'ultimo risultato, valido finché sono le stesse righe (per
 * riferimento: un nuovo result set è un nuovo array) e la stessa
 * configurazione (per contenuto: il pannello la modifica sul posto).
 */
let memoPre = null;

/** Butta il precalcolo tenuto da parte (cambio di vista, di tab, di dati). */
export function scordaPrecalcolo() { memoPre = null; }

/** Precalcolo del grafico (raggruppamento, aggregazione, ordinamento). */
export function precalcolaGraficoAsync(righe, cfg) {
  const r = righe || [];
  let firma = null;
  try {
    firma = JSON.stringify(cfg);
  } catch (_err) {
    firma = null; // configurazione non serializzabile: si ricalcola sempre
  }
  if (memoPre && firma !== null && memoPre.righe === r && memoPre.firma === firma) {
    contatori.riusati++;
    return Promise.resolve(memoPre.risultato);
  }
  return esegui({ tipo: 'precalcolaGrafico', righe: r, cfg }, celleGrafico(r, cfg))
    .then((risultato) => {
      if (firma !== null) memoPre = { righe: r, firma, risultato };
      return risultato;
    });
}

/* ==========================================================================
 * Ordine delle risposte
 * ========================================================================== */

/**
 * Sequenziatore per chi ricalcola in continuazione (la barra di stato durante
 * il trascinamento). Si chiede un token prima di partire e si controlla che sia
 * ancora l'ultimo quando il risultato arriva: senza, una selezione grande
 * risponderebbe dopo una piccola chiesta più tardi, e il riassunto mostrerebbe
 * i numeri di una selezione che non esiste più.
 */
export function sequenziatore() {
  let n = 0;
  return {
    nuovo() { return ++n; },
    attuale(token) { return token === n; },
  };
}
