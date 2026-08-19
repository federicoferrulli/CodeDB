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

**Status:** ready-for-agent

- [ ] Ogni metodo pubblico delle tre strategie ha una voce con la sua capability
- [ ] Un test statico confronta tabella ed elenco dei metodi pubblici e passa
- [ ] Lo stesso test è stato verificato aggiungendo un metodo finto senza voce: deve fallire
- [ ] Nessun comportamento è cambiato: i test di autorizzazione passano invariati
