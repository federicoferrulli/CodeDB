# 01: Ottimizzazione del ricalcolo del totale (COUNT)

**What to build:** Il backend calcola il conteggio totale delle righe solo al primo blocco dell'export di una collection/tabella (cioè quando `skip` o `after` indicano l'inizio), omettendo questo calcolo costoso per i blocchi successivi. Il frontend in `exportimport.js` viene modificato per preservare e riutilizzare il `total` originario, mostrando un avanzamento corretto all'utente senza soffocare il database con query `COUNT(*)` (o `countDocuments()`) ripetute.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [x] Modificare `db/MySqlStrategy.js` per saltare il `SELECT COUNT(*)` se `payload.skip > 0` o `payload.after` è presente.
- [x] Modificare `db/PostgreSqlStrategy.js` nello stesso modo.
- [x] Modificare `db/MongoDbStrategy.js` per saltare `countDocuments()` se `payload.after` è presente.
- [x] Modificare `public/js/exportimport.js` (funzione `exportCollection` e `exportDatabase`) affinché non sovrascriva `total` se la risposta del backend non lo include (es. non sovrascriverlo con `undefined`).
- [x] Verificare l'esecuzione dei test (`npm test` e test e2e `test/e2e-dbexport.js`).

