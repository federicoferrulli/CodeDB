# 24: Degradare progressivamente il grafo 3D

Status: ready-for-agent
Type: task
Blocked by: 23: Applicare budget progressivi allo schema UML

**What to build:** Il grafo 3D deve consumare il riepilogo progressivo dello schema e
ridurre dettagli ed effetti oltre soglia, restando esplorabile su cataloghi grandi.

- [ ] Il grafo usa paginazione e indicatori di completezza introdotti dal ticket 23
- [ ] Nodi, relazioni e campi visibili rispettano budget espliciti
- [ ] Particelle ed effetti costosi vengono ridotti o disattivati oltre soglia
- [ ] L'utente può espandere una porzione senza ricostruire l'intero grafo
- [ ] Un test con catalogo grande verifica limite degli elementi e interazione ancora disponibile
- [ ] Schemi piccoli conservano l'esperienza completa
- [ ] La controprova senza degradazione rende rosso il test di budget

