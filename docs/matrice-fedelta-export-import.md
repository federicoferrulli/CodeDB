# Fedeltà di import, export e backup

Verifica del 12 ottobre 2026 su MongoDB **8.0.29**, MySQL **8.4.11**, PostgreSQL **16.4** con PostGIS **3.4.3**. Test su istanze Docker usa-e-getta e nomi casuali, senza operare sui database dell'utente.

## Formati e percorsi

| Percorso | Contenuto |
|---|---|
| **Esporta database → CodeDB**, oppure **Esporta CodeDB · tipi completi…** su una tabella | Struttura, metadati e dati. MongoDB usa BSON grezzo in base64, SQL rappresentazioni native esatte e marcatori tipizzati. Import con anteprima, staging, verifica e recupero. |
| **Script SQL** CodeDB | MySQL e PostgreSQL: letterali binari/numerici/testuali e cast espliciti. Importabile da CodeDB e dai client del motore. MongoDB non ha un equivalente SQL completo. |
| **Backup** | Manifest v4, dati a blocchi, SHA-256; BSON grezzo, valori SQL esatti e file binari separati per i Large Object. Full, incrementale, differenziale e cancellazioni. |
| JSON/EJSON o CSV della griglia | Interscambio dei dati. CSV non descrive tipi o vincoli. EJSON è interoperabile ma non rappresenta tutte le particolarità del BSON grezzo. Per il trasferimento completo usare CodeDB. |
| Dump esterni | Dump **testuali** dello stesso motore: mysqldump, INSERT multipli nello stile phpMyAdmin, pg_dump plain con INSERT/COPY. Nessuna conversione automatica fra DBMS. |

L'estensione `.codedb.json` rimane la stessa. I nuovi file MongoDB dichiarano `versione: 2` e `encoding: "bson-base64"`. I vecchi artefatti restano leggibili, ma precisione o tipi già persi nel file non sono ricostruibili. Dopo l'aggiornamento iniziare una nuova catena con un backup full.

## Tipi verificati su database reali

| Motore | Copertura e confronto |
|---|---|
| MongoDB | Tutti i tag BSON memorizzabili, inclusi Undefined, Symbol, DBPointer, Code/Scope, MinKey/MaxKey. Binary con sottotipi 0–9 e 128; NaN, −0, interi estremi, date oltre il range JavaScript, documenti vicini a 16 MiB, GridFS. Confronto **byte BSON per byte BSON** e byte dei chunk. JSON CodeDB, full e incrementale. |
| MySQL | **50 casi**: interi signed/unsigned, BOOLEAN, DECIMAL(65,30), FLOAT/DOUBLE, BIT, CHAR/VARCHAR, tutte le famiglie TEXT/BLOB, BINARY/VARBINARY, DATE/DATETIME/TIMESTAMP/TIME/YEAR, JSON, ENUM/SET, tutte le famiglie geometriche e SRID. Date zero, microsecondi, Unicode fuori BMP, NULL, stringa vuota ENUM distinta dall'indice 0, SET a 64 bit. Confronto dei valori e uguaglianza numerica sul server; geometrie/binari byte per byte. JSON CodeDB, SQL e backup. |
| PostgreSQL | **103 casi**: numerici e speciali, money, boolean, caratteri, bytea/bit, temporali, UUID, rete/MAC, JSON/JSONB/JSONPath/XML, ricerca testuale, geometrie native, range/multirange predefiniti, array multidimensionali con limiti non standard, enum/domain/composite, tipo base custom, range con funzione canonica, collation ICU, hstore/citext, PostGIS/geography, OID e alias reg*, xid/cid/tid/LSN/snapshot, aclitem[]. Confronto del formato nativo del server e delle firme dei riferimenti. JSON CodeDB, SQL CodeDB, backup e pg_dump. |
| PostgreSQL: combinazioni | Domini su regproc, array di domini, compositi con regproc/regoper e array, domini su array di compositi. NULL, escaping e firme di funzioni sovraccariche. JSON, SQL e backup; esecuzione diretta sul server delle espressioni SQL esportate. |
| PostgreSQL: Large Object | OID scalari, array, domini e compositi; regclass; aggiornamento del binario senza modificare la riga; ripristino selettivo. Byte identici e nuovi OID indipendenti, anche da pg_dump `--blobs`. Prova da **128 MiB** con SHA-256 integrale. |

Fixture: `test/e2e-tipi-bson.js`, `test/e2e-tipi-sql.js`, `test/e2e-tipi-riferimenti.js`, `test/e2e-tipi-large-objects.js`. Gli elenchi SQL dettagliati sono anche in `test-reports/import-export-2026-10-12/tipi-mysql.json` e `tipi-postgresql.json`.

## Correzioni nel motore

- MongoDB trasferisce i dati completi senza convertirli in oggetti JavaScript. Tag storici, date estreme e bit dei numeri non vengono normalizzati dal driver. Upsert e cancellazioni conservano l'identità BSON originale; GridFS conserva collection, indici, metadati e chunk.
- MySQL legge FLOAT con precisione sufficiente, ENUM/SET come ordinali e geometrie come SRID + WKB. Ricostruisce le definizioni ENUM/SET con caratteri fuori BMP dai valori reali: nel catalogo di MySQL 8.4 possono diventare `?`. Per l'indice ENUM 0 tollera solo i warning previsti per quella colonna **e quella riga**, mai warning troncati o altre conversioni.
- PostgreSQL conserva dipendenze dei tipi, collations ed estensioni, e ricrea le routine prima dei valori che le referenziano. I riferimenti agli overload includono la firma anche quando annidati. Clona i Large Object e aggiorna gli OID, senza modificare gli originali.
- Il backup PostgreSQL legge con un cursore nella snapshot: nessun ordinamento lessicografico accidentale degli alias convertiti in testo, né dipendenza dal tipo della chiave o da `ctid`. L'export paginato ordinario ordina sulle colonne originali; i cursori MySQL conservano i byte delle chiavi.
- I Large Object del backup viaggiano in blocchi da 1 MiB, con file binario e checksum. La pulizia esplicita di un import fallito elimina i binari dello staging e conserva quelli originali; prima di pulire una promozione dall'esito incerto occorre verificarne il risultato.

## Coerenza durante le scritture

MySQL/InnoDB e PostgreSQL leggono in una snapshot `repeatable-read`. MongoDB usa una sessione snapshot condivisa fra le collection su replica set/sharding compatibili (MongoDB 5+). Il test su replica set modifica i dati durante export e backup e verifica l'istante originale. Il catalogo non deve subire DDL concorrenti.

MongoDB standalone e tabelle MySQL non transazionali richiedono di sospendere le scritture per una copia coerente. Un conteggio uguale non prova l'assenza di modifiche ai valori. Il manifest dichiara la consistenza disponibile.

Le identità degli incrementali sono rilevate nella stessa snapshot dei dati. MongoDB, senza un campo affidabile di modifica, rilegge tutti i documenti: il timestamp di `_id` non rileva aggiornamenti. Un campo `updatedAt`/`sinceField` deve essere aggiornato da **ogni** modifica applicativa; un filtro temporale non può rilevare modifiche che non aggiornano quel campo.

## Prerequisiti e limiti

- PostgreSQL: il “database” della UI è uno **schema**. Tipi/funzioni esterni, estensioni e librerie native devono esistere con versioni compatibili; i file dell'estensione non vengono esportati. Testate hstore, citext e PostGIS, non tutte le estensioni di terze parti né ogni tipo base con funzioni I/O arbitrarie. Ruoli, ACL, policy RLS, sharding e configurazione del server non sono un dump completo dell'istanza.
- I Large Object sono scoperti tramite colonne OID e contenitori tipizzati. Un intero applicativo che nasconde un riferimento LO non è distinguibile da un normale numero. I LO globali non referenziati non appartengono all'export di schema.
- `pg_dump` può rappresentare regproc/regoper col solo nome, ambiguo in presenza di overload. Le prove pg_dump usano nomi univoci per questi campi; gli overload sono verificati nei formati CodeDB e nei backup. Una firma assente dal dump non è ricostruibile: [alias OID PostgreSQL](https://www.postgresql.org/docs/16/datatype-oid.html).
- Ricostruire ENUM/SET MySQL con caratteri fuori BMP richiede `CREATE TEMPORARY TABLES`. Le tabelle temporanee sono isolate e rimosse al termine.
- Import dall'app: **64 MiB per file** di default, configurabile con `CODEDB_MAX_IMPORT_BYTES` e quota totale. Upload a blocchi, ma il piano conserva i documenti validati in memoria: **non è un import a memoria costante per file arbitrariamente grandi**. Per grandi binari il backup/restore è il percorso verificato in streaming. Base64 aumenta la dimensione del BSON.
- Il trasporto BSON grezzo usa un componente interno del driver MongoDB: un aggiornamento del driver richiede i roundtrip reali. Nessuna promessa di recuperare dati già troncati da export esterni o precedenti.

## Prove e sensibilità

Log e risultati: `test-reports/import-export-2026-10-12/`.

Oltre ai tipi: 100.000 record per motore con hash integrale; 1.601 righe per tabella con chiavi numeriche/binarie e duplicati senza chiave; incrementali con upsert/cancellazioni; vincoli, indici, view, sequenze, swap PostgreSQL atomico, recupero dopo errore e cleanup LO fallito/selettivo. Suite unitaria completa eseguita.

Le opzioni `--mutant` alterano soltanto i processi usa-e-getta. I test falliscono realmente su arrotondamento numerico, ENUM 0 trasformato in stringa vuota valida, BSON deserializzato/riscritto, byte LO alterato, snapshot disattivata, cancellazioni omesse, overload scambiato, pagina troncata e controllo dei warning disattivato.

Non eseguiti: UI/browser, MongoDB sharded reale, MySQL non transazionale, matrice completa di versioni/estensioni, prove multi-TB e variante MongoDB autenticata del test `drop negato`. Vedere [benchmark](benchmark-export-import.md) e [guida operativa](guida-export-import.md).
