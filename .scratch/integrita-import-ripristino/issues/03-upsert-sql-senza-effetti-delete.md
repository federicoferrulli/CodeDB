# 03: Applicare upsert SQL senza effetti di cancellazione

Status: ready-for-agent
Type: task
Blocked by: 02

Applicare i layer SQL attraverso l'identità dichiarata. MySQL non deve più usare
`REPLACE`; PostgreSQL non deve ripiegare su `INSERT` quando manca una PK.

- [ ] MySQL usa un vero upsert che non esegue delete più insert
- [ ] PostgreSQL usa `ON CONFLICT` sull'identità dichiarata
- [ ] L'assenza o la divergenza dell'identità interrompe il piano prima della prima riga
- [ ] Un batch con forme di riga diverse conserva tutte le colonne come oggi
- [ ] Conteggi applicati e stato finale vengono verificati separatamente
- [ ] Test MySQL con FK `ON DELETE CASCADE` e trigger dimostra che il ramo delete non si attiva
- [ ] Test MySQL e PostgreSQL dimostra che una tabella senza identità non viene duplicata
- [ ] La sensibilità viene provata reintroducendo temporaneamente `REPLACE` e il fallback `INSERT`

