# 10: Rifiutare CSV strutturalmente ambigui prima dell'import

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** L'import CSV deve validare integralmente struttura e ampiezza del file
e segnalare la posizione dell'errore prima della prima mutazione.

- [ ] EOF dentro una cella quotata viene rifiutato
- [ ] Header duplicati e righe con celle mancanti o extra vengono rifiutati
- [ ] Quote, virgole, CRLF e righe nuove valide vengono preservati
- [ ] Anteprima ed esecuzione consumano la stessa rappresentazione normalizzata
- [ ] Un errore riporta riga e colonna e lascia la collezione invariata
- [ ] La controprova che tronca celle extra o aggiunge null rende rosso il test

