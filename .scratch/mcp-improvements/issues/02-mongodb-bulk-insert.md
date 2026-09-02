# 02: Support array documents in MongoDB insert via execute_write

**What to build:** Permette agli agenti AI di inserire migliaia di documenti in MongoDB in un colpo solo, passando un array JSON al tool `execute_write`. Attualmente MongoDB richiede l'inserimento uno a uno, costringendo gli agenti a fare migliaia di chiamate MCP distinte (ognuna con il proprio token di conferma).

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [X] Rimuovere il blocco esplicito sugli array in `docInsert` (o aggiungere un metodo parallelo per l'insert di massa) per le strategie MongoDB.
- [X] Mappare correttamente il comportamento su `insertMany` lato MongoDB driver.
- [X] L'operazione `execute_write` con `operation: insert` supporta `args.doc` quando quest'ultimo è un array JSON (Extended JSON).
- [X] Verificare che gli audit log traccino correttamente l'inserimento dell'array.

