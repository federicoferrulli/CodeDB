# 03: Invalidare le richieste IntelliSense in corso

Status: resolved
Type: task
Blocked by: 01: Scartare le pagine obsolete della griglia

**What to build:** Una modifica dello schema deve invalidare sia la cache sia le richieste
IntelliSense già partite, impedendo che un acknowledgment tardivo ripristini metadata
obsoleti.

- [x] Ogni chiave di schema possiede una generazione monotona
- [x] L'invalidazione incrementa la generazione e rimuove il valore memorizzato
- [x] Una risposta appartenente a una generazione precedente non viene memorizzata
- [x] La richiesta successiva alla DDL interroga nuovamente lo schema
- [x] Un test controllabile consegna la vecchia risposta dopo l'invalidazione
- [x] La controprova che accetta la vecchia risposta rende rosso il test

## Risposta

La cache in `public/js/autocomplete.js` possedeva già la soluzione condivisa: una
generazione monotona per chiave `tabId::db`, incrementata dall'invalidazione e
controllata prima di memorizzare sia una risposta valida sia il ripiego vuoto.
Mancava la prova della race per cui quella guardia esiste.

`test/e2e-richieste-intellisense.js` usa le API pubbliche
`schemaCorrente()` e `invalidaSchemaIntellisense()` nel frontend reale e un socket
finto che trattiene gli acknowledgment. Avvia una lettura, invalida lo schema,
verifica che parta una seconda `db:schema`, consegna il metadata nuovo e soltanto
dopo quello obsoleto: la cache conserva esclusivamente `tabella_nuova`.

Controprova eseguita rimuovendo temporaneamente il confronto di generazione nel
ramo di successo: il test è diventato rosso mostrando `tabella_obsoleta`; la
guardia è stata poi ripristinata. Il test dedicato passa. La suite unitaria
completa arriva alla fine ma resta rossa per il preesistente e fuori perimetro
`FAIL Le regex normali continuano a funzionare`.
