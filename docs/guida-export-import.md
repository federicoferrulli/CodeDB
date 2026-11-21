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

Il menu del database offre **Esporta database…** su MySQL e PostgreSQL e
**Esporta o copia il database…** su MongoDB. Tutti e tre i motori permettono
di scaricare un archivio **CodeDB (.codedb.json)**. Su MySQL e PostgreSQL si
può scaricare anche uno **script SQL (.sql)**. Su MongoDB si può copiare in un
altro database oppure scaricare uno **script mongosh (.js)**. La selezione di struttura, dati e
oggetti si applica sia alla copia sia al file. SQL non rappresenta i
documenti e gli indici MongoDB: il formato CodeDB contiene BSON grezzo in base64,
che conserva anche tag storici, date estreme e sottotipi binari. Per esportare
una singola tabella MySQL o PostgreSQL, aprire «Esporta SQL o CodeDB con opzioni…»
dal suo menu.

### Copiare su MongoDB da CodeDB

Nel wizard **Esporta o copia il database** scegliere **Copia in un altro database MongoDB** nel menu
**Formato o operazione**. Selezionare una connessione MongoDB aperta e indicare
il database di destinazione. Sulla stessa istanza scegliere un database diverso
dall’origine. Due server distinti possono usare lo stesso nome di database.
È possibile aprire lo stesso wizard dal menu della singola collection.

Aprire **Anteprima della copia**, controllare origine, destinazione e oggetti,
quindi selezionare **Avvia copia**. CodeDB applica la selezione con il driver MongoDB. Il resoconto
mostra i documenti inseriti, aggiornati, sostituiti e mantenuti, insieme alle
collection e alle viste create o ricreate. Un documento già identico viene
contato fra i mantenuti. Se una scrittura fallisce, i conteggi parziali
descrivono le operazioni già confermate. Quelle operazioni restano applicate.
Se il browser perde la connessione, mostra l’ultimo avanzamento ricevuto.
Il server registra l’esito e i conteggi disponibili nello storico Audit,
alla voce «Copia MongoDB diretta».

Per usare una collection già popolata scegliere **Solo dati**. Il confronto
avviene per `_id`. I documenti con un nuovo `_id` vengono inseriti in tutte
le modalità.

| Se il documento esiste | Effetto |
| --- | --- |
| Inserisci | Il duplicato genera un errore. |
| Mantieni | Conserva l’intero documento presente. |
| Aggiorna | Scrive i campi esportati e conserva gli altri campi di primo livello. Un sottodocumento o un array esportato viene sostituito per intero. |
| Sostituisci | Rimpiazza il documento con quello esportato, eliminando anche i campi presenti soltanto a destinazione. |

Per **struttura e dati**, si può creare, creare solo se assente oppure eliminare
e ricreare. Il riuso conserva indici e opzioni locali. La ricreazione ripristina
la definizione esportata ed elimina i documenti precedenti. L’anteprima indica
i nomi delle collection e delle viste che la ricreazione potrà eliminare. Una
collection inclusa soltanto come dipendenza di una vista viene conservata se esiste.

Per una collection time-series scegliere **Inserisci**. Questa modalità
trasferisce i documenti in BSON grezzo e conserva anche tipi storici o date
fuori dall’intervallo JavaScript. Le modalità che confrontano i documenti
per `_id` segnalano i valori che il driver non può convertire fedelmente.

### Scaricare uno script mongosh

Il formato predefinito su MongoDB è l’archivio BSON completo. Per ottenere
un file eseguibile, scegliere **Scarica lo script di copia per mongosh (.js)**.
Aprire **Anteprima dello script** e confermare con **Scarica script** per salvare il file.
La copia avviene solo quando si esegue lo script, per esempio con
`mongosh "mongodb://localhost:27017" --file negozio.mongosh.js`. Il file
seleziona il database di origine indicato nell’anteprima. Le operazioni sono
applicate in ordine. Se un indice univoco o un validatore rifiuta una scrittura,
le operazioni precedenti possono essere già state applicate. Per il replay
usare una finestra senza modifiche concorrenti. [Esecuzione di script con mongosh](https://www.mongodb.com/docs/mongodb-shell/write-scripts/)

Il file trasferisce la struttura logica degli oggetti selezionati. La
configurazione del cluster e dello sharding va predisposta sulla destinazione.
Le time-series supportano l’inserimento delle misure. Per le collection con
Queryable Encryption, l’export di script si ferma perché il trasferimento
richiede anche le chiavi e le collection di stato. Se un valore BSON non ha una
rappresentazione fedele nello script, l’export lo segnala prima del download.
Per conservare quei byte scegliere **CodeDB · BSON completo**.

### Script SQL

Con **Script SQL** si sceglie come applicare il file alla destinazione. Le
impostazioni iniziali generano `CREATE TABLE` per la struttura e `INSERT` per
le righe. «Crea solo se assente» conserva la struttura delle tabelle esistenti.
«Elimina e ricrea» scrive `DROP TABLE IF EXISTS` per le tabelle elencate
nell’anteprima. Quando si esegue il file, queste perdono anche le righe presenti
solo a destinazione. Scegliere «Solo dati» per lavorare sulle righe di tabelle
già predisposte.

| Righe duplicate | MySQL | PostgreSQL |
| --- | --- | --- |
| Aggiornare la riga esistente | `INSERT … ON DUPLICATE KEY UPDATE` | `INSERT … ON CONFLICT (…) DO UPDATE` su una chiave primaria o un indice univoco compatibile |
| Mantenere la riga esistente | Autoassegnazione su duplicato. Possono scattare i trigger di aggiornamento | `INSERT … ON CONFLICT DO NOTHING` |
| Sostituire la riga | `REPLACE INTO` elimina le righe in conflitto prima di inserire quella esportata | Usare l’aggiornamento su conflitto per modificare la riga |

Su PostgreSQL l’aggiornamento confronta una sola chiave. La violazione di
un altro vincolo univoco può fermare lo script. Su MySQL `REPLACE` attiva
anche le azioni `ON DELETE` delle chiavi esterne, comprese le cancellazioni
a cascata di righe figlie. Per applicare le opzioni, eseguire il file con
`mysql` o `psql` durante una finestra senza scritture concorrenti.
Il wizard di import usa un proprio piano di staging e sostituzione della
destinazione. [MySQL REPLACE](https://dev.mysql.com/doc/refman/8.4/en/replace.html) · [MySQL ON DUPLICATE KEY UPDATE](https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html) · [PostgreSQL ON CONFLICT](https://www.postgresql.org/docs/17/sql-insert.html)

Con le opzioni avanzate PostgreSQL, selezionare i dati delle singole partizioni
che si vogliono trasferire. La struttura di una partizione include quella del
padre come dipendenza. La ricreazione di un padre si ferma se eliminerebbe
anche una partizione esclusa. Le chiavi esterne già presenti nella destinazione
restano attive. Un ciclo con vincoli immediati può richiedere che le righe
riferite esistano prima del caricamento.

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
L'export SQL «solo dati» con `INSERT` semplice gestisce anche FK cicliche, composte e autorelazioni:
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
`test/e2e-export-mongosh.js` scarica lo script via HTTP e lo esegue con
`mongosh` su un database di prova. Richiede `EXPORT_MONGO_PORT` e usa il
client locale oppure quello del container indicato da `EXPORT_MONGO_CONTAINER`.
`test/e2e-export-opzioni-sql-ui.js` verifica nel browser le scelte per gli
script SQL e mongosh, dall’apertura del wizard all’anteprima.
`test/e2e-export-mongo-diretto.js` esegue la copia dal browser su due istanze
MongoDB e confronta il resoconto con i dati effettivi, anche dopo un errore.
Usa `EXPORT_MONGO_PORT`, `EXPORT_MONGO_TARGET_PORT` e `CODEDB_E2E_DESTRUCTIVE=1`
per i database casuali della prova.
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
