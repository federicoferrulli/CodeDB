# 02: Chiudere i residui del payload dell'esecuzione di query

**Cosa costruire:** i campi del payload riservati al server vengono rimossi da una regola
esplicita e verificabile, non dall'ordine in cui le chiavi compaiono in un letterale.
Oggi il riferimento di annullamento è neutralizzato solo per accidente d'ordine:
riordinare quelle chiavi riaprirebbe il varco.

Inoltre il registro dell'esecuzione — la struttura su cui il server segna se
un'operazione ha scritto, e da cui deriva la categoria con cui l'operazione finisce
nell'audit — smette di essere costruibile da chi manda la richiesta.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** done

- [x] Un test dimostra che il registro dell'esecuzione inviato da un client **veniva adottato dal server** — cioè sostituiva la struttura da cui deriva la categoria di audit — e **fallisce prima** della correzione. Provato il meccanismo, non l'esito: da `query:execute` la categoria non era raggiungibile (vedi Commenti)
- [x] Dopo la correzione il registro proviene solo dal server
- [x] La rimozione dei campi riservati avviene per regola dichiarata; riordinare le chiavi del letterale non cambia il risultato, e un test lo verifica
- [x] L'elenco dei campi riservati è definito in un posto solo

## Commenti

**Portata reale del primo criterio, verificata.** Il registro dell'esecuzione mandato dal
client *veniva adottato dal server*: `test/unit-payload-esecuzione.js` lo dimostra e
fallisce prima della correzione (`haScritto` finiva `true` sull'oggetto arrivato nella
richiesta). La conseguenza sull'audit, però, **non era raggiungibile da `query:execute`**:
quel gestore ricava la categoria dal valore di ritorno di `executeQueryCode`, non dal
registro; il registro decide la categoria solo nella voce di chiusura di uno script
(`finalizzaScript`), e lì l'oggetto è sempre costruito dal server. Il varco era quindi
nel meccanismo, non ancora nell'esito: un secondo chiamante che avesse passato il payload
del client — cioè esattamente ciò che faceva lo spread — l'avrebbe aperto davvero.
Il test prova il meccanismo e, accanto, la regola di audit rifatta a mano, così si legge
che cosa la sostituzione significherebbe.

**Verifica di sensibilità.** Tutti i test sono stati visti fallire almeno una volta
rompendo il codice che proteggono: senza `run` nell'elenco dei campi del server, con la
marcatura resa enumerabile (uno spread tornerebbe a passare per composizione valida), e
con `assertPayloadEsecuzione` assente.

**Classe, non istanza.** Lo stesso accidente d'ordine viveva su un'altra giuntura: in
`delegate` l'`opHandle` del server veniva imposto solo dentro il ramo `if (runId)`, quindi
una richiesta **senza** `runId` portava fino alla strategia quello mandato dal client — e su
MySQL/PostgreSQL è l'oggetto che sceglie il ramo della connessione dedicata e riceve
`connectionId`/`processID`. Chiuso con la stessa regola. Restano fuori, dichiarati: `count` e
`write` di `mongoScriptHost`, il cui payload lo compone l'interprete con un insieme chiuso di
chiavi e non contiene alcun campo del server (il perché è scritto accanto al codice).

**Non provato:** i percorsi end-to-end (script su MongoDB/MySQL) — nessun database locale
disponibile in questa sessione. La suite unitaria completa (`npm test`) passa.
