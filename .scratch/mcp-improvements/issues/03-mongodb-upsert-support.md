# 03: Support upsert for MongoDB update operations

**What to build:** Consente agli agenti AI di eseguire aggiornamenti con logica "upsert" (aggiorna se esiste, inserisci se non esiste) in MongoDB tramite il tool `execute_write`, eliminando la necessità di eseguire una query preventiva di lettura per verificare l'esistenza del record.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [X] Aggiungere un flag `upsert` (boolean opzionale) all'operazione di tipo `update` del tool `execute_write`.
- [X] Passare correttamente questo flag a `collectionUpdateMany` (o equivalente) nel driver MongoDB.
- [X] Assicurarsi che l'anteprima (il primo passaggio del flusso di conferma) mostri chiaramente all'utente umano che l'operazione include l'istruzione di `upsert`.

