# 04: Riconciliare i metodi quasi-gemelli nel modulo comune

**Cosa costruire:** gli altri metodi che i due adattatori SQL implementano con lo stesso
nome — paginazione a chiave, informazioni sulle colonne, indici unici, chiave primaria,
conteggio stimato, elenco dei campi — hanno una sola implementazione nel modulo comune.

A differenza dei quattro del ticket precedente questi **non** sono identici: divergono su
dettagli di dialetto. La riconciliazione deve rendere le differenze esplicite come dati
del dialetto, non nasconderle dietro rami condizionali sparsi.

Ciò che diverge davvero — scrittura degli identificatori, tipi di colonna, DDL, geometrie,
sessioni e lock — resta negli adattatori e non entra nel modulo comune.

**Bloccato da:** 03.

**Status:** done

- [x] Ogni metodo riconciliato ha una sola implementazione e test unitari senza database
- [x] Le differenze fra i due motori sono dichiarate come dati, non come rami sparsi nel corpo
- [x] Per ogni metodo riconciliato esiste un test che copre entrambi i dialetti
- [x] I test end-to-end dei due motori SQL passano invariati
- [x] L'interfaccia degli adattatori si è accorciata: i metodi spostati non vi compaiono più

---

## Che cosa è stato fatto

`db/sqlMetadati.js` tiene la logica di nove metodi: `buildKeyset`,
`keysetValue`, `primaryKey`, `tableColumnsInfo`, `tableFields`, `elencoIndici`,
`uniqueIndexes`, `estimatedRowCount` e `collectionCount`. Ogni adattatore
dichiara un **dialetto** — le query al catalogo, come se ne leggono le righe, il
segnaposto dei parametri, le classi di tipo con cui si riconoscono le colonne
geometriche — e `installaMetadati` li definisce sul prototipo **non
enumerabili**, come sono i metodi di una classe: nel corpo delle classi non
compaiono più, ma nulla cambia per chi li chiama.

Anche il raggruppamento delle righe di indice (una riga per colonna, con
ordinale) era la stessa operazione scritta due volte: è `raggruppaIndici`, e
`PostgreSqlStrategy.indexList` ricompone da `elencoIndici` la forma che la vista
Dettagli si aspetta.

Il dialetto è **dati** anche dove servono due query: le colonne si leggono per
`tentativi` in ordine di preferenza (su MySQL 5.7 manca `SRS_ID`, e il secondo
tentativo la legge senza), e la lettura degli indici è `{ query, lettori }`.
L'unico pezzo di dialetto rimasto una funzione è `colonne.arricchisci`, il
secondo passo che esiste solo su PostgreSQL — il SRID dalle viste PostGIS, che
deve poter fallire senza fermare la lettura.

Il campo `_geoCache` è diventato `_cacheColonne`: non conteneva più solo
geometrie da quando il modulo ci mette tutti i metadati di colonna.

**Un difetto trovato riconciliando.** `estimatedRowCount` prendeva `(db, coll)`
su MySQL e `(coll, db)` su PostgreSQL: due significati opposti per la stessa
posizione. Non era osservabile — il metodo è chiamato solo da `collectionCount`,
dentro lo stesso file — e sarebbe diventato un difetto vero al primo chiamante
nuovo. Ora la firma è una sola, e un test la sorveglia.

Restano agli adattatori `countWithTimeout` (il tetto di tempo è meccanica del
driver: `SET LOCAL statement_timeout` contro il timeout per-query di mysql2),
`selectListFor`, le geometrie, le DDL, le sessioni e i lock.

## Come è stato provato, e che cosa NON copre

**Test unitari senza database**: `test/unit-sql-metadati.js`, registrato in
`test/unit.js`. Al posto del pool c'è un oggetto che registra la query ricevuta
e risponde con righe finte, quindi si provano i **dialetti veri dichiarati dagli
adattatori** — non due dialetti finti scritti nel test. Ogni metodo è coperto su
entrambi i motori. La suite completa (`npm test`) passa.

**La sensibilità dei test è stata verificata** rompendo di proposito il codice
sei volte, e tutte e sei fanno fallire la suite: parametri della stima invertiti
su PostgreSQL, filtro delle colonne `INVISIBLE` tolto su MySQL, segnaposto
PostgreSQL fissato a `$1`, tolleranza sulle view tolta, una copia di
`tableFields` rimessa dentro `MySqlStrategy`, e i metodi installati come
enumerabili.

**Gli E2E dei due motori sono stati eseguiti davvero**, contro MySQL 8.4 e
PostGIS 16 in container, e confrontati con la stessa esecuzione su HEAD:
- MySQL: 70 verifiche superate e 2 fallimenti (`db:rename` non atomica),
  **identici prima e dopo**;
- PostgreSQL: 3 fallimenti al punto 9-bis (FK fra schemi) che interrompono la
  corsa, **identici prima e dopo**.

Sono difetti preesistenti e scorrelati (gli stessi già dichiarati nel ticket
03): "invariati" è provato nel senso letterale, ma i due motori non hanno una
corsa E2E verde da cui partire.

**Il buco lasciato dall'E2E di PostgreSQL è stato chiuso a parte.** Poiché quella
corsa si interrompe al punto 9-bis, i metodi riconciliati non venivano
esercitati su PostgreSQL da nessun test contro un server vero. È stata quindi
eseguita una prova mirata su **entrambi** i motori accesi (tabella con chiave
primaria auto-incrementale, colonna geometrica con SRID, indice unico semplice e
composto): chiave primaria, colonne e classificazione delle geometrie,
`tableFields` con i modificatori di tipo, indici unici, stima, conteggio con e
senza filtro, paginazione a chiave avanti e indietro, e `duplicatePlan` — che
usa insieme campi, indici unici e chiave primaria. Tutto superato su MySQL e su
PostgreSQL, compresa la distinzione fra geometrie PostGIS e tipi geometrici
nativi. La prova è uno script usa-e-getta, non è entrata nella suite.

**Resta noto e non chiuso**: nessun test della suite esercita questi metodi
contro un PostgreSQL vero, perché l'E2E si ferma prima. Chiudere quel buco vuol
dire correggere il difetto del punto 9-bis, che è un'altra issue.

## Rilievi della revisione, e che cosa ne è stato fatto

Corretti: gli export del modulo ridotti a ciò che ha un lettore; `_geoCache`
rinominato; il blocco `Object.assign` copiato nei due adattatori sostituito da
`installaMetadati` (che risolve anche l'enumerabilità); `colonne.leggi` e
`indici.leggi` — funzioni che facevano query proprie — diventati dati
(`tentativi`, `{ query, lettori }`).

Non corretti, di proposito:

* `componiKeyset` chiama la funzione di modulo `valoreKeyset` invece di
  `this.keysetValue`. Un aggancio per sovrascriverla non lo usa nessuno: sarebbe
  generalità speculativa.
* `chiaveDallaPrimaria` e `assentiSeErrore` restano bandiere booleane. Sono
  esattamente le differenze fra i motori che il ticket chiede di **dichiarare**,
  e una bandiera dichiarata in un posto solo non è il ramo sparso che si voleva
  togliere.
* `Status: done` non è nel vocabolario di `docs/agents/triage-labels.md`, ma è
  quello che usano gli altri tre ticket chiusi di questa cartella: cambiarlo
  qui soltanto renderebbe la serie incoerente.
