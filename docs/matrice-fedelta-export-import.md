# Matrice di fedeltà — export e import

Deliverable della **Fase 0** di `piano-export-import-database.md` (§6). Dice che cosa il
repo conserva **oggi**, riga per riga, e con quale prova. Non descrive funzionalità future.

Questo file è mantenuto dai test: quando una riga cambia verdetto, cambia insieme alla
prova che lo dimostra.

## Come leggere i verdetti

| Verdetto | Significato |
|---|---|
| **conservato** | Il valore o l'oggetto torna identico, e c'è una prova che lo dimostra |
| **perso** | Torna diverso — misurato, non supposto. La riga dice *che cosa* diventa |
| **non coperto** | Non viene nemmeno letto: non c'è perdita silenziosa, c'è assenza |
| **non verificato** | Il codice dichiara di conservarlo, ma nessuna prova lo misura |

## I due percorsi non sono lo stesso percorso

Il repo ha **due** vie che producono un file, e non hanno la stessa fedeltà. È la prima
cosa che questa matrice serve a rendere visibile.

| | Percorso **backup** | Percorso **`.codedb.json`** |
|---|---|---|
| Da dove | `backup/lib/engine.js` (CLI `npm run backup`, evento `backup:run`) | `public/js/exportimport.js` → `collection:export` |
| Dove legge | Driver nativo, con SELECT costruita apposta | Stesso pool, SELECT della griglia |
| Contenitore | Cartella con `manifest.json`, `data/*.ndjson[.gz]`, `schema/*.sql`, checksum SHA-256 | File JSON unico, assemblato **nel browser** |
| Ripristino | `backup/lib/restore.js` → `db/importPlan.js`, con staging e verifica | `database:import:start` → stesso `db/importPlan.js` |

Le righe che seguono distinguono i due percorsi ogni volta che divergono.

---

## 1. Dati

### Numeri

| Caso | Backup | `.codedb.json` | Prova |
|---|---|---|---|
| MySQL `BIGINT` oltre 2^53 | conservato — `CAST(… AS CHAR)`, testo | conservato — `supportBigNumbers: true` restituisce una stringa | `test/unit-sql-integrita-righe.js` |
| MySQL `BIGINT UNSIGNED` al massimo | non verificato | non verificato | — |
| `DECIMAL`/`NUMERIC` arbitrario | conservato — i due driver lo consegnano come stringa | conservato | — (nessuna prova diretta) |
| BSON `Decimal128` | conservato | conservato | misurato, vedi §1-bis |
| BSON `Long` oltre 2^53 | conservato — codec canonico, testo `$numberLong` | conservato | `test/unit-sql-integrita-righe.js`, `test/unit-codec-fedele.js` |
| BSON `Long` **dentro** 2^53 | conservato dalla Fase 3 (prima: **perso** → `Int32`, vedi §1-bis) | **perso** → torna `Int32` | `test/unit-codec-fedele.js` |
| BSON `Double` con valore intero | conservato dalla Fase 3 (prima: **perso** → `Int32`, vedi §1-bis) | **perso** → torna `Int32` | `test/unit-codec-fedele.js` |
| BSON `Double` frazionario | conservato | conservato | misurato, vedi §1-bis |
| BSON `Int32` | conservato | conservato | misurato, vedi §1-bis |

### §1-bis — La misura del formato relaxed (superata in Fase 3)

Fino alla Fase 2 il motore di backup scriveva le righe con
`EJSON.stringify(doc, { relaxed: true })` e le **rileggeva** con
`{ relaxed: false }`: la scrittura e la lettura non usavano lo stesso formato,
ed era nella scrittura che si perdeva il tipo. Misura storica, conservata come
regressione di riferimento (con la patch CDB-04 caricata):

```
doubleIntegrale    Double->Int32          PERSO   rel=3
doubleFrazionario  Double->Double         OK      rel=3.5
longMax            Long->Long             OK      rel={"$numberLong":"9223372036854775807"}
longOltre2e53      Long->Long             OK      rel={"$numberLong":"9007199254740993"}
longPiccolo        Long->Int32            PERSO   rel=5
int32              Int32->Int32           OK      rel=7
decimal            Decimal128->Decimal128 OK      rel={"$numberDecimal":"1.000"}
```

Dalla Fase 3 tutte le scritture passano da `db/codecFedele.js` (canonico
esplicito, mai default relaxed): i due casi PERSO tornano `Long` e `Double`
distinti, e la guardia statica in `test/unit-codec-fedele.js` rifiuta qualunque
`relaxed: true` nel motore. I file relaxed storici restano leggibili dallo
stesso lettore (provato). Resta la riserva sulla patch CDB-04 come garanzia per
effetto collaterale di caricamento, ora non più necessaria al motore.

Due cose vanno tenute separate, perché hanno gravità diversa:

* il **valore** non si perde: la patch CDB-04 copre l'unico caso in cui si perdeva
  (`Long` oltre i 53 bit, che senza patch diventava `9223372036854776000`);
* il **tipo** si perde: `Double(3)` e `Long(5)` tornano entrambi `Int32(5)`/`Int32(3)`.
  §6 del piano chiede che «BSON Int32/Int64/Double/Decimal128» restino **distinti**, e qui
  non restano.

La patch CDB-04 è però una garanzia **per effetto collaterale di caricamento**: vale
perché `db/MongoDbStrategy.js` viene importato, non perché il motore di backup la chieda.
Un percorso futuro che caricasse `backup/lib/engine.js` senza `DbFactory` perderebbe il
valore, non solo il tipo — verificato: in un processo che carica *solo* il motore,
`Long.prototype.__codedbLongPatched` è `false`.

Il formato canonico (`relaxed: false`) invece round-trippa **tutti** i quindici casi
provati, tipo compreso. È la base tecnica della Fase 3 («nessun formato relaxed
distruttivo»): non serve un codec nuovo, serve smettere di scrivere in relaxed.

### Temporali

| Caso | Backup | `.codedb.json` | Prova |
|---|---|---|---|
| MySQL `DATETIME(6)` con microsecondi | conservato — `CAST(… AS CHAR)` | **perso** → mysql2 consegna un `Date` JS, risoluzione al millisecondo | letto (`engine.js:573`, `MySqlStrategy.js:1527`) |
| MySQL `TIMESTAMP` | conservato — testo, nessun fuso applicato | **perso** → reinterpretato nel fuso del client | letto, stessi punti |
| MySQL `TIME` negativi/estesi | conservato — testo | non verificato | letto |
| PostgreSQL `timestamptz`/`timestamp`/`time`/`date`/`interval` | conservato — `::text` | **perso** → `Date` JS, millisecondi e fuso | `db/pg-ddl.js:108` contro `PostgreSqlStrategy.js:1639` |
| MySQL date zero ammesse dal `sql_mode` | non verificato | non verificato | — |
| PostgreSQL `infinity` | non verificato | non verificato | — |
| BSON `Date` fuori dall'intervallo ISO | conservato — relaxed ricade su `$numberLong` | conservato | misurato |

### Binari

| Caso | Backup | `.codedb.json` | Prova |
|---|---|---|---|
| MySQL `BLOB`/`BINARY`/`VARBINARY`/`BIT` | conservato — `HEX(…)`, testo esatto | **perso** → il `Buffer` diventa `{"0":0,"1":255,"2":16}` | misurato, vedi sotto |
| PostgreSQL `bytea` | conservato — `encode(…, 'hex')` | **perso** → stessa forma | `db/pg-ddl.js:105` contro `PostgreSqlStrategy.js:1639` |
| BSON `Binary` con sottotipo | conservato — `$binary` con `subType` | conservato | misurato |
| BSON `Binary` sottotipo 4 (UUID) | conservato | conservato | misurato |

Misura della perdita sul percorso `.codedb.json`:

```
Buffer relaxed -> {"b":{"0":0,"1":255,"2":16}}
riletto        -> {"b":{"0":0,"1":255,"2":16}}   e Buffer? false
```

Il motore di backup lo dichiara già nel proprio commento («NON sopravvive al giro EJSON
del file NDJSON: torna come oggetto e MySQL lo rifiuta, "Data too long"») e vi rimedia con
`HEX`. L'export dell'interfaccia non ha quel rimedio: la classe di difetto è nota e
corretta **in un percorso solo**.

### Testo, strutturati, geometrie, BSON

| Caso | Backup | `.codedb.json` | Prova |
|---|---|---|---|
| Unicode, emoji, newline, stringa vuota ≠ NULL | non verificato | non verificato | — |
| `NUL` dentro una stringa | non verificato | non verificato | — |
| charset/collation della colonna | conservato nel DDL (`SHOW CREATE TABLE`) | conservato nel DDL | letto |
| MySQL `JSON` | non verificato | non verificato | — |
| PostgreSQL `json`/`jsonb` | non verificato | non verificato | — |
| PostgreSQL array, range, composti | non verificato | non verificato | — |
| PostgreSQL `enum`/`domain` (tipo definito dall'utente) | **non coperto** — il tipo non viene esportato: il DDL lo nomina e il ripristino fallisce | **non coperto** | §2 di questo file |
| MySQL geometrie | conservato — `HEX(ST_AsBinary(…))` + SRID dal catalogo | conservato — GeoJSON + SRID (`selectListFor`, `preservaSrid`) | `db/MySqlStrategy.js:1460` |
| PostGIS `geometry` | non verificato — il driver restituisce l'EWKB esadecimale | non verificato | letto |
| PostgreSQL geometrie **native** (`point`, `box`, `circle`) | conservato — `::text` | non verificato | `db/pg-ddl.js:110` |
| BSON `ObjectId`, `Timestamp`, `MinKey`/`MaxKey`, regex con opzioni | conservato | conservato | misurato |
| Campo assente ≠ `null`, ordine dei campi | non verificato | non verificato | — |

### Identità

| Caso | Stato | Prova |
|---|---|---|
| PK composte, UNIQUE interamente `NOT NULL` | conservato e **dichiarato** nel manifest v2 | `test/unit-identita-backup.js` |
| Tabella senza identità stabile | ammessa nel full verso destinazione vuota, rifiutata come base incrementale | `test/unit-identita-backup.js` |
| `AUTO_INCREMENT` MySQL | conservato — è dentro `SHOW CREATE TABLE` | letto |
| Sequenze PostgreSQL: definizione **e valore corrente** | conservato | `db/pg-ddl.js` (`pg_sequences`), `test/unit-schema-objects.js` |
| Colonne generate | escluse dalla lettura, ricalcolate dal DDL | `test/unit-sql-integrita-righe.js` |
| Colonne invisibili MySQL | non verificato | — |

---

## 2. Schema e oggetti

Fonte unica dell'inventario: `db/schemaObjects.js`, che riusa `mysqlSchemaObjects`
(`backup/lib/engine.js`) e `pgSchemaObjects` (`db/pg-ddl.js`). I due percorsi usano lo
**stesso** inventario: qui non divergono.

| Oggetto | MySQL | PostgreSQL | MongoDB |
|---|---|---|---|
| Tabelle / collection, anche vuote | conservato | conservato | conservato (materializzate) |
| Indici, con opzioni complete | conservato | conservato | conservato — descrittori **grezzi**, predefiniti omessi da entrambe le parti |
| Chiavi esterne, CHECK, UNIQUE | conservato | conservato | n/d |
| View | conservato (`SHOW CREATE VIEW`, definer compreso) | conservato, materialized comprese | conservato (`viewOn`, pipeline, collation) |
| Routine (funzioni, procedure) | conservato | conservato — **escluse** aggregate e window (`prokind` limitato a `f`,`p`) | n/d |
| Trigger | conservato | conservato | n/d |
| Eventi schedulati | conservato | n/d | n/d |
| Sequenze / contatori | dentro il DDL | conservato, **valore corrente compreso** | n/d |
| Opzioni di collection (capped, time series, clustered, validator, collation) | n/d | n/d | conservato — `info.options` passa intero |
| Partizioni | dentro `SHOW CREATE TABLE` | **non coperto** | n/d |
| Tipi definiti dall'utente (`enum`, `domain`, compositi) | n/d | **non coperto** | n/d |
| Estensioni | n/d | **non coperto** | n/d |
| RLS e policy | n/d | **non coperto** | n/d |
| Owner, ACL, default privileges | **non coperto** | **non coperto** | n/d |
| Large Object | n/d | **non coperto** | n/d |
| Ereditarietà | n/d | **non coperto** | n/d |
| GridFS come insieme coerente | n/d | n/d | **non coperto** come insieme (i dati passano come due collection qualsiasi) |
| Sharding, indici di servizi esterni (Atlas Search) | n/d | n/d | **non coperto** |

Verificato con una ricerca su `db/pg-ddl.js`, `backup/lib/engine.js` e
`db/schemaObjects.js`: nessuno dei termini `pg_type`, `pg_enum`, `domain`, `extension`,
`pg_policy`, `relrowsecurity`, `pg_largeobject`, `DEFAULT PRIVILEGES`, `relacl`,
`inherit`, `partbound` compare in alcuno dei tre.

Le righe **non coperto** sono la parte peggiore, ed è la ragione per cui esistono: una
`CREATE TABLE` che nomina un `enum` definito dall'utente si ripristina in un database in
cui quel tipo non esiste, e fallisce. Fallisce in chiaro — il che è corretto, è
fail-closed — ma il piano chiede che l'oggetto sia **dichiarato** nel report prima di
arrivare al DBMS, non scoperto dall'errore del motore.

---

## 3. Consistenza della sorgente

| Motore | Stato oggi |
|---|---|
| MongoDB | cursore ordinario, nessuna snapshot globale (`engine.js:296`). §5 del piano lo dichiara insufficiente |
| MySQL | nessuna transazione snapshot esplicita nel percorso incorporato |
| PostgreSQL senza identità | paginazione per `OFFSET`, con `ORDER BY ctid` a dare un ordine stabile fra le pagine — resta `OFFSET`, che la Fase 3 deve togliere (`engine.js:1005`) |
| PostgreSQL con identità | keyset sulla PK, nessun `OFFSET` |

---

## 4. Baseline dei test

Ambiente di questa misura: Windows 11, Node v26.2.0, worktree `backup-sql`.

* `npm test` — **verde**, dopo la correzione descritta sotto.
* Tutti gli E2E che richiedono un motore vero (MongoDB 27017, MySQL 3306, PostgreSQL
  5432) **non sono eseguibili qui**: nessuno dei tre risponde e il demone Docker non è
  attivo. Le righe «non verificato» di questa matrice restano tali finché non c'è un
  ambiente con i tre motori.

### Una prova che non poteva provare nulla

`test/unit-sql-write-batch.js` delimitava il corpo di `executeWriteBatch` cercando
`'\n  }\n'` nel sorgente. Il repo tiene LF (`git ls-files --eol` → `i/lf`) ma un checkout
Windows con `core.autocrlf` consegna CRLF: `indexOf` non trovava nulla, restituiva `-1`, e
`slice(0, -1 + 4)` riduceva «il metodo» a tre caratteri. Effetto doppio e opposto: la
prima asserzione falliva **sempre** (la suite era rossa su Windows per un motivo che non
riguardava il codice), e le due negative passavano **sempre**, cioè le due copie della
logica del batch che quel test esiste per impedire sarebbero rientrate senza che nulla lo
dicesse.

Corretto normalizzando i fine riga prima di tagliare, con un'asserzione esplicita sul
fatto che il corpo sia delimitabile. Sensibilità verificata: inserendo di proposito
`auditResult` dentro `executeWriteBatch` di `MySqlStrategy.js`, il test fallisce con il
messaggio giusto; rimosso, torna verde.
