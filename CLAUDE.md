# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Regola per le risposte

L'utente si chiama **Keus**: rivolgiti a lui per nome in ogni risposta.

---

## Regola di completezza: chiudere davvero

Non ridurre il lavoro perché sembra lungo. Se un problema richiede di correggere
il motore prima della funzione, si corregge il motore. Non c'è credito per aver
finito prima, e c'è un costo reale nel dichiarare risolto ciò che non lo è.

In pratica:

* **Non disabilitare al posto di correggere.** Nascondere un pulsante, bloccare
  una funzione con un messaggio, aggiungere un `return` anticipato: sono
  soluzioni solo quando la cosa giusta è davvero non fare quell'operazione (per
  esempio perché il DBMS non offre un'alternativa sicura), e in quel caso vanno
  spiegate. Una nota "temporaneamente bloccato" è un lavoro rinviato, non un fix.
* **"Risolto" significa verificato.** Aver scritto il codice non è averlo
  provato. Se i test non sono stati eseguiti, va detto; se sono stati eseguiti,
  va detto cosa copre la prova e cosa no. Un rapporto che dichiara risolto
  qualcosa di non provato vale meno di uno che dichiara onestamente il dubbio.
* **Correggi la classe, non l'istanza.** Se una GEOMETRY non sopravvive al
  backup, la domanda non è "come sistemo le geometrie" ma "quali altri tipi
  hanno lo stesso problema". Chiudere solo il caso segnalato lascia il difetto
  vivo e dà la falsa sicurezza di averlo eliminato.
* **Un test che non fallisce mai non prova nulla.** Dopo averlo scritto,
  verificane almeno una volta la sensibilità rompendo di proposito il codice che
  dovrebbe proteggere.
* **Finisci l'intero perimetro chiesto.** Se una parte va lasciata fuori, va
  dichiarata esplicitamente, con il motivo — non semplicemente omessa.

---

## Comandi Principali

```bash
# Avvio del Server e App
npm install
npm start                  # Avvia server su http://localhost:3030 (porta: env PORT)
npm run dev                # Dev mode con riavvio automatico (node --watch)
npm run start:rbac         # Avvia server con RBAC attivo (carica .env con CODEDB_RBAC=on)
npm run electron:start     # Avvia app desktop Electron (server incorporato + finestra)

# Build & Release Installer (Electron)
npm run electron:icons     # Rigenera icone (public/codedb.ico, public/codedb.png, build/icon.*)
npm run electron:licenza   # Rigenera build/license.txt per installer NSIS da MANLEVA.md
npm run build:win          # Installer Windows (.exe NSIS) in dist/
npm run build:mac          # Installer macOS (.dmg)
npm run build:linux        # Installer Linux (.AppImage + .deb)
npm run build:linux:docker # Build Linux da Windows tramite container Docker
npm run build:all          # Build per tutte le piattaforme
npm run build:dir          # Solo cartella spacchettata
npm run dist:win|mac|linux # Eseguibile portatile (.zip) tramite @electron/packager
npm run release:win|mac|linux # Build e pubblicazione release su GitHub (richiede GH_TOKEN)

# Collegamenti Launcher
npm run shortcut           # Crea collegamenti "CodeDB (sorgenti)" su Desktop e Start (Windows)
npm run shortcut-unix      # Crea collegamento .desktop (Linux) o istruzioni Dock (macOS)
CodeDB.cmd / ./codedb.sh   # Launcher background multipiattaforma (usa "stop" per fermare)

# Test E2E e Unitari
npm test                   # Esegue tutti i test unitari senza dipendenza da DB
node test/e2e.js           # Test end-to-end MongoDB
node test/e2e-mysql.js     # Test end-to-end MySQL
node test/e2e-postgres.js  # Test end-to-end PostgreSQL (verifica isolamento schemi)
node test/e2e-mcp.js       # Test end-to-end gateway MCP (MongoDB)
node test/e2e-mcp-mysql.js # Test end-to-end gateway MCP (MySQL)
node test/e2e-query-engine.js  # Test Query Engine & Virtual JOINs
node test/e2e-collazione-mysql.js # Test allineamento collation su MySQL reale
node test/e2e-script-risultati.js # Test risultato mostrato da uno script (MySQL)
node test/e2e-script-schede-ui.js # Test schede di risultato per istruzione (Chromium + MySQL)
node test/e2e-backup.js       # Test CLI Backup (MongoDB)
node test/e2e-backup-mysql.js # Test CLI Backup (MySQL)
node test/e2e-dbexport.js     # Test Export/Import intero DB via socket
node test/e2e-sessions.js     # Test Monitor Sessioni e lock DB reali
node test/e2e-vault-passphrase.js # Test migrazione v1→v2 e sblocco/reset vault
node test/e2e-rbac.js         # Test RBAC via socket
node test/e2e-rbac-mcp.js     # Test RBAC gateway MCP
node test/unit-mcp-auth.js    # Test gate API key endpoint /mcp
node test/unit-tema.js        # Test validazione temi e contrasti WCAG
node test/unit-tipi-colonna.js# Test validazione sintattica tipi colonna DDL
node test/unit-split-layout.js# Test geometria ed albero Split-View
node test/unit-json-bson.js  # Test validazione/formattazione/minificazione JSON-BSON
node test/unit-calcoli.js     # Test calcoli su Web Worker (soglia, equivalenza, precalcolo grafici)
node test/unit-intellisense.js# Test completamento automatico consapevole dello schema
node test/unit-sessioni.js    # Test normalizzazione sessioni DB
node test/unit-fk-relazioni.js# Test decisioni del pannello 🔗 (chiavi esterne)
node test/unit-scorrimento.js # Test velocità dello scorrimento automatico ai bordi
node test/unit-duplica.js     # Test pianificazione della duplicazione di una riga
node test/unit-collazione.js  # Test scelta della collation di connessione (MySQL)
node test/unit-script-esito.js # Test decisioni del pannello di esecuzione script
node test/unit-script-results.js # Test deposito su file dei risultati di uno script
node test/e2e-tocco-griglia.js# Test gesto tattile + scorrimento automatico (Chromium, eventi touch nativi)
node test/e2e-avvio-ui.js     # Test che la UI si carichi senza errori JS (catena degli init*)

# Backup CLI & Marcatori
npm run backup -- <cmd>    # CLI di backup/restore (backup, restore, list, verify, help)
npm run impronte           # Verifica marcatori di provenienza AGPL-3.0 (tools/impronte.js)
docker compose up -d --build # Stack Docker (CodeDB + MongoDB + MySQL)
```

> **Nota sui Test**: I test E2E avviano un'istanza usa-e-getta isolata tramite `test/e2e-harness.js` su porta dedicata (`E2E_PORT`), senza toccare il vault o la configurazione dell'utente. Richiedono un MongoDB locale su `localhost:27017` o MySQL local (`root`, password vuota).

---

## Architettura del Backend

CodeDB è un'interfaccia stile DBeaver con supporto multi-database (**MongoDB**, **MySQL**, **PostgreSQL**).

### 1. Trasporto e Protocollo
* **Socket.IO**: Tutta la comunicazione browser ↔ backend usa WebSocket con acknowledgment `{ ok: true, ... }` o `{ ok: false, error }`.
* **Gate di Sicurezza & CORS**: Controllo Origin/Host anti DNS-rebinding (`checkOrigin`). Endpoint `GET /handshake-check` per la diagnosi di errori di connessione dal client.
* **Gestione Sessioni e Tab**: Per ogni socket viene mantenuta una `Map<tabId, sessione>` (strategia DB + eventuale tunnel SSH, max 8 per socket).

### 2. Strategy Pattern (`db/`)
* **`DbStrategy.js`**: Interfaccia astratta e helper euristici UML.
* **`MongoDbStrategy.js`**: Strategia MongoDB su driver nativo (`MongoClient`). Supporta change streams (`collection:watch`).
* **`MySqlStrategy.js`**: Pool `mysql2`. **Collation della connessione**: mysql2 non la chiede al server — senza `charset` impone una costante compilata nel driver (utf8mb4_unicode_ci), che nessuno ha scelto. Non è cosmetico: variabili utente `@x`, `CAST(… AS CHAR)` e `DATE_FORMAT()` ereditano `collation_connection` con coercibilità **IMPLICIT**, la stessa di una colonna, quindi confrontarli con una colonna di collation diversa dava l'errore 1267 «Illegal mix of collations» — in query corrette nel client `mysql` e in DBeaver. `scegliCollazione` si allinea al database (in mancanza al server, poi alla predefinita utf8mb4 del server) e `usaDatabase` rifà l'allineamento a ogni `USE`, perché `collation_connection` non segue il database. Sempre e solo **dentro utf8mb4**: adottare una collation di un altro charset (su server vecchi `collation_server` è latin1_swedish_ci) sposterebbe `character_set_connection` lasciando il client su utf8mb4, cioè caratteri persi in silenzio. Un confronto fra due colonne di collation diverse resta giustamente un errore: quello è lo schema, non la connessione.
* **`PostgreSqlStrategy.js`**: Pool `pg`. **Nota**: Il livello "Database" nella UI equivale allo **Schema PostgreSQL** (`listDatabases()` elenca gli schemi e `qtable()` qualifica sempre le tabelle).
* **Paginazione e Conteggio**: `collection:find` supporta `deferCount: true`. Il conteggio viene richiesto a parte con `collection:count` soggetto a timeout (`CODEDB_COUNT_TIMEOUT_MS`, default 5000ms) per evitare blocchi su tabelle enormi. Budget di byte sui risultati (`CODEDB_MAX_RESULT_BYTES`, default 32 MB).

### 3. Vault Segreti & Crittografia (`db/vault.js`)
* **Formato Vault v2**: I segreti sono cifrati AES-256-GCM. La passphrase deriva (via `scrypt` + salt) una KEK che avvolge la DEK casuale memorizzata in `vault.json`.
* **Gestione Passphrase**: Cambiare passphrase aggiorna solo l'avvolgimento della DEK senza ri-cifrare tutti i segreti. Funzione di sblocco (`vault:unlock`), avviso segreti in chiaro (`#vault-hint`) e reset di emergenza (`vault:reset`).
* **Privilegi Admin**: La gestione del vault è riservata a `isInstallAdmin` (definiti via `CODEDB_VAULT_ADMINS` o `CODEDB_OWNER_EMAIL`).

### 4. RBAC Multi-Utente (`auth/`)
* Attivabile tramite `CODEDB_RBAC=on`. Utilizza un control plane MongoDB dedicato (`CODEDB_APP_DB_URI`).
* Autenticazione via token opachi (SHA-256 memorizzato in DB). Supporta revoca immediata a caldo dei socket connessi (`rivalidaPrincipal`).
* **Proxy Autorizzante (`guardStrategy.js`)**: Avvolge ogni `DbStrategy` imponendo le capability (`read`, `write`, `ddl`, `delete`, `manage`) e gli scope glob su DB/collezioni.
* **Sicurezza Query**:
  * `isFileIoSql`: Blocco dell'I/O sul filesystem host (`INTO OUTFILE`, `LOAD DATA`, `LOAD_FILE`).
  * `sqlTables.js`: Verifica che tutte le tabelle citate nella query rientrino nello scope.
  * `sqlClause.js`: Forzatura di filtri/ordinamenti strutturati per sottoutenti con scope.
  * Transazioni `READ ONLY` applicate lato DBMS per query di sola lettura.

### 5. Engine di Esecuzione Query & Script
* **`ScriptRunner.js`**: Esegue script SQL/Mongo istruzione per istruzione con supporto a pausa, ripresa, stop su errore e avanzamento tramite push socket (`script:progress`). **Risultati per istruzione**: uno script produce un result set per istruzione e l'utente vuole rivederli tutti, ma tenerli in RAM significherebbe cinquecento result set per run e spedirli tutti insieme a chi ne guarderà uno. Ogni result set finisce quindi **su file** (`db/ScriptResults.js`, cartella temporanea, permessi 0600, id `<10 caratteri di base64url del testo>-<timestamp>`); in memoria resta un indice leggero che viaggia con gli eventi terminali, e il browser chiede il contenuto di una scheda con `script:result` **quando la apre**. Tetti espliciti su numero (primi 50: le linguette non devono spostarsi sotto gli occhi) e byte, con gli scartati **dichiarati**. I file muoiono con il run, con il socket e con una passata all'avvio — un arresto anomalo non esegue nessuna pulizia e lì dentro ci sono righe di database. Sono schede **solo i result set veri** (`resultSet`, dichiarato dalle strategie): i riepiloghi di scrittura resterebbero cinquanta linguette «1 riga coinvolta» che tolgono il posto alla SELECT che si voleva rivedere. Lo stesso flag risolve il difetto per cui un `SELECT` con **zero righe** veniva scambiato per «nessun risultato» e la griglia mostrava l'istruzione precedente — il messaggio di una `USE` al posto della query appena scritta.
* **`MongoScript.js`**: Interprete AST JS/mongosh sicuro (senza `eval`/`new Function`) con quote di passi, ricorsione e tempo.
* **`MongoShell.js`**: Parser della sintassi shell nativa `db.<coll>.find(...)`.
* **`SqlToMql.js`**: Traduttore da SQL `SELECT` (con `JOIN`, `GROUP BY`, `HAVING`, `UNION`, sottoquery) e DDL a pipeline e comandi MongoDB.
* **`VirtualJoinEngine.js`**: Motore per Virtual JOIN Cross-DB in memoria tra SQL e MongoDB.

### 6. Geometrie su Mappa
* **GeoJSON Standard**: Formato unico usato per tutti i DBMS (`ST_AsGeoJSON` e `ST_GeomFromGeoJSON` su SQL).
* Editor Leaflet 1.9.4 integrato (vendorizzato), ottimizzazione del trascinamento vertici via Canvas a doppio layer (`geomap.js`), ed analisi statistica/cartografica delle selezioni geometriche (`geo-stats.js`, `geomulti.js`).
* **Vista mappa condivisa (`geo-vista.js`)**: motore riusabile (disegno, elenco cliccabile, riepilogo, avvisi, tetti di disegno, export GeoJSON) usato sia dalla modale della selezione di celle sia dalla scheda 🗺 Mappa dei risultati della tab ⚡. Ogni istanza è indipendente: le due viste possono coesistere nella stessa pagina.

### 7. Gateway MCP (`mcp/McpGateway.js`)
* Implementa il **Model Context Protocol** per client AI (Claude Code, Cursor, ecc.) via Streamable HTTP (`/mcp`).
* Protegibile da API Key (`Authorization: Bearer cdb_...`) sotto RBAC.
* Offre tool di esplorazione, schema audit, analisi PII/GDPR, ricerca BFS, ed esecuzione query/scritture sicure (`execute_write` con `confirm_token`).

### 8. CLI e Motore di Backup (`backup/`)
* Backup Full, Incrementale e Differenziale con manifest JSON e checksum SHA-256.
* Supporto storage cloud opzionale (S3, GCS, Azure) via `backup/lib/storage.js`.
* Isolamento multi-tenant dei backup (`BACKUP_ROOT/tenants/<ownerId>`).
* Validazione di sicurezza delle DDL in ripristino (`assertSafeSchemaSql`).

### 9. Audit Log & Errori Parlanti
* **Audit (`db/AuditLog.js`)**: Tracciamento operazioni in `ui-audit.log` e `mcp-audit.log`, isolati per tenant.
* **Errori (`db/errors.js`)**: `spiegaErrore(err, ctx)` converte gli errori tecnici dei driver in messaggi chiari in italiano (*cosa è successo*, *cosa fare*).

---

## Architettura del Frontend (`public/js/`)

Applicazione Web modulare in vanilla JavaScript (nessun framework o build step).

* **Gestione Tab e Stato**: `tabs.js` mantiene il registro dei tab attivi; `state.js` esporta un Proxy che delega allo stato del tab correntemente attivo. `colltabs.js` gestisce le schede di secondo livello (tabelle/collezioni aperte, compreso il tab a livello DB vuoto e i tab in anteprima "preview").
* **Sidebar & Impostazioni (`connmanager.js`)**: Albero delle connessioni salvate e menu Impostazioni unificato (Backup, Audit, Salute, Utenti, Passphrase, Guida, Aggiornamenti, Licenza).
* **Viste del Workspace (`main.js`)**:
  1. **Dati (`grid.js`)**: Griglia dati paginata con editing inline (`inlineEdit.js`), inserimento (`insert.js`) e toolbar compattabile.
  2. **Dettagli (`details.js`)**: Vista indici, colonne e statistiche.
  3. **⚡ Query & Aggregate (`query-tab.js`)**: Runner SQL/MQL con numeri di riga (`query-editor.js`), formattatore (`query-formatter.js`), cronologia dedicata (`qe-history.js`) e visualizzazione risultati (Tabella, JSON Tree, Grafici, **Mappa**). La scheda 🗺 Mappa (`query-map.js`) compare solo se nei risultati ci sono geometrie: `geo-risultati.js` (puro) le riconosce nelle righe — primo livello, sottodocumenti fino a 2 livelli e dentro gli array — e `geo-vista.js` le disegna.
  4. **UML (`uml.js`)**: Diagramma E-R generato in SVG.
  5. **Grafo 3D (`graph3d.js`)**: Vista interattiva 3D Force-Graph (Three.js) con percorsi BFS e diagnosi schema.
* **Split-View (`split-layout.js` / `splitview.js`)**: Struttura ad albero immutabile per affiancare più tabelle/collezioni nello stesso workspace con supporto al trascinamento, il cui ridimensionamento usa Pointer Events senza scatti.
* **Calcoli pesanti su Web Worker (`calcoli.js` / `calcoli-protocollo.js` / `calcoli-worker.js`)**: le statistiche della selezione, la scansione dei campi e il **precalcolo** dei grafici (`precalcola` in `chart-option.js`: raggruppamento, aggregazione, ordinamento) scorrono tutte le righe. Oltre **50.000 celle** finiscono su un module worker, sotto restano sul posto — spostare un lavoro da due millisecondi costerebbe più del lavoro. Le due vie chiamano lo stesso `eseguiCompito`, quindi non possono divergere; senza `Worker`, o se il worker muore, si ricade sul calcolo locale. Il **disegno** resta sul thread principale: l'option di ECharts contiene funzioni (`formatter`) e non attraversa il confine fra thread. Chi ricalcola in continuazione (la barra di stato durante il trascinamento) usa `sequenziatore()` per scartare le risposte sorpassate.
* **Custom Charts (`charts.js` / `chart-option.js`)**: Generatore di grafici ECharts 6.1.0 (vendorizzato) con aggregazione lato client, suggerimenti automatici e palette accessibili WCAG. Il caricamento della libreria e la cromatura del tema stanno in `chart-runtime.js`, condivisi con il grafico della selezione.
* **IntelliSense schema-aware (`intellisense.js` / `autocomplete.js`)**: il completamento si decide dal punto in cui sta il cursore — dopo `FROM`/`JOIN` tabelle o collezioni, dopo `u.` le colonne della sola tabella a cui `u` fa da alias, dopo `db.` le collezioni, dopo `db.coll.` i metodi, `$` gli operatori. La **lingua si deduce dal testo dell'istruzione**, non dal DBMS (`motoreDalTesto`): su MongoDB si scrive SQL — tradotto da `SqlToMql` — e lì dopo `FROM` servono i nomi delle collezioni; in uno script ogni istruzione fra `;` ha la sua lingua. Il tipo di connessione e il selettore del motore restano solo il ripiego finché il testo tace, e in quel caso su MongoDB si propongono anche gli inizi SQL. **I vocabolari del dialetto** (`sql-dialetti.js`) aggiungono a quelli comuni le funzioni, le clausole e i tipi di colonna del motore in uso — `GROUP_CONCAT`/`ON DUPLICATE KEY UPDATE` su MySQL, `STRING_AGG`/`RETURNING` su PostgreSQL — e su MongoDB via SQL limitano le funzioni ai soli aggregati che `SqlToMql` sa tradurre. I tipi si propongono solo dove il DDL li pretende (`CREATE TABLE`, `ALTER TABLE … ADD`); senza un motore riconosciuto il dialetto è vuoto e resta il completamento comune. **I nomi vengono scritti già quotati quando il motore lo richiede** (`quotaIdentificatore`): su PostgreSQL un identificatore non quotato viene abbassato, quindi `FROM diego.Prova` cerca `diego.prova` — il completamento, il doppio clic e il trascinamento dello Schema Browser inseriscono `diego."Prova"`. Su MySQL e MongoDB si usa il backtick (in SQL→MQL le `"…"` sono stringhe, non identificatori) e solo quando serve davvero. Dopo `FROM`/`JOIN` il punto separa lo **schema** dalla tabella, non l'alias dalla colonna. Lo strato puro `intellisense.js` legge il contesto e ordina i candidati; `autocomplete.js` tiene il dropdown (posizionato al cursore nell'editor ⚡, Ctrl+Spazio per aprirlo a richiesta) e la **cache dello schema** per (connessione, database), riempita con `db:schema` e invalidata da ogni DDL e da `schema:changed`.
* **JSON/BSON: valida, formatta, minifica (`json-bson.js` / `json-lint.js`)**: parser tollerante alla sintassi della shell (chiavi nude, apici singoli, `ObjectId(...)`, regex, commenti) che riemette i token **alla lettera** — per questo formattare non arrotonda un intero oltre i 53 bit, come farebbe `JSON.parse`. Il linting compare mentre si scrive, con riga e colonna cliccabili, nell'editor ⚡ (solo se il testo è un documento) e nelle modali di inserimento e modifica; Ctrl+Shift+F formatta e Ctrl+Shift+M minifica ovunque.
* **Selezioni & Statistiche Excel (`cellselect.js` / `cell-stats.js`)**: Copia/incolla multi-formato (TSV, CSV, JSON, SQL) e pannello statistiche numeriche immediate ($\Sigma$, $\bar{x}$, min, max, mediana, stddev) con compensazione Kahan. **Scorrimento automatico ai bordi (`scorrimento-bordo.js`)**: trascinando la selezione fino al bordo della `.grid-wrap` (o oltre, fuori dalla griglia) il contenitore scorre da solo e la selezione segue, col mouse e col dito. La posizione del puntatore è tenuta a parte perché `mouseover` non basta: col cursore fermo sul bordo non arriva più nessun evento, ed è lo scorrimento stesso a portare nuove celle sotto al cursore, quindi la cella si rilegge con `elementFromPoint` dentro il ciclo `requestAnimationFrame` (coordinate riportate sotto l'intestazione `sticky`, altrimenti si troverebbe un `th`). La velocità sta nel modulo puro, verificato da `test/unit-scorrimento.js`. **Col dito** valgono tre accorgimenti in più: la fascia sensibile è più larga (72 px contro 40: il polpastrello copre il bordo), il trascinamento scatta solo oltre 10 px di movimento (sotto è ancora una *pressione*, e sulla selezione la pressione lunga è l'unico modo di aprire il menu contestuale), e il puntatore viene catturato esplicitamente sul `tbody` — la cattura implicita del tocco sta sul `td` iniziale, che lo scorrimento fa sparire quando la virtualizzazione rifà la finestra visibile. `test/e2e-tocco-griglia.js` prova in Chromium con eventi touch nativi le assunzioni di piattaforma: scorrere da codice non annulla il puntatore, il gesto sopravvive alla ricostruzione delle righe, e `elementsFromPoint` (al plurale) trova la cella anche sotto un elemento sovrapposto.
* **Duplicazione di righe (`cellselect.js` → `doc:duplicate` → `db/duplica.js`)**: duplicare non è copiare. La chiave primaria collide sempre, le colonne di un indice unico spesso, e una colonna calcolata dal DBMS non si può nemmeno nominare in un `INSERT`: per questo il documento da inserire lo calcola il **server**, che i vincoli li legge dal database, invece di lasciarlo comporre a mano in un editor JSON. Due modalità dal menu contestuale, entrambe **immediate** (nessuna modale): *senza chiavi* rifà la primaria e svuota le altre chiavi — omesse se il DBMS le genera (`AUTO_INCREMENT`, `serial`/identity, ObjectId), `NULL` se la colonna lo consente, altrimenti un valore nuovo; *con chiavi* lascia tutto e cambia **solo** la primaria. Il valore nuovo lo decide `calcolaNuovoValore`: `MAX+1` sui numeri, suffisso `-copia`, `-copia-2`… sul testo (accorciando la BASE, non il suffisso, dentro la lunghezza della colonna), UUID dove il tipo lo è — e in tutti i casi si salta ciò che risulta già occupato. Su una chiave **composta** si rifà solo l'ultima componente: cambiare anche `ordine_id` sposterebbe il duplicato in un altro ordine. Su MongoDB `null` non è una via d'uscita (il campo assente vale null nell'indice unico e collide lo stesso), quindi quei campi ricevono sempre un valore nuovo, e un `_id` numerico resta numerico invece di diventare un ObjectId. Le note del server dicono in un toast che cosa è cambiato; la terza voce, *Duplica e modifica…*, mostra lo stesso documento (`soloAnteprima`) in un editor prima di scriverlo. Lo strato puro è `db/duplica.js`, verificato da `test/unit-duplica.js`.
* **Grafico della selezione (`cellgrafico.js` / `cell-chart.js`)**: Voce 📈 del menu contestuale della griglia (e pulsante nel pannello 📊) che disegna le celle selezionate in una finestra ECharts. Lo strato puro `cell-chart.js` deduce dalla selezione l'asse X (data → categoria → ordinale di riga `#`), una serie per colonna numerica e il raggruppamento — acceso solo se i valori dell'asse si ripetono davvero.
* **Pannello di riferimento delle chiavi esterne (`fk-vista.js` / `fk-relazioni.js`)**: le colonne collegate portano un indicatore in griglia (🔗 vincolo dichiarato, ≈ ipotesi) e, al doppio clic, un pulsante che fa scorrere da destra un pannello con la riga riferita e l'elenco cercabile da cui scegliere un altro valore. Non è una modale: la cella resta in modifica. I dati arrivano da `collection:relations` (FK della sola tabella aperta, mirata — non `db:schema`) e `relation:rows` (righe della tabella riferita, con filtro **parametrizzato** dentro ogni strategia: su SQL il `filter` di `collectionFind` è un frammento WHERE grezzo e non va composto altrove). Lo strato puro `fk-relazioni.js` normalizza i descrittori delle tre sorgenti e sceglie dai dati la colonna-etichetta dell'elenco.
* **Monitor Sessioni (`sessions.js` / `db/sessioni.js`)**: Gestione sessioni DB attive con diagnosi automatica dei lock ("chi blocca chi") ed annullamento/kill sicuro.
* **Temi (`theme.js` / `theme-colori.js` / `tokens.css`)**: Temi chiaro, scuro e personalizzati gestiti via CSS Custom Properties, applicati istantaneamente via script inline per evitare FOUC.

---

## Packaging Desktop & Sicurezza di Rete

* **Electron (`electron-main.js`)**: Avvia il server Node.js in-process su una porta dinamica libera, applica il single-instance lock e memorizza i file utente in `userData`.
* **Aggiornamenti Desktop (`electron-aggiornamenti.js`)**: Integrazione con `electron-updater` per aggiornamenti da GitHub Releases o server HTTP statici HTTPS.
* **Sicurezza di Rete (`server.js`)**:
  * `assertTransportSafe`: Rifiuta l'avvio fuori da `127.0.0.1` se manca un reverse proxy HTTPS (`CODEDB_TRUST_PROXY_TLS=1`).
  * `assertAuthSafe`: Rifiuta l'avvio di rete con RBAC disattivato (`CODEDB_RBAC=off`), a meno di override esplicito via `CODEDB_ALLOW_UNAUTHENTICATED_NETWORK=1`.

---

## Convenzione EJSON e Lingua

* **Extended JSON (EJSON)**: Tutti i documenti viaggiano come EJSON tra client e server (`$oid`, `$date`, `$numberLong`, `$numberDecimal`). I tipi nativi BSON o SQL vengono preservati durante la serializzazione/deserializzazione.
* **Lingua**: Tutti i testi della UI, le descrizioni dei comandi, i commenti nel codice ed i messaggi d'errore devono essere mantenuti in **italiano**.

---

## Agent skills

### Tracciamento delle issue

Le issue vivono come file markdown sotto `.scratch/<funzionalita>/` in questo repo. Vedi `docs/agents/issue-tracker.md`.

### Etichette di triage

Vocabolario predefinito: i cinque ruoli canonici, con l'etichetta uguale al nome del ruolo. Vedi `docs/agents/triage-labels.md`.

### Documenti di dominio

Layout a contesto singolo (`CONTEXT.md` + `docs/adr/` alla radice). Vedi `docs/agents/domain.md`.
