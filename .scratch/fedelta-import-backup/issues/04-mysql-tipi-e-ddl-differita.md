# 04: Rendere fedele l'import MySQL di tipi e DDL differita

Status: ready-for-agent
Type: task
Blocked by: 02

Applicare all'export UI le estrazioni tipizzate del backup e separare dal `CREATE TABLE`
gli oggetti che richiedono la presenza di tutte le tabelle.

- [ ] BIGINT signed e unsigned conservano valore esatto
- [ ] BLOB/BINARY, BIT, temporali frazionari e geometrie con SRID fanno round-trip
- [ ] Le colonne generated sono escluse dagli `INSERT`
- [ ] Foreign key e indici differibili vengono applicati nella fase post-DDL
- [ ] Due tabelle collegate si importano anche se compaiono in ordine inverso
- [ ] Il DDL posticipato mantiene nome, azioni e proprietà del vincolo originale
- [ ] UI e backup usano la stessa descrizione archivistica delle colonne
- [ ] La controprova con `SELECT *` intercetta almeno BIGINT e geometria
