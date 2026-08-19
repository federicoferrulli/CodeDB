# 14: La tab delle query diventa chiamante della griglia

**Cosa costruire:** i risultati di una query usano lo stesso modulo della vista Dati, e la
seconda copia dell'aritmetica della finestra virtuale sparisce.

Le schede di visualizzazione dei risultati che non sono la tabella — albero JSON, grafici,
mappa — restano come sono: questo ticket riguarda solo la tabella.

**Bloccato da:** 13.

**Status:** ready-for-agent

- [ ] La tabella dei risultati usa il modulo comune
- [ ] Nessuna copia dell'aritmetica della finestra virtuale sopravvive, verificato con una ricerca
- [ ] Ordinamento, ridimensionamento delle colonne e larghezze calcolate funzionano come prima
- [ ] Le schede albero JSON, grafici e mappa continuano a funzionare
- [ ] Il test end-to-end delle schede di risultato per istruzione passa invariato
