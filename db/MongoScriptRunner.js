'use strict';

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
  costruisciGlobali, errore, NOMI_VIETATI,
} = require('./MongoScript');

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
};

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
    getName: chiamabile('getName', () => ctx.dbCorrente()),
    getSiblingDB: chiamabile('getSiblingDB', (nome) => creaDb(ctx, String(nome))),
    getCollection: chiamabile('getCollection', (nome) => creaCollezione(ctx, nomeDb, String(nome))),
    getCollectionNames: chiamabile('getCollectionNames', async () => {
      const elenco = await ctx.host.listCollections(risolviDb(ctx, nomeDb));
      return (elenco || []).map((c) => (typeof c === 'string' ? c : c.name));
    }),
    createCollection: chiamabile('createCollection', async (nome) => {
      await ctx.host.createCollection(risolviDb(ctx, nomeDb), String(nome));
      return { ok: 1 };
    }),
    dropDatabase: chiamabile('dropDatabase', async () => {
      await ctx.host.dropDatabase(risolviDb(ctx, nomeDb));
      return { ok: 1 };
    }),
  };

  return {
    __host: true,
    __nome: 'db',
    __get(chiave) {
      if (Object.prototype.hasOwnProperty.call(metodi, chiave)) return metodi[chiave];
      return creaCollezione(ctx, nomeDb, chiave);
    },
  };
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
    find: chiamabile('find', (filtro, proiezione) => creaCursore(ctx, db(), nomeColl, {
      filter: filtro, projection: proiezione,
    })),
    findOne: chiamabile('findOne', async (filtro, proiezione) => {
      const docs = await ctx.leggi(db(), nomeColl, { filter: filtro, projection: proiezione, limit: 1 });
      return docs.length ? docs[0] : null;
    }),
    aggregate: chiamabile('aggregate', (pipeline) => creaCursore(ctx, db(), nomeColl, { pipeline })),
    countDocuments: chiamabile('countDocuments', (filtro) => ctx.conta(db(), nomeColl, filtro)),
    count: chiamabile('count', (filtro) => ctx.conta(db(), nomeColl, filtro)),
    estimatedDocumentCount: chiamabile('estimatedDocumentCount', () => ctx.conta(db(), nomeColl, {})),
    distinct: chiamabile('distinct', async (campo, filtro) => {
      const pipeline = [];
      if (filtro && Object.keys(filtro).length) pipeline.push({ $match: aEjson(filtro) });
      pipeline.push({ $group: { _id: `$${String(campo)}` } });
      const docs = await ctx.aggrega(db(), nomeColl, pipeline);
      return docs.map((d) => (d && '_id' in d ? d._id : null));
    }),

    // --- Scritture (il punto in cui cade la barriera di sola lettura della
    //     shell a comando singolo: qui uno script può creare e modificare) ---
    insertOne: chiamabile('insertOne', (doc) => ctx.scrivi(db(), nomeColl, 'insertOne', { doc })),
    insertMany: chiamabile('insertMany', (docs) => ctx.scrivi(db(), nomeColl, 'insertMany', { docs })),
    updateOne: chiamabile('updateOne', (f, u, o) => ctx.scrivi(db(), nomeColl, 'updateOne', { filter: f, update: u, options: o })),
    updateMany: chiamabile('updateMany', (f, u, o) => ctx.scrivi(db(), nomeColl, 'updateMany', { filter: f, update: u, options: o })),
    replaceOne: chiamabile('replaceOne', (f, d, o) => ctx.scrivi(db(), nomeColl, 'replaceOne', { filter: f, doc: d, options: o })),
    deleteOne: chiamabile('deleteOne', (f) => ctx.scrivi(db(), nomeColl, 'deleteOne', { filter: f })),
    deleteMany: chiamabile('deleteMany', (f) => ctx.scrivi(db(), nomeColl, 'deleteMany', { filter: f })),
    findOneAndUpdate: chiamabile('findOneAndUpdate', (f, u, o) => ctx.scrivi(db(), nomeColl, 'findOneAndUpdate', { filter: f, update: u, options: o })),
    findOneAndDelete: chiamabile('findOneAndDelete', (f, o) => ctx.scrivi(db(), nomeColl, 'findOneAndDelete', { filter: f, options: o })),
    bulkWrite: chiamabile('bulkWrite', () => {
      throw errore('bulkWrite non è supportato negli script: usa insertMany/updateMany o un ciclo.');
    }),

    // --- DDL ---
    drop: chiamabile('drop', async () => { await ctx.host.dropCollection(db(), nomeColl); return { ok: 1 }; }),
    createIndex: chiamabile('createIndex', async (chiavi, opzioni) => {
      await ctx.host.createIndex(db(), nomeColl, { keys: aEjson(chiavi), options: aEjson(opzioni || {}) });
      return { ok: 1 };
    }),
    dropIndex: chiamabile('dropIndex', async (nome) => {
      await ctx.host.dropIndex(db(), nomeColl, String(nome));
      return { ok: 1 };
    }),
    getName: chiamabile('getName', () => nomeColl),
  };

  return {
    __host: true,
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

  const materializza = async () => {
    if (materializzati) return materializzati;
    materializzati = opz.pipeline
      ? await ctx.aggrega(nomeDb, nomeColl, opz.pipeline, opz)
      : await ctx.leggi(nomeDb, nomeColl, opz);
    return materializzati;
  };

  const cursore = {
    __host: true,
    __nome: 'cursor',
    __cursore: true,
    materializza,
    __get(chiave, contesto) {
      const catena = (nome, applica) => chiamabile(nome, (...args) => {
        if (materializzati) throw errore(`"${nome}" va chiamato prima di leggere il cursore`);
        applica(...args);
        return cursore;
      });

      switch (chiave) {
        case 'sort': return catena('sort', (v) => { opz.sort = v; });
        case 'limit': return catena('limit', (v) => { opz.limit = v; });
        case 'skip': return catena('skip', (v) => { opz.skip = v; });
        case 'projection': return catena('projection', (v) => { opz.projection = v; });
        case 'toArray': return chiamabile('toArray', () => materializza());
        case 'count': return chiamabile('count', async () => (await materializza()).length);
        case 'itcount': return chiamabile('itcount', async () => (await materializza()).length);
        case 'hasNext': return chiamabile('hasNext', async () => (await materializza()).length > 0);
        case 'forEach': return chiamabile('forEach', async (fn) => {
          const docs = await materializza();
          for (const d of docs) await contesto.chiamaFunzione(fn, [d]);
          return undefined;
        });
        case 'map': return chiamabile('map', async (fn) => {
          const docs = await materializza();
          const out = [];
          for (const d of docs) out.push(await contesto.chiamaFunzione(fn, [d]));
          return out;
        });
        // Metodi di cursore che non cambiano il risultato: accettati e ignorati,
        // così gli script copiati dalla shell continuano a funzionare.
        case 'pretty': case 'allowDiskUse': case 'batchSize': case 'hint':
        case 'maxTimeMS': case 'readPref': case 'collation': case 'comment':
          return catena(chiave, () => { /* nessun effetto */ });
        default:
          throw errore(`Metodo non supportato sui cursori: "${chiave}"`);
      }
    },
  };

  return cursore;
}

function chiamabile(nome, impl) {
  return { __chiamabile: true, __nome: nome, invoca: (args) => impl(...args) };
}

/* ==========================================================================
 * Valutatore
 * ========================================================================== */

class Interprete {
  constructor(host, opzioni = {}) {
    this.host = host;
    this.limiti = { ...LIMITI_DEFAULT, ...(opzioni.limiti || {}) };
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
      host,
      chiamaFunzione: (fn, args) => this.chiamaFunzione(fn, args),
      dbCorrente: () => this.dbAttivo,
      stampa: (args, json) => this.stampa(args, json),
      leggi: (db, coll, opz) => this.leggi(db, coll, opz),
      aggrega: (db, coll, pipeline, opz) => this.aggrega(db, coll, pipeline, opz),
      conta: (db, coll, filtro) => this.conta(db, coll, filtro),
      scrivi: (db, coll, op, args) => this.scrivi(db, coll, op, args),
    };

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
    if (++this.chiamateDb > this.limiti.chiamateDb) {
      throw errBudget(`Script interrotto: superato il limite di ${this.limiti.chiamateDb} operazioni sul database.`);
    }
  }

  stampa(args, json = false) {
    if (this.output.length >= this.limiti.output) return;
    const riga = args.map((a) => (json ? JSON.stringify(semplifica(a), null, 2) : testo(a))).join(' ');
    this.output.push(riga);
  }

  /* --- Accesso al database --- */

  async leggi(db, coll, opz = {}) {
    this.contaChiamataDb();
    const payload = {
      filter: opz.filter ? aEjsonStr(opz.filter) : '',
      maxRows: this.limiti.docPerLettura,
    };
    if (opz.projection) payload.projection = aEjsonStr(opz.projection);
    if (opz.sort) payload.sort = aEjsonStr(opz.sort);
    if (opz.limit != null) payload.limit = Number(opz.limit);
    if (opz.skip != null) payload.skip = Number(opz.skip);
    const res = await this.host.find(db, coll, payload);
    const docs = (res && res.docs) || [];
    this.ultimiDocumenti = docs;
    return docs;
  }

  async aggrega(db, coll, pipeline, opz = {}) {
    this.contaChiamataDb();
    const stadi = aEjson(pipeline);
    if (!Array.isArray(stadi)) throw errore('aggregate() richiede un array di stadi.');
    const extra = [];
    if (opz.sort) extra.push({ $sort: aEjson(opz.sort) });
    if (opz.skip != null) extra.push({ $skip: Number(opz.skip) });
    if (opz.limit != null) extra.push({ $limit: Number(opz.limit) });
    const res = await this.host.aggregate(db, coll, {
      pipeline: JSON.stringify([...stadi, ...extra]),
      maxRows: this.limiti.docPerLettura,
    });
    const docs = (res && res.docs) || [];
    this.ultimiDocumenti = docs;
    return docs;
  }

  async conta(db, coll, filtro) {
    this.contaChiamataDb();
    const res = await this.host.count(db, coll, { filter: filtro ? aEjsonStr(filtro) : '{}' });
    return res && res.total != null ? res.total : 0;
  }

  async scrivi(db, coll, op, args) {
    this.contaChiamataDb();
    const payload = { op };
    if (args.doc !== undefined) payload.doc = aEjsonStr(args.doc);
    if (args.docs !== undefined) payload.docs = aEjsonStr(args.docs);
    if (args.filter !== undefined) payload.filter = aEjsonStr(args.filter === undefined ? {} : args.filter);
    if (args.update !== undefined) payload.update = aEjsonStr(args.update);
    if (args.options !== undefined) payload.options = aEjsonStr(args.options || {});
    const res = await this.host.write(db, coll, payload);
    return res || { ok: 1 };
  }

  /* --- Chiamate --- */

  async chiamaFunzione(fn, args) {
    if (fn && fn.__chiamabile) return fn.invoca(args);
    if (!fn || !fn.__funzione) throw errore('Valore non richiamabile: non è una funzione.');

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
        scope.dichiara(st.name, { __funzione: true, params: st.params, body: st.body, scope });
      }
    }
    for (const st of ast.body) {
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
            interno.dichiara(st.name, { __funzione: true, params: st.params, body: st.body, scope: interno });
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
          : (sorgente && typeof sorgente === 'object' && !sorgente.__host ? Object.keys(sorgente) : []);
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
              interno.dichiara(nodo.param, { message: err && err.message ? err.message : String(err) });
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
    if (v && v.__cursore) return v.materializza();
    if (v && typeof v === 'object' && v.__host) {
      throw errore('Questo oggetto non è iterabile: usa .toArray() oppure .forEach().', line);
    }
    throw errore('Il valore di "for…of" non è iterabile.', line);
  }

  /* --- Espressioni --- */

  async valuta(nodo, scope) {
    this.passo();
    switch (nodo.type) {
      case 'Num': case 'Str': case 'Bool': return nodo.value;
      case 'Null': return null;
      case 'Undef': return undefined;
      case 'Regex': return new RegExp(nodo.value.pattern, nodo.value.flags);

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
          out[chiave] = await this.valuta(p.value, scope);
        }
        return out;
      }

      case 'Func':
        return {
          __funzione: true,
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
        if (nome && Object.prototype.hasOwnProperty.call(this.globali, nome)) {
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
        return applicaBinario(nodo.op, a, b, nodo.line);
      }

      case 'Cond':
        return verita(await this.valuta(nodo.test, scope))
          ? this.valuta(nodo.cons, scope)
          : this.valuta(nodo.alt, scope);

      case 'Assign': {
        let valore = await this.valuta(nodo.value, scope);
        if (nodo.op !== '=') {
          const attuale = await this.valuta(nodo.target, scope);
          valore = applicaBinario(nodo.op[0], attuale, valore, nodo.line);
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
      if (obj.__host || obj.__funzione || obj.__chiamabile) {
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
  if (v && typeof v === 'object' && (v.__funzione || v.__chiamabile)) return 'function';
  return typeof v;
}

function applicaBinario(op, a, b, line) {
  switch (op) {
    case '+':
      if (typeof a === 'string' || typeof b === 'string') return testo(a) + testo(b);
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
function sembraScriptJs(code) {
  const s = String(code || '');
  // Costrutti che solo un vero script può contenere.
  if (/\b(var|let|const|function|if|for|while|do|try|return|throw)\b/.test(s)) return true;
  if (/=>/.test(s)) return true;
  return false;
}

module.exports = { eseguiScript, sembraScriptJs, Interprete, LIMITI_DEFAULT };
