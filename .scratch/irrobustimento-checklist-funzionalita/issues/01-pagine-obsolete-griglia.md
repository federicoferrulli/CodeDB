# 01: Scartare le pagine obsolete della griglia

Status: done
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

