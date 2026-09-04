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
node test/unit-tetto-tempo.js # Test tetto di tempo sulla query libera (lettura E scrittura, SQL)
node test/unit-payload-esecuzione.js # Test campi riservati al server nel payload di query:execute
node test/unit-sql-tabellare.js # Test del tabellare comune ai due motori SQL (_id, ORDER BY, SELECT)
node test/unit-sql-metadati.js # Test dei metadati comuni ai due motori SQL (chiave, colonne, indici, conteggio)
node test/e2e-tetto-scrittura.js # Test che il tetto MORDA su un server vero (MySQL/PostgreSQL)
node test/unit-script-results.js # Test deposito su file dei risultati di uno script
node test/e2e-tocco-griglia.js# Test gesto tattile + scorrimento automatico (Chromium, eventi touch nativi)
node test/e2e-avvio-ui.js     # Test che la UI si carichi senza errori JS (catena degli init*)
node test/unit-identificatori.js # Test della regola unica per quotare gli identificatori
node test/unit-tetti.js       # Test dei tetti imposti dalla giuntura (adattatore finto)
node test/unit-tabella-autorizzazioni.js # Test che la tabella del Proxy copra tutti i metodi
node test/unit-divieto-server-js.js # Test del divieto del JavaScript lato server MongoDB
node test/unit-trasporto.js   # Test del trasporto del frontend (socket finto)
node test/unit-griglia.js     # Test del modulo unico della griglia (finestra virtuale)
node test/unit-ordinamento-strategia.js # Test del punto di estensione dell'ordinamento
node test/unit-giuntura-socket.js # Test degli handler socket invocati con un contesto finto
node test/unit-osservazione-giuntura.js # Test dei quattro eventi di osservazione
node test/unit-giuntura-amministrativa.js # Test della giuntura amministrativa e del suo audit
node test/unit-operazioni-lunghe.js # Test degli otto punti di estensione delle operazioni lunghe
node test/unit-registrazione-eventi.js # Test che ogni evento socket stia in UNA famiglia
node test/unit-filtro.js      # Test del filtro strutturato nei tre dialetti
node test/unit-filtro-rapido.js # Test del filtro rapido della griglia
node test/unit-filtro-autorizzazione.js # Test che uscire dallo scope non sia esprimibile
node test/e2e-griglia-viste.js # Test della griglia nelle viste reali (Chromium)
node test/e2e-pagine-obsolete.js # Test che una risposta obsoleta non tocchi righe, pagina, conteggio o caricamento (Chromium)
node test/e2e-filtro-rapido-ui.js # Test del filtro rapido nel browser
node test/e2e-filtro-strutturato.js # Test del filtro strutturato sui tre motori
node test/e2e-nulli-ordinati.js # Test che i valori nulli si ordinino uguale sui tre motori
node test/e2e-osservazione.js # Test dell'osservazione da capo a fondo (MongoDB)
node test/unit-palette-ricerca.js # Test della ricerca della palette (punteggio e ordine)
node test/e2e-palette.js      # Test della palette Ctrl+P: virtualizzazione e ricerca (Chromium, senza DB)
node test/e2e-selezione-celle-viste.js # Test della selezione di celle in piu' griglie indipendenti (Chromium)
node test/e2e-incolla-esatto-atomico.js # Test che l'incolla di celle sia esatto (numeri, fusi) e atomico (Chromium)
node test/e2e-fk-viste.js     # Test del pannello 🔗 aperto da piu' griglie (Chromium)
node test/e2e-geometrie-viste.js # Test delle celle geometriche in ogni griglia (Chromium)
node test/unit-geo-editor.js   # Test del sottotipo geometrico dichiarato dalla colonna
node test/unit-geo-modifica.js # Test delle operazioni dei bottoni azione sulla mappa
node test/e2e-editor-geometrico.js # Test dell'editor su mappa: tipo dichiarato e multipart (Chromium)
node test/unit-artefatti.js    # Test del confine di fiducia: bersaglio effettivo delle DDL
node test/unit-piano-import.js # Test del piano immutabile e delle fasi dell'orchestratore
node test/unit-import-adapter.js # Test dell'adapter reale (identita' e righe prima delle mutazioni)
node test/unit-schema-objects.js # Test dell'inventario canonico degli oggetti di schema
node test/unit-upsert-identitario.js # Test dell'upsert SQL sull'identita' dichiarata
node test/unit-drop-fail-closed.js # Test che un drop ignori solo l'assenza della risorsa
node test/unit-import-uploads.js # Test di TTL, quote e isolamento dei caricamenti
node test/unit-operazione-import.js # Test del registro dell'operazione lunga di import
node test/unit-evento-import.js # Test dell'evento reale di import (socket e contesto finti)
node test/unit-import-status.js # Test della presentazione dei tre esiti terminali
node test/unit-e2e-targets.js  # Test delle barriere sui bersagli distruttivi dell'harness
node test/unit-grafo-comandi.js # Test delle regole della barra del Grafo 3D (tabella vuota, comandi abilitati, esito ricerca)
node test/e2e-barra-grafo.js   # Test del cablaggio della barra del Grafo 3D (Chromium, senza DB)
node test/e2e-integrita-import.js # Matrice reale di integrita' su MongoDB, MySQL e PostgreSQL

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
* **Il tabellare comune ai due motori SQL (`db/sqlTabellare.js`)**: l'`_id` virtuale di una riga, la sua rilettura in clausola WHERE, l'`ORDER BY` e i pezzi della SELECT (filtro, limite, salto) non hanno nulla di MySQL né di PostgreSQL — la griglia è una sola. Vivevano però in **due copie byte per byte identiche** dentro i due adattatori, messaggio d'errore e costanti comprese: correggerne una lasciava l'altra intatta senza che nulla lo segnalasse. Ciò che cambia davvero fra i due motori è solo il **dialetto** (quotatura, qualificazione della tabella, `<=>` con `?` contro `IS NULL`/`=` con `$n`), e resta dell'adattatore, passato a `tabellare()`. Sono funzioni pure: `test/unit-sql-tabellare.js` le prova senza alcun database, e con un controllo sul testo dei due adattatori — due copie identiche si comportano identicamente, quindi un test di solo comportamento passerebbe anche con le copie ancora al loro posto. Lo stesso vale per la conversione **EJSON ↔ parametri SQL** (`db/sqlValori.js`, quattro funzioni anch'esse identiche): è il protocollo del client, non il dialetto del server. Fuori restano le geometrie, dove il formato nativo di PostgreSQL non ha corrispettivo su MySQL.
* **I metadati comuni ai due motori SQL (`db/sqlMetadati.js`)**: gli altri metodi che i due adattatori implementavano con lo stesso nome — paginazione a chiave, informazioni sulle colonne, elenco dei campi, indici unici, chiave primaria, stima delle righe e conteggio — non erano copie identiche come quelle del tabellare: divergevano su dettagli di **dialetto**. La decisione però era la stessa e stava scritta due volte, e l'ultima prova che non fossero gemelli era che `estimatedRowCount` prendeva `(db, coll)` su un motore e `(coll, db)` sull'altro — due significati opposti per la stessa posizione, che nessun test poteva vedere perché il metodo non è chiamato da fuori. Ora la logica sta nel modulo e ogni adattatore **dichiara** il suo dialetto: le query al catalogo, come se ne leggono le righe (`autoIncrement` da `EXTRA` contro `nextval`/`is_identity`), il segnaposto (`?` contro `$n` numerato), le **classi** di tipo con cui si riconoscono le colonne geometriche (su PostgreSQL PostGIS e tipi nativi sono due classi valutate in ordine). Un ramo `if (motore === 'mysql')` nel corpo sarebbe stata la stessa duplicazione, solo spostata. `installaMetadati` li definisce sul prototipo **non enumerabili**, come sono i metodi di una classe (un `Object.assign` avrebbe fatto comparire nove nomi in ogni `for...in` su una strategia): l'interfaccia degli adattatori si è accorciata senza che nulla cambi per i chiamanti. `test/unit-sql-metadati.js` li prova **senza database** mettendo un pool finto al posto di quello vero: sono i dialetti veri, non due dialetti finti scritti nel test.
* **I valori nulli si ordinano allo stesso modo sui tre motori**: lo stesso clic
  sulla stessa intestazione dava tre ordini diversi — misurato su motori veri,
  `ORDER BY nome` con un NULL fra due valori: MySQL e MongoDB mettono il nullo
  per primo in salita, PostgreSQL per ultimo. La differenza non e' marginale:
  e' la posizione di TUTTE le righe con quel campo vuoto. **La regola di CodeDB
  e' che il valore nullo e' il piu' piccolo**, e sta nel modulo comune perche'
  e' una proprieta' della griglia e non di un motore; cio' che cambia e' solo
  come ciascun dialetto la SCRIVE (`nulliPrima`): un suffisso esplicito su
  PostgreSQL, niente su MySQL dove il predefinito gia' coincide — cosa che
  `test/e2e-nulli-ordinati.js` PROVA contro un MySQL vero invece di assumerla.
  Su una colonna NOT NULL il suffisso viene **omesso**: non e' solo inutile, e'
  dannoso — PostgreSQL non riconosce che l'operazione e' nulla e passa da Index
  Scan a Seq Scan + Sort. Vale solo per l'ordinamento STRUTTURATO: l'SQL libero
  scritto a mano non viene mai riscritto.

* **Paginazione e Conteggio**: `collection:find` supporta `deferCount: true`. Il conteggio viene richiesto a parte con `collection:count` soggetto a timeout (`CODEDB_COUNT_TIMEOUT_MS`, default 5000ms) per evitare blocchi su tabelle enormi. Budget di byte sui risultati (`CODEDB_MAX_RESULT_BYTES`, default 32 MB).
* **Tetto di tempo sulla query libera**: `collectionAggregate` è la porta unica della tab ⚡ su SQL — ci passano sia le letture sia le scritture — e il tetto vale su **entrambi i rami**, da `DbStrategy.aggregateTimeoutMs()` (`CODEDB_AGGREGATE_TIMEOUT_MS`, default 120000; `<= 0` disattiva). Prima il limite stava solo dentro il ramo di sola lettura, come costante `30000` scritta nel corpo del metodo: un `UPDATE` sbagliato teneva una connessione del pool senza limite, e `cancelQuery` lo raggiunge solo se il client ha mandato un `runId` e l'utente del DB ha il privilegio per uccidere. Su PostgreSQL è `statement_timeout` (`SET LOCAL` in transazione, `SET` + `RESET` fuori: un `SET` non riazzerato lo eredita chi prende quel client dal pool). Su MySQL è il `timeout` per-query di mysql2, che però è **lato client**: allo scadere il driver smette di aspettare ma il server continua, quindi la strategia manda `KILL QUERY` da una seconda connessione e **distrugge** quella avvelenata invece di restituirla al pool con un result set arretrato in arrivo. Interrompere è sicuro perché su entrambi i motori l'istruzione annullata fa rollback: è la ragione per cui su MongoDB le pipeline `$out`/`$merge` restano invece **escluse** dal tetto — lì fermarsi a metà lascerebbe la destinazione scritta a metà.

* **La regola unica per scrivere un identificatore (`public/js/identificatori.mjs`, ponte `db/identificatori.js`)**: se un nome vada quotato e come si raddoppia l'apice che contiene era una decisione presa in **sette** punti diversi, e uno solo sapeva rispondere alla prima domanda — gli altri quotavano sempre o mai. È la classe di difetto per cui su PostgreSQL un nome con maiuscole scritto nudo viene abbassato dal motore e la tabella `Prova` non si trova più. Il modulo è `.mjs` per un motivo preciso: è l'unico del repo che serve **da tutte e due le parti** — il browser lo importa, il server (CommonJS) lo raggiunge con `require()`, cosa che Node concede solo a un file dichiaratamente ESM. Distingue `quotaIdentificatore` (quota **se serve** — la via di chi scrive nell'editor dell'utente) da `quotaSempre` (quota comunque — la via di chi compone SQL che l'utente non legge), e su un motore sconosciuto la seconda **lancia** invece di tirare a caso.

* **I tetti imposti dalla giuntura (`db/tetti.js`)**: righe, byte e tempo non sono più funzioni che ogni adattatore può ricordarsi o dimenticarsi di chiamare. `DbFactory.getStrategy` restituisce la strategia già **avvolta**, quindi un motore aggiunto in futuro nasce limitato senza doversene ricordare. L'applicazione era a macchia: il budget di byte valeva sulla `collectionFind` di tutti e tre i motori ma **non** sulla `collectionAggregate` dei due motori SQL — cioè dove arrivano i risultati grossi. Righe e byte si applicano al risultato e **dichiarano** il troncamento; il tempo no, perché arriva dopo: la giuntura tiene un cane da guardia con un margine di grazia sopra al tetto vero, così il messaggio preciso del motore vince su quello generico, e interviene solo quando il meccanismo per motore non c'è o non ha funzionato. All'adattatore resta il solo pezzo che varia: come si ferma una query, e `fuoriDalTettoDiTempo` per dichiarare che una certa esecuzione **non va fermata** (le pipeline `$out`/`$merge` su MongoDB, che a metà lascerebbero la destinazione scritta a metà).

* **Il filtro come DATO (`db/filtro.js`)**: lo stesso parametro `filter` significava tre cose a seconda del motore — un frammento di clausola SQL grezzo, un documento MQL — e ogni chiamante doveva sapere in anticipo chi avrebbe risposto. Il filtro strutturato è `{ condizioni: [{ campo, operatore, valore }], unione }` con undici operatori, e ogni motore lo rende nel proprio dialetto **parametrizzando**. Il valore non attraversa mai il testo della query: è questa, e non un elenco di caratteri vietati, la ragione per cui un valore ostile non può cambiare la struttura di ciò che viene eseguito — e su MongoDB l'equivalente è che il valore resta sempre in posizione di *valore*, mai di operatore. Un `campo` con un segmento vuoto o che comincia per `$` è **rifiutato**: su MongoDB diventerebbe un operatore. Il filtro testuale convive, ed è la modalità «condizione» della griglia.

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

### 4-bis. Le tre giunture degli eventi socket

Gli ottanta eventi socket non passano da una giuntura sola, e la decisione è
registrata in `docs/adr/0001-tre-famiglie-di-evento.md`: forzarli in un'unica
giuntura la renderebbe **superficiale** — un'interfaccia piena di parametri
opzionali e di rami, complessa quanto ciò che nasconde.

* **Il contesto della sessione è un ARGOMENTO** (`registraEventi(ctx)`, con
  `creaContestoSocket`). Prima viveva dentro una chiusura anonima di
  duemiladuecento righe, e non esisteva alcun punto in cui sostituirlo: i test
  di `server.js` erano ridotti a leggerlo come testo bilanciando le graffe con
  un'espressione regolare. Ora un handler si invoca con un socket finto, sessioni
  finte e un principal finto (`test/contesto-finto.js`), senza rete e senza
  database. `safeOn` passa il contesto agli handler come terzo argomento.
* **`delegate`** — 36 eventi sui DATI: spoglio dei campi riservati al server,
  classificazione per l'audit, verifica della capability, riferimento di
  annullamento, riconnessione automatica, contesto sull'errore.
* **`amministrativo`** — 26 eventi che non toccano alcuna strategia. Scrive la
  voce di audit al posto loro, da una tabella (`EVENTI_AMMINISTRATIVI`) in cui
  ogni evento dichiara la propria etichetta **oppure** il motivo per cui non è
  tracciato. Un evento non dichiarato **non si registra affatto**, e l'errore
  arriva all'avvio: prima quindici handler componevano l'audit a mano, riga per
  riga, e scritto a mano vuol dire dimenticabile.
* **`operazioneLunga`** — 8 eventi, ciascuno con i suoi **punti di estensione**
  dichiarati fra gli otto di `PUNTI_ESTENSIONE`. Non aggiunge comportamento:
  dichiara. Un'operazione che non ne usa nessuno non appartiene alla famiglia, e
  la giuntura la rifiuta dicendo dove spostarla — è l'unica cosa che impedisce a
  questa famiglia di diventare il cassetto dove finisce ciò che non si sa dove
  mettere.
* **`safeOn`** — 10 eventi, tutti dichiarati in `ECCEZIONI_VIA_GENERICA` con il
  loro motivo: tre aprono o chiudono la sessione che le altre giunture
  presuppongono, tre verificano una capability senza bersaglio, quattro sono
  backup che accedono al driver nativo.

`test/unit-registrazione-eventi.js` confronta le quattro vie con ciò che
`server.js` registra davvero: un evento fuori posto, dichiarato in due famiglie,
o un evento amministrativo che tocca una strategia fanno fallire il test — con
un messaggio che dice **cosa fare**, non solo che qualcosa non torna.

### 5. Engine di Esecuzione Query & Script
* **`ScriptRunner.js`**: Esegue script SQL/Mongo istruzione per istruzione con supporto a pausa, ripresa, stop su errore e avanzamento tramite push socket (`script:progress`). **Risultati per istruzione**: uno script produce un result set per istruzione e l'utente vuole rivederli tutti, ma tenerli in RAM significherebbe cinquecento result set per run e spedirli tutti insieme a chi ne guarderà uno. Ogni result set finisce quindi **su file** (`db/ScriptResults.js`, cartella temporanea, permessi 0600, id `<10 caratteri di base64url del testo>-<timestamp>`); in memoria resta un indice leggero che viaggia con gli eventi terminali, e il browser chiede il contenuto di una scheda con `script:result` **quando la apre**. Tetti espliciti su numero (primi 50: le linguette non devono spostarsi sotto gli occhi) e byte, con gli scartati **dichiarati**. I file muoiono con il run, con il socket e con una passata all'avvio — un arresto anomalo non esegue nessuna pulizia e lì dentro ci sono righe di database. Sono schede **solo i result set veri** (`resultSet`, dichiarato dalle strategie): i riepiloghi di scrittura resterebbero cinquanta linguette «1 riga coinvolta» che tolgono il posto alla SELECT che si voleva rivedere. Lo stesso flag risolve il difetto per cui un `SELECT` con **zero righe** veniva scambiato per «nessun risultato» e la griglia mostrava l'istruzione precedente — il messaggio di una `USE` al posto della query appena scritta.
* **Il payload dell'esecuzione (`db/payloadEsecuzione.js`)**: `executeQueryCode` riceve un oggetto solo, ma le sue chiavi hanno due origini. Codice, motore, database e collezione li propone chi manda la richiesta; il riferimento di annullamento (`opHandle`) e il **registro dell'esecuzione** (`run`) sono strutture vive del server — sul secondo le scritture lasciano il segno da cui `finalizzaScript` ricava la categoria con cui l'operazione finisce nell'audit. Il gestore componeva `{ ...payload, runId, opHandle }`: `opHandle` era neutralizzato solo perché scritto **dopo** lo spread — un accidente d'ordine, che riordinare le chiavi avrebbe riaperto — e `run` non compariva affatto in quel letterale, quindi arrivava intatto dal client e veniva adottato come registro. Ora l'elenco dei campi imposti dal server sta in un posto solo, la rimozione è una regola dichiarata (indifferente all'ordine) e il payload viene **marcato**: `executeQueryCode` rifiuta ciò che non è passato di lì, così ricomporlo a mano in un chiamante nuovo non produce un varco silenzioso ma un errore immediato. La stessa regola vale sulla giuntura `delegate`, dove il residuo era l'altra metà dello stesso accidente: l'`opHandle` del server veniva imposto solo **dentro** il ramo `if (runId)`, quindi una richiesta senza `runId` portava fino alla strategia quello del client.
* **`MongoScript.js`**: Interprete AST JS/mongosh sicuro (senza `eval`/`new Function`) con quote di passi, ricorsione e tempo.
* **`MongoShell.js`**: Parser della sintassi shell nativa `db.<coll>.find(...)`.
* **`SqlToMql.js`**: Traduttore da SQL `SELECT` (con `JOIN`, `GROUP BY`, `HAVING`, `UNION`, sottoquery) e DDL a pipeline e comandi MongoDB.
* **`VirtualJoinEngine.js`**: Motore per Virtual JOIN Cross-DB in memoria tra SQL e MongoDB.

### 6. Geometrie su Mappa
* **GeoJSON Standard**: Formato unico usato per tutti i DBMS (`ST_AsGeoJSON` e `ST_GeomFromGeoJSON` su SQL).
* Editor Leaflet 1.9.4 integrato (vendorizzato), ottimizzazione del trascinamento vertici via Canvas a doppio layer (`geomap.js`), ed analisi statistica/cartografica delle selezioni geometriche (`geo-stats.js`, `geomulti.js`).
* **Vista mappa condivisa (`geo-vista.js`)**: motore riusabile (disegno, elenco cliccabile, riepilogo, avvisi, tetti di disegno, export GeoJSON) usato sia dalla modale della selezione di celle sia dalla scheda 🗺 Mappa dei risultati della tab ⚡. Ogni istanza è indipendente: le due viste possono coesistere nella stessa pagina.
* **Una coordinata è un numero JSON, non un oggetto BSON**: salvare una geometria
  disegnata sulla mappa falliva su **entrambi** i motori SQL con «Colonna "x": le coordinate
  devono essere numeri finiti», e il messaggio era esatto — le coordinate davvero non erano
  numeri. I valori in scrittura passano da `deserializeClientObject`, cioè
  `EJSON.deserialize(…, { relaxed: false })`, che trasforma OGNI numero in un oggetto BSON
  (`Double`, `Int32`, `Long`, `Decimal128`). Per le colonne esatte quella cura è il motivo
  per cui esiste — è ciò che tiene un DECIMAL o un BIGINT senza farlo passare da un double —
  ma una geometria non è un documento BSON: viene consegnata al DBMS come **testo**
  (`ST_GeomFromGeoJSON`), e `typeof coordinata === 'number'` era falso per tutte.
  `assertGeoJson` **normalizza e restituisce** ora la forma canonica (`normalizzaGeoJson` in
  `db/geometry.js`), e i due adattatori serializzano ciò che hanno **validato** invece
  dell'originale: serializzare l'originale avrebbe rimesso `{"low":…,"high":…}` dentro il
  GeoJSON per un `Long`. Non è una tolleranza sul formato — una coordinata testuale o `NaN`
  resta rifiutata con lo stesso messaggio. La normalizzazione sta dentro la validazione, e
  non nei chiamanti, perché ogni via di scrittura (inserimento, aggiornamento, import, e la
  forma grezza del driver MySQL recuperata da `daFormaDriverMysql`) passa comunque di lì.
* **Prendere un vertice non richiede la mira**: una maniglia è un cerchio di sette pixel, e
  Leaflet la considera premuta solo entro il raggio più metà del contorno — **misurato: una
  decina di pixel**. Peggio, un clic appena fuori non faceva NULLA: nessuna selezione,
  nessun messaggio, cioè il vertice sembrava non rispondere. Tre cose insieme: il renderer
  delle maniglie ha una `tolerance` (10 px, 20 col dito) che allarga il bersaglio senza
  ingrandire il cerchietto; il clic sulla mappa in modalità **Modifica** si **aggancia** al
  vertice più vicino entro 22 px (34 col dito) invece di azzerare la scelta; e il cursore
  diventa una mano sopra una maniglia, perché senza quel segnale una maniglia è
  indistinguibile da un disegno. Misurato di nuovo dopo: si prende un vertice fino a **22 px**
  dal centro, e oltre il raggio la scelta si azzera — l'aggancio ha un limite, non è «il più
  vicino comunque». Quale vertice vinca è una regola pura (`verticePiuVicino` in
  `geo-modifica.js`, con la parità risolta sul primo perché il capo e la chiusura di un
  anello stanno nello stesso punto); le posizioni sullo schermo le sa solo la mappa.
* **La mappa è il documento, gli strumenti le stanno sopra**: i comandi vivevano in due
  barre di testo sopra la mappa — due righe intere di finestra — mentre la mappa, che è ciò
  che si sta modificando, ne aveva poco più di metà. Ora c'è **una** barra con le scelte che
  riguardano l'intera geometria (tipo, modalità del clic, pannelli) e due gruppi
  **flottanti** sulla mappa, come in ogni editor cartografico: la colonna a destra per la
  forma (annulla, rifai, parti, ridisegna, inquadra) e la barra in basso per il **vertice
  scelto**, che è dove l'occhio sta già guardando. Il fondo di quei gruppi è **pieno** e non
  translucido: sopra le tile chiare di OpenStreetMap un velo all'86% di bianco è
  indistinguibile dalla mappa, cioè i comandi sparivano proprio nel tema in cui la mappa è
  più luminosa. Il pannello **GeoJSON resta accanto alla mappa** — le due viste sono la
  stessa geometria e tenerle affiancate è il senso dell'editor — ma non più a metà finestra,
  e un interruttore lo chiude quando serve tutta la mappa (Leaflet deve rileggere le
  dimensioni con `invalidateSize`, altrimenti resta disegnato sulla larghezza di prima).
  La **modalità del clic** è un controllo segmentato «Disegna | Modifica» invece di un
  bottone che cambia etichetta: con un bottone solo non si capisce se l'etichetta descriva
  lo stato di adesso o quello che si otterrebbe premendolo, e lo stato vive in
  `aria-pressed`, cioè nella proprietà che lo dichiara anche a chi non vede il colore. Le
  icone sono un **unico sprite SVG** (`<symbol>` + `<use>`): tracciate, non caratteri
  tipografici che cambiano forma da un sistema all'altro. I bersagli crescono a 44 px sotto
  `pointer: coarse`, il fuoco da tastiera si vede anche sopra la mappa, e le transizioni
  spariscono con `prefers-reduced-motion`.
  Scegliere un vertice **non** è una modifica: l'istantanea per l'annullamento si prende
  alla pressione ma si registra al primo movimento vero, altrimenti premere un vertice per
  sceglierlo lasciava un passo nella storia e «Annulla» andava premuto quattro volte per
  disfarne una sola.
* **I gesti dell'editor su mappa sono BOTTONI (`geo-modifica.js`)**: modificare una
  geometria esistente si faceva con tre gesti che non si vedevano da nessuna parte — clic
  per aggiungere, trascinamento per spostare, **tasto destro** per eliminare — e con due
  operazioni che semplicemente non c'erano: infilare un vertice in mezzo a un lato e tornare
  indietro. Il clic aggiungeva sempre in coda all'anello, quindi correggere il lato fra il
  terzo e il quarto vertice di un poligono voleva dire rifare la forma o riscrivere il JSON;
  e il tasto destro non esiste su un touch. Ora la barra sotto al tipo ha `↶ Annulla` /
  `↷ Rifai`, `＋ Vertice dopo` (a metà del lato successivo, o **prolungando** il tratto se il
  vertice scelto è l'ultimo di una linea aperta), `🗑 Vertice`, `🗑 Parte`, e un bottone di
  **modalità** che dichiara che cosa farà il prossimo clic sulla mappa. Un bottone
  disattivato dice *prima* del clic che quel gesto qui non ha senso, e il `title` dice
  perché. Premere una maniglia la SELEZIONA e insieme comincia il trascinamento: i bottoni
  agiscono sul vertice scelto, che è dipinto diverso — un comando che agisce su qualcosa di
  invisibile non è un comando.
  La modalità del clic **dipende da cosa si sta facendo**: una geometria nuova si disegna
  (il clic aggiunge), una che esiste già si corregge (il clic sceglie soltanto), perché
  aprire in «aggiungi» una geometria esistente significava che il primo clic sulla mappa —
  spesso solo per portare a fuoco la finestra — le attaccava un vertice in coda.
  L'annullamento copre ogni modifica, **trascinamento e JSON scritto a mano compresi**: è la
  sola ragione per cui un gesto sbagliato non costa più il disegno.
  Le REGOLE stanno in `geo-modifica.js`, pure: dove entra un vertice nuovo, quando un anello
  va richiuso, quale operazione va **rifiutata** e con quale motivo (una parte al minimo dei
  vertici si elimina intera, l'ultima parte non si elimina affatto). Non mutano la geometria
  ricevuta — è ciò che rende possibile l'annullamento — e restituiscono l'errore come
  **dato**, già scritto in italiano, invece di lanciarlo. `test/unit-geo-modifica.js` le
  prova senza browser; `test/e2e-editor-geometrico.js` prova in Chromium che i bottoni siano
  davvero collegati a quelle regole, e la sensibilità di entrambi è stata verificata
  rompendo di proposito la chiusura dell'anello, la registrazione della storia, il
  collegamento del bottone «Vertice dopo» e la modalità iniziale del clic.
* **L'editor su mappa apre sul tipo che la colonna DICHIARA**: la forma di partenza era
  sempre un `Point`, e le geometrie multipart (`MultiPoint` a parte) non si potevano nemmeno
  disegnare — `MODIFICABILI` le escludeva, quindi su una colonna `MULTIPOLYGON` l'unica via
  era scrivere il GeoJSON a mano nella casella accanto alla mappa. Il sottotipo però è già
  scritto nel catalogo, e i due motori SQL lo tengono in **due posti diversi**: MySQL dentro
  il tipo stesso (`COLUMN_TYPE` = `multipolygon`), PostGIS nelle viste
  `geometry_columns`/`geography_columns`, perché `udt_name` lì dice soltanto `geometry` —
  la lettura del SRID passava già da quelle viste e ora porta con sé anche il tipo
  (`geoType` nel `columnMeta`). `tipoGeoJsonDaTipoColonna` e `tipoGeoJsonDaMetadato`
  (`geojson.js`, puri) sono la regola unica che riconosce entrambe le forme più i typmod
  (`geometry(MultiPolygon,4326)`): il form di inserimento, la modifica in griglia e la
  Split-View passano di lì, e `insert.js` non tiene più un elenco parallelo di nomi che i
  tipi con modificatore non conteneva. Un tipo **generico** (`geometry`, `geography`,
  `geojson`) non autorizza a indovinare una forma e resta su `Point`.
  Tutti i tipi basati su `coordinates` sono ora modificabili con le maniglie: la parte
  attiva di una geometria multipart è quella toccata per ultima o l'ultima creata,
  «＋ Nuovo poligono/linea» ne apre un'altra e «↺ Ridisegna» svuota la forma conservando il
  tipo. `GeometryCollection` resta volutamente fuori (componenti eterogenei: servirebbe un
  secondo editor gerarchico) e si vede sulla mappa modificandosi dal JSON. Il salvataggio è
  **fail-closed**: una parte con troppi pochi vertici o un anello non chiuso fermano
  «Applica geometria» con il motivo, invece di mandare al database una geometria che il
  motore rifiuterà. Una cella **vuota** di una colonna geometrica apre la mappa come una
  piena: prima la decisione dipendeva dal solo valore, quindi la PRIMA geometria di una riga
  era l'unica che si dovesse scrivere a mano in GeoJSON — cioè proprio quando la mappa serve
  di più. `test/unit-geo-editor.js` prova la regola pura, `test/e2e-editor-geometrico.js` la
  prova in Chromium disegnando con clic veri sulla mappa: entrambe le prove sono state
  verificate rompendo di proposito l'autoselezione e la scelta della parte attiva.
* **La cella geometrica in ogni griglia (`cella-geometria.js`)**: riconoscere una geometria in una cella, darle etichetta, classe `type-geo`, aiuto e doppio clic era scritto **nella sola vista Dati**: in un riquadro della Split-View la stessa colonna mostrava il JSON grezzo e non si apriva su mappa. `rendiCellaGeometrica` è ora la resa comune alle tre griglie, e la capacità `geometrie` di un riquadro è **accesa** e dichiarata. Che cosa significhi «aprire» non è però una proprietà della vista ma della **cella**: una riga senza `_id` — una vista SQL, un result set — non è riscrivibile, e aprirle l'editor con «Applica geometria» prometteva un `doc:update` senza bersaglio, cioè un errore restituito dopo che l'utente aveva finito di disegnare. `aperturaCella` tiene quella decisione in un posto solo e ogni griglia dichiara nei propri termini quando una cella è modificabile (`col !== '_id'` e identità della riga in Dati, più il permesso di selezione in un riquadro); `aperturaSolaLettura` è la via della tab ⚡, dove non c'è nulla da riscrivere. Provato da `test/e2e-geometrie-viste.js` in Chromium con un socket finto: la resa si controlla sul `td` e non su un discendente, perché `displayValue` marca già `type-geo` sullo span di **ripiego** — cercare la classe ovunque avrebbe fatto passare il test anche a capacità spenta.

### 7. Gateway MCP (`mcp/McpGateway.js`)
* Implementa il **Model Context Protocol** per client AI (Claude Code, Cursor, ecc.) via Streamable HTTP (`/mcp`).
* Protegibile da API Key (`Authorization: Bearer cdb_...`) sotto RBAC.
* Offre tool di esplorazione, schema audit, analisi PII/GDPR, ricerca BFS, ed esecuzione query/scritture sicure (`execute_write` con `confirm_token`).

### 8. CLI e Motore di Backup (`backup/`)
* Backup Full, Incrementale e Differenziale con manifest JSON e checksum SHA-256.
* Supporto storage cloud opzionale (S3, GCS, Azure) via `backup/lib/storage.js`.
* Isolamento multi-tenant dei backup (`BACKUP_ROOT/tenants/<ownerId>`).
* Validazione di sicurezza delle DDL in ripristino (`assertSafeSchemaSql`).
* **Manifest v2: l'identità stabile è dichiarata**: un timestamp seleziona le righe
  cambiate ma non dice *quale* riga è. Senza una regola scritta, un layer incrementale
  riapplicato duplicava righe e la verifica numerica — che sommava le scritture — non se
  ne accorgeva. Il manifest v2 dichiara identità, schema delle colonne e cardinalità della
  sorgente: MongoDB usa `_id`, i motori SQL una chiave primaria o un vincolo univoco
  interamente `NOT NULL`. Una tabella senza identità stabile è ammessa in un full verso una
  destinazione **vuota** e rifiutata come base o layer di una catena incrementale — i
  manifest storici restano quindi ripristinabili come full ma non vengono **promossi** a
  incrementali sicuri. La verifica finale confronta cardinalità e identità **distinte**
  realmente presenti, non la somma delle scritture applicate.

### 8-bis. Il motore unico di applicazione degli artefatti (`db/importPlan.js`)

Import dell'intero database e ripristino di un backup erano due orchestrazioni con regole
diverse, e l'import viveva nel **browser**: una sequenza di drop, create, insert e DDL
mandata una alla volta. Entrambe cominciavano a mutare la destinazione prima di aver
dimostrato che input, piano e strategia fossero sicuri, quindi un errore a metà lasciava
una destinazione parziale e un esito formalmente riuscito. Ora c'è una giuntura sola: chi
entra da UI, CLI o MCP costruisce lo stesso **piano** e passa dallo stesso motore.

* **Il confine di fiducia (`db/artefatti.js`)**: un file `.codedb.json` e i layer di un
  backup contengono DDL libero, e validarne la **forma** JSON non dice nulla sul suo
  **bersaglio**. La presenza testuale del nome atteso non è una prova: un
  `ALTER TABLE clienti` che nomina `ordini` in una colonna passava il controllo. Il modulo
  normalizza l'artefatto, estrae il bersaglio **effettivo** di ogni istruzione e rifiuta
  qualificatori estranei o cross-database prima di ogni mutazione. Integrità (checksum) e
  autenticità sono esposte come proprietà **distinte**: un artefatto con checksum valido
  resta non fidato. Nessuna regex parallela sopravvive negli altri percorsi.
* **Il piano è immutabile e firmato (`creaPianoImport`, `creaPianoRestore`)**: il piano
  è congelato e porta un'impronta SHA-256 del proprio contenuto canonico. Anteprima ed
  esecuzione devono presentare la **stessa** impronta, altrimenti l'esecuzione è rifiutata:
  è ciò che impedisce alla conferma mostrata all'utente di descrivere un'operazione diversa
  da quella che verrà eseguita.
* **L'orchestratore è indipendente dal DBMS (`eseguiPianoImport`)**: dieci fasi osservabili
  in ordine fisso — validazione, destinazione, recupero, staging, applicazione, verifica
  dello staging, promozione, verifica finale, ed eventuale rollback. Fino alla promozione
  ogni scrittura riguarda **soltanto** lo staging, quindi un errore prima di quel punto non
  ricostruisce nulla: il bersaglio è ancora intatto. L'adapter è intenzionalmente piccolo,
  così l'**ordine delle barriere** è provabile con una strategia finta registrante e senza
  alcun database.
* **La promozione dichiara la garanzia reale**: PostgreSQL rinomina gli schemi nella stessa
  transazione (`swap-schema-atomico`), quindi un lettore concorrente vede o il vecchio o il
  nuovo. MongoDB e MySQL non hanno un equivalente e non fingono di averlo
  (`staging-con-recupero`): promuovono da una copia **verificata** e conservano recupero e
  staging fino a un'eliminazione esplicita. Promettere atomicità dove il DBMS non la offre
  sarebbe la falsa riuscita che questa giuntura esiste per togliere.
* **Tre esiti canonici, e nessun falso successo**: `completato`,
  `ripristinato_dopo_errore`, `intervento_richiesto`. Soltanto il primo usa la
  presentazione del successo (`public/js/import-status.js`, seam puro). Un risultato
  parziale non usa mai messaggi o stile di riuscita, e la copia di recupero resta visibile
  con un'azione successiva esplicita per eliminarla.
* **Fail-closed sui drop**: `eliminaSePresente` ignora **esclusivamente** l'errore che
  dimostra l'assenza della risorsa (`NamespaceNotFound`/26 su MongoDB, `42P01` su
  PostgreSQL). Autorizzazione, rete e timeout conservano istanza, codice e bersaglio fino
  all'audit, e un drop fallito impedisce create e insert successivi: un `catch` generico
  mescolava dati vecchi e nuovi dichiarando successo.
* **L'upsert passa dall'identità dichiarata**: MySQL usa
  `INSERT … ON DUPLICATE KEY UPDATE` e non più `REPLACE`, che implementa l'upsert come
  delete più insert e attiva quindi foreign key `ON DELETE CASCADE` e trigger già presenti
  sul database dell'utente. PostgreSQL usa `ON CONFLICT` sull'identità dichiarata e non
  ripiega più su un `INSERT` normale quando la PK manca. L'assenza o la divergenza
  dell'identità ferma il piano **prima della prima riga**.
* **L'inventario degli oggetti di schema (`db/schemaObjects.js`)**: la verifica non
  confronta stringhe di DDL ma definizioni **canoniche** di tabelle, view, routine,
  trigger, indici, chiavi esterne, opzioni MongoDB e valori delle sequenze — altrimenti una
  view mancante o una sequenza arretrata passavano inosservate.
* **L'import è una operazione lunga** (`db/importOperations.js`, `db/importUploads.js`),
  nella terza famiglia di ADR-0001: ack immediato, id stabile, avanzamento, annullamento
  cooperativo, audit e stato interrogabile. La sessione ha un **lease** che sopravvive alla
  chiusura del tab, quindi chiudere la vista non classifica come fallita un'operazione
  ancora viva e non produce retry; `database:import:list` permette alla UI riaperta di
  ritrovare l'operazione invece di rilanciarla. I file oltre i 5 MB salgono a **blocchi e
  senza effetti**: i caricamenti hanno TTL, quota globale, quota per owner e limite di
  concorrenza, sono legati al soggetto autenticato e non al solo tenant, e lo stato
  pubblico non espone i percorsi assoluti delle copie di recupero.
* **Una collection VUOTA sopravvive al ripristino**: su MongoDB una collection nasce alla
  prima scrittura, quindi una collection vuota nel backup non ne produceva nessuna nella
  destinazione — spariva, e il conteggio tornava lo stesso (zero attese contro zero
  presenti in una collection inesistente), cioè un `completato` che aveva perso una
  collection. Il manifest la dichiara: il ripristino la **materializza**, come il motore
  del piano fa già per l'import. La barriera che avrebbe dovuto accorgersene mancava:
  per lo staging le due liste di conteggi sono **lo stesso oggetto**, quindi non potevano
  divergere su una collection assente da entrambe. La verifica confronta ora le collection
  **attese dal piano** con quelle presenti.
* **Gli indici si verificano leggendoli dal server (`MongoDbStrategy.indexList`)**: la
  verifica confronta l'indice ricreato con quello salvato nel backup, ma la strategia
  MongoDB **non implementava il metodo** con cui leggerlo. Le due chiamate erano protette
  da un `typeof … === 'function'` che nascondeva l'assenza in due modi opposti: sul
  ripristino il lato reale restava vuoto e ogni indice atteso risultava mancante — quindi
  **ogni** ripristino di un database con almeno un indice falliva la verifica dello
  staging; sull'import il controllo veniva **saltato in silenzio** e dichiarato fatto.
  Entrambe le vie ora falliscono dichiarando che gli indici non sono verificabili, e i
  descrittori restano **grezzi**: normalizzarli (`unique: !!i.unique`) inventerebbe un
  `unique: false` su ogni indice non univoco contro la sua assenza nel file di backup,
  cioè una divergenza per ciascun indice.
* **Una verifica fallita dice che cosa non torna**: l'esito riduceva a «la verifica non è
  riuscita» un risultato che conosce già collection mancanti, conteggi divergenti e
  definizioni di schema diverse. Chi lo riceveva non aveva modo di agire; ora le
  divergenze sono nel messaggio.
* **Il predefinito della compressione è dichiarato in un posto solo**: il nome del file di
  dati si sceglieva con `compress ? '.gz' : ''` mentre `createFileSink` comprimeva
  comunque, perché lì il predefinito è `true`. Un chiamante che ometteva il parametro
  otteneva contenuto gzip sotto un nome `.ndjson`, e il ripristino falliva con un errore
  di JSON illeggibile invece che con «backup corrotto».
* **La forma canonica dev'essere davvero canonica**: la verifica confrontava la
  **presentazione** invece della semantica, e rifiutava l'import del proprio stesso
  staging. Due facce. Su MySQL `SHOW CREATE VIEW` qualifica il nome del database soltanto
  quando NON è quello corrente della connessione: `canonicalSqlForDb` toglieva la
  qualificazione nella forma nuda e in quella fra virgolette doppie di PostgreSQL, ma non
  fra **apici inversi** — l'unica che MySQL usa — quindi la stessa view risultava mancante
  da sé stessa. Il meccanismo non è di MySQL: su PostgreSQL `pg_get_viewdef` qualifica i
  nomi in base al `search_path`, quindi la stessa view torna nuda o qualificata a seconda
  della connessione. Lì le due forme erano già coperte, ed è la ragione per cui PostgreSQL
  non mostrava il difetto; il test lo **misura** invece di darlo per scontato. Su MongoDB il server omette le opzioni lasciate al predefinito, mentre
  l'artefatto esportato scriveva `unique: false`: confrontando la **presenza** del campo,
  ogni indice non univoco divergeva, e l'import falliva su qualunque database con almeno
  un indice. `canonicalMongoIndex` omette ora i predefiniti da entrambe le parti e vive in
  `db/schemaObjects.js` in copia unica — i due adapter ne tenevano due identiche. Ciò che
  ha un **valore** resta confrontato: un TTL o un filtro parziale diverso è una differenza
  vera.
* **Gli indici MongoDB viaggiano interi**: `collectionStats` riduceva ogni indice a
  `{name, key, unique}` e l'import lo ricreava con quei soli tre campi, quindi
  `expireAfterSeconds`, `sparse`, `partialFilterExpression`, `collation` e
  `wildcardProjection` sparivano. Non era un falso allarme della verifica ma una perdita:
  un TTL importato è una scadenza che non scade più. L'export porta ora i descrittori
  completi e `createIndex` li applica, da un elenco **chiuso** di opzioni — è anche un
  evento del browser, e inoltrare al driver un oggetto arbitrario sarebbe una superficie
  in più.
* **L'export scrive solo le colonne che un `INSERT` può scrivere**: l'export dell'intero
  database leggeva le righe con `SELECT *` — cioè leggeva anche ciò che il motore di backup
  già sapeva di non poter riscrivere — e l'import le riscriveva. Due forme rendevano il file
  **non reimportabile**, entrambe con «applicate 0 di N righe»: una colonna **generata**,
  che nominata in un `INSERT` è un errore e non un valore in più; e una **geometria**, che
  `SELECT *` restituisce nella forma privata del driver (`{ x, y }`) invece che in GeoJSON.
  Le colonne scrivibili sono ora una regola sola (`colonneScrivibili`, dichiarata dal
  dialetto e servita dalla lettura di colonne già in cache), e l'export MySQL usa la stessa
  `selectListFor` geometrica della griglia — che su PostgreSQL era già stata applicata, e su
  MySQL no. L'import scarta comunque le colonne generate e riconosce la forma grezza del
  driver, così i file **già esportati** restano importabili: a produrli così è stato un
  difetto nostro.
* **Il SRID di una geometria MySQL va imposto anche quando la colonna non lo dichiara**:
  `ST_GeomFromGeoJSON` produce SRID 4326, dove MySQL usa l'ordine degli assi
  latitudine-longitudine. Su una colonna che dichiara un SRID il valore veniva riportato a
  quello giusto; su una colonna che non lo dichiara — il caso predefinito — si saltava
  `ST_SRID` e restava il 4326: misurato su MySQL 8, un `POLYGON((0 0,3 0,3 1,0 0))` tornava
  `POLYGON((0 0,0 3,1 3,0 0))`, cioè con le coordinate **scambiate** e senza alcun errore.
  Una colonna senza SRS dichiarato contiene geometrie cartesiane, il cui SRID è 0. Valeva
  per ogni scrittura, non solo per l'import: anche disegnare sulla mappa e salvare. Il test
  che affermava il contrario codificava il difetto ed è stato corretto; il poligono di prova
  è **asimmetrico**, perché su una figura simmetrica uno scambio di assi è invisibile.
* **Un'applicazione incompleta dice quale riga e perché**: `collectionImport` ripete il
  batch riga per riga proprio per isolare l'errore, e il motore riduceva tutto a «applicate
  0 di 6», buttando via l'unica informazione con cui si può fare qualcosa.
* **I test distruttivi possiedono i propri bersagli (`test/e2e-harness.js`)**: un E2E si
  collegava al DBMS locale come amministratore e cancellava database dal nome fisso — un
  nome da test, ma nessuna prova che quella destinazione fosse usa-e-getta. Ogni target
  riceve ora un marcatore casuale, viene registrato dalla fixture che lo crea, e un drop
  richiede sia `destructive: true` sia `CODEDB_E2E_DESTRUCTIVE=1` **nell'ambiente**:
  scriverlo nel sorgente non basta più. Un nome storico omonimo ma non registrato viene
  rifiutato.

### 9. Audit Log & Errori Parlanti
* **Audit (`db/AuditLog.js`)**: Tracciamento operazioni in `ui-audit.log` e `mcp-audit.log`, isolati per tenant.
* **Errori (`db/errors.js`)**: `spiegaErrore(err, ctx)` converte gli errori tecnici dei driver in messaggi chiari in italiano (*cosa è successo*, *cosa fare*).

---

## Architettura del Frontend (`public/js/`)

Applicazione Web modulare in vanilla JavaScript (nessun framework o build step).

* **Il trasporto (`trasporto.js`)**: `emit`, `emitFireAndForget`,
  `isForActiveTab`. Dietro tre nomi ci stanno tre decisioni che nessun chiamante
  deve rifare — a quale tab appartiene la richiesta (catturato alla **chiamata**,
  non alla risposta: `state` è un Proxy che punta sempre al tab attivo), la
  riconnessione delle **sole** connessioni salvate, l'annullamento quando il tab
  d'origine si chiude. Stava dentro `utils.js`, sepolto fra una quarantina di
  funzioni scorrelate che al solo essere importate registrano ascoltatori sul
  `document`; `utils.js` lo ri-esporta, quindi i quarantasette moduli che lo
  importavano da lì non sono cambiati. Il socket **si accetta**, non si crea:
  `socket.js` lo apre alla prima usata e `impostaSocket` è il punto in cui un
  test mette il proprio — prima `io(…)` girava all'import, e bastava a rendere
  non caricabile in prova quasi tutto il frontend.
* **Il modulo unico della griglia (`griglia.js`)**: la griglia dei risultati era
  implementata **quattro** volte — vista Dati, tab ⚡, Split-View e Storico
  Azioni — e tre di loro rifacevano la stessa aritmetica della finestra virtuale
  con nomi di variabile diversi. Qui c'è ciò che hanno davvero in comune:
  `finestraVirtuale` (pura, senza DOM), `disegnaCorpo` (le righe fra i due
  spaziatori) e `capacita({…})` — le otto capacità **dichiarate**
  all'interfaccia, che sono l'inventario che prima non esisteva da nessuna parte:
  «la Split-View non virtualizza» era una cosa che si scopriva usandola. Il
  disegno della **singola riga** resta della vista, perché è ciò che cambia
  davvero fra loro. Una capacità scritta male è un **errore**, non un'opzione
  ignorata.
* **Le pagine obsolete non arrivano alla griglia (`coerenza-richieste.js`)**: la
  query iniziale, il caricamento incrementale e il conteggio disaccoppiato sono
  tre richieste asincrone sullo stesso stato, e quale delle due letture in volo
  risponda per prima non lo decide l'utente. Ognuna congela alla **chiamata** il
  proprio contesto (`congelaContesto`: tab, coll-tab, db, collection, filtro,
  ordinamento, pagina, `runId`) e la risposta produce effetti solo se quel
  contesto è ancora quello mostrato (`contestoCorrente`) — una sola regola al
  posto dei sei confronti a mano che `runQuery` e il conteggio scrivevano
  ciascuno per conto proprio, e che nel primo caso ignoravano il contesto pur
  congelandolo; una nuova `runQuery`
  rinnova `gridRunId` e — quando non è una paginazione — `countToken`, cioè
  invalida tutto ciò che è ancora in volo. L'indicatore di caricamento si spegne
  con `chiudiCaricamento`, che agisce **solo** sul proprio blocco: chiuderlo
  comunque farebbe sparire la rotellina di un caricamento ancora vivo. Il difetto
  non è visibile leggendo il codice perché dipende dall'ordine di consegna:
  `test/e2e-pagine-obsolete.js` mette gli acknowledgment in coda con un socket
  finto e li consegna **al contrario**, e la sua sensibilità è stata verificata
  rompendo di proposito, una alla volta, le tre guardie (find, conteggio, blocco
  successivo).
* **La selezione di celle riceve il contenitore e le righe (`cellselect.js`)**:
  la selezione stile foglio di calcolo esisteva **solo** nella vista Dati, e non
  per scelta — il modulo cercava da sé il proprio bersaglio in tre modi che
  dicevano tutti «esiste una griglia sola»: si agganciava a `#grid tbody`,
  trovava le celle con `document.querySelectorAll('#grid tbody td[data-c]')` e
  leggeva i dati dal Proxy `state`, che punta al **tab attivo**. Un riquadro
  della Split-View ha invece il proprio contenitore (`.pane-grid-wrap`) e i
  propri dati (`p.docs`, `p.columns`), e con due riquadri su due connessioni
  diverse «il tab attivo» non identifica nemmeno il riquadro giusto: accendere
  la capacità senza parametrizzare avrebbe dato una selezione che funziona in
  quello a fuoco e **scrive silenziosamente sul riquadro sbagliato** negli
  altri. `creaSelezioneCelle(aggancio)` costruisce ora un'istanza per griglia; le
  funzioni che dipendono dalla griglia prendono l'aggancio come **primo
  argomento**, così lo dichiarano nella firma invece di andarselo a prendere da
  una variabile globale, e fuori restano quelle pure (formati di copia,
  letterali SQL, parser degli appunti). Lo stato vive dove lo dichiara l'aggancio
  — `state.cellSel` per la vista Dati, `p.cellSel` per un riquadro — quindi due
  griglie sono indipendenti **perché hanno due stati**, non perché qualcuno si
  ricorda di azzerare. Appunti, tastiera e movimento del mouse arrivano però dal
  `document` e non dicono a quale griglia si riferiscono: uno **smistamento**
  unico li manda all'ultima griglia toccata finché resta visibile (prima che
  qualcuna sia toccata, alla prima visibile), altrimenti un Ctrl+A le
  selezionerebbe tutte e un Ctrl+V scriverebbe su tutte. Le regole CSS seguono
  la stessa strada: `.selezione-celle` sul `tbody` al posto di `#grid` —
  comprese `td.editing` e le due che dipingono la selezione, altrimenti la
  capacità accesa altrove sarebbe funzionante ma **invisibile**. Provata da
  `test/e2e-selezione-celle-viste.js` (Chromium), che non si ferma alle classi:
  misura lo stile calcolato, e prova con un socket finto che l'incolla dentro un
  riquadro scriva sulla connessione e sulla tabella del RIQUADRO mentre il Proxy
  `state` ne dichiara altre — cioè il difetto per cui la capacità era rimasta
  spenta.
* **La palette dei comandi (`palette.js` / `palette-ricerca.js`)**: Ctrl+P cerca
  in un elenco solo — comandi, connessioni salvate, database e **tabelle di
  tutti i database del tab**. Le tabelle hanno due sorgenti: l'albero, che per i
  database già espansi le tiene in cache (niente attesa per ciò che l'utente sta
  guardando), e la rete per gli altri, con al massimo sei richieste in volo
  insieme — `listCollections` conta i documenti di ogni collection, e centocinquanta
  richieste simultanee sarebbero un piccolo attacco al proprio server. Le risposte
  si fondono man mano e il piede dice a che punto è la lettura: senza, una palette
  che non trova una tabella è indistinguibile da una che non l'ha ancora letta.
  I **richiami** dicono che cosa si sta cercando: `>` un comando, `#` un
  database, `@` una tabella, e la ricerca si restringe a quel tipo (il piede
  dichiara il richiamo attivo e, finché non se ne usa uno, li insegna — una
  scorciatoia che nessuno sa che esiste non esiste). Un carattere che NON è un
  richiamo resta parte del termine: mangiarsi il primo carattere di una ricerca
  legittima sarebbe peggio del richiamo mancato. Con un richiamo attivo il tipo
  esce dal testo cercato, altrimenti `#base` corrisponderebbe a ogni database.
  L'elenco passa così da una decina di voci a qualche migliaio, e questo cambia
  due cose. La prima è che **quale voce sopravvive al termine scritto** smette di
  essere un dettaglio di disegno: sta in `palette-ricerca.js`, puro e provato
  senza browser, senza alcun tetto sui risultati (troncare a trenta nasconderebbe
  proprio la tabella cercata). La seconda è che la lista è **virtualizzata** con
  la stessa aritmetica della griglia (`finestraVirtuale` di `griglia.js`, non una
  seconda copia): in DOM stanno le righe della finestra visibile fra due
  spaziatori, e sono `<li>` **riusati** — scorrere ne riscrive il testo invece di
  ricostruire l'elenco. Le frecce non possono quindi usare `scrollIntoView`
  sull'elemento attivo, che può non essere disegnato: la posizione si calcola
  dall'indice (`scorrimentoPerRiga`).
* **Il filtro rapido (`filtro-rapido.js`)**: la casella del filtro chiedeva
  all'utente di sapere quale motore aveva davanti — un documento MQL su MongoDB,
  un frammento `WHERE` sui due motori SQL. Ora ha due modalità, alternate dal
  pulsante alla sua sinistra: **👁 rapida** (si scrive del testo e si cerca in
  tutte le colonne, componendo un filtro strutturato che ogni motore rende nel
  proprio dialetto) e **condizione** (la casella di prima, per una `WHERE` o un
  MQL scritti a mano). Cambiare modalità **svuota** la casella e non riesegue: il
  testo di una modalità quasi mai ha senso nell'altra. La ricerca dell'elenco nel
  pannello 🔗 usa lo stesso filtro rapido.
* **Gestione Tab e Stato**: `tabs.js` mantiene il registro dei tab attivi; `state.js` esporta un Proxy che delega allo stato del tab correntemente attivo. `colltabs.js` gestisce le schede di secondo livello (tabelle/collezioni aperte, compreso il tab a livello DB vuoto e i tab in anteprima "preview").
* **Sidebar & Impostazioni (`connmanager.js`)**: Albero delle connessioni salvate e menu Impostazioni unificato (Backup, Audit, Salute, Utenti, Passphrase, Guida, Aggiornamenti, Licenza).
* **Viste del Workspace (`main.js`)**:
  1. **Dati (`grid.js`)**: Griglia dati paginata con editing inline (`inlineEdit.js`), inserimento (`insert.js`) e toolbar compattabile.
  2. **Dettagli (`details.js`)**: Vista indici, colonne e statistiche.
  3. **⚡ Query & Aggregate (`query-tab.js`)**: Runner SQL/MQL con numeri di riga (`query-editor.js`), formattatore (`query-formatter.js`), cronologia dedicata (`qe-history.js`) e visualizzazione risultati (Tabella, JSON Tree, Grafici, **Mappa**). La scheda 🗺 Mappa (`query-map.js`) compare solo se nei risultati ci sono geometrie: `geo-risultati.js` (puro) le riconosce nelle righe — primo livello, sottodocumenti fino a 2 livelli e dentro gli array — e `geo-vista.js` le disegna.
  **Le colonne di un result set sono DICHIARATE, non dedotte
  (`colonneRisultato` in `table-cols.js`)**: la tabella ⚡ ricavava le proprie
  intestazioni dall'unione delle chiavi delle righe, cioè da un insieme vuoto
  quando le righe erano zero. `SELECT id, addsa FROM vuota` perdeva così le
  intestazioni e mostrava «Nessun risultato da mostrare», che è la stessa cosa
  che il pannello dice quando **non è stata eseguita alcuna query**: due stati
  diversi resi indistinguibili proprio nel caso in cui l'utente ha bisogno di
  sapere quale dei due sta guardando. Le tre strategie dichiarano già `columns`
  (dai `fields` del driver sui due motori SQL) e `ScriptResults` le conserva su
  file accanto alle righe: era il frontend a buttarle via. Ora viaggiano fino al
  disegno come **argomento** — dall'esecuzione della query, dall'evento
  terminale dello script e da `script:result` — e la regola sta in un posto
  solo: le dichiarate prima e nel loro ordine (quello della `SELECT`, non quello
  di comparsa nella prima riga), poi i campi che compaiono **solo** nei dati,
  che si accodano invece di sparire — su MongoDB il catalogo dei campi è
  campionato, e una colonna presente nei dati ma assente dall'intestazione
  sarebbe un valore invisibile. La stessa regola vale ora per i riquadri della
  Split-View e per l'export, che rifacevano il calcolo per conto proprio.
  Un'aggregazione MongoDB senza documenti resta l'unico caso senza colonne, ed è
  corretto: lì la forma del risultato non è dichiarata da nessuno.
  4. **UML (`uml.js`)**: Diagramma E-R generato in SVG.
  5. **Grafo 3D (`graph3d.js`)**: Vista interattiva 3D Force-Graph (Three.js) con percorsi BFS e diagnosi schema.
  **Il grafo è il documento, gli strumenti gli stanno sopra**: la barra teneva
  nove comandi allo stesso peso visivo, tutti etichettati con un'emoji, su
  un'unica riga che scorreva in orizzontale — i comandi oltre il bordo
  sparivano senza alcun segno, e nulla distingueva ciò che decide *cosa si
  guarda* (ricerca, colore, filtri) da ciò che muove la **telecamera**. I tre
  comandi d'inquadratura (2D, rotazione automatica, inquadra tutto) stanno ora
  in un gruppo flottante in alto a destra sul canvas, come nell'editor
  cartografico e per la stessa ragione; il fondo di quel gruppo è **pieno**,
  perché sul tema chiaro un velo sopra il canvas rende i comandi
  indistinguibili dallo sfondo. La barra resta a una riga sola e **va a capo**
  invece di scorrere: una seconda riga si vede, una porzione fuori schermo no.
  Le icone sono un **unico sprite SVG** (`<symbol>` + `<use>`, prefisso `gico-`
  perché gli id di un `<symbol>` sono globali al documento e la modale
  geografica ne ha già uno) e non emoji, che cambiano forma e larghezza da un
  sistema all'altro. La modalità di colorazione era il `value` di una `<select>`
  il cui nome stava dentro le opzioni («🎨 Colore: Prefisso»): a tendina chiusa
  si leggeva un valore senza sapere di che cosa, ed è ora un controllo
  **segmentato** con i due stati visibili insieme.
  **Il filtro «Vicini» era una `<select>` di sistema accanto a un'etichetta**:
  due elementi che galleggiavano vicini in mezzo a pillole e a un segmentato,
  cioè un controllo che sembra caduto lì da un'altra interfaccia. Nome e valore
  stanno ora dentro **un solo bordo**, con l'altezza, il raggio e l'hover delle
  pillole; è un `<label for>`, quindi premere ovunque apre la tendina. La
  freccia è quella dello sprite, che eredita `currentColor` e quindi segue il
  tema: la regola **globale** `select` ne dipinge già una come `background-image`
  con il colore scritto a mano (`#8892a4`) e `!important`, e le due si
  sovrapponevano quasi esattamente — stessa misura, stesso bordo destro —
  ispessendo il chevron e schiacciando il valore; qui si spegne con
  `background-image: none !important`. La `<select>` si dimensiona sul
  **contenuto** e non su una larghezza fissa: una larghezza fissa più ampia
  apriva un vuoto di oltre 80 px fra la parola e la freccia (misurato). Non
  serve compensarlo, perché Chromium dimensiona comunque una select
  sull'opzione **più larga**: la larghezza non cambia al cambio di scelta, e i
  comandi alla sua destra non si spostano sotto le dita. `text-align: right`
  non è una via d'uscita — Chromium lo ignora sul valore chiuso.
  **Lo stato di un comando sta in `aria-pressed`, non in una classe CSS**: viveva
  in `.active` assegnata da otto gestori diversi, e quello **iniziale** non lo
  dipingeva nessuno — `showImplicitRelations` parte a `true` e il suo bottone
  nasceva spento, cioè dichiarava il contrario di ciò che il grafo stava
  facendo. Due interruttori («Solo popolate», «Relazioni implicite») erano
  inoltre voci dentro un menu chiuso: uno stato acceso che non si vede è uno
  stato che non esiste. `aggiornaComandi()` è l'unico punto che dipinge, e le
  **decisioni** sono dati puri in `grafo-comandi.js`: un comando inutilizzabile
  è disattivato e il `title` dice *perché* prima del clic — il filtro dei
  vicini conta i salti a partire da una tabella scelta, e senza selezione non
  faceva nulla né lo diceva; la rotazione automatica viene spenta d'ufficio
  quando il grafo è in modalità ridotta (`policy.reducedEffects`), e il bottone
  restava acceso sopra una scena ferma. La ricerca ha ora l'esito **assente**:
  prima una ricerca senza corrispondenze si comportava esattamente come una
  ricerca non ancora scritta.
  **«Vista 2D» non appiattiva nulla**: fissava `fz = 0` su ogni nodo e spostava
  la telecamera, ma le forze restavano a tre dimensioni — la disposizione
  continuava a essere calcolata nello spazio e l'unico effetto visibile era un
  ridisegno. Il piano è una proprietà della **simulazione**: `numDimensions(2)`.
  In piano la rotazione dell'orbita si blocca, altrimenti «2D» sarebbe solo una
  disposizione piana guardata di sbieco dopo il primo trascinamento — ma
  toglierla e basta lascia **fermi**, perché negli OrbitControls il trascinamento
  col tasto sinistro *è* la rotazione. `applicaNavigazione` rimappa quindi i
  gesti: in 2D il trascinamento (e un dito) **sposta** sul piano X-Y, la
  rotellina ingrandisce, il tasto destro sposta come in 3D; tornando in 3D il
  trascinamento torna a ruotare. Lo spostamento segue lo **schermo**
  (`screenSpacePanning`): in una vista dall'alto l'altra modalità sposterebbe
  lungo un asse che non si vede.
  **Il fondo della scena non seguiva il tema**: col tema chiaro il grafo
  restava scuro, ed era l'unico elemento della UI che il tema non raggiungeva.
  Il fondo lo dipinge il **renderer WebGL**, non il CSS: la regola
  `.graph3d-canvas { background: var(--bg-1) }` sta dietro a un canvas opaco e
  non si vede mai, quindi valeva il predefinito di 3d-force-graph (un blu quasi
  nero). Ora `backgroundColor` riceve il token `--bg-1`, e il cambio tema
  ricostruisce già l'istanza del grafo, quindi si applica da sé.
  **«Rotazione automatica» non ha mai fatto nulla**: assegnava
  `controls().autoRotate`, ma i controlli **predefiniti** di 3d-force-graph sono
  i TrackballControls, che quella proprietà non ce l'hanno affatto — si scriveva
  un campo che nessuno legge. Il grafo nasce ora con `controlType: 'orbit'`, che
  la implementa e che è anche il modello di navigazione giusto per un grafo (si
  gira intorno a un centro, non si fa rotolare la scena); `tick()` chiama
  `controls.update()` a ogni fotogramma, che è ciò che la rotazione richiede per
  avanzare. La rotazione viene **riapplicata a ogni ridisegno**, perché
  l'istanza viene ricreata e senza quello cambiare colore la spegneva in
  silenzio. Chiedere la rotazione mentre si è in 2D è chiedere lo spazio: si
  esce dal piano e lo si dice, invece di disabilitare uno dei due comandi.
  **Il degrado spegneva tutto su sedici tabelle**: `reducedEffects` valeva
  `incomplete || troppi nodi`, e `incomplete` è vero anche solo perché **una**
  tabella ha più di dodici colonne — `limitaSchema` marca allora
  `schemaPage.complete = false`. Bastava questo a togliere le **etichette dei
  nodi** su uno schema minuscolo, cioè i nomi delle tabelle: un grafo di tabelle
  senza i nomi delle tabelle non è alleggerito, è illeggibile. Il troncamento
  dei **campi** non ha alcun rapporto col costo del disegno: gli effetti si
  riducono ora in base a quanti nodi si disegnano, e le etichette hanno un tetto
  **proprio** (`labelThreshold`, sopra al tetto dei nodi) perché sono
  l'informazione e non un ornamento — le texture sono memoizzate per nome,
  quindi il costo è una volta per tabella e non per fotogramma.
  **«Solo popolate» filtrava le tabelle senza COLONNE**: il criterio era
  `fields.length === 0`, che su MySQL e PostgreSQL non è mai vero — il comando
  non nascondeva nulla su due motori su tre, e funzionava solo su MongoDB
  perché lì una collection vuota non produce campi campionati. Lo schema non
  portava alcun conteggio, quindi la decisione non era **esprimibile**:
  `dbSchema` dichiara ora `rowsApprox` su tutti e tre i motori (`TABLE_ROWS`,
  `reltuples`, `estimatedDocumentCount`). È una **stima**, e vale `null` quando
  il motore non la conosce (`reltuples = -1` prima di un ANALYZE): quel «non
  so» non autorizza a nascondere, perché far sparire una tabella piena è molto
  peggio che mostrarne una vuota. Il messaggio dichiara quante tabelle sono
  sparite e che il conteggio è stimato.
* **Split-View (`split-layout.js` / `splitview.js`)**: Struttura ad albero immutabile per affiancare più tabelle/collezioni nello stesso workspace con supporto al trascinamento, il cui ridimensionamento usa Pointer Events senza scatti.
* **Calcoli pesanti su Web Worker (`calcoli.js` / `calcoli-protocollo.js` / `calcoli-worker.js`)**: le statistiche della selezione, la scansione dei campi e il **precalcolo** dei grafici (`precalcola` in `chart-option.js`: raggruppamento, aggregazione, ordinamento) scorrono tutte le righe. Oltre **50.000 celle** finiscono su un module worker, sotto restano sul posto — spostare un lavoro da due millisecondi costerebbe più del lavoro. Le due vie chiamano lo stesso `eseguiCompito`, quindi non possono divergere; senza `Worker`, o se il worker muore, si ricade sul calcolo locale. Il **disegno** resta sul thread principale: l'option di ECharts contiene funzioni (`formatter`) e non attraversa il confine fra thread. Chi ricalcola in continuazione (la barra di stato durante il trascinamento) usa `sequenziatore()` per scartare le risposte sorpassate.
* **Custom Charts (`charts.js` / `chart-option.js`)**: Generatore di grafici ECharts 6.1.0 (vendorizzato) con aggregazione lato client, suggerimenti automatici e palette accessibili WCAG. Il caricamento della libreria e la cromatura del tema stanno in `chart-runtime.js`, condivisi con il grafico della selezione.
* **IntelliSense schema-aware (`intellisense.js` / `autocomplete.js`)**: il completamento si decide dal punto in cui sta il cursore — dopo `FROM`/`JOIN` tabelle o collezioni, dopo `u.` le colonne della sola tabella a cui `u` fa da alias, dopo `db.` le collezioni, dopo `db.coll.` i metodi, `$` gli operatori. La **lingua si deduce dal testo dell'istruzione**, non dal DBMS (`motoreDalTesto`): su MongoDB si scrive SQL — tradotto da `SqlToMql` — e lì dopo `FROM` servono i nomi delle collezioni; in uno script ogni istruzione fra `;` ha la sua lingua. Il tipo di connessione e il selettore del motore restano solo il ripiego finché il testo tace, e in quel caso su MongoDB si propongono anche gli inizi SQL. **I vocabolari del dialetto** (`sql-dialetti.js`) aggiungono a quelli comuni le funzioni, le clausole e i tipi di colonna del motore in uso — `GROUP_CONCAT`/`ON DUPLICATE KEY UPDATE` su MySQL, `STRING_AGG`/`RETURNING` su PostgreSQL — e su MongoDB via SQL limitano le funzioni ai soli aggregati che `SqlToMql` sa tradurre. I tipi si propongono solo dove il DDL li pretende (`CREATE TABLE`, `ALTER TABLE … ADD`); senza un motore riconosciuto il dialetto è vuoto e resta il completamento comune. **I nomi vengono scritti già quotati quando il motore lo richiede** (`quotaIdentificatore`): su PostgreSQL un identificatore non quotato viene abbassato, quindi `FROM diego.Prova` cerca `diego.prova` — il completamento, il doppio clic e il trascinamento dello Schema Browser inseriscono `diego."Prova"`. Su MySQL e MongoDB si usa il backtick (in SQL→MQL le `"…"` sono stringhe, non identificatori) e solo quando serve davvero. Dopo `FROM`/`JOIN` il punto separa lo **schema** dalla tabella, non l'alias dalla colonna. Lo strato puro `intellisense.js` legge il contesto e ordina i candidati; `autocomplete.js` tiene il dropdown (posizionato al cursore nell'editor ⚡, Ctrl+Spazio per aprirlo a richiesta) e la **cache dello schema** per (connessione, database), riempita con `db:schema` e invalidata da ogni DDL e da `schema:changed`.
* **JSON/BSON: valida, formatta, minifica (`json-bson.js` / `json-lint.js`)**: parser tollerante alla sintassi della shell (chiavi nude, apici singoli, `ObjectId(...)`, regex, commenti) che riemette i token **alla lettera** — per questo formattare non arrotonda un intero oltre i 53 bit, come farebbe `JSON.parse`. Il linting compare mentre si scrive, con riga e colonna cliccabili, nell'editor ⚡ (solo se il testo è un documento) e nelle modali di inserimento e modifica; Ctrl+Shift+F formatta e Ctrl+Shift+M minifica ovunque.
* **Selezioni & Statistiche Excel (`cellselect.js` / `cell-stats.js`)**: Copia/incolla multi-formato (TSV, CSV, JSON, SQL) e pannello statistiche numeriche immediate ($\Sigma$, $\bar{x}$, min, max, mediana, stddev) con compensazione Kahan. **L'incolla è esatto e atomico (`coercePasted`/`pasteIntoGrid`)**: numeri oltre 2^53 e decimali passano dal codec di `valori-esatti.js`, mai da `Number`, e l'intero blocco incollato viene VALIDATO prima di mandare la prima `doc:update` — un errore in una riga qualsiasi annulla tutto il blocco e nomina riga e colonna, il database resta invariato. La convenzione temporale (DATE calendario, DATETIME/TIMESTAMP locale senza fuso, TIMESTAMPTZ istante con fuso esplicito) la decide il tipo **dichiarato** dalla colonna, e quel controllo doveva stare PRIMA di `valueType(current) === 'date'`: su ogni motore SQL una colonna già valorizzata arriva in EJSON come `{$date}` qualunque sia il suo tipo, quindi il controllo generico catturava sempre una cella non vuota e trattava anche una DATE o una DATETIME naive come istante, pretendendo un fuso che non hanno mai avuto — il ramo che le distingueva esisteva già ma era irraggiungibile. `test/e2e-incolla-esatto-atomico.js` prova entrambe le proprietà su un blocco vero (BIGINT/decimal al limite, un cambio d'ora legale) e la sensibilità è stata verificata rompendo di proposito sia l'ordine dei controlli sia l'atomicità del preflight. **Scorrimento automatico ai bordi (`scorrimento-bordo.js`)**: trascinando la selezione fino al bordo della `.grid-wrap` (o oltre, fuori dalla griglia) il contenitore scorre da solo e la selezione segue, col mouse e col dito. La posizione del puntatore è tenuta a parte perché `mouseover` non basta: col cursore fermo sul bordo non arriva più nessun evento, ed è lo scorrimento stesso a portare nuove celle sotto al cursore, quindi la cella si rilegge con `elementFromPoint` dentro il ciclo `requestAnimationFrame` (coordinate riportate sotto l'intestazione `sticky`, altrimenti si troverebbe un `th`). La velocità sta nel modulo puro, verificato da `test/unit-scorrimento.js`. **Col dito** valgono tre accorgimenti in più: la fascia sensibile è più larga (72 px contro 40: il polpastrello copre il bordo), il trascinamento scatta solo oltre 10 px di movimento (sotto è ancora una *pressione*, e sulla selezione la pressione lunga è l'unico modo di aprire il menu contestuale), e il puntatore viene catturato esplicitamente sul `tbody` — la cattura implicita del tocco sta sul `td` iniziale, che lo scorrimento fa sparire quando la virtualizzazione rifà la finestra visibile. `test/e2e-tocco-griglia.js` prova in Chromium con eventi touch nativi le assunzioni di piattaforma: scorrere da codice non annulla il puntatore, il gesto sopravvive alla ricostruzione delle righe, e `elementsFromPoint` (al plurale) trova la cella anche sotto un elemento sovrapposto.
* **Duplicazione di righe (`cellselect.js` → `doc:duplicate` → `db/duplica.js`)**: duplicare non è copiare. La chiave primaria collide sempre, le colonne di un indice unico spesso, e una colonna calcolata dal DBMS non si può nemmeno nominare in un `INSERT`: per questo il documento da inserire lo calcola il **server**, che i vincoli li legge dal database, invece di lasciarlo comporre a mano in un editor JSON. Due modalità dal menu contestuale, entrambe **immediate** (nessuna modale): *senza chiavi* rifà la primaria e svuota le altre chiavi — omesse se il DBMS le genera (`AUTO_INCREMENT`, `serial`/identity, ObjectId), `NULL` se la colonna lo consente, altrimenti un valore nuovo; *con chiavi* lascia tutto e cambia **solo** la primaria. Il valore nuovo lo decide `calcolaNuovoValore`: `MAX+1` sui numeri, suffisso `-copia`, `-copia-2`… sul testo (accorciando la BASE, non il suffisso, dentro la lunghezza della colonna), UUID dove il tipo lo è — e in tutti i casi si salta ciò che risulta già occupato. Su una chiave **composta** si rifà solo l'ultima componente: cambiare anche `ordine_id` sposterebbe il duplicato in un altro ordine. Su MongoDB `null` non è una via d'uscita (il campo assente vale null nell'indice unico e collide lo stesso), quindi quei campi ricevono sempre un valore nuovo, e un `_id` numerico resta numerico invece di diventare un ObjectId. Le note del server dicono in un toast che cosa è cambiato; la terza voce, *Duplica e modifica…*, mostra lo stesso documento (`soloAnteprima`) in un editor prima di scriverlo. Lo strato puro è `db/duplica.js`, verificato da `test/unit-duplica.js`.
* **Grafico della selezione (`cellgrafico.js` / `cell-chart.js`)**: Voce 📈 del menu contestuale della griglia (e pulsante nel pannello 📊) che disegna le celle selezionate in una finestra ECharts. Lo strato puro `cell-chart.js` deduce dalla selezione l'asse X (data → categoria → ordinale di riga `#`), una serie per colonna numerica e il raggruppamento — acceso solo se i valori dell'asse si ripetono davvero.
* **Pannello di riferimento delle chiavi esterne (`fk-vista.js` / `fk-relazioni.js`)**: le colonne collegate portano un indicatore in griglia (🔗 vincolo dichiarato, ≈ ipotesi) e, al doppio clic, un pulsante che fa scorrere da destra un pannello con la riga riferita e l'elenco cercabile da cui scegliere un altro valore. Non è una modale: la cella resta in modifica. I dati arrivano da `collection:relations` (FK della sola tabella aperta, mirata — non `db:schema`) e `collection:find` con un **filtro strutturato** (la stessa via della griglia). Il metodo separato `relatedRows` non esiste più: era un metodo a sé *dichiaratamente* perché sui motori SQL il filtro era un frammento grezzo interpolato, e tolta la causa è rientrato nel metodo comune — 202 righe in meno e un metodo in meno nell'interfaccia delle strategie. Lo strato puro `fk-relazioni.js` normalizza i descrittori delle tre sorgenti e sceglie dai dati la colonna-etichetta dell'elenco.
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
