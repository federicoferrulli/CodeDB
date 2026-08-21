/**
 * CodeDB — Il modulo unico della griglia dei risultati.
 *
 * La griglia era implementata **tre volte**: nella vista Dati, nella tab ⚡ e
 * nella Split-View, con capacità diverse e nessuna giuntura comune. Due delle
 * tre calcolavano la finestra virtuale con la stessa aritmetica, nomi di
 * variabile compresi — e la terza, la Split-View, non virtualizzava affatto:
 * chi affianca due tabelle perde metà dell'applicazione.
 *
 * Qui non c'è una griglia "generica" che prova a fare tutto. C'è ciò che le tre
 * viste hanno **davvero** in comune, e che nessuna di loro dovrebbe rifare:
 *
 *  1. **quali righe stanno nella finestra visibile** — aritmetica pura, senza
 *     DOM, provabile senza browser (`finestraVirtuale`);
 *  2. **come si scrive il corpo della tabella** — le righe della finestra fra
 *     due spaziatori che simulano l'altezza di ciò che non è disegnato
 *     (`disegnaCorpo`);
 *  3. **che cosa quella griglia sa fare** — le capacità, dichiarate
 *     all'interfaccia e non dedotte da rami interni (`capacita`).
 *
 * Ciò che **non** sta qui è il disegno di una singola riga: quello dipende da
 * che cosa la vista mostra (documenti con `_id` e checkbox, righe di un result
 * set senza identità, celle modificabili o no) e resta della vista, che lo
 * passa come funzione. Assorbirlo qui significherebbe un'interfaccia piena di
 * rami — cioè il modulo superficiale che questo lotto esiste per non fare.
 *
 * Modulo senza import e senza DOM al caricamento: si carica in un test.
 */

/* ==========================================================================
 * Le capacità
 * ========================================================================== */

/**
 * Che cosa una griglia sa fare. Sono **opzioni dichiarate**, non rami interni:
 * chi costruisce la griglia dice che cosa le serve, e il modulo non deve
 * indovinarlo da `state`, dal modo della query o dal tipo di connessione.
 *
 * Il valore di questo elenco non è tecnico ma di inventario: prima le tre
 * copie avevano capacità diverse e nessun posto in cui leggerlo, quindi
 * «la Split-View non virtualizza» era una cosa che si scopriva usandola.
 */
export const CAPACITA = Object.freeze([
  'virtualizzazione',      // finestra visibile invece di tutte le righe in DOM
  'selezioneRighe',        // checkbox di riga, per l'eliminazione multipla
  'selezioneCelle',        // rettangolo di selezione stile foglio di calcolo
  'scorrimentoAiBordi',    // trascinando fino al bordo, il contenitore scorre
  'modificaInline',        // doppio clic su una cella per modificarla
  'paginazioneAChiave',    // pagine per chiave invece che per salto (OFFSET)
  'chiaviEsterne',         // indicatore 🔗 e pannello della riga riferita
  'geometrie',             // celle geometriche disegnate su mappa
]);

/**
 * Normalizza le capacità richieste: tutte spente, tranne quelle chieste.
 * Un nome sconosciuto è un errore e non un'opzione ignorata — è così che una
 * capacità scritta con un refuso resta spenta per sempre senza che nulla lo
 * dica.
 */
export function capacita(richieste = {}) {
  const fuori = Object.keys(richieste).filter((n) => !CAPACITA.includes(n));
  if (fuori.length) {
    throw new Error(`Capacità della griglia sconosciute: ${fuori.join(', ')}. `
      + `Quelle previste sono: ${CAPACITA.join(', ')}.`);
  }
  const out = {};
  for (const nome of CAPACITA) out[nome] = !!richieste[nome];
  return Object.freeze(out);
}

/* ==========================================================================
 * La finestra virtuale
 * ========================================================================== */

/** Righe in DOM oltre le quali conviene virtualizzare. */
export const SOGLIA_VIRTUALE = 200;

/**
 * Quali righe disegnare, e quanto spazio lasciare sopra e sotto.
 *
 * Funzione pura: è l'aritmetica che stava scritta due volte, in `grid.js` e in
 * `query-tab.js`, con le stesse operazioni e nomi di variabile diversi.
 * Correggerne una lasciava l'altra intatta e nulla lo segnalava.
 *
 * `overscan` sono le righe disegnate **oltre** la finestra visibile, sopra e
 * sotto: senza, ogni pixel di scorrimento scoprirebbe una riga vuota prima che
 * il ridisegno arrivi.
 *
 * @param {object} p
 * @param {number} p.scrollTop        quanto è già scorso il contenitore
 * @param {number} p.altezzaViewport  altezza visibile del contenitore
 * @param {number} p.altezzaRiga      altezza di una riga in px
 * @param {number} p.righeTotali      quante righe ci sono in tutto
 * @param {number} [p.overscan=8]
 * @returns {{ inizio:number, fine:number, spazioSopra:number, spazioSotto:number }}
 */
export function finestraVirtuale({
  scrollTop = 0, altezzaViewport = 400, altezzaRiga, righeTotali, overscan = 8,
}) {
  const h = Math.max(1, Math.round(altezzaRiga) || 1);
  const n = Math.max(0, righeTotali | 0);
  const scorso = Math.max(0, scrollTop || 0);
  const inizio = Math.min(n, Math.max(0, Math.floor(scorso / h) - overscan));
  const visibili = Math.ceil(Math.max(0, altezzaViewport) / h);
  const fine = Math.min(n, inizio + visibili + overscan * 2);
  return {
    inizio,
    fine,
    spazioSopra: inizio * h,
    spazioSotto: (n - fine) * h,
  };
}

/**
 * Serve virtualizzare? La soglia esiste perché sotto di essa il render classico
 * lascia le larghezze automatiche, che altrimenti «ballerebbero» sui dataset
 * piccoli. Con la capacità spenta la risposta è sempre no.
 */
export function vaVirtualizzata(righeTotali, cap, soglia = SOGLIA_VIRTUALE) {
  return !!(cap && cap.virtualizzazione) && righeTotali > soglia;
}

/* ==========================================================================
 * Il corpo della tabella
 * ========================================================================== */

/** La riga-spaziatore che simula l'altezza di ciò che non è disegnato. */
export function spaziatore(altezza, colonne, doc = document) {
  const tr = doc.createElement('tr');
  tr.className = 'v-spacer';
  tr.setAttribute('aria-hidden', 'true');
  const td = doc.createElement('td');
  td.colSpan = colonne;
  td.style.height = `${altezza}px`;
  td.style.padding = '0';
  td.style.border = 'none';
  td.style.background = 'none';
  tr.appendChild(td);
  return tr;
}

/**
 * Scrive nel `tbody` le righe della finestra, fra i due spaziatori.
 *
 * Il disegno della singola riga arriva da fuori (`disegnaRiga(riga, indice)`):
 * è ciò che cambia fra le tre viste, e assorbirlo qui vorrebbe dire un ramo per
 * ciascuna. Ciò che invece non deve cambiare — l'ordine, gli spaziatori, il
 * fatto di scrivere in un frammento e di attaccarlo una volta sola — sta qui.
 *
 * @param {object} p
 * @param {HTMLElement} p.tbody
 * @param {any[]} p.righe
 * @param {(riga:any, indice:number)=>HTMLElement} p.disegnaRiga
 * @param {{inizio:number,fine:number,spazioSopra:number,spazioSotto:number}|null} p.finestra
 *        null = disegna tutto (griglia non virtualizzata)
 * @param {number} p.colonneTotali  colspan degli spaziatori
 * @returns {{ disegnate:number }}
 */
export function disegnaCorpo({ tbody, righe, disegnaRiga, finestra, colonneTotali }) {
  const doc = tbody.ownerDocument || document;
  const frammento = doc.createDocumentFragment();
  const inizio = finestra ? finestra.inizio : 0;
  const fine = finestra ? finestra.fine : righe.length;

  if (finestra && finestra.spazioSopra > 0) {
    frammento.appendChild(spaziatore(finestra.spazioSopra, colonneTotali, doc));
  }
  for (let i = inizio; i < fine; i++) {
    frammento.appendChild(disegnaRiga(righe[i], i));
  }
  if (finestra && finestra.spazioSotto > 0) {
    frammento.appendChild(spaziatore(finestra.spazioSotto, colonneTotali, doc));
  }

  tbody.innerHTML = '';
  tbody.appendChild(frammento);
  return { disegnate: fine - inizio };
}

/**
 * Dove deve arrivare lo scorrimento perché la riga `indice` sia visibile per
 * intero. `null` se è già visibile: chi chiama non deve toccare lo scorrimento,
 * altrimenti la navigazione con le frecce farebbe sobbalzare la griglia a ogni
 * tasto.
 */
export function scorrimentoPerRiga({ indice, altezzaRiga, scrollTop, altezzaViewport }) {
  const cima = indice * altezzaRiga;
  const fondo = cima + altezzaRiga;
  if (cima < scrollTop) return cima;
  if (fondo > scrollTop + altezzaViewport) return fondo - altezzaViewport;
  return null;
}
