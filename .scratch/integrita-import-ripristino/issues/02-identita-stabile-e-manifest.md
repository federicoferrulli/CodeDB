# 02: Dichiarare l'identità stabile nei manifest

Status: ready-for-agent
Type: task
Blocked by: nessuno

Definire la regola unica con cui un layer riconosce la stessa riga nel tempo e registrarla
nel manifest. Un timestamp seleziona le modifiche ma non identifica la riga.

- [ ] MongoDB dichiara `_id` come identità
- [ ] SQL dichiara PK oppure un vincolo univoco interamente non nullo
- [ ] Una tabella senza identità stabile è ammessa nel full verso destinazione vuota ma rifiutata negli incrementali/differenziali
- [ ] Il restore riverifica identità, colonne e compatibilità col manifest prima di scrivere
- [ ] La versione del manifest distingue i nuovi backup da quelli storici
- [ ] I backup storici non vengono promossi implicitamente a incrementali sicuri
- [ ] La verifica finale confronta cardinalità e identità distinte, non la somma delle scritture
- [ ] Un test rotto intenzionalmente dimostra di intercettare la duplicazione dei layer

## Commenti

Questo ticket è il prerequisito semantico degli upsert MySQL e PostgreSQL.

