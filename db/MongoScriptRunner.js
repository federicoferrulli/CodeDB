'use strict';
const { OGGETTO_HOST, FUNZIONE_SCRIPT, FUNZIONE_NATIVA, CURSORE } = require('./mongoScriptValori');

/**
 * CodeDB — Valutatore degli script MongoDB e oggetti `db` dello script
 *
 * `MongoScript.js` conosce il LINGUAGGIO (lessico, sintassi, whitelist dei
 * valori). Qui si esegue l'AST e si espone il database.
 *
 * Due principi che spiegano quasi tutte le scelte di questo file:
 *
 * 1. **Ogni accesso al database passa dall'`host`**, che `server.js` costruisce
 *    sopra la strategia della sessione. La strategia è già avvolta nel Proxy
 *    autorizzante, quindi l'RBAC vale per ogni riga di script senza controlli
 *    dedicati qui — e non può essere aggirato aggiungendo un metodo nuovo.
 *
 * 2. **Tutto ha un budget.** Lo script gira dentro il processo CodeDB: un
 *    `while (true)`, una ricorsione infinita o un ciclo che scrive un milione
 *    di documenti devono fermare sé stessi. Passi, iterazioni, tempo, chiamate
 *    al database e righe di output sono tutti limitati, e il superamento è un
 *    errore chiaro, non un blocco.
 */

const {
  parse, getMember, aEjson, aEjsonStr, semplifica, testo, verita,
  costruisciGlobali, errore, assertRegexSicura, tokenize, NOMI_VIETATI,
} = require('./MongoScript');
const VOCABOLARIO_COSTRUTTORI = require('../public/js/costruttori-bson');
const { opzioniLettura } = require('./mongoOpzioni');
const COSTRUTTORI_CON_NEW = new Set(VOCABOLARIO_COSTRUTTORI.conNew);

/**
 * Errore di superamento di un BUDGET. È marcato perché `try/catch` dello script
 * non deve poterlo catturare: un ciclo infinito avvolto in un try/catch
 * continuerebbe a girare per sempre, che è esattamente ciò da cui il budget
 * dovrebbe proteggere.
 */
function errBudget(msg) {
  const err = errore(msg);
  err.budget = true;
  return err;
}

const LIMITI_DEFAULT = {
  passi: 2000000,        // nodi valutati
  iterazioni: 1000000,   // giri di ciclo complessivi
  profondita: 100,       // annidamento delle chiamate (ricorsione)
  tempoMs: 60000,        // durata massima dello script
  chiamateDb: 5000,      // operazioni sul database
  output: 1000,          // righe di print conservate
  docPerLettura: 10000,  // documenti materializzati da una singola find
  // Memoria che un valore dello script può arrivare a occupare (CDB-65).
  // Gli altri budget contano OPERAZIONI, e nessuno di essi ferma
  // un'allocazione singola: `'x'.repeat(5e8)` è un passo solo, e
  // `for (let i=0;i<26;i++) a = a.concat(a)` sono ventisei giri di ciclo che
  // esauriscono l'heap in meno di mezzo secondo. Il processo Node muore, e con
  // esso cadono le sessioni di TUTTI gli utenti: uno script non deve poter
  // fermare il server, esattamente come non deve poterlo fare un `while(true)`.
  memoriaBytes: 50 * 1024 * 1024,
  regexTempoMs: 250,
  regexTesto: 5000,
  regexPattern: 1000,
};

// Env CODEDB_SCRIPT_MAX_BYTES: <= 0 disabilita il controllo (installazione
// mono-utente che sa cosa sta facendo).
function limiteMemoria() {
  const m = parseInt(process.env.CODEDB_SCRIPT_MAX_BYTES, 10);
  if (!Number.isFinite(m)) return LIMITI_DEFAULT.memoriaBytes;
  return Math.max(m, 0);
}

/* --------------------------------------------------------------------------
 * Completion record: come si propagano return/break/continue senza eccezioni.
 * ------------------------------------------------------------------------ */
const NORMALE = { tipo: 'normale' };
const BREAK = { tipo: 'break' };
const CONTINUE = { tipo: 'continue' };
const ritorno = (valore) => ({ tipo: 'return', valore });

/* --------------------------------------------------------------------------
 * Scope
 * ------------------------------------------------------------------------ */

class Scope {
  constructor(padre = null) {
    this.vars = new Map();
    this.padre = padre;
  }
  dichiara(nome, valore, costante = false) {
    this.vars.set(nome, { valore, costante });
  }
  trova(nome) {
    let s = this;
    while (s) {
      if (s.vars.has(nome)) return s.vars.get(nome);
      s = s.padre;
    }
    return null;
  }
  assegna(nome, valore) {
    const cella = this.trova(nome);
    if (!cella) throw errore(`Variabile non dichiarata: "${nome}"`);
    if (cella.costante) throw errore(`Assegnamento a una costante: "${nome}"`);
    cella.valore = valore;
  }
}

/* ==========================================================================
 * Oggetti del database esposti allo script
 * ========================================================================== */

/**
 * `db` dello script. L'accesso a una proprietà qualsiasi restituisce una
 * collezione (`db.utenti`), come nella shell; i nomi che coincidono con un
 * metodo di database hanno la precedenza (`db.getCollectionNames()`).
 */
function creaDb(ctx, nomeDb) {
  const metodi = {
    getName: chiamabile('getName', () => risolviDb(ctx, nomeDb)),
    aggregate: chiamabile('aggregate', (pipeline, options) => creaCursore(ctx, risolviDb(ctx, nomeDb), null, { pipeline, options })),
    getMongo: chiamabile('getMongo', () => ({ [OGGETTO_HOST]: true, __get(name) {
      if (name === 'startSession') return chiamabile(name, options => creaSessione(ctx, options));
      throw errore(`Metodo di connessione MongoDB sconosciuto: ${name}.`);
    } })),
    runCommand: chiamabile('runCommand', command => ctx.host.command(risolviDb(ctx, nomeDb), aEjsonStr(command))),
    adminCommand: chiamabile('adminCommand', command => ctx.host.command('admin', aEjsonStr(command))),
    getCollectionInfos: chiamabile('getCollectionInfos', async (filter = {}, nameOnly = false, authorizedCollections = false) =>
      ctx.host.collectionInfos(risolviDb(ctx, nomeDb), { filter: aEjsonStr(filter), nameOnly, authorizedCollections })),
    stats: chiamabile('stats', (scale = 1) => ctx.host.command(risolviDb(ctx, nomeDb), aEjsonStr({ dbStats: 1, scale }))),
    version: chiamabile('version', async () => (await ctx.host.command('admin', '{"buildInfo":1}')).version),
    hello: chiamabile('hello', () => ctx.host.command('admin', '{"hello":1}')),
    getSiblingDB: chiamabile('getSiblingDB', (nome) => creaDb(ctx, String(nome))),
    getCollection: chiamabile('getCollection', (nome) => creaCollezione(ctx, nomeDb, String(nome))),
    getCollectionNames: chiamabile('getCollectionNames', async () => {
      const elenco = await ctx.host.listCollections(risolviDb(ctx, nomeDb));
      return (elenco || []).map((c) => (typeof c === 'string' ? c : c.name));
    }),
    createCollection: chiamabile('createCollection', async (nome, options = {}) => {
      await ctx.host.createCollection(risolviDb(ctx, nomeDb), String(nome), aEjson(options));
      return { ok: 1 };
    }),
    dropDatabase: chiamabile('dropDatabase', async () => {
      await ctx.host.dropDatabase(risolviDb(ctx, nomeDb));
      return { ok: 1 };
    }),
  };

  return {
    [OGGETTO_HOST]: true,
    __nome: 'db',
    __get(chiave) {
      if (Object.prototype.hasOwnProperty.call(metodi, chiave)) return metodi[chiave];
      return creaCollezione(ctx, nomeDb, chiave);
    },
  };
}

async function creaSessione(ctx, options = {}) {
  const id = await ctx.host.startSession(aEjson(options));
  // Le funzioni restano quelle dell'interprete; solo il contesto del driver
  // cambia. Ogni operazione continua ad attraversare il Proxy RBAC.
  const bound = Object.create(ctx);
  for (const name of ['leggi', 'aggrega', 'conta', 'scrivi']) bound[name] = (...args) => ctx.host.inSession(id, () => ctx[name](...args));
  bound.host = new Proxy(ctx.host, { get(target, name) {
    const method = target[name];
    return typeof method === 'function' ? (...args) => ctx.host.inSession(id, () => method(...args)) : method;
  } });
  let object;
  object = { [OGGETTO_HOST]: true, __get(name) {
    if (name === 'getDatabase') return chiamabile(name, db => creaDb(bound, String(db)));
    if (name === 'getOptions') return chiamabile(name, () => options);
    if (name === 'withTransaction') return chiamabile(name, (fn, opts = {}) =>
      ctx.host.transaction(id, () => ctx.chiamaFunzione(fn, [object]), aEjson(opts)));
    if (['startTransaction', 'commitTransaction', 'abortTransaction', 'endSession', 'hasEnded',
      'getSessionId', 'getClusterTime', 'getOperationTime', 'advanceClusterTime', 'advanceOperationTime'].includes(name)) {
      return chiamabile(name, (...args) => ctx.host.sessionOperation(id, name, aEjson(args)));
    }
    throw errore(`Metodo di sessione MongoDB sconosciuto: ${name}.`);
  } };
  return object;
}

// `nomeDb` null = "il database corrente", che può cambiare con `use`/`USE`.
function risolviDb(ctx, nomeDb) {
  const nome = nomeDb || ctx.dbCorrente();
  if (!nome) {
    throw errore('Nessun database selezionato: apri un database nella sidebar oppure usa db.getSiblingDB("nome").');
  }
  return nome;
}

function creaCollezione(ctx, nomeDb, nomeColl) {
  const db = () => risolviDb(ctx, nomeDb);

  const metodi = {
    // --- Letture ---
    find: chiamabile('find', (filtro, proiezione, options) => creaCursore(ctx, db(), nomeColl, {
      filter: filtro, projection: proiezione, options,
    })),
    findOne: chiamabile('findOne', async (filtro, proiezione, options) => {
      const docs = await ctx.leggi(db(), nomeColl, { filter: filtro, projection: proiezione, limit: 1, options });
      return docs.length ? docs[0] : null;
    }),
    aggregate: chiamabile('aggregate', (pipeline, options) => creaCursore(ctx, db(), nomeColl, { pipeline, options })),
    countDocuments: chiamabile('countDocuments', (filtro, options) => ctx.conta(db(), nomeColl, filtro, options)),
    count: chiamabile('count', (filtro, options) => ctx.conta(db(), nomeColl, filtro, options)),
    estimatedDocumentCount: chiamabile('estimatedDocumentCount', (options = {}) => ctx.host.metadata(db(), nomeColl, { method: 'estimatedDocumentCount', options: aEjsonStr(options) })),
    distinct: chiamabile('distinct', async (campo, filtro, options = {}) => {
      if (typeof campo !== 'string' || !campo) throw errore('distinct richiede il nome del campo.');
      return ctx.host.distinct(db(), nomeColl, { field: campo, filter: aEjsonStr(filtro || {}), options: aEjsonStr(options) });
    }),

    // --- Scritture (il punto in cui cade la barriera di sola lettura della
    //     shell a comando singolo: qui uno script può creare e modificare) ---
    insertOne: chiamabile('insertOne', (doc, options) => ctx.scrivi(db(), nomeColl, 'insertOne', { doc, options })),
    insertMany: chiamabile('insertMany', (docs, options) => ctx.scrivi(db(), nomeColl, 'insertMany', { docs, options })),
    updateOne: chiamabile('updateOne', (f, u, o) => ctx.scrivi(db(), nomeColl, 'updateOne', { filter: f, update: u, options: o })),
    updateMany: chiamabile('updateMany', (f, u, o) => ctx.scrivi(db(), nomeColl, 'updateMany', { filter: f, update: u, options: o })),
    replaceOne: chiamabile('replaceOne', (f, d, o) => ctx.scrivi(db(), nomeColl, 'replaceOne', { filter: f, doc: d, options: o })),
    deleteOne: chiamabile('deleteOne', (f, options) => ctx.scrivi(db(), nomeColl, 'deleteOne', { filter: f, options })),
    deleteMany: chiamabile('deleteMany', (f, options) => ctx.scrivi(db(), nomeColl, 'deleteMany', { filter: f, options })),
    findOneAndUpdate: chiamabile('findOneAndUpdate', (f, u, o) => ctx.scrivi(db(), nomeColl, 'findOneAndUpdate', { filter: f, update: u, options: o })),
    findOneAndReplace: chiamabile('findOneAndReplace', (f, d, o) => ctx.scrivi(db(), nomeColl, 'findOneAndReplace', { filter: f, doc: d, options: o })),
    findOneAndDelete: chiamabile('findOneAndDelete', (f, o) => ctx.scrivi(db(), nomeColl, 'findOneAndDelete', { filter: f, options: o })),
    bulkWrite: chiamabile('bulkWrite', async (operazioni, opzioni = {}) => {
      if (!Array.isArray(operazioni) || !operazioni.length) throw errore('bulkWrite richiede un array non vuoto.');
      if (!opzioni || typeof opzioni !== 'object' || Array.isArray(opzioni)) throw errore('Le opzioni di bulkWrite devono essere un documento.');
      const { ordered, ...comuni } = opzioni;
      const validi = new Set(['insertOne', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany']);
      const piano = operazioni.map((voce, indice) => {
        const keys = voce && typeof voce === 'object' ? Object.keys(voce) : [];
        const op = keys[0], dati = voce?.[op];
        if (keys.length !== 1 || !validi.has(op) || !dati || typeof dati !== 'object') throw errore(`bulkWrite: operazione ${indice + 1} non valida.`);
        if (op !== 'insertOne' && (!dati.filter || typeof dati.filter !== 'object' || Array.isArray(dati.filter))) throw errore(`bulkWrite: filtro obbligatorio all’operazione ${indice + 1}.`);
        const { filter, document, replacement, update, ...options } = dati;
        return { op, args: { filter, update, doc: op === 'insertOne' ? document : replacement, options: { ...comuni, ...options } } };
      });
      const risultato = { acknowledged: true, insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0,
        insertedIds: {}, upsertedIds: {} };
      const errori = [];
      for (const [i, voce] of piano.entries()) {
        try {
          // Ogni voce attraversa il medesimo controllo RBAC e i medesimi
          // budget delle scritture singole, compresa la capability delete.
          const r = await ctx.scrivi(db(), nomeColl, voce.op, voce.args);
          risultato.insertedCount += r.insertedCount ?? r.inserted ?? (voce.op === 'insertOne' && r.acknowledged ? 1 : 0);
          risultato.matchedCount += r.matchedCount ?? r.matched ?? 0;
          risultato.modifiedCount += r.modifiedCount ?? r.modified ?? 0;
          risultato.deletedCount += r.deletedCount ?? r.deleted ?? 0;
          risultato.upsertedCount += r.upsertedCount ?? r.upserted ?? 0;
          if (voce.op === 'insertOne' && r.insertedId !== undefined) risultato.insertedIds[i] = r.insertedId;
          if (r.upsertedId != null) risultato.upsertedIds[i] = r.upsertedId;
        } catch (err) {
          if (err.budget || err.nonCatturabile) throw err;
          errori.push({ index: i, code: err.code, errmsg: err.message });
          if (ordered !== false) break;
        }
      }
      if (errori.length) throw Object.assign(errore(`bulkWrite incompleto (${risultato.insertedCount} inseriti, ${risultato.modifiedCount} modificati, ${risultato.deletedCount} eliminati): ${errori.map(e => `${e.index + 1}: ${e.errmsg}`).join('; ')}`),
        { name: 'MongoBulkWriteError', code: errori[0].code, writeErrors: errori, result: risultato });
      return risultato;
    }),

    // --- DDL ---
    drop: chiamabile('drop', async () => { await ctx.host.dropCollection(db(), nomeColl); return { ok: 1 }; }),
    createIndex: chiamabile('createIndex', async (chiavi, opzioni, commitQuorum) => {
      return ctx.host.index(db(), nomeColl, { method: 'createIndex', args: aEjsonStr([chiavi, opzioni || {}, ...(commitQuorum === undefined ? [] : [commitQuorum])]) });
    }),
    dropIndex: chiamabile('dropIndex', async (nome) => {
      return ctx.host.index(db(), nomeColl, { method: 'dropIndex', args: aEjsonStr([nome]) });
    }),
    getName: chiamabile('getName', () => nomeColl),
    getFullName: chiamabile('getFullName', () => `${db()}.${nomeColl}`),
    getDB: chiamabile('getDB', () => creaDb(ctx, nomeDb)),
    getIndexes: chiamabile('getIndexes', () => ctx.host.metadata(db(), nomeColl, { method: 'getIndexes' })),
    stats: chiamabile('stats', (scale = 1) => ctx.host.metadata(db(), nomeColl, { method: 'stats', scale })),
    isCapped: chiamabile('isCapped', () => ctx.host.metadata(db(), nomeColl, { method: 'isCapped' })),
    options: chiamabile('options', () => ctx.host.metadata(db(), nomeColl, { method: 'options' })),
  };
  for (const method of ['createIndexes', 'dropIndexes', 'hideIndex', 'unhideIndex']) {
    metodi[method] = chiamabile(method, (...args) => ctx.host.index(db(), nomeColl, { method, args: aEjsonStr(args) }));
  }

  return {
    [OGGETTO_HOST]: true,
    __nome: `collection ${nomeColl}`,
    __get(chiave) {
      if (Object.prototype.hasOwnProperty.call(metodi, chiave)) return metodi[chiave];
      throw errore(`Metodo non supportato sulle collezioni: "${chiave}"`);
    },
  };
}

/**
 * Cursore: raccoglie le opzioni della catena (`.sort().limit()`) e materializza
 * solo quando serve (`toArray`, `forEach`, o usandolo in un `for…of`). È la
 * stessa pigrizia della shell, e serve a non leggere documenti che nessuno
 * chiederà.
 */
function creaCursore(ctx, nomeDb, nomeColl, base) {
  const opz = { ...base };
  let materializzati = null;
  let posizione = 0;

  const materializza = async () => {
    if (materializzati) return materializzati;
    materializzati = opz.pipeline
      ? await ctx.aggrega(nomeDb, nomeColl, opz.pipeline, opz)
      : await ctx.leggi(nomeDb, nomeColl, opz);
    return materializzati;
  };
  const restanti = async () => {
    const docs = await materializza(), result = docs.slice(posizione);
    posizione = docs.length; ctx.ultimiDocumenti = result; return result;
  };

  const cursore = {
    [OGGETTO_HOST]: true,
    __nome: 'cursor',
    [CURSORE]: true,
    materializza,
    async itera() {
      const docs = await materializza();
      return (function* () { while (posizione < docs.length) yield docs[posizione++]; })();
    },
    __get(chiave, contesto) {
      const catena = (nome, applica) => chiamabile(nome, (...args) => {
        if (materializzati) throw errore(`"${nome}" va chiamato prima di leggere il cursore`);
        applica(...args);
        return cursore;
      });

      switch (chiave) {
        case 'sort': return catena('sort', (v) => { if (opz.pipeline) opz.pipeline = [...opz.pipeline, { $sort: v }]; else opz.sort = v; });
        case 'limit': return catena('limit', (v) => { if (opz.pipeline) opz.pipeline = [...opz.pipeline, { $limit: v }]; else opz.limit = v; });
        case 'skip': return catena('skip', (v) => { if (opz.pipeline) opz.pipeline = [...opz.pipeline, { $skip: v }]; else opz.skip = v; });
        case 'project': case 'projection': return catena(chiave, (v) => { if (opz.pipeline) opz.pipeline = [...opz.pipeline, { $project: v }]; else opz.projection = v; });
        case 'explain': return chiamabile('explain', async (verbosity = 'queryPlanner') => {
          const payload = { mode: opz.pipeline ? 'aggregate' : 'find', verbosity, limit: opz.limit, skip: opz.skip };
          for (const k of ['filter', 'pipeline', 'sort', 'projection', 'options']) if (opz[k] !== undefined) payload[k] = aEjsonStr(opz[k]);
          const result = await ctx.host.explain(nomeDb, nomeColl, payload);
          ctx.ultimiDocumenti = [result.plan];
          return result.plan;
        });
        case 'toArray': return chiamabile('toArray', restanti);
        case 'count': return chiamabile('count', async (applySkipLimit = false) => {
          if (opz.pipeline) throw errore('count() richiede un cursore find().');
          const pipeline = [{ $match: opz.filter || {} }];
          if (applySkipLimit && opz.skip) pipeline.push({ $skip: opz.skip });
          if (applySkipLimit && opz.limit) pipeline.push({ $limit: Math.abs(opz.limit) });
          pipeline.push({ $count: 'count' });
          return (await ctx.aggrega(nomeDb, nomeColl, pipeline, { options: opz.options }))[0]?.count || 0;
        });
        case 'itcount': return chiamabile('itcount', async () => (await restanti()).length);
        case 'hasNext': return chiamabile('hasNext', async () => posizione < (await materializza()).length);
        case 'close': return chiamabile('close', () => { materializzati = []; posizione = 0; });
        case 'isClosed': return chiamabile('isClosed', () => !!materializzati && posizione >= materializzati.length);
        case 'next': case 'tryNext': return chiamabile(chiave, async () => {
          const docs = await materializza();
          if (posizione < docs.length) {
            const doc = docs[posizione++]; ctx.ultimiDocumenti = [doc]; return doc;
          }
          if (chiave === 'tryNext') { ctx.ultimiDocumenti = []; return null; }
          throw errore('Cursore esaurito.');
        });
        case 'forEach': return chiamabile('forEach', async (fn) => {
          const docs = await materializza();
          while (posizione < docs.length) await contesto.chiamaFunzione(fn, [docs[posizione++]]);
          return undefined;
        });
        case 'map': return chiamabile('map', async (fn) => {
          const docs = await materializza();
          const out = [];
          while (posizione < docs.length) out.push(await contesto.chiamaFunzione(fn, [docs[posizione++]]));
          return out;
        });
        case 'pretty': return catena(chiave, () => {});
        case 'allowDiskUse': case 'batchSize': case 'hint': case 'maxTimeMS':
        case 'readPref': case 'readConcern': case 'collation': case 'comment':
        case 'min': case 'max': case 'returnKey': case 'showRecordId':
          return catena(chiave, (v, tags, extra) => {
            const key = chiave === 'readPref' ? 'readPreference' : chiave;
            const val = chiave === 'readPref' ? { mode: v, ...(tags ? { tags } : {}), ...extra }
              : chiave === 'readConcern' ? { level: v }
              : ['allowDiskUse', 'returnKey', 'showRecordId'].includes(chiave) ? v ?? true : v;
            opz.options = opzioniLettura({ ...opz.options, [key]: val }, !!opz.pipeline);
          });
        default:
          throw errore(`Metodo non supportato sui cursori: "${chiave}"`);
      }
    },
  };

  return cursore;
}

function chiamabile(nome, impl) {
  return { [FUNZIONE_NATIVA]: true, __nome: nome, invoca: (args) => impl(...args) };
}

/* ==========================================================================
 * Valutatore
 * ========================================================================== */

class Interprete {
  constructor(host, opzioni = {}) {
    // Tutti gli accessi, compresi DDL, indici ed explain, consumano lo stesso
    // budget. Contare solo nei quattro metodi CRUD lasciava percorsi esclusi.
    this.host = new Proxy(host, { get: (target, key) => {
      const method = target[key];
      if (typeof method !== 'function') return method;
      return (...args) => { this.contaChiamataDb(); return method.apply(target, args); };
    } });
    this.limiti = { ...LIMITI_DEFAULT, memoriaBytes: limiteMemoria(), ...(opzioni.limiti || {}) };
    this.passi = 0;
    this.iterazioni = 0;
    this.profondita = 0;
    this.chiamateDb = 0;
    this.scadenza = Date.now() + this.limiti.tempoMs;
    this.output = [];
    this.ultimiDocumenti = [];   // ultimo result set letto: è ciò che la UI mostra
    this.dbAttivo = opzioni.db || null;
    // Interruzione cooperativa: uno script JS non è divisibile in istruzioni
    // riprendibili, ma deve poter essere FERMATO. Il chiamante espone una
    // funzione che dice "l'utente ha premuto stop" e la si controlla insieme
    // agli altri budget.
    this.interrotto = typeof opzioni.interrotto === 'function' ? opzioni.interrotto : null;

    // Contesto passato alla sandbox dei valori e agli oggetti host.
    this.ctx = {
      host: this.host,
      chiamaFunzione: (fn, args) => this.chiamaFunzione(fn, args),
      dbCorrente: () => this.dbAttivo,
      stampa: (args, json) => this.stampa(args, json),
      leggi: (db, coll, opz) => this.leggi(db, coll, opz),
      aggrega: (db, coll, pipeline, opz) => this.aggrega(db, coll, pipeline, opz),
      conta: (db, coll, filtro, options) => this.conta(db, coll, filtro, options),
      scrivi: (db, coll, op, args) => this.scrivi(db, coll, op, args),
      // Budget di memoria: lo applica anche la sandbox dei valori
      // (MongoScript.legaNativo), che è dove i metodi nativi allocano.
      contaMemoria: (byte, cosa) => this.contaMemoria(byte, cosa),
      limitiRegex: {
        tempoMs: this.limiti.regexTempoMs,
        maxTesto: this.limiti.regexTesto,
        maxPattern: this.limiti.regexPattern,
        runId: opzioni.runId || null,
      },
    };

    Object.defineProperty(this.ctx, 'ultimiDocumenti', {
      get: () => this.ultimiDocumenti, set: docs => { this.ultimiDocumenti = docs; },
    });
    this.globali = costruisciGlobali(this.ctx);
  }

  /* --- Budget --- */

  passo() {
    if (++this.passi > this.limiti.passi) {
      throw errBudget(`Script troppo lungo: superato il limite di ${this.limiti.passi} operazioni.`);
    }
    // Il tempo si controlla di rado: `Date.now()` a ogni nodo costerebbe più
    // della valutazione stessa.
    if ((this.passi & 0x3ff) === 0) {
      if (Date.now() > this.scadenza) {
        throw errBudget(`Script interrotto: superato il tempo massimo di ${Math.round(this.limiti.tempoMs / 1000)}s.`);
      }
      if (this.interrotto && this.interrotto()) {
        throw errBudget('Script interrotto dall\'utente.');
      }
    }
  }

  giro() {
    if (++this.iterazioni > this.limiti.iterazioni) {
      throw errBudget(`Ciclo interrotto: superato il limite di ${this.limiti.iterazioni} iterazioni (controlla la condizione di uscita).`);
    }
  }

  contaChiamataDb() {
    if (Date.now() > this.scadenza) throw errBudget('Script interrotto: superato il tempo massimo.');
    if (this.interrotto?.()) throw errBudget('Script interrotto dall’utente.');
    if (++this.chiamateDb > this.limiti.chiamateDb) {
      throw errBudget(`Script interrotto: superato il limite di ${this.limiti.chiamateDb} operazioni sul database.`);
    }
  }

  /**
   * Budget di memoria (CDB-65). Si controlla la dimensione che il valore AVREBBE
   * una volta costruito, PRIMA di costruirlo: dopo sarebbe inutile, perché è
   * proprio l'allocazione a uccidere il processo. La stima è per eccesso sulle
   * stringhe (2 byte per carattere, come le stringhe interne di V8) e per
   * difetto sugli array (8 byte per elemento, cioè il solo puntatore): non è una
   * misura della memoria reale, è una soglia contro la crescita esplosiva.
   *
   * Come gli altri budget, l'errore è marcato e quindi NON catturabile da un
   * try/catch dello script.
   */
  contaMemoria(byteStimati, cosa) {
    const max = this.limiti.memoriaBytes;
    if (!max || max <= 0) return;
    if (byteStimati > max) {
      throw errBudget(
        `Script interrotto: ${cosa} occuperebbe circa ${Math.round(byteStimati / 1048576)} MB, `
        + `oltre il limite di ${Math.round(max / 1048576)} MB per valore `
        + '(variabile d\'ambiente CODEDB_SCRIPT_MAX_BYTES).'
      );
    }
  }

  stampa(args, json = false) {
    if (this.outputTroncato) return;
    if (this.output.length >= this.limiti.output) {
      // Ogni altro budget del modulo termina con un messaggio esplicito: un
      // output tagliato in silenzio fa credere che lo script si sia fermato lì.
      this.outputTroncato = true;
      this.output.push(`… output troncato: superato il limite di ${this.limiti.output} righe.`);
      return;
    }
    const riga = args.map((a) => (json ? JSON.stringify(semplifica(a), null, 2) : testo(a))).join(' ');
    // `stampa` era l'unico punto che accumulava dati senza passare dal budget
    // di memoria: una riga è `JSON.stringify` di un valore arbitrario, e
    // l'array le trattiene tutte fino alla fine dello script. Si conta sia la
    // singola riga sia il totale già accumulato, altrimenti `printjson` in un
    // ciclo aggirerebbe il limite una riga alla volta.
    this.outputBytes = (this.outputBytes || 0) + riga.length * 2;
    this.contaMemoria(riga.length * 2, 'l\'output di print');
    this.contaMemoria(this.outputBytes, 'l\'output complessivo dello script');
    this.output.push(riga);
  }

  /* --- Accesso al database --- */

  async leggi(db, coll, opz = {}) {
    const tetto = this.limiti.docPerLettura;
    const richiesto = Number(opz.limit) || Infinity;
    const payload = {
      filter: opz.filter ? aEjsonStr(opz.filter) : '',
      // Una riga sentinella distingue il budget dal LIMIT voluto dall'utente.
      maxRows: tetto + 1,
      limit: Math.min(Math.abs(richiesto), tetto + 1) * (richiesto < 0 ? -1 : 1),
    };
    if (opz.projection) payload.projection = aEjsonStr(opz.projection);
    if (opz.sort) payload.sort = aEjsonStr(opz.sort);
    if (opz.skip != null) payload.skip = Number(opz.skip);
    if (opz.options) payload.options = aEjsonStr(opzioniLettura(opz.options));
    const res = await this.host.find(db, coll, payload);
    const docs = (res && res.docs) || [];
    if (res?.truncated || docs.length > tetto) throw errBudget('Lettura MQL incompleta: superato il limite di righe o byte dello script. Restringi il filtro o usa limit().');
    this.ultimiDocumenti = docs;
    return docs;
  }

  async aggrega(db, coll, pipeline, opz = {}) {
    const stadi = aEjson(pipeline);
    if (!Array.isArray(stadi)) throw errore('aggregate() richiede un array di stadi.');
    const extra = [];
    if (opz.sort) extra.push({ $sort: aEjson(opz.sort) });
    if (opz.skip != null) extra.push({ $skip: Number(opz.skip) });
    if (opz.limit != null) extra.push({ $limit: Number(opz.limit) });
    const res = await this.host.aggregate(db, coll, {
      pipeline: JSON.stringify([...stadi, ...extra]),
      maxRows: this.limiti.docPerLettura + 1,
      ...(opz.options ? { options: aEjsonStr(opzioniLettura(opz.options, true)) } : {}),
    });
    const docs = (res && res.docs) || [];
    if (res?.truncated || docs.length > this.limiti.docPerLettura) throw errBudget('Aggregazione MQL incompleta: superato il limite di righe o byte dello script. Restringi la pipeline.');
    this.ultimiDocumenti = docs;
    return docs;
  }

  async conta(db, coll, filtro, options) {
    const res = await this.host.count(db, coll, { filter: filtro ? aEjsonStr(filtro) : '{}', ...(options ? { options: aEjsonStr(options) } : {}) });
    if (res?.timedOut || res?.total == null) throw errore('Conteggio MongoDB incompleto: tempo massimo superato. Restringi il filtro.');
    return res && res.total != null ? res.total : 0;
  }

  async scrivi(db, coll, op, args) {
    const payload = { op };
    if (args.doc !== undefined) payload.doc = aEjsonStr(args.doc);
    if (args.docs !== undefined) payload.docs = aEjsonStr(args.docs);
    if (args.filter !== undefined) payload.filter = aEjsonStr(args.filter === undefined ? {} : args.filter);
    if (args.update !== undefined) payload.update = aEjsonStr(args.update);
    if (args.options !== undefined) payload.options = aEjsonStr(args.options || {});
    const res = await this.host.write(db, coll, payload);
    // Gli script salvati prima dei risultati mongosh usavano questi nomi.
    // Restano leggibili, senza aggiungere campi al risultato JSON nativo.
    if (res && typeof res === 'object' && !op.startsWith('findOneAnd')) {
      for (const [old, key] of Object.entries({ inserted: 'insertedCount', matched: 'matchedCount', modified: 'modifiedCount', deleted: 'deletedCount', upserted: 'upsertedCount' })) {
        if (res[key] !== undefined && !Object.hasOwn(res, old)) Object.defineProperty(res, old, { value: res[key] });
      }
    }
    return res;
  }

  /* --- Chiamate --- */

  async chiamaFunzione(fn, args) {
    if (fn && fn[FUNZIONE_NATIVA]) return fn.invoca(args);
    if (!fn || !fn[FUNZIONE_SCRIPT]) throw errore('Valore non richiamabile: non è una funzione.');

    if (++this.profondita > this.limiti.profondita) {
      this.profondita--;
      throw errBudget(`Troppe chiamate annidate (limite ${this.limiti.profondita}): forse una ricorsione senza uscita.`);
    }
    try {
      const scope = new Scope(fn.scope);
      fn.params.forEach((p, i) => scope.dichiara(p, args[i]));
      if (fn.espressione) return await this.valuta(fn.body, scope);
      const esito = await this.esegui(fn.body, scope);
      return esito.tipo === 'return' ? esito.valore : undefined;
    } finally {
      this.profondita--;
    }
  }

  /* --- Statement --- */

  async eseguiProgramma(ast, scope) {
    // Le dichiarazioni di funzione sono visibili da tutto il blocco (hoisting):
    // uno script che chiama una funzione definita più in basso deve funzionare.
    for (const st of ast.body) {
      if (st.type === 'FuncDecl') {
        scope.dichiara(st.name, { [FUNZIONE_SCRIPT]: true, params: st.params, body: st.body, scope });
      }
    }
    for (const [index, st] of ast.body.entries()) {
      if (index === ast.body.length - 1 && st.type === 'ExprStmt') {
        const value = await this.valuta(st.expr, scope);
        if (value?.[CURSORE]) this.ultimiDocumenti = await value.__get('toArray').invoca([]);
        else if (value !== undefined && !value?.[OGGETTO_HOST] && !value?.[FUNZIONE_SCRIPT] && !value?.[FUNZIONE_NATIVA]) {
          this.ultimiDocumenti = (Array.isArray(value) ? value : [value]).map(v => v && typeof v === 'object' ? v : { valore: v });
        }
        continue;
      }
      const esito = await this.esegui(st, scope);
      if (esito.tipo === 'return') return esito;
      if (esito.tipo !== 'normale') {
        throw errore(`"${esito.tipo}" fuori da un ciclo`, st.line);
      }
    }
    return NORMALE;
  }

  async esegui(nodo, scope) {
    this.passo();
    switch (nodo.type) {
      case 'Block': {
        const interno = new Scope(scope);
        for (const st of nodo.body) {
          if (st.type === 'FuncDecl') {
            interno.dichiara(st.name, { [FUNZIONE_SCRIPT]: true, params: st.params, body: st.body, scope: interno });
          }
        }
        for (const st of nodo.body) {
          const esito = await this.esegui(st, interno);
          if (esito.tipo !== 'normale') return esito;
        }
        return NORMALE;
      }

      case 'VarDecl': {
        for (const d of nodo.decls) {
          const valore = d.init ? await this.valuta(d.init, scope) : undefined;
          scope.dichiara(d.name, valore, nodo.kind === 'const');
        }
        return NORMALE;
      }

      case 'ExprStmt':
        await this.valuta(nodo.expr, scope);
        return NORMALE;

      case 'If':
        if (verita(await this.valuta(nodo.test, scope))) return this.esegui(nodo.cons, scope);
        if (nodo.alt) return this.esegui(nodo.alt, scope);
        return NORMALE;

      case 'While':
        for (;;) {
          this.giro();
          if (!verita(await this.valuta(nodo.test, scope))) break;
          const esito = await this.esegui(nodo.body, new Scope(scope));
          if (esito.tipo === 'break') break;
          if (esito.tipo === 'return') return esito;
        }
        return NORMALE;

      case 'DoWhile':
        for (;;) {
          this.giro();
          const esito = await this.esegui(nodo.body, new Scope(scope));
          if (esito.tipo === 'break') break;
          if (esito.tipo === 'return') return esito;
          if (!verita(await this.valuta(nodo.test, scope))) break;
        }
        return NORMALE;

      case 'For': {
        const esterno = new Scope(scope);
        if (nodo.init) await this.esegui(nodo.init, esterno);
        for (;;) {
          this.giro();
          if (nodo.test && !verita(await this.valuta(nodo.test, esterno))) break;
          const esito = await this.esegui(nodo.body, new Scope(esterno));
          if (esito.tipo === 'break') break;
          if (esito.tipo === 'return') return esito;
          if (nodo.update) await this.valuta(nodo.update, esterno);
        }
        return NORMALE;
      }

      case 'ForOf': {
        const sorgente = await this.valuta(nodo.right, scope);
        const elementi = await this.iterabile(sorgente, nodo.line);
        for (const el of elementi) {
          this.giro();
          const interno = new Scope(scope);
          interno.dichiara(nodo.name, el, nodo.kind === 'const');
          const esito = await this.esegui(nodo.body, interno);
          if (esito.tipo === 'break') break;
          if (esito.tipo === 'return') return esito;
        }
        return NORMALE;
      }

      case 'ForIn': {
        const sorgente = await this.valuta(nodo.right, scope);
        const chiavi = Array.isArray(sorgente)
          ? sorgente.map((_, i) => String(i))
          : (sorgente && typeof sorgente === 'object' && !sorgente[OGGETTO_HOST] ? Object.keys(sorgente) : []);
        for (const k of chiavi) {
          this.giro();
          const interno = new Scope(scope);
          interno.dichiara(nodo.name, k, nodo.kind === 'const');
          const esito = await this.esegui(nodo.body, interno);
          if (esito.tipo === 'break') break;
          if (esito.tipo === 'return') return esito;
        }
        return NORMALE;
      }

      case 'Return':
        return ritorno(nodo.arg ? await this.valuta(nodo.arg, scope) : undefined);

      case 'Break': return BREAK;
      case 'Continue': return CONTINUE;

      case 'FuncDecl':
        // Già dichiarata in fase di hoisting.
        return NORMALE;

      case 'Throw': {
        const v = await this.valuta(nodo.arg, scope);
        // Il messaggio resta ESATTAMENTE quello lanciato dallo script: chi lo
        // cattura si aspetta il proprio testo, non un'annotazione del motore.
        // La riga viaggia a parte, per la segnalazione in caso di errore non
        // catturato.
        const err = new Error(typeof v === 'string' ? v : testo(v));
        err.scriptLine = nodo.line;
        err.lanciataDalloScript = true;
        err.valore = v;
        throw err;
      }

      case 'Try': {
        // Niente `finally` di JavaScript qui: un `return` dentro un `finally`
        // scarterebbe silenziosamente l'eccezione in volo, budget compresi.
        // Si tiene quindi l'esito da parte e si rilancia a mano DOPO il
        // finalizzatore.
        let esito = NORMALE;
        let errPendente = null;
        try {
          esito = await this.esegui(nodo.block, new Scope(scope));
        } catch (err) {
          // I superamenti di budget NON sono catturabili: uno script non deve
          // poter neutralizzare con un try/catch il limite che lo protegge —
          // un `while(true)` dentro un try/catch girerebbe per sempre.
          if (err && err.budget) throw err;
          if (!nodo.handler) errPendente = err;
          else {
            const interno = new Scope(scope);
            if (nodo.param) {
              // `throw` dello script conserva il valore lanciato in
              // `err.valore`: se è un OGGETTO va legato com'è, altrimenti
              // `throw { codice: 42, dettaglio: … }` arrivava al catch come un
              // oggetto col solo `message` e tutto il resto spariva.
              // Un valore primitivo resta invece nella forma `{ message }`:
              // in questo dialetto `e.message` è il modo documentato di leggere
              // un `throw 'testo'`, e la sola forma che vale anche per gli
              // errori del motore e del driver, che non hanno altro.
              const lanciato = err && err.lanciataDalloScript && err.valore && typeof err.valore === 'object'
                ? err.valore
                : { message: err && err.message ? err.message : String(err),
                  ...Object.fromEntries(['name', 'code', 'codeName', 'errorLabels', 'keyPattern', 'keyValue', 'writeErrors', 'result']
                    .filter(k => err?.[k] !== undefined).map(k => [k, aEjson(err[k])])) };
              interno.dichiara(nodo.param, lanciato);
            }
            try {
              esito = await this.esegui(nodo.handler, interno);
            } catch (err2) {
              if (err2 && err2.budget) throw err2;
              errPendente = err2;
            }
          }
        }

        if (nodo.finalizer) {
          const esitoFin = await this.esegui(nodo.finalizer, new Scope(scope));
          // Un'uscita esplicita dal finalizzatore vince, come in JavaScript.
          if (esitoFin.tipo !== 'normale') return esitoFin;
        }

        if (errPendente) throw errPendente;
        return esito;
      }

      default:
        throw errore(`Istruzione non supportata: ${nodo.type}`, nodo.line);
    }
  }

  async iterabile(v, line) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return [...v];
    if (v && v[CURSORE]) return v.itera();
    if (v && typeof v === 'object' && v[OGGETTO_HOST]) {
      throw errore('Questo oggetto non è iterabile: usa .toArray() oppure .forEach().', line);
    }
    throw errore('Il valore di "for…of" non è iterabile.', line);
  }

  /* --- Espressioni --- */

  async valuta(nodo, scope) {
    this.passo();
    switch (nodo.type) {
      case 'Await': return this.valuta(nodo.arg, scope);
      case 'Num': case 'Str': case 'Bool': return nodo.value;
      case 'Null': return null;
      case 'Undef': return undefined;
      // Una regex è l'unico costrutto che può consumare tempo esponenziale
      // senza consumare un solo passo, e mentre gira nessun budget può
      // intervenire: si rifiutano qui i pattern a quantificatore annidato.
      case 'Regex':
        assertRegexSicura(nodo.value.pattern, nodo.line);
        return new RegExp(nodo.value.pattern, nodo.value.flags);

      case 'Tpl': {
        let out = nodo.parti[0] || '';
        for (let i = 0; i < nodo.exprs.length; i++) {
          out += testo(await this.valuta(nodo.exprs[i], scope));
          out += nodo.parti[i + 1] || '';
        }
        return out;
      }

      case 'Ident': {
        if (nodo.name === 'db') return creaDb(this.ctx, null);
        const cella = scope.trova(nodo.name);
        if (cella) return cella.valore;
        if (Object.prototype.hasOwnProperty.call(this.globali, nodo.name)) return this.globali[nodo.name];
        // Niente fallback sulle globali del processo: un nome sconosciuto è un
        // errore, non `undefined` — e soprattutto non `require`.
        throw errore(`Nome non definito: "${nodo.name}"`, nodo.line);
      }

      case 'Array': {
        const out = [];
        for (const el of nodo.elements) out.push(await this.valuta(el, scope));
        return out;
      }

      case 'Object': {
        const out = {};
        for (const p of nodo.props) {
          const chiave = p.computed ? String(await this.valuta(p.key, scope)) : p.key.value;
          Object.defineProperty(out, chiave, { value: await this.valuta(p.value, scope), enumerable: true, writable: true, configurable: true });
        }
        return out;
      }

      case 'Func':
        return {
          [FUNZIONE_SCRIPT]: true,
          params: nodo.params,
          body: nodo.body,
          espressione: !!nodo.espressione,
          scope,
        };

      case 'Member': {
        const obj = await this.valuta(nodo.obj, scope);
        const chiave = nodo.computed ? await this.valuta(nodo.prop, scope) : nodo.prop.value;
        return getMember(obj, chiave, this.ctx);
      }

      case 'Call': {
        let thisObj = null;
        let fn;
        if (nodo.callee.type === 'Member') {
          thisObj = await this.valuta(nodo.callee.obj, scope);
          const chiave = nodo.callee.computed
            ? await this.valuta(nodo.callee.prop, scope)
            : nodo.callee.prop.value;
          fn = getMember(thisObj, chiave, this.ctx);
          if (fn === undefined) {
            throw errore(`Metodo non trovato: "${chiave}"`, nodo.line);
          }
        } else {
          fn = await this.valuta(nodo.callee, scope);
        }
        const args = [];
        for (const a of nodo.args) args.push(await this.valuta(a, scope));
        return this.chiamaFunzione(fn, args);
      }

      case 'New': {
        // Solo i costruttori dell'ambiente: `new Date(...)`, `new ObjectId(...)`.
        const nome = nodo.callee.type === 'Ident' ? nodo.callee.name : null;
        const args = [];
        for (const a of nodo.args) args.push(await this.valuta(a, scope));
        if (nome === 'Date') return args.length ? new Date(args[0]) : new Date();
        if (nome === 'Error') return { name: 'Error', message: String(args[0] ?? '') };
        if (nome && COSTRUTTORI_CON_NEW.has(nome) && Object.prototype.hasOwnProperty.call(this.globali, nome)) {
          return this.chiamaFunzione(this.globali[nome], args);
        }
        throw errore(`"new ${nome || '?'}" non è supportato negli script`, nodo.line);
      }

      case 'Unary': {
        if (nodo.op === 'typeof') {
          try {
            const v = await this.valuta(nodo.arg, scope);
            return tipoDi(v);
          } catch (err) {
            // `typeof x` su un nome non definito vale "undefined", come in JS.
            if (err && /Nome non definito/.test(err.message)) return 'undefined';
            throw err;
          }
        }
        const v = await this.valuta(nodo.arg, scope);
        switch (nodo.op) {
          case '!': return !verita(v);
          case '-': return -Number(v);
          case '+': return Number(v);
          case 'void': return undefined;
          case 'delete': return true;
          default: throw errore(`Operatore unario non supportato: ${nodo.op}`, nodo.line);
        }
      }

      case 'Update': {
        const vecchio = Number(await this.valuta(nodo.arg, scope));
        const nuovo = nodo.op === '++' ? vecchio + 1 : vecchio - 1;
        await this.assegnaA(nodo.arg, nuovo, scope);
        return nodo.prefix ? nuovo : vecchio;
      }

      case 'Logical': {
        const sx = await this.valuta(nodo.left, scope);
        if (nodo.op === '&&') return verita(sx) ? this.valuta(nodo.right, scope) : sx;
        if (nodo.op === '||') return verita(sx) ? sx : this.valuta(nodo.right, scope);
        return sx == null ? this.valuta(nodo.right, scope) : sx; // ??
      }

      case 'Binary': {
        const a = await this.valuta(nodo.left, scope);
        const b = await this.valuta(nodo.right, scope);
        return applicaBinario(nodo.op, a, b, nodo.line, this);
      }

      case 'Cond':
        return verita(await this.valuta(nodo.test, scope))
          ? this.valuta(nodo.cons, scope)
          : this.valuta(nodo.alt, scope);

      case 'Assign': {
        let valore = await this.valuta(nodo.value, scope);
        if (nodo.op !== '=') {
          const attuale = await this.valuta(nodo.target, scope);
          valore = applicaBinario(nodo.op[0], attuale, valore, nodo.line, this);
        }
        await this.assegnaA(nodo.target, valore, scope);
        return valore;
      }

      default:
        throw errore(`Espressione non supportata: ${nodo.type}`, nodo.line);
    }
  }

  async assegnaA(bersaglio, valore, scope) {
    if (bersaglio.type === 'Ident') {
      scope.assegna(bersaglio.name, valore);
      return;
    }
    if (bersaglio.type === 'Member') {
      const obj = await this.valuta(bersaglio.obj, scope);
      const chiave = bersaglio.computed
        ? String(await this.valuta(bersaglio.prop, scope))
        : bersaglio.prop.value;
      if (obj == null) throw errore('Assegnamento su un valore nullo');
      if (obj[OGGETTO_HOST] || obj[FUNZIONE_SCRIPT] || obj[FUNZIONE_NATIVA]) {
        throw errore('Gli oggetti del database non sono modificabili dallo script');
      }
      if (NOMI_VIETATI.has(chiave)) {
        throw errore(`Assegnamento a "${chiave}" non consentito`);
      }
      if (Array.isArray(obj) && /^\d+$/.test(chiave)) obj[Number(chiave)] = valore;
      else if (typeof obj === 'object') obj[chiave] = valore;
      else throw errore('Assegnamento non consentito su questo valore');
      return;
    }
    throw errore('Bersaglio di assegnamento non valido');
  }
}

function tipoDi(v) {
  if (v === null) return 'object';
  if (Array.isArray(v)) return 'object';
  if (v && typeof v === 'object' && (v[FUNZIONE_SCRIPT] || v[FUNZIONE_NATIVA])) return 'function';
  return typeof v;
}

// `interprete` serve al solo budget di memoria (CDB-65): la concatenazione di
// stringhe è la via più immediata per far esplodere l'heap (`a = a + a` in un
// ciclo raddoppia a ogni giro), e va fermata PRIMA di costruire il risultato.
function applicaBinario(op, a, b, line, interprete = null) {
  switch (op) {
    case '+':
      if (typeof a === 'string' || typeof b === 'string') {
        const sa = testo(a);
        const sb = testo(b);
        if (interprete) interprete.contaMemoria((sa.length + sb.length) * 2, 'la stringa concatenata');
        return sa + sb;
      }
      return Number(a) + Number(b);
    case '-': return Number(a) - Number(b);
    case '*': return Number(a) * Number(b);
    case '/': return Number(a) / Number(b);
    case '%': return Number(a) % Number(b);
    case '**': return Number(a) ** Number(b);
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    case '==': return confrontaLento(a, b);
    case '!=': return !confrontaLento(a, b);
    case '===': return confrontaStretto(a, b);
    case '!==': return !confrontaStretto(a, b);
    case 'in': return !!(b && typeof b === 'object' && Object.prototype.hasOwnProperty.call(b, String(a)));
    case 'instanceof': return false;
    default: throw errore(`Operatore non supportato: ${op}`, line);
  }
}

function confrontaStretto(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function confrontaLento(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) return Number(a) === Number(b);
  // eslint-disable-next-line eqeqeq
  return a == b;
}

/**
 * Esegue uno script MongoDB.
 *
 * @param {string} code
 * @param {object} host  operazioni sul database (già sotto il Proxy RBAC):
 *   find(db, coll, payload), aggregate(...), count(...), write(db, coll, payload),
 *   listCollections(db), createCollection(db, nome), dropCollection(db, coll),
 *   dropDatabase(db), createIndex(db, coll, payload), dropIndex(db, coll, nome)
 * @param {object} [opzioni] { db, limiti }
 * @returns {Promise<{ output: string[], docs: object[], chiamateDb: number }>}
 */
async function eseguiScript(code, host, opzioni = {}) {
  const ast = parse(code);
  const interprete = new Interprete(host, opzioni);
  const scope = new Scope(null);
  await interprete.eseguiProgramma(ast, scope);
  return {
    output: interprete.output,
    docs: interprete.ultimiDocumenti,
    chiamateDb: interprete.chiamateDb,
    passi: interprete.passi,
  };
}

/**
 * Il testo è uno SCRIPT JavaScript (e non un singolo comando shell, un filtro
 * MQL o una SELECT)? Serve a `query:execute`/`script:execute` per scegliere
 * l'interprete invece della divisione per `;`, che non conosce i blocchi `{}`.
 */
const PAROLE_SCRIPT = new Set([
  'var', 'let', 'const', 'function', 'if', 'for', 'while', 'do', 'try', 'return', 'throw', 'async', 'await',
]);

function sembraScriptJs(code) {
  const s = String(code || '');
  if (!s.trim()) return false;
  // Il riconoscimento passa dal TOKENIZER, non da una regex sul testo grezzo:
  // `if`, `do`, `for` e `return` sono parole comunissime nei dati, e un comando
  // shell come db.log.find({ nota: 'do not delete' }) finiva all'interprete
  // sbagliato. Il tokenizer distingue già stringhe, template e commenti.
  try {
    const tokens = tokenize(s);
    // Le keyword SQL possono essere seguite da nomi di campi come "let" o
    // "return": questi non trasformano una SELECT in uno script JavaScript.
    if (/^(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|REPLACE)$/i.test(tokens[0]?.v || '')) return false;
    for (const [i, t] of tokens.entries()) {
      const proprieta = tokens[i - 1]?.v === '.' || tokens[i + 1]?.v === ':';
      if (!proprieta && (t.t === 'kw' || t.t === 'ident') && PAROLE_SCRIPT.has(t.v)) return true;
      if (t.t === 'op' && t.v === '=>') return true;
    }
    return false;
  } catch {
    // Testo che il tokenizer non sa leggere (SQL, frammenti): non è uno script.
    return false;
  }
}

module.exports = { eseguiScript, sembraScriptJs, Interprete, LIMITI_DEFAULT };
