# 23: Migrare il server e il gateway MCP al filtro strutturato

**Cosa costruire:** i due chiamanti del contratto che non sono il browser — il server e il
gateway per i client AI — passano al filtro strutturato.

Vanno fatti insieme perché condividono la stessa interfaccia: lasciarne uno indietro
significa mantenere due contratti vivi più a lungo del necessario, ed è proprio la
condizione che il ticket di contrazione deve poter chiudere.

Il gateway espone strumenti a client esterni: il cambiamento del contratto va riflesso
nella descrizione degli strumenti, altrimenti un client continua a mandare la forma vecchia.

**Bloccato da:** 21.

**Status:** ready-for-agent

- [ ] Il server compone filtri strutturati
- [ ] Il gateway compone filtri strutturati e la descrizione dei suoi strumenti è aggiornata
- [ ] La verifica di autorizzazione legge i campi del filtro anziché rianalizzarne il testo
- [ ] Un test dimostra che un filtro che esce dallo scope viene negato leggendo i campi
- [ ] I test del gateway, quelli di autorizzazione e quelli end-to-end passano invariati
