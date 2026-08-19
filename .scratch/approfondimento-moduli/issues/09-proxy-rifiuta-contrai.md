# 09: Il Proxy autorizzante rifiuta in mancanza di regola (contrai)

**Cosa costruire:** un metodo di strategia privo di voce nella tabella viene **negato**
anziché lasciato passare. La leva del Proxy — «aggiungere un handler o un tool non può
aprire un buco» — diventa vera invece che quasi vera.

L'inversione è sicura solo dopo che la tabella è completa: da sola romperebbe ogni
chiamante di un metodo non ancora elencato. È il motivo del blocco.

L'accesso diretto al driver da parte del motore di backup resta come è: è dichiarato e
autorizzato a parte sull'intera connessione.

**Bloccato da:** 08.

**Status:** ready-for-agent

- [ ] Un metodo privo di voce viene rifiutato con un errore parlante
- [ ] Un test dimostra il rifiuto e **fallisce prima** dell'inversione
- [ ] Il motore di backup continua a funzionare, provato dai suoi test end-to-end
- [ ] I test di autorizzazione, quelli del gateway e quelli end-to-end passano invariati
