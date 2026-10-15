# Audit approfondito SQL e MQL — 14 ottobre 2026

Dieci classi di difetti confermate e corrette: quattro di severità alta e sei
media. Nessun rilievo confermato resta aperto nell'ambito verificato. Questo
rapporto riguarda il checkout locale, incluse le modifiche precedenti; non
certifica ogni sintassi, versione, estensione o configurazione dei DBMS.

Il [rapporto strutturato](../../docs/audit-2026-10-14.json) contiene scenario,
correzione, verifica e riferimenti per ciascun rilievo.

## Ambito e metodo

Esaminati instradamento `query:execute`, esecuzione degli script, sessioni e
risultati SQL nativi, shell e interprete MQL, cursori, budget e annullamento;
inoltre guard RBAC, scope, pipeline annidate, autorizzazione delle routine,
gateway MCP e gestione della destinazione nell'editor. Per SQL→MongoDB sono
stati riletti i percorsi di runtime, savepoint, scrittura, trigger e dipendenze,
e rieseguite le matrici delle funzionalità precedenti.

I difetti sono stati riprodotti prima della correzione; i log `audit-*-prima.log`
conservano le riproduzioni. I log `audit-mutant-*` contengono fallimenti attesi:
servono a dimostrare che le regressioni rilevano il difetto reintrodotto.

Non è un nuovo audit completo di backup/export, vault, packaging o del resto
della piattaforma. Non sono stati verificati altri DBMS, estensioni opzionali,
installazioni di produzione o cluster su macchine diverse. I limiti del
[traduttore SQL→MongoDB e della shell](../../docs/copertura-linguaggi-query.md)
restano distinti dall'esecuzione sui [motori SQL nativi](../../docs/sql-nativo.md).

## Difetti corretti

| ID | Severità | Riproduzione e conseguenza | Correzione |
| --- | --- | --- | --- |
| CDB-Q01 | Alta | `SET @@SESSION.autocommit=0` e una scrittura non attivavano lo stato locale; una lettura protetta poteva confermare implicitamente la transazione. Il DDL lasciava anche uno stato obsoleto. | Stato MySQL ottenuto dai flag nativi OK/EOF, anche dopo DDL riuscito o fallito. Nessuna seconda transazione aperta sopra una scrittura pendente. |
| CDB-Q02 | Media | Un `COMMIT` PostgreSQL fallito su vincolo differito lasciava CodeDB convinto che la transazione fosse aperta. Il cambio `READ ONLY`→`READ WRITE` non aggiornava la protezione. | Sincronizzazione con ReadyForQuery, `getTransactionStatus()` e modalità effettiva del server; rilascio del lease garantito. |
| CDB-Q03 | Media | `SELECT 7 AS affectedRows` diventava un riepilogo di scrittura. | Distinzione fra result set tramite metadati del driver, senza interpretare i nomi delle colonne. |
| CDB-Q04 | Media | Una stringa SQL o un campo MQL chiamato `virtualJoin` deviava la query verso Cross-DB. | Riconoscimento strutturale della specifica completa solo in modalità automatica, oppure scelta esplicita Cross-DB. |
| CDB-Q05 | Alta | `USE` seguito da testo invalido cambiava la destinazione prima del fallimento; commenti in `USE` lasciavano invece la destinazione obsoleta. | Il bersaglio cambia solo dopo il successo, usando il database effettivo comunicato dal server. |
| CDB-Q06 | Media | `USE`, `SET` e `SELECT CONNECTION_ID` interni sostituivano conteggi e avvisi del comando precedente. | Osservazione del protocollo, identificativo della connessione già disponibile e preparazione del database solo quando serve. Verificati `ROW_COUNT`, `FOUND_ROWS` e `SHOW WARNINGS`. |
| CDB-Q07 | Alta | Gli script elaboravano la pagina predefinita da 50 documenti o risultati troncati come letture complete; un conteggio scaduto diventava zero. DDL e altri metodi host non rispettavano la quota delle chiamate. | Riga sentinella, errore non catturabile sui risultati parziali per righe/byte, conteggio sconosciuto esplicito e budget centralizzato per tutti i metodi host. |
| CDB-Q08 | Media | Campi BSON `__bson`, `__host`, `__funzione`, `__chiamabile` collidevano con valori interni. | Marcatori `Symbol` non producibili dallo script; copia delle proprietà proprie senza modificare il prototipo. |
| CDB-Q09 | Alta | Escape come `\u00e8` e `\x41` modificavano silenziosamente filtri e dati scritti. | Decodifica condivisa per shell, stringhe e template: Unicode, code point, esadecimali, continuazioni e rifiuto degli escape invalidi. |
| CDB-Q10 | Media | I cursori rileggevano elementi consumati; `count` dipendeva dal limite materializzato, mancava `next` e il risultato finale non seguiva l'operazione del cursore. `explain` nello script richiamava un contatore assente. | Posizione condivisa, consumo coerente, `count(true)` con skip/limit, risultato finale aggiornato e accesso host con quota centralizzata anche per `explain`. |

I cambiamenti principali sono in `server/query.js`, `db/sqlSessione.js`, nelle
strategie SQL, in `db/mysqlSessioneNativa.js`, `db/MongoScriptRunner.js`,
`db/MongoScript.js`, `db/MongoShell.js`, `db/mongoStringhe.js` e
`db/mongoScriptValori.js`. La dipendenza minima `pg` è ora 8.22.0, coerente con
il lock e con l'API di stato utilizzata.

La soluzione MySQL osserva anche gli EOF del driver mysql2: è un punto da
ricontrollare quando si aggiorna il driver, coperto dalle regressioni reali
di transazione e diagnostica. Per PostgreSQL è usata l'[API pubblica del
client](https://node-postgres.com/apis/client). Il comportamento dei cursori
è confrontato con le specifiche MongoDB di
[count](https://www.mongodb.com/docs/v7.0/reference/method/cursor.count/) e
[toArray](https://www.mongodb.com/docs/v8.0/reference/method/cursor.toarray/).

## Prove eseguite sui database reali

Fixture Docker isolate: **PostgreSQL 18.6, MySQL 8.4.11, MongoDB 8.0.29**.
Database e schemi di prova sono separati dai dati dell'utente; il server E2E usa
configurazione e vault usa-e-getta. I log seguenti appartengono a questo audit.

| Suite | Esito e copertura | Log |
| --- | --- | --- |
| Nuove regressioni | 15 scenari passati: transazioni, diagnostica, bersagli, colonne, routing, Virtual JOIN, BSON, escape, letture parziali e cursori | [audit-e2e-query-audit.log](audit-e2e-query-audit.log) |
| Sessioni SQL precedenti | 12 regressioni passate, inclusi rollback/savepoint, cambio destinazione, disconnessione, rilascio e recupero senza replay | [audit-e2e-sql-native-sessioni.log](audit-e2e-sql-native-sessioni.log) |
| SQL nativo | 117 istruzioni attraverso Socket.IO; tipi/precisione, routine, trigger, cursori, handler, SQL dinamico, JOIN di scrittura e savepoint | [audit-e2e-sql-native.log](audit-e2e-sql-native.log) |
| UI con database reali | Chromium, destinazioni PostgreSQL/MySQL, conservazione di bozze e origine MongoDB, selettore mobile | [audit-e2e-sql-native-ui.log](audit-e2e-sql-native-ui.log) |
| Dialetti e SQL comune | Query originali/formattate e confronti sui tre motori | [audit-e2e-query-dialetti-nativi.log](audit-e2e-query-dialetti-nativi.log) |
| SQL→Mongo avanzato | 378 verifiche MongoDB, 270 confronti PostgreSQL, 273 MySQL | [audit-e2e-sql-mongo-avanzato.log](audit-e2e-sql-mongo-avanzato.log) |
| Completamento | 112 MongoDB, 30 PostgreSQL, 45 MySQL | [audit-e2e-sql-mongo-completamento.log](audit-e2e-sql-mongo-completamento.log) |
| Tipi | 218 MongoDB, 178 PostgreSQL, 1 MySQL | [audit-e2e-sql-mongo-tipi.log](audit-e2e-sql-mongo-tipi.log) |
| Estensioni | 116 MongoDB, 104 PostgreSQL | [audit-e2e-sql-mongo-estesi.log](audit-e2e-sql-mongo-estesi.log) |
| Compatibilità precedente | 169 MongoDB, 133 PostgreSQL | [audit-compatibilita.log](audit-compatibilita.log) |
| Varianti aggiuntive | 73 MongoDB, 35 PostgreSQL, 52 MySQL | [audit-e2e-sql-mongo-varianti.log](audit-e2e-sql-mongo-varianti.log) |
| Eventi SQL | Suite passata | [audit-e2e-sql-mongo-eventi.log](audit-e2e-sql-mongo-eventi.log) |
| Atomicità, integrità, migrazioni | Suite passate | [atomicità](audit-e2e-sql-mongo-atomicita.log), [integrità](audit-e2e-sql-mongo-integrita.log), [migrazioni](audit-e2e-sql-mongo-migrazioni.log) |
| Interprete MQL precedente e copertura query | Suite passate, compreso ALTER già implementato | [MQL](audit-e2e-mongo-script.log), [copertura](audit-e2e-query-copertura.log) |
| RBAC e MCP | Socket, gateway, MongoDB e MySQL reali; autorizzazioni e DATETIME con microsecondi | [RBAC](audit-e2e-rbac.log), [RBAC MCP](audit-e2e-rbac-mcp.log), [MCP MongoDB](audit-e2e-mcp.log), [MCP MySQL](audit-e2e-mcp-mysql.log) |
| Annullamento e timeout | Query annullate e tetti sulle scritture reali | [annullamento](audit-e2e-query-cancel.log), [timeout](audit-e2e-tetto-scrittura.log) |
| Failover | 18 arresti del container primario, elezioni e recuperi passati | [audit-failover.log](audit-failover.log) |

Le cinque matrici principali sommano **993 verifiche MongoDB, 715 confronti
PostgreSQL e 319 MySQL**, oltre alle varianti indicate separatamente. Sono
conteggi di verifiche, con possibili sovrapposizioni fra funzionalità; non
rappresentano una percentuale di grammatica coperta.

Il failover usa tre container distinti sullo stesso host: non è una prova su
macchine separate. Il provisioning persistente non è stato nuovamente fermato
o riconfigurato durante questo audit.

## Unitari, browser e sensibilità delle regressioni

`npm test` è passato sul codice finale: [audit-unit-finale.log](audit-unit-finale.log).
Include `test/unit-query-audit.js`: escape, proprietà BSON, errori di budget
non catturabili, troncamento per byte, timeout del conteggio e quota DDL.
`e2e-query-languages.js` è passato in Chromium per completamento, formattazione
e tastiera desktop/mobile, ma usa un trasporto simulato: non viene conteggiato
come prova di database reale ([log](audit-e2e-query-languages.log)).

**20 mutazioni deliberate rilevate**, applicate solo al caricamento in memoria
dei processi di prova, senza modificare i sorgenti dell'applicazione:

| Gruppo | Mutazioni rilevate |
| --- | --- |
| Nuove, SQL/routing | `instradamento`, `colonne`, `stato_pg`, `stato_mysql`, `bersaglio`, `diagnostica`, `stato_select`, `use_fallito`, `join_auto` |
| Nuove, MQL | `marcatori`, `escape`, `lettura`, `budget`, `cursore`, `conteggio`, `byte`, `risultato_cursore`, `quota_host` |
| Regressioni storiche adattate | `database_cache`, `dialetto_sessione` |

I log sono `audit-mutant-<nome>.log` e
`audit-mutant-storico-<nome>.log` in questa cartella. I test normali passano;
reintroducendo i difetti falliscono le asserzioni pertinenti. Le nuove fixture
sono `test/fixtures/query-audit-mutant.cjs`; le storiche restano in
`test/fixtures/sql-native-mutant.cjs`.

Due aspettative storiche sono state aggiornate alle funzionalità precedenti
già implementate: `ALTER TABLE` SQL→MongoDB riesce, e il DATETIME MySQL nativo
mantiene il testo esatto con microsecondi. Nessun test è stato disabilitato.

## Riproduzione e chiusura

La preparazione delle fixture e le variabili sono in
[docs/sql-nativo.md](../../docs/sql-nativo.md#prove-riproducibili).
Eseguire `npm test`, `node test/e2e-query-audit.js` e le suite elencate sopra;
la variante estesa usa anche `node test/e2e-sql-mongo-estesi.js --compatibilita`.
Il failover richiede `CODEDB_E2E_FAILOVER_NODES=1` e tre nodi con le etichette
di proprietà previste dal test.

Per una singola mutazione impostare `CODEDB_QUERY_MUTANT` sul nome della tabella
ed eseguire `test/e2e-query-audit.js`; per `byte`, `conteggio` e `quota_host`
usare `test/unit-query-audit.js`. Rimuovere la variabile prima delle prove normali.
Il risultato atteso della mutazione è un'asserzione fallita sul comportamento
protetto, non un errore di connessione o di configurazione.

Sono conservati i log e le fixture riproducibili. I cinque container di test
e la loro rete sono stati rimossi dopo la verifica delle etichette di proprietà.
Verificata l'assenza di container residui del progetto `codedb-sql-test`;
entrambi i motori dello stack SQL persistente risultano ancora attivi e sani.
I database dell'utente restano separati.
