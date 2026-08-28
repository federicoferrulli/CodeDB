# 02: Memoizzazione query Information Schema per colonne generate

**What to build:** Durante l'export JSON, la ricerca delle colonne generate invoca l'Information Schema del database in ogni blocco. Aggiungere una logica di caching (ad esempio una semplice mappa in memoria su `db/sqlMetadati.js` o sul client) in modo che i metadati della tabella (le "colonne scrivibili") vengano letti una sola volta per tabella esportata, annullando l'impatto sul DB.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [x] Individuare la chiamata `this.colonneScrivibili(db, coll)` all'interno delle strategy (MySQL/PostgreSQL) in `collectionExport` (formato JSON).
- [x] Implementare una soluzione per leggere questo valore una singola volta. Possibilità: 1. Passare i metadati in payload dal frontend. 2. Aggiungere un piccolo caching LRU (o pulito in seguito ad eventi DDL) all'interno di `sqlMetadati.js`.
- [x] Verificare che i test E2E continuino a passare senza errori sui tipi JSON importati.

