# 02: Congelare il bersaglio di ogni riquadro Split View

Status: resolved
Type: task
Blocked by: 01: Scartare le pagine obsolete della griglia

**What to build:** Ogni riquadro deve mostrare e modificare soltanto la collezione del
contesto che ha originato la richiesta, anche quando l'utente cambia rapidamente
database, collezione o tab.

- [x] Ogni lettura del riquadro usa il contratto di generazione introdotto dal ticket 01
- [x] Titolo, righe e metadata del riquadro provengono dalla stessa generazione
- [x] Una mutazione conserva tab, database e collezione originari senza rileggere stato globale mutabile
- [x] Un test inverte le risposte di due collezioni e verifica vista e bersaglio della scrittura
- [x] Nessuna scrittura raggiunge la seconda collezione usando una riga della prima
- [x] La controprova senza contesto congelato rende rosso il test


## Risposta

Il congelamento del bersaglio esisteva già per buona parte dei percorsi di
`public/js/splitview.js`: `runPaneQuery` teneva un contatore di generazione
per riquadro, il cambio di database/collezione lo confrontava già con
`contestoCorrente`, e ogni scrittura (`deletePaneDoc`, `eliminaRigheRiquadro`,
la modifica inline via `startPaneEdit` → `contestoScrittura` in
`inlineEdit.js`) congelava già `tabId`/`db`/`coll` in un oggetto letterale al
momento dell'azione, non in un riferimento al riquadro mutabile. Mancava però
proprio ciò che il ticket 01 aveva già dimostrato necessario: **usare il
contratto** (`contestoCorrente`) invece di ripetere a mano lo stesso confronto
di campi in ogni guardia, e una prova nella condizione in cui la differenza si
vede.

- `runPaneQuery` (lettura e catch) e `caricaRelazioniPane` leggono ora il
  contesto atteso attraverso `contestoCorrente`, come già faceva il cambio di
  database/collezione nella stessa testata. `deletePaneDoc` ed
  `eliminaRigheRiquadro` fanno lo stesso per decidere se la scrittura appena
  riuscita deve riavviare una rilettura del riquadro.
- `test/e2e-split-bersaglio-riquadro.js` (Chromium, socket finto, nessun
  database) copre due generazioni:
  - **vista**: un riquadro passa "ordini" → "clienti" → "prodotti" senza mai
    ricevere risposta, poi le tre `collection:find` vengono consegnate FUORI
    ordine (la superata di mezzo, poi quella vera, infine la più vecchia).
    Colonne, righe e riepilogo mostrati appartengono tutti a "prodotti", mai
    un mix;
  - **scrittura**: si apre la modifica di una cella di "prodotti", si passa il
    riquadro a "fatture" PRIMA di salvare (il `<input>` dell'editor resta un
    nodo staccato ma vivo) e si salva. Il `doc:update` raggiunge "prodotti"
    con l'`_id` della riga originale, mai "fatture".
- Controprova eseguita rompendo di proposito, una alla volta, le due guardie
  coinvolte, poi ripristinate:
  - `contestoCorrente` rimosso dalla guardia di `runPaneQuery` → 4 asserti
    rossi (colonne, righe e riepilogo della prova "vista");
  - il congelamento del contesto di scrittura bypassato in
    `inlineEdit.js` (`salvaCampi` ignora il `ctx` esplicito) → 2 asserti
    rossi (bersaglio della scrittura, database della scrittura).
- `npm test`, `test/e2e-pagine-obsolete.js`, `test/e2e-selezione-celle-viste.js`
  e `test/e2e-fk-viste.js` restano verdi: nessuna regressione sulle altre
  guardie di generazione né sulle prove esistenti sui riquadri.
