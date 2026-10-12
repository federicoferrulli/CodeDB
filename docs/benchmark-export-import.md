# Misure di import/export — 12 ottobre 2026

Misure locali riproducibili, non una garanzia di throughput in produzione. Node **26.2.0**, Windows, Intel Core Ultra 7 155H (16 core, 22 processori logici), motori in Docker raggiunti su loopback: MySQL 8.4.11, PostgreSQL 16.4/PostGIS 3.4.3, MongoDB 8.0.29. Cache non svuotata; altre attività di test erano presenti. RAM totale, modello del disco, limiti delle risorse Docker e RTT non sono stati misurati.

## Roundtrip completo

`test/e2e-import-volume.js`, `EXPORT_VOLUME_ROWS=100000`. Ogni record contiene un identificatore oltre 2^53, un decimale esatto rappresentato in modo appropriato al motore e testo Unicode. Il tempo comprende export HTTP, ticket, upload, piano, staging, import e verifica applicativa. Dopo la misura il test confronta anche cardinalità e SHA-256 di **ogni valore** sorgente/destinazione; il tempo di questo hash aggiuntivo non è incluso.

| Motore | Record | Primo passaggio | Passaggio finale | Hash identico |
|---|---:|---:|---:|---|
| MySQL | 100.000 | 16,058 s | **13,428 s** | sì |
| PostgreSQL | 100.000 | 10,393 s | **7,895 s** | sì |
| MongoDB | 100.000 | 17,624 s | **19,790 s** | sì |

Sono due osservazioni, non percentili o un confronto controllato prima/dopo. Non dimostrano che un motore sia intrinsecamente più veloce degli altri. Report finale: `test-reports/import-export-2026-10-12/volume.json`; log: `volume-final.log`.

## Large Object PostgreSQL

`node --expose-gc test/e2e-lo-volume.js`: binario poco comprimibile da **128 MiB**, backup, restore e verifica integrale SHA-256.

| Misura | Risultato |
|---|---:|
| Tempo | **8,481 s** |
| RSS iniziale del processo Node | 74,5 MiB |
| Picco RSS osservato | 136,4 MiB |
| Incremento RSS osservato | **61,9 MiB** |
| SHA-256 | identico |

Il contenuto viaggia in blocchi da 1 MiB: la prova non carica tutto il binario in memoria. La RSS riguarda il processo Node del test, non Docker, il browser o tutta la macchina; il campionamento può non vedere picchi molto brevi. Report: `large-object-volume.json`.

## Altre prove di volume e coerenza

- Documento MongoDB vicino al limite BSON di 16 MiB, con confronto dei byte, più GridFS.
- 1.601 righe per tabella, chiavi numeriche/binarie e righe duplicate senza chiave: export paginato e backup completo verificati su entrambi i motori SQL.
- Aggiornamenti concorrenti durante lettura MongoDB in replica set: tutti i documenti appartengono allo stesso snapshot.
- Incrementali con chiavi binarie/ENUM: aggiornamenti, cancellazioni e valori Unicode conservati.

## Riproduzione

Usare soltanto server di test vuoti. Indicare esplicitamente `EXPORT_MYSQL_PORT`, `EXPORT_PG_PORT`, `EXPORT_MONGO_PORT`; per il test snapshot anche `EXPORT_MONGO_RS_PORT`. Eseguire i test che usano l'harness HTTP **in sequenza**, perché condividono la porta 3159.

```powershell
$env:EXPORT_VOLUME_ROWS='100000'
node test/e2e-import-volume.js
node --expose-gc test/e2e-lo-volume.js
node test/e2e-tipi-pagine.js
node test/e2e-mongo-snapshot-types.js
```

Per il test LO servono privilegi di creazione/lettura dei Large Object. I test generano nomi casuali e rimuovono i propri dati.

## Limiti prestazionali attuali

Il backup è a blocchi; il piano d'importazione dall'app mantiene invece i documenti validati in memoria e ha un limite configurabile di 64 MiB per file. Aumentarlo non rende automaticamente l'import adatto a file multi-GB. Non sono stati provati dataset da 1/10/100 GB o TB, migliaia di tabelle, reti remote, carico concorrente di produzione o confronti prestazionali con pg_restore/mongorestore/mysql.

Per valutare quei carichi servono profili e risorse dichiarati, almeno tre ripetizioni, cache controllata, RSS aggregata e tempi separati di lettura, trasferimento, scrittura e verifica. Le misure sopra non vanno estrapolate linearmente.
