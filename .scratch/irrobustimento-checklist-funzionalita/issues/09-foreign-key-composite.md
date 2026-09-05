# 09: Trattare le foreign key composite come vincoli unici

Status: completed
Type: task
Blocked by: None (can start immediately)

**What to build:** Schema Browser e griglia devono rappresentare una foreign key
composita come coppie ordinate appartenenti a un solo vincolo e modificarla atomicamente.

- [x] I metadata associano ogni colonna locale alla colonna referenziata dello stesso ordinale
- [x] Il contratto conserva nome del vincolo, ordine e tutte le coppie di colonne
- [x] Il selettore mostra una relazione composita senza appiattirla in relazioni indipendenti
- [x] Una scelta aggiorna tutte le colonne oppure non ne aggiorna nessuna
- [x] E2E PostgreSQL copre una FK composita con nomi e ordini differenti
- [x] La controprova con join privo di ordinale rende rosso il test


## Verifica del 2026-09-05

Il contratto `coppie`, il join ordinale PostgreSQL e la scrittura unica erano
presenti. Completati lo Schema Browser (nome e coppie in un solo nodo), il testo
delle opzioni e il confronto su tutte le componenti: cambiare soltanto la seconda
componente ora abilita la scelta.

- `node test/e2e-fk-viste.js`: Chromium, Schema Browser, tuple complete senza
  etichette duplicate, singolo payload con entrambe le colonne e regressioni Split-View.
  Prima della correzione tre nuove asserzioni fallivano.
- `node test/e2e-postgres.js`: PostgreSQL locale su porta 5412, schemi temporanei
  registrati e ripuliti. Nomi locali/remoti diversi; ordine fisico, ordine della
  PK e ordine della FK differenti. Verificati aggiornamento completo e rifiuto
  senza modificare nessuna componente.
- Controprova: rimosso temporaneamente il predicato
  `rcu.ordinal_position = kcu.position_in_unique_constraint`; il test PostgreSQL
  fallisce sulle coppie attese. Ripristinati i byte originali del file.
- `npm test`: suite unitaria completa superata; anche i due test unitari FK
  eseguiti direttamente. Controlli di sintassi sui moduli modificati superati.

Revisione Standards: nessuna violazione sostanziale; corretti due difetti visivi
minori (separatori e ripiego dell'etichetta). Revisione Spec: nessun requisito
mancante e nessuna estensione estranea. Chromium rieseguito dopo le correzioni.
La prova browser usa un socket simulato; la prova PostgreSQL usa il server e il
DBMS reali. Nessun test MySQL reale aggiuntivo: la strategia non cambia.
