# 📋 Checklist Completa delle Funzionalità di CodeDB

Questo documento raccoglie l'inventario esaustivo di **tutte le funzionalità, moduli e strumenti** integrati nell'applicativo CodeDB (Backend, Frontend, Desktop Electron, Sicurezza, Query Engine, Mappe GIS, Grafo 3D, Backup e Gateway AI/MCP).

---

## 1. 🔌 Gestione Connessioni & Sicurezza Credenziali

- [ ] **Supporto Multi-DBMS Nativo:**
  - [ ] **MongoDB:** Driver nativo (`MongoClient`), change streams in tempo reale (`watch`), BSON/EJSON esteso.
  - [ ] **MySQL:** Pool di connessioni ad alte prestazioni (`mysql2`), rilevamento e allineamento automatico della collation (`utf8mb4`).
  - [ ] **PostgreSQL:** Pool (`pg`), mappatura Database ↔ Schema PostgreSQL, quotatura identificatori sensibile al maiuscolo/minuscolo (`qtable`).
- [ ] **Wizard di Connessione Guidato (3 Passaggi):**
  - [ ] **Passo 1 (Parametri di Rete):** Inserimento puntuale (Host, Porta, Username, Password, AuthSource, Database/Schema iniziale) oppure parsing automatico da Connection String URI completa.
  - [ ] **Passo 2 (Tunnel SSH / Bastion Host):** Connessione sicura tramite Host SSH, Porta (default 22), Utente SSH, Autenticazione a Password o Chiave Privata con Passphrase.
  - [ ] **SSH Host Key Pinning (Anti MITM):** Registrazione automatica dell'impronta crittografica SHA-256 della chiave host al primo collegamento riuscito; blocco preventivo della connessione in caso di sostituzione della chiave host.
  - [ ] **Passo 3 (Organizzazione & Salvataggio):** Assegnazione etichetta personalizzata, associazione a cartelle/gruppi nidificati, anteprima riepilogativa.
- [ ] **Test di Connessione Standalone:** Verifica istantanea della raggiungibilità del database lato server senza aprire schede di lavoro.
- [ ] **Sidebar Connessioni Salvate:**
  - [ ] Albero gerarchico organizzato per cartelle comprimibili.
  - [ ] Ricerca e filtraggio rapido in tempo reale.
  - [ ] Modifica rapida dei parametri con banner di avviso.
  - [ ] Duplicazione ed eliminazione connessioni salvate.
- [ ] **Esportazione & Importazione Connessioni:**
  - [ ] Esportazione del file `connections.ini` con payload dei segreti cifrati.
  - [ ] Possibilità di indicare una passphrase di destinazione per migrare le connessioni su un'altra istanza.
  - [ ] Importazione e fusione con le connessioni già presenti.
- [ ] **Vault Crittografico v2 (AES-256-GCM):**
  - [ ] Derivazione crittografica della KEK tramite `scrypt` con salt casuale.
  - [ ] DEK (Data Encryption Key) casuale avvolta dalla KEK: il cambio passphrase aggiorna solo l'avvolgimento senza ri-cifrare tutti i record.
  - [ ] Modale di sblocco all'avvio con Master Password.
  - [ ] Banner contestuale (`#vault-hint`) per segnalare la presenza di segreti in chiaro su vault non protetti.
  - [ ] Modale di cambio Passphrase per l'intera installazione.
  - [ ] Procedura di reset di emergenza ("Riparti da zero") con salvataggio delle connessioni non recuperabili con suffisso `*.pre-reset-...`.

---

## 2. 🗄️ Esplorazione Database & Schema Browser

- [ ] **Navigatore Gerarchico Database / Tabelle / Collezioni:**
  - [ ] Visualizzazione gerarchica per tab di connessione attiva.
  - [ ] **PostgreSQL:** visualizzazione degli schemi al livello "Database" e relative tabelle/viste.
  - [ ] **MongoDB:** conteggio stimato dei documenti per collezione.
  - [ ] **MySQL:** visualizzazione database, tabelle e viste.
- [ ] **Ricerca Istantanea nell'Albero:** Filtro reattivo mentre si digita per individuare velocemente schemi, database, tabelle o collezioni.
- [ ] **Menu Contestuale dell'Albero:**
  - [ ] **Nuovo Database / Schema:** Creazione rapida con inserimento prima collezione o schema SQL.
  - [ ] **Rinomina:** Ridenominazione di database o tabelle/collezioni (con protezione per schemi di sistema).
  - [ ] **Eliminazione (DROP):** Cancellazione definitiva con conferma di sicurezza.
  - [ ] **Svuotamento (TRUNCATE):** Eliminazione di tutti i record preservando la struttura.
  - [ ] **Nuova Tabella / Collezione:** Creazione con editor visuale dei tipi di colonna (PK, AI, NULL, Default).
  - [ ] **Import/Export Rapido:** Accesso diretto agli strumenti di import ed export per la risorsa selezionata.
- [ ] **Schema Browser Integrato nella scheda Query:**
  - [ ] Albero compatto navigabile durante la scrittura del codice.
  - [ ] Supporto al doppio clic e drag-and-drop nell'editor con quotatura automatica degli identificatori (`"schema"."Tabella"` o `` `db`.`tabella` ``).

---

## 3. 📊 Vista Dati & Griglia Virtualizzata

- [ ] **Griglia Virtualizzata ad Alte Prestazioni:**
  - [ ] Finestra virtuale pura (`finestraVirtuale`): rendering nel DOM delle sole righe visibili nel viewport (nessun rallentamento con milioni di record).
  - [ ] Riutilizzo degli elementi `<tr>` e `<td>` durante lo scorrimento veloce.
- [ ] **Filtro Dati a Doppia Modalità:**
  - [ ] **Modalità 👁 Cerca (Filtro Strutturato):** Ricerca full-text su tutte le colonne con traduzione parametrizzata e sicura nel dialetto del motore in uso.
  - [ ] **Modalità Condizione:** Inserimento di clausole `WHERE` SQL libere o query MQL JSON/BSON avanzate.
- [ ] **Ordinamento Colonne Unificato:**
  - [ ] Clic sulle intestazioni per alternare ordinamento ASC / DESC / reset.
  - [ ] **Allineamento dei Valori `NULL`:** Comportamento uniforme su tutti i DBMS (`NULL` considerato sempre come valore più piccolo) con sintassi ottimizzata per evitare de-ottimizzazioni degli indici (`NULLS FIRST` omesso su colonne `NOT NULL` in PostgreSQL).
  - [ ] Campo input ordinamento manuale per clausole complesse.
- [ ] **Paginazione & Navigazione:**
  - [ ] Paginatore con selezione del limite per pagina (25, 50, 100, 200, 500, 1000, 5000 righe).
  - [ ] Modalità **∞ Scroll Infinito:** Caricamento continuo a blocchi durante lo scorrimento.
  - [ ] Paginatore compatto automatico quando tutti i record risiedono in una sola pagina.
  - [ ] Conteggio differito con timeout (`CODEDB_COUNT_TIMEOUT_MS`) per non bloccare la lettura su tabelle massive.
- [ ] **Toolbar di Azione Dati:**
  - [ ] Esegui (Invio), Inserisci nuovo record, Ricarica dati.
  - [ ] Menu esteso: Piano di esecuzione (Explain), Polling automatico ogni 5s, Elimina tutto filtrato.
- [ ] **Aggiornamenti in Tempo Reale (Live Change Streams):** Monitoraggio live su MongoDB con badge `● LIVE` e aggiornamento push della griglia.
- [ ] **Storico Query della Collezione:** Menu a discesa per ripescare le ultime query eseguite sulla tabella attiva.

---

## 4. ✏️ Manipolazione Dati, Inserimento & Modifica

- [ ] **Editing Inline delle Celle:** Modifica diretta in cella con doppio clic, conferma con tasto Invio o spostamento su altra cella, annullamento con Esc.
- [ ] **Modale Inserimento Record/Documento:**
  - [ ] **Modalità Modulo:** Form generato sulle colonne note dello schema, con gestione campi opzionali e tipi.
  - [ ] **Modalità JSON/BSON:** Editor testuale con evidenziazione, formattatore (Ctrl+Shift+F), minificatore (Ctrl+Shift+M) e linting in tempo reale.
- [ ] **Modale Modifica Documento Intero:** Visualizzazione del record/documento completo in formato JSON/EJSON con linting e validazione.
- [ ] **Duplicazione Intelligente di Righe (Server-Side):**
  - [ ] *Duplica senza chiavi:* Rigenera la chiave primaria e azzera/omette le chiavi uniche autogenerate (`AUTO_INCREMENT`, `serial`/identity, `ObjectId`).
  - [ ] *Duplica con chiavi:* Mantiene i dati e rigenera solo la chiave primaria con algoritmo `calcolaNuovoValore` (`MAX+1`, UUID, suffisso `-copia` con troncamento della base per rispettare la lunghezza massima della colonna).
  - [ ] *Duplica e modifica...:* Apre il record duplicato in anteprima prima del salvataggio.
- [ ] **Eliminazione Record:**
  - [ ] Eliminazione singola riga dal menu contestuale.
  - [ ] Selezione multipla con barra contestuale ("Elimina X record selezionati").
  - [ ] Eliminazione massiva filtrata (`deleteMany`).

---

## 5. 📑 Selezione Avanzata, Statistiche Excel & Clipboard

- [ ] **Selezione Celle Stile Foglio di Calcolo:**
  - [ ] Selezione singola cella, blocchi rettangolari con Shift+Clic o trascinamento, intere colonne o righe.
  - [ ] Selezione globale (Ctrl+A).
  - [ ] Istanze di selezione completamente indipendenti per ciascuna griglia aperta (Dati, Split-View, Risultati).
- [ ] **Scorrimento Automatico ai Bordi (Edge Scrolling):**
  - [ ] Scorrimento automatico continuo durante il trascinamento della selezione oltre i bordi della griglia.
  - [ ] Supporto completo per eventi Touch su dispositivi mobili (cattura esplicita del puntatore su `tbody`, soglia minima 10px e area di attivazione allargata a 72px).
- [ ] **Pannello Statistiche Matematiche Immediate:**
  - [ ] Calcolo in tempo reale per le celle numeriche selezionate: Conteggio, Somma ($\Sigma$), Media ($\bar{x}$), Minimo, Massimo, Mediana, Deviazione Standard.
  - [ ] Algoritmo di compensazione di Kahan per preservare la precisione numerica in virgola mobile.
  - [ ] Esecuzione su **Web Worker** dedicato per selezioni superiori a 50.000 celle (con fallback locale e sequenziatore anti-sovrapposizione).
- [ ] **Copia / Incolla Multi-Formato:**
  - [ ] Copia negli appunti in formato **TSV** (compatibile con Excel e Google Sheets), **CSV**, **JSON** ed **INSERT SQL**.
  - [ ] Incolla intelligente di valori singoli o matrici tabellari su griglie scrivibili.
- [ ] **Grafico Rapido della Selezione:** Generazione istantanea di un grafico ECharts direttamente dalle righe e colonne selezionate (con deduzione asse X temporale/ordinale e raggruppamento automatico).

---

## 6. 🗺️ Geometrie & Mappe GIS (Leaflet & GeoJSON)

- [ ] **Riconoscimento Automatico Tipi Geometrici:**
  - [ ] Supporto GeoJSON, PostGIS (`GEOMETRY`, `GEOGRAPHY`), tipi geometrici nativi PostgreSQL e MySQL (`POINT`, `LINESTRING`, `POLYGON`, `MULTIPOINT`, `MULTILINESTRING`, `MULTIPOLYGON`, `GEOMETRYCOLLECTION`).
  - [ ] Rilevamento geometrie al 1° livello, in sottodocumenti fino a 2 livelli di profondità e dentro array.
  - [ ] Resa grafica compatta nella cella con badge `type-geo` ed etichetta descrittiva del tipo.
- [ ] **Editor Geografico Interattivo (Leaflet 1.9.4 vendorizzato):**
  - [ ] Disegno e modifica visuale di geometrie su mappa.
  - [ ] Canvas a doppio layer ottimizzato per il trascinamento fluido dei vertici.
  - [ ] Funzionamento offline su sfondo neutro con opzione per caricare i tile OpenStreetMap.
  - [ ] Sincronizzazione bidirezionale in tempo reale tra la mappa e il testo GeoJSON grezzo.
- [ ] **Visualizzatore Multi-Geometrie su Mappa:**
  - [ ] Modale per visualizzare simultaneamente tutte le geometrie presenti in una selezione di celle.
  - [ ] Elenco laterale interattivo (clic sulla riga per centrare la forma e clic sulla forma per evidenziare la riga).
  - [ ] Calcolo geodetico di lunghezze e aree sulla sfera WGS84.
  - [ ] Esportazione cumulativa in formato FeatureCollection GeoJSON.
- [ ] **Scheda 🗺 Mappa nei Risultati Query:** Comparsa automatica della scheda Mappa nei risultati della tab ⚡ se il result set contiene colonne o proprietà geometriche.

---

## 7. 🔗 Relazioni & Chiavi Esterne (Pannello FK)

- [ ] **Rilevamento Relazioni:**
  - [ ] **Vincoli Dichiarati:** Lettura delle Foreign Key formali definite nel catalogo SQL.
  - [ ] **Relazioni Euristiche Implicite:** Deduzione euristica automatica su MongoDB e SQL basata su convenzioni di naming (es. `user_id`, `id_prodotto`) e tipi ObjectId.
- [ ] **Badge Indicatore in Griglia:** Icona 🔗 (vincolo formale) o ≈ (relazione euristica) posizionata accanto alle celle collegate.
- [ ] **Pannello Laterale a Scorrimento ("Scegli un Riferimento"):**
  - [ ] Apertura non-modale: la cella rimane attiva e modificabile.
  - [ ] Visualizzazione dell'intero record genitore collegato.
  - [ ] Elenco cercabile in tempo reale delle righe della tabella esterna tra cui selezionare il nuovo valore da assegnare.
  - [ ] Pulsante per aprire direttamente la tabella collegata in una nuova scheda.
  - [ ] Ridimensionamento bidirezionale con maniglie e supporto drawer per mobile.

---

## 8. ⚡ Query Engine & Runner Script (Tab ⚡)

- [ ] **Motore di Esecuzione Multi-Dialetto:**
  - [ ] **SQL Diretto:** Esecuzione query native su MySQL e PostgreSQL.
  - [ ] **MQL Diretto:** Query JSON e pipeline di aggregazione MongoDB (`aggregate`).
  - [ ] **Mongo Shell Sintassi Nativa:** Parser ed interprete `db.<coll>.find(...)`, `db.<coll>.aggregate(...)`, comandi di inserimento, aggiornamento e cancellazione.
  - [ ] **SQL-to-MQL Translator:** Traduzione automatica di query SQL `SELECT` (con `JOIN`, `GROUP BY`, `HAVING`, `UNION`, sottoquery) e DDL in pipeline e comandi MongoDB nativi.
  - [ ] **Cross-DB Virtual JOIN Engine:** Esecuzione di JOIN virtuali in memoria cross-database tra tabelle SQL e collezioni MongoDB.
  - [ ] **Interprete AST JS Sicuro (`MongoScript`):** Esecuzione sicura di script shell JavaScript senza `eval`/`new Function`, con quote di passi, ricorsione e tempo.
- [ ] **Editor Query Avanzato:**
  - [ ] Gutter con numeri di riga sincronizzati.
  - [ ] Syntax Highlighting dinamico.
  - [ ] Selettore del motore di destinazione (⚡ Auto-detect, MySQL, PostgreSQL, MongoDB, Cross-DB).
  - [ ] Metriche in tempo reale (Stato, Tempo di esecuzione in ms, Record estratti).
  - [ ] Tetto di tempo sulle query (`CODEDB_AGGREGATE_TIMEOUT_MS`) con cancellazione sicura (`statement_timeout` su PostgreSQL, `KILL QUERY` su MySQL con distruzione della connessione compromessa).
  - [ ] Pulsante Annulla Query in esecuzione con propagazione dell'`opHandle` e arresto lato DBMS.
- [ ] **Runner Script Multi-Istruzione:**
  - [ ] Esecuzione istruzione per istruzione con separatore `;`.
  - [ ] Avanzamento in tempo reale tramite notifiche push Socket.IO (`script:progress`).
  - [ ] Opzione "Ferma al primo errore".
  - [ ] Controlli di esecuzione: Pausa, Pausa Forzata (interruzione lato server), Riprendi, Interrompi definitivamente.
  - [ ] Schede Risultati per singola istruzione con archiviazione su file temporanei protetti (evita saturazione della memoria RAM).
- [ ] **Gestione File SQL Grandi (Chunking Engine):**
  - [ ] Caricamento file `.sql` o `.queries` di grandi dimensioni (decine o centinaia di MB).
  - [ ] Suddivisione automatica in chunk logici eseguibili.
  - [ ] Navigatore chunk con barra di avanzamento ed esecuzione sequenziale completa.
- [ ] **Cronologia Query & Snippet Manager:**
  - [ ] Cronologia query per tab e persistente.
  - [ ] Libreria Snippet & Template predefiniti e personalizzati.
  - [ ] Coda delle query in sospeso con badge nell'header e modale di gestione/pulizia.

---

## 9. 🖥️ Visualizzazione Risultati

- [ ] **Scheda Tabella:** Vista a griglia con ordinamento, selezione celle, statistiche e formattazione tipi.
- [ ] **Scheda JSON Tree:** Vista ad albero gerarchico esplorabile per documenti nidificati complessi e BSON.
- [ ] **Scheda Grafici (ECharts):** Generazione immediata di grafici dai risultati della query.
- [ ] **Scheda Mappa:** Visualizzazione cartografica automatica dei dati spaziali presenti nel result set.
- [ ] **Esportazione Risultati:**
  - [ ] Esportazione rapida in **CSV**.
  - [ ] Esportazione in **JSON** (EJSON formattato).
  - [ ] Esportazione in **SQL INSERT**.

---

## 10. 📈 Custom Charts & Visualizzazione Dati (ECharts 6.1.0)

- [ ] **Tipi di Grafico Supportati:**
  - [ ] Barre (verticali, orizzontali, impilate, percentuali 100%).
  - [ ] Linee & Aree (lineari, curve spline, a gradini, aree sfumate).
  - [ ] Torta & Ciambella (Donut, Rose/Nightingale).
  - [ ] Dispersione (Scatter plot) & Bolle (Bubble chart con 3° dimensione).
  - [ ] Radar (Kiviat diagram).
  - [ ] Heatmap (Mappa di calore su matrice di categorie/date).
  - [ ] Indicatori Gauge (Tachimetri) & Funnel (Imbuto di conversione).
  - [ ] Treemap (Mappe ad albero gerarchiche).
- [ ] **Barra Rapida di Configurazione:** Selezione istantanea di Asse X / Categoria, Misura / Serie Y, Funzione di aggregazione (Somma, Media, Conteggio, Min, Max, Primo valore).
- [ ] **Suggerimenti Automatici:** Riconoscimento intelligente della forma dei dati ed elenco grafici consigliati con un clic.
- [ ] **Pannello di Personalizzazione Avanzata (Builder):**
  - [ ] Titoli, sottotitoli e allineamento.
  - [ ] Configurazione assi (scale lineari, logaritmiche, temporali, limiti min/max).
  - [ ] Legenda, Tooltip interattivi, Griglia e Margini.
  - [ ] Tavolozze di colori tematiche accessibili (conformi ai contrasti WCAG).
  - [ ] Editor Override JSON per personalizzazioni avanzate dell'Option ECharts.
- [ ] **Esportazione Grafici:**
  - [ ] Download come immagine ad alta risoluzione **PNG**.
  - [ ] Download configurazione come **Option ECharts JSON**.

---

## 11. 🕸️ Viste Architetturali dello Schema (UML & Grafo 3D)

- [ ] **Diagramma UML E-R (SVG Nativo):**
  - [ ] Generazione automatica diagramma entità-relazione in grafica vettoriale SVG.
  - [ ] Rappresentazione tabelle/collezioni, attributi primari, indici e frecce di relazione.
  - [ ] Zoom, pan e rigenerazione su richiesta.
- [ ] **Vista Grafo 3D Interattivo (Three.js & 3D Force-Graph):**
  - [ ] Visualizzazione tridimensionale dell'intero database con fisica delle forze.
  - [ ] Alternanza tra vista 3D prospettica e vista 2D piana ortogonale.
  - [ ] Modalità di colorazione nodi per Prefisso/Schema o per Grado di Centralità.
  - [ ] Filtro di prossimità per Hop (Mostra tutti, vicini di 1° livello, vicini di 2° livello).
  - [ ] Filtro tabelle popolate (nasconde tabelle con 0 record).
  - [ ] Toggle per visualizzare o nascondere le relazioni implicite euristiche.
  - [ ] Rotazione automatica 3D e reset orientamento camera.
  - [ ] Barra di ricerca per evidenziare tabelle e campi nel grafo.
  - [ ] Pannello laterale informativo al clic sul nodo (dettagli colonne, tipi, vincoli, tabelle collegate).

---

## 12. 🩺 Diagnostica & Strumenti di Analisi Schema

- [ ] **Audit Schema & Health Check:** Diagnostica automatica dello schema del database (rilevamento tabelle senza chiave primaria, colonne orfane, indici ridondanti o mancanti su FK, anomalie di tipo).
- [ ] **Ricerca Cammino Minimo (Shortest Path BFS):** Calcolo algoritmico del percorso di JOIN più breve tra due tabelle qualsiasi ed evidenziazione visiva nel Grafo 3D.
- [ ] **Matrice delle Dipendenze & Ordine di Popolamento (Seeding Order):** Ordinamento topologico dei nodi per determinare l'ordine corretto di inserimento o svuotamento dati senza violare i vincoli di integrità referenziale.
- [ ] **Schema Diff (Confronto con Snapshot):** Salvataggio di snapshot JSON dello schema e confronto visuale con lo schema attivo (rilevamento tabelle aggiunte, rimosse o modificate).
- [ ] **Importazione Schema Standalone:** Generazione del Grafo 3D da file DDL SQL (`CREATE TABLE`) o script DBML incollati senza connessione a DB reale.
- [ ] **Esportazione Multi-Formato dello Schema:**
  - [ ] Esportazione diagramma in sintassi **Mermaid** (`erDiagram`).
  - [ ] Esportazione in formato **DBML** (compatibile con dbdiagram.io).
  - [ ] Esportazione **DDL SQL CREATE TABLE**.
  - [ ] Snapshot grafico in **PNG**.

---

## 13. 🪟 Split-View (Pannelli Affiancati)

- [ ] **Layout ad Albero Immutabile N-Ario:** Affiancamento orizzontale o verticale di più tabelle o collezioni nello stesso spazio di lavoro.
- [ ] **Supporto Drag & Drop:** Trascina schede o tabelle dall'albero per creare nuovi riquadri affiancati.
- [ ] **Ridimensionamento Fluido:** Separatori con gestione Pointer Events senza scatti.
- [ ] **Indipendenza dei Riquadri:** Ogni riquadro mantiene la propria griglia virtualizzata, paginazione, filtro rapido, ordinamento, selezione celle, modifiche inline e pannello chiavi esterne.

---

## 14. 💡 IntelliSense & Autocompletion Consapevole dello Schema

- [ ] **Completamento Contestuale Guidato dal Cursore:**
  - [ ] Proposta di tabelle/collezioni dopo `FROM` o `JOIN`.
  - [ ] Proposta di sole colonne relative alla tabella identificata dopo alias (es. `u.`).
  - [ ] Proposta collezioni dopo `db.`.
  - [ ] Proposta metodi shell dopo `db.<coll>.`.
  - [ ] Proposta operatori MQL dopo `$`.
- [ ] **Deduzione Linguaggio dal Testo (`motoreDalTesto`):** Riconoscimento automatico della sintassi (SQL vs MQL vs Shell) basato sul frammento di codice in scrittura.
- [ ] **Vocabolari di Dialetto Specifici:** Funzioni e clausole dedicate (`GROUP_CONCAT` per MySQL, `STRING_AGG`/`RETURNING` per PostgreSQL, funzioni aggregate per SQL-to-MQL).
- [ ] **Quotatura Intelligente degli Identificatori (`quotaIdentificatore`):** Aggiunta automatica di virgolette doppie `"` su PostgreSQL (risolve il problema dell'abbassamento maiuscole) e backtick su MySQL.
- [ ] **Cache Schema Multi-Database:** Inserimento asincrono e invalidazione immediata a ogni comando DDL eseguito o evento `schema:changed`.

---

## 15. 🔍 Parser, Linter, Formattatore e Minificatore JSON/BSON

- [ ] **Parser Tollerante alla Shell:** Supporto per chiavi non quotate, apici singoli, costruttori shell (`ObjectId(...)`, `ISODate(...)`, `NumberLong(...)`, regex `/.../`, commenti `//` e `/* */`).
- [ ] **Preservazione Letterale dei Token:** Nessuna perdita di precisione per interi a 64 bit (non soffre del limite dei 53 bit di `JSON.parse`).
- [ ] **Linting Sintattico in Tempo Reale:** Notifica istantanea di errori di sintassi con riga e colonna cliccabili negli editor e nei moduli di inserimento/modifica.
- [ ] **Formattatore Codice (Ctrl+Shift+F):** Indentazione pulita e leggibile per JSON, BSON e SQL.
- [ ] **Minificatore Codice (Ctrl+Shift+M):** Compattazione su singola riga.

---

## 16. 📦 Import / Export Avanzato

- [ ] **Export Tabellare & Collection:** Download dati in CSV, TSV, JSON, JSONL o script INSERT SQL.
- [ ] **Import Tabellare:** Caricamento file o incolla testo con rilevamento automatico delimitatori e formati, barra di avanzamento e report esito.
- [ ] **Export & Import Intero Database (`.codedb.json`):**
  - [ ] Backup/Export completo di tutte le tabelle/collezioni e metadati in un unico archivio strutturato.
  - [ ] Importazione con opzione per eliminare e ricreare (DROP) gli oggetti o effettuare upsert per chiave.
  - [ ] Monitoraggio dell'avanzamento operazione in tempo reale tramite WebSocket.

---

## 17. 💾 Sistema di Backup & Ripristino (UI & CLI)

- [ ] **Tipologie di Backup:**
  - [ ] **FULL:** Dump integrale del database e dei metadati.
  - [ ] **INCREMENTALE:** Salvataggio delle sole modifiche dall'ultimo backup (basato su campo data o checkpoint).
  - [ ] **DIFFERENZIALE:** Salvataggio delle modifiche dall'ultimo backup FULL.
- [ ] **Caratteristiche di Sicurezza & Storage:**
  - [ ] Manifest JSON con checksum crittografico SHA-256 per ogni file.
  - [ ] Compressione Gzip integrata con livello configurabile (1-9) o disattivabile.
  - [ ] Supporto Cloud Storage per destinazioni remote (AWS S3, Google Cloud Storage, Azure Blob Storage).
  - [ ] Notifiche webhook Slack al completamento del job.
  - [ ] Isolamento tenant per i percorsi di backup (`BACKUP_ROOT/tenants/<ownerId>`).
- [ ] **Ripristino Sicuro (Restore Engine):**
  - [ ] Selezione da Catalogo Backup con albero catena di ripristino.
  - [ ] Validazione di sicurezza DDL in ripristino (`assertSafeSchemaSql`).
  - [ ] Opzione per DROP preliminare o ripristino per chiave (upsert).
  - [ ] Avanzamento e log in tempo reale tramite push `backup:progress`.
- [ ] **CLI di Backup Standalone (`npm run backup -- <cmd>`):**
  - [ ] Comandi `backup`, `restore`, `list`, `verify`, `help` eseguibili da terminale o crontab.

---

## 18. 🩺 Monitor Sessioni, Lock Detection & Salute Server

- [ ] **Monitor di Salute Connessioni (CodeDB Health):**
  - [ ] Controllo in tempo reale di tutte le connessioni aperte nell'applicativo.
  - [ ] Monitoraggio latenza ping in millisecondi, stato tunnel SSH e pool di connessioni con auto-refresh a 4s.
- [ ] **Monitor Sessioni & Lock del DBMS (Server Sessions):**
  - [ ] Ispezione di tutte le sessioni e query attive sul server di database (anche di altri client).
  - [ ] **Verdetto Automatico Lock ("Chi blocca chi"):** Identificazione algoritmica della catena di blocco e indicazione immediata del processo che detiene il lock esclusivo.
  - [ ] Terminazione sicura (Kill Query / Kill Connection) dei processi bloccanti.
  - [ ] Protezione: esclusione e conteggio separato per le connessioni di servizio e i socket propri di CodeDB (non terminabili accidentalmente).

---

## 19. 📜 Storico Azioni & Audit Log

- [ ] **Registro Centralizzato Operazioni Critiche:**
  - [ ] Tracciamento strutturato di tutte le operazioni di scrittura, DDL, modifiche dati, drop, backup, restore ed esecuzioni query.
  - [ ] Registrazione separata per UI (`ui-audit.log`) e AI Gateway (`mcp-audit.log`) con isolamento per tenant.
- [ ] **Interfaccia Visuale Storico Azioni:**
  - [ ] Filtro per Categoria (Scritture ✏️ / Letture 👁).
  - [ ] Filtro per Tipo Evento specifico (`db:create`, `collection:drop`, `doc:update`, `backup:restore`, ecc.).
  - [ ] Filtro per Esito (Successo / Errore) e per nome Database.
  - [ ] Paginatore storico con selezione righe (25, 50, 100, 200).

---

## 20. 👥 RBAC (Controllo Accessi Basato su Ruoli) & Sottoutenti

- [ ] **Attivazione Sicura (`CODEDB_RBAC=on`):** Control plane isolato su database applicativo dedicato.
- [ ] **Autenticazione & Sessioni:** Login con credenziali cifrate, token opachi (SHA-256) e revoca a caldo dei socket connessi (`rivalidaPrincipal`).
- [ ] **Gestione Sottoutenti:** Creazione, modifica password e disattivazione account dipendenti/collaboratori.
- [ ] **Assegnazione Permessi Granulari (Grants):**
  - [ ] Ruoli predefiniti e personalizzabili: `admin`, `readwrite`, `readonly`, `ddl`, `delete`, `manage`.
  - [ ] **Scope Glob su Database e Tabelle:** Limitazione dell'accesso a specifici database e pattern di collezioni/tabelle (es. `orders_*`, `public.*`).
- [ ] **Proxy Autorizzante lato Backend (`guardStrategy.js`):**
  - [ ] Blocco dell'accesso I/O al filesystem host (`INTO OUTFILE`, `LOAD DATA`, `LOAD_FILE`).
  - [ ] Verifica `sqlTables.js` su ogni tabella citata nelle query libere.
  - [ ] Forzatura clausole di sicurezza `sqlClause.js`.
  - [ ] Transazioni `READ ONLY` applicate forzatamente lato DBMS per query di sola lettura.
- [ ] **Gestione API Key per Agenti AI:** Generazione, limitazione scope di connessione ed invalidazione chiavi `cdb_...`.

---

## 21. 🤖 Gateway MCP (Model Context Protocol per Agenti AI)

- [ ] **Integrazione Standard MCP:** Server MCP integrato tramite SDK ufficiale su trasporto Streamable HTTP (`POST/GET/DELETE /mcp`) con supporto API Key e RBAC.
- [ ] **19 Tool Esposti per Client AI (Claude, Cursor, Codex, ecc.):**
  - [ ] `list_saved_connections`: Elenco connessioni disponibili al modello (senza password).
  - [ ] `connect_database` / `disconnect_database`: Apertura e chiusura sessioni DB.
  - [ ] `get_databases_and_collections`: Esplorazione topologia.
  - [ ] `get_schema`: Recupero schema completo e relazioni per generazione query precise.
  - [ ] `execute_query`: Esecuzione query in sola lettura con transazione `READ ONLY` forzata e tetti di sicurezza.
  - [ ] `execute_write`: Esecuzione scritture protette con **protocollo di conferma a 2 passaggi** (`confirm_token` human-in-the-loop, scadenza 5 minuti).
  - [ ] `set_connection_read_only`: Modifica sicura del flag di sola lettura con doppia conferma.
  - [ ] `get_shortest_path`: Calcolo cammino minimo BFS tra entità.
  - [ ] `analyze_dependencies`: Calcolo matrice dipendenze e ordine topologico.
  - [ ] `analyze_pii`: Rilevamento automatico dati personali/sensibili e conformità GDPR.
  - [ ] `audit_schema`: Diagnostica salute schema.
  - [ ] `filter_empty_tables`: Rilevamento tabelle prive di dati.
  - [ ] `get_graph`: Estrazione grafo completo nodi/archi.
  - [ ] `backup_database`: Avvio job di backup via AI.
  - [ ] `list_backups`: Consultazione catalogo backup.
  - [ ] `verify_backup`: Verifica integrità e checksum backup.
  - [ ] `restore_backup`: Ripristino backup con token di conferma.
  - [ ] `import_database_artifact`: Importazione artefatto database.
- [ ] **Risorse MCP (`schema://{connectionId}/{db}`):** Diagramma Mermaid ER dinamico + Dizionario Dati sempre aggiornato.
- [ ] **Prompt Parametrizzati MCP:** `genera-report`, `esplora-database`.

---

## 22. 🎨 Sistema Temi, UI/UX, Accessibilità & Scorciatoie

- [ ] **Gestione Temi Istantanea (Anti-FOUC):**
  - [ ] Temi integrati: **Scuro**, **Chiaro**, **Auto** (segue il sistema operativo).
  - [ ] Editor Temi Personalizzati con anteprima dal vivo sull'app reale.
  - [ ] Verifica contrasti colore secondo gli standard **WCAG**.
  - [ ] Esportazione ed importazione temi in formato JSON.
- [ ] **Command Palette Rapida (Ctrl+P):**
  - [ ] Ricerca unificata virtualizzata ad altissima velocità su comandi, connessioni, database e tutte le tabelle.
  - [ ] Filtri con richiami: `>` per comandi, `#` per database, `@` per tabelle/collezioni.
- [ ] **Scorciatoie da Tastiera Interattive:**
  - [ ] Modale di consultazione di tutte le scorciatoie (Editor, Griglia, Navigazione, Schede).
  - [ ] Possibilità di rimappare le scorciatoie con salvataggio per tenant.
- [ ] **Layout Adattivo Mobile & Tablet:**
  - [ ] Drawer laterali a comparsa per barra connessioni e schema database.
  - [ ] Barra di navigazione inferiore per dispositivi touch (**Connessioni**, **Database**, **Query**, **Salute**).
- [ ] **Onboarding, Tour Guidato & Novità:**
  - [ ] Giro guidato interattivo dell'interfaccia.
  - [ ] Checklist interattiva primi passi.
  - [ ] Hub documentazione integrato e resoconto novità di versione.

---

## 23. 🖥️ Desktop App (Electron), Aggiornamenti & Architettura

- [ ] **Integrazione Electron Nativa:**
  - [ ] Server Node.js incorporato in-process avviato su porta dinamica libera.
  - [ ] Single-Instance Lock (impedisce istanze duplicate sovrapposte).
  - [ ] Cartella dati utente isolata in `userData`.
- [ ] **Auto-Updater Desktop:** Controllo e download aggiornamenti automatici da GitHub Releases o server statici HTTPS via `electron-updater`.
- [ ] **Sicurezza di Rete del Server:**
  - [ ] `assertTransportSafe`: Rifiuto avvio su interfacce esterne senza reverse proxy HTTPS (`CODEDB_TRUST_PROXY_TLS=1`).
  - [ ] `assertAuthSafe`: Rifiuto avvio su rete senza RBAC abilitato (salvo override esplicito).
  - [ ] Protezione da attacchi DNS-Rebinding tramite validazione Origin/Host.
  - [ ] Blocco totale di script JavaScript lato server su MongoDB (`$where`, `mapReduce`).
- [ ] **Tooling & Build Multi-Piattaforma:**
  - [ ] Generazione installer Windows (`.exe` NSIS), macOS (`.dmg`), Linux (`.AppImage`, `.deb`) e build Docker.
  - [ ] Generazione automatica licenze da `MANLEVA.md` e pacchetti dipendenze.
  - [ ] Launcher invisibili in background multipiattaforma (`CodeDB.cmd`, `./codedb.sh`).
  - [ ] Verifica marcatori di provenienza AGPL-3.0 (`tools/impronte.js`).
