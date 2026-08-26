# 09: Trattare le foreign key composite come vincoli unici

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** Schema Browser e griglia devono rappresentare una foreign key
composita come coppie ordinate appartenenti a un solo vincolo e modificarla atomicamente.

- [ ] I metadata associano ogni colonna locale alla colonna referenziata dello stesso ordinale
- [ ] Il contratto conserva nome del vincolo, ordine e tutte le coppie di colonne
- [ ] Il selettore mostra una relazione composita senza appiattirla in relazioni indipendenti
- [ ] Una scelta aggiorna tutte le colonne oppure non ne aggiorna nessuna
- [ ] E2E PostgreSQL copre una FK composita con nomi e ordini differenti
- [ ] La controprova con join privo di ordinale rende rosso il test

