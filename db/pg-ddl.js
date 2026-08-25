'use strict';

/* ---------------------------------------------------------------------------
 * Lettura dello schema PostgreSQL: DDL fedele, oggetti e metadati di colonna.
 *
 * Esiste per una ragione precisa (CDB-A87): la stessa logica era scritta DUE
 * volte — in `PostgreSqlStrategy.tableDdl`, per l'export/import, e in
 * `pgTableDdl` dentro il motore di backup. Correggendo la prima (CDB-A83) le
 * due sono divergute, e il backup ha continuato a produrre DDL rotte mentre
 * l'export/import era già a posto. Due copie della stessa conoscenza si
 * separano sempre: la domanda è solo quando ce ne si accorge.
 *
 * Ogni funzione riceve un ESECUTORE `q(sql, params) -> { rows }` invece di un
 * pool o di un client. È ciò che permette ai due chiamanti di usare la propria
 * connessione: il motore di backup deve leggere lo schema dallo STESSO client
 * della snapshot, altrimenti un DDL concorrente gli farebbe descrivere una
 * tabella diversa da quella di cui sta salvando i dati.
 *
 * Le definizioni si prendono dalle funzioni di catalogo (`pg_get_constraintdef`,
 * `pg_get_indexdef`, `pg_get_expr`) e non si ricostruiscono a mano: sono la
 * stessa fonte che usa `pg_dump`, e conservano UNIQUE parziali, espressioni
 * CHECK, operator class e clausole che una ricostruzione dimentica sempre.
 * ------------------------------------------------------------------------- */

const { isPostgresNativeGeometryType } = require('./geometry');
// La quotatura degli identificatori e' una regola sola per tutto il repo: vedi
// db/identificatori.js.
const { quotaSempre } = require('./identificatori');

function qid(name) {
  return quotaSempre(name, 'postgresql');
}

// Tipo seriale equivalente per una colonna con default `nextval(...)`. I nomi a
// sinistra sono quelli restituiti da `format_type`, non gli alias SQL.
const SERIAL_PER_TIPO = {
  smallint: 'smallserial',
  integer: 'serial',
  bigint: 'bigserial',
};

// Tipi che il driver `pg` consegna come Buffer: come su MySQL, un Buffer non
// sopravvive al giro EJSON del file NDJSON e va letto in esadecimale.
const TIPI_BINARI_PG = new Set(['bytea']);

// Tipi temporali: il driver li converte in Date di JavaScript, che ha
// risoluzione al millisecondo e reinterpreta il fuso. `::text` li lascia
// esattamente come sono nel database, microsecondi compresi.
const TIPI_TEMPORALI_PG = new Set([
  'timestamp without time zone', 'timestamp with time zone',
  'time without time zone', 'time with time zone', 'date', 'interval',
]);

/**
 * Colonne di una tabella, con tutto ciò che serve a ricrearle e a leggerle.
 *
 * @param {(sql: string, params: any[]) => Promise<{rows: any[]}>} q
 * @returns {Promise<Array<{name, ctype, notnull, cdefault, identity, generated}>>}
 */
async function pgColonne(q, schema, table) {
  const res = await q(
    `SELECT a.attname AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS ctype,
            a.attnotnull AS notnull,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS cdefault,
            a.attidentity AS identity,
            a.attgenerated AS generated
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2
        AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY a.attnum`,
    [schema, table],
  );
  return res.rows.map((r) => ({
    name: r.name,
    ctype: String(r.ctype || 'text'),
    notnull: r.notnull === true || r.notnull === 't',
    cdefault: r.cdefault == null ? null : String(r.cdefault),
    // 'a' = GENERATED ALWAYS AS IDENTITY, 'd' = BY DEFAULT, '' = non identità
    identity: r.identity === 'a' ? 'ALWAYS' : (r.identity === 'd' ? 'BY DEFAULT' : null),
    // 's' = STORED generated. PostgreSQL non ha ancora colonne VIRTUAL.
    generated: r.generated === 's',
  }));
}

/**
 * Come leggere le colonne senza perdere nulla, e quali NON leggere affatto.
 *
 * Le colonne generate si escludono: sono derivate, PostgreSQL rifiuta un INSERT
 * che le valorizzi, e la destinazione le ricalcola dalla CREATE TABLE.
 *
 * @returns {Promise<{nomi: string[], columnSchema: object[], binarie: Set<string>, select: string}>}
 */
async function pgColonneDaSalvare(q, schema, table) {
  const colonne = await pgColonne(q, schema, table);
  const salvabili = colonne.filter((c) => !c.generated);
  const binarie = new Set();
  const pezzi = [];
  for (const c of salvabili) {
    const id = qid(c.name);
    const base = String(c.ctype).replace(/\(.*$/, '').trim().toLowerCase();
    if (TIPI_BINARI_PG.has(base)) {
      binarie.add(c.name);
      pezzi.push(`encode(${id}, 'hex') AS ${id}`);
    } else if (TIPI_TEMPORALI_PG.has(base) || TIPI_TEMPORALI_PG.has(String(c.ctype).toLowerCase())) {
      pezzi.push(`${id}::text AS ${id}`);
    } else if (isPostgresNativeGeometryType(base)) {
      // Tipi geometrici NATIVI di PostgreSQL (point, box, circle…): il driver
      // li consegna come oggetti ({x, y}) che non si possono reinserire, come
      // le geometrie di MySQL. Non sono PostGIS, quindi non c'è ST_AsBinary:
      // la loro forma testuale — `(1,2)` — è però esatta e riconvertibile,
      // perché PostgreSQL la accetta in scrittura con un cast implicito.
      pezzi.push(`${id}::text AS ${id}`);
    } else {
      pezzi.push(id);
    }
  }
  return {
    nomi: salvabili.map((c) => c.name),
    columnSchema: salvabili.map((c) => ({
      name: c.name,
      type: String(c.ctype).toLowerCase(),
      nullable: !c.notnull,
    })),
    binarie,
    select: pezzi.join(', '),
  };
}

/**
 * CREATE TABLE fedele: colonne, identità, generate, PRIMARY KEY, UNIQUE, CHECK.
 *
 * Le chiavi esterne NON sono qui: vanno applicate quando tutte le tabelle
 * esistono e i dati sono caricati (vedi `pgAuxDdl`).
 *
 * @param {{qualificato?: boolean}} opts qualificare col nome dello schema. Il
 *   backup lo fa (ripristina in uno schema noto e lo riscrive); l'export/import
 *   no, perché conta sul `search_path` per il retarget.
 */
async function pgCreateTable(q, schema, table, { qualificato = false } = {}) {
  const colonne = await pgColonne(q, schema, table);
  if (!colonne.length) return null;

  const defs = colonne.map((c) => {
    if (c.generated) {
      // L'espressione della colonna generata sta nel default del catalogo.
      return `${qid(c.name)} ${c.ctype} GENERATED ALWAYS AS (${c.cdefault || 'NULL'}) STORED`;
    }
    if (c.identity) {
      return `${qid(c.name)} ${c.ctype} GENERATED ${c.identity} AS IDENTITY`;
    }
    // `DEFAULT nextval('<tabella>_<col>_seq')` è una colonna seriale: la
    // sequenza vive nello schema di ORIGINE, quindi riprodurre il default
    // verbatim creerebbe una tabella che punta altrove. I tipi `serial` la
    // ricreano da soli, col nome giusto, nello schema di destinazione.
    const seriale = c.cdefault && /\bnextval\s*\(/i.test(c.cdefault)
      ? SERIAL_PER_TIPO[String(c.ctype).toLowerCase()]
      : null;
    let def = `${qid(c.name)} ${seriale || c.ctype}`;
    if (c.notnull) def += ' NOT NULL';
    // Il default del catalogo è già un'ESPRESSIONE SQL (`now()`, `'x'::text`,
    // `(a + b)`): va riprodotto verbatim. Quotarlo come letterale — che è ciò
    // che faceva `pgDefaultSql` nel motore di backup — trasformava
    // `nextval('s'::regclass)` nella stringa "nextval('s'::regclass)" e
    // rendeva la DDL del backup inservibile.
    if (!seriale && c.cdefault != null) def += ` DEFAULT ${c.cdefault}`;
    return def;
  });

  const vincoli = await q(
    `SELECT pg_catalog.pg_get_constraintdef(c.oid) AS def
       FROM pg_catalog.pg_constraint c
       JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND c.contype IN ('p', 'u', 'c')
   ORDER BY c.contype DESC, c.conname`,
    [schema, table],
  );
  for (const r of vincoli.rows) defs.push(String(r.def));

  const nome = qualificato ? `${qid(schema)}.${qid(table)}` : qid(table);
  return `CREATE TABLE ${nome} (\n  ${defs.join(',\n  ')}\n);`;
}

/**
 * Indici non vincolari e chiavi esterne, da applicare DOPO tabelle e dati.
 *
 * @returns {Promise<{indexes: string[], foreignKeys: string[]}>}
 */
async function pgAuxDdl(q, schema, table, { qualificato = false } = {}) {
  const out = { indexes: [], foreignKeys: [] };

  // Solo gli indici NON creati da un vincolo: quelli di PK/UNIQUE sono già
  // dentro la CREATE TABLE e ricrearli darebbe un errore di duplicato.
  const idx = await q(
    `SELECT pg_catalog.pg_get_indexdef(x.indexrelid) AS def
       FROM pg_catalog.pg_index x
       JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
       JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = x.indexrelid
        )
   ORDER BY i.relname`,
    [schema, table],
  );
  for (const r of idx.rows) out.indexes.push(`${String(r.def)};`);

  const fk = await q(
    `SELECT c.conname AS name, pg_catalog.pg_get_constraintdef(c.oid) AS def
       FROM pg_catalog.pg_constraint c
       JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'f'
   ORDER BY c.conname`,
    [schema, table],
  );
  const nome = qualificato ? `${qid(schema)}.${qid(table)}` : qid(table);
  for (const r of fk.rows) {
    out.foreignKeys.push(`ALTER TABLE ${nome} ADD CONSTRAINT ${qid(r.name)} ${String(r.def)};`);
  }
  return out;
}

/**
 * Oggetti dello schema che non sono tabelle: view (comprese le materializzate),
 * funzioni/procedure, trigger e sequenze indipendenti.
 *
 * Erano il buco dichiarato del motore anche per PostgreSQL: un backup
 * "riuscito" di uno schema con delle view lo ripristinava senza, e nessun
 * conteggio di righe lo segnalava — le view non hanno righe proprie.
 */
async function pgSchemaObjects(q, schema) {
  const out = { views: [], routines: [], triggers: [], sequences: [], sequenceValues: [] };

  const views = await q(
    `SELECT c.relname AS name, c.relkind AS kind,
            pg_catalog.pg_get_viewdef(c.oid, true) AS def
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')
   ORDER BY c.relname`,
    [schema],
  );
  for (const r of views.rows) {
    const materializzata = r.kind === 'm';
    out.views.push({
      name: r.name,
      materialized: materializzata,
      ddl: `CREATE ${materializzata ? 'MATERIALIZED ' : ''}VIEW ${qid(r.name)} AS ${String(r.def)}`,
    });
  }

  // `pg_get_functiondef` non funziona sulle funzioni aggregate: si escludono
  // invece di far fallire l'intero backup per un oggetto che non sappiamo
  // riprodurre. prokind: 'f' funzione, 'p' procedura, 'a' aggregata, 'w' window.
  const routines = await q(
    `SELECT p.oid AS oid, p.proname AS name,
            pg_catalog.pg_get_functiondef(p.oid) AS def
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
   ORDER BY p.proname`,
    [schema],
  );
  for (const r of routines.rows) {
    if (r.def) out.routines.push({ name: r.name, ddl: String(r.def) });
  }

  const triggers = await q(
    `SELECT t.tgname AS name, c.relname AS ontable,
            pg_catalog.pg_get_triggerdef(t.oid, true) AS def
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal
   ORDER BY c.relname, t.tgname`,
    [schema],
  );
  for (const r of triggers.rows) {
    out.triggers.push({ name: r.name, table: r.ontable, ddl: String(r.def) });
  }

  // --- Sequenze -----------------------------------------------------------
  //
  // Due cose distinte, e la seconda è quella che veniva dimenticata:
  //
  //  1. la DEFINIZIONE delle sequenze indipendenti. Quelle possedute da una
  //     colonna (`serial`) le ricrea il tipo `serial` della CREATE TABLE, e
  //     ricrearle qui darebbe un duplicato;
  //
  //  2. il VALORE CORRENTE di TUTTE le sequenze, possedute comprese. Senza,
  //     una tabella con id 1..1000 si ripristina con i dati giusti ma la
  //     sequenza riparte da 1: il primo INSERT dopo il ripristino sbatte
  //     contro la chiave primaria. Il restore si dichiara riuscito, i conteggi
  //     tornano, e la tabella non accetta più scritture. Su MySQL il problema
  //     non esiste perché AUTO_INCREMENT è dentro SHOW CREATE TABLE.
  //
  // `pg_sequences` (PG 10+) espone parametri e last_value in una vista sola.
  const seqs = await q(
    `SELECT s.sequencename AS name, s.start_value, s.min_value, s.max_value,
            s.increment_by, s.cycle, s.cache_size, s.last_value,
            (SELECT 1 FROM pg_catalog.pg_depend d
               JOIN pg_catalog.pg_class c ON c.oid = d.objid
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = s.schemaname AND c.relname = s.sequencename
                AND c.relkind = 'S' AND d.deptype = 'a' LIMIT 1) AS posseduta
       FROM pg_catalog.pg_sequences s
      WHERE s.schemaname = $1
   ORDER BY s.sequencename`,
    [schema],
  );
  for (const r of seqs.rows) {
    if (!r.posseduta) {
      // Parametri riprodotti: una sequenza ricreata con i default non è la
      // stessa sequenza — cambiano passo, limiti e comportamento al giro.
      const parti = [`CREATE SEQUENCE IF NOT EXISTS ${qid(r.name)}`];
      if (r.increment_by != null) parti.push(`INCREMENT BY ${r.increment_by}`);
      if (r.min_value != null) parti.push(`MINVALUE ${r.min_value}`);
      if (r.max_value != null) parti.push(`MAXVALUE ${r.max_value}`);
      if (r.start_value != null) parti.push(`START WITH ${r.start_value}`);
      if (r.cache_size != null) parti.push(`CACHE ${r.cache_size}`);
      parti.push(r.cycle ? 'CYCLE' : 'NO CYCLE');
      out.sequences.push({ name: r.name, ddl: parti.join(' ') });
    }
    // Il valore corrente vale per TUTTE, possedute comprese. `last_value` è
    // null se la sequenza non è mai stata usata: in quel caso non c'è nulla da
    // riportare e lasciarla al suo START WITH è la cosa giusta.
    if (r.last_value != null) {
      out.sequenceValues.push({
        name: r.name,
        // `true` come terzo argomento: il PROSSIMO nextval restituirà
        // last_value + 1, che è esattamente lo stato in cui era l'originale.
        sql: `SELECT pg_catalog.setval('${String(r.name).replace(/'/g, "''")}', ${r.last_value}, true)`,
      });
    }
  }

  return out;
}

module.exports = {
  qid,
  pgColonne,
  pgColonneDaSalvare,
  pgCreateTable,
  pgAuxDdl,
  pgSchemaObjects,
  SERIAL_PER_TIPO,
  TIPI_BINARI_PG,
  TIPI_TEMPORALI_PG,
};
