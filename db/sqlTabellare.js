'use strict';

/* ---------------------------------------------------------------------------
 * Il tabellare comune ai due motori SQL.
 *
 * La griglia dati è una sola: la stessa colonna cliccata produce lo stesso
 * ordinamento, la stessa riga selezionata produce lo stesso `_id`, e lo stesso
 * `_id` rimandato indietro deve colpire quella riga e non un'altra. Queste
 * quattro decisioni non hanno nulla di MySQL né di PostgreSQL — vivevano però
 * in due copie byte per byte identiche dentro i due adattatori, messaggio
 * d'errore e costanti comprese, dove correggerne una lasciava l'altra intatta
 * senza che nulla lo segnalasse.
 *
 * Ciò che davvero cambia fra i due motori è soltanto il DIALETTO: come si
 * quota un identificatore, come si qualifica una tabella, come si scrive
 * l'uguaglianza sulla chiave (`<=>` e `?` su MySQL, `IS NULL`/`=` e `$n` su
 * PostgreSQL). Sta tutto nell'oggetto passato a `tabellare()`, e resta
 * dell'adattatore.
 *
 * Sono funzioni pure: si provano senza alcun database acceso
 * (`test/unit-sql-tabellare.js`).
 * ------------------------------------------------------------------------- */

const DbStrategy = require('./DbStrategy');
// Il filtro come DATO, accanto a quello testuale: vedi db/filtro.js.
const { normalizzaFiltro, rendiSql } = require('./filtro');
// I valori del filtro arrivano in EJSON come tutto il resto del protocollo: qui
// tornano tipi nativi, altrimenti una data verrebbe confrontata come l'oggetto
// `{ $date: … }` e non troverebbe mai nulla (vedi db/sqlValori.js).
const { parseClientValue, deserializeClientObject } = require('./sqlValori');

// _id virtuale per il client: la chiave primaria come oggetto
// { colonna: valore }. Senza chiave primaria si usa l'intera riga come
// chiave composita di fallback.
function componiIdRiga(row, pkCols, allCols) {
  const cols = pkCols.length ? pkCols : allCols;
  const id = {};
  for (const c of cols) id[c] = row[c];
  return id;
}

// Risale dalla chiave inviata dal client (JSON.stringify di _id) e la
// trasforma in clausola WHERE. `whereFromId` è la parte di dialetto.
function leggiIdRiga(rawId, whereFromId) {
  const id = parseClientValue(rawId);
  if (!id || typeof id !== 'object' || Array.isArray(id)) {
    throw new Error('Identificatore di riga non valido.');
  }
  return whereFromId(id);
}

/* ---------------------------------------------------------------------------
 * Dove vanno i valori nulli.
 *
 * LA REGOLA DI CODEDB: **il valore nullo e' il piu' piccolo.** In salita sta in
 * cima, in discesa in fondo. E' una proprieta' della griglia, non di un motore,
 * e per questo sta qui e non nei due adattatori.
 *
 * Senza questa regola lo stesso clic sulla stessa intestazione dava tre ordini
 * diversi — misurato su motori veri, stessi tre valori, ORDER BY nome:
 *
 *   MySQL        ASC: <NULL> aldo bruno    DESC: bruno aldo <NULL>
 *   MongoDB      ASC: <NULL> <assente> …   DESC: … <NULL> <assente>
 *   PostgreSQL   ASC: aldo bruno <NULL>    DESC: <NULL> bruno aldo
 *
 * Due motori su tre gia' la seguono, quindi cambia solo PostgreSQL. Cio' che
 * varia e' come ciascun dialetto la SCRIVE: PostgreSQL con un suffisso
 * esplicito, MySQL con niente perche' il suo predefinito gia' coincide.
 * ------------------------------------------------------------------------- */

/**
 * Il suffisso serve?
 *
 * Su una colonna che non ammette nulli i motori non possono differire, e il
 * suffisso e' inutile — ma NON e' innocuo: su PostgreSQL un `NULLS FIRST`
 * esplicito su una colonna NOT NULL con indice produce comunque Seq Scan +
 * Sort, perche' il planner non riconosce che e' un'operazione nulla.
 * L'omissione deve farla CodeDB. E' anche dove si recupera quasi tutto il
 * costo, perche' si ordina soprattutto per chiavi e identificatori.
 *
 * Quando la nullabilita' NON si conosce (nessun elenco di colonne, o un
 * dialetto che non la chiede) il suffisso si mette: sbagliare l'ordine e' un
 * difetto visibile su tutte le righe vuote, sbagliare il piano e' lento.
 */
function serveSuffissoNulli(col, colonne) {
  if (!Array.isArray(colonne)) return true;
  const descrittore = colonne.find((c) => c && c.name === col);
  if (!descrittore) return true;
  return descrittore.nullable !== false;
}

/**
 * ORDER BY: accetta sia SQL libero ("name ASC") sia il JSON {"name": 1}
 * prodotto dal click sulle intestazioni di colonna.
 *
 * `opzioni` porta cio' che si sa della TABELLA su cui si ordina: `colonne`,
 * l'elenco dei descrittori con nome, tipo e nullabilita'.
 *
 * L'SQL LIBERO non viene mai riscritto — nemmeno per allineare i nulli. Se
 * l'utente ordina a mano, comanda lui: e' il confine dichiarato del ticket 27.
 */
function componiOrdinamento(text, qid, opzioni = {}) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.startsWith('{')) {
    let spec;
    try {
      spec = JSON.parse(t);
    } catch {
      throw new Error('Ordinamento non valido: usare SQL (es. name ASC) oppure JSON (es. {"name":1}).');
    }
    const nulliPrima = opzioni.nulliPrima || (() => '');
    const parts = Object.entries(spec).map(([col, dir]) => {
      const discendente = Number(dir) < 0;
      const verso = discendente ? 'DESC' : 'ASC';
      const suffisso = serveSuffissoNulli(col, opzioni.colonne) ? nulliPrima(discendente) : '';
      return `${qid(col)} ${verso}${suffisso}`;
    });
    return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
  }
  // SQL libero: passa invariato, suffisso compreso.
  return ` ORDER BY ${t}`;
}

/**
 * Il valore di una condizione, come tipo nativo.
 *
 * I valori del filtro arrivano in Extended JSON come tutto il resto del
 * protocollo: una data e' `{ $date: … }` e un ObjectId `{ $oid: … }`. Passarli
 * al driver cosi' com'e' li confronterebbe come OGGETTI, e una data non
 * troverebbe mai nulla. I valori semplici (numeri, testo, booleani) passano
 * invariati: non c'e' niente da decodificare, e farli attraversare il
 * decodificatore li trasformerebbe soltanto in un giro inutile.
 */
function valoreNativo(v) {
  if (v === null || typeof v !== 'object') return v;
  return deserializeClientObject({ v }).v;
}

// Pezzi comuni di una SELECT su filter/sort/limit/skip liberi (usati sia
// dalla query dati vera e propria sia dal suo EXPLAIN).
function componiSelezione(db, coll, payload, {
  qid, qtable, ordinamento, segnaposto, testoDi, ricercaGlobale,
}) {
  // DUE filtri, per ora conviventi.
  //
  //  - `filter` è il frammento di clausola GREZZO storico: arriva già scritto e
  //    viene interpolato. È la ragione per cui esiste l'analisi sintattica
  //    difensiva di auth/sqlClause.js, e sparirà con il ticket 24;
  //  - `filtro` è il filtro strutturato: un elenco di condizioni che viene reso
  //    qui e PARAMETRIZZATO. Il valore non attraversa mai il testo della query.
  //
  // Quando ci sono entrambi valgono entrambi, uniti da AND: è la condizione che
  // permette di migrare un chiamante per volta senza che gli altri cambino
  // comportamento.
  const pezziWhere = [];
  const whereParams = [];

  const where = String(payload.filter || '').trim();
  if (where) pezziWhere.push(where);

  const strutturato = normalizzaFiltro(payload.filtro);
  if (strutturato) {
    if (typeof segnaposto !== 'function') {
      throw new Error('Dialetto SQL incompleto: il filtro strutturato richiede "segnaposto".');
    }
    // I parametri del filtro vengono PRIMA di quelli di limite e salto, ed è il
    // chiamante a saperlo: su PostgreSQL il numero del segnaposto è la
    // posizione reale, e sbagliarla farebbe leggere il limite al posto del
    // filtro.
    const reso = rendiSql(strutturato, { qid, segnaposto, testoDi }, 1);
    if (reso.sql) {
      pezziWhere.push(reso.sql);
      whereParams.push(...reso.params.map(valoreNativo));
    }
  }

  // La ricerca globale è un'intenzione, non un OR costruito nel browser. La
  // strategia possiede metadati e dialetto e restituisce SQL parametrizzato;
  // il numero iniziale segue gli eventuali parametri del filtro strutturato.
  if (payload.cercaOvunque != null) {
    if (typeof ricercaGlobale !== 'function') {
      throw new Error('Ricerca globale non disponibile per questa strategia.');
    }
    const globale = ricercaGlobale(1 + whereParams.length);
    if (globale && globale.sql) {
      pezziWhere.push(globale.sql);
      whereParams.push(...(globale.params || []).map(valoreNativo));
    }
  }

  // Un pezzo solo resta scritto com'è: le parentesi servono solo quando i
  // due filtri convivono, e aggiungerle sempre cambierebbe il testo prodotto
  // per il filtro testuale, che deve restare quello di prima.
  const whereSql = pezziWhere.length
    ? ` WHERE ${pezziWhere.length === 1 ? pezziWhere[0] : pezziWhere.map((p) => `(${p})`).join(' AND ')}`
    : '';
  // L'ordinamento NON si compone qui: si chiede a chi lo sa fare.
  //
  // Prima questa riga chiamava `componiOrdinamento` direttamente, e il punto di
  // estensione veniva saltato: un motore che sovrascrivesse `buildOrderBy` —
  // che e' l'idioma di questo strato, la classe base propone e il motore
  // corregge — sarebbe stato ascoltato dalla tab ⚡ e **ignorato in silenzio
  // dalla griglia**. Due ordinamenti diversi nello stesso motore a seconda
  // della strada, senza alcun errore.
  const orderSql = ordinamento(payload.sort);
  const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), DbStrategy.resultCap(payload));
  const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
  const table = qtable(db, coll);
  return { table, whereSql, whereParams, orderSql, limit, skip };
}

/**
 * Lega le quattro funzioni a un dialetto e le restituisce già pronte.
 * `dialetto`: { qid, qtable, whereFromId }.
 */
function tabellare(dialetto) {
  const { qid, qtable, whereFromId, nulliPrima, segnaposto, testoDi } = dialetto || {};
  if (typeof qid !== 'function' || typeof qtable !== 'function' || typeof whereFromId !== 'function') {
    throw new Error('Dialetto SQL incompleto: servono qid, qtable e whereFromId.');
  }
  return {
    makeId: (row, pkCols, allCols) => componiIdRiga(row, pkCols, allCols),
    parseRowId: (rawId) => leggiIdRiga(rawId, whereFromId),
    buildOrderBy: (text, opzioni) => componiOrdinamento(text, qid, { ...opzioni, nulliPrima }),
    /**
     * `ordinamento` e' il modo in cui il chiamante impone CHI compone l'ORDER
     * BY. Gli adattatori passano `(t) => this.buildOrderBy(t, opzioni)`, cosi'
     * una sottoclasse che sovrascriva quel metodo viene ascoltata anche dalla
     * griglia. Se non lo passa nessuno si ricade sul comune, che e' quello che
     * facevano tutti prima.
     */
    buildSelect: (db, coll, payload, opzioni = {}) => componiSelezione(db, coll, payload, {
      qid,
      qtable,
      segnaposto,
      testoDi,
      ricercaGlobale: opzioni.ricercaGlobale,
      ordinamento: opzioni.ordinamento
        || ((t) => componiOrdinamento(t, qid, { ...opzioni, nulliPrima })),
    }),
  };
}

/* ---------------------------------------------------------------------------
 * Una porta sola.
 *
 * Le quattro funzioni qui sopra restano deliberatamente NON esportate. Prese da
 * sole accettano qualunque regola di quotatura, e comporre l'ordinamento di una
 * griglia MySQL passando le regole di PostgreSQL dava ` ORDER BY "nome" ASC`
 * senza che nulla protestasse — provato. Non era una via di fuga per il motore
 * che deve divergere (legate al dialetto danno esattamente ciò che dà il metodo
 * della strategia, non un grammo di più): era solo la possibilità di
 * accoppiarle male, e la riconciliazione dei metodi gemelli ne avrebbe versate
 * altre lì dentro.
 *
 * Servivano solo alla prova, e la prova ora passa dalla stessa porta della
 * produzione — che è ciò che una prova dovrebbe fare comunque.
 * ------------------------------------------------------------------------- */

module.exports = { tabellare };
