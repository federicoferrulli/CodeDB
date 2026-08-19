# 18: La giuntura amministrativa

**Cosa costruire:** i ventisei eventi che non toccano alcuna strategia — vault, utenti,
permessi, chiavi API, connessioni salvate, licenza, aggiornamenti, audit — hanno una
giuntura propria, e la scrittura della voce di audit smette di essere copiata a mano.

Sono la seconda delle tre famiglie riconosciute in ADR-0001. Non hanno un database come
bersaglio, quindi la verifica della capability per database non li riguarda: hanno invece
gate d'installazione e audit, che oggi una quindicina di loro compone a mano riga per riga.

La ricerca della sessione, dove serve, viene da sotto: è condivisa con le altre due
famiglie.

**Bloccato da:** 16.

**Status:** ready-for-agent

- [ ] Gli eventi amministrativi passano dalla loro giuntura
- [ ] La voce di audit è scritta da un posto solo; nessuna composizione a mano sopravvive
- [ ] Un evento amministrativo nuovo scrive l'audit senza che chi lo aggiunge debba ricordarsene, e un test lo dimostra
- [ ] I gate d'installazione e le verifiche di amministrazione valgono come prima
- [ ] I test di autorizzazione, quelli del vault e quelli end-to-end passano invariati
