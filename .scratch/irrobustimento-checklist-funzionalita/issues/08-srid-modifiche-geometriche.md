# 08: Preservare lo SRID nelle modifiche geometriche

Status: done
Type: task
Blocked by: None (can start immediately)

**What to build:** Una geometria modificata deve conservare lo SRID originale; quando
CodeDB non può determinarlo, la scrittura deve fermarsi con un errore parlante.

- [x] Il valore o i metadata trasportano lo SRID fino alla strategia
- [x] PostgreSQL non inventa SRID 4326 e MySQL non inventa SRID 0
- [x] Il fallimento della lettura dei metadata impedisce la mutazione
- [x] L'errore spiega perché lo SRID non è noto e come correggere i privilegi o lo schema
- [x] E2E PostgreSQL e MySQL coprono uno SRID non predefinito e metadata negati
- [x] La controprova col ripiego predefinito rende rosso il test

Verifica: `node test/e2e-srid-modifiche.js` superato con MySQL 8 e PostGIS
16-3.4 su schemi temporanei. Copre update e replace, SRID 3003 e 0 effettivo,
coordinate proiettate, NULL senza SRID dichiarato, otto modifiche concorrenti.
Il diniego SELECT dei metadata è iniettato sul pool, senza cambiare i privilegi
globali dei cataloghi; viene verificata l'assenza di mutazioni.
Le controprove in memoria con ripiego MySQL 0 e PostgreSQL 4326 falliscono
entrambe sull'asserzione `SRID originale non predefinito conservato`.
`npm test` e i test unitari di geometrie e metadata SQL superati.
Revisione Standards/Spec completata; corretto lo stallo del pool PostgreSQL
spostando la lettura della chiave primaria prima dell'apertura della transazione.
