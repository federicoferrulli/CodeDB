# 03: Applicare upsert SQL senza effetti di cancellazione

Status: resolved
Type: task
Blocked by: 02

Applicare i layer SQL attraverso l'identità dichiarata. MySQL non deve più usare
`REPLACE`; PostgreSQL non deve ripiegare su `INSERT` quando manca una PK.

- [x] MySQL usa un vero upsert che non esegue delete più insert
- [x] PostgreSQL usa `ON CONFLICT` sull'identità dichiarata
- [x] L'assenza o la divergenza dell'identità interrompe il piano prima della prima riga
- [x] Un batch con forme di riga diverse conserva tutte le colonne come oggi
- [x] Conteggi applicati e stato finale vengono verificati separatamente
- [x] Test MySQL con FK `ON DELETE CASCADE` e trigger dimostra che il ramo delete non si attiva
- [x] Test MySQL e PostgreSQL dimostra che una tabella senza identità non viene duplicata
- [x] La sensibilità viene provata reintroducendo temporaneamente `REPLACE` e il fallback `INSERT`

## Risposta

MySQL applica `INSERT ... ON DUPLICATE KEY UPDATE` e conta le righe sorgente, senza
interpretare `affectedRows = 2` come due righe. PostgreSQL rifiuta l'upsert privo di
identità e usa `ON CONFLICT` sulle colonne dichiarate. L'adapter verifica vincolo e
presenza delle colonne d'identità in tutte le righe prima della prima scrittura.

Le prove unitarie passano. Le controprove hanno reso rosso il test sia alterando la
clausola MySQL sia riabilitando il fallback PostgreSQL. L'E2E reale con FK
`ON DELETE CASCADE`, trigger e tabella priva di identità passa su MySQL 8; la prova
senza identità passa anche su PostgreSQL 16.
