# 07: Provare il round-trip completo sui tre DBMS

Status: ready-for-agent
Type: task
Blocked by: 01, 02, 03, 04, 05, 06

Chiudere il programma con una matrice che esegua gli stessi fixture attraverso
export/import UI e backup/restore e confronti valore, tipo e schema risultanti.

- [ ] MongoDB copre l'intera matrice BSON canonica, validator, view e opzioni degli indici
- [ ] PostgreSQL copre array, bytea, JSON, temporali, intervalli, geometrie, generated e identity
- [ ] MySQL copre BIGINT, binari, BIT, temporali, geometrie, generated e FK in ordine inverso
- [ ] Ogni scenario passa sia dal percorso `.codedb.json` sia dal backup CLI
- [ ] I confronti verificano tipo e metadati, non soltanto il valore reso come JSON
- [ ] Gli E2E usano nomi unici e il confine distruttivo isolato della spec di integrità
- [ ] Ogni famiglia critica possiede una prova di sensibilità documentata
- [ ] Le suite esistenti restano verdi

## Commenti

I test correnti provano soprattutto documenti e date ordinarie. Questa matrice deve
impedire che un esito verde nasconda coercizioni di tipo o oggetti di schema omessi.
