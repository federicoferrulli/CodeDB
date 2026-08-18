'use strict';

/* ---------------------------------------------------------------------------
 * Duplicazione di una riga/documento: la parte che NON tocca il database.
 *
 * Duplicare una riga è banale finché non ci sono vincoli: appena c'è una chiave
 * primaria, un indice unico o una colonna calcolata, la copia identica non è
 * inseribile. Prima questa decisione era lasciata all'utente davanti a un
 * editor JSON (togli tu l'`_id`, cambia tu l'email); qui viene presa dal
 * codice, che i vincoli li conosce.
 *
 * Due modalità, e la differenza sta solo in QUANTE chiavi si azzerano:
 *   - senza chiavi: la primaria e ogni colonna di un indice unico lasciano il
 *     posto a un valore generato dal DBMS, a NULL o a un valore nuovo;
 *   - con chiavi: tutte le chiavi restano come sono, tranne la primaria, che
 *     va comunque ricalcolata (è l'unica che collide con certezza).
 *
 * Le colonne CALCOLATE dal DBMS (GENERATED ALWAYS AS …) escono sempre dal
 * documento, in entrambe le modalità: scriverle è un errore SQL, non una
 * scelta.
 *
 * Il modulo è puro — nessun driver, nessuna query — perché è qui che stanno le
 * decisioni sbagliabili in silenzio: una chiave lasciata dentro dà un errore
 * evidente, una chiave azzerata di troppo dà un duplicato che sembra giusto.
 * ------------------------------------------------------------------------- */

// Cosa è successo a una colonna nel documento duplicato.
const OMESSA = 'omessa';       // tolta dal documento: la genera il DBMS
const AZZERATA = 'azzerata';   // scritta a NULL
const RICALCOLA = 'ricalcola'; // serve un valore nuovo: lo calcola la strategia
const CONSERVATA = 'conservata';

/**
 * Toglie l'involucro Extended JSON da un valore scalare.
 * I documenti viaggiano in EJSON: `5` può arrivare come `{ "$numberLong": "5" }`
 * e una chiave testuale come stringa nuda. Per calcolare "il prossimo valore"
 * serve il valore, non l'involucro.
 */
function valoreSemplice(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return v;
  if (typeof v.$numberInt === 'string') return Number(v.$numberInt);
  if (typeof v.$numberLong === 'string') return Number(v.$numberLong);
  if (typeof v.$numberDouble === 'string') return Number(v.$numberDouble);
  if (typeof v.$numberDecimal === 'string') return Number(v.$numberDecimal);
  if (typeof v.$oid === 'string') return v.$oid;
  if (typeof v.$date === 'string') return v.$date;
  return v;
}

/**
 * Famiglia del tipo di colonna, dedotta dal tipo dichiarato dal DBMS
 * (`int unsigned`, `character varying(80)`, `uuid`, `numeric(12,2)`…).
 * Serve a decidere COME si calcola un valore nuovo, non a validarlo.
 */
function categoriaTipo(tipo) {
  const t = String(tipo || '').toLowerCase();
  if (!t) return 'altro';
  if (/^uuid\b/.test(t)) return 'uuid';
  if (/\b(serial|int|integer|smallint|bigint|tinyint|mediumint|decimal|numeric|float|double|real|money)\b/.test(t)) return 'numero';
  if (/(char|text|varchar|clob|citext|name)/.test(t)) return 'testo';
  return 'altro';
}

/** Lunghezza massima dichiarata (`varchar(80)` → 80), altrimenti null. */
function lunghezzaMassima(tipo) {
  const m = /(?:var)?char(?:acter)?(?:\s+varying)?\s*\(\s*(\d+)\s*\)/i.exec(String(tipo || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Candidato n-esimo per una chiave testuale: `Rossi` → `Rossi-copia`,
 * `Rossi-copia-2`, … Il suffisso non deve far sforare la lunghezza della
 * colonna, quindi è la BASE ad accorciarsi (un `varchar(8)` troncato a
 * `Rossi-co` sarebbe indistinguibile dall'originale al tentativo dopo).
 */
function candidatoTesto(base, n, max) {
  const suffisso = n <= 1 ? '-copia' : `-copia-${n}`;
  let testo = String(base == null ? '' : base);
  if (max != null && max > 0) {
    if (suffisso.length >= max) return suffisso.slice(-max); // colonna cortissima
    testo = testo.slice(0, max - suffisso.length);
  }
  return testo + suffisso;
}

/**
 * Piano di duplicazione: quali colonne escono dal documento, quali vanno a
 * NULL e quali hanno bisogno di un valore nuovo dal database.
 *
 * @param {object}   opzioni.doc        documento sorgente (EJSON già parsato in JSON semplice)
 * @param {Array}    opzioni.colonne    [{ name, tipo, pk, nullable, generabile, generata }]
 *        `generabile` = il DBMS produce da solo un valore NUOVO se la colonna
 *        non viene scritta (AUTO_INCREMENT, serial/identity, ObjectId): un
 *        DEFAULT costante non lo è, perché darebbe lo stesso valore.
 * @param {Array}    opzioni.uniche     indici unici NON primari, come liste di colonne
 * @param {boolean}  opzioni.conChiavi  true = conserva le chiavi tranne la primaria
 * @param {boolean}  opzioni.idVirtuale true = `_id` non è una colonna vera (SQL)
 * @returns {{ doc: object, azioni: object, ricalcola: string[], note: string[] }}
 */
function pianificaDuplicazione(opzioni = {}) {
  const sorgente = opzioni.doc && typeof opzioni.doc === 'object' && !Array.isArray(opzioni.doc)
    ? opzioni.doc
    : {};
  const doc = { ...sorgente };
  const colonne = Array.isArray(opzioni.colonne) ? opzioni.colonne : [];
  const uniche = Array.isArray(opzioni.uniche) ? opzioni.uniche : [];
  const conChiavi = opzioni.conChiavi === true;
  const azioni = {};
  const ricalcola = [];
  const note = [];

  const ha = (nome) => Object.prototype.hasOwnProperty.call(doc, nome);
  const omette = (nome) => { delete doc[nome]; azioni[nome] = OMESSA; };

  // `_id` sintetico della griglia SQL (la chiave primaria impacchettata): non è
  // una colonna, e passarlo all'INSERT darebbe "Unknown column '_id'".
  if (opzioni.idVirtuale && ha('_id')) delete doc._id;

  // Colonne calcolate dal DBMS: scriverle è sempre un errore.
  for (const c of colonne) {
    if (c.generata && ha(c.name)) {
      omette(c.name);
      note.push(`«${c.name}» è calcolata dal database: la ricalcola da sé.`);
    }
  }

  const primaria = colonne.filter((c) => c.pk).map((c) => c.name);
  const inPrimaria = new Set(primaria);
  const perNome = new Map(colonne.map((c) => [c.name, c]));

  // --- Chiave primaria: sempre nuova, in entrambe le modalità ---------------
  const daGenerare = primaria.filter((n) => perNome.get(n).generabile);
  const daCalcolare = primaria.filter((n) => !perNome.get(n).generabile);
  for (const nome of daGenerare) omette(nome);
  if (daCalcolare.length) {
    // Chiave composta senza generatore: si rifà l'ULTIMA componente e si
    // conservano le altre. Rifarle tutte scollegherebbe il duplicato dal suo
    // contesto (in (ordine_id, riga) cambiare anche l'ordine lo sposterebbe in
    // un altro ordine), e il valore nuovo dell'ultima basta a rendere unica la
    // tupla.
    const bersaglio = daCalcolare[daCalcolare.length - 1];
    for (const nome of daCalcolare) if (nome !== bersaglio) azioni[nome] = CONSERVATA;
    azioni[bersaglio] = RICALCOLA;
    ricalcola.push(bersaglio);
    if (daCalcolare.length > 1) {
      note.push(`Chiave primaria composta: si ricalcola «${bersaglio}», le altre componenti restano.`);
    }
  }

  // --- Altre chiavi: restano solo nella modalità "con chiavi" ---------------
  if (!conChiavi) {
    const viste = new Set();
    for (const indice of uniche) {
      for (const nome of (Array.isArray(indice) ? indice : [])) {
        if (inPrimaria.has(nome) || viste.has(nome) || !perNome.has(nome)) continue;
        viste.add(nome);
        const c = perNome.get(nome);
        if (c.generata) continue; // già tolta sopra
        if (c.generabile) { omette(nome); continue; }
        if (c.nullable) {
          // Su MySQL e PostgreSQL un indice unico ammette più NULL: è il modo
          // più onesto di dire "questo valore lo metterai tu".
          doc[nome] = null;
          azioni[nome] = AZZERATA;
          continue;
        }
        azioni[nome] = RICALCOLA;
        ricalcola.push(nome);
      }
    }
    if (viste.size) {
      note.push(`Chiavi uniche svuotate: ${[...viste].map((n) => `«${n}»`).join(', ')}.`);
    }
  } else if (uniche.length) {
    const nomi = [...new Set(uniche.flat().filter((n) => !inPrimaria.has(n) && perNome.has(n)))];
    if (nomi.length) {
      note.push(`Chiavi uniche conservate: ${nomi.map((n) => `«${n}»`).join(', ')} — se il database le impone univoche, l'inserimento fallirà.`);
    }
  }

  return { doc, azioni, ricalcola, note };
}

/**
 * Valore nuovo per una chiave, orchestrando le sole domande che il database sa
 * rispondere. Nessuna query qui dentro: le due funzioni arrivano dalla
 * strategia, così la regola ("i numeri vanno a MAX+1, il testo prende un
 * suffisso finché è libero") è una sola per MySQL, PostgreSQL e MongoDB.
 *
 * @param {string}   tipo        tipo dichiarato della colonna
 * @param {*}        originale   valore della riga sorgente (già senza involucro EJSON)
 * @param {Function} massimo     () => Promise<number|null>  — MAX(colonna)
 * @param {Function} esiste      (valore) => Promise<boolean> — esiste già una riga con quel valore
 * @param {Function} [uuid]      () => string — generatore di UUID
 * @param {number}   [tentativi] quanti suffissi provare prima di arrendersi
 * @returns {Promise<{ valore: *, come: string }|null>} null = non calcolabile
 */
async function calcolaNuovoValore({ tipo, originale, massimo, esiste, uuid, tentativi = 50 }) {
  let categoria = categoriaTipo(tipo);
  // Su MongoDB la colonna non ha un tipo dichiarato: lo dice il valore. Il
  // ripiego vale SOLO senza tipo: un `timestamp` come chiave e' un tipo noto e
  // senza una regola sensata, e trattarlo come testo darebbe "2024-01-01-copia"
  // — un valore che la colonna rifiuta, dopo aver fatto credere di aver capito.
  if (categoria === 'altro' && !String(tipo || '').trim()) {
    if (typeof originale === 'number') categoria = 'numero';
    else if (typeof originale === 'string') categoria = 'testo';
  }

  if (categoria === 'uuid' && typeof uuid === 'function') {
    for (let i = 0; i < tentativi; i++) {
      const v = uuid();
      if (!(await esiste(v))) return { valore: v, come: 'uuid' };
    }
    return null;
  }

  if (categoria === 'numero') {
    const max = await massimo();
    let v = Number.isFinite(Number(max)) ? Math.floor(Number(max)) + 1 : 1;
    for (let i = 0; i < tentativi; i++, v++) {
      if (!(await esiste(v))) return { valore: v, come: 'max+1' };
    }
    return null;
  }

  if (categoria === 'testo') {
    const max = lunghezzaMassima(tipo);
    for (let n = 1; n <= tentativi; n++) {
      const v = candidatoTesto(originale, n, max);
      if (!(await esiste(v))) return { valore: v, come: 'suffisso' };
    }
    return null;
  }

  return null;
}

/**
 * Documento sorgente inviato dal client: testo EJSON, letto come JSON semplice.
 * Non si deserializza in tipi BSON di proposito — i valori che NON cambiano
 * devono tornare al `docInsert` esattamente com'erano (`{ "$date": … }` resta
 * una data, `{ "$numberLong": … }` non diventa un double).
 */
function documentoSorgente(testo) {
  let doc;
  try {
    doc = typeof testo === 'string' ? JSON.parse(testo) : testo;
  } catch {
    throw new Error('Documento da duplicare non valido: atteso JSON.');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Documento da duplicare non valido: attesa una coppia { "campo": valore }.');
  }
  return doc;
}

/**
 * Scrive nel piano l'esito del ricalcolo di una chiave.
 * Se il valore non è calcolabile: sulla PRIMARIA è un errore parlante (senza
 * chiave nuova l'inserimento fallirebbe comunque, ma con un messaggio del
 * driver); su una chiave unica secondaria è una nota — il valore originale
 * resta e sarà il database a rifiutarlo, se davvero collide.
 */
function applicaRicalcolo(piano, nome, nuovo, { pk = false, etichetta = 'colonna' } = {}) {
  if (nuovo) {
    piano.doc[nome] = nuovo.valore;
    piano.azioni[nome] = 'nuovo';
    piano.note.push(`Nuovo valore per «${nome}»: ${JSON.stringify(nuovo.valore)}.`);
    return piano;
  }
  if (pk) {
    throw new Error(
      `Non è stato possibile calcolare una nuova chiave primaria per «${nome}» `
      + `(${etichetta}): usa "Duplica e modifica…" per indicarla a mano.`
    );
  }
  piano.azioni[nome] = CONSERVATA;
  piano.note.push(`«${nome}» è unica ma non ricalcolabile: resta invariata, l'inserimento fallirà se collide.`);
  return piano;
}

/**
 * Rimette al valore nuovo lo stesso involucro Extended JSON dell'originale.
 * Senza, il duplicato di un `_id` `{ "$numberInt": "5" }` diventava un double 6:
 * la chiave funziona, ma la collection si ritrova due tipi diversi sullo stesso
 * campo — differenza che si scopre molto piu' tardi, ordinando o confrontando.
 */
function riavvolgi(originale, valore) {
  if (typeof valore !== 'number' || !originale || typeof originale !== 'object' || Array.isArray(originale)) {
    return valore;
  }
  for (const chiave of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']) {
    if (typeof originale[chiave] === 'string') return { [chiave]: String(valore) };
  }
  return valore;
}

module.exports = {
  OMESSA,
  AZZERATA,
  RICALCOLA,
  CONSERVATA,
  valoreSemplice,
  categoriaTipo,
  lunghezzaMassima,
  candidatoTesto,
  pianificaDuplicazione,
  calcolaNuovoValore,
  documentoSorgente,
  applicaRicalcolo,
  riavvolgi,
};
