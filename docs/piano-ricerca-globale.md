# Piano — Ricerca Globale

Stato: **proposta**, nessuna riga scritta.
Perimetro deciso: **la connessione del tab attivo**, entrambe le modalità (struttura e dati).

---

## 1. Il problema

Oggi in CodeDB "ricerca" significa **sei caselle scollegate**, ognuna che sa una cosa sola:

| Casella | Cosa cerca | Dove |
|---|---|---|
| `#conn-search` | nomi di connessioni salvate | `connmanager.js` |
| `#db-search` | nomi di database e collezioni (evento `db:search`) | `dbtree.js` |
| `#query-schema-search` | tabelle/campi dello Schema Browser | `query-tab.js` |
| `#graph3d-search` | tabelle/campi nel grafo 3D | `graph3d.js` |
| `#backup-catalog-filter` | gruppi di backup | `backupmanager.js` |
| `#pending-search-input` | query in sospeso | `pending-queries.js` |

Due conseguenze. La prima è che **per cercare bisogna già sapere dove guardare**: chi ha in mente `ordini_2024` deve prima indovinare in quale pannello vive la casella giusta, e se sbaglia riceve "nessuna corrispondenza" — una risposta falsa, non incompleta. La seconda è più grave: **nessuna di queste cerca dentro i dati**. La domanda che si pone davvero davanti a un database sconosciuto — *dove sta scritto `mario.rossi@x.it`?* — oggi non ha risposta se non aprendo una tabella alla volta e scrivendo un filtro a mano.

`db:search` inoltre si ferma ai **nomi di db e collezioni**: non conosce le colonne. Cercare `codice_fiscale` non trova nulla, anche quando quella colonna esiste in undici tabelle.

## 2. Cosa costruiamo

**Un solo ingresso** (`Ctrl+K`, più una voce nel menu Impostazioni) con **due modalità distinte e dichiarate**, perché rispondono a due domande diverse e hanno due costi diversi di ordini di grandezza:

- **Struttura & comandi** — istantanea, in memoria, nessuna query pesante. Trova database, tabelle/collezioni, **colonne**, connessioni salvate, comandi dell'applicazione, query della cronologia, snippet.
- **Dati** — scansione vera sui DBMS. Trova *in quali tabelle e colonne compare un valore*, con progresso, cancellazione e tetti.

Le due modalità **non si mescolano in un elenco unico**. Un risultato di struttura costa zero e appare mentre si scrive; un risultato di dati costa una scansione da decine di secondi. Fonderli significherebbe o far pagare la scansione a chi voleva solo aprire una tabella, o far credere che la ricerca nei dati sia già completa quando non è ancora partita. La modalità dati si attiva con un prefisso esplicito (`>` o il tasto Tab, da decidere in fase 2) o dal suo tab nella finestra.

Le sei caselle esistenti **restano**: sono filtri di contesto e funzionano bene per quello. La palette non le sostituisce, risponde a un'altra domanda.

---

## Fase 1 — Struttura & comandi

### 1.1 Indice lato server: `search:index`

Un nuovo evento socket restituisce, per la sessione del tab, l'inventario dei nomi: database → collezioni → colonne.

**Il costo va speso una volta e in modo asimmetrico fra i DBMS.**

- **MySQL / PostgreSQL** — una sola `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns` con l'esclusione degli schemi di sistema copre *tutto* l'inventario, colonne comprese, in una query. Su PostgreSQL `table_schema` è il livello "database" della UI, coerentemente con `PostgreSqlStrategy`.
- **MongoDB** — non c'è un catalogo. `dbSchema()` esiste ma **campiona 50 documenti per collezione**: su venti database da quaranta collezioni sono ottocento campionamenti, cioè decine di secondi all'apertura della palette. Inaccettabile per una finestra che deve rispondere mentre si digita.

Da qui la regola: **l'indice è a due livelli e il secondo è pigro.**

1. *Livello nomi* — database e collezioni, da `listDatabases`/`listCollections` (già esistenti, già economici). Disponibile subito, su tutti e tre i DBMS.
2. *Livello colonne* — gratis su SQL (arriva con la stessa query del livello 1), **su richiesta** su MongoDB: si campionano le collezioni di un database solo quando quel database viene espanso nella sidebar, oppure quando l'utente chiede esplicitamente "cerca anche nei campi" dalla palette.

La palette dichiara la differenza invece di nasconderla: su MongoDB, sotto i risultati, una riga dice quali database non sono ancora stati indicizzati per campo e un pulsante li carica. È la stessa scelta già presa per il filtro dello Schema Browser (`query-tab.js`), dove "nessuna corrispondenza" su una tabella mai caricata sarebbe una risposta falsa.

**Cache.** L'indice vive nella sessione (`session.searchIndex`) con un TTL breve (60 s) e viene **invalidato dalle DDL che passano da qui** — stesso meccanismo della cache di `tableColumnsInfo` nelle strategie SQL. Senza invalidazione, una tabella appena creata non sarebbe trovabile e sembrerebbe un guasto.

**RBAC.** `search:index` è capability `read` e — punto non negoziabile — **deve filtrare, non negare**, esattamente come fanno oggi `listDatabases`/`listCollections`/`search` in `guardStrategy.js`. Un sottoutente con scope su due tabelle deve vedere due tabelle nella palette, non un errore. Il modo più sicuro di ottenerlo è **costruire l'indice sopra i metodi già avvolti dal Proxy** (`listDatabases`, `listCollections`, `dbSchema`), che il filtro ce l'hanno già, invece di aggiungere un metodo nuovo con una sua copia della logica di scope, destinata a divergere. Su SQL, dove per efficienza serve la query unica su `information_schema`, il risultato va comunque passato dal **filtro dello scope** prima di uscire: è l'unico punto dove il pattern "filtra le liste" viene ricreato a mano, e va coperto da un test dedicato.

### 1.2 Strato puro del match: `public/js/search-fuzzy.js`

Modulo **foglia, senza import**, provato in Node (`test/unit-search-fuzzy.js`, dentro `npm test`). Stessa ragione di `cell-stats.js`, `chart-option.js`, `table-cols.js`: `utils.js` sta in un ciclo di import che carica l'intera applicazione, quindi qualunque logica importi da lì non è provabile fuori dal browser.

Contiene: normalizzazione del termine, match a sottosequenza con punteggio (bonus per inizio parola, per corrispondenza contigua, per separatori `_`/`-`/`.`), evidenziazione delle posizioni corrisposte, e l'**ordinamento fra tipi diversi**.

Quest'ultimo è la decisione che fa la differenza fra una palette utile e un elenco casuale: cercando `ordini` si vuole la **tabella** `ordini` prima della colonna `id_ordini` di un'altra tabella e prima del comando "Esporta ordini". L'ordine è quindi *punteggio del match*, poi *peso del tipo* (collezione > database > colonna > comando > cronologia > snippet), poi *recenza d'uso*. Un elemento aperto di recente sale: è il comportamento che rende una palette veloce dopo una settimana d'uso, e costa una mappa in `localStorage`.

Il match è sul **nome**, non sull'etichetta visualizzata — è lo stesso difetto già corretto nello Schema Browser, dove cercare `int` tirava su ogni colonna intera perché il confronto includeva il tipo nell'etichetta.

### 1.3 La finestra: `public/js/palette.js`

- Apertura `Ctrl+K` (e `Ctrl+P`, convenzione VS Code), voce nel menu Impostazioni, Esc/clic fuori per chiudere.
- Elenco a gruppi con intestazioni, navigazione da tastiera, Invio apre, `Ctrl+Invio` apre in un **nuovo coll-tab fissato** invece che in anteprima.
- Aprire una collezione riusa `selectCollection`; aprire un database riusa `openDbTab`. **Nessun percorso di apertura nuovo**: la palette è un modo di *raggiungere* funzioni esistenti, e ogni scorciatoia che duplicasse la logica di apertura sarebbe un secondo comportamento da tenere allineato.
- Un risultato aperto dalla palette nasce **in anteprima** (`ct.preview`), come un clic in sidebar: esplorare con la palette non deve lasciare venti tab aperti — è esattamente il caso per cui i tab in anteprima esistono.
- L'overlay **disattiva `backdrop-filter`** come `#geomap-overlay`, `#geomulti-overlay` e `#modal-theme`: il pannello si ridipinge a ogni tasto, e una sfocatura a schermo intero per fotogramma è il costo già misurato altrove.
- Nessun colore cablato: solo token di `tokens.css`.

### 1.4 Registro dei comandi

Un array dichiarativo (`public/js/palette-comandi.js`) che elenca le azioni già esistenti con etichetta, sinonimi e condizione di visibilità: Backup & Restore, Storico Azioni, Salute Connessioni, Sessioni & Query attive, Utenti & Permessi, Cambia Passphrase, Tema, Guida Introduttiva, Controlla Aggiornamenti, Informazioni & Licenza, più le cinque viste del workspace e "nuova connessione".

La condizione di visibilità non è un dettaglio: le voci che richiedono una connessione aperta, o `manage`, o l'app desktop (Controlla Aggiornamenti, che senza il ponte `__codedbDesktop` oggi resta nascosta invece di comparire e fallire) **non devono comparire quando non sono eseguibili**. Una palette che offre comandi che poi danno errore è peggio di una palette che non li ha.

Il registro punta agli **id dei pulsanti esistenti** (`btn-backup-manager`, `btn-audit-log`, …), che il refactoring del menu Impostazioni ha deliberatamente conservato: così un comando è un `click()` sull'elemento vero e non una seconda strada verso la stessa funzione.

---

## Fase 2 — Ricerca nei dati

### 2.1 La decisione architetturale

C'è una strada ovvia e sbagliata: aggiungere alle strategie un metodo `searchAllData(termine)` che gira su tutte le tabelle e restituisce i risultati.

**Non va fatto**, per una ragione sola ma dirimente: il Proxy autorizzante di `auth/guardStrategy.js` mappa *un metodo* su *una capability* e confronta *un bersaglio* con lo scope. Un metodo che tocca trecento tabelle ha un bersaglio solo — nessuno — quindi lo scope non avrebbe alcun effetto reale e un sottoutente autorizzato su due tabelle leggerebbe l'intero database. È lo stesso difetto già corretto per l'SQL Raw con `auth/sqlTables.js`, dove il bersaglio *dedotto* non corrispondeva a ciò che veniva eseguito.

La ricerca nei dati va quindi **orchestrata in `server.js` come ciclo sui metodi esistenti**, sulla strategia già avvolta dal Proxy — esattamente il modello di `ScriptRunner`, che esegue un'istruzione alla volta proprio per avere capability decisa per singola istruzione invece di un unico "write" indistinto.

Ne discendono quattro proprietà **gratis**, senza scrivere una riga di sicurezza nuova:

1. Lo **scope per tabella** vale automaticamente: una tabella fuori scope solleva sul suo `collectionFind` e viene saltata.
2. Il **filtro delle liste** vale già: le tabelle da scandire vengono dall'indice della Fase 1, già filtrato.
3. `isFileIoSql`, il divieto di `$where`/`$function`, `expectRead` e la transazione `READ ONLY` per i sottoutenti valgono senza eccezioni.
4. L'**audit** classifica ogni lettura con il codice esistente.

### 2.2 Strato puro: `db/ricercaGlobale.js`

Provato in Node (`test/unit-ricerca-globale.js`, in `npm test`). Prende il termine e l'inventario delle colonne, restituisce il **piano di scansione**: per ogni tabella, quali colonne interrogare e con quale filtro.

Tre regole, e sono la differenza fra "funziona" e "dà errore sulla terza tabella":

**(a) Le colonne si filtrano per compatibilità col termine.** Cercare `mario` su una colonna `INT` su MySQL non è un errore ma un **cast implicito silenzioso** (`'mario'` → `0`), che restituisce tutte le righe con quel campo a zero: risultati falsi, plausibili, e impossibili da riconoscere. Su PostgreSQL è un errore secco che interrompe la scansione. Quindi: un termine non numerico interroga solo colonne testuali (`char`/`varchar`/`text`/`json`/`enum`/`uuid`); un termine numerico anche quelle numeriche; una data riconoscibile anche quelle temporali. Le colonne binarie e geometriche restano fuori sempre.

**(b) Il filtro è in forma strutturata, non testo SQL.** `auth/sqlClause.js` pretende la forma strutturata (confronti colonna/valore combinati con AND/OR) per i principal con scope attivo. Un `OR` di `colonna LIKE valore` rientra esattamente in quella forma — quindi la ricerca nei dati funziona per i sottoutenti senza deroghe, purché il piano venga costruito così e non concatenando stringhe. Costruirlo come testo libero significherebbe o rompersi per i sottoutenti, o pretendere una deroga: entrambe le cose vanno evitate ora, non dopo.

**(c) Su MongoDB si cercano i campi campionati, e si dichiara.** Il filtro è un `$or` di `{campo: {$regex: …}}` sui campi noti dal campionamento di `dbSchema`, con il termine **passato per `$regex` con i metacaratteri neutralizzati** (senza, cercare `a.b` o `c++` fa match a sorpresa o solleva). Un campo presente solo in documenti fuori campione **non viene cercato**, e questo va scritto nell'interfaccia: un limite dichiarato è utile, uno silenzioso è una bugia. Alternativa valutata e scartata per il default: `$expr` + `$objectToArray` cerca in *ogni* campo senza conoscerlo, ma impedisce l'uso di qualunque indice e trasforma ogni collezione in una scansione completa — resta come opzione esplicita ("ricerca esaustiva"), non come comportamento normale.

### 2.3 Esecuzione: `search:data`, `search:progress`, `search:abort`

Modellati **uno a uno** su `script:execute` / `script:progress` / `script:abort`, perché il problema è lo stesso: un'operazione lunga che deve dare avanzamento, sopravvivere all'ack, essere fermabile e non intasare il socket.

- L'ack ritorna subito `{ ok, totaleTabelle }`; i risultati arrivano con i push, diradati come `SCRIPT_PROGRESS_MS` (ma i **ritrovamenti** scavalcano il diradamento: sono la cosa per cui si sta aspettando).
- Ogni ricerca è una **query in sospeso** (`kind: 'search'` in `pending-queries.js`), con barra di avanzamento nella scheda. Coerente con gli script.
- `opHandle` registrato in `session.inflight`, così `search:abort` tronca la query in corso sul database con `cancelQuery` — e non solo smette di ciclare.
- **Ordine di scansione: dalla tabella più piccola alla più grande** (il conteggio stimato è già disponibile da `listCollections`). Non è cosmesi: su un database reale il 90% delle tabelle è piccolo, quindi i primi ritrovamenti compaiono in un paio di secondi invece che dopo la tabella da ottanta milioni di righe. La barra di avanzamento continua a contare le tabelle, non le righe.
- **Tetti**, tutti già esistenti o loro fratelli: `CODEDB_SEARCH_MAX_TABLES` (default 500), `CODEDB_SEARCH_MAX_HITS_PER_TABLE` (default 20 — la palette dice *dove* sta il valore, non lo esporta), `CODEDB_SEARCH_TIMEOUT_MS` per tabella (default 5000, come `countTimeoutMs`, con la tabella marcata "scaduta" e la scansione che **prosegue**), più `maxResultBytes` già applicato dalle strategie. Ogni tetto raggiunto viene **dichiarato nel riepilogo**: "482 tabelle su 1.130", non un elenco che sembra completo.
- Politica errori: **continua e riporta**, come lo `ScriptRunner`. Una tabella fuori scope, con privilegi mancanti o in lock non ferma le altre; compare nel riepilogo con il motivo.

### 2.4 Audit

Una ricerca nei dati è **una** voce di audit, non trecento. `classifyAudit` va esteso con `search:data` come lettura, con dettagli: termine cercato (o la sua lunghezza, se si preferisce non registrare valori che possono essere dati personali — **da decidere**, ed è una decisione GDPR, non tecnica), numero di tabelle scandite, numero di ritrovamenti. Le singole `collectionFind` interne vanno marcate `_bg` per non moltiplicare le voci, come già fanno le letture automatiche della griglia.

### 2.5 Risultati

Elenco raggruppato per database → tabella → colonna, con il numero di righe corrispondenti e un'anteprima del valore. Un clic apre la tabella **con il filtro già applicato**: è il punto in cui la ricerca smette di essere un elenco e diventa navigazione. "Copia riepilogo" in TSV, coerente con i pannelli statistiche e geometrie.

---

## 3. File toccati

**Nuovi**
```
docs/piano-ricerca-globale.md          (questo)
db/ricercaGlobale.js                   puro — piano di scansione
public/js/search-fuzzy.js              puro, foglia — match e punteggio
public/js/palette.js                   la finestra
public/js/palette-comandi.js           registro dei comandi
test/unit-search-fuzzy.js              in npm test
test/unit-ricerca-globale.js           in npm test
test/e2e-ricerca-globale.js            sui 3 DBMS
```

**Modificati**
```
server.js                 search:index, search:data (+ progress/abort), cache in sessione
auth/capabilities.js      EVENT_CAPABILITY: search:index → read, search:data → read
auth/guardStrategy.js     filtro dello scope sull'inventario SQL costruito da information_schema
db/AuditLog.js            classifyAudit: search:data come lettura
public/index.html         overlay della palette
public/css/style.css      stile, solo token
public/js/main.js         scorciatoia Ctrl+K, voce nel menu Impostazioni
public/js/pending-queries.js   kind 'search'
CLAUDE.md                 sezione della ricerca globale
```

## 4. Ordine di lavoro

1. `search-fuzzy.js` + test — foglia, nessuna dipendenza, si scrive e si prova da sola.
2. `search:index` lato server (SQL prima: una query; Mongo pigro dopo) + filtro di scope + test.
3. `palette.js` con la sola struttura. **Consegnabile e utile qui**: già risolve "in quale pannello sta la casella giusta" e la ricerca per colonna, che oggi non esiste.
4. Registro dei comandi.
5. `ricercaGlobale.js` + test — il piano di scansione, provato in Node prima di toccare un DBMS.
6. `search:data` con progresso, cancellazione, tetti e audit.
7. Interfaccia dei risultati e apertura col filtro applicato.
8. e2e sui tre DBMS + collaudo in browser + `npm run impronte`.

Il punto 3 è una consegna vera: se la Fase 2 slitta, quello che resta è comunque la funzione che manca di più oggi.

## 5. Questioni aperte

- **Il termine cercato finisce nell'audit?** È il caso in cui un log di sicurezza può diventare un archivio di dati personali (si cerca un'email, un codice fiscale). Propendo per registrare lunghezza e hash, non il testo — ma è una scelta da confermare.
- **Prefisso della modalità dati**: `>`, `#`, o un tab nella finestra. Da provare a mano.
- **MongoDB, ricerca esaustiva** (`$objectToArray`): tenerla come opzione dichiarata o non offrirla affatto. Su una collezione grande è una scansione completa e non c'è modo di renderla economica.
- **Ricerca fra più connessioni**: escluso ora per decisione esplicita. L'indice per sessione lo rende un'estensione naturale in seguito, ma il fan-out sugli errori parziali è un problema a sé.
