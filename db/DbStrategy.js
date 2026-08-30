'use strict';

/* ---------------------------------------------------------------------------
 * Strategy Pattern: interfaccia comune a tutti i DBMS supportati.
 *
 * Ogni metodo riceve dati "grezzi" dal payload socket e ritorna l'oggetto da
 * unire alla risposta { ok: true, ... }; in caso di problema lancia un Error
 * con il messaggio (in italiano) da mostrare all'utente.
 * ------------------------------------------------------------------------- */

function unsupported() {
  return new Error('Operazione non supportata da questo tipo di database.');
}

class DbStrategy {
  /** Identificatore del tipo di database (es. 'mongodb', 'mysql'). */
  get type() { return 'unknown'; }

  /** Apre la connessione; lancia se le credenziali o l'host non sono validi. */
  async connect(_cfg) { throw unsupported(); }

  /** Chiude la connessione e libera le risorse (watch incluso). */
  async disconnect() { throw unsupported(); }

  /** @returns {Promise<Array<{name: string, sizeOnDisk: number}>>} */
  async listDatabases() { throw unsupported(); }

  /**
   * Cerca database e collection in base a una stringa.
   * @returns {Promise<Array<{name: string, collections: Array<{name: string, count?: number}>}>>}
   */
  async search(_query) { throw unsupported(); }

  async createDatabase(_db, _firstColl) { throw unsupported(); }
  async renameDatabase(_db, _newName) { throw unsupported(); }

  /**
   * Il DBMS sa rinominare un database con un comando atomico?
   *
   * Se no, il server esegue la rinomina come dump → verifica → restore (vedi
   * `rinominaViaDump` in server.js). La distinzione sta qui e non nel
   * chiamante perché è una proprietà del motore, non dell'interfaccia.
   */
  supportsNativeRename() { return false; }
  async dropDatabase(_db) { throw unsupported(); }

  /** @returns {Promise<Array<{name: string, type: string, count: number|null}>>} */
  async listCollections(_db) { throw unsupported(); }

  /** payload.columns (solo SQL): [{ name, type, nullable, default, autoIncrement, primaryKey }] */
  async createCollection(_db, _name, _payload) { throw unsupported(); }
  async renameCollection(_db, _coll, _newName) { throw unsupported(); }
  async dropCollection(_db, _coll) { throw unsupported(); }

  /**
   * Gestione delle colonne/campi: per i database SQL agisce sullo schema
   * (ALTER TABLE), per quelli a documenti sui campi di tutti i documenti.
   */
  async addColumn(_db, _coll, _column) { throw unsupported(); }
  async alterColumn(_db, _coll, _payload) { throw unsupported(); }
  async dropColumn(_db, _coll, _name) { throw unsupported(); }

  /** payload: { fields: '{"campo": 1}', name?, unique? } */
  async createIndex(_db, _coll, _payload) { throw unsupported(); }
  async dropIndex(_db, _coll, _name) { throw unsupported(); }

  /**
   * DDL della collection/tabella (es. CREATE TABLE), usato dall'export di
   * interi database; null per i DBMS senza schema dichiarativo (MongoDB).
   */
  async tableDdl(_db, _coll) { return null; }

  /**
   * Istruzioni DDL da applicare DOPO la creazione di tutte le tabelle e il
   * caricamento dei dati: indici non vincolari e chiavi esterne.
   *
   * Sono separate da `tableDdl` per una ragione di ordine, non di stile: una FK
   * verso una tabella non ancora creata fallisce, e una FK già attiva impone
   * alle righe un ordine di inserimento che l'export non conosce.
   *
   * @returns {Promise<{indexes: string[], foreignKeys: string[]}>}
   */
  async tableAuxDdl(_db, _coll) { return { indexes: [], foreignKeys: [] }; }

  /** @returns {Promise<{stats, indexes, fields, sampled}>} */
  async collectionStats(_db, _coll) { throw unsupported(); }

  /** @returns {Promise<{collections, relations}>} per la vista UML. */
  async dbSchema(_db) { throw unsupported(); }

  /**
   * Chiavi esterne USCENTI della sola tabella/collection indicata, per il
   * pannello di riferimento della griglia (doppio clic su una cella collegata).
   *
   * Non è `dbSchema(db)` ristretto: quello descrive TUTTO il database e su
   * MongoDB campiona documenti per ogni collection, un costo che qui si
   * pagherebbe a ogni apertura di tabella per usarne un ventesimo.
   *
   * `db` e `tabella` del descrittore non sono ridondanti con gli argomenti: una
   * FK può puntare a un altro schema PostgreSQL o a un altro database MySQL, e
   * il pannello deve interrogare QUEL bersaglio, non quello di partenza.
   *
   * `origine` distingue il vincolo dichiarato dall'ipotesi: 'vincolo' è una
   * garanzia del DBMS, 'euristica' è un indovinello sul nome del campo. Un
   * indovinello presentato come certezza è il modo migliore per far fidare
   * l'utente di un collegamento che non esiste.
   *
   * @returns {Promise<Array<{campo, db, tabella, colonna, origine, molti}>>}
   */
  async columnRelations(_db, _coll) { throw unsupported(); }

  /** @returns {Promise<{docs, columns, total, skip, limit}>} */
  async collectionFind(_db, _coll, _payload) { throw unsupported(); }

  /**
   * Conteggio totale dei documenti/righe che soddisfano il filtro, disaccoppiato
   * dalla find: su collection/tabelle enormi è una scansione costosa, quindi la
   * griglia carica prima i dati (total = null) e poi chiede questo conteggio in
   * background con un timeout. Ritorna { total, timedOut? }: `total` è null se il
   * conteggio ha superato il timeout (l'UI mostra il totale come sconosciuto).
   * @returns {Promise<{ total: number|null, timedOut?: boolean }>}
   */
  async collectionCount(_db, _coll, _payload) { throw unsupported(); }

  /** Pipeline di aggregazione (MongoDB) o query SQL libera (MySQL). */
  async collectionAggregate(_db, _coll, _payload) { throw unsupported(); }

  /**
   * Piano di esecuzione (EXPLAIN) della query corrente. Accetta gli stessi
   * parametri di collectionFind/collectionAggregate più `mode`
   * ('find' | 'aggregate'); un filtro vuoto è valido (explain del find pieno).
   * @returns {Promise<{format: 'json'|'table', plan?, rows?, columns?}>}
   */
  async collectionExplain(_db, _coll, _payload) { throw unsupported(); }

  async docInsert(_db, _coll, _payload) { throw unsupported(); }
  /** Documento pronto da inserire come duplicato: vedi db/duplica.js. */
  async duplicatePlan(_db, _coll, _payload) { throw unsupported(); }

  /**
   * Aggiornamento di massa: payload = { filter, set, upsert? } (gateway MCP).
   * Il filtro vuoto va rifiutato: mai aggiornare tutto per sbaglio.
   */
  async collectionUpdateMany(_db, _coll, _payload) { throw unsupported(); }

  async docUpdate(_db, _coll, _payload) { throw unsupported(); }
  async docReplace(_db, _coll, _payload) { throw unsupported(); }
  async docDelete(_db, _coll, _payload) { throw unsupported(); }
  async collectionDeleteMany(_db, _coll, _payload) { throw unsupported(); }

  /**
   * Esporta un blocco di documenti/righe come righe di testo già formattate
   * (paginazione keyset con payload.after/limit, skip come ripiego se non
   * esiste un ordinamento stabile): { lines, count, total, header?, nextAfter }.
   * `total` (il conteggio dell'intera tabella/collection) è presente SOLO
   * nella risposta della prima pagina — vale a dire payload.skip assente/0 e
   * payload.after assente — perché costa una scansione che non serve ripetere
   * a ogni blocco: chi pagina deve conservarlo dalla prima risposta e riusarlo
   * per quelle successive, che lo restituiscono `undefined`.
   */
  async collectionExport(_db, _coll, _payload) { throw unsupported(); }

  /**
   * Importa un blocco di documenti/righe (payload.docs = array in Extended
   * JSON serializzato) e riporta il conteggio: { inserted, failed, errors }.
   */
  async collectionImport(_db, _coll, _payload) { throw unsupported(); }

  /**
   * Aggiornamenti in tempo reale: handlers = { onChange, onUnavailable }.
   * I DBMS senza change stream lasciano l'implementazione di default.
   */
  watch(_db, _coll, _handlers) {
    throw new Error('Gli aggiornamenti in tempo reale non sono supportati da questo tipo di database.');
  }

  unwatch() { /* niente da fermare di default */ }

  /**
   * Aggiornamenti in tempo reale sullo schema (database/collection creati,
   * rinominati o eliminati): handlers = { onChange, onUnavailable }.
   * I DBMS senza change stream degradano subito segnalando onUnavailable:
   * il frontend ripiega su un polling della sidebar.
   */
  watchSchema(handlers) { handlers.onUnavailable(); }

  unwatchSchema() { /* niente da fermare di default */ }

  /**
   * Stato di salute della connessione per il pannello di monitoraggio: misura
   * la latenza di un ping (round-trip a vuoto) e, dove disponibili, le
   * statistiche del pool di connessioni.
   * @returns {Promise<{ latencyMs: number, pool: { limit, total, idle, active, waiting }|null, extra?: object }>}
   */
  async health() { throw unsupported(); }

  /**
   * Annulla una query in corso indicata dall'opHandle.
   * @param {object} _opHandle
   * @returns {Promise<{ cancelled: boolean }>}
   */
  async cancelQuery(_opHandle) { return { cancelled: false }; }

  /**
   * Questa esecuzione va lasciata finire, tetto di tempo o no?
   *
   * È il solo pezzo del tetto di tempo che resta all'adattatore: la giuntura
   * (`db/tetti.js`) decide QUANDO smettere di aspettare, l'adattatore dichiara
   * se per quella particolare chiamata smettere sia sbagliato. Il caso vero è
   * una pipeline MongoDB che materializza (`$out`/`$merge`): fermarla a metà
   * lascerebbe la collection di destinazione scritta a metà, cioè proprio lo
   * stato incoerente che il tetto esiste per evitare. Sui motori SQL non
   * succede, perché l'istruzione annullata fa rollback.
   *
   * La risposta predefinita è "no": un motore nuovo nasce limitato, e per
   * uscirne deve dirlo.
   *
   * @param {string} _metodo nome del metodo invocato
   * @param {any[]} _args argomenti con cui è stato invocato
   * @returns {boolean}
   */
  fuoriDalTettoDiTempo(_metodo, _args) { return false; }

  /**
   * Sessioni e query attive sul SERVER di database — tutte, non solo quelle di
   * CodeDB. È il pannello "chi sta occupando il database in questo momento",
   * e la sua controparte è `killSession`.
   *
   * Il descrittore comune e le regole su cosa sia terminabile stanno in
   * `db/sessioni.js`: le strategie si limitano a interrogare la propria fonte
   * (`$currentOp`, `information_schema.PROCESSLIST`, `pg_stat_activity`) e a
   * passare le righe grezze al normalizzatore.
   *
   * `capacita` dichiara cosa il DBMS sa davvero fare: MongoDB annulla
   * l'operazione ma non chiude la connessione altrui, e l'interfaccia deve
   * dirlo invece di offrire un pulsante che fallirà.
   *
   * @returns {Promise<{ sessioni: object[], capacita: { annullaQuery: boolean, terminaConnessione: boolean }, troncato?: boolean, nota?: string }>}
   */
  async listSessions() { throw unsupported(); }

  /**
   * Termina una sessione altrui sul server di database.
   * @param {string} _id id della sessione (opid Mongo, thread MySQL, pid PG)
   * @param {'query'|'connessione'} _modo annulla la sola operazione o chiude tutto
   * @returns {Promise<{ terminata: boolean, modo: string }>}
   */
  async killSession(_id, _modo) { throw unsupported(); }
}

/* ---------------------------------------------------------------------------
 * Euristiche condivise per le relazioni del diagramma UML
 * ------------------------------------------------------------------------- */

function singular(s) {
  if (s.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

// Euristica per l'UML: un campo "user_id" / "userId" / "user_ids" (oppure di
// tipo ObjectId con nome corrispondente a una collection, anche al plurale)
// viene considerato un riferimento verso quella collection/tabella.
// Indice dei nomi di collection per la risoluzione: forma intera e singolare,
// entrambe minuscole, verso il nome REALE (che conserva le maiuscole).
function indexCollectionNames(names) {
  const byName = new Map();
  for (const name of names) {
    const low = String(name).toLowerCase();
    byName.set(low, name);
    byName.set(singular(low), name);
  }
  return byName;
}

// Relazioni uscenti da UNA sola collection, dato l'indice dei nomi esistenti.
//
// Estratta dal ciclo di `detectRelations` il giorno in cui è servita per il
// pannello delle chiavi esterne della griglia: lì si conosce la collection
// aperta e non si vuole campionare l'intero database per sapere dove punta un
// suo campo. `detectRelations` la richiama a sua volta, così l'euristica resta
// UNA: se il diagramma UML e il pannello divergessero, uno dei due starebbe
// mostrando un collegamento che l'altro nega, senza modo di capire quale.
function relationsForCollection(collection, byName) {
  const resolve = (base) => byName.get(base) || byName.get(base + 's') || byName.get(singular(base));

  const relations = [];
  for (const f of collection.fields || []) {
    if (f.name === '_id') continue;
    const types = f.types || [];
    const low = f.name.toLowerCase();
    const m = low.match(/^(.+?)_?ids?$/);
    if (!m && !types.includes('objectId')) continue;
    const base = m ? m[1] : low;
    const target = resolve(base);
    if (!target || target === collection.name) continue;
    relations.push({
      from: collection.name,
      field: f.name,
      to: target,
      many: types.includes('array') || /ids$/.test(low),
    });
  }
  return relations;
}

function detectRelations(collections) {
  const byName = indexCollectionNames(collections.map((c) => c.name));
  const relations = [];
  for (const c of collections) {
    relations.push(...relationsForCollection(c, byName));
  }
  return relations;
}

DbStrategy.detectRelations = detectRelations;
DbStrategy.relationsForCollection = relationsForCollection;
DbStrategy.indexCollectionNames = indexCollectionNames;
DbStrategy.singular = singular;

/* ---------------------------------------------------------------------------
 * Nomi di oggetti CREATI da CodeDB.
 *
 * I DBMS accettano identificatori arbitrari se quotati: `CREATE DATABASE
 * "<img src=x onerror=…>"` è SQL legale, e quel nome viene poi mostrato nella
 * sidebar, nell'UML, nell'audit e nei menu. Il frontend fa l'escape ovunque
 * (verificato), ma un solo punto dimenticato basta a trasformare un utente con
 * la sola capability `ddl` in chi esegue codice nel browser dell'owner — token
 * di sessione e credenziali comprese.
 *
 * Si vieta quindi alla RADICE che nomi del genere possano essere creati DA
 * CodeDB. Non è una whitelist stretta di caratteri (bloccherebbe nomi
 * legittimi: accenti, punti, nomi non latini) ma il rifiuto della sola classe
 * pericolosa — caratteri di markup, quoting e terminazione di comando, più i
 * caratteri di controllo.
 *
 * ATTENZIONE: vale solo per la CREAZIONE. I nomi PREESISTENTI, creati altrove,
 * devono restare leggibili, apribili ed eliminabili: applicare qui una regola
 * severa renderebbe inutilizzabili database che esistono già.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[<>&"'`;\\\x00-\x1f\x7f]/;

function assertCreatableName(name, what = 'oggetto') {
  const s = String(name == null ? '' : name);
  if (!s.trim()) throw new Error(`Nome ${what} mancante.`);
  if (UNSAFE_NAME_CHARS.test(s)) {
    throw new Error(
      `Nome ${what} non valido: "${s}". Non sono ammessi i caratteri < > & " ' \` ; \\ ` +
      'né caratteri di controllo, perché finirebbero nell\'interfaccia e nei log di tutti gli utenti.'
    );
  }
  return s;
}

DbStrategy.assertCreatableName = assertCreatableName;

/**
 * Tipo SQL di una colonna, scritto dall'utente e interpolato nel DDL.
 *
 * Il NOME della colonna viene quotato (`qid`), il tipo no: non esiste un
 * "escape per tipi", perché `VARCHAR(255)` o `TIMESTAMP WITH TIME ZONE` devono
 * arrivare al motore come sintassi, non come stringa. L'unica difesa possibile
 * è quindi pretendere che il testo ABBIA la forma di un tipo.
 *
 * Non è teoria. Su PostgreSQL le DDL passano da `pool.query(testo)` senza
 * parametri, cioè dal SIMPLE QUERY PROTOCOL, che esegue tutte le istruzioni
 * separate da `;` — lo stesso meccanismo che `auth/capabilities.js` documenta
 * per la classificazione dell'SQL Raw. Un tipo come
 *
 *     text; CREATE ROLE evil SUPERUSER LOGIN PASSWORD 'x'; --
 *
 * trasformava quindi `column:add`/`column:alter` in esecuzione di SQL
 * arbitrario: per un sottoutente con la sola capability `ddl` e uno scope
 * limitato a una tabella era l'uscita completa dal proprio perimetro. Su MySQL
 * `multipleStatements:false` ferma il punto e virgola, ma non le clausole
 * aggiuntive — `INT, RENAME TO tabella_fuori_scope` in un `CHANGE COLUMN`
 * sposta la tabella fuori dallo scope, cioè proprio ciò che `coll2` di
 * `renameCollection` esiste per impedire.
 *
 * COSA SI AMMETTE: parole (lettere, cifre, `_`), separate da spazi, con
 * eventuali argomenti fra parentesi — numeri, parole, virgole e literal fra
 * apici singoli, perché `ENUM('a','b')` e `SET('x')` di MySQL e
 * `geometry(Point,4326)` di PostGIS sono tipi legittimi — e il suffisso `[]`
 * degli array PostgreSQL. Fuori dai literal restano vietati `;`, i quoting
 * (`"`, backtick), la barra rovesciata e gli introduttori di commento: sono
 * esattamente i caratteri che servono a uscire dalla posizione "tipo". La
 * virgola è ammessa solo DENTRO le parentesi, perché a livello superiore è il
 * separatore delle specifiche di un ALTER.
 *
 * DUE REGOLE DI POSIZIONE, che sono ciò che distingue un TIPO da un'ESPRESSIONE.
 * Senza di esse i soli vincoli sui caratteri lasciavano passare
 *
 *     text USING pg_read_file('/etc/passwd')      (ALTER COLUMN … TYPE)
 *     text DEFAULT pg_read_file('/etc/passwd')    (ADD COLUMN)
 *
 * cioè la valutazione di un'espressione arbitraria con l'utente DBMS della
 * connessione, che porta il contenuto di un file dell'host dentro una colonna
 * leggibile con una normale SELECT. Non è un residuo accettabile: è la stessa
 * cosa che `isFileIoSql` vieta altrove proprio perché «il file finisce comunque
 * fuori dal perimetro dello scope». Le regole:
 *
 *  1. **I literal stanno solo dentro le parentesi.** Nei tipi veri compaiono
 *     unicamente come argomenti (`ENUM('a','b')`, `SET('x')`); a livello
 *     superiore un literal è per forza il valore di una clausola.
 *  2. **Un solo gruppo di parentesi, e attaccato alla prima o alla seconda
 *     parola.** È dove sta negli argomenti di un tipo — `VARCHAR(255)`,
 *     `timestamp(3) with time zone`, `character varying(50)`, `bit varying(8)`
 *     — mentre una chiamata di funzione in coda a una clausola cade sempre
 *     dalla terza parola in poi. Blocca anche `REFERENCES altra(id)` e
 *     `GENERATED ALWAYS AS (…) STORED`.
 *
 * LIMITE DICHIARATO, ora piccolo: restano possibili le clausole di sole parole
 * (`text NOT NULL`, `int PRIMARY KEY`, `text UNIQUE`). Non valutano nulla, non
 * nominano altri oggetti e agiscono sulla stessa tabella già dentro lo scope.
 * Per un sottoutente con `ddl` la barriera di fondo resta comunque quella
 * dichiarata altrove: aprirgli la connessione con un utente DBMS a privilegi
 * ridotti.
 */
const MAX_TYPE_LEN = 200;

function assertColumnType(type, what = 'colonna') {
  const s = String(type == null ? '' : type).trim();
  if (!s) throw new Error(`Tipo della ${what} mancante.`);

  const rifiuta = (perche) => {
    throw new Error(
      `Tipo di ${what} non valido: "${s.slice(0, 80)}" — ${perche}. ` +
      'Sono ammessi i tipi SQL nella forma normale (es. INT, VARCHAR(255), ' +
      'DECIMAL(10,2), TIMESTAMP WITH TIME ZONE, TEXT[], ENUM(\'a\',\'b\')). ' +
      'Per una definizione più complessa usa la tab ⚡ Query & Aggregate con un ALTER TABLE esplicito.'
    );
  };

  if (s.length > MAX_TYPE_LEN) rifiuta(`supera i ${MAX_TYPE_LEN} caratteri`);

  let profondita = 0;
  let parole = 0;          // parole incontrate a livello superiore
  let gruppi = 0;          // gruppi di parentesi aperti a livello superiore
  let inParola = false;    // si sta attraversando una parola (per contarle una volta)
  let ultimaParola = '';   // ultima parola di livello superiore, per la regola 2

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const eCarattereDiParola = /[A-Za-z0-9_]/.test(c);
    if (profondita === 0) {
      if (eCarattereDiParola) {
        if (!inParola) { parole++; ultimaParola = ''; }
        ultimaParola += c;
      }
      inParola = eCarattereDiParola;
    }

    // Literal fra apici singoli: il contenuto è un DATO (i valori di ENUM/SET),
    // quindi non lo si ispeziona — ma lo si deve attraversare correttamente,
    // apici raddoppiati compresi, o il resto dell'analisi guarderebbe il testo
    // sbagliato. La barra rovesciata è vietata ovunque proprio perché in MySQL
    // sarebbe un escape e permetterebbe di non chiudere mai il literal.
    if (c === "'") {
      // Fuori dalle parentesi un literal non è mai parte di un tipo: è il
      // valore di una clausola (`text DEFAULT 'x'`). Vedi la regola 1.
      if (profondita === 0) rifiuta("un valore fra apici può comparire solo fra parentesi, come argomento del tipo");
      i++;
      for (;;) {
        if (i >= s.length) rifiuta('un apice non è mai chiuso');
        if (s[i] === "'") {
          if (s[i + 1] === "'") { i += 2; continue; }
          break;
        }
        if (s[i] === '\\') rifiuta('la barra rovesciata non è ammessa');
        i++;
      }
      continue;
    }

    if (c === '(') {
      // Regola 2: un solo gruppo, e attaccato al NOME DEL TIPO.
      //
      // Normalmente è la prima parola (`VARCHAR(255)`, `timestamp(3) with time
      // zone`). L'unica eccezione reale è `varying`, che completa il nome di due
      // tipi standard — `character varying(50)` e `bit varying(8)` — ed è
      // esattamente la forma che `information_schema.columns` restituisce su
      // PostgreSQL, cioè quella che pre-riempie il form di modifica: escluderla
      // significherebbe rifiutare il tipo che CodeDB stesso propone.
      //
      // Senza il vincolo sulla parola, `parole <= 2` lasciava passare
      // `text USING (pg_read_file('/etc/passwd'))` e `text USING (SELECT … FROM
      // segreti)`: `USING` occupava la seconda posizione e la parentesi
      // successiva sembrava un elenco di argomenti.
      if (profondita === 0) {
        if (gruppi >= 1) rifiuta('un tipo ha al massimo un elenco di argomenti fra parentesi');
        if (parole > 2 || (parole === 2 && ultimaParola.toLowerCase() !== 'varying')) {
          rifiuta('le parentesi seguono il nome del tipo, non una clausola successiva');
        }
        gruppi++;
      }
      profondita++;
      // Nessun tipo ha argomenti annidati: la profondità 2 è sempre una
      // chiamata di funzione o una sotto-query dentro una clausola. Seconda
      // rete, indipendente dal conteggio delle parole.
      if (profondita > 1) rifiuta('gli argomenti di un tipo non contengono altre parentesi');
      continue;
    }
    if (c === ')') {
      profondita--;
      if (profondita < 0) rifiuta('le parentesi non sono bilanciate');
      continue;
    }
    // La virgola è legittima SOLO fra parentesi (`DECIMAL(10,2)`,
    // `geometry(Point,4326)`, `ENUM('a','b')`). A livello superiore è invece il
    // separatore delle specifiche di un ALTER: `INT, RENAME TO altra_tabella`
    // in un `CHANGE COLUMN` di MySQL sposta la tabella fuori dallo scope, ed è
    // il vettore che sopravvive anche con `multipleStatements:false`.
    if (c === ',') {
      if (profondita === 0) rifiuta('la virgola può comparire solo fra parentesi');
      continue;
    }
    if (c === '[' || c === ']' || c === '.' || c === ' ') continue;
    if (/[A-Za-z0-9_]/.test(c)) continue;

    rifiuta(`il carattere "${c}" non è ammesso in un tipo`);
  }
  if (profondita !== 0) rifiuta('le parentesi non sono bilanciate');

  return s;
}

DbStrategy.assertColumnType = assertColumnType;

// Tetto massimo di righe/documenti restituiti da una lettura. Il default (500)
// preserva il comportamento della griglia paginata; il Query Engine passa un
// `payload.maxRows` più alto per non troncare i risultati di una query
// esplicita. Il ceiling assoluto evita di esaurire la memoria con risultati
// enormi. Usato da tutte le strategie in collectionFind/collectionAggregate.
//
// NB: `maxRows` è un campo RISERVATO AL SERVER — server.js lo rimuove da ogni
// payload che arriva dal client (SERVER_ONLY_PAYLOAD_FIELDS), altrimenti
// chiunque potrebbe alzare il tetto a 100.000 documenti su una normale find.
function resultCap(payload, fallback = 500) {
  const m = parseInt(payload && payload.maxRows, 10);
  if (!Number.isFinite(m) || m < 1) return fallback;
  return Math.min(m, 100000);
}

DbStrategy.resultCap = resultCap;

// Parametri normalizzati di `relatedRows`, uguali per tutte le strategie: il
// pannello delle chiavi esterne è uno solo e non deve comportarsi diversamente
// a seconda del DBMS sotto.
//
// `haValore` è distinto da `valore` di proposito: cercare le righe con la
// colonna a NULL è una richiesta legittima, e `valore == null` da solo non
// permette di distinguerla da "nessun valore richiesto" (che invece elenca
// tutto). Senza la distinzione, aprire il pannello su una cella vuota mostrava
// l'intera tabella spacciandola per la riga riferita.
function relatedRowsParams(payload) {
  const p = payload || {};
  const colonna = String(p.colonna == null ? '' : p.colonna).trim();
  if (!colonna) throw new Error('Manca la colonna di riferimento da interrogare.');
  return {
    colonna,
    valore: p.valore,
    haValore: Object.prototype.hasOwnProperty.call(p, 'valore') && p.valore !== undefined,
    cerca: p.cerca == null ? '' : String(p.cerca).trim(),
    limit: Math.min(Math.max(parseInt(p.limit, 10) || 25, 1), 200),
    skip: Math.max(parseInt(p.skip, 10) || 0, 0),
  };
}

DbStrategy.relatedRowsParams = relatedRowsParams;

// Quante colonne testuali al massimo entrano nella ricerca del pannello di
// riferimento. Una tabella con quaranta colonne di testo produrrebbe quaranta
// LIKE in OR su ogni battuta: la ricerca sarebbe corretta e inutilizzabile.
DbStrategy.MAX_COLONNE_CERCA = 6;

// Neutralizza i metacaratteri di LIKE nel testo cercato (`\` è il carattere di
// escape predefinito sia su MySQL sia su PostgreSQL). Non è una difesa da
// injection — i valori viaggiano come parametri — ma da un'altra sorpresa: chi
// scrive "50%" cerca la stringa "50%", non "tutto ciò che inizia per 50".
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

DbStrategy.escapeLike = escapeLike;

// L'equivalente di `escapeLike` per MongoDB, dove la ricerca del pannello passa
// per `$regex`: senza, chi cerca "S.p.A." otterrebbe un'espressione regolare in
// cui il punto vale "qualsiasi carattere", e una parentesi aperta farebbe
// fallire la query invece di cercare una parentesi.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

DbStrategy.escapeRegex = escapeRegex;

// Budget di memoria per il risultato di una singola lettura. Il tetto sulle
// RIGHE non basta: poche righe con BLOB, testi lunghi o campi JSON estesi
// pesano quanto decine di migliaia di documenti piccoli, e il risultato viene
// poi serializzato in EJSON e messo su socket. Configurabile con
// CODEDB_MAX_RESULT_BYTES; <= 0 disabilita il controllo.
function maxResultBytes() {
  const m = parseInt(process.env.CODEDB_MAX_RESULT_BYTES, 10);
  if (!Number.isFinite(m)) return 32 * 1024 * 1024; // 32 MB
  return Math.max(m, 0);
}

DbStrategy.maxResultBytes = maxResultBytes;

/**
 * Accumula i documenti di un cursore rispettando SIA il tetto sulle righe SIA
 * il budget di byte, interrompendo la lettura appena uno dei due è superato.
 * Fermare il cursore è l'unico modo per proteggere davvero la memoria: troncare
 * a valle presuppone che il risultato sia già stato materializzato per intero.
 *
 * Ritorna `{ docs, truncated }`: `truncated` dice che ci sarebbero altri
 * documenti ma il budget è finito, così il chiamante può segnalarlo alla UI
 * invece di far credere che i dati siano tutti lì.
 */
async function collectCapped(cursor, cap, budget = maxResultBytes()) {
  const docs = [];
  let bytes = 0;
  let truncated = false;
  for await (const doc of cursor) {
    if (docs.length >= cap) { truncated = true; break; }
    if (budget > 0) {
      // Stima grossolana ma sufficiente: l'ordine di grandezza è quello che
      // conta, e il costo è lo stesso della serializzazione che seguirebbe.
      try { bytes += JSON.stringify(doc).length; } catch { bytes += 1024; }
      if (bytes > budget && docs.length) { truncated = true; break; }
    }
    docs.push(doc);
  }
  return { docs, truncated };
}

DbStrategy.collectCapped = collectCapped;

/**
 * Variante per i risultati già materializzati (driver SQL, che restituiscono
 * l'intero result set): tronca la lista al budget di byte. Non evita il picco
 * di memoria del driver — per quello servirebbe lo streaming — ma impedisce di
 * serializzare e spedire su socket un risultato spropositato.
 */
function truncateBySize(rows, budget = maxResultBytes()) {
  if (!budget || !Array.isArray(rows) || !rows.length) return { rows, truncated: false };
  let bytes = 0;
  for (let i = 0; i < rows.length; i++) {
    try { bytes += JSON.stringify(rows[i]).length; } catch { bytes += 1024; }
    if (bytes > budget && i > 0) return { rows: rows.slice(0, i), truncated: true };
  }
  return { rows, truncated: false };
}

DbStrategy.truncateBySize = truncateBySize;

// Tempo massimo (ms) concesso al conteggio esatto disaccoppiato prima di
// arrendersi e riportare un totale sconosciuto. Configurabile via env
// CODEDB_COUNT_TIMEOUT_MS (default 5000); un valore <= 0 disabilita il timeout.
function countTimeoutMs() {
  const m = parseInt(process.env.CODEDB_COUNT_TIMEOUT_MS, 10);
  if (!Number.isFinite(m)) return 5000;
  return Math.max(m, 0);
}

DbStrategy.countTimeoutMs = countTimeoutMs;

// Tempo massimo (ms) concesso a una query di lettura della griglia (find/pagina)
// prima che il server la interrompa, così una scansione lenta (es. OFFSET
// profondo) degrada con un errore invece di tenere occupata una connessione del
// pool all'infinito. Configurabile via env CODEDB_QUERY_TIMEOUT_MS (default
// 30000); un valore <= 0 disabilita il timeout. Usato dalle strategie in
// collectionFind.
function queryTimeoutMs() {
  const m = parseInt(process.env.CODEDB_QUERY_TIMEOUT_MS, 10);
  if (!Number.isFinite(m)) return 30000;
  return Math.max(m, 0);
}

DbStrategy.queryTimeoutMs = queryTimeoutMs;

// Tempo massimo (ms) concesso a un'AGGREGAZIONE di lettura (CDB-17). È distinto
// da queryTimeoutMs perché le due cose hanno tempi legittimi diversi: una pagina
// di griglia che impiega più di 30 s è quasi sempre un problema, mentre un
// $group su una collection grande può ragionevolmente durare qualche minuto ed
// è esattamente ciò per cui esiste il Query Engine. Senza alcun limite, però,
// una pipeline pesante tiene occupata una connessione del pool a tempo
// indefinito, e `cancelQuery` la ferma solo se il client ha mandato un runId e
// l'utente del database ha il privilegio killOp — spesso assente.
// Env CODEDB_AGGREGATE_TIMEOUT_MS (default 120000); <= 0 disabilita.
function aggregateTimeoutMs() {
  const m = parseInt(process.env.CODEDB_AGGREGATE_TIMEOUT_MS, 10);
  if (!Number.isFinite(m)) return 120000;
  return Math.max(m, 0);
}

DbStrategy.aggregateTimeoutMs = aggregateTimeoutMs;

module.exports = DbStrategy;
