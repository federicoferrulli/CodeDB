# 01: Scartare le pagine obsolete della griglia

Status: resolved
Type: task
Blocked by: None (can start immediately)

**What to build:** La griglia deve accettare una pagina o un conteggio soltanto quando
appartengono ancora alla stessa generazione di database, collezione, condizione e
ordinamento mostrata all'utente.

- [x] Query iniziale, caricamento incrementale e conteggio conservano un contesto immutabile
- [x] Una nuova query invalida tutte le risposte pendenti della generazione precedente
- [x] Una risposta obsoleta non modifica righe, paginazione, conteggio o stato di caricamento
- [x] Un test con acknowledgment consegnati in ordine inverso osserva solo i dati più recenti
- [x] La controprova senza controllo di generazione rende rosso il test di regressione


## Risposta

Le guardie di generazione esistevano già in `public/js/grid.js` e
`public/js/coerenza-richieste.js`: ciò che mancava era la prova nella sola
condizione in cui contano, cioè l'acknowledgment di una lettura consegnato
DOPO quello della lettura che l'ha sostituita.

- `runQuery` e `requestTotalCount` leggono ora il contesto congelato alla
  chiamata attraverso `contestoCorrente`, come già faceva `fetchMore`: la
  regola sta scritta una volta invece che in sei confronti a mano, e il
  contesto che `runQuery` congelava non è più decorativo.
- `test/e2e-pagine-obsolete.js` (Chromium, socket finto) mette gli
  acknowledgment in coda e li consegna al contrario su tutte e tre le vie:
  due `collection:find`, due `collection:count`, e un blocco dello scroll
  infinito superato da una query nuova. Le risposte obsolete portano
  `total: null`, altrimenti l'asserto sul secondo conteggio non potrebbe
  fallire nemmeno a guardia rimossa.
- Controprova eseguita rompendo di proposito, una alla volta, le tre guardie:
  find → 7 asserti rossi, conteggio → 1, blocco successivo → 1.

Fuori perimetro, e dichiarato: la selettività di `chiudiCaricamento` — un
blocco obsoleto non deve spegnere l'indicatore di un blocco più recente —
resta provata dal test unitario `test/unit-coerenza-richieste.js`, che la
esercita direttamente e senza browser.
