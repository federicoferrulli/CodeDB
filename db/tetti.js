'use strict';

/* ---------------------------------------------------------------------------
 * I tetti su righe, byte e tempo, imposti dalla giuntura.
 *
 * Prima erano funzioni di supporto che ogni adattatore poteva ricordarsi o
 * dimenticarsi di chiamare, e infatti la loro applicazione era a macchia: il
 * budget di byte valeva sulla `collectionFind` di tutti e tre i motori ma
 * **non** sulla `collectionAggregate` dei due motori SQL — cioè proprio dove
 * arrivano i risultati grossi, quelli della tab ⚡. Il difetto chiuso dal
 * ticket 01 (il tetto di tempo assente sul ramo in scrittura) era un caso
 * della stessa classe: un limite che esiste solo se qualcuno si ricorda di
 * invocarlo non è un limite, è una convenzione.
 *
 * Qui i tetti diventano un vincolo che **avvolge** l'esecuzione. Un adattatore
 * nuovo — o uno che non fa nulla per rispettarli — viene limitato lo stesso,
 * perché la limitazione non è più cosa sua. Ciò che resta all'adattatore è il
 * solo pezzo che varia davvero fra motori: come si ferma una query mentre è in
 * corso (`maxTimeMS`, `KILL QUERY`, `statement_timeout`) e quali esecuzioni non
 * vanno fermate affatto.
 *
 * I tre tetti non si applicano allo stesso modo:
 *
 *  - **righe** e **byte** si applicano al risultato: sono un troncamento, e
 *    l'esito lo DICHIARA con la sua bandiera di troncamento — un risultato
 *    tagliato in silenzio è peggio di uno rifiutato;
 *  - **tempo** non si può applicare al risultato, perché arriva dopo. La
 *    giuntura tiene quindi un cane da guardia che smette di aspettare, con un
 *    margine di grazia sopra al tetto vero: l'adattatore ha la sua occasione di
 *    fermare la query *sul server* e di darne il messaggio giusto, e solo se
 *    non lo fa interviene la giuntura. Attenzione a cosa questo significa: la
 *    giuntura libera il chiamante, NON ferma il lavoro sul database. È il
 *    motivo per cui il cane da guardia non sostituisce il meccanismo per
 *    motore, lo copre.
 *
 * Gli adattatori continuano a chiamare `resultCap`, `collectCapped` e
 * `truncateBySize` per conto loro, e non è una svista: là il tetto è
 * un'**ottimizzazione**, qui è la **garanzia**. Scrivere `LIMIT 500` nella
 * query, o smettere di consumare il cursore, evita di far arrivare in memoria
 * cinque milioni di righe per poi buttarne via 4.999.500 — cosa che questa
 * giuntura, che vede solo il risultato, non può fare. Ma se un adattatore
 * quella riga se la dimentica, il chiamante riceve comunque 500 righe. Le due
 * cose non sono in concorrenza: quando l'adattatore ha già rispettato il tetto,
 * il passaggio qui non taglia nulla.
 * ------------------------------------------------------------------------- */

const DbStrategy = require('./DbStrategy');

/* Le tre fonti del tetto di tempo, ciascuna con la propria variabile
 * d'ambiente. Restano distinte perché i tempi legittimi sono diversi: una
 * pagina di griglia che impiega più di trenta secondi è quasi sempre un
 * problema, un `$group` su una collection enorme no. */
const TEMPI = {
  query: () => DbStrategy.queryTimeoutMs(),
  aggregate: () => DbStrategy.aggregateTimeoutMs(),
  count: () => DbStrategy.countTimeoutMs(),
};

/* Il margine minimo, quando un quarto del tetto sarebbe troppo poco. */
const GRAZIA_MINIMA_MS = 2000;

/**
 * Il margine che la giuntura concede all'adattatore prima di intervenire.
 *
 * Senza margine il cane da guardia arriverebbe *insieme* al meccanismo per
 * motore e vincerebbe a caso, sostituendo un messaggio preciso («query
 * interrotta dopo 30 s») con uno generico. Con il margine il messaggio
 * generico compare solo quando il meccanismo per motore non c'è o non ha
 * funzionato — che è esattamente il caso in cui serve.
 */
function grazia(ms, minima = GRAZIA_MINIMA_MS) {
  return Math.max(minima, Math.round(ms * 0.25));
}

/**
 * Le letture soggette ai tetti, e come si legge il loro risultato.
 *
 * `righe`/`troncato` sono i nomi delle chiavi nell'esito, che non sono gli
 * stessi ovunque (`docs`/`truncated` per la griglia e la tab ⚡, `righe`/
 * `troncato` per il pannello delle chiavi esterne). Dichiararli qui è ciò che
 * permette alla giuntura di applicare il troncamento senza sapere nulla del
 * metodo che sta avvolgendo.
 *
 * `scaduto` è ciò che si restituisce quando è il tempo a finire: il conteggio
 * disaccoppiato degrada a «totale sconosciuto» invece di fallire, perché la
 * griglia sa mostrarlo e un errore le toglierebbe anche le righe.
 */
const LETTURE = {
  collectionFind: {
    tempo: 'query',
    righe: 'docs',
    troncato: 'truncated',
    cap: (payload) => DbStrategy.resultCap(payload),
  },
  collectionAggregate: {
    tempo: 'aggregate',
    righe: 'docs',
    troncato: 'truncated',
    cap: (payload) => DbStrategy.resultCap(payload),
  },
  collectionCount: {
    tempo: 'count',
    scaduto: () => ({ total: null, timedOut: true }),
  },
};

/** Il nome del metodo è soggetto ai tetti? */
function soggetto(metodo) {
  return Object.prototype.hasOwnProperty.call(LETTURE, metodo);
}

/**
 * Il tetto di tempo, con il cane da guardia sopra al meccanismo per motore.
 *
 * L'esecuzione dell'adattatore NON viene abbandonata: le si attacca un
 * gestore di errore, altrimenti un fallimento arrivato dopo la scadenza
 * diventerebbe un rifiuto non gestito che abbatte il processo.
 */
function conTettoDiTempo(bersaglio, metodo, args, spec, graziaMinima) {
  const esecuzione = Promise.resolve(bersaglio[metodo].apply(bersaglio, args));
  const ms = TEMPI[spec.tempo]();
  if (ms <= 0) return esecuzione;

  // L'adattatore può dichiarare che questa esecuzione non va fermata. È il caso
  // delle pipeline MongoDB che materializzano ($out/$merge): interromperle a
  // metà lascerebbe la collection di destinazione scritta per metà, cioè lo
  // stato incoerente che il tetto dovrebbe evitare.
  if (typeof bersaglio.fuoriDalTettoDiTempo === 'function'
      && bersaglio.fuoriDalTettoDiTempo(metodo, args)) {
    return esecuzione;
  }

  const scadenza = ms + grazia(ms, graziaMinima);
  return new Promise((risolvi, rifiuta) => {
    let finito = false;
    const timer = setTimeout(() => {
      if (finito) return;
      finito = true;
      if (spec.scaduto) { risolvi(spec.scaduto()); return; }
      rifiuta(new Error(
        `Operazione interrotta: ha superato il tetto di ${ms} ms concesso a questa lettura. ` +
        'Cosa fare: restringi il filtro, aggiungi un indice, oppure alza il tetto con la ' +
        'variabile d\'ambiente corrispondente. Attenzione: il server di database potrebbe ' +
        'stare ancora lavorando alla richiesta.'
      ));
    }, scadenza);
    if (typeof timer.unref === 'function') timer.unref();

    esecuzione.then(
      (esito) => { if (!finito) { finito = true; clearTimeout(timer); risolvi(esito); } },
      (err) => { if (!finito) { finito = true; clearTimeout(timer); rifiuta(err); } }
    );
  });
}

/**
 * I tetti su righe e byte, applicati all'esito qualunque cosa abbia fatto
 * l'adattatore. Se l'adattatore li ha già rispettati questo passaggio non
 * cambia nulla: taglia solo ciò che eccede.
 */
function conTettiSulRisultato(esito, payload, spec) {
  if (!esito || !spec.righe) return esito;
  const righe = esito[spec.righe];
  if (!Array.isArray(righe)) return esito;

  let tagliate = righe;
  let troncato = !!esito[spec.troncato];

  const cap = spec.cap(payload);
  if (Number.isFinite(cap) && cap > 0 && tagliate.length > cap) {
    tagliate = tagliate.slice(0, cap);
    troncato = true;
  }

  // Il tetto sulle righe non basta: poche righe con BLOB o testi lunghi pesano
  // quanto decine di migliaia di documenti piccoli, e il risultato viene poi
  // serializzato in EJSON e messo su socket.
  const perByte = DbStrategy.truncateBySize(tagliate);
  if (perByte.truncated) { tagliate = perByte.rows; troncato = true; }

  if (tagliate === righe && troncato === !!esito[spec.troncato]) return esito;
  return { ...esito, [spec.righe]: tagliate, [spec.troncato]: troncato || undefined };
}

/**
 * Avvolge una strategia perché rispetti i tetti indipendentemente da ciò che
 * fa al suo interno. Tutto il resto passa invariato: il motore di backup legge
 * `strategy.pool`/`strategy.client`, e il Query Engine scrive
 * `strategy.currentDb`.
 */
function conTetti(strategia, opzioni = {}) {
  // `graziaMinima` esiste per i test della giuntura, che altrimenti dovrebbero
  // aspettare due secondi veri a ogni scadenza. Non e' una manopola di
  // configurazione: nessun percorso di produzione la passa.
  const graziaMinima = opzioni.graziaMinima;
  return new Proxy(strategia, {
    get(bersaglio, prop, ricevente) {
      const valore = Reflect.get(bersaglio, prop, ricevente);
      if (typeof valore !== 'function' || typeof prop !== 'string' || !soggetto(prop)) {
        return valore;
      }
      const spec = LETTURE[prop];
      return async function conTettiApplicati(...args) {
        const esito = await conTettoDiTempo(bersaglio, prop, args, spec, graziaMinima);
        return conTettiSulRisultato(esito, args[2] || {}, spec);
      };
    },
    set(bersaglio, prop, valore) {
      bersaglio[prop] = valore;
      return true;
    },
  });
}

module.exports = { conTetti, LETTURE, grazia, TEMPI, GRAZIA_MINIMA_MS };
