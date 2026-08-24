# 02: Condividere un codec SQL guidato dai metadati

Status: ready-for-agent
Type: task
Blocked by: nessuno

Estrarre dal backup il concetto di colonna archivistica e renderlo il confine comune di
export/import UI e backup/restore. La conversione deve dipendere dal tipo dichiarato,
non soltanto dalla forma JavaScript del valore.

- [ ] Array PostgreSQL e JSON restano categorie distinte
- [ ] Buffer SQL non viene serializzato come oggetto con chiavi numeriche
- [ ] `bytea`, BLOB/BINARY e BIT hanno una codifica reversibile
- [ ] Temporali e intervalli conservano precisione e significato dichiarati dal DBMS
- [ ] Geometrie conservano rappresentazione e SRID necessari al ripristino
- [ ] BIGINT MySQL non attraversa un `Number` JavaScript non sicuro
- [ ] UI e CLI chiamano lo stesso codec per ogni strategia
- [ ] Il codec possiede test puri per valore nullo e per ogni famiglia supportata

## Commenti

`toSqlValue` resta adatto alle modifiche interattive, dove un oggetto può significare
JSON; non è sufficiente per un artefatto che deve distinguere un array SQL da JSON.
