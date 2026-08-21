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
node test/e2e-filtro-rapido-ui.js # Test del filtro rapido nel browser
node test/e2e-filtro-strutturato.js # Test del filtro strutturato sui tre motori
node test/e2e-nulli-ordinati.js # Test che i valori nulli si ordinino uguale sui tre motori
node test/e2e-osservazione.js # Test dell'osservazione da capo a fondo (MongoDB)

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

* **Il filtro come DATO (`db/filtro.js`)**: lo stesso parametro `filter` significava tre cose a seconda del motore — un frammento di clausola SQL grezzo, un documento MQL — e ogni chiamante doveva sapere in anticipo chi avrebbe risposto. Il filtro strutturato è `{ condizioni: [{ campo, operatore, valore }], unione }` con undici operatori, e ogni motore lo rende nel proprio dialetto **parametrizzando**. Il valore non attraversa mai il testo della query: è questa, e non un elenco di caratteri vietati, la ragione per cui un valore ostile non può cambiare la struttura di ciò che viene eseguito — e su MongoDB l'equivalente è che il valore resta sempre in posizione di *valore*, mai di operatore. Un `campo` con un segmento vuoto o che comincia per `# CLAUDE.md

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
node test/e2e-filtro-rapido-ui.js # Test del filtro rapido nel browser
node test/e2e-filtro-strutturato.js # Test del filtro strutturato sui tre motori
node test/e2e-nulli-ordinati.js # Test che i valori nulli si ordinino uguale sui tre motori
node test/e2e-osservazione.js # Test dell'osservazione da capo a fondo (MongoDB)

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
* **Paginazione e Conteggio**: `collection:find` supporta `deferCount: true`. Il conteggio viene richiesto a parte con `collection:count` soggetto a timeout (`CODEDB_COUNT_TIMEOUT_MS`, default 5000ms) per evitare blocchi su tabelle enormi. Budget di byte sui risultati (`CODEDB_MAX_RESULT_BYTES`, default 32 MB).
* **Tetto di tempo sulla query libera**: `collectionAggregate` è la porta unica della tab ⚡ su SQL — ci passano sia le letture sia le scritture — e il tetto vale su **entrambi i rami**, da `DbStrategy.aggregateTimeoutMs()` (`CODEDB_AGGREGATE_TIMEOUT_MS`, default 120000; `<= 0` disattiva). Prima il limite stava solo dentro il ramo di sola lettura, come costante `30000` scritta nel corpo del metodo: un `UPDATE` sbagliato teneva una connessione del pool senza limite, e `cancelQuery` lo raggiunge solo se il client ha mandato un `runId` e l'utente del DB ha il privilegio per uccidere. Su PostgreSQL è `statement_timeout` (`SET LOCAL` in transazione, `SET` + `RESET` fuori: un `SET` non riazzerato lo eredita chi prende quel client dal pool). Su MySQL è il `timeout` per-query di mysql2, che però è **lato client**: allo scadere il driver smette di aspettare ma il server continua, quindi la strategia manda `KILL QUERY` da una seconda connessione e **distrugge** quella avvelenata invece di restituirla al pool con un result set arretrato in arrivo. Interrompere è sicuro perché su entrambi i motori l'istruzione annullata fa rollback: è la ragione per cui su MongoDB le pipeline `$out`/`$merge` restano invece **escluse** dal tetto — lì fermarsi a metà lascerebbe la destinazione scritta a metà.

 è **rifiutato**: su MongoDB diventerebbe un operatore. Il filtro testuale convive, ed è la modalità «condizione» della griglia.

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
