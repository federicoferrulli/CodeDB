# 09: Verificare l'integrità sui tre DBMS

Status: ready-for-agent
Type: task
Blocked by: 03, 04, 05, 06, 07, 08

Chiudere il programma con una matrice E2E ridotta alle semantiche che una strategia finta
non può dimostrare. Le prove devono usare l'harness isolato del ticket 08.

- [ ] MySQL: FK cascade e trigger non vengono attivati dall'upsert incrementale
- [ ] PostgreSQL: la promozione dello schema non espone stati intermedi a un lettore concorrente
- [ ] MongoDB: drop negato impedisce ogni inserimento successivo
- [ ] MySQL e PostgreSQL: incrementale senza identità stabile viene rifiutato prima della mutazione
- [ ] Tutti: errore dopo la prima collezione conserva o recupera la destinazione originale
- [ ] Tutti: duplicati, oggetti mancanti e conteggi divergenti impediscono `completato`
- [ ] Import `.codedb.json` con DDL estranea viene rifiutato sull'evento reale
- [ ] UI, CLI e MCP producono lo stesso piano per lo stesso artefatto
- [ ] Ogni scenario critico ha una prova di sensibilità documentata
- [ ] Le suite unitarie e gli E2E esistenti non presentano nuove regressioni

## Commenti

Questo ticket non deve duplicare le invarianti già provate al seam principale: conferma
soltanto transazioni, constraint, trigger, autorizzazioni e promozione propri dei DBMS.

