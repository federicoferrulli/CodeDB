# Laboratorio di integrità backup e trasferimenti

La suite `node test/lab/integrita.cjs` lavora contro MongoDB, MySQL e PostgreSQL
reali. Richiede `CODEDB_E2E_DESTRUCTIVE=1`; crea nomi casuali registrati come propri,
avvia un server CodeDB isolato e rimuove solo le proprie fixture e gli staging
derivati. Non usa il vault o il file di connessioni dell'utente.

| Variabile | Default su host Windows |
|---|---|
| `MONGO_PORT` | `37017` |
| `MYSQL_PORT`, `MYSQL_PASSWORD` | `33306`, `lab_mysql` |
| `PG_PORT`, `PG_PASSWORD` | `35432`, `lab_postgres` |
| `LAB_INTEGRITA_PORT` | `3244` |
| `LAB_REPORT_DIR` | `.scratch/lab-reports` |

In container impostare le porte interne dei servizi. MongoDB usa sempre una
connessione diretta, evitando di seguire indirizzi del replica set fuori dal
laboratorio. I processi CLI usano esplicitamente `TZ=Europe/Rome`, mentre le
sessioni native SQL usano UTC: questa differenza fa parte della prova.
Le connessioni puntano a `127.0.0.1`: il runner deve condividere la rete dei
database, come fa `compose.yml` con `network_mode: service:rete`. Servono Node.js
con `fetch`, `structuredClone` e `fs.cpSync` (il runner usa Node 24) e le
dipendenze npm del repository. Non servono client CLI esterni dei database.
Il caso geometrico PostgreSQL usa il tipo nativo `POINT`; questa suite non
richiede l'estensione PostGIS.

## Cosa viene verificato

- MongoDB: 2.507 documenti con Long oltre 2^53, Decimal128, Double/Int32, -0,
  Binary, UUID, Timestamp, ObjectId, regex BSON, MinKey/MaxKey/NaN, date,
  documenti annidati, geometrie, indici e validatore; collection vuota.
- MySQL e PostgreSQL: 2.203 righe ciascuno, PK composte con BIGINT oltre 2^53,
  decimali esatti, Unicode, caratteri di controllo, byte arbitrari, temporali con
  microsecondi, JSON con interi grandi, geometrie, colonne generate, FK e view.
  MySQL aggiunge ENUM/SET/BIT/SRID; PostgreSQL domini, enum, array NUMERIC,
  intervalli, range, INET e UUID.
- Backup CLI full, incremental e differential; checksum e restore su un nome
  diverso; aggiornamenti, inserimenti e cancellazioni; casi minimi view e fusi.
- Export HTTP e import socket `.codedb.json`, più SQL per i due motori SQL;
  upload a blocchi, fingerprint errata, ticket download mancante, staging.
- Confronti finali via driver nativi, senza usare il codice CodeDB come oracolo.
  I valori SQL sensibili sono letti come testo/hex dal DBMS.
- Sensibilità: cancellazione reale nella copia ripristinata/importata, alterazione
  deliberata di riga/valore nell'oracolo e byte aggiunti a un archivio vero.
  La verifica deve rilevare il danno; il restore corrotto deve conservare una
  sentinella preesistente nella destinazione.

Il report JSON include esito, durata, errore e hash dei contenuti; la cartella
`integrita-artifacts` conserva backup e metadati nativi per diagnosticare i FAIL.
La suite esce con codice 1 se almeno una verifica fallisce. I difetti noti non
sono trasformati in successi attesi.

## Risultato del 21 ottobre 2026

Ultima esecuzione host: 43 verifiche, **27 PASS e 16 FAIL**, circa 121 secondi;
MongoDB 8.0.34, MySQL 8.4.11, PostgreSQL 17.5. I FAIL possono avere una causa
comune e non rappresentano sedici difetti distinti.

| Difetto osservato | Evidenza e attribuzione |
|---|---|
| PostgreSQL: l'incrementale salta nuove righe `TIMESTAMP` senza fuso | Caso minimo: full con una riga, inserimento con `CURRENT_TIMESTAMP`, incremental `SUCCESSO` con **0 righe anziché 1**. Sessione UTC, processo Europe/Rome. Confermato anche senza view, FK o tipi personalizzati. Il parametro Date in `backup/lib/engine.js` viene confrontato con il timestamp locale. |
| PostgreSQL: restore rifiuta un indice ordinario/parziale | Il backup mette `CREATE INDEX` dentro `objects.foreignKeys`; `db/artefatti.js` accetta lì solo `ALTER TABLE`. Falliscono full, incremental e differential. |
| SQL: catene con view falliscono al secondo layer | Riproduzione minima separata su entrambi i DBMS: 2 righe corrette, ma `CREATE VIEW` ripetuto produce `already exists`. Il restore si interrompe e conserva lo staging. |
| MongoDB: validatori con default impliciti bloccano restore/import | L'origine omette `validationLevel` e `validationAction`; `collMod` nello staging materializza `strict` e `error`. Il confronto interpreta i default equivalenti come oggetti diversi. Con default espliciti passano full, incremental, differential e JSON con tutti i valori BSON. |
| MySQL: verifica schema del restore respinge FK e charset equivalenti | FK presente realmente nello staging, ma `schemaOf` usa `tableAuxDdl` ereditato vuoto. Inoltre `SHOW CREATE TABLE` esplicita `CHARACTER SET utf8mb4` nello staging dove l'origine lo omette: confronto testuale divergente. JSON/SQL export-import passano e la FK rifiuta un orfano. |
| PostgreSQL: restore full con colonna generata fallisce verifica DDL | Anche tolto l'indice aggiuntivo, il restore fallisce su `table:Misure Storiche`. Il catalogo nativo conserva tipi ed espressione generata; il percorso `PostgreSqlStrategy.tableDdl` non gestisce la colonna generata come `pgCreateTable`. Attribuzione al confronto DDL, da isolare ulteriormente nel fix. |

Questa suite non certifica la piattaforma: copre questi percorsi con questi
motori/versioni. Non prova storage cloud, perdita di alimentazione, migrazioni tra
versioni del DBMS, grandi volumi, tutte le impostazioni di collation/timezone,
ogni tipo SQL o installazione e aggiornamento dei pacchetti desktop.
