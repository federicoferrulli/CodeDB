# Laboratorio di affidabilità CodeDB

Il laboratorio crea database reali usa e getta e conserva i fallimenti come
fallimenti. Non modifica i moduli della piattaforma per far passare le prove.
Gli oracoli dei nuovi test rileggono i dati con i driver nativi, oppure osservano
gli effetti delle azioni nel browser. Un test saltato non viene contato verde.

## Avvio ed esecuzione

Prerequisiti: Docker con container Linux, Docker Compose, Node e Git. Per le
suite storiche il runner include Chromium e una copia del repository in un
volume dedicato; una copia filtrata dei sorgenti è montata in sola lettura.

```sh
npm run lab:prepara     # database, copia isolata, npm ci, Chromium, frontend
npm run lab:nuovi       # query/CRUD, MCP, backup/import, sensibilità
npm run lab:test        # campagna delle suite E2E esistenti compatibili
npm run lab:rapporti    # copia log e JSON in .scratch/lab-reports/docker
npm run lab:stato
npm run lab:stop        # ferma solo il progetto codedb-affidabilita
npm run lab:down        # rimuove i suoi container; conserva i volumi
```

Le due campagne proseguono dopo i fallimenti e terminano con codice diverso da
zero se un caso fallisce, scade o viene saltato. Al momento ci sono difetti reali
aperti: **un esito rosso è previsto, non viene neutralizzato con `xfail`**.
Non avviare due campagne nello stesso runner: le suite storiche condividono
alcune porte e alcuni nomi di fixture.

Per ripetere una sola suite nella copia Docker, dopo `lab:prepara`:

```sh
docker compose -f test/lab/compose.yml exec -T -e LAB_FILTER=e2e-dbexport -e LAB_REPORT_DIR=/laboratorio/rapporti/ripetizione prove node test/lab/esegui.cjs
```

`LAB_SUITE_TIMEOUT_MS` controlla il limite per suite (default 180.000 ms,
360.000 ms per la scansione di oltre mille target mobile).
I comandi `lab:test` e `lab:nuovi` inoltrano anche `LAB_REPORT_DIR`; `lab:test`
inoltra `LAB_FILTER` per selezionare le suite senza sovrascrivere la baseline.
`manifest.cjs` elenca i prerequisiti esclusi dalla campagna di base; il report li
riporta esplicitamente. Sono distinzioni di ambiente, non prove superate.

## Isolamento

| Servizio | Porta sull'host | Porta nel runner | Credenziali sintetiche |
|---|---:|---:|---|
| MongoDB 8, replica set `lab` | 37017 | 27017 | senza autenticazione DBMS |
| MongoDB 8, autorizzazioni native | 37018 | mongo-auth:27017 | labadmin / lab_mongo_auth |
| MySQL 8.4 | 33306 | 3306 | root / lab_mysql |
| PostgreSQL 17 + PostGIS | 35432 | 5432 | postgres / lab_postgres |

Le porte Docker sono pubblicate soltanto su `127.0.0.1`. Il runner condivide la
rete dei database di prova: anche un vecchio test con `localhost:27017` fisso
raggiunge il MongoDB del laboratorio. Non monta il socket Docker, né il vault,
né le connessioni salvate dell'utente. La copia include soltanto file tracciati
(esclusi rapporti e configurazioni locali) e i nuovi file `test/lab`.

Le nuove fixture usano nomi casuali e un registro di proprietà prima di
cancellare database/schema. Ogni server CodeDB usa configurazione, audit, vault
e backup temporanei. Dall'host MongoDB deve usare `directConnection=true`: il
replica set annuncia un indirizzo interno alla rete del laboratorio.

Gli archivi di prova contengono esclusivamente dati sintetici. Le password sopra
servono a verificare connessioni autenticate e non sono credenziali da riutilizzare.

## Copertura dei nuovi test

| Suite | Evidenza |
|---|---|
| `query.cjs` | Tre DBMS reali, CRUD, precisione, byte binari, PK composte, vincoli, transazioni separate, SQL→Mongo, JOIN cross DB, 20.017 righe per motore con hash e paginazione, query concorrenti, riuso/rilascio connessioni. |
| `mcp.cjs` | Client SDK MCP reale, HTTP, autenticazione, RBAC, scope annidati, paginazione, conferme monouso concorrenti, revoca a caldo, EJSON e terminazione sessione. |
| `mcp-sql.cjs` | MCP MySQL/PostgreSQL, atomicità batch, rollback, parametri, scope, precisione, binari, funzioni SQL con scrittura interna respinte da READ ONLY. |
| `integrita.cjs` | Backup CLI e catene, JSON/SQL export-import, oltre 2.000 righe complesse per motore, schema/indici/view/FK/geometrie/BSON, fusi orari, archivi corrotti e protezione della destinazione. |
| `dialog-menu.cjs` | Browser reale, fixture visiva sintetica: menu contestuale durante chiusura dialoghi, con casi di controllo e screenshot. |
| `browser.cjs` | Chromium reale sui tre DBMS: modifica e rilettura indipendente, JSON esatto, grafici, mappe, viewport mobile, virtualizzazione e reattività. |
| `unit-runner.cjs` | Processi reali: exit nonzero, falso verde nel log, skip, timeout, classificazione e mutazione del classificatore. |
| `unit-infrastruttura.cjs` | Staging senza segreti, hash, file obsoleti, junction/link simbolici, interruzione del processo padre e blocco dei figli orfani; due guasti deliberati. |
| `unit-connection.cjs` | Handshake PostgreSQL interrotto da un endpoint posseduto dal test; nessuna dipendenza dal DB dell'utente. |

I tempi p50/p95 e le soglie anti-blocco non sono un SLA: la macchina ospita
container e test concorrenti. Conservare l'ambiente e ripetere isolatamente le
regressioni di prestazioni prima di attribuirle al prodotto.

## Sensibilità

`query.cjs --sensitivity` avvia copie in memoria del server con perdita di righe,
scritture saltate e JOIN che eliminano duplicati. `mcp-sensitivity.cjs` verifica
riuso dei token e commit parziale. Non basta che il processo esca con 1: i
wrapper esigono gli errori attesi e i valori corrotti osservati sui database.

La suite integrità altera realmente una copia ripristinata/importata e corrompe
archivi, verificando che i controlli rilevino il danno. Le mutazioni non toccano
i sorgenti applicativi sul disco.

## Profilo nativo e failover

`native.cjs` usa la fixture separata `test/fixtures/sql-native-databases.yml`:
PostgreSQL 18, MySQL 8.4, tre nodi MongoDB, porte dedicate 55439/33339/27039–27041.
Controlla le etichette dei container prima delle azioni distruttive. Il profilo
esegue SQL nativo, sessioni, audit, UI e fasi di failover con elezione reale.
Include anche `e2e-mongosh-runtime.js` e `e2e-mongosh-ui.js`: variabili isolate
per tab, transazioni, change stream persistenti e ripresa dopo cambio primario,
cancellazione di cicli infiniti, limite di byte, reset e interazione nel browser.
Richiede dipendenze Node installate sull'host e Docker:

```sh
node test/lab/native.cjs --sensitivity
```

Per l'esecuzione fuori dai comandi Docker impostare `CODEDB_E2E_DESTRUCTIVE=1`.
Su PowerShell: `$env:CODEDB_E2E_DESTRUCTIVE='1'`. I report del profilo si trovano
in `.scratch/lab-reports/native`; le opzioni di esclusione sono registrate.
`--no-up` riusa la fixture già avviata, `--mongosh-only` seleziona le due suite
mongosh e `--ui-only` seleziona entrambe le suite UI.
`--only=nome-suite,nome-suite` seleziona suite specifiche ed esclude il failover;
una selezione vuota o sconosciuta fallisce. Il browser può essere
Chromium Playwright oppure Chrome/Edge già installato; `LAB_BROWSER_EXECUTABLE`
permette di indicarlo esplicitamente. I rapporti versionati scritti dalle suite
storiche vengono copiati nelle evidenze e ripristinati ai byte precedenti.

Nella campagna del 21 ottobre 2026 sono passate 117 istruzioni SQL native,
12 gruppi di regressione sessioni, 20 gruppi query native, 15 gruppi audit,
18 fasi di failover e il controllo UI nativo. Il mutante quorum è stato rilevato
per mancato avanzamento della migrazione, come richiesto. Evidenze in
`.scratch/lab-reports/native/native.json`; il primo tentativo UI privo di
Chromium è conservato insieme alla ripetizione riuscita con Chrome in
`.scratch/lab-reports/native-ui/native.json`.

La ripetizione aggiuntiva mongosh è passata: 56 esecuzioni reali in 12 gruppi
runtime, incluso cambio primario reale, e la suite UI con stream insert/update,
resume token, chiusura e reset, senza errori JavaScript. Report separato in
`.scratch/lab-reports/native-mongosh/native.json`, log per suite e screenshot
`live-ui.png`. Per ripeterla da PowerShell:

```powershell
$env:CODEDB_E2E_DESTRUCTIVE='1'
$env:LAB_NATIVE_REPORT_DIR='.scratch/lab-reports/native-mongosh'
node test/lab/native.cjs --no-up --mongosh-only
```

Il profilo include anche `e2e-query-dialetti-nativi.js` e
`e2e-sql-mongo-tipi.js`, i cui oracoli richiedono PostgreSQL 18. Entrambe sono
passate su 18.6: inventari di 734 keyword MySQL e 494 PostgreSQL, 14 query native
con due riscritture equivalenti, 6 confronti tra i tre motori, 218 prove tipi
MongoDB, 178 PostgreSQL e una MySQL; inoltre 247 condizioni e 251 SQLSTATE
eseguiti negli handler. Report in `.scratch/lab-reports/native-pg18/native.json`.

Il controllo separato su PostgreSQL 17.5 trova una sola keyword non inclusa nel
catalogo dichiarato per la versione 18: `RECHECK`, classificata `unreserved` dal
server. Il risultato su 18 non dimostra copertura completa del catalogo per 17.
Le condizioni di errore introdotte in 18 richiedono l'oracolo 18. Per ripetere:

```powershell
$env:CODEDB_E2E_DESTRUCTIVE='1'
$env:LAB_NATIVE_REPORT_DIR='.scratch/lab-reports/native-pg18'
node test/lab/native.cjs --no-up --only=e2e-query-dialetti-nativi,e2e-sql-mongo-tipi
```

## CI ed evidenze

`.github/workflows/laboratorio.yml` prepara il laboratorio sulle pull request e
su avvio manuale, esegue unitari/TypeScript e le due campagne, carica i rapporti
anche quando falliscono e chiude i container. La presenza del workflow non
attesta che GitHub Actions lo abbia già eseguito.

I log, gli screenshot, gli hash e gli archivi locali sono in `.scratch/lab-reports`
e non vengono versionati automaticamente. Il registro dei difetti confermati è
in `RISULTATI.md`; `INTEGRITA.md` dettaglia backup e trasferimenti.

Restano verifiche distinte: certificazione degli installer/store, aggiornamenti
fra versioni, storage cloud con account reali, SSO/Kerberos/Atlas/sharding,
interruzione dell'alimentazione, tutte le combinazioni di DBMS/estensioni e test
di lunga durata. Nessuna suite finita dimostra assenza di ogni difetto.
