# 16: Il contesto della sessione diventa un argomento

**Cosa costruire:** un handler di evento si può invocare passandogli un contesto costruito
per la prova — socket finto, sessioni finte, principal finto — senza aprire un socket vero
né una connessione a un database.

Oggi la giuntura vive dentro una chiusura di quasi duemila righe per catturare socket,
sessioni e principal: non esiste alcun punto in cui sostituire il comportamento senza
modificare lì dentro. La conseguenza si vede nei test, che sono ridotti a leggere il file
come testo e a bilanciare le graffe con un'espressione regolare — ed è così che è stato
scoperto uno scambio fra due variabili omonime che aveva ucciso l'intero esecutore di
script a ogni invocazione, vissuto a lungo perché quel percorso non ha test.

È il prerequisito di tutto il resto del lotto e va fatto in un colpo: un server a metà
strada fra cattura e passaggio del contesto è peggio di entrambi gli stati.

Il blocco su 02 e 10 è per **conflitto sugli stessi file**, non per dipendenza logica.

**Bloccato da:** 02, 10.

**Status:** ready-for-agent

- [ ] Il contesto della sessione è passato agli handler, non catturato dalla chiusura
- [ ] Esiste un contesto finto che permette di invocare un handler in un test
- [ ] Almeno tre handler di famiglie diverse hanno un test unitario che li invoca
- [ ] Nessun comportamento è cambiato: l'intera suite end-to-end passa invariata
- [ ] I test che leggono il file come testo continuano a passare, o sono sostituiti da test che invocano davvero il codice
