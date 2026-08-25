# 09: Verificare l'integrità sui tre DBMS

Status: resolved
Type: task
Blocked by: 03, 04, 05, 06, 07, 08

Chiudere il programma con una matrice E2E ridotta alle semantiche che una strategia finta
non può dimostrare. Le prove devono usare l'harness isolato del ticket 08.

- [x] MySQL: FK cascade e trigger non vengono attivati dall'upsert incrementale
- [x] PostgreSQL: la promozione dello schema non espone stati intermedi a un lettore concorrente
- [x] MongoDB: drop negato impedisce ogni inserimento successivo
- [x] MySQL e PostgreSQL: incrementale senza identità stabile viene rifiutato prima della mutazione
- [x] Tutti: errore dopo la prima collezione conserva o recupera la destinazione originale
- [x] Tutti: duplicati, oggetti mancanti e conteggi divergenti impediscono `completato`
- [x] Import `.codedb.json` con DDL estranea viene rifiutato sull'evento reale
- [x] UI, CLI e MCP producono lo stesso piano per lo stesso artefatto
- [x] Ogni scenario critico ha una prova di sensibilità documentata
- [x] Le suite unitarie e gli E2E esistenti non presentano nuove regressioni

## Commenti

Questo ticket non deve duplicare le invarianti già provate al seam principale: conferma
soltanto transazioni, constraint, trigger, autorizzazioni e promozione propri dei DBMS.

## Risposta

La matrice reale è implementata in `test/e2e-integrita-import.js`: MySQL prova FK,
trigger e rifiuto senza identità; PostgreSQL prova rifiuto senza identità e lettore
concorrente durante lo swap; MongoDB crea, quando esplicitamente abilitato, un utente
`readWrite` privo di `dropDatabase` e verifica il fail-closed. I casi comuni (errore di
fase, recupero, conteggi, duplicati, oggetti mancanti, DDL estranea e piano identico fra
canali) restano nei test deterministici del seam principale.

La suite unitaria completa passa. La matrice è stata eseguita su container usa-e-getta
loopback: MongoDB 6 autenticato, MySQL 8 e PostgreSQL 16; tutti e tre gli scenari sono
verdi. Passano anche gli E2E esistenti di backup MongoDB/MySQL, MCP MongoDB/MySQL,
collation MySQL, PostgreSQL e sessioni MongoDB/MySQL. L'E2E browser
`e2e-script-schede-ui` raggiunge ora il workspace ma segnala un difetto preesistente e
separato: una SELECT vuota non conserva le intestazioni. Non riguarda i percorsi di
import/ripristino né è una regressione introdotta da queste modifiche.
