# 25: Distinguere cicli interni e dipendenze esterne

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** La diagnostica deve separare le dipendenze verso altri database dai
cicli reali interni e produrre un ordine coerente per le collezioni osservate.

- [ ] Il grafo interno contiene soltanto nodi appartenenti al database analizzato
- [ ] Le dipendenze esterne vengono conservate e mostrate in una categoria distinta
- [ ] I cicli sono individuati mediante componenti fortemente connesse
- [ ] Un nodo non ordinato per una dipendenza esterna non viene chiamato ciclico
- [ ] Test coprono catena, diamante, autoanello, ciclo multiplo e riferimento esterno
- [ ] La controprova che incrementa il grado per un nodo esterno rende rosso il test

