# Piano — Esecuzione di script nella tab ⚡ Query & Aggregate

> Ambito deciso con Keus: la tab **⚡ Query & Aggregate** deve poter eseguire
> **script** (più istruzioni), non solo singole query, su **SQL** (MySQL/PostgreSQL)
> e su **MongoDB**, con **formattazione** e **syntax coloring**.
>
> Decisioni prese da Keus:
> 1. **Interprete JS completo** per gli script MongoDB (`var`, `for`, `if`…), con in
>    più la possibilità di **interpretare anche SQL su database Mongo**.
> 2. **Continua e riporta** in caso di errore: lo script non si ferma al primo
>    fallimento. Ogni esecuzione — script compreso — è una **query in sospeso**
>    (`pending-queries.js`), quindi **mettibile in pausa e riprendibile** dal punto
>    in cui si era interrotta.

## Stato di partenza (cosa c'è già)

| Pezzo | Dove | Stato |
|---|---|---|
| Syntax coloring SQL/MQL/shell | `public/js/query-highlighter.js` | ✅ tokenizer proprio, zero dipendenze |
| Editor con overlay colorato | `public/index.html:715` + `query-tab.js:22` | ✅ `<pre>` sotto `<textarea>` |
| Caricamento file SQL enormi | `public/js/sql-chunker.js` | ✅ chunk da 1 MB allineati al `;` |
| Esecuzione sequenziale dei chunk | `query-tab.js:313` | ⚠️ esiste ma manda ogni chunk **intero** a `query:execute` |
| Registro query in sospeso | `public/js/pending-queries.js` | ✅ track/pause/resume/persistenza |
| Annullamento reale lato DB | `cancelQuery` nelle 3 strategie | ✅ killOp / KILL QUERY / pg_cancel_backend |
| **Multi-statement MySQL** | `db/MySqlStrategy.js:119` | ❌ `multipleStatements: false` |
| **Multi-statement PostgreSQL** | `db/PostgreSqlStrategy.js:592` | ✅ funziona già (simple query protocol) |
| **Script MongoDB** | `db/MongoShell.js` | ❌ una sola espressione, sola lettura |
| **Formattatore SQL** | `query-tab.js:121` | ❌ formatta solo JSON, su SQL non fa nulla |

Il risultato è che l'interfaccia per gli script c'è già: manca il **motore**.

## Principio guida

**Non** si abilita `multipleStatements: true` su mysql2: amplierebbe la superficie da
injection su **tutta** l'app (griglia, filtri, clausole libere), non solo sul Query
Engine. Gli script vengono invece **divisi lato server** ed eseguiti **uno statement
alla volta sulla stessa connessione**. Vantaggi oltre alla sicurezza:

- progresso reale (statement *n* di *N*) e **pausa/ripresa** a granularità di statement;
- ogni statement classificato singolarmente da `isWriteSql` → **audit e RBAC precisi**
  invece di un unico "write" indistinto;
- errore localizzato alla **riga esatta** del sorgente.

## Stato di avanzamento

- **Fase A — FATTA** (A1 splitter, A2 ScriptRunner, A3 eventi socket). Test:
  `unit-sql-split`, `unit-script-runner` (in `npm test`), `e2e-script-runner` (MongoDB).
  Due correzioni emerse strada facendo, entrambe di bug **preesistenti**:
  `$out`/`$merge` su MongoDB erano **impossibili** dal Query Engine (`.limit(cap)`
  accodava uno stage dopo `$out`), e le porzioni di soli commenti venivano prese
  per istruzioni.
- **Fase B — FATTA**: `public/js/sql-split.js` (splitter client, solo per il
  routing; test di **coerenza col gemello server**), `public/js/script-run.js`
  (ciclo di vita, pannello, pausa/ripresa), voci `kind: 'script'` con barra di
  avanzamento in `pending-queries.js`, routing automatico in `runQuery()` e
  pannello a blocchi che esegue ogni chunk come script **atteso fino alla fine**.
  Limite noto: un F5 **uccide** lo script, perché la sessione DB vive col socket
  (`closeSession` → `abort`); la ripresa dopo un reload ricarica il codice
  nell'editor e riparte da capo, come per le query singole.
- **Fase C — FATTA**: `db/MongoScript.js` (lessico, sintassi, sandbox dei
  valori) + `db/MongoScriptRunner.js` (valutatore AST, oggetti `db`, budget),
  metodo `shellWrite` sulle strategie con capability decisa dall'operazione,
  `translateWrite` in `SqlToMql.js` per SQL di scrittura/DDL su MongoDB,
  guardia del database di contesto rilassata per `CREATE/DROP DATABASE`,
  messaggio dedicato per `CREATE DATABASE` su PostgreSQL e **ricarica
  dell'albero** dopo un DDL riuscito. Test: `unit-mongo-script`,
  `unit-sql-write-mongo` (in `npm test`), `e2e-mongo-script`, più il caso
  «scritture da script soggette ai permessi» in `unit-rbac`.
- **Fase D** — da fare.

## Fase A — Fondamenta: divisione ed esecuzione a passi (backend)

### A1. `db/sqlText.js` → `splitStatementsDetailed(sql)`

`splitStatements` esistente lavora sul testo **normalizzato** (stringhe e commenti
sostituiti da segnaposto): utilissimo per *decidere*, inutilizzabile per *eseguire*.
Serve una variante che percorra l'originale con lo stesso lexer ma **conservi il
testo vero**, restituendo per ogni istruzione:

```js
{ sql, start, end, line }   // line = 1-based, per puntare l'errore nell'editor
```

`splitStatements` viene riscritta sopra questa, così esiste **un solo lexer**.

### A2. `db/ScriptRunner.js` (nuovo)

Macchina a stati dell'esecuzione, indipendente dal trasporto e dal dbType:

```js
createScriptRun({ id, statements })
  .start(executor)      // executor(stmt, index) -> { rows, affected, ... }
  .pause()              // si ferma DOPO lo statement in corso, cursore conservato
  .resume(executor)     // riparte dal cursore
  .state()              // { status, cursor, total, results[] }
```

Politica errori: **continua e riporta** (scelta di Keus). Ogni statement produce una
voce `{ index, line, ok, error, rows, affected, ms }`; lo script termina con
`{ eseguiti, falliti, durata }`.

### A3. Eventi socket

| Evento | Payload | Note |
|---|---|---|
| `script:execute` | `{ tabId, runId, code, db, coll, startAt }` | ack immediato `{ ok, total }`, non attende la fine |
| `script:pause` | `{ tabId, runId }` | pausa + `cancelQuery` sullo statement in volo |
| `script:resume` | `{ tabId, runId, fromIndex }` | riprende dal cursore (o da un indice scelto) |
| `script:progress` | *push* `{ runId, index, total, result }` | instradato per `tabId` come gli eventi `live` |

Lo stato vive in `session.scripts: Map<runId, run>`, accanto a `session.inflight` già
usato da `query:cancel`. Alla chiusura della sessione i run vengono fermati.

## Fase B — Client: lo script è una query in sospeso

- `pending-queries.js`: voce con `kind: 'script'`, `progress { index, total }`,
  stato `paused` **riprendibile dal cursore** (non da capo) e riepilogo degli errori.
- `query-tab.js`: riconosce il testo multi-statement e instrada su `script:execute`;
  pannello risultati con l'elenco per statement (riga, esito, durata).
- Il pannello chunk esistente (`sql-chunker.js`) smette di mandare il chunk intero:
  ogni chunk diventa un segmento dello stesso run.

## Fase C — MongoDB: interprete e SQL

> **Vincolo emerso nella Fase A**: la divisione in istruzioni oggi in uso è
> quella SQL (`;` fuori da stringhe e commenti) e **non conosce i blocchi `{ … }`
> del JavaScript**: un `for (…) { a; b; }` verrebbe spezzato a metà.
> L'interprete deve quindi analizzare il testo da sé — `script:execute` gli
> passerà lo script intero come una sola "istruzione" quando il target è
> MongoDB e il codice contiene costrutti JS.

### C1. `db/MongoScriptInterpreter.js` (nuovo) — interprete JS

Parser a discesa ricorsiva → **AST** → valutatore. **Nessun `eval`, nessun `Function`,
nessun accesso a `require`/`process`/globali**: l'ambiente contiene solo `db`, i
costruttori BSON già noti a `MongoShell.js` (`ObjectId`, `ISODate`, `NumberLong`…),
`print`/`printjson` e un pugno di funzioni pure.

Sottoinsieme di linguaggio: `var/let/const`, assegnamenti, aritmetica e confronti,
`if/else`, `for`, `for…of`, `while`, `break`/`continue`, funzioni utente, letterali
oggetto/array, member access e chiamate, `try/catch`. Con **tetto di iterazioni e
budget di tempo** per non trasformare un ciclo infinito in un blocco del server.

`db.<coll>.<metodo>()` viene eseguito **davvero**, scritture comprese
(`insertOne/Many`, `updateOne/Many`, `deleteOne/Many`, `createCollection`, `drop`…):
è il punto in cui cade la barriera read-only odierna di `MongoShell.js`. Ogni chiamata
passa comunque dalla strategia, quindi **resta sotto il Proxy autorizzante** di
`auth/guardStrategy.js` — l'RBAC continua a valere senza codice dedicato.

### C2. `SqlToMql.js` → scritture e DDL

Oggi traduce solo `SELECT` (`SqlToMql.js:513`). Da estendere a `INSERT`/`UPDATE`/
`DELETE` e al DDL (`CREATE TABLE` → `createCollection`, `CREATE DATABASE`,
`DROP TABLE` → `drop`), così "SQL su Mongo" vale anche in scrittura.

### C3. Creazione database

- **MongoDB**: il DB nasce con la prima collection; lo script lo crea implicitamente.
- **PostgreSQL**: il livello "database" della UI **è lo schema** → `CREATE SCHEMA`
  funziona ed è visibile; `CREATE DATABASE` no (pool legato a `cfg.database`): serve
  un messaggio esplicito che indirizzi a `CREATE SCHEMA`.
- **Guardia `server.js:1830`**: da rilassare per i comandi che un database di
  contesto non lo richiedono affatto, mantenendo il controllo RBAC sull'operazione.
- Dopo un DDL riuscito, **ricaricare l'albero** nella sidebar (oggi non si aggiorna:
  il database c'è ma non si vede, e sembra che il comando non abbia fatto nulla).

## Fase D — Editor: formattazione e coloring

- **Formattatore SQL vero** (`public/js/query-formatter.js`): indentazione per
  clausole, keyword in maiuscolo, un `;` per riga, riusando il tokenizer
  dell'highlighter — nessuna dipendenza nuova. Per MQL resta la formattazione EJSON.
- **Coloring**: estendere `query-highlighter.js` alle keyword JS
  (`var/let/const/function/for/if/return`) per gli script Mongo.
- Rifiniture: numeri di riga, indentazione con Tab, **"esegui solo la selezione"**
  (Ctrl+Enter sul testo selezionato), evidenziazione dello statement sotto il cursore
  e della riga in errore.

## Sicurezza — cosa NON cambia

- `assertNoServerJs` continua a rifiutare `$where`/`$function`/`$accumulator`:
  l'interprete gira **nel processo CodeDB**, non nel server MongoDB.
- Il Proxy autorizzante resta l'unico punto di applicazione dei permessi: tutte le
  chiamate dell'interprete passano dalla strategia.
- `multipleStatements` di mysql2 resta `false`.
- Nessuna modifica a cifratura, vault o gestione dei segreti.

## Test

| Test | Copertura |
|---|---|
| `test/unit-sql-split.js` | `splitStatementsDetailed`: `;` dentro stringhe/commenti/dollar-quoting, righe corrette |
| `test/unit-script-runner.js` | macchina a stati: continua-su-errore, pausa/ripresa dal cursore |
| `test/unit-mongo-script.js` | interprete: costrutti, tetto iterazioni, assenza di accesso a globali |
| `test/e2e-script-mysql.js` | script reale multi-statement (DDL + DML) con pausa/ripresa |
| `test/e2e-script-mongo.js` | script Mongo con scritture + SQL tradotto |

## Ordine di lavoro

1. **Fase A** — splitter + ScriptRunner + eventi socket (fondamenta di tutto).
2. **Fase B** — integrazione con le query in sospeso (pausa/ripresa lato UI).
3. **Fase D** — formattatore e coloring (indipendente, consegnabile in parallelo).
4. **Fase C** — interprete Mongo + SQL in scrittura (la più grossa, per ultima).
