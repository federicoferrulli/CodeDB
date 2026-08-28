'use strict';

/* ---------------------------------------------------------------------------
 * I metadati comuni ai due motori SQL.
 *
 * Dopo il tabellare (db/sqlTabellare.js) restano gli altri metodi che i due
 * adattatori implementano con lo STESSO nome e la stessa forma di risultato:
 * la paginazione a chiave, le informazioni sulle colonne, l'elenco dei campi,
 * gli indici (unici e non), la chiave primaria, il conteggio stimato ed esatto.
 *
 * A differenza dei quattro del tabellare questi non erano copie identiche:
 * divergevano su dettagli di dialetto — il segnaposto dei parametri, la query
 * al catalogo, il modo di riconoscere una colonna auto-incrementale. Ma la
 * DECISIONE era la stessa in entrambi, e stava scritta due volte: la stima
 * delle righe è «chiedi al catalogo, se non è attendibile torna null e lascia
 * che il chiamante conti davvero» tanto su MySQL quanto su PostgreSQL. La
 * prova che non fossero davvero gemelli era che `estimatedRowCount` prendeva
 * `(db, coll)` su un motore e `(coll, db)` sull'altro — due significati
 * opposti per la stessa posizione, che nessun test poteva vedere.
 *
 * Le differenze non spariscono: diventano DATI. Ogni adattatore dichiara un
 * dialetto — le query al catalogo, come si legge una riga di quelle query,
 * come si scrive un segnaposto — e questo modulo tiene la logica, una volta
 * sola. Un ramo `if (motore === 'mysql')` dentro il corpo sarebbe stata la
 * stessa duplicazione, solo spostata. L'unico pezzo di dialetto che resta una
 * FUNZIONE è `colonne.arricchisci`: non è una query in più con altri nomi, è un
 * secondo passo che esiste solo su PostgreSQL (il SRID dalle viste PostGIS) e
 * che deve poter fallire senza fermare la lettura.
 *
 * I metodi sono legati all'istanza della strategia (`this`): usano
 * `this._cacheColonne`, `this.buildSelect`, `this.countWithTimeout`, cioè lo
 * stato e i pezzi di dialetto che restano dell'adattatore. Si provano senza
 * database mettendo un pool finto al posto di quello vero
 * (`test/unit-sql-metadati.js`).
 *
 * Resta fuori ciò che diverge davvero: scrittura degli identificatori, tipi di
 * colonna, DDL, geometrie, sessioni e lock.
 * ------------------------------------------------------------------------- */

const { parseClientValue, toSqlValue } = require('./sqlValori');
const { potaCache } = require('./geometry');

// Durata della cache dei metadati di colonna. Breve di proposito: una ALTER
// TABLE fatta da fuori si riflette al più tardi dopo questo intervallo, quelle
// fatte da qui svuotano la cache subito.
const META_CACHE_MS = 15000;

function chiaveColonne(dialetto, db, coll) {
  // Separatore NUL: un carattere che in un nome di schema o di tabella non può
  // comparire, quindi due coppie diverse non possono collidere nella cache.
  return `${dialetto.schema(db)}\u0000${coll}`;
}

/* --- Paginazione a chiave (seek) ------------------------------------------ */

// Costruisce la query keyset per la paginazione oppure ritorna null se non
// applicabile (nessun keyset richiesto, sort personalizzato, o chiave non a
// colonna singola) e il chiamante usa OFFSET. Il filtro utente (WHERE) viene
// combinato in AND con il vincolo sul cursore. L'unica differenza fra i due
// motori è il segnaposto: `?` su MySQL, `$n` su PostgreSQL.
function componiKeyset(dialetto, payload, table, whereSql, limit, pk, selectList = '*', whereParams = []) {
  const { qid, segnaposto } = dialetto;
  const ks = payload && payload.keyset;
  if (!ks) return null;
  if (String(payload.sort || '').trim()) return null; // sort personalizzato: OFFSET
  if (!pk || pk.length !== 1) return null;            // chiave composita/assente: OFFSET
  const col = pk[0];
  const conds = [];
  // I parametri del WHERE precedono cursore e limite. Per PostgreSQL la loro
  // quantità determina anche da quale $n deve proseguire la keyset; per MySQL
  // ne preserva semplicemente l'ordine dei `?`.
  const params = [...(whereParams || [])];
  // Il segnaposto va calcolato PRIMA di aggiungere il parametro: su PostgreSQL
  // il numero è la posizione che quel parametro sta per occupare.
  const prossimo = () => segnaposto(params.length + 1);
  if (whereSql) conds.push(`(${whereSql.replace(/^\s*WHERE\s+/i, '')})`); // filtro utente
  let dir = 'ASC', reverse = false;
  if (ks.after != null) {
    conds.push(`${qid(col)} > ${prossimo()}`); params.push(valoreKeyset(ks.after, col));
  } else if (ks.from != null) {
    // Refresh in place: pagina corrente a partire (incluso) dal primo id noto.
    conds.push(`${qid(col)} >= ${prossimo()}`); params.push(valoreKeyset(ks.from, col));
  } else if (ks.before != null) {
    conds.push(`${qid(col)} < ${prossimo()}`); params.push(valoreKeyset(ks.before, col));
    dir = 'DESC'; reverse = true;
  }
  // ks.first (o nessun estremo): prima pagina, solo ORDER BY pk ASC.
  const whereClause = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const sql = `SELECT ${selectList} FROM ${table}${whereClause} ORDER BY ${qid(col)} ${dir} LIMIT ${prossimo()}`;
  params.push(limit);
  return { sql, params, reverse };
}

// Estrae il valore della chiave dal cursore inviato dal client: è l'_id della
// riga (JSON.stringify di `{ colonna: valore }`) oppure il valore scalare.
// Nessun dialetto: è il protocollo del client (vedi db/sqlValori.js).
function valoreKeyset(rawId, col) {
  const parsed = parseClientValue(rawId);
  const v = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !parsed._bsontype)
    ? parsed[col] : parsed;
  return toSqlValue(v);
}

/* --- Lettura del catalogo --------------------------------------------------- */

// Alcune colonne del catalogo esistono solo da una certa versione del server
// (`SRS_ID` da MySQL 8): il dialetto dichiara i tentativi in ordine di
// preferenza e si usa il primo che il server accetta. Se falliscono tutti
// l'errore che risale è quello dell'ultimo, cioè del tentativo più prudente.
async function eseguiTentativi(dialetto, strategia, tentativi) {
  if (!tentativi || !tentativi.length) throw new Error('Dialetto SQL: nessuna query dichiarata.');
  let ultimo;
  for (const t of tentativi) {
    try {
      return await dialetto.esegui(strategia, t.sql, t.params);
    } catch (err) {
      ultimo = err;
    }
  }
  throw ultimo;
}

/* --- Chiave primaria ------------------------------------------------------ */

// Colonne della chiave primaria, nell'ordine della definizione. Entrambe le
// query del catalogo espongono la colonna come `name`.
async function chiavePrimaria(dialetto, strategia, db, table) {
  const { sql, params } = dialetto.chiavePrimaria.query(db, table);
  const rows = await dialetto.esegui(strategia, sql, params);
  return rows.map((r) => r.name);
}

/* --- Informazioni sulle colonne ------------------------------------------- */

// Colonne della tabella con tipo (e, dove serve, SRID), in cache breve perché
// ogni lettura di dati le richiede. Le query al catalogo e l'eventuale
// arricchimento sono del dialetto; la cache, la forma del risultato e la
// classificazione per tipo sono qui.
async function infoColonne(dialetto, strategia, db, coll) {
  const chiave = chiaveColonne(dialetto, db, coll);
  const ora = Date.now();
  const cache = strategia._cacheColonne;
  const hit = cache.get(chiave);
  if (hit && hit.scade > ora) return hit.info;

  const d = dialetto.colonne;
  const rows = await eseguiTentativi(dialetto, strategia, d.tentativi(db, coll));
  const visibile = d.visibile || (() => true);
  const classi = d.classi || [];
  const info = {
    columns: rows.filter(visibile).map((r) => ({
      name: r.name,
      type: r.type,
      declaredType: r.declaredType || r.type,
      srid: r.srid == null ? null : Number(r.srid),
      // I due cataloghi rispondono 'YES'/'NO'; qui diventa un booleano.
      // `undefined` quando il dialetto non lo chiede: chi legge deve poter
      // distinguere «ammette NULL» da «non lo so», perche' decidere come
      // ordinare i nulli in base a un'ipotesi e' peggio che non decidere.
      nullable: r.nullable == null ? undefined : /^y/i.test(String(r.nullable)),
      // Colonna calcolata dal motore: nominarla in un INSERT e' un errore.
      // Viaggia con le colonne che si leggevano gia', come `nullable`: sapere
      // quali colonne si possono SCRIVERE non costa una lettura di catalogo in
      // piu' — e questa lettura e' in cache, mentre l'elenco dei campi no.
      generated: d.generato ? !!d.generato(r) : false,
    })),
  };
  // Le classi sono dichiarate dal dialetto e valutate NELL'ORDINE dichiarato:
  // su PostgreSQL un tipo geometrico nativo (point, polygon) non è una
  // geometria PostGIS, e la prima classe che riconosce il tipo se lo prende.
  for (const classe of classi) info[classe.nome] = new Map();
  for (const c of info.columns) {
    for (const classe of classi) {
      if (classe.riconosce(c.type)) { info[classe.nome].set(c.name, c); break; }
    }
  }
  if (d.arricchisci) await d.arricchisci(strategia, info, db, coll);

  cache.set(chiave, { info, scade: ora + META_CACHE_MS });
  potaCache(cache);
  return info;
}

/* --- Elenco dei campi ----------------------------------------------------- */

// Descrittori di colonna nella forma che usano la vista Dettagli e la
// duplicazione (db/duplica.js). Nome, nullabilità e default si leggono allo
// stesso modo sui due motori; tipo, auto-incremento, colonna calcolata e
// appartenenza alla chiave sono letture dichiarate dal dialetto.
async function elencoCampi(dialetto, strategia, db, table) {
  const d = dialetto.campi;
  const { sql, params } = d.query(db, table);
  // Su PostgreSQL l'appartenenza alla chiave primaria non sta nella stessa
  // query (information_schema.columns non la espone): serve una seconda
  // lettura, dichiarata dal dialetto e fatta in parallelo. Su MySQL
  // COLUMN_KEY ce l'ha già, e quel round trip non si paga.
  const [rows, pk] = await Promise.all([
    dialetto.esegui(strategia, sql, params),
    d.chiaveDallaPrimaria ? strategia.primaryKey(db, table) : Promise.resolve(null),
  ]);
  const pkSet = new Set(pk || []);
  return rows.map((c) => ({
    name: c.name,
    types: [d.tipo(c)],
    presence: c.nullable === 'YES' ? 0 : 100, // 100 = NOT NULL
    nullable: c.nullable === 'YES',
    default: c.cdefault == null ? null : String(c.cdefault),
    autoIncrement: d.autoIncrement(c),
    generated: d.generato(c),
    key: d.chiave(c, pkSet),
  }));
}

/**
 * I nomi delle colonne che si possono SCRIVERE.
 *
 * Una colonna generata (`GENERATED ALWAYS AS` su MySQL, `GENERATED ALWAYS AS
 * ... STORED` su PostgreSQL) è calcolata dal motore: nominarla in un `INSERT`
 * non è un valore in più, è un errore — MySQL risponde «The value specified for
 * generated column ... is not allowed» e PostgreSQL «cannot insert into column».
 * L'export di un intero database la leggeva con `SELECT *` e l'import la
 * riscriveva, quindi OGNI riga veniva rifiutata e l'import falliva su qualunque
 * tabella con una colonna calcolata. Il motore di backup la escludeva già: qui
 * la stessa regola diventa una sola, dichiarata dal dialetto, che export e
 * import condividono.
 *
 * Non si perde nulla: il valore di una colonna generata lo ricalcola il
 * database dalla definizione, che viaggia nel DDL.
 */
async function colonneScrivibili(_dialetto, strategia, db, coll) {
  // Passa dal METODO, non dalla funzione: `tableColumnsInfo` e' il punto in cui
  // un test mette il proprio catalogo, e scavalcarlo significherebbe leggere il
  // database vero da sotto a chi credeva di averlo sostituito.
  const info = await strategia.tableColumnsInfo(db, coll);
  return new Set(info.columns.filter((c) => !c.generated).map((c) => c.name));
}

/**
 * Snapshot dei metadati usati dall'export JSON a blocchi.
 *
 * La cache generale delle colonne scade dopo pochi secondi, correttamente per
 * la griglia: una ALTER TABLE eseguita fuori da CodeDB deve diventare visibile.
 * Un export, invece, può impiegare più di quella finestra per leggere una sola
 * pagina. La prima pagina rinnova quindi lo snapshot; le continuazioni della
 * stessa tabella lo riusano senza tornare su information_schema. Le DDL delle
 * strategie svuotano già `_cacheColonne`, e `potaCache` ne limita la crescita.
 */
async function metadatiEsportazione(dialetto, strategia, db, coll, nuovaEsportazione) {
  const chiave = `export\u0000${chiaveColonne(dialetto, db, coll)}`;
  const cache = strategia._cacheColonne;
  const hit = cache.get(chiave);
  if (!nuovaEsportazione && hit && hit.metadatiEsportazione) {
    return hit.metadatiEsportazione;
  }

  const info = await strategia.tableColumnsInfo(db, coll);
  const metadati = {
    info,
    scrivibili: new Set(info.columns.filter((c) => !c.generated).map((c) => c.name)),
  };
  cache.set(chiave, { metadatiEsportazione: metadati, scade: Infinity });
  potaCache(cache);
  return metadati;
}

/* --- Indici --------------------------------------------------------------- */

/**
 * Righe di catalogo (una per colonna dell'indice) in elenco di indici con le
 * colonne nell'ordine della definizione. Entrambi i motori restituiscono
 * l'indice spezzato in righe con un ordinale; cambiano solo i nomi delle
 * colonne del risultato, che il dialetto dichiara in `lettori`.
 * Le colonne assenti (indici su espressione, su PostgreSQL) lasciano un buco,
 * che viene tolto: non sono chiavi su cui si possa ragionare.
 */
function raggruppaIndici(rows, lettori) {
  const perNome = new Map();
  for (const r of rows) {
    const nome = lettori.nome(r);
    let voce = perNome.get(nome);
    if (!voce) {
      voce = { name: nome, columns: [], unique: !!lettori.unico(r), primary: !!lettori.primario(r) };
      perNome.set(nome, voce);
    }
    const col = lettori.colonna(r);
    const ord = Number(lettori.ordine(r)) || voce.columns.length + 1;
    if (col) voce.columns[ord - 1] = col;
  }
  for (const voce of perNome.values()) voce.columns = voce.columns.filter(Boolean);
  return [...perNome.values()];
}

// Tutti gli indici della tabella, unici e non, nella forma normalizzata
// { name, columns, unique, primary }.
async function elencoIndici(dialetto, strategia, db, table) {
  const d = dialetto.indici;
  const { sql, params } = d.query(db, table);
  const rows = await dialetto.esegui(strategia, sql, params);
  return raggruppaIndici(rows, d.lettori);
}

/**
 * Indici unici NON primari, come liste di colonne. La chiave primaria resta
 * fuori: ha una sua strada nella duplicazione (vedi db/duplica.js).
 */
async function indiciUnici(dialetto, strategia, db, table) {
  let elenco;
  try {
    elenco = await elencoIndici(dialetto, strategia, db, table);
  } catch (err) {
    // Su MySQL `SHOW INDEX` fallisce sulle viste, che indici non ne hanno: il
    // dialetto lo dichiara, e lì l'assenza di indici non è un errore.
    if (dialetto.indici.assentiSeErrore) return [];
    throw err;
  }
  return elenco.filter((i) => i.unique && !i.primary).map((i) => i.columns);
}

/* --- Conteggio ------------------------------------------------------------ */

// Stima (approssimata) delle righe dal catalogo, senza scansione. Se il
// catalogo non ha un valore attendibile si torna null e il chiamante conta
// davvero. Un errore qui non è un errore per l'utente: la stima è un
// acceleratore, non un risultato.
async function stimaRighe(dialetto, strategia, db, coll) {
  const d = dialetto.stima;
  try {
    const { sql, params } = d.query(db, coll);
    const rows = await dialetto.esegui(strategia, sql, params);
    const grezzo = rows && rows[0] ? rows[0].n : null;
    if (grezzo == null) return null;
    const n = Number(grezzo);
    return d.attendibile(n) ? n : null;
  } catch (_) {
    return null;
  }
}

// Conteggio disaccoppiato richiesto dalla griglia (evento collection:count).
// Senza filtro si usa la stima istantanea del catalogo invece di un COUNT(*)
// che scansiona l'intera tabella: è ciò che fanno DBeaver/phpMyAdmin. La stima
// vale solo se > 0 — su tabella vuota o mai analizzata è inaffidabile, e lì il
// COUNT(*) esatto è comunque istantaneo. Con filtro resta il COUNT(*) esatto
// con tetto di tempo, che è l'unico pezzo rimasto all'adattatore.
async function conteggioCollezione(strategia, db, coll, payload) {
  let opzioni = {};
  if (payload && payload.cercaOvunque != null && typeof strategia._preparaRicercaGlobale === 'function') {
    const { columns: colonne } = await strategia.tableColumnsInfo(db, coll);
    const ricercaGlobale = await strategia._preparaRicercaGlobale(db, coll, payload, colonne);
    opzioni = { colonne, ricercaGlobale };
  }
  const { table, whereSql, whereParams } = strategia.buildSelect(db, coll, payload, opzioni);
  if (!whereSql) {
    const est = await strategia.estimatedRowCount(db, coll);
    if (est != null && est > 0) return { total: est, timedOut: false, approx: true };
  }
  // I parametri viaggiano con la clausola: col filtro strutturato la clausola
  // da sola contiene segnaposto senza valori.
  return strategia.countWithTimeout(table, whereSql, whereParams);
}

/* --- Installazione sul prototipo ------------------------------------------ */

const RICHIESTI = ['qid', 'segnaposto', 'schema', 'esegui', 'chiavePrimaria', 'colonne', 'campi', 'indici', 'stima'];

function metodi(dialetto) {
  for (const chiave of RICHIESTI) {
    if (!dialetto || dialetto[chiave] == null) {
      throw new Error(`Dialetto SQL incompleto: manca "${chiave}".`);
    }
  }
  return {
    buildKeyset(payload, table, whereSql, limit, pk, selectList = '*', whereParams = []) {
      return componiKeyset(dialetto, payload, table, whereSql, limit, pk, selectList, whereParams);
    },
    keysetValue(rawId, col) {
      return valoreKeyset(rawId, col);
    },
    primaryKey(db, table) {
      return chiavePrimaria(dialetto, this, db, table);
    },
    tableColumnsInfo(db, coll) {
      return infoColonne(dialetto, this, db, coll);
    },
    tableFields(db, table) {
      return elencoCampi(dialetto, this, db, table);
    },
    colonneScrivibili(db, coll) {
      return colonneScrivibili(dialetto, this, db, coll);
    },
    metadatiEsportazione(db, coll, nuovaEsportazione) {
      return metadatiEsportazione(dialetto, this, db, coll, nuovaEsportazione);
    },
    elencoIndici(db, table) {
      return elencoIndici(dialetto, this, db, table);
    },
    uniqueIndexes(db, table) {
      return indiciUnici(dialetto, this, db, table);
    },
    estimatedRowCount(db, coll) {
      return stimaRighe(dialetto, this, db, coll);
    },
    collectionCount(db, coll, payload) {
      return conteggioCollezione(this, db, coll, payload);
    },
  };
}

/**
 * Installa i metodi comuni sul prototipo di un adattatore SQL, legati al
 * dialetto dichiarato dall'adattatore stesso.
 *
 * Sono definiti NON enumerabili, come lo sono i metodi di una classe: un
 * `Object.assign` li avrebbe resi enumerabili, cioè avrebbe fatto comparire
 * otto nomi in ogni `for...in` su una strategia. Oggi nessuno enumera le
 * strategie, ma la differenza sarebbe stata un effetto collaterale del modo in
 * cui il codice è organizzato, non una scelta.
 */
function installaMetadati(prototipo, dialetto) {
  const descrittori = {};
  for (const [nome, fn] of Object.entries(metodi(dialetto))) {
    descrittori[nome] = { value: fn, writable: true, enumerable: false, configurable: true };
  }
  Object.defineProperties(prototipo, descrittori);
  return prototipo;
}

module.exports = {
  installaMetadati,
  // Esportate a parte perché sono pure e provate direttamente: il resto della
  // logica si raggiunge dai metodi installati.
  componiKeyset,
  raggruppaIndici,
};
