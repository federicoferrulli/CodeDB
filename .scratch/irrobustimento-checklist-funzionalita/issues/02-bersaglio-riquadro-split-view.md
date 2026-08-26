# 02: Congelare il bersaglio di ogni riquadro Split View

Status: ready-for-agent
Type: task
Blocked by: 01: Scartare le pagine obsolete della griglia

**What to build:** Ogni riquadro deve mostrare e modificare soltanto la collezione del
contesto che ha originato la richiesta, anche quando l'utente cambia rapidamente
database, collezione o tab.

- [ ] Ogni lettura del riquadro usa il contratto di generazione introdotto dal ticket 01
- [ ] Titolo, righe e metadata del riquadro provengono dalla stessa generazione
- [ ] Una mutazione conserva tab, database e collezione originari senza rileggere stato globale mutabile
- [ ] Un test inverte le risposte di due collezioni e verifica vista e bersaglio della scrittura
- [ ] Nessuna scrittura raggiunge la seconda collezione usando una riga della prima
- [ ] La controprova senza contesto congelato rende rosso il test

