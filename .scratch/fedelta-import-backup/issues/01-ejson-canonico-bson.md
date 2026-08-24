# 01: Rendere canonici dati e metadati BSON negli artefatti

Status: ready-for-agent
Type: task
Blocked by: nessuno

Introdurre un codec archivistico MongoDB che usi Extended JSON canonico per export UI,
backup, dati e metadati, lasciando invariato il formato relaxed della griglia.

- [ ] `Long("9007199254740993")` conserva valore e tipo nei due round-trip
- [ ] `Long(42)`, `Int32(42)` e `Double(42.0)` restano distinguibili
- [ ] `Decimal128`, `Binary`, `Timestamp`, regex, date e valori annidati restano fedeli
- [ ] Indici e oggetti di schema non attraversano più `EJSON.serialize(..., { relaxed: true })`
- [ ] I file storici relaxed restano importabili senza inventare tipi ormai ambigui
- [ ] La versione dell'artefatto distingue il nuovo codec dal formato storico
- [ ] Una controprova col vecchio codec rende rossa la matrice numerica

## Commenti

La perdita avviene prima del restore: usare `relaxed: false` soltanto in lettura non può
recuperare precisione o tipo già eliminati dal file.
