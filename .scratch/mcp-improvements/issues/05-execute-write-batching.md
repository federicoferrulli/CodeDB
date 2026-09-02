# 05: Add multi-operation batching to execute_write

**What to build:** Consente di eseguire un set di mutazioni distinte inviandole in batch (tramite un array di operazioni) ad `execute_write`. L'utente riceve e convalida un singolo `confirm_token` per l'intero blocco, permettendo approvazioni massive per migrazioni dati complesse.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [X] Modificare lo schema di `execute_write` introducendo un campo opzionale `operations` (array di descrittori di mutazioni SQL o Mongo).
- [X] Il sistema riassumerà tutte le operazioni richieste nel payload di anteprima (primo step).
- [X] Il backend applicherà il batch sequenzialmente alla convalida del `confirm_token` (idealmente dentro una transazione unica, ove supportato, ad es. su Postgres/MySQL).
- [X] Il tool dovrà respingere formati misti o incompatibili (es. eseguire batch misti SQL/Mongo all'interno della stessa chimata non ha senso).
- [X] Gli audit log devono tracciare l'esecuzione del blocco massivo.

