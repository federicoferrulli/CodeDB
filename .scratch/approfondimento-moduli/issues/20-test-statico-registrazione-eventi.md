# 20: Test statico sulla registrazione degli eventi

**Cosa costruire:** registrare un evento fuori dalle tre giunture previste fa fallire un
test. È il terzo gradino del criterio di chiusura: non basta che la situazione sia
sistemata, deve essere difficile riformarla.

Il modello esiste già nel repo: un test legge il codice come testo per trovare ciò che
nessun controllo di tipo troverebbe, ed è così che è stato intercettato lo scambio fra due
variabili omonime.

Il test deve anche verificare che ogni evento sia dichiarato in **una sola** famiglia, e che
la famiglia dichiarata corrisponda a ciò che l'handler fa davvero — almeno per il criterio
osservabile: chi tocca una strategia non può stare nella famiglia amministrativa.

**Bloccato da:** 17, 18, 19.

**Status:** ready-for-agent

- [ ] Il test elenca tutti gli eventi registrati e ne verifica la famiglia
- [ ] Registrare un evento fuori dalle tre giunture fa fallire il test
- [ ] Dichiarare un evento in due famiglie fa fallire il test
- [ ] Il test è stato verificato introducendo di proposito una registrazione fuori posto
- [ ] Il messaggio di fallimento dice quale evento e cosa fare, non solo che qualcosa non torna
