# 03: Preservare generated, identity e sequenze PostgreSQL

Status: ready-for-agent
Type: task
Blocked by: 02

Rendere fedele il ciclo completo delle colonne prodotte dal database e delle sequenze,
sia nell'import `.codedb.json` sia nel restore.

- [ ] Il DDL delle colonne generated conserva l'espressione del catalogo
- [ ] Le colonne generated sono escluse dai dati inseriti
- [ ] Identity `GENERATED ALWAYS` accetta i valori del full tramite una politica esplicita
- [ ] Identity `BY DEFAULT` e colonne serial conservano i valori esportati
- [ ] Lo stato di tutte le sequenze viene registrato e riallineato dopo il caricamento
- [ ] Il primo inserimento con valore predefinito dopo il round-trip non collide
- [ ] Import UI e restore producono la stessa semantica
- [ ] La controprova senza riallineamento rende rosso il test del primo inserimento
