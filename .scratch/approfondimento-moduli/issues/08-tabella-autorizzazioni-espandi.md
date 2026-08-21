# 08: Completare la tabella delle autorizzazioni e provarla (espandi)

**Cosa costruire:** ogni metodo pubblico delle tre strategie ha la sua voce nella tabella
che il Proxy autorizzante consulta, e un test statico confronta la tabella con l'elenco dei
metodi pubblici, fallendo su qualunque differenza.

Oggi la tabella copre una parte dei metodi; quelli che non vi compaiono passano invariati.
Il test è il modo per rendere impossibile aggiungere un metodo scoperto senza accorgersene,
e ha prior art nel repo: esiste già un test che legge il codice come testo per trovare ciò
che nessun controllo di tipo troverebbe.

Questo ticket **espande soltanto**: il comportamento in mancanza di voce resta quello di
oggi, e nulla viene ancora negato.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** done

- [x] Ogni metodo pubblico delle tre strategie ha una voce con la sua capability
- [x] Un test statico confronta tabella ed elenco dei metodi pubblici e passa
- [x] Lo stesso test è stato verificato aggiungendo un metodo finto senza voce: deve fallire
- [x] Nessun comportamento è cambiato: i test di autorizzazione passano invariati

## Che cosa è stato fatto

I metodi visibili sui prototipi delle tre strategie (più la classe base) sono
**75**; la tabella ne copriva **36**. Ora li copre tutti, e i 39 aggiunti non
hanno ricevuto una capability a caso: hanno ricevuto una voce che dichiara
`cap: null` **e il motivo**. La differenza fra «passa» e «passa perché non c'è
scritto niente» è tutta lì — la seconda è una dimenticanza che nessuno vede.

Le voci senza capability sono di quattro specie, e ognuna dice anche **dove**
l'operazione viene autorizzata invece:

* **ciclo di vita della connessione** (`connect`, `disconnect`): chi può aprirla
  lo decide `assertConnAllowed` *prima* che la strategia esista;
* **amministrazione del server di database** (`health`, `listSessions`,
  `killSession`): server.js le autorizza con `assertWholeConnection`, che
  pretende l'assenza di scope. Dare loro una capability qui significherebbe due
  regole diverse per la stessa porta, e la più debole vincerebbe per prima;
* **operazioni su richieste già autorizzate** (`cancelQuery`, `unwatch`,
  `unwatchSchema`) e **dichiarazioni sul motore** (`supportsNativeRename`,
  `fuoriDalTettoDiTempo`): non leggono e non scrivono dati;
* **aiuti interni degli adattatori** (29 metodi: composizione della query
  tabellare, metadati SQL comuni, dettagli di connessione dei singoli motori).
  Non attraversano il Proxy — le strategie li chiamano su `this`, e il Proxy
  vede solo le chiamate che arrivano da fuori. Compaiono nella tabella perché
  dev'essere completa, e perché se un giorno qualcuno li chiamasse da fuori
  quella voce è il posto in cui decidere che cosa debba succedere.

**Nessun comportamento è cambiato.** `guardStrategy` distingue ora `!spec` da
`!spec.cap`: entrambi passano, esattamente come prima. La distinzione esiste per
la 09, che dovrà negare il primo e continuare a lasciar passare il secondo.

## Come è stato provato

`test/unit-tabella-autorizzazioni.js` (4 prove, registrato in `test/unit.js`).
Legge i prototipi con `getOwnPropertyNames` risalendo la catena — e non
`for...in` — perché `installaMetadati` (db/sqlMetadati.js) definisce nove metodi
**non enumerabili**, come sono i metodi di una classe: un elenco che li saltasse
avrebbe dichiarato «completa» una tabella con nove buchi dentro.

Il test verifica anche il difetto **opposto**, altrettanto silenzioso: una voce
orfana, cioè la convinzione di aver classificato un metodo che intanto è stato
rinominato o rimosso. E verifica che ogni voce dica o una capability
riconosciuta o un motivo scritto.

**Sensibilità verificata rompendo il codice di proposito**: aggiunto un
`metodoFintoSenzaVoce()` a `MongoDbStrategy`, il test fallisce nominandolo e
dicendo in quale classe si trova; rimosso, torna verde.

Che cosa **non** garantisce, ed è scritto in testa al test: che la capability
scelta sia quella giusta. Il test vede che una voce c'è, non che dica il vero —
che `dropCollection` chieda `ddl` e non `read` lo provano i test dell'RBAC.

`npm test` passa (codice di uscita 0), compresi i test RBAC esistenti.
