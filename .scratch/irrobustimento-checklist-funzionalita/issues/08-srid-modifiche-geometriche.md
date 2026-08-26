# 08: Preservare lo SRID nelle modifiche geometriche

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** Una geometria modificata deve conservare lo SRID originale; quando
CodeDB non può determinarlo, la scrittura deve fermarsi con un errore parlante.

- [ ] Il valore o i metadata trasportano lo SRID fino alla strategia
- [ ] PostgreSQL non inventa SRID 4326 e MySQL non inventa SRID 0
- [ ] Il fallimento della lettura dei metadata impedisce la mutazione
- [ ] L'errore spiega perché lo SRID non è noto e come correggere i privilegi o lo schema
- [ ] E2E PostgreSQL e MySQL coprono uno SRID non predefinito e metadata negati
- [ ] La controprova col ripiego predefinito rende rosso il test

