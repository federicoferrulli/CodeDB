# 15: Rappresentare le cancellazioni negli incrementali MongoDB

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** Una catena MongoDB deve ricostruire inserimenti, modifiche e
cancellazioni, introducendo end-to-end il contratto versionato usato anche dagli altri
motori.

- [ ] Il manifest dichiara esplicitamente la semantica e l'ordine delle cancellazioni
- [ ] Il layer rappresenta ogni eliminazione mediante informazione stabile e verificabile
- [ ] Il restore applica le eliminazioni soltanto al bersaglio e all'identità previsti dal piano
- [ ] Una catena storica priva di cancellazioni non dichiara equivalenza completa
- [ ] E2E full, insert, update, delete, incremental e restore ricostruisce lo stato esatto
- [ ] La copia di recupero e gli esiti canonici del motore degli artefatti restano invariati
- [ ] La controprova che ignora il record di eliminazione rende rosso il test

