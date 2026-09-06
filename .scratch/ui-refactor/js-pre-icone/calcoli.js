/**
 * CodeDB — Calcoli pesanti fuori dal thread dell'interfaccia
 *
 * Facciata unica per statistiche, campi e precalcolo dei grafici. Decide da sé
 * **dove** eseguire, e la decisione dipende da DUE costi, non da uno solo:
 * quanto costa il calcolo e quanto costa portare i dati dall'altra parte.
 *
 * `postMessage` non condivide la memoria: la copia strutturata dei dati la paga
 * il thread CHIAMANTE, cioè proprio quello che si voleva liberare. Misurato su
 * un result set di 50.000 righe per 12 colonne, e ripetuto su 200.000:
 *
 *              calcolo    copia delle righe
 *   precalcolo  16 ms          126 ms        (50.000 righe)
 *   precalcolo  50 ms          628 ms       (200.000 righe)
 *
 * Il trasporto costa da otto a dodici volte il lavoro che evita, e cresce con
 * lui: non esiste una soglia oltre la quale il Worker cominci a convenire. Il
 * grafico lo pagava DUE volte per disegno (scansione dei campi e precalcolo), a
 * ogni modifica del pannello — è questo che faceva scattare l'interfaccia
 * mentre si costruiva un grafico.
 *
 * La regola è quindi sulla FORMA di ciò che attraversa il confine:
 *
 *  - un elenco piatto di VALORI (le statistiche della selezione) si copia in
 *    meno di un millisecondo per 50.000 celle: lì il Worker conviene, e sopra
 *    le 50.000 celle ci va;
 *  - un elenco di RIGHE (campi e precalcolo del grafico) no: si calcola qui.
 *    Sedici millisecondi su questo thread sono un fotogramma; centoventisei di
 *    copia sono otto, e sarebbero comunque su questo thread.
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

import { eseguiCompito, conviene, SOGLIA_CELLE } from './calcoli-protocollo.js';

export { SOGLIA_CELLE, conviene };

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

/**
 * Campi (nome e tipo) presenti nelle righe.
 *
 * `campiDisponibili` si ferma alle prime 300 righe: due millisecondi e mezzo,
 * quante che siano le righe. Il peso veniva invece stimato sull'INTERO result
 * set (righe × chiavi), quindi da 4.200 righe in su il compito partiva per il
 * Worker — e per due millisecondi e mezzo di lavoro si copiavano tutte le
 * righe, centoventisei millisecondi su questo thread. Si calcola qui.
 */
export function campiAsync(righe) {
  contatori.locali++;
  return Promise.resolve(eseguiCompito({ tipo: 'campiDisponibili', righe: righe || [] }));
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
  // Qui, non sul Worker: vedi la tabella in testa al file — copiare le righe
  // costa più del precalcolo di un ordine di grandezza, e la copia la paga
  // comunque questo thread. Il memo sotto è ciò che toglie il lavoro vero:
  // ridimensionare il riquadro ridisegna il grafico ma non cambia i dati.
  contatori.locali++;
  const risultato = eseguiCompito({ tipo: 'precalcolaGrafico', righe: r, cfg });
  if (firma !== null) memoPre = { righe: r, firma, risultato };
  return Promise.resolve(risultato);
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
