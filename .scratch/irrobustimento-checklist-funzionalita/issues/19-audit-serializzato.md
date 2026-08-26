# 19: Serializzare persistenza e rotazione dell'audit

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** Ogni record di audit dichiarato persistito deve essere scritto in
ordine e sopravvivere a rotazioni concorrenti; un errore su disco deve essere osservabile.

- [ ] Ogni destinazione di audit possiede una sola coda ordinata di append e rotazione
- [ ] Due eventi oltre soglia non gareggiano sul rename dello stesso file
- [ ] Errori di append, flush, stat o rotazione vengono propagati allo stato di salute
- [ ] La cache non presenta come persistito un evento fallito su disco
- [ ] Un test concorrente verifica ordine, cardinalità e generazioni dei file ruotati
- [ ] Un test di errore disco verifica il comportamento fail-visible
- [ ] La controprova senza serializzazione rende rosso il test concorrente

