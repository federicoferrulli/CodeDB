# 16: Rappresentare le cancellazioni negli incrementali MySQL

Status: ready-for-agent
Type: task
Blocked by: 15: Rappresentare le cancellazioni negli incrementali MongoDB

**What to build:** MySQL deve produrre e applicare cancellazioni incrementali secondo lo
stesso contratto di manifest, senza effetti delete estranei al piano.

- [ ] La strategia MySQL produce record di eliminazione completi di identità stabile
- [ ] Il restore usa il piano condiviso e non reintroduce REPLACE come upsert
- [ ] Foreign key, cascade e trigger vengono attivati soltanto dalle cancellazioni dichiarate
- [ ] Una catena storica mantiene la classificazione di equivalenza incompleta
- [ ] E2E con riga padre/figlia verifica lo stato finale e gli effetti previsti
- [ ] La controprova che omette una cancellazione rende rosso il confronto finale

