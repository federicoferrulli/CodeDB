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

  /** @returns {Promise<{stats, indexes, fields, sampled}>} */
  async collectionStats(_db, _coll) { throw unsupported(); }

  /** @returns {Promise<{collections, relations}>} per la vista UML. */
  async dbSchema(_db) { throw unsupported(); }

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

  /**
   * Aggiornamento di massa: payload = { filter, set } (per il gateway MCP).
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
function detectRelations(collections) {
  const byName = new Map();
  for (const c of collections) {
    const low = c.name.toLowerCase();
    byName.set(low, c.name);
    byName.set(singular(low), c.name);
  }
  const resolve = (base) => byName.get(base) || byName.get(base + 's') || byName.get(singular(base));

  const relations = [];
  for (const c of collections) {
    for (const f of c.fields) {
      if (f.name === '_id') continue;
      const low = f.name.toLowerCase();
      const m = low.match(/^(.+?)_?ids?$/);
      if (!m && !f.types.includes('objectId')) continue;
      const base = m ? m[1] : low;
      const target = resolve(base);
      if (!target || target === c.name) continue;
      relations.push({
        from: c.name,
        field: f.name,
        to: target,
        many: f.types.includes('array') || /ids$/.test(low),
      });
    }
  }
  return relations;
}

DbStrategy.detectRelations = detectRelations;
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
