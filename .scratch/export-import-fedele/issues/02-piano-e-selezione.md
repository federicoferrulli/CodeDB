Status: resolved
Blocked by: 01

# Fase 1 — Piano e selezione

Piano: `docs/piano-export-import-database.md` §11, riga «1 — Piano e selezione»; §3
(albero di selezione, dipendenze), §4 (contratto comune del piano), §6.3 (selezione,
filtri e dipendenze).

## Perimetro

Evolvere `db/importPlan.js`, `db/artefatti.js`, `db/schemaObjects.js`. Introdurre il
**piano di export** con le stesse proprietà del piano di import: immutabile, firmato da
impronta, con riferimenti a file e digest e mai array di documenti. Chiusura delle
dipendenze dal catalogo reale, non dalle euristiche UML.

## Criterio di uscita (dal piano)

Struttura+dati / solo struttura / solo dati / mista generano piani immutabili;
esclusioni e bersagli verificati prima di ogni scrittura.

## Risposta

Fase 1 chiusa. Il contratto comune vive in `db/pianoComune.js` (canonico, impronta,
congelamento, verifica) e `db/importPlan.js` ora lo riusa invece di duplicarlo.
`db/exportPlan.js` decide il perimetro senza aprire connessioni: le quattro modalità,
la chiusura transitiva delle dipendenze di struttura dal catalogo reale (mai dalle
euristiche UML), FK escluse dalla chiusura di creazione ma dichiarate in
`ordine.vincoli` e `vincoliOmessi`, prerequisiti esterni, dipendenze non deducibili,
dipendenze dei dati dichiarate e mai chiuse d'ufficio, ordine di ricostruzione
separato (creazione/dati/vincoli) con cicli veri dichiarati, esclusioni con motivo,
rifiuto dei database di sistema anche fuori dal browser, `contaRighe` dichiarato per
«solo struttura». `db/exportCatalogo.js` legge il catalogo reale (MySQL da
`information_schema`, PostgreSQL da `pg_depend`/`pg_constraint`, MongoDB da
`viewOn` con `$lookup` dichiarato non deducibile) riusando `readSchemaObjects` per gli
oggetti non-tabella invece di un secondo lettore.

Prove: `test/unit-piano-export.js` (modalità, contratto, chiusura, ordine, esclusioni,
rifiuti) e `test/unit-export-catalogo.js` (query vere contro funzioni finta,
incastro catalogo→piano), entrambi cablati in `test/unit.js`. `npm test` verde;
sensibilità del piano verificata in fase di scrittura (mutazioni su chiusura FK e
impronta osservate fallire prima del ripristino).
