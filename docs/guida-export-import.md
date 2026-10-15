# Guida operativa — export e import (parti verificate)

## Export JSON da Query e Aggregate

«Esporta JSON» scarica un array JSON standard con tutte le righe caricate,
nell'ordine mostrato. La conversione vale anche dentro oggetti e array:
ObjectId diventano stringhe, date diventano stringhe ISO e interi rappresentabili
senza arrotondamento diventano numeri. Decimali e interi oltre la precisione
sicura di JavaScript restano stringhe per conservare tutte le cifre.

I binari diventano stringhe base64, le espressioni regolari oggetti
`{ "pattern": "…", "options": "…" }` e i timestamp BSON oggetti `{ "t": …, "i": … }`.
NaN e infinito restano stringhe; le date fuori dall'intervallo ISO conservano
i millisecondi originali come stringa. I tag BSON non vengono conservati:
per un ripristino con i tipi completi usare l'export CodeDB dalla sidebar.

## Export dalla sidebar

«Esporta database…» permette di scegliere **Script SQL (.sql)** su MySQL e
PostgreSQL, oppure **CodeDB (.codedb.json)** sui tre motori. La scelta di
struttura, dati e oggetti si applica al file effettivo. SQL non rappresenta i
documenti e gli indici MongoDB: il formato CodeDB contiene BSON grezzo in base64,
che conserva anche tag storici, date estreme e sottotipi binari. Il menu della
tabella offre «Esporta CodeDB · tipi completi…» con la tabella già selezionata.

Il server conserva il piano confermato, produce il file a blocchi su disco,
verifica i conteggi e il checksum e solo allora offre il download HTTP.
Il browser non tiene una copia del database. Il motore usato è quello
incorporato: la presenza di `mysqldump` o `pg_dump` non cambia questo percorso.
L'accesso al catalogo e all'esecuzione richiede lettura sull'intera connessione.

Lo script SQL contiene il database/schema di origine e si esegue con il client
del motore, per esempio `mysql -u utente -p < database.sql` oppure
`psql -U utente -d database_fisico -v ON_ERROR_STOP=1 -f schema.sql`.
Le routine MySQL usano la direttiva `DELIMITER` del client mysql.
Gli script preservano gli ID MySQL pari a zero e gli istanti temporali usando
UTC durante export e ripristino. Al termine MySQL ripristina modalità SQL,
fuso orario e controllo FK della sessione destinataria.
L'export SQL «solo dati» gestisce anche FK cicliche, composte e autorelazioni:
i vincoli vengono verificati dopo il caricamento e prima del commit. Su MySQL
serve il privilegio `CREATE TEMPORARY TABLES`; su PostgreSQL occorre poter
alterare i vincoli delle tabelle. Gli errori devono fermare il client SQL:
non usare opzioni che proseguono dopo un errore. Il rollback dei dati richiede
tabelle transazionali; le DDL MySQL non sono annullabili come un'unica transazione.
Le viste materializzate PostgreSQL vengono definite senza dati e popolate dopo
il caricamento delle tabelle, nell'ordine delle dipendenze. Le routine possono
quindi riferire le viste già durante la propria creazione.
La finestra «Importa database» legge sia CodeDB EJSON sia dump SQL testuali
del motore della connessione. Entrambi passano da anteprima, conferma del piano,
staging, verifica e recupero. Eseguire uno script con il client SQL esterno
non usa questo percorso protetto.

## Import dalla sidebar

| Connessione | File |
|---|---|
| MongoDB | `.codedb.json`, BSON completo; compatibile con gli artefatti EJSON storici |
| MySQL | `.codedb.json` o `.sql` di CodeDB, mysqldump e INSERT multipli nello stile phpMyAdmin |
| PostgreSQL | `.codedb.json` o `.sql` di CodeDB e pg_dump in formato plain, con INSERT o COPY testuale |

Il file deve essere UTF-8 e contenere un solo database/schema dello stesso
motore della connessione. Non si tratta di una conversione tra DBMS.
Per MySQL usare `--hex-blob --default-character-set=utf8mb4` nel dump:
i byte binari non devono essere interpretati come testo. Per PostgreSQL usare
`pg_dump --format=plain --schema=<schema> --no-owner --no-privileges`.
Per MongoDB il JSON generico di una collection si importa dalla griglia;
il comando «Importa database» richiede l'involucro CodeDB con struttura e indici.

Il parser riconosce i valori senza convertirli in numeri JavaScript, conserva
NULL, stringhe vuote, binari, geometrie, precisione decimale e microsecondi.
Supporta DELIMITER, commenti eseguibili di mysqldump, COPY con escape e
sequenze PostgreSQL con nome, proprietà, incremento e stato `is_called`.
Le regole di escape seguono il dialetto: [stringhe MySQL](https://dev.mysql.com/doc/refman/8.0/en/string-literals.html)
e [COPY PostgreSQL](https://www.postgresql.org/docs/17/sql-copy.html).
Gli ID MySQL pari a zero e i TIMESTAMP sopravvivono anche al passaggio di
backup/ripristino usato dalla promozione. Un fuso esplicito nel dump MySQL viene
applicato durante il caricamento; i nuovi export CodeDB usano UTC.

Proprietari, privilegi e commenti SQL non vengono trasferiti: l'interfaccia
lo segnala prima della conferma. Comandi non riconosciuti, espressioni SQL
arbitrarie nei valori, dump binari/compressi e COPY da filesystem o programmi
non vengono eseguiti. Un errore di parsing interrompe la validazione prima di
scrivere nei database. Per INSERT senza elenco colonne serve la CREATE TABLE
nel file. Una singola istruzione o riga SQL può occupare al massimo 32 MiB.

Il browser legge a blocchi, controlla UTF-8 e libera gli upload abbandonati.
I batch SQL rispettano un budget di circa 1 MiB e il limite dei parametri;
la validazione e l'impronta non duplicano più ripetutamente tutto l'artefatto.
Colonne sconosciute, conversioni MySQL segnalate dal server e conflitti su
identità diverse non vengono ignorati. Le colonne generate vengono ricalcolate
dal DBMS. Un import incompleto non viene promosso come riuscito.

La sostituzione dello schema PostgreSQL è atomica; MySQL e MongoDB usano
staging e copia di recupero verificata. Per questi ultimi non c'è uno swap
atomico: evitare scritture concorrenti sulla destinazione durante la promozione.

MySQL/InnoDB e PostgreSQL usano una sola transazione repeatable-read per export.
MongoDB usa una sessione snapshot comune alle collection su replica set e
cluster sharded compatibili (MongoDB 5+); mantenere stabile la struttura.
Su MongoDB standalone e tabelle MySQL non transazionali occorre sospendere
le scritture per ottenere un file coerente. Un conteggio uguale
non dimostra che i valori non siano cambiati, e l'anteprima lo dichiara.

Gli export JSON e SQL **non hanno un limite alla dimensione del file**:
non ereditano `CODEDB_MAX_IMPORT_BYTES`, `CODEDB_MAX_IMPORT_TOTAL_BYTES` né
`CODEDB_ARTEFATTI_MAX_BYTES`. La scrittura procede a blocchi su disco e il
registro dei blocchi dell'export conserva solo l'ultimo, senza crescere con
il file. Servono spazio libero e, se l'operatore ha configurato una quota
disco del tenant, spazio disponibile in quella quota.

L'import dall'app mantiene il proprio limite (64 MiB di default,
`CODEDB_MAX_IMPORT_BYTES` e `CODEDB_MAX_IMPORT_TOTAL_BYTES`), sia per JSON sia
per SQL: il server conserva i documenti validati in memoria durante anteprima
e staging. Per reimportare dall'app un export più grande occorre dimensionare
e aumentare questi limiti. Gli script SQL restano eseguibili anche con il client
nativo del DBMS.

Scrittura dei blocchi e lettura per il checksum usano I/O asincrono; il checksum
viene aggiornato a blocchi, lasciando avanzare l'event loop fra le letture.

Verifica dedicata: `test/unit-database-export.js`,
`test/e2e-export-regressioni.js` (porte MySQL e PostgreSQL esplicite) e
`test/e2e-export-formati.js`. Quest'ultimo richiede le porte esplicite
`EXPORT_MYSQL_PORT`, `EXPORT_PG_PORT`, `EXPORT_MONGO_PORT` di server di prova;
crea e rimuove soltanto database con nomi casuali. Se si indicano
`EXPORT_MYSQL_CONTAINER` e `EXPORT_PG_CONTAINER`, il roundtrip usa direttamente
mysql e psql nei container indicati, oltre a dump prodotti da mysqldump e pg_dump.
`test/e2e-import-volume.js` confronta tutti i valori di 12.000 righe per motore
e verifica le sequenze nel restore PostgreSQL selettivo. Le misure sono in
`test-reports/import-export-2026-10-12/volume.json`.
`test/e2e-import-upload-ui.js` copre File.stream, UTF-8, limiti dei blocchi,
annullamento e drawer mobile. Il trasporto di questo test UI è simulato;
quello dei roundtrip sopra è reale.

Le sezioni seguenti descrivono i moduli e le verifiche del piano originale.
Il resto del piano resta nelle issue di
`.scratch/export-import-fedele/` e in `gate-stato.md`: questa guida non lo
promette.

## Piani: un contratto, non un modulo

Export (`db/exportPlan.js`), selezione import (`db/selezioneImport.js`) e
import/restore (`db/importPlan.js`) costruiscono oggetti immutabili firmati
dalla stessa impronta (`db/pianoComune.js`). L'anteprima mostra il piano, la
conferma ne fissa l'impronta, l'esecuzione la ricontrolla: se divergono,
l'esecuzione rifiuta. Il riepilogo per la UI è `public/js/riepilogo-piano.js`.

## Data-plane HTTP: i file viaggiano qui

I comandi restano su Socket.IO; i byte passano da:

- `POST /artefatti/caricamenti` → apre la sessione, risponde con `uploadId` e
  ticket di blocco. Serve il ticket `caricamenti`, emesso via socket con
  l'evento `artefatti:ticket` (solo chi amministra il tenant).
- `POST /artefatti/caricamenti/:id/blocco` → un blocco binario con header
  `x-codedb-offset` e `x-codedb-blocco-sha256`. Ripetere un blocco già scritto
  è idempotente; conflitti e buchi sono rifiutati (409).
- `POST /artefatti/caricamenti/:id/finalizza` → verifica dimensione e SHA-256
  dichiarati e pubblica manifest + ticket di download. Impronta errata: 409,
  niente pubblicato.
- `POST /artefatti/caricamenti/:id/scarta` → cancella l'incompleto.
- `GET /artefatti/:id/scarica?ticket=…` (anche HEAD) → 200/206/416 con `ETag`
  = SHA-256, `Accept-Ranges`, ripresa via `Range`/`If-Range`.

Autenticazione: ticket brevi (5 minuti) legati a risorsa, attore e tenant —
mai il token di sessione nell'URL. Ogni evento di ciclo di vita e ogni rifiuto
finisce in `<tenant>/artefatti/trasferimenti.log`, senza ticket né byte.

## Coerenza e diario: cosa dichiara ogni backup

Il manifest riporta `coerenza`: snapshot `repeatable-read` su MySQL e
PostgreSQL; per MongoDB, topologia e disponibilità della sessione snapshot.
Le operazioni di import scrivono un journal per tenant (`import-diario/`):
dopo un crash, la prima lettura dichiara `intervento_richiesto` a esito
incerto invece di presumere — mai completato presunto, mai cancellato da solo.

## Fedeltà dei tipi

I nuovi export completi MongoDB usano BSON grezzo; quelli SQL conservano
valori nativi, microsecondi, decimali, binari e geometrie senza conversioni
del driver. I file storici restano leggibili, ma dati già persi non si ricreano.
PostgreSQL usa un cursore DBMS nel backup anche senza chiave primaria.
Il manifest v4 salva i Large Object referenziati in file binari separati;
il restore li clona e aggiorna gli OID. Le librerie delle estensioni PostgreSQL
devono già essere installate con versioni compatibili. Per MySQL, ENUM/SET
con caratteri fuori BMP richiedono `CREATE TEMPORARY TABLES`.

Copertura dei tipi, prove e prerequisiti: [matrice di fedeltà](matrice-fedelta-export-import.md).

## Variabili

| Variabile | Default | Effetto |
|---|---|---|
| `CODEDB_ARTEFATTI_MAX_BYTES` | 10 GiB | Tetto del singolo upload; non limita gli export |
| `CODEDB_ARTEFATTI_MAX_BLOCCO` | 4 MiB | Tetto del blocco (anche limite HTTP) |
| `CODEDB_ARTEFATTI_QUOTA_BYTES` | illimitata | Quota disco del tenant, controllo all'avvio e durante gli export |
| `CODEDB_ARTEFATTI_TTL_MS` | 24 h | Scadenza degli upload incompleti |
| `CODEDB_ARTEFATTI_RETENTION_MS` | mai | Scadenza dei finalizzati (opt-in) |
| `CODEDB_ARTEFATTI_SECRET` | effimero | Segreto HMAC dei ticket (riavvio li invalida) |
| `CODEDB_PG_DUMP`, … | PATH | Percorso del binario nativo dedicato |

## Verifiche e misure

Test reali dei tipi, dump nativi, recupero, ripristino selettivo e misure
su 100.000 record per motore: [benchmark](benchmark-export-import.md).
Non verificati in questa sessione: UI/browser, cluster MongoDB sharded,
tutte le versioni/estensioni dei DBMS e carichi multi-TB. L'app usa il proprio
motore di trasferimento; non avvia automaticamente tool di dump nativi.
