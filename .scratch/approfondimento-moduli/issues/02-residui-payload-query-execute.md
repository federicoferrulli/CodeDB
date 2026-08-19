# 02: Chiudere i residui del payload dell'esecuzione di query

**Cosa costruire:** i campi del payload riservati al server vengono rimossi da una regola
esplicita e verificabile, non dall'ordine in cui le chiavi compaiono in un letterale.
Oggi il riferimento di annullamento è neutralizzato solo per accidente d'ordine:
riordinare quelle chiavi riaprirebbe il varco.

Inoltre il registro dell'esecuzione — la struttura su cui il server segna se
un'operazione ha scritto, e da cui deriva la categoria con cui l'operazione finisce
nell'audit — smette di essere costruibile da chi manda la richiesta.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** ready-for-agent

- [ ] Un test dimostra che un client che invia il registro dell'esecuzione ne influenza la categoria di audit, e **fallisce prima** della correzione
- [ ] Dopo la correzione il registro proviene solo dal server
- [ ] La rimozione dei campi riservati avviene per regola dichiarata; riordinare le chiavi del letterale non cambia il risultato, e un test lo verifica
- [ ] L'elenco dei campi riservati è definito in un posto solo
