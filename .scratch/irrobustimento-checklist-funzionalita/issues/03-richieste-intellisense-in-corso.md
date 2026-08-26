# 03: Invalidare le richieste IntelliSense in corso

Status: ready-for-agent
Type: task
Blocked by: 01: Scartare le pagine obsolete della griglia

**What to build:** Una modifica dello schema deve invalidare sia la cache sia le richieste
IntelliSense già partite, impedendo che un acknowledgment tardivo ripristini metadata
obsoleti.

- [ ] Ogni chiave di schema possiede una generazione monotona
- [ ] L'invalidazione incrementa la generazione e rimuove il valore memorizzato
- [ ] Una risposta appartenente a una generazione precedente non viene memorizzata
- [ ] La richiesta successiva alla DDL interroga nuovamente lo schema
- [ ] Un test controllabile consegna la vecchia risposta dopo l'invalidazione
- [ ] La controprova che accetta la vecchia risposta rende rosso il test

