# 12: Provare riconnessione e annullamento su tab chiuso

**Cosa costruire:** il comportamento del trasporto è coperto da test attraverso la sua
interfaccia: riconnessione automatica alle sole connessioni salvate, annullamento della
richiesta quando il tab d'origine viene chiuso, marcatura che permette a una risposta di
sapere se il suo tab è ancora quello attivo.

Il modulo porta nei commenti tre difetti già corretti — un identificatore di tab indefinito
che cancellava quello iniettato, il tab orfano, e una notifica scambiata per messaggio
all'utente che ne aveva soppressi una trentina — e nessuno dei tre ha oggi un test che ne
impedisca il ritorno.

**Bloccato da:** 11.

**Status:** ready-for-agent

- [ ] Un socket finto permette di provare il trasporto senza server
- [ ] La riconnessione automatica è provata, compreso il caso della connessione **non** salvata, dove non deve avvenire
- [ ] L'annullamento su tab chiuso è provato
- [ ] I tre difetti registrati nei commenti hanno ciascuno un test che fallisce se il difetto torna
- [ ] Ogni test è stato verificato rompendo di proposito il codice che protegge
