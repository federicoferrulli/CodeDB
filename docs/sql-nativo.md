# SQL nativo in CodeDB

La compatibilità dei dialetti viene affidata a PostgreSQL e MySQL reali. Ogni
motore conserva i propri dati e applica direttamente parser, tipi, vincoli,
trigger, procedure e transazioni. Non esiste una traduzione intermedia verso
MongoDB per questo percorso.

## Avvio locale

Con Docker disponibile, dalla cartella dei sorgenti:

```sh
npm run sql:native:up
npm run sql:native:status
```

Il primo avvio genera tre password casuali in `.env.sql-native`, escluso da Git
e dai pacchetti. Non vengono stampate nei log. I volumi sono persistenti e le
porte sono esposte soltanto su `127.0.0.1`.

In **Connessioni → Nuova connessione**, configura:

| Campo | PostgreSQL | MySQL |
| --- | --- | --- |
| Host | `127.0.0.1` | `127.0.0.1` |
| Porta predefinita | `55432` | `53306` |
| Utente | `codedb` | `codedb` |
| Database | `codedb` | `codedb` |
| Password nel file locale | `CODEDB_NATIVE_PG_PASSWORD` | `CODEDB_NATIVE_MY_PASSWORD` |

MySQL assegna all'utente `codedb` i privilegi sul database `codedb`; le operazioni
amministrative su altri database richiedono un account adeguato. La password
root separata è `CODEDB_NATIVE_MY_ROOT_PASSWORD`. In PostgreSQL il navigatore
mostra gli **schemi** del database della connessione; per il primo lavoro usa
`public`. Per collegarsi a un altro database PostgreSQL crea un'altra connessione.

Le porte possono essere cambiate nel file locale con `CODEDB_NATIVE_PG_PORT`
e `CODEDB_NATIVE_MY_PORT`. I motori possono anche risiedere su server già esistenti:
il percorso di esecuzione è lo stesso, senza dipendere da Docker.

```sh
npm run sql:native:stop
```

Lo stop conserva volumi e password. Cambiare una password nel file non cambia
quella già inizializzata nel database: aggiorna le credenziali sul server e nel
vault di CodeDB. Non eliminare i volumi per effettuare una rotazione.

## Query provenienti da un workspace MongoDB

Apri la connessione PostgreSQL o MySQL, scegli il database/schema nel navigatore
e apri una scheda Query. Incolla il testo da eseguire e premi **Esegui**.

Il codice opera sui dati della destinazione. Questo percorso non migra né
sincronizza le collezioni MongoDB. L'importazione dei dati va effettuata
esplicitamente nel database SQL scelto, definendo lo schema desiderato.

La connessione determina il dialetto. Impostare `engine: postgresql` su una
connessione MongoDB non crea un server PostgreSQL: il backend rifiuta questo
bersaglio incoerente. Il percorso SQL→MQL rimane disponibile nella connessione
MongoDB, con la sua [copertura specifica](copertura-linguaggi-query.md).

## Semantica e risultati

Le query native conservano il testo SQL. Restano attivi autorizzazioni RBAC,
scope, divieto di I/O sul filesystem server per i sottoutenti, annullamento e budget dei risultati.
I commenti eseguibili MySQL (`/*! … */`) vengono inoltrati senza riscrittura
soltanto a chi ha `manage` sull'intera connessione; restano rifiutati per gli
altri utenti. Il driver continua a vietare più istruzioni raw accodate.
Le estensioni devono essere installate sul server. Una funzione che MySQL non
possiede non diventa una funzione MySQL solo perché esiste in PostgreSQL.

Le esecuzioni singole nella stessa scheda di connessione condividono una
sessione: `SET`, tabelle temporanee, variabili, `PREPARE`, cursori e transazioni
restano disponibili alla richiesta seguente. La disconnessione annulla le
transazioni aperte e distrugge la sessione. Gli script mantengono una sessione
separata, come già previsto dal runner; una transazione lasciata aperta a fine
script viene annullata, salvo la continuazione esplicita a blocchi del runner.

Su PostgreSQL `ROLLBACK`, `ROLLBACK TO SAVEPOINT`, `COMMIT` e `ABORT` raggiungono
il server senza comandi `SET` anteposti, anche dopo un errore nativo. La sessione
può quindi recuperare dal savepoint secondo le regole del server. Una connessione
persa non conserva la transazione: CodeDB segnala l'esito incerto senza ripetere
automaticamente le scritture.

Prima di ogni query ordinaria viene ristabilito il database/schema scelto nel
bersaglio. Un `ROLLBACK`, un savepoint o un `USE` precedente non possono lasciare
la richiesta successiva su una destinazione diversa. Questo vale anche dopo
`SET LOCAL`, `set_config`, `RESET ALL` e `DISCARD ALL`; il limite di tempo
configurato viene riapplicato.

Lo stato transazionale segue il protocollo dei server, anche quando un COMMIT
PostgreSQL fallisce per un vincolo differito o un DDL MySQL termina implicitamente
la transazione. Su MySQL il database corrente viene osservato anche dopo `USE`;
i comandi di preparazione ridondanti vengono evitati per conservare `ROW_COUNT()`,
`FOUND_ROWS()` e gli avvisi. Le righe SQL possono avere nomi come `affectedRows`
senza essere confuse con i messaggi del driver.

Se il server interrompe una connessione SQL inattiva, la prima operazione
successiva segnala l'interruzione e ripristina la connessione, senza ripetere
la query. Le richieste successive usano una nuova sessione. Il messaggio
avverte che transazioni, variabili e altri stati della sessione precedente
non sono stati ripristinati. Anche la disconnessione ordinaria chiude i client
persistenti e annulla le transazioni ancora aperte.

Nel runner MySQL, le direttive client `DELIMITER` separano le routine e non
vengono inviate come SQL. Stringhe e commenti conservano i delimitatori letterali.

Nelle query native i valori che JavaScript non può rappresentare fedelmente
vengono restituiti come **testo canonico del server**: date e timestamp con
microsecondi, JSON, array PostgreSQL con limiti inferiori, range, multirange,
compositi e tipi di estensione. I decimali lunghi restano testo esatto; il JSON
`null` si distingue dal valore SQL `NULL`. Non sono convertiti in Date, Number
o array JavaScript con perdita di informazione.

## Prove riproducibili

`test/e2e-sql-native.js` usa un server CodeDB isolato e passa attraverso Socket.IO.
Richiede PostgreSQL di prova su `55439`, MySQL su `33339` (configurabili con
`PGPORT` e `MYSQL_PORT`) e `CODEDB_E2E_DESTRUCTIVE=1`. Crea e rimuove soltanto
database/schemi casuali registrati dalla fixture. Il vault dell'utente non viene
letto né modificato.

`test/e2e-sql-native-ui.js` usa Chromium e tre connessioni reali, compreso il
replica set MongoDB di test su `27039`. Controlla la destinazione delle DDL,
le bozze, l'originale MongoDB e il selettore del motore su schermo mobile.

Le mutazioni in `test/fixtures/sql-native-mutant.cjs` alterano solo il codice
caricato nel processo di prova. Il resoconto e i log sono in
`test-reports/query-languages/native-*`.

`test/e2e-sql-native-provisioning.js` verifica autenticazione e persistenza dello
stack locale con stop e riavvio. Richiede anche `CODEDB_E2E_NATIVE_PROVISIONING=1`,
perché interrompe brevemente entrambi i motori locali. Il runner E2E generale
non include questa prova senza il flag esplicito.

`test/e2e-sql-native-sessioni.js` copre i cambi di destinazione dopo rollback,
savepoint e USE, le modifiche delle impostazioni SQL, la perdita della connessione
inattiva e durante una scrittura, il recupero senza ripetizioni automatiche e la
chiusura con transazioni aperte. `test/unit-sql-sessioni.js` controlla anche il
rilascio unico dei client attraverso i proxy e la rimozione dei listener.

Per preparare fixture isolate sulle porte dei test, con Docker Desktop:

```powershell
docker compose -f test/fixtures/sql-native-databases.yml up -d --wait
node test/fixtures/sql-native-init.cjs
$env:CODEDB_E2E_DESTRUCTIVE='1'
$env:PGPORT='55439'
$env:PG_PORT='55439'
$env:MYSQL_PORT='33339'
$env:MONGO_PORT='27039'
$env:NODE_OPTIONS='--require=./test/fixtures/sql-native-dns.cjs'
node test/e2e-sql-native-sessioni.js
node test/e2e-sql-native.js
node test/e2e-sql-native-ui.js
node test/e2e-query-audit.js
```

Il preload DNS riguarda solo il processo di test: dal computer indirizza i nomi
annunciati dal replica set alle porte loopback, senza modificare il DNS di
sistema. Le fixture non hanno credenziali di produzione e sono pubblicate solo
su localhost. I failover richiedono anche `CODEDB_E2E_FAILOVER_NODES=1` e arrestano
esclusivamente i nodi etichettati `codedb.test=sql-replica`.

Al termine, `docker compose -f test/fixtures/sql-native-databases.yml down -v`
rimuove container e volumi delle sole fixture. Lo stack persistente descritto
all'inizio usa un progetto Compose distinto.

L'[audit SQL/MQL del 14 ottobre](../test-reports/query-languages/quality-audit-completo.md)
riporta difetti riprodotti, correzioni, test reali, mutazioni e ambito verificato.
