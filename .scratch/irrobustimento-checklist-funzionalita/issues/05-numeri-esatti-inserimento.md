# 05: Preservare numeri esatti durante l'inserimento

Status: completed
Type: task
Blocked by: 04: Preservare numeri esatti nell'editing inline

**What to build:** La modale di inserimento deve applicare lo stesso contratto numerico
dell'editing inline, producendo valori identici per lo stesso testo e tipo.

- [x] Inserimento ed editing condividono il codec esatto del ticket 04
- [x] BIGINT, Long e Decimal conservano valore e tipo fino alla strategia
- [x] Gli errori indicano la colonna e non inviano una mutazione parziale
- [x] Test equivalenti inseriscono e modificano gli stessi valori limite
- [x] Il valore riletto è identico nei due percorsi
- [x] La controprova con conversione Number nell'inserimento rende rosso il test

**Note di chiusura:** `insert.js` già passava dal codec (`decodificaNumeroEsatto`) per i
campi numerici e decimali — condiviso con `inlineEdit.js` fin dal ticket 04. Mancava però
una parità reale: `insertInputFor` forzava sempre `type="number"` per il kind `number`
(quindi anche per BIGINT/Long), mentre `buildEditor` passa a `type="text"` quando
`richiedePrecisioneEsatta` è vera — un controllo nativo `<input type=number>` calcola le
frecce su `valueAsNumber` (un double) e arrotonderebbe un intero oltre 2^53 al primo clic.
Corretto passando `numericMeta` fino a `insertInputFor`, che ora sceglie lo stesso tipo di
casella dell'editing inline. `test/e2e-numeri-esatti-inserimento.js` (Chromium, nessun
database — mirror di `e2e-fk-viste.js`/`e2e-editor-geometrico.js` perché `insert.js` e
`inlineEdit.js` richiedono il DOM) importa i moduli reali e prova: gli stessi valori limite
(bigint signed/unsigned a 64 bit, decimal ad alta precisione, BSON Long/Decimal) producono
lo stesso EJSON e lo stesso tipo di casella nei due percorsi; un campo fuori intervallo fa
fallire `buildInsertDoc` (che gira PRIMA di `emit('doc:insert', …)`, quindi nessuna
mutazione parziale) nominando la colonna nel messaggio; una controprova dimostra che
`Number()` al posto del codec perde le ultime cifre di 2^63 - 1, rendendo rosso il
confronto. La sensibilità del test è stata verificata ripristinando di proposito
`insertInputFor` alla vecchia forma (`type: 'number'` incondizionato): tre asserzioni
diventano rosse. "Il valore riletto dal database coincide con testo e tipo" resta provato,
per l'intero confine EJSON → parametro SQL → riga riletta → EJSON, da
`test/unit-sql-valori-esatti.js` (ticket 04), che quel confine non lo duplica per
inserimento ed editing: è lo stesso codec e lo stesso `serializeRow` per entrambi.

