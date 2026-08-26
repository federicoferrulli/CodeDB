# 21: Separare preferenze personali e condivise

Status: ready-for-agent
Type: task
Blocked by: 20: Introdurre l'amministrazione tenant-level

**What to build:** Le preferenze personali devono appartenere al principal; quelle
condivise devono essere validate, limitate, autorizzate e registrate come eventi
amministrativi.

- [ ] Lettura e scrittura distinguono chiaramente preferenze personali e tenant-wide
- [ ] Le preferenze personali sono isolate per principal
- [ ] Le preferenze condivise richiedono la capability amministrativa del ticket 20
- [ ] Chiavi, struttura e dimensione dei valori sono validate server-side
- [ ] Ogni modifica condivisa produce un record di audit
- [ ] Test con due principal dimostrano isolamento e divieto di escalation
- [ ] La controprova senza controllo amministrativo rende rosso il test

