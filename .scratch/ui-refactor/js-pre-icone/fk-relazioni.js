'use strict';

/* ---------------------------------------------------------------------------
 * Le decisioni del pannello delle chiavi esterne, separate dal pannello.
 *
 * Il pannello (`fk-vista.js`) disegna; qui si decide COSA disegnare: quale
 * campo della griglia è collegato e dove, quale colonna della tabella riferita
 * fa da etichetta accanto alla chiave, come si scrive un valore Extended JSON e
 * quando due valori sono lo stesso valore.
 *
 * Sta a parte per la ragione di `cell-stats.js`, `chart-option.js` e
 * `geo-risultati.js`: sbagliata, questa parte NON si vede. Un pannello che si
 * apre storto salta all'occhio; un elenco in cui l'etichetta cade sulla colonna
 * "stato" invece che su "ragione_sociale" mostra venti righe tutte uguali, e
 * sembra un elenco fatto bene di dati fatti male. Qui non c'è DOM né socket,
 * quindi si prova in Node (`test/unit-fk-relazioni.js`, incluso in `npm test`).
 *
 * Tre scelte che non sono ovvie:
 *
 * 1. IL DESCRITTORE È UNO SOLO PER TRE SORGENTI. MySQL e PostgreSQL dichiarano
 *    vincoli veri, MongoDB no e si va di euristica sul nome del campo. Il
 *    pannello non deve sapere da quale dei tre arriva — ma l'utente sì, e per
 *    questo `origine` sopravvive alla normalizzazione: un'ipotesi presentata
 *    come certezza fa fidare di un collegamento che non esiste.
 *
 * 2. L'ETICHETTA SI SCEGLIE DAI DATI, non dal nome della colonna. Cercare
 *    "name", "nome", "descrizione" in un elenco di nomi noti funziona finché lo
 *    schema è in inglese, o in italiano, o non abbreviato — cioè quasi mai su
 *    un database vero. Le righe che si stanno per mostrare, invece, dicono già
 *    quale colonna distingue una riga dall'altra.
 *
 * 3. IL CONFRONTO FRA VALORI È PERMISSIVO. La chiave 42 può arrivare come
 *    numero dalla griglia e come stringa dalla ricerca, a seconda del driver e
 *    del tipo di colonna. Un confronto rigido toglierebbe la spunta alla riga
 *    corrente proprio nel momento in cui serve: capire se si sta cambiando
 *    qualcosa o si sta riconfermando ciò che c'era.
 * ------------------------------------------------------------------------- */

/** Origini possibili di un collegamento, in ordine di affidabilità. */
export const VINCOLO = 'vincolo';
export const EURISTICA = 'euristica';

/** Righe minime su cui l'etichetta viene scelta guardando la distintività. */
const MIN_RIGHE_PER_DISTINTIVITA = 2;

/** Oltre questa lunghezza un valore testuale viene troncato con l'ellissi. */
export const MAX_TESTO = 120;

/* --------------------------- Descrittori di FK ---------------------------- */

/**
 * Normalizza un descrittore grezzo (`collection:relations`) o `null` se non è
 * utilizzabile. Un descrittore senza campo o senza tabella non è una relazione
 * incompleta da mostrare a metà: è rumore che accenderebbe il badge 🔗 su una
 * cella il cui pannello non potrebbe poi aprire nulla.
 */
export function descrittoreRelazione(grezzo) {
  if (!grezzo || typeof grezzo !== 'object') return null;
  const tabella = testoSemplice(grezzo.tabella);
  const coppieGrezze = Array.isArray(grezzo.coppie) && grezzo.coppie.length
    ? grezzo.coppie : [{ campo: grezzo.campo, colonna: grezzo.colonna || '_id', ordine: 1 }];
  const coppie = coppieGrezze.map((p, indice) => ({
    campo: testoSemplice(p && p.campo),
    colonna: testoSemplice(p && p.colonna),
    ordine: Number(p && p.ordine) || indice + 1,
  })).filter((p) => p.campo && p.colonna).sort((a, b) => a.ordine - b.ordine);
  if (!coppie.length || coppie.length !== coppieGrezze.length || !tabella) return null;
  const prima = coppie[0];
  return {
    nome: testoSemplice(grezzo.nome),
    campo: prima.campo,
    db: testoSemplice(grezzo.db),
    tabella,
    // Su MongoDB la colonna riferita è per costruzione `_id`; su SQL è quella
    // dichiarata dal vincolo. Il ripiego serve ai descrittori di provenienza
    // ignota, non ai nostri.
    colonna: prima.colonna,
    coppie,
    origine: grezzo.origine === VINCOLO ? VINCOLO : EURISTICA,
    molti: !!grezzo.molti,
  };
}

/**
 * Indice campo → relazione, pronto per la griglia. È una Map e non un oggetto
 * perché la griglia lo interroga in modo SINCRONO mentre costruisce ogni cella
 * di ogni riga visibile, a ogni fotogramma di scorrimento.
 *
 * Con più vincoli sullo stesso campo (chiavi composite) vince il primo: il
 * pannello mostra una tabella per volta, e la prima colonna del vincolo è
 * quella su cui l'utente ha fatto doppio clic nella stragrande maggioranza dei
 * casi. Il collegamento certo batte comunque l'ipotesi.
 */
export function indicizzaRelazioni(relazioni) {
  const indice = new Map();
  for (const grezzo of Array.isArray(relazioni) ? relazioni : []) {
    const rel = descrittoreRelazione(grezzo);
    if (!rel) continue;
    for (const coppia of rel.coppie) {
      const esistente = indice.get(coppia.campo);
      if (esistente && !(esistente.origine === EURISTICA && rel.origine === VINCOLO)) continue;
      indice.set(coppia.campo, rel);
    }
  }
  return indice;
}

export function setDaRelazione(relazione, riga) {
  const rel = descrittoreRelazione(relazione);
  if (!rel) throw new Error('Relazione non valida.');
  const set = {};
  for (const coppia of rel.coppie) {
    if (!riga || !Object.prototype.hasOwnProperty.call(riga, coppia.colonna)) {
      throw new Error(`Valore riferito "${coppia.colonna}" mancante: nessuna colonna è stata modificata.`);
    }
    set[coppia.campo] = riga[coppia.colonna];
  }
  return set;
}

/** Etichetta del bersaglio, con lo schema/database solo se è un ALTRO. */
export function bersaglioRelazione(relazione, dbCorrente) {
  if (!relazione) return '';
  const altrove = relazione.db && dbCorrente && relazione.db !== dbCorrente;
  const tabella = altrove ? `${relazione.db}.${relazione.tabella}` : relazione.tabella;
  const colonne = relazione.coppie && relazione.coppie.length > 1
    ? `(${relazione.coppie.map((p) => p.colonna).join(', ')})`
    : relazione.colonna;
  return `${tabella}.${colonne}`;
}

/**
 * Riga di spiegazione sotto l'intestazione del pannello. Dice da dove viene il
 * collegamento, perché "ipotizzato dal nome del campo" e "dichiarato dal
 * database" portano a due livelli di fiducia diversi — e solo il secondo
 * garantisce che il valore scelto esista davvero.
 */
export function notaOrigine(relazione) {
  if (!relazione) return '';
  return relazione.origine === VINCOLO
    ? `Chiave esterna${relazione.coppie && relazione.coppie.length > 1 ? ' composita' : ''} dichiarata dal database.`
    : 'Collegamento ipotizzato dal nome del campo: il database non lo garantisce.';
}

/* ------------------------------ Valori EJSON ------------------------------ */

/**
 * Testo leggibile di un valore Extended JSON. Esiste qui invece di riusare
 * `displayValue` di `utils.js` perché quel modulo tira dentro DOM e socket, e
 * questo file deve restare eseguibile in Node.
 */
export function testoValore(v) {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (typeof v === 'string') return tronca(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return tronca(`[${v.length} elementi]`);
  if (typeof v === 'object') {
    if (typeof v.$oid === 'string') return v.$oid;
    if (v.$date !== undefined) return tronca(testoData(v.$date));
    if (v.$numberLong !== undefined) return String(v.$numberLong);
    if (v.$numberDecimal !== undefined) return String(v.$numberDecimal);
    if (v.$binary !== undefined) return '(binario)';
    return tronca(JSON.stringify(v));
  }
  return tronca(String(v));
}

function testoData(d) {
  // EJSON relaxed produce una stringa ISO; fuori dall'intervallo rappresentabile
  // ricade su { $numberLong }, che va comunque mostrato come data e non come
  // numero di millisecondi.
  const ms = (d && typeof d === 'object' && d.$numberLong !== undefined) ? Number(d.$numberLong) : d;
  const data = new Date(ms);
  return Number.isNaN(data.getTime()) ? String(ms) : data.toISOString();
}

/**
 * Chiave di confronto di un valore. Serve a riconoscere la riga corrente
 * nell'elenco dei candidati: `42` (numero, dalla griglia) e `"42"` (stringa,
 * dalla ricerca su una colonna di testo) sono lo stesso riferimento, e
 * distinguerli toglierebbe la spunta proprio dove serve leggerla.
 */
export function chiaveValore(v) {
  if (v === null || v === undefined) return '\0nullo';
  if (typeof v === 'object' && !Array.isArray(v)) {
    if (typeof v.$oid === 'string') return v.$oid;
    if (v.$numberLong !== undefined) return String(v.$numberLong);
    if (v.$numberDecimal !== undefined) return String(Number(v.$numberDecimal));
    if (v.$date !== undefined) return testoData(v.$date);
  }
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    // Un decimale scritto come testo ("42.0") e lo stesso numero devono
    // coincidere; ciò che non è un numero resta il testo che è.
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) ? String(n) : v;
  }
  return testoValore(v);
}

/** I due valori indicano lo stesso riferimento? */
export function stessoValore(a, b) {
  return chiaveValore(a) === chiaveValore(b);
}

/* ------------------------- Etichetta delle righe -------------------------- */

/**
 * Quale colonna mostrare accanto alla chiave nell'elenco dei candidati, o
 * `null` se nessuna aiuta.
 *
 * Si guardano i DATI, non i nomi: una tabella reale ha colonne che si chiamano
 * `rag_soc`, `descr` o `lbl`, e un elenco di nomi noti le manca tutte. Le righe
 * che stiamo per mostrare dicono già quale colonna distingue una riga
 * dall'altra — ed è esattamente ciò che serve per scegliere fra due righe.
 *
 * I due scarti che contano:
 *  - le colonne piene a metà (più della metà dei valori vuoti): un'etichetta
 *    che manca su una riga su due fa sembrare vuote righe che non lo sono;
 *  - le colonne costanti: "42 — attivo / 51 — attivo" occupa spazio senza
 *    distinguere nulla, cioè fa il contrario del suo unico compito.
 */
export function scegliEtichetta(righe, colonnaChiave, colonne = null) {
  const elenco = Array.isArray(righe) ? righe : [];
  if (!elenco.length) return null;
  const nomi = colonne && colonne.length ? colonne : colonneDelle(elenco);

  let migliore = null;
  for (const nome of nomi) {
    if (nome === colonnaChiave || nome === '_id') continue;
    const stat = statisticaColonna(elenco, nome);
    if (!stat) continue;
    if (stat.pieni * 2 < elenco.length) continue; // troppo vuota per fare da etichetta
    if (elenco.length >= MIN_RIGHE_PER_DISTINTIVITA && stat.distinti < 2) continue; // costante
    // A parità di distintività vince la colonna che viene prima: chi progetta
    // una tabella mette il nome all'inizio e i dettagli in fondo.
    if (!migliore || stat.distintivita > migliore.distintivita) migliore = { nome, ...stat };
  }
  return migliore ? migliore.nome : null;
}

// Statistiche di una colonna ai soli fini dell'etichetta, oppure null se la
// colonna non è testuale. Restano fuori numeri, booleani, date e oggetti: un
// secondo identificatore accanto al primo non aiuta a scegliere una riga.
function statisticaColonna(righe, nome) {
  let pieni = 0;
  const distinti = new Set();
  for (const riga of righe) {
    const v = riga ? riga[nome] : undefined;
    if (typeof v !== 'string') {
      // Una colonna testuale può avere valori nulli; se invece contiene un tipo
      // diverso, non è una colonna di etichette.
      if (v === null || v === undefined) continue;
      return null;
    }
    if (v.trim() === '') continue;
    pieni += 1;
    distinti.add(v);
  }
  if (!pieni) return null;
  return { pieni, distinti: distinti.size, distintivita: distinti.size / pieni };
}

// Unione ordinata delle chiavi delle righe: su MongoDB non esiste un elenco di
// colonne dichiarate, e documenti diversi hanno campi diversi.
function colonneDelle(righe) {
  const nomi = [];
  const viste = new Set();
  for (const riga of righe) {
    for (const k of Object.keys(riga || {})) {
      if (!viste.has(k)) { viste.add(k); nomi.push(k); }
    }
  }
  return nomi;
}

/**
 * Testo di una riga nell'elenco dei candidati: la chiave, e l'etichetta quando
 * c'è. La chiave viene sempre per prima perché è ciò che finirà nella cella —
 * il nome serve a riconoscere la riga, non a identificarla.
 */
export function etichettaRiga(riga, colonnaChiave, colonnaEtichetta) {
  const chiave = testoValore(riga ? riga[colonnaChiave] : undefined);
  if (!colonnaEtichetta) return chiave;
  const eti = testoValore(riga ? riga[colonnaEtichetta] : undefined);
  return eti && eti !== 'null' ? `${chiave} — ${eti}` : chiave;
}

/* --------------------------------- Utility -------------------------------- */

function testoSemplice(v) {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
}

function tronca(s, max = MAX_TESTO) {
  const t = String(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
