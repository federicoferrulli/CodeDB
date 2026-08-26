# 17: Rappresentare le cancellazioni negli incrementali PostgreSQL

Status: ready-for-agent
Type: task
Blocked by: 15: Rappresentare le cancellazioni negli incrementali MongoDB

**What to build:** PostgreSQL deve raggiungere la stessa semantica di ricostruzione delle
cancellazioni rispettando database come schema e le identità stabili dichiarate.

- [ ] La strategia PostgreSQL produce record di eliminazione ordinati e identificabili
- [ ] Il restore qualifica ogni bersaglio nello schema previsto dal piano
- [ ] La promozione e gli esiti del motore degli artefatti continuano a essere rispettati
- [ ] Una catena storica non viene reinterpretata come completa
- [ ] E2E full, modifica, eliminazione e restore confronta identità e cardinalità finali
- [ ] La controprova che applica il layer senza eliminazioni rende rosso il test

