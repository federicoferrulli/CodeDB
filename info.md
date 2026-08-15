# CodeDB — Panoramica e Architettura del Progetto

CodeDB è un'applicazione web e desktop **multi-database** moderna, ad alte prestazioni e progettata secondo la filosofia **Local-First, AI-Native e Zero-Build**. Nasce per offrire un'alternativa agile, privata e aperta a strumenti come DBeaver, MongoDB Compass, TablePlus e pgAdmin.

---

## 1. 🎯 Filosofia e Visione

1. **Local-First & Privacy Assoluta**:
   - Tutte le credenziali e i segreti risiedono esclusivamente sul server locale/backend.
   - Nessun dato sensibile transita o viene esposto verso il client o terze parti.
   - Il backend Node.js agisce come **unica fonte di verità** (*Single Source of Truth*).
2. **Zero-Build & Pure Vanilla Performance**:
   - Il frontend è realizzato in **Vanilla JavaScript** modulare (ES Modules nativi), HTML5 semantico e CSS Custom Properties.
   - Nessun bundler o framework pesante (React, Vue, Angular): caricamento sub-millisecondo, zero FOUC all'avvio, rendering fluido a 60 FPS e consumo minimo di memoria RAM.
3. **Ponte Uomo-AI (AI-First via Model Context Protocol)**:
   - Integrazione nativa del gateway **MCP** (`/mcp`) conforme alle specifiche ufficiali di Anthropic.
   - Consente ad agenti AI (Claude Desktop, Cursor, Codex, Windsurf) di esplorare database, analizzare schemi ed eseguire query in totale sicurezza con audit e controllo umano a due passaggi per le scritture.

---

## 2. 🗄️ Supporto Multi-DBMS & Strategy Pattern

Il backend astrae la comunicazione con i database attraverso un'architettura a **Strategy Pattern** estensibile:

- **MongoDB** (`db/MongoDbStrategy.js`):
  - Driver nativo `mongodb` con BSON ed Extended JSON (EJSON v2).
  - Supporto a Change Streams in tempo reale (`collection:watch`) tramite WebSocket Socket.IO.
  - Pipeline di aggregazione avanzate e supporto alla sintassi shell nativa `db.<coll>.find()`.
- **MySQL & MariaDB** (`db/MySqlStrategy.js`):
  - Pool di connessioni ad alta concorrenza via `mysql2`.
  - Introspezione completa di tabelle, chiavi primarie, foreign keys, indici e vincoli DDL.
- **PostgreSQL** (`db/PostgreSqlStrategy.js`):
  - Pool nativo `pg` con gestione multischema (il livello "Database" nella UI equivale allo Schema PostgreSQL).
  - Supporto ai tipi complessi, enum e colonne geometriche.
- **Tunnel SSH Trasparente** (`db/SshTunnel.js`):
  - Tunneling cifrato per bastion host remoti (password o chiave privata RSA/Ed25519 con passphrase).
  - Protezione anti-Man-in-the-Middle con verifica dell'impronta `StrictHostKeyChecking` (modello TOFU - Trust On First Use).

---

## 3. ⚡ Query Engine, Script Runner & Virtual JOINs

- **Traduttore SQL $\rightarrow$ MQL** (`db/SqlToMql.js`):
  - Consente di scrivere query SQL standard (`SELECT`, `JOIN`, `GROUP BY`, `HAVING`, `WHERE`, `ORDER BY`, `LIMIT`) su database **MongoDB**.
  - Traduzione trasparente in pipeline di aggregazione BSON native (`$match`, `$lookup`, `$group`, `$project`, `$sort`).
- **Virtual JOINs Cross-Database** (`db/VirtualJoinEngine.js`):
  - Esegue JOIN in memoria tra database e motori eterogenei (es. unire una tabella SQL PostgreSQL/MySQL con una collezione MongoDB).
- **Script Runner Sicuro** (`db/ScriptRunner.js`, `db/MongoScript.js`):
  - Esecuzione passo-passo di script multi-istruzione con avanzamento in tempo reale via WebSocket (`script:progress`).
  - Interprete AST custom senza ricorrere a `eval` o `new Function`, dotato di quote di passi, ricorsione e tempo massimo.
  - Supporto per pausa, ripresa e modalità *"ferma al primo errore"*.
- **Chunking per File SQL Grandi** (`public/js/sql-chunker.js`):
  - Gestione ed esecuzione a blocchi sequenziali per script o dump SQL di grandi dimensioni senza saturare la memoria del browser.

---

## 4. 🗺️ Modulo GIS, Geometrie & Editing Cartografico

- **Riconoscimento Automatico Geometrie** (`public/js/geo-risultati.js`):
  - Ispezione automatica dei risultati delle query per rilevare oggetti GeoJSON, geometrie WKT e coordinate `[lat, lng]` (fino a 2 livelli di annidamento e all'interno di array).
- **Motore Cartografico Leaflet** (`public/js/geo-vista.js`, `public/js/geomap.js`):
  - Visualizzazione interattiva su mappa con tessere cartografiche e supporto offline.
  - Editor di vertici su Canvas a doppio layer: spostamento e trascinamento fluido a 60 FPS senza ricalcolo della mappa base.
- **Analisi Geospaziale & Statistiche** (`public/js/geo-stats.js`):
  - Calcolo geodetico immediato di area ($m^2$, $km^2$), perimetro, lunghezza, centroide e bounding box per qualsiasi selezione geometrica.

---

## 5. 📊 Visualizzazioni Avanzate, Grafici & Modelli E-R

- **Grafo 3D Force-Directed** (`public/js/graph3d.js`):
  - Rendering WebGL con Three.js delle relazioni e dello schema del database.
  - Algoritmo **BFS** (Breadth-First Search) per calcolare e tracciare il cammino minimo (*Shortest Path*) tra due entità.
- **Diagrammi Entità-Relazione (UML E-R)** (`public/js/uml.js`):
  - Generazione di diagrammi E-R vettoriali SVG completi di foreign keys, tipi di dato e relazioni.
- **Custom Charts ECharts 6.1** (`public/js/charts.js`):
  - Aggregazione dati client-side con grafici a barre, linee, torta e dispersione, con palette conformi ai criteri di contrasto WCAG.
- **Grafico Istantaneo della Selezione** (`public/js/cellgrafico.js`):
  - Possibilità di selezionare un'area di celle nella griglia e generare con un click un grafico al volo deducendo serie temporali, categorie e valori numerici.

---

## 6. 🔲 Split-View & Gestione Dati Excel-Style

- **Split-View ad Albero Immutabile** (`public/js/splitview.js`, `public/js/split-layout.js`):
  - Affiancamento e impilamento di più tabelle o collezioni nello stesso workspace (fino a 4 o più contemporaneamente).
  - Ridimensionamento reattivo con Pointer Events senza scatti.
- **Selezioni a Blocchi & Statistiche Immediate** (`public/js/cellselect.js`, `public/js/cell-stats.js`):
  - Selezione rettangolare stile foglio di calcolo con calcolo istantaneo di Somma ($\Sigma$ con compensazione numerica Kahan), Media ($\bar{x}$), Minimo, Massimo, Mediana e Deviazione Standard ($\sigma$).
  - Copia rapida in formati TSV (Excel/Google Sheets), CSV, JSON e `INSERT INTO` SQL.
- **Editing Inline & Toolbar Compatta** (`public/js/inlineEdit.js`, `public/js/grid.js`):
  - Modifica rapida delle celle con validazione di tipo, inserimento guidato di nuovi record e paginazione ottimizzata.

---

## 7. 🔒 Sicurezza, Vault Crittografico & Control Plane RBAC

- **Vault Crittografico v2 (Envelope Encryption)** (`db/vault.js`):
  - Passphrase $\xrightarrow{\text{scrypt}}$ KEK $\xrightarrow{\text{AES-256-GCM}}$ DEK $\xrightarrow{\text{AES-256-GCM}}$ Segreti.
  - Nessuna password o chiave viaggia mai verso il browser (eliminazione dei campi segreti in `connections:get` e `connections:list`).
  - Scrittura atomica e durevole con `fsync` esplicito e conservazione automatica dei file di backup `.bak` e `.bak2`.
- **Control Plane & RBAC Multi-Tenant** (`auth/`):
  - Attivabile con `CODEDB_RBAC=on` tramite database dedicato (`CODEDB_APP_DB_URI`).
  - Token opachi a 32 byte con hash SHA-256 memorizzati nel DB e revoca immediata a caldo dei socket connessi (`disconnettiSocketDi`).
  - **Proxy Autorizzante (`guardStrategy.js`)**: Incapsula ogni strategia verificando a monte capability (`read`, `write`, `delete`, `ddl`, `manage`) e scope su database/tabelle.
  - **Blocco I/O DBMS & Server JS**: Rilevamento e blocco di query con `INTO OUTFILE`, `LOAD DATA`, `LOAD_FILE()` e divieto di costrutti JavaScript pericolosi su MongoDB (`$where`, `$function`, `$accumulator`).
- **Monitor Sessioni & Deadlock Detector** (`db/sessioni.js`, `public/js/sessions.js`):
  - Monitoraggio real-time di query attive, transazioni e lock con diagnosi automatica della catena di blocco (*"chi blocca chi"*) e annullamento sicuro.
- **Audit Logging** (`db/AuditLog.js`):
  - Registrazione su file append-only con rotazione automatica (`ui-audit.log`, `mcp-audit.log`), filtrati per tenant con sanitizzazione automatica di password e URI (`redigiUri`).

---

## 8. 💾 Motore di Backup & Restore Integrato

- **CLI e Gestore Web** (`backup/`):
  - Tipologie di backup supportate: **Full**, **Incrementale** (dall'ultimo backup) e **Differenziale** (dall'ultimo full).
  - Formato di archiviazione streaming compresso gzip con `manifest.json` e checksum di integrità SHA-256 per ogni file.
  - Risoluzione automatica della catena di ripristino (*restore chain*).
- **Storage Cloud Opzionale**:
  - Supporto per destinazioni AWS S3 (`s3://`), Google Cloud Storage (`gs://`) e Azure Blob (`azure://`).
  - Policy di sicurezza anti-SSRF con whitelist di alias pre-approvati (`resolveStorageAlias`).
- **Isolamento Multi-Tenant**:
  - Partizione dei dump per tenant (`tenants/<ownerId>`) e validazione rigorosa dei percorsi contro attacchi di directory traversal (`resolveBackupPath`).

---

## 9. 🤖 AI Gateway (Model Context Protocol - MCP)

- **Endpoint Streamable HTTP** (`/mcp`):
  - Connessione nativa per assistenti e agenti AI.
  - Tool integrati: `list_saved_connections`, `connect_database`, `get_databases_and_collections`, `get_schema`, `execute_query`, `get_shortest_path`, `analyze_dependencies`, `analyze_pii`, `audit_schema`, `backup_database`, `list_backups`, `verify_backup`, `restore_backup`.
- **Sicurezza per Modelli AI**:
  - Le credenziali fisiche non vengono mai passate all'AI (connessione tramite ID logico effimero).
  - Modalità sola lettura di default; le operazioni mutative (`execute_write`, `restore_backup`) richiedono un `confirm_token` a consumo singolo approvato da un operatore umano.

---

## 10. 🖥️ Packaging Desktop, Launcher & Testing

- **App Desktop Electron** (`electron-main.js`):
  - Server Node.js in-process integrato, single-instance lock e memorizzazione sicura dei dati in `userData`.
  - Aggiornamenti automatici cross-platform via `electron-updater` (`electron-aggiornamenti.js`).
- **Launchers Multipiattaforma**:
  - `CodeDB.cmd` (Windows) e `codedb.sh` (Linux/macOS) per l'avvio in background trasparente con scorciatoie Desktop/Start.
- **Suite di Test End-to-End**:
  - Test E2E isolati per DBMS: `test/e2e.js` (MongoDB), `test/e2e-mysql.js` (MySQL), `test/e2e-postgres.js` (PostgreSQL), `test/e2e-mcp.js` (MCP Gateway).
  - Test E2E Browser con **Playwright** (`test/e2e-playwright.js`): automazione sblocco vault, inventario dinamico dei controlli UI (`test-reports/ui-clickable-elements-latest.md`), test di connessione ed esecuzione query.

---

## 🛠️ Comandi Principali per gli Sviluppatori

```bash
# Installazione e Avvio
npm install
npm start                  # Avvia server su http://localhost:3030
npm run dev                # Dev mode con riavvio automatico (node --watch)
npm run start:rbac         # Avvia server con RBAC attivo (.env con CODEDB_RBAC=on)
npm run electron:start     # Avvia l'app desktop Electron

# Esecuzione Test
npm test                   # Esegue tutti i test unitari
npm run test:e2e:playwright # Esegue la suite Playwright E2E nel browser Chromium
node test/e2e.js           # Test E2E MongoDB
node test/e2e-mysql.js     # Test E2E MySQL
node test/e2e-postgres.js  # Test E2E PostgreSQL
node test/e2e-mcp.js       # Test E2E Gateway MCP

# Build & Release Desktop (Electron)
npm run build:win          # Installer Windows (.exe NSIS) in dist/
npm run build:mac          # Installer macOS (.dmg)
npm run build:linux        # Installer Linux (.AppImage + .deb)
npm run build:all          # Build per tutte le piattaforme

# Backup CLI
npm run backup -- help     # Guida alla CLI di backup/restore
```
