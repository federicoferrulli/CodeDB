# 04: Preservare numeri esatti nell'editing inline

Status: completed
Type: task
Blocked by: None (can start immediately)

**What to build:** L'utente deve poter modificare BIGINT, BSON Long e Decimal senza
perdere cifre o tipo fra cella, evento e strategia.

- [x] Un codec pubblico converte testo, metadata di colonna ed EJSON senza passare da Number
- [x] L'editing conserva esattamente i valori oltre 2^53 e i decimali con molte cifre
- [x] Input fuori intervallo o incompatibili col tipo vengono rifiutati prima della scrittura
- [x] Il valore riletto dal database coincide con testo e tipo confermati dall'utente
- [x] Test tabellari coprono limiti signed e unsigned a 64 bit e BSON Long/Decimal
- [x] La controprova che reintroduce la conversione approssimata rende rossi i test

