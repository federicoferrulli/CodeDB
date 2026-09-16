'use strict';

/**
 * Il catalogo REALE di un database, nella forma che `db/exportPlan.js` sa
 * decidere: un elenco di oggetti e un elenco di dipendenze dichiarate.
 *
 * «Reale» è la parola che conta. `dbSchema` esiste già e restituisce anche le
 * relazioni, ma quelle relazioni sono in parte **indovinate** — a valle delle
 * chiavi esterne vere ci aggiunge `DbStrategy.detectRelations`, che deduce un
 * legame dal nome di una colonna. Va benissimo per disegnare un diagramma UML,
 * dove un'ipotesi sbagliata costa una freccia di troppo; qui costerebbe una
 * tabella esportata che nessuno ha chiesto, oppure — peggio, perché silenzioso
 * — la convinzione che il perimetro sia chiuso quando non lo è. §6.3 del piano
 * lo dice in una riga: il grafo si costruisce dagli oggetti reali del catalogo.
 *
 * Ogni motore dichiara le proprie query. Quello che NON si riesce a leggere non
 * diventa «nessuna dipendenza»: diventa una dipendenza **non deducibile**, che
 * il piano porta fino al report.
 */

const { tipoDb } = require('./artefatti');
const { readSchemaObjects } = require('./schemaObjects');

const id = (tipo, nome) => `${tipo}:${nome}`;

/* --- MySQL ---------------------------------------------------------------- */

async function catalogoMySql(q, db) {
  const oggetti = [];
  const dipendenze = [];

  const tabelle = await q(
    `SELECT TABLE_NAME AS name, TABLE_ROWS AS rows_approx
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
   ORDER BY TABLE_NAME`,
    [db],
  );
  for (const r of tabelle) {
    // `TABLE_ROWS` è una STIMA InnoDB, non un `COUNT(*)`: il piano la tratta
    // come tale, e `null` significa «non so», mai zero.
    oggetti.push({ tipo: 'tabella', nome: r.name, righeStimate: r.rows_approx == null ? null : Number(r.rows_approx) });
  }

  // Chiavi esterne dichiarate. `REFERENCED_TABLE_SCHEMA` si legge e non si dà
  // per uguale a `db`: una FK cross-database è un prerequisito esterno, non un
  // oggetto da tirare dentro.
  const fk = await q(
    `SELECT TABLE_NAME AS src, COLUMN_NAME AS col,
            REFERENCED_TABLE_SCHEMA AS ref_schema, REFERENCED_TABLE_NAME AS ref
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
   ORDER BY TABLE_NAME, COLUMN_NAME`,
    [db],
  );
  for (const r of fk) {
    const esterna = !!r.ref_schema && r.ref_schema !== db;
    dipendenze.push({
      da: id('tabella', r.src), a: id('tabella', r.ref), tipo: 'fk',
      campo: r.col, esterna, db: esterna ? r.ref_schema : null,
    });
  }
  return { oggetti, dipendenze, fkLette: true };
}

/**
 * Da quali tabelle dipende una view MySQL.
 *
 * `VIEW_TABLE_USAGE` esiste dal MySQL 8.0. Su un server più vecchio la query
 * fallisce, e l'unica alternativa sarebbe leggere il testo della view e
 * indovinare i nomi dal SQL — cioè esattamente ciò che questo modulo esiste per
 * non fare. Si dichiara quindi la dipendenza come non deducibile.
 */
async function vistePerMySql(q, db, viste) {
  if (!viste.length) return { dipendenze: [], nonDeducibili: [] };
  try {
    const righe = await q(
      `SELECT VIEW_NAME AS view_name, TABLE_SCHEMA AS ref_schema, TABLE_NAME AS ref
         FROM information_schema.VIEW_TABLE_USAGE
        WHERE VIEW_SCHEMA = ?
     ORDER BY VIEW_NAME, TABLE_NAME`,
      [db],
    );
    return {
      dipendenze: righe.map((r) => ({
        da: id('vista', r.view_name),
        a: id('tabella', r.ref),
        tipo: 'vista',
        esterna: !!r.ref_schema && r.ref_schema !== db,
        db: r.ref_schema && r.ref_schema !== db ? r.ref_schema : null,
      })),
      nonDeducibili: [],
    };
  } catch (err) {
    return {
      dipendenze: [],
      nonDeducibili: viste.map((nome) => ({
        da: id('vista', nome), tipo: 'vista',
        nota: `dipendenze della view non leggibili su questo server (${err.message})`,
      })),
    };
  }
}

/* --- PostgreSQL ----------------------------------------------------------- */

async function catalogoPostgres(q, schema) {
  const oggetti = [];
  const dipendenze = [];

  const tabelle = await q(
    `SELECT c.relname AS name,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS rows_approx
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
   ORDER BY c.relname`,
    [schema],
  );
  for (const r of tabelle.rows) {
    // `reltuples = -1` prima di un ANALYZE significa «non lo so»: la query lo
    // traduce in NULL, e nascondere una tabella piena sarebbe molto peggio che
    // mostrarne una vuota.
    oggetti.push({ tipo: 'tabella', nome: r.name, righeStimate: r.rows_approx == null ? null : Number(r.rows_approx) });
  }

  const fk = await q(
    `SELECT src.relname AS src, tgt.relname AS ref, tgtns.nspname AS ref_schema,
            (SELECT a.attname FROM pg_catalog.pg_attribute a
              WHERE a.attrelid = con.conrelid AND a.attnum = con.conkey[1]) AS col
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class src ON src.oid = con.conrelid
       JOIN pg_catalog.pg_namespace srcns ON srcns.oid = src.relnamespace
       JOIN pg_catalog.pg_class tgt ON tgt.oid = con.confrelid
       JOIN pg_catalog.pg_namespace tgtns ON tgtns.oid = tgt.relnamespace
      WHERE con.contype = 'f' AND srcns.nspname = $1
   ORDER BY src.relname, con.conname`,
    [schema],
  );
  for (const r of fk.rows) {
    const esterna = r.ref_schema !== schema;
    dipendenze.push({
      da: id('tabella', r.src), a: id('tabella', r.ref), tipo: 'fk',
      campo: r.col, esterna, db: esterna ? r.ref_schema : null,
    });
  }

  // Da che cosa dipende una view: `pg_depend` sulle regole di riscrittura. È la
  // dipendenza REALE registrata dal catalogo, non una lettura del testo.
  const viste = await q(
    `SELECT DISTINCT v.relname AS view_name, d.relname AS ref, dns.nspname AS ref_schema,
            d.relkind AS ref_kind
       FROM pg_catalog.pg_depend dep
       JOIN pg_catalog.pg_rewrite rw ON rw.oid = dep.objid
       JOIN pg_catalog.pg_class v ON v.oid = rw.ev_class
       JOIN pg_catalog.pg_namespace vns ON vns.oid = v.relnamespace
       JOIN pg_catalog.pg_class d ON d.oid = dep.refobjid
       JOIN pg_catalog.pg_namespace dns ON dns.oid = d.relnamespace
      WHERE dep.classid = 'pg_rewrite'::regclass
        AND dep.refclassid = 'pg_class'::regclass
        AND v.relkind IN ('v', 'm') AND vns.nspname = $1 AND d.oid <> v.oid
   ORDER BY v.relname, d.relname`,
    [schema],
  );
  for (const r of viste.rows) {
    const esterna = r.ref_schema !== schema;
    dipendenze.push({
      da: id('vista', r.view_name),
      a: id(r.ref_kind === 'v' || r.ref_kind === 'm' ? 'vista' : 'tabella', r.ref),
      tipo: 'vista', esterna, db: esterna ? r.ref_schema : null,
    });
  }

  // Sequenze INDIPENDENTI possedute da nessuno: quelle possedute da una colonna
  // le ricrea il tipo `serial`/identity della CREATE TABLE, quindi non sono
  // oggetti a sé e non generano un arco.
  const seq = await q(
    `SELECT s.relname AS seq, t.relname AS tabella
       FROM pg_catalog.pg_class s
       JOIN pg_catalog.pg_namespace n ON n.oid = s.relnamespace
       JOIN pg_catalog.pg_depend d ON d.objid = s.oid AND d.deptype = 'a'
       JOIN pg_catalog.pg_class t ON t.oid = d.refobjid
      WHERE s.relkind = 'S' AND n.nspname = $1
   ORDER BY s.relname`,
    [schema],
  );
  const possedute = new Set(seq.rows.map((r) => r.seq));
  return { oggetti, dipendenze, possedute };
}

/* --- MongoDB -------------------------------------------------------------- */

function catalogoMongo(infos, conteggi) {
  const oggetti = [];
  const dipendenze = [];
  for (const info of infos) {
    if (info.type === 'view') {
      oggetti.push({ tipo: 'vista', nome: info.name });
      const su = info.options && info.options.viewOn;
      // Una view MongoDB dichiara la propria sorgente: è una dipendenza reale,
      // non un'ipotesi. La pipeline può però leggere altre collection con
      // `$lookup`, e quello il catalogo non lo dice.
      if (su) dipendenze.push({ da: id('vista', info.name), a: id('collection', su), tipo: 'vista' });
      const lookup = JSON.stringify((info.options && info.options.pipeline) || []).includes('"$lookup"');
      if (lookup) {
        dipendenze.push({
          da: id('vista', info.name), a: null, tipo: 'lookup',
          nota: 'la pipeline della view usa $lookup: le collection lette non sono dichiarate dal catalogo',
        });
      }
      continue;
    }
    oggetti.push({
      tipo: 'collection', nome: info.name,
      righeStimate: conteggi && conteggi.has(info.name) ? conteggi.get(info.name) : null,
    });
  }
  // MongoDB non dichiara chiavi esterne: i riferimenti applicativi esistono ma
  // non sono nel catalogo, e inventarli qui sarebbe la stessa euristica che
  // questo modulo rifiuta.
  return { oggetti, dipendenze };
}

/* --- Composizione --------------------------------------------------------- */

/**
 * Legge il catalogo di un database e lo restituisce nella forma del piano.
 *
 * @param {object} strategy adattatore già connesso
 * @param {string} dbType   motore
 * @param {string} db       database (schema, su PostgreSQL)
 */
async function leggiCatalogoExport(strategy, dbType, db) {
  const tipo = tipoDb(dbType);
  const oggettiSchema = await readSchemaObjects(strategy, tipo, db);
  let base;
  let nonDeducibili = [];

  if (tipo === 'mysql') {
    const conn = await strategy.pool.getConnection();
    try {
      const q = async (sql, params) => (await conn.query(sql, params))[0];
      base = await catalogoMySql(q, db);
      const viste = await vistePerMySql(q, db, (oggettiSchema.views || []).map((v) => v.name));
      base.dipendenze.push(...viste.dipendenze);
      nonDeducibili = viste.nonDeducibili;
    } finally { conn.release(); }
  } else if (tipo === 'postgresql') {
    const client = await strategy.pool.connect();
    try {
      base = await catalogoPostgres((sql, params) => client.query(sql, params), db);
    } finally { client.release(); }
  } else if (tipo === 'mongodb') {
    const infos = await strategy.client.db(db).listCollections().toArray();
    const conteggi = new Map();
    for (const info of infos) {
      if (info.type === 'view') continue;
      // Stima, non conteggio: `estimatedDocumentCount` legge i metadati e non
      // scorre la collection. In «solo struttura» il piano non la userà
      // nemmeno, ma il catalogo si legge una volta sola.
      conteggi.set(info.name, await strategy.client.db(db).collection(info.name).estimatedDocumentCount());
    }
    base = catalogoMongo(infos, conteggi);
  } else {
    throw new Error(`Motore non supportato per il catalogo di export: ${dbType}.`);
  }

  const oggetti = [...base.oggetti];
  const dipendenze = [...base.dipendenze];

  // Gli oggetti non-tabella arrivano dallo stesso inventario che usa il backup:
  // un secondo lettore qui vorrebbe dire due cataloghi che possono divergere.
  for (const vista of oggettiSchema.views || []) {
    if (!oggetti.some((o) => o.tipo === 'vista' && o.nome === vista.name)) {
      oggetti.push({ tipo: 'vista', nome: vista.name });
    }
  }
  for (const routine of oggettiSchema.routines || []) {
    oggetti.push({ tipo: 'routine', nome: routine.name });
    // Il corpo di una routine può comporre SQL a runtime: quelle dipendenze
    // nessun catalogo le conosce, e darle per assenti è la scorciatoia che
    // produce un perimetro incompleto dichiarato completo.
    dipendenze.push({
      da: id('routine', routine.name), a: null, tipo: 'dinamica',
      nota: 'il corpo della routine può riferire oggetti non deducibili dal catalogo',
    });
  }
  for (const trigger of oggettiSchema.triggers || []) {
    oggetti.push({ tipo: 'trigger', nome: trigger.name, tabella: trigger.table || null });
    if (trigger.table) {
      dipendenze.push({ da: id('trigger', trigger.name), a: id('tabella', trigger.table), tipo: 'trigger' });
    }
  }
  for (const evento of oggettiSchema.events || []) {
    oggetti.push({ tipo: 'evento', nome: evento.name });
  }
  for (const sequenza of oggettiSchema.sequences || []) {
    oggetti.push({ tipo: 'sequenza', nome: sequenza.name });
  }

  return {
    dbType: tipo,
    db,
    oggetti,
    dipendenze: [...dipendenze, ...nonDeducibili],
    // Ciò che il catalogo NON copre affatto, dichiarato una volta sola invece
    // che scoperto dall'errore del motore al ripristino. La matrice di fedeltà
    // tiene l'elenco completo; qui c'è la parte che riguarda il perimetro.
    fuoriCopertura: tipo === 'postgresql'
      ? ['tipi definiti dall utente', 'estensioni', 'policy RLS', 'owner e ACL', 'large object']
      : (tipo === 'mongodb' ? ['sharding', 'indici di servizi esterni'] : []),
  };
}

module.exports = {
  leggiCatalogoExport,
  catalogoMySql,
  catalogoPostgres,
  catalogoMongo,
  vistePerMySql,
};
