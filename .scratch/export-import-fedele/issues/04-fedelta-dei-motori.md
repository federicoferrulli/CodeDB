Status: ready-for-agent
Blocked by: 03

# Fase 3 — Fedeltà dei motori

Piano: `docs/piano-export-import-database.md` §11, riga «3 — Fedeltà dei motori»;
§5 (consistenza della sorgente), §6 (matrice di fedeltà).

## Perimetro

`backup/lib/engine.js`, restore e helper condivisi; wrapper nativi minimi.

## Criterio di uscita (dal piano)

Snapshot valida per ogni profilo, matrice tipi/schema superata; PostgreSQL senza PK
senza `OFFSET`; nessun formato relaxed distruttivo.

## Stato parziale (verificato, senza motori live)

- `db/codecFedele.js` (nuovo): unico punto di scrittura/lettura EJSON —
  canonico esplicito in scrittura (bson ha il relaxed come default quando le
  opzioni mancano: non dirlo È scrivere relaxed), stesso lettore per canonico
  e relaxed storico. `backup/lib/engine.js` non usa più `EJSON` diretto (6
  scritture + 2 corredi + 2 letture migrate). Prova:
  `test/unit-codec-fedele.js` — giro dei tipi BSON (Long/Double piccoli restano
  distinti, oltre 2^53 come testo, Date/ObjectId/Timestamp/regex/MinMaxKey/
  binari/UUID/annidati/ordine campi), compatibilità file storici, guardia
  statica anti-relaxed (con lezione CRLF incorporata). Sensibilità verificata
  nei due sensi. Matrice aggiornata (§1-bis chiuso come superato).
- `paginaSenzaChiave` (in `engine.js`, esportata per i test): tabelle senza
  identità in keyset su `ctid` (`ctid > ultimo`, prima pagina da `(0,0)`),
  niente più `OFFSET`. Prova SQL-shape nel codec-test. Trovata per strada e
  fissata nel test: le regex `/g/` non sono BSON (falliscono qui, non di notte).
- Già presenti e riusati, non duplicati: snapshot `REPEATABLE READ` MySQL e
  PostgreSQL con lock condiviso, letture conservative (WKB, hex, testo).
- `db/mongoTopologia.js` (nuovo): classifica standalone/replica/sharded da
  `hello` (il discriminante è `setName`, non `isWritablePrimary`) e la dichiara
  nel manifest con `snapshot: false` — nessuna snapshot finta senza topologia
  certificata. `dumpMongo` scrive `coerenza` nel manifest; anche MySQL e PG
  registrano la propria snapshot. Prova: `test/unit-dump-mongo.js` — classifica
  più `runBackup` vero con client finto (tipi intatti su disco, conteggi,
  coerenza). Sensibilità verificata.
- Resta fuori (serve ambiente): validazione del keyset `ctid` e della snapshot
  su PG reale, snapshot Mongo su replica/sharding, resto della matrice
  (estensioni, RLS, Large Object, date zero, infinity) — nessun motore risponde
  (27017/3306/5432 chiuse, demone Docker fermo).
