/*
 * Le decisioni della barra del grafo, come DATI.
 *
 * Erano tre regole scritte dentro i gestori di evento, e per questo nessuna
 * era verificabile né riusabile:
 *
 *  - «questa tabella è vuota» cadeva su `fields.length === 0`, cioè sulle
 *    tabelle senza COLONNE. Su MySQL e PostgreSQL non esistono, quindi il
 *    comando «Solo popolate» non nascondeva mai nulla: funzionava soltanto su
 *    MongoDB, dove una collection vuota non produce campi campionati. Ora lo
 *    schema porta un conteggio stimato (`rowsApprox`) e la regola sta qui.
 *  - «il filtro dei vicini è utilizzabile» dipendeva da una variabile interna
 *    al modulo del grafo: senza una selezione il filtro non faceva nulla, e
 *    non lo diceva. Un comando disattivato dichiara PRIMA del clic che quel
 *    gesto ora non ha senso, e il motivo sta nel `title`.
 *  - «che cosa ha trovato la ricerca» non era espresso affatto: una ricerca
 *    senza corrispondenze si comportava esattamente come una ricerca non
 *    ancora scritta.
 *
 * Nessuna di queste funzioni tocca il DOM: `test/unit-grafo-comandi.js` le
 * prova in Node.
 */

/**
 * Una tabella è vuota quando la stima del motore lo dichiara.
 *
 * `rowsApprox` è una STIMA (TABLE_ROWS su MySQL, reltuples su PostgreSQL,
 * estimatedDocumentCount su MongoDB) e vale `null` quando il motore non la
 * conosce — su PostgreSQL, per esempio, finché nessun ANALYZE è passato.
 * Quel «non so» non autorizza a nascondere: nascondere una tabella piena è un
 * danno molto peggiore del mostrarne una vuota, quindi la regola è
 * fail-closed sul nascondere.
 *
 * Resta il ripiego storico per MongoDB, dove una collection senza documenti
 * non produce alcun campo campionato. Su SQL quel ripiego tace da solo,
 * perché le colonne esistono anche a tabella vuota.
 */
export function tabellaVuota(collection) {
  if (!collection) return false;
  const stima = collection.rowsApprox;
  if (typeof stima === 'number' && Number.isFinite(stima)) return stima <= 0;
  return !(collection.fields && collection.fields.length);
}

/**
 * Quante tabelle il filtro nasconderebbe, e quante non sa giudicare.
 * Serve a dire nel messaggio che cosa è successo davvero: «nessuna tabella
 * vuota» e «il motore non sa quante righe ci sono» sono due esiti diversi.
 */
export function contaVuote(collections) {
  const elenco = Array.isArray(collections) ? collections : [];
  let vuote = 0;
  let ignote = 0;
  for (const c of elenco) {
    const stima = c && c.rowsApprox;
    if (!(typeof stima === 'number' && Number.isFinite(stima))) ignote += 1;
    if (tabellaVuota(c)) vuote += 1;
  }
  return { vuote, ignote, totali: elenco.length };
}

/**
 * Stato dichiarato dei comandi che dipendono dal contesto: se sono abilitati,
 * se risultano premuti e PERCHÉ. Il chiamante dipinge, non decide.
 */
export function statoComandi({ selezione = null, autoRotazione = false } = {}) {
  return {
    vicini: selezione
      ? {
        abilitato: true,
        motivo: `Mostra solo i vicini di «${selezione}» entro il numero di salti scelto`,
      }
      : {
        abilitato: false,
        motivo: 'Scegli prima una tabella nel grafo: i salti si contano a partire da quella',
      },
    /*
     * La rotazione automatica non si disabilita MAI. Era spenta d'ufficio sui
     * grafi «grandi», il che toglieva una funzione proprio dove serve di più —
     * e un grafo veniva giudicato grande anche solo perché una tabella ha più
     * di dodici colonne. Disattivare non era il rimedio al fatto che non
     * funzionasse: non funzionava perché i controlli predefiniti di
     * 3d-force-graph sono i TrackballControls, che non hanno `autoRotate`
     * affatto (vedi `graph3d.js`).
     */
    autoRotazione: {
      abilitato: true,
      premuto: !!autoRotazione,
      motivo: 'Rotazione automatica della scena attorno al centro del grafo',
    },
  };
}

/**
 * Che cosa trova la ricerca: prima un nome di tabella, poi un nome di campo.
 * L'ordine è quello di prima; ciò che manca è l'esito `assente`, che è
 * l'unico modo per distinguere «non c'è» da «non hai ancora scritto».
 */
export function cercaNodo(nodi, termine) {
  const q = String(termine == null ? '' : termine).trim().toLowerCase();
  if (!q) return { esito: 'vuoto', nodo: null, testo: '' };
  const elenco = Array.isArray(nodi) ? nodi : [];

  const perNome = elenco.find((n) => String((n && n.name) || '').toLowerCase().includes(q));
  if (perNome) return { esito: 'tabella', nodo: perNome, testo: perNome.name };

  for (const n of elenco) {
    const campo = ((n && n.fields) || []).find((f) => String((f && f.name) || '').toLowerCase().includes(q));
    if (campo) return { esito: 'campo', nodo: n, testo: `${n.name}.${campo.name}` };
  }
  return { esito: 'assente', nodo: null, testo: '' };
}

/** Il testo che accompagna il campo di ricerca, dedotto dall'esito. */
export function messaggioRicerca(risultato) {
  if (!risultato || risultato.esito === 'vuoto') return '';
  if (risultato.esito === 'tabella') return `Tabella ${risultato.testo}`;
  if (risultato.esito === 'campo') return `Campo ${risultato.testo}`;
  return 'Nessuna corrispondenza';
}
