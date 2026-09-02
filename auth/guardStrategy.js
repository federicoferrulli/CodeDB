'use strict';

/* ---------------------------------------------------------------------------
 * Proxy autorizzante sulle strategie di database.
 *
 * È il punto di applicazione dell'RBAC: qualunque accesso ai dati — griglia,
 * Query Engine, Virtual JOIN, tool MCP — passa da un metodo di DbStrategy, e
 * `establishConnection()` restituisce la strategia già avvolta. Aggiungere un
 * nuovo handler socket o un nuovo tool MCP non può quindi aprire un buco:
 * il controllo è a valle di tutti.
 *
 * Nota: il motore di backup accede al driver nativo (`strategy.client` /
 * `strategy.pool`), che il Proxy lascia passare invariato. Gli eventi
 * `backup:run`/`backup:restore` sono perciò autorizzati a parte in server.js
 * (canWholeConnection), dove si può pretendere l'assenza di scope.
 *
 * Le liste di navigazione (listDatabases/listCollections/search/dbSchema) non
 * vengono negate ma **filtrate**: la sidebar mostra spontaneamente solo ciò che
 * l'utente può vedere, senza modifiche al frontend.
 * ------------------------------------------------------------------------- */

const {
  METHOD_CAPABILITY, CAPABILITY_LABEL, DDL_AUTH_CAPABILITIES, SQL_DDL_AUTHORIZED,
  analyzeSql, isFileIoSql,
  analyzeMongoPipeline, assertNoMongoServerJs, matchesAny, shellWriteCapabilities,
} = require('./capabilities');
const { can, scopeFor } = require('./permissions');
const { assertScopedClauses } = require('./sqlClause');
// La validazione strutturale del filtro: vedi db/filtro.js.
const { normalizzaFiltro } = require('../db/filtro');
const { normalizzaRicerca } = require('../db/ricercaGlobale');
const { assertTabelleNelloScope } = require('./sqlTables');
// Il messaggio del batch vuoto è uno solo: era scritto in tre punti diversi.
const { MESSAGGIO_BATCH_VUOTO } = require('../db/sqlWriteBatch');

function denied(capability, connName, db, coll) {
  const label = CAPABILITY_LABEL[capability] || capability;
  const target = [db, coll].filter(Boolean).join('.');
  return new Error(
    `Permesso negato: operazione di ${label}${target ? ` su "${target}"` : ''}` +
    `${connName ? ` nella connessione "${connName}"` : ''}. Contatta l'amministratore del tuo account.`
  );
}

function resolveAuthorization(spec, strategy, args) {
  if (spec.cap !== 'dynamic') return { capabilities: [spec.cap] };
  const payload = args[2] || {};
  // Scritture della shell da uno script: findOneAndUpdate/Delete restituiscono
  // anche il documento e richiedono read oltre alla capability mutativa.
  if (spec.kind === 'shellWrite') {
    return { capabilities: shellWriteCapabilities(payload.op) };
  }
  if (spec.kind === 'sqlWriteBatch') {
    if (!strategy.type || strategy.type === 'mongodb') {
      throw new Error('Il batch SQL transazionale è disponibile solo su MySQL e PostgreSQL.');
    }
    const statements = args[1];
    if (!Array.isArray(statements) || statements.length === 0) {
      throw new Error(MESSAGGIO_BATCH_VUOTO);
    }
    const sqlBatch = statements.map((statement) => ({
      statement: String(statement || ''),
      analysis: analyzeSql(statement),
    }));
    const capabilities = ['read', 'write', 'delete', 'ddl'].filter((capability) =>
      sqlBatch.some(({ analysis }) => analysis.capabilities.includes(capability)));
    return { capabilities, sqlBatch };
  }
  // collection:aggregate = SQL Raw su MySQL/PostgreSQL, pipeline su MongoDB:
  // stessa logica di classifyAudit, così audit e permessi non divergono mai.
  const isSql = strategy.type && strategy.type !== 'mongodb';
  if (isSql) {
    const sql = analyzeSql(payload.pipeline);
    // Solo execute_ddl puo' applicare questo Symbol, dopo aver validato un
    // singolo comando di schema. SQL Raw ordinario mantiene invece tutte le
    // capability dedotte (read compresa) e non eredita la deroga del tool.
    if (payload[SQL_DDL_AUTHORIZED] === true) {
      return { capabilities: [], anyCapabilities: DDL_AUTH_CAPABILITIES, sql };
    }
    return {
      capabilities: sql.capabilities,
      sql,
    };
  }
  const mongoPipeline = analyzeMongoPipeline(payload.pipeline);
  return {
    // Anche $out/$merge leggono la collection sorgente: write non deve mai
    // diventare una scorciatoia per estrarre dati senza read.
    capabilities: mongoPipeline.write ? ['read', 'write'] : ['read'],
    mongoPipeline,
  };
}

/**
 * I campi di ogni metodo in cui può nascondersi un operatore che fa eseguire
 * JavaScript al server MongoDB.
 *
 * `filtro` — il filtro STRUTTURATO — sta accanto a `filter` e non al suo posto:
 * i suoi *nomi di campo* sono già protetti da `normalizzaFiltro` (un segmento
 * che comincia per `$` è rifiutato), ma i suoi VALORI no. Un
 * `{ campo: '_id', operatore: 'uguale', valore: { $where: 'return true' } }`
 * porterebbe l'operatore dentro il documento reso. Era la difesa che il metodo
 * separato delle righe riferite applicava sul proprio `valore`: tolto quello,
 * la superficie è questa.
 */
const MONGO_SERVER_JS_FIELDS = {
  collectionFind: ['filter', 'filtro'],
  collectionCount: ['filter', 'filtro'],
  collectionAggregate: ['pipeline', 'filtro'],
  collectionExplain: ['filter', 'pipeline', 'filtro'],
  collectionUpdateMany: ['filter', 'filtro'],
  collectionDeleteMany: ['filter', 'filtro'],
  shellWrite: ['filter', 'update'],
};

function assertSafeMongoFieldPath(value, label = 'Campo MongoDB') {
  const path = String(value == null ? '' : value).trim();
  const segments = path.split('.');
  if (!path || path.includes('\0') || segments.some((segment) => !segment || segment.startsWith('$'))) {
    throw new Error(`${label}: percorso non valido; non usare segmenti vuoti, NUL o il prefisso $.`);
  }
  return path;
}

function validateMongoOperation(method, payload, authorization) {
  const fields = MONGO_SERVER_JS_FIELDS[method] || [];
  for (const field of fields) {
    if (payload[field] != null && payload[field] !== '') {
      assertNoMongoServerJs(payload[field], field === 'pipeline' ? 'Pipeline MongoDB' : 'Filtro MongoDB');
    }
  }
  if (method === 'collectionExplain' && payload.mode === 'aggregate') {
    const analysis = analyzeMongoPipeline(payload.pipeline);
    if (analysis.write) {
      throw new Error('Gli stage $out e $merge non sono consentiti nel piano di esecuzione.');
    }
    authorization.mongoPipeline = analysis;
  }
  return authorization && authorization.mongoPipeline;
}

const listaScopeIllimitata = (patterns) =>
  !Array.isArray(patterns) || patterns.length === 0 || patterns.includes('*');

function scopeEffettivamenteLimitato(scope) {
  return !!scope
    && (!listaScopeIllimitata(scope.databases) || !listaScopeIllimitata(scope.collections));
}

function filterResult(kind, result, scope, currentDb) {
  if (!scope || !result) return result;
  const dbOk = (name) => matchesAny(scope.databases, name);
  const collOk = (name) => matchesAny(scope.collections, name);

  if (kind === 'databases') {
    return Array.isArray(result) ? result.filter((d) => dbOk(d && d.name)) : result;
  }
  if (kind === 'collections') {
    return Array.isArray(result) ? result.filter((c) => collOk(c && c.name)) : result;
  }
  if (kind === 'search') {
    if (!Array.isArray(result)) return result;
    return result
      .filter((d) => dbOk(d && d.name))
      .map((d) => ({ ...d, collections: (d.collections || []).filter((c) => collOk(c && c.name)) }));
  }
  if (kind === 'schema') {
    if (!result || !Array.isArray(result.collections)) return result;
    const collections = result.collections.filter((c) => collOk(c && c.name));
    const visible = new Set(collections.map((c) => c.name));
    const relations = (result.relations || []).filter((r) => {
      const targetDb = r && (r.db ?? r.toDb ?? r.targetDb ?? currentDb);
      return visible.has(r && r.from) && visible.has(r && r.to)
        && targetDb != null && dbOk(targetDb) && collOk(r.to);
    });
    return { ...result, collections, relations };
  }
  if (kind === 'relations') {
    if (!Array.isArray(result)) return result;
    return result.filter((r) => {
      const targetDb = r && (r.db ?? r.toDb ?? r.targetDb ?? currentDb);
      const targetColl = r && (r.tabella ?? r.to);
      return targetDb != null && targetColl != null
        && dbOk(targetDb) && collOk(targetColl);
    });
  }
  return result;
}

/**
 * @param {import('../db/DbStrategy')} strategy
 * @param {{ principal: object, connName: string|null }|null} ctx
 * @returns la strategia stessa senza contesto oppure un Proxy che autorizza ogni chiamata
 */
function guardStrategy(strategy, ctx) {
  if (!strategy || !ctx || !ctx.principal) return strategy;

  return new Proxy(strategy, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      const spec = typeof prop === 'string' ? METHOD_CAPABILITY[prop] : null;

      // Proprietà (type, currentDb, client, pool…): il motore di backup legge
      // il driver nativo da qui, ed è autorizzato a parte sull'intera
      // connessione (canWholeConnection in server.js).
      if (typeof value !== 'function') return value;

      // Metodo con una voce che DICHIARA di non essere un'operazione sui dati
      // (connect, disconnect, health, cancelQuery, unwatch, aiuti interni…):
      // passa invariato, con `this` legato alla strategia reale.
      if (spec && !spec.cap) return value.bind(target);

      // Metodo di cui nessuno ha detto niente: NEGATO.
      //
      // È il verso opposto rispetto a prima, quando ciò che non si trovava
      // passava. La leva del Proxy — «aggiungere un handler o un tool non può
      // aprire un buco» — era quindi vera solo per i metodi che qualcuno si era
      // ricordato di classificare, cioè era quasi vera. L'inversione si può
      // fare perché la tabella è completa, e un test statico
      // (test/unit-tabella-autorizzazioni.js) la tiene completa: aggiungere un
      // metodo a una strategia rompe quel test PRIMA di arrivare qui.
      if (!spec) {
        return function metodoNonClassificato() {
          throw new Error(
            `Operazione non consentita: il metodo "${String(prop)}" non è classificato ` +
            'fra le operazioni che questa connessione autorizza. ' +
            'Cosa fare: se è un\'operazione legittima, va dichiarata in ' +
            'METHOD_CAPABILITY (auth/capabilities.js) con la capability che richiede, ' +
            'o con il motivo per cui non ne richiede nessuna.'
          );
        };
      }
      return function guarded(...args) {
        // Il principal resta nel contesto MUTABILE della sessione: una
        // rivalidazione può sostituirlo e il Proxy vede subito grant e scope
        // nuovi, senza riaprire la connessione al database.
        const principal = ctx.principal;
        const connName = ctx.connName || null;
        // `undefined` quando il metodo NON ha un bersaglio (listDatabases,
        // search, watchSchema): `can()` salta il confronto con lo scope, che per
        // quelle operazioni è comunque applicato filtrando i RISULTATI. Passare
        // `null` le avrebbe fatte negare, lasciando la sidebar vuota proprio
        // agli utenti che lo scope dovrebbe servire.
        const db = spec.db != null ? args[spec.db] : undefined;
        const coll = spec.coll != null ? args[spec.coll] : undefined;
        // I metodi della strategia sono asincroni e chi li chiama può usarne
        // direttamente la promise (`strategy.dropCollection(...).catch(...)` in
        // backup/lib/restore.js): il rifiuto deve quindi essere una promise
        // rigettata, non un throw sincrono, o si perderebbe il catch.
        const refuse = (c, d, k) => (spec.sync ? (() => { throw denied(c, connName, d, k); })() : Promise.reject(denied(c, connName, d, k)));
        const reject = (err) => (spec.sync ? (() => { throw err; })() : Promise.reject(err));

        if (!principal) return reject(new Error('Sessione non più autorizzata.'));
        let authorization;
        try {
          authorization = resolveAuthorization(spec, target, args);
          if (authorization.sql && authorization.sql.executableComment) {
            throw new Error('I commenti SQL eseguibili /*! … */ e /*M! … */ non sono consentiti in SQL Raw.');
          }
          if (authorization.sql && authorization.sql.multipleStatements) {
            throw new Error('Più istruzioni SQL nello stesso SQL Raw non sono consentite: usa lo ScriptRunner.');
          }
          if (authorization.sqlBatch) {
            for (const { analysis } of authorization.sqlBatch) {
              if (analysis.executableComment) {
                throw new Error('I commenti SQL eseguibili non sono consentiti nel batch SQL.');
              }
              if (analysis.multipleStatements) {
                throw new Error('Ogni elemento del batch SQL deve contenere un solo statement.');
              }
              const mutativa = analysis.capabilities.some((capability) =>
                capability === 'write' || capability === 'delete');
              if (!mutativa || analysis.capabilities.some((capability) =>
                !['read', 'write', 'delete'].includes(capability))) {
                throw new Error('Il batch SQL ammette solo INSERT, UPDATE, DELETE o REPLACE (niente DDL).');
              }
            }
          }
          // Il filtro STRUTTURATO si valida sempre, per chiunque e su ogni
          // motore: un nome di campo che comincia per `$` o un segmento vuoto
          // non sono un permesso negato, sono un'INVARIANTE — su MongoDB quel
          // nome diventerebbe un operatore. Vale quindi anche per root, come
          // già valgono le altre invarianti di questo Proxy, e vale PRIMA di
          // toccare il database invece che dentro l'adattatore.
          if (args[2] && args[2].filtro != null) normalizzaFiltro(args[2].filtro);
          if (args[2] && args[2].cercaOvunque != null) normalizzaRicerca(args[2].cercaOvunque);
          if (target.type === 'mongodb') {
            validateMongoOperation(String(prop), args[2] || {}, authorization);
          }
        } catch (err) {
          return reject(err);
        }

        const capabilities = authorization.capabilities;
        let missing = capabilities.find((capability) =>
          !can(principal, { connName, capability, db, coll }));
        if (!missing && authorization.anyCapabilities
            && !authorization.anyCapabilities.some((capability) =>
              can(principal, { connName, capability, db, coll }))) {
          missing = authorization.anyCapabilities[0];
        }
        if (missing) return refuse(missing, db, coll);
        // Rename: anche la destinazione deve rientrare nello scope, altrimenti
        // si potrebbe spostare un oggetto fuori dal proprio perimetro.
        const primaryCapability = capabilities[capabilities.length - 1];
        if (spec.db2 != null && !can(principal, { connName, capability: primaryCapability, db: args[spec.db2] })) {
          return refuse(primaryCapability, args[spec.db2], null);
        }
        if (spec.coll2 != null && !can(principal, { connName, capability: primaryCapability, db, coll: args[spec.coll2] })) {
          return refuse(primaryCapability, db, args[spec.coll2]);
        }

        // Le pipeline possono leggere altre collection anche in rami annidati
        // ($lookup/$graphLookup/$unionWith dentro $facet o sub-pipeline). Ogni
        // sorgente nominata deve avere read nel proprio scope.
        if (authorization.mongoPipeline) {
          for (const source of authorization.mongoPipeline.readTargets || []) {
            const sourceDb = source.db == null ? db : source.db;
            if (!source.coll) {
              return reject(new Error(
                'Sorgente ' + source.operator + ' non valida: manca il nome della collection.'
              ));
            }
            if (!can(principal, {
              connName,
              capability: 'read',
              db: sourceDb,
              coll: source.coll,
            })) {
              return refuse('read', sourceDb, source.coll);
            }
          }
        }

        // $out/$merge autorizzano sia l'origine sia la DESTINAZIONE. Il target
        // arriva dalla pipeline EJSON già decodificata, quindi anche
        // \u0024out/\u0024merge attraversano questo controllo.
        if (authorization.mongoPipeline && authorization.mongoPipeline.write) {
          for (const destination of authorization.mongoPipeline.targets) {
            const targetDb = destination.db == null ? db : destination.db;
            if (!destination.coll) {
              return reject(new Error(`Destinazione ${destination.operator} non valida: manca il nome della collection.`));
            }
            // `$merge` aggiorna/inserisce documenti; `$out` sostituisce invece
            // integralmente la collection destinazione. Per `$out` la sola
            // capability write non basta: serve anche delete sul BERSAGLIO.
            const targetCapabilities = destination.operator === '$out'
              ? ['write', 'delete']
              : ['write'];
            for (const capability of targetCapabilities) {
              if (!can(principal, {
                connName,
                capability,
                db: targetDb,
                coll: destination.coll,
              })) {
                return refuse(capability, targetDb, destination.coll);
              }
            }
          }
        }

        // Su MySQL/PostgreSQL `filter` e `sort` della griglia sono frammenti di
        // SQL grezzo: lo scope protegge il NOME della tabella, non il testo della
        // query, quindi da lì si può leggere (a oracolo) fuori dal proprio
        // perimetro. Per i soli principal con uno scope attivo si pretende la
        // forma strutturata; per owner e sottoutenti senza scope nulla cambia.
        const activeScope = target.type && target.type !== 'mongodb'
          ? scopeFor(principal, connName)
          : null;
        if (scopeEffettivamenteLimitato(activeScope)) {
          try {
            // Un batch e' SEMPRE negato a chi ha un ambito limitato, come lo
            // e' gia' l'SQL Raw singolo e per la stessa ragione: view,
            // funzioni e dipendenze indirette non sono verificabili in modo
            // completo, e qui gli statement sono molti. Il rifiuto e'
            // incondizionato, quindi NON si passa dal parser delle tabelle:
            // chiamarlo prima di un throw che ignora il suo esito faceva
            // sembrare che il permesso dipendesse da lui.
            if (authorization.sqlBatch) {
              throw new Error(
                'Batch SQL non consentito con un ambito limitato: view, funzioni e dipendenze ' +
                'indirette non sono verificabili in modo completo su un blocco di istruzioni. ' +
                'Esegui le mutazioni una alla volta con i comandi strutturati, oppure chiedi ' +
                'un grant senza limiti di ambito.'
              );
            }
            // Il parser delle tabelle copre DML e letture, ma non può provare
            // in modo affidabile tutti i bersagli del DDL libero (DATABASE,
            // SCHEMA, VIEW, ROLE/USER, FUNCTION, EXTENSION, GRANT/REVOKE,
            // rename multipli…). Con uno scope attivo si chiude quindi il ramo
            // SQL Raw: il DDL resta disponibile tramite le operazioni
            // strutturate della UI, dove origine e destinazione sono esplicite.
            if (authorization.sql && args[2] && typeof args[2] === 'object'
                && args[2].pipeline != null) {
              // Prima conserva il dettaglio sui nomi esplicitamente fuori
              // scope; poi nega comunque, perché view e funzioni possono avere
              // dipendenze invisibili al parser dei nomi.
              assertTabelleNelloScope(args[2].pipeline, activeScope, args[0]);
              throw new Error(
                'SQL Raw non consentito con un ambito limitato: view, funzioni e dipendenze ' +
                'indirette non sono verificabili in modo completo. Usa griglia, filtri e ' +
                'comandi strutturati della UI oppure ' +
                'chiedi un grant senza limiti di ambito.'
              );
            }
            assertScopedClauses(args[2]);
            // SQL Raw: lo scope era confrontato con un bersaglio DEDOTTO (una
            // regex sul primo FROM, o il `coll` scelto dal client quando il FROM
            // non c'era), mentre la stringa veniva eseguita verbatim — le
            // strategie SQL ignorano l'argomento `coll`. Bastava una JOIN per
            // leggere fuori perimetro, o una UPDATE senza FROM per scriverci.
            // Qui si guardano i nomi CITATI nella query (CDB-A03).
            if (args[2] && typeof args[2] === 'object' && args[2].pipeline != null) {
              assertTabelleNelloScope(args[2].pipeline, activeScope, args[0]);
            }
          } catch (err) {
            return spec.sync ? (() => { throw err; })() : Promise.reject(err);
          }
        }

        // I/O su file dell'host del DBMS (INTO OUTFILE/DUMPFILE, LOAD DATA/XML,
        // LOAD_FILE): non è un'operazione sui dati della connessione, quindi
        // nessuna capability la autorizza per un sottoutente — con `write` si
        // scriverebbe comunque FUORI dal perimetro dello scope, sul filesystem
        // del server di database, e la transazione READ ONLY non lo impedisce
        // (scrivere un file non è una scrittura transazionale).
        //
        // Si guardano tutti e tre i campi di SQL grezzo, non il solo `pipeline`
        // di SQL Raw: su MySQL `… WHERE 1 INTO OUTFILE '/tmp/x'` è sintassi
        // valida, quindi anche la casella "filtro" della griglia è una porta.
        //
        // L'owner resta libero: sulla propria macchina un export via OUTFILE è
        // un uso legittimo, ed è la stessa scelta già fatta per `expectRead`.
        if (!principal.root && !principal.owner && target.type && target.type !== 'mongodb'
            && args[2] && typeof args[2] === 'object'
            && [args[2].pipeline, args[2].filter, args[2].sort].some((t) => t && isFileIoSql(t))) {
          const err = new Error(
            'Permesso negato: questa istruzione legge o scrive un file sul server del database ' +
            '(INTO OUTFILE/DUMPFILE, LOAD DATA/XML, LOAD_FILE, COPY o funzioni file PostgreSQL) ' +
            'e non sui dati della connessione. ' +
            'Cosa fare: per portare fuori dei dati usa l\'esportazione della griglia o un backup.'
          );
          return spec.sync ? (() => { throw err; })() : Promise.reject(err);
        }

        // Barriera indipendente dal parser: quando un SQL Raw è stato
        // classificato come LETTURA e chi lo esegue è un sottoutente, lo si fa
        // girare in una transazione di sola lettura (PostgreSqlStrategy legge
        // `expectRead`). Se la classificazione dovesse comunque sbagliarsi, è il
        // MOTORE a rifiutare la scrittura. Non si applica all'owner: una SELECT
        // che invoca una funzione con effetti collaterali, una tabella
        // temporanea o un SET di sessione sono casi rari ma legittimi, e
        // continuano a funzionare come oggi.
        if (!principal.root && !principal.owner && authorization.sqlBatch
            && authorization.sqlBatch.some(({ statement }) => isFileIoSql(statement))) {
          return reject(new Error(
            'Permesso negato: il batch contiene I/O su file del server del database, non sui dati della connessione.'
          ));
        }

        if (authorization.sql && capabilities.length === 1 && capabilities[0] === 'read'
            && !principal.root && !principal.owner && args[2] && typeof args[2] === 'object') {
          args[2].expectRead = true;
        }

        const out = value.apply(target, args);
        if (!spec.filter) return out;
        const scope = scopeFor(principal, connName);
        if (!scope) return out;
        return out && typeof out.then === 'function'
          ? out.then((res) => filterResult(spec.filter, res, scope, args[0]))
          : filterResult(spec.filter, out, scope, args[0]);
      };
    },
    set(target, prop, value) {
      // Il Query Engine scrive strategy.currentDb: deve continuare a funzionare.
      target[prop] = value;
      return true;
    },
  });
}

module.exports = { guardStrategy, scopeEffettivamenteLimitato };
