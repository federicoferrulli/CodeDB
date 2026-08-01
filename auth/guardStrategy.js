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
  METHOD_CAPABILITY, CAPABILITY_LABEL, isWriteSql, isWriteMongoPipeline,
  matchesAny, shellWriteCapability,
} = require('./capabilities');
const { can, scopeFor } = require('./permissions');
const { assertScopedClauses } = require('./sqlClause');

function denied(capability, connName, db, coll) {
  const label = CAPABILITY_LABEL[capability] || capability;
  const target = [db, coll].filter(Boolean).join('.');
  return new Error(
    `Permesso negato: operazione di ${label}${target ? ` su "${target}"` : ''}` +
    `${connName ? ` nella connessione "${connName}"` : ''}. Contatta l'amministratore del tuo account.`
  );
}

function resolveCapability(spec, strategy, args) {
  if (spec.cap !== 'dynamic') return spec.cap;
  const payload = args[2] || {};
  // Scritture della shell da uno script: la capability dipende dall'operazione
  // richiesta (insert/update = write, delete = delete).
  if (spec.kind === 'shellWrite') return shellWriteCapability(payload.op);
  // collection:aggregate = SQL Raw su MySQL/PostgreSQL, pipeline su MongoDB:
  // stessa logica di classifyAudit, così audit e permessi non divergono mai.
  const isSql = strategy.type && strategy.type !== 'mongodb';
  const write = isSql ? isWriteSql(payload.pipeline) : isWriteMongoPipeline(payload.pipeline);
  return write ? 'write' : 'read';
}

function filterResult(kind, result, scope) {
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
    const relations = (result.relations || []).filter((r) => visible.has(r.from) && visible.has(r.to));
    return { ...result, collections, relations };
  }
  return result;
}

/**
 * @param {import('../db/DbStrategy')} strategy
 * @param {{ principal: object, connName: string|null }|null} ctx
 * @returns la strategia stessa (RBAC spento) oppure un Proxy che autorizza ogni chiamata
 */
function guardStrategy(strategy, ctx) {
  if (!strategy || !ctx || !ctx.principal || ctx.principal.root) return strategy;
  const { principal, connName = null } = ctx;

  return new Proxy(strategy, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      const spec = typeof prop === 'string' ? METHOD_CAPABILITY[prop] : null;
      if (!spec || typeof value !== 'function') {
        // Proprietà (type, currentDb, client, pool…) e metodi non classificati
        // (connect, disconnect, health, cancelQuery, unwatch…) passano invariati,
        // con `this` legato alla strategia reale.
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return function guarded(...args) {
        const capability = resolveCapability(spec, target, args);
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

        if (!can(principal, { connName, capability, db, coll })) return refuse(capability, db, coll);
        // Rename: anche la destinazione deve rientrare nello scope, altrimenti
        // si potrebbe spostare un oggetto fuori dal proprio perimetro.
        if (spec.db2 != null && !can(principal, { connName, capability, db: args[spec.db2] })) {
          return refuse(capability, args[spec.db2], null);
        }
        if (spec.coll2 != null && !can(principal, { connName, capability, db, coll: args[spec.coll2] })) {
          return refuse(capability, db, args[spec.coll2]);
        }

        // Su MySQL/PostgreSQL `filter` e `sort` della griglia sono frammenti di
        // SQL grezzo: lo scope protegge il NOME della tabella, non il testo della
        // query, quindi da lì si può leggere (a oracolo) fuori dal proprio
        // perimetro. Per i soli principal con uno scope attivo si pretende la
        // forma strutturata; per owner e sottoutenti senza scope nulla cambia.
        if (target.type && target.type !== 'mongodb' && scopeFor(principal, connName)) {
          try {
            assertScopedClauses(args[2]);
          } catch (err) {
            return spec.sync ? (() => { throw err; })() : Promise.reject(err);
          }
        }

        // Barriera indipendente dal parser: quando un SQL Raw è stato
        // classificato come LETTURA e chi lo esegue è un sottoutente, lo si fa
        // girare in una transazione di sola lettura (PostgreSqlStrategy legge
        // `expectRead`). Se la classificazione dovesse comunque sbagliarsi, è il
        // MOTORE a rifiutare la scrittura. Non si applica all'owner: una SELECT
        // che invoca una funzione con effetti collaterali, una tabella
        // temporanea o un SET di sessione sono casi rari ma legittimi, e
        // continuano a funzionare come oggi.
        if (spec.cap === 'dynamic' && capability === 'read' && !principal.owner && args[2] && typeof args[2] === 'object') {
          args[2].expectRead = true;
        }

        const out = value.apply(target, args);
        if (!spec.filter) return out;
        const scope = scopeFor(principal, connName);
        if (!scope) return out;
        return out && typeof out.then === 'function'
          ? out.then((res) => filterResult(spec.filter, res, scope))
          : filterResult(spec.filter, out, scope);
      };
    },
    set(target, prop, value) {
      // Il Query Engine scrive strategy.currentDb: deve continuare a funzionare.
      target[prop] = value;
      return true;
    },
  });
}

module.exports = { guardStrategy };
