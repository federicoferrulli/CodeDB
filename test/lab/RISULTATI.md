# Registro dei difetti — laboratorio del 21 ottobre 2026

Questa campagna aggiunge test e corregge fixture di test. I difetti applicativi
restano aperti: non sono stati aggiunti bypass, disabilitazioni o `xfail`.
Le prove sono eseguite su database Docker dedicati, con confronto indipendente
dei dati persistiti. I report grezzi sono in `.scratch/lab-reports`.

## Consuntivo eseguito

Avvio completo verificato con `lab:prepara`, poi `lab:nuovi`: staging filtrato,
copia nel volume, dipendenze Linux, build UI e Chromium. La seconda copia ha
verificato anche l'aggiornamento del bind mount senza ricreare il runner.

| Nuova suite applicativa, esecuzione Docker | Verifiche | Superate | Fallite |
|---|---:|---:|---:|
| Query, CRUD, tipi, creazione e concorrenza | 80 | 70 | 10 |
| MCP MongoDB reale | 28 | 28 | 0 |
| MCP MySQL/PostgreSQL reali | 42 | 40 | 2 |
| Backup, restore, export/import complessi | 43 | 27 | 16 |
| Browser sui tre DBMS | 42 | 40 | 2 |
| Regressione menu/dialoghi | 4 | 2 | 2 |
| **Totale** | **239** | **207** | **32** |

I 32 fallimenti rappresentano **11 classi confermate**, descritte sotto, non
32 problemi indipendenti. I risultati completi sono in
`.scratch/lab-reports/docker/nuovi/`; gli stessi difetti sono stati osservati
anche dalle prove sull'host Windows.

Ulteriori verifiche superate: unitari completi e TypeScript su host e Linux;
otto controlli dell'infrastruttura su Windows e Linux; classificazione dei
processi e handshake interrotto. Rilevati tutti i guasti deliberati di query
(3), MCP (2), infrastruttura (2), classificatore/connessione (2), oltre alle
alterazioni reali di copie e archivi e ai tre controlli di precisione browser.
La sensibilità dimostra che gli oracoli rilevano quei guasti specifici.

La prima campagna storica ha eseguito **159 suite: 134 superate, 23 fallite,
una incompleta e un timeout**. Il report originale è conservato, senza
riscriverlo dopo le correzioni delle fixture: `docker/esecuzione.json`.
Il dettaglio dei prerequisiti e dei candidati è in `TRIAGE_LEGACY.md`.

La ripetizione mirata Docker ha chiuso **12/12 suite**: dieci nel batch
`docker/ripetizioni`, le ultime due dopo correzione delle fixture nel batch
`docker/ripetizioni-finali`. Comprende le otto fixture UI corrette, i 50 tipi
MySQL, 103 tipi PostgreSQL e 21 tag BSON del test inserimenti, lo snapshot
durante scritture concorrenti, l'import con autorizzazione MongoDB reale e
1.188 bersagli mobile (176,7 s, nessun errore JavaScript). Non è una seconda
esecuzione integrale delle 159 suite. Resta una decisione UX aperta: se il
navigatore Database debba riaprirsi dopo aver chiuso il selettore del tema.

Profilo nativo separato: **18/18 fasi di failover reale** superate e guasto del
quorum rilevato; 117 istruzioni SQL native, sessioni, audit e UI; 56 esecuzioni
mongosh con cambio primario e UI; confronti tipi/cataloghi su PostgreSQL 18.
Le prove native usano report distinti `native`, `native-ui`, `native-mongosh`
e `native-pg18`, senza sommare le ripetizioni come nuova copertura.

## Prestazioni osservate

Linux Node 24.22.0, MongoDB 8.0.34, MySQL 8.4.11, PostgreSQL 17.5:
20.017 righe per DBMS recuperate su 41 pagine con hash esatto. Su 48 query
concorrenti per motore, p95 rispettivamente **26 / 34 / 21 ms**; endpoint
salute p95 **21 / 3 / 3 ms**. Dodici cicli di connessione/disconnessione
per motore non hanno lasciato connessioni attive in più.

Nel browser, 1.203 righe producono 25 righe DOM e l'ultima è raggiungibile.
Durante query SQL realmente lente, l'intervallo massimo del controllo di
reattività è stato 37,9 ms su MySQL e 35 ms su PostgreSQL. I grafici sono
verificati sui valori disegnati, non sulla sola presenza del canvas.
Sono misure locali di questi scenari, non un SLA o una prova di lunga durata.

## Difetti riprodotti

| ID | Priorità | Percorso e comportamento osservato | Riproduzione/evidenza |
|---|---|---|---|
| LAB-001 | P1, integrità dati | **MySQL VARBINARY e PostgreSQL BYTEA** diventano oggetti con chiavi numeriche nel trasporto. Salvare la riga appena letta converte i byte in testo JSON. Le PK binarie non ritrovano la riga durante update. Lo stesso tipo perso è visibile via MCP. | `query.cjs`, `mcp-sql.cjs`; report query/MCP. Caso: `00ff80275c0a` → byte UTF-8 di `{"0":0,"1":255,...}`. Percorso comune `db/sqlValori.js`, serializzazione Buffer senza Binary. |
| LAB-002 | P2, scritture bloccate | **PostgreSQL INT[]/TEXT[]** vengono letti correttamente, ma `doc:update` e `doc:replace` convertono l'array JS in stringa JSON; il DBMS rifiuta `[1,null,3]` come array SQL. | `query.cjs`; due verifiche indipendenti update/replace. Percorso `db/sqlValori.js`, `toSqlValue`. |
| LAB-003 | P1, backup incompleto dichiarato riuscito | **Incrementale PostgreSQL con TIMESTAMP senza fuso**: dopo full con una riga, INSERT con CURRENT_TIMESTAMP; CLI Europe/Rome e sessione UTC. L'incrementale termina con successo ma contiene zero righe anziché una. | `integrita.cjs`, caso minimo e manifest in `integrita-artifacts`; `integrita.json.diagnosticaTemporale`. |
| LAB-004 | P1, ripristino bloccato | **Indici PostgreSQL** ordinari/parziali finiscono nell'elenco di chiavi esterne dell'archivio. Il restore respinge `CREATE INDEX` perché in quella sezione ammette solo `ALTER TABLE`. | `integrita.cjs`; `backup/lib/engine.js` inserisce `aux.indexes` in `objects.foreignKeys`; rifiuto in `db/artefatti.js`. |
| LAB-005 | P1, ripristino catene bloccato | **View MySQL/PostgreSQL nelle catene**: il restore riesegue CREATE VIEW a ogni layer e fallisce con `already exists`, anche in una fixture minima. | `integrita.cjs`, incremental e differential, casi minimi separati sui due motori; `backup/lib/restore.js`. |
| LAB-006 | P2, verifica metadati errata | **Validator MongoDB con default impliciti**: restore e import materializzano `validationLevel=strict` e `validationAction=error`; il confronto respinge questi default equivalenti. | `integrita.cjs`: caso implicito rosso; caso esplicito verde con gli stessi documenti BSON e tutti i percorsi. |
| LAB-007 | P1, ripristino bloccato | **Schema MySQL**: FK ricreata davvero nello staging risulta mancante alla verifica; SHOW CREATE esprime charset equivalenti in modo diverso e il confronto DDL fallisce. | `integrita.cjs`, cataloghi nativi conservati. `backupRestoreAdapter.schemaOf` usa il `tableAuxDdl` ereditato vuoto per MySQL. |
| LAB-008 | P2, verifica DDL errata | **Colonne generate PostgreSQL**: restore full fallisce confronto DDL anche senza indice aggiuntivo. Il catalogo nativo conserva tipi ed espressione generata; i due descrittori dello schema divergono. | `integrita.cjs`; `PostgreSqlStrategy.tableDdl` e `pgCreateTable`. Sintomo confermato; attribuzione da isolare ulteriormente durante il fix. |
| LAB-009 | P2, UI | **Menu contestuale durante chiusura dialoghi**: dopo modifica/duplicazione, il menu si apre durante `closing`, poi scompare quando il portal lo sposta. Gli elementi restano nel DOM ma invisibili. | `dialog-menu.cjs`: due controlli passano dopo chiusura completa, due regressioni falliscono durante la transizione. JSON DOM e screenshot; `ui/dialogs.tsx`. |
| LAB-010 | P2, UI/mappa | **Mappa e resize**: selezione/zoom, cambio a 390 px, query e riapertura producono `Invalid LatLng object: (NaN, NaN)` e possono lasciare canvas 0×0 con geometrie presenti. | `browser.cjs`, errori runtime e screenshot; stack `geo-vista.js`/Leaflet `invalidateSize`/`_animMoveEnd`. |
| LAB-011 | P1, creazione bloccata | **Creazione collezioni MongoDB**: i campi di trasporto `db`, `name`, `tabId` arrivano fra le opzioni del comando nativo. MongoDB rifiuta `create.db`/`create.tabId` come campi sconosciuti; la collezione non viene creata. | Baseline `e2e.js` e riproduzione indipendente `.scratch/lab-triage/mongo-create.json`; driver nativo verde, Socket.IO rosso. `server/eventi-dati.js` → `MongoDbStrategy.createCollection`. |

Gli errori di tipo binario sono una classe comune a più ingressi e motori, non
sei difetti indipendenti. Analogamente i fallimenti di backup possono arrestare
più scenari a causa dello stesso problema. Le priorità riflettono l'effetto
osservato: perdita silenziosa prima di operazioni bloccate e regressioni UI.

## Correzioni limitate alle fixture

- Il test unitario della connessione PostgreSQL presumeva che `localhost:5432`
  fosse spento o senza password. Ora usa un endpoint temporaneo del test che
  interrompe l'handshake; falsa riuscita deliberata rilevata.
- Le fixture SQL con password vuota fissa leggono ora le credenziali dedicate
  dall'ambiente, conservando il precedente default quando non configurate.
- `e2e-arc-campi`: onboarding inizializzato prima dell'app, evitando il controllo
  prematuro della sua visibilità.
- `e2e-cronologia-posizione`: attesa del focus effettivo dopo Home prima di Enter.
- `e2e-icone-uniformi`: l'inizializzazione non rimuove dal DOM un overlay che può
  contenere il menu condiviso nel portal.
- `e2e-rbac-ui`: chiusura del vero dialogo mobile e attesa della fine transizione.
- `e2e-query-select`: contesto DBMS coerente con il motore selezionato e verifica
  delle opzioni correttamente disabilitate; report fuori dalle cartelle storiche.
- `e2e-sql-integrita-ui`: controllo TEXT riconosciuto come textarea e invio
  dell'evento input richiesto dal normale inserimento.
- `e2e-griglia-viste`: connessione simulata applicata anche alla cornice tramite
  `renderWorkspace`; il benvenuto non occupa più lo spazio della Split-View.
- `e2e-uml-progetto-regressioni`: stato onboarding impostato prima del caricamento,
  evitando che un dialogo tardivo nasconda il progettista ai locator accessibili.
- `e2e-insert-types`: credenziali anche nella preparazione nativa e ripristino
  del `sql_mode` globale alla fine della prova.

Le otto fixture UI sono state rieseguite con successo nel Chromium Docker.
Il difetto del menu durante la chiusura resta rosso nel nuovo test dedicato.

## Limiti della conclusione

L'installazione pulita ha anche segnalato un advisory npm di gravità alta,
`GHSA-c475-qrg2-pj4r`, sul parser di liste FTP di `basic-ftp`; npm conta sette
pacchetti coinvolti nella catena transitiva mongosh/proxy. Non sono sette
vulnerabilità indipendenti e non è stata dimostrata la raggiungibilità da
CodeDB. Nessun aggiornamento automatico applicato. Evidenza completa:
`.scratch/lab-reports/docker/npm-audit.json`.

Una suite verde dimostra i casi eseguiti, non l'assenza di difetti nell'intera
piattaforma. Le prove native comprendono PostgreSQL 18 oltre al PostgreSQL 17
del laboratorio principale e failover MongoDB a tre nodi. Gli installer/store,
gli aggiornamenti distribuiti, i servizi cloud con account reali e i dispositivi
Android richiedono profili e ambienti distinti. I tempi locali sotto carico
concorrente non sono una certificazione delle prestazioni.
