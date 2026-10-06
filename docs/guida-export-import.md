# Guida operativa — export e import (parti verificate)

## Export dalla sidebar

«Esporta database…» permette di scegliere **Script SQL (.sql)** su MySQL e
PostgreSQL, oppure **CodeDB EJSON (.codedb.json)** sui tre motori. La scelta di
struttura, dati e oggetti si applica al file effettivo. SQL non rappresenta i
documenti e gli indici MongoDB: per MongoDB resta disponibile EJSON.

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
La finestra «Importa database» continua a leggere il formato CodeDB e offre
staging e recupero; eseguire uno script con il client SQL non usa quel percorso.

MySQL/InnoDB e PostgreSQL usano una sola transazione repeatable-read per export.
MongoDB e le tabelle MySQL non transazionali non hanno questa garanzia: per
ottenere un file coerente occorre sospendere le scritture. Un conteggio uguale
non dimostra che i valori non siano cambiati, e l'anteprima lo dichiara.

Il formato JSON condivide il limite configurato dell'import (64 MiB di default,
`CODEDB_MAX_IMPORT_BYTES` e quota `CODEDB_MAX_IMPORT_TOTAL_BYTES`): il limite è
mostrato prima della conferma e superarlo non produce un file dichiarato valido
ma non reimportabile. SQL usa la quota disco degli artefatti
(`CODEDB_ARTEFATTI_MAX_BYTES`, 10 GiB di default). Per file JSON più grandi occorre
dimensionare e aumentare il limite di import; l'import mantiene i documenti in
memoria durante validazione e staging.

Scrittura dei blocchi e lettura per il checksum usano I/O asincrono; il checksum
viene aggiornato a blocchi, lasciando avanzare l'event loop fra le letture.

Verifica dedicata: `test/unit-database-export.js`,
`test/e2e-export-regressioni.js` (porte MySQL e PostgreSQL esplicite) e
`test/e2e-export-formati.js`. Quest'ultimo richiede le porte esplicite
`EXPORT_MYSQL_PORT`, `EXPORT_PG_PORT`, `EXPORT_MONGO_PORT` di server di prova;
crea e rimuove soltanto database con nomi casuali. Se si indicano
`EXPORT_MYSQL_CONTAINER` e `EXPORT_PG_CONTAINER`, il roundtrip usa direttamente
mysql e psql nei container indicati.

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
PostgreSQL, topologia rilevata e assenza di snapshot globale su MongoDB.
Le operazioni di import scrivono un journal per tenant (`import-diario/`):
dopo un crash, la prima lettura dichiara `intervento_richiesto` a esito
incerto invece di presumere — mai completato presunto, mai cancellato da solo.

## Fedeltà dei tipi

Scritture EJSON sempre canoniche (`db/codecFedele.js`): `Long`, `Double`,
`Decimal128` e oltre-2^53 tornano distinti. I file relaxed storici restano
leggibili. Tabelle PostgreSQL senza chiave: keyset su `ctid`, mai `OFFSET`.

## Variabili

| Variabile | Default | Effetto |
|---|---|---|
| `CODEDB_ARTEFATTI_MAX_BYTES` | 10 GiB | Tetto del singolo artefatto |
| `CODEDB_ARTEFATTI_MAX_BLOCCO` | 4 MiB | Tetto del blocco (anche limite HTTP) |
| `CODEDB_ARTEFATTI_QUOTA_BYTES` | illimitata | Quota disco del tenant, controllo all'avvio |
| `CODEDB_ARTEFATTI_TTL_MS` | 24 h | Scadenza degli upload incompleti |
| `CODEDB_ARTEFATTI_RETENTION_MS` | mai | Scadenza dei finalizzati (opt-in) |
| `CODEDB_ARTEFATTI_SECRET` | effimero | Segreto HMAC dei ticket (riavvio li invalida) |
| `CODEDB_PG_DUMP`, … | PATH | Percorso del binario nativo dedicato |

## Non ancora (serve ambiente o browser)

Import selettivi completi sui DBMS, backend nativi di dump,
wizard DOM con progresso e accessibilità, benchmark e gate E2E estesi. Vedi
`gate-stato.md` per il dettaglio prova per prova.
