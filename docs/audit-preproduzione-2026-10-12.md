# Verifica di preproduzione — 12 ottobre 2026

CodeDB **0.1.5-beta.1**, checkout basato su `8f4b0803f6358b49bfd3c618943bad1267f5a4a1`, con modifiche locali anche precedenti a questa verifica. Non è una certificazione dell'assenza di vulnerabilità: è una revisione dei confini di fiducia e dei percorsi critici, accompagnata da correzioni e prove riproducibili.

Sono stati chiusi **14 rilievi confermati**: 5 di severità alta, 8 media e 1 bassa. Comprendono gli otto rilievi funzionali del rapporto del 6 ottobre, che resta conservato come documento storico. Nessun rilievo confermato in questo rapporto rimane aperto.

## Correzioni e prove

| ID | Severità | Problema e scenario | Correzione e verifica |
| --- | --- | --- | --- |
| CDB-F08 | Alta | `BEGIN`, scrittura e `ROLLBACK` potevano finire su connessioni fisiche diverse; script concorrenti e file divisi in blocchi aggravavano il rischio. | Connessione riservata al tab o allo script, mantenuta fra blocchi SQL; chiusura con rollback e distruzione della sessione residua. Provati su MySQL e PostgreSQL rollback interattivo, script concorrenti, interruzione, tabella temporanea e avviso per `COMMIT` mancante. |
| CDB-P01 | Alta | Il lockfile conteneva 25 segnalazioni npm, fra cui una classificata critica dal registry. Non è stata dimostrata la raggiungibilità di ogni advisory dall'app. | Aggiornamenti compatibili e override circoscritto di `global-agent` nella catena di `@electron/get`. Audit finale: **0 segnalazioni**, anche sulle dipendenze di sviluppo. Suite e pacchetti ricostruiti. |
| CDB-P02 | Alta | Dopo una disconnessione, la riconnessione ripeteva l'operazione: una scrittura già confermata dal DB ma con risposta persa poteva essere duplicata. | Riconnessione senza riesecuzione automatica; messaggio di esito incerto. Test che verifica una sola invocazione e mutazione che reintroduce il difetto. |
| CDB-P04 | Alta | Il packaging permissivo raccoglieva anche export JSON locali e materiale di sviluppo, compreso `landing/node_modules`. Un file privato alla radice poteva essere distribuito. | Elenco esplicito dei file runtime per builder, portatile e Docker. Ispezione del vero ASAR: 4.783 percorsi ammessi, nessun percorso esterno all'elenco. Dimensione da 1.917.622.636 a **34.267.177 byte**. È la dimensione di `app.asar`, non dell'intero installer. |
| CDB-P06 | Alta | L'immagine Docker dichiarava esposizione locale anche quando `docker run -p` pubblicava la porta in rete. I gate potevano quindi basarsi su una premessa falsa. | Default dell'immagine esposto; il compose continua a dichiarare il bind scelto. Test sul container reale: avvio negato senza TLS, poi negato con solo TLS e RBAC spento. |
| CDB-F01 | Media | SQL `COUNT`, `GROUP BY` e `DISTINCT` su MongoDB generavano uno stage di aggregazione privo di `$group`. | Pipeline corretta e `COUNT(colonna)` che esclude campi mancanti/null. 75 test del traduttore e prova su MongoDB reale. |
| CDB-F02 | Media | Il Virtual JOIN della UI non risolveva due connessioni effettive. | Risoluzione dalle sessioni del socket tramite `tabId`, nome connessione o motore non ambiguo. Entrambe le strategie restano autorizzate dal proprio proxy. Provati JOIN SQL/MongoDB reali. |
| CDB-F03 | Media | Il JOIN conservava una sola corrispondenza e poteva presentare come completo un risultato troncato. | Espansione di tutte le corrispondenze, query della seconda sorgente rispettata, parametri SQL, letture protette e rifiuto esplicito di risultati incompleti. Test di cardinalità, budget e parametri; integrazione reale. |
| CDB-F04 | Media | Alias nei `SELECT` semplici su MongoDB accettati ma ignorati. | Proiezione degli alias, ordinamento sul campo sorgente e conservazione di `_id` quando richiesto. Test puri e query reale con alias e ordinamento. |
| CDB-F05 | Media | Revisioni dello schema identiche dopo rinomina/cambio tipo/FK senza cambio del numero di campi. | Impronta della struttura effettiva e delle relazioni. Test con modifiche a cardinalità invariata e mutazione del calcolo. |
| CDB-F07 | Media | Limite dei risultati calcolato su caratteri anziché byte; prima riga enorme ammessa. | Conteggio UTF-8 di EJSON, delimitatori compresi; prima riga sottoposta al limite e cursore chiuso. Test al confine esatto e mutazione. Il limite del payload non costituisce un limite assoluto della memoria del driver SQL. |
| CDB-P03 | Media | Return duplicati rendevano irraggiungibile la serializzazione con metadati; il batch PostgreSQL passava due volte le righe al posto delle colonne. | Eliminati i return errati e corretto `conRighe`. Suite di serializzazione/batch e roundtrip reali dei tipi SQL. |
| CDB-P05 | Media | Immagine basata su Node 20 fuori supporto. | Docker su Node 24 LTS; build e avvio reali con Node 24.21.0. Lo stato di supporto è verificabile nella [tabella ufficiale Node.js](https://nodejs.org/en/about/previous-releases). |
| CDB-F06 | Bassa | Deduplicazione della cronologia che collassava spazi dentro i letterali e ignorava la collezione. | Conservati il testo interno della query e il contesto di collezione. Test su `'a  b'`, `'a b'` e collezioni distinte. |

Riferimenti puntuali, scenari e prove sono nel [rapporto strutturato](audit-2026-10-12.json).

## Verifiche eseguite

Tutti i test di database hanno usato container dedicati e bersagli casuali registrati dalla fixture. Vault, configurazioni e audit delle suite E2E sono temporanei. Non sono stati eseguiti import, restore o scritture sui database dell'utente.

- **`npm test`**: superato dopo le correzioni finali; copre anche trasporto, autorizzazione, parser, isolamento tenant, percorsi file, import/export, script, connessioni e test di processo Electron/server. Il traduttore SQL→MQL è ora incluso nella suite ordinaria.
- **`npm run typecheck:ui`**: superato.
- **`test/e2e-preproduzione.js`**: superato sui tre DBMS reali; transazioni, concorrenza, blocchi SQL, rollback su interruzione, tabelle temporanee, avviso per transazione incompleta, aggregazioni MongoDB e JOIN fra connessioni.
- **Tipi MySQL**: 50 casi, con valori estremi e NULL, attraverso CodeDB JSON, SQL e backup.
- **Tipi PostgreSQL/PostGIS**: 103 casi attraverso gli stessi tre percorsi. Il primo tentativo su PostgreSQL senza PostGIS si è fermato per estensione mancante; la matrice completa è stata rieseguita e superata sul container PostGIS.
- **BSON**: tutti i tag BSON memorizzabili della matrice, confronto dei byte, GridFS, backup completo e incrementale.
- **Prove aggiuntive**: riferimenti PostgreSQL, Large Object e rimappatura OID, identità e sequenze, export/backup paginati da 1.601 righe su entrambi i motori SQL.
- **RBAC, MCP e vault reali**: autenticazione, scope, revoca, API key, migrazione/cambio passphrase e reset su risorse isolate.
- **SSH locale**: chiave da file, percorso quotato, upload, chiave cifrata, PKCS8, home, chiave errata e fingerprint. La fixture rigenera una chiave Ed25519 se il generatore di `ssh2` produce un formato che il suo stesso parser rifiuta; la validazione dell'app non è stata allentata.
- **Sensibilità**: sei difetti reintrodotti soltanto in memoria — byte, `$group`, JOIN, revisione schema, transazione e replay dopo riconnessione. Tutti producono `ERR_ASSERTION`; non basta il semplice exit diverso da zero.
- **Distribuzione Windows**: directory costruita con Electron 43.7.9; ispezione ASAR e server eseguito dal pacchetto con il runtime incluso, porta casuale e configurazione temporanea. Provati HTML, asset JS, licenze, origine estranea e shutdown.
- **Docker**: immagine costruita, gate di rete provati separatamente e smoke HTTP/asset/origine/shutdown su container usa e getta. Nessuna porta pubblicata per questa prova.

I log sono in [`test-reports/preproduzione-2026-10-12`](../test-reports/preproduzione-2026-10-12/). Le [patch notes dell'app](../public/js/onboarding-stato.js) sono aggiornate, senza modifica della versione né pubblicazione.

## Ambito e limiti

La lettura ha seguito trasporto HTTP/Socket.IO, autenticazione/RBAC, query e script, confini dei trasferimenti, vault/SSH, autorizzazioni MCP, lifecycle, serializzazione e distribuzione. Per il frontend sono stati esaminati i percorsi sensibili e la cronologia, insieme ai test già presenti; non ogni schermata o ogni riga del repository.

- Nessun penetration test su infrastruttura pubblica, reverse proxy reale, provider cloud, webhook o server SSH remoto. Il gate verifica la dichiarazione di TLS; non può certificare la configurazione del proxy esterno.
- Nessuna firma di release, installazione/aggiornamento di un installer, notarizzazione macOS, pacchetto Android o prova su hardware mobile. Il build Windows segnala esplicitamente l'assenza di un certificato di firma. Lo smoke Windows riguarda il server nel runtime distribuito; non è una prova interattiva completa della finestra Electron.
- Nessuna scansione CVE dei pacchetti di sistema Alpine o analisi completa delle librerie JavaScript vendorizzate. `npm audit` riguarda l'albero npm del lockfile al momento della verifica.
- La matrice dei tipi copre i casi e le versioni delle fixture; non dimostra ogni combinazione di estensioni, versioni DBMS, trigger e dati del mondo reale. Non è un benchmark di carico concorrente o una misura della memoria di picco.
- I driver SQL possono materializzare righe prima del taglio del risultato: il budget UTF-8 protegge il payload, non è un tetto assoluto alla RAM. Per un limite rigido serve estendere lo streaming delle query libere.
- Una lettura con barriera `readOnly` dentro una transazione esplicitamente scrivibile viene rifiutata con un errore chiaro: avviare una seconda transazione potrebbe confermare implicitamente quella MySQL. Le transazioni dichiarate `READ ONLY` sono supportate.

Questi limiti restano criteri del rilascio, non prove implicitamente superate. Lo schema e il validatore citati dalla skill di audit non erano presenti nell'installazione locale: il JSON è stato verificato per campi obbligatori, ID univoci, severità, stati, riferimenti esistenti e coerenza dei conteggi con un controllo locale.
