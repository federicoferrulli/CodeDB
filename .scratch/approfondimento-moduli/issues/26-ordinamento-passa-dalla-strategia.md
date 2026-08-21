# 26: L'ordinamento della griglia passa dalla strategia e conosce le colonne

**Cosa costruire:** un motore che ha bisogno di ordinare in modo diverso lo
ottiene sovrascrivendo il proprio metodo di ordinamento, e la modifica si vede
**anche nella griglia dati** — che è il posto dove l'ordinamento si guarda. E
chi compone l'ordinamento sa se la colonna ammette valori nulli.

Nessun cambiamento di comportamento visibile: è il prefactor che rende possibile
il ticket successivo.

Due difetti, la stessa giuntura:

**Il punto di estensione è saltato.** La composizione dei pezzi della SELECT non
passa più dal metodo di ordinamento della strategia ma direttamente dalla
funzione legata al dialetto. Sovrascrivere quel metodo — che è l'idioma di
questo strato: la classe base propone, il motore corregge, come già fanno la
rinomina nativa, il DDL ausiliario e l'osservazione dei cambiamenti — oggi
funzionerebbe per la tab ⚡ e verrebbe **ignorato in silenzio dalla griglia**.
Due ordinamenti diversi nello stesso motore a seconda della strada, senza alcun
errore: è la divergenza silenziosa che il modulo comune doveva eliminare,
riapparsa fra due funzioni invece che fra due file.

**I metadati arrivano troppo tardi.** L'ordinamento viene composto in modo
sincrono *prima* che la lettura dei metadati di colonna sia partita. Finché
resta lì, chi compone l'ordinamento non può sapere nulla della colonna su cui
ordina — e il ticket 27 ha bisogno esattamente di quello. I metadati sono già
letti a ogni pagina, con una cache di pochi secondi: il costo di spostare la
composizione dopo di essi è nullo, il costo di leggerli due volte no.

**Bloccato da:** 25 (cambia la firma di funzioni che la 25 sta togliendo dalla
superficie pubblica: farlo prima significherebbe scrivere prove contro una
superficie che la 25 poi cancella).

**Status:** done

- [x] Sovrascrivere il metodo di ordinamento di una strategia si riflette su tutti i percorsi che ordinano, griglia compresa
- [x] Esiste un test che fallisce se quel punto di estensione viene di nuovo scavalcato — e la sua sensibilità è verificata rompendolo di proposito
- [x] Chi compone l'ordinamento può sapere quali colonne ammettono valori nulli, senza letture di catalogo aggiuntive rispetto a oggi
- [x] La paginazione a chiave (keyset) e il suo ripiego su OFFSET si comportano esattamente come prima
- [x] Nessun cambiamento osservabile: stessa SQL prodotta, a parità di richiesta
- [x] I test end-to-end dei due motori SQL passano invariati

## Difetto 1: il punto di estensione era saltato

`componiSelezione` chiamava `componiOrdinamento` **direttamente**. Ora riceve
`ordinamento`, una funzione, e gli adattatori le passano
`(testo) => this.buildOrderBy(testo, opzioni)`: la chiusura è su *questa
istanza*, ed è ciò che rende efficace una sovrascrittura anche per la griglia.

`buildOrderBy` prende un secondo argomento, `opzioni`, che la versione comune
ignora (`void opzioni`) — la classe base propone, il motore corregge, com'è già
per la rinomina nativa, il DDL ausiliario e l'osservazione dei cambiamenti.

Anche il **piano di esecuzione** è stato riportato in riga: `collectionExplain`
compone la sua SELECT con le stesse colonne che vede `collectionFind`. Un piano
calcolato su un `ORDER BY` diverso da quello della query vera spiegherebbe
un'altra query — un difetto della stessa famiglia, trovato guardando gli altri
chiamanti di `buildSelect`.

## Difetto 2: i metadati arrivavano troppo tardi

`collectionFind` componeva la SELECT in modo sincrono **prima** che la lettura
dei metadati fosse partita. Ora la compone dopo, e le passa `colonne`.

Il costo è zero, come previsto dal ticket: `selectListFor` leggeva già quei
descrittori e ora li restituisce insieme alla lista di selezione, invece di
tenerseli. Nessuna lettura di catalogo aggiuntiva, e **nessun rischio di
raddoppio**: chiedere `tableColumnsInfo` una seconda volta in parallelo avrebbe
potuto mancare la cache due volte e mandare due query.

La **nullabilità** viaggia con le colonne che si leggevano già: basta
`IS_NULLABLE` (MySQL) e `is_nullable` (PostgreSQL) aggiunti alle stesse due
query. `sqlMetadati.js` le normalizza a booleano, e lascia `undefined` quando il
dialetto non le chiede — chi legge deve poter distinguere «ammette NULL» da
«non lo so», perché decidere come ordinare i nulli su un'ipotesi è peggio che
non decidere. Serve al ticket 27.

## Come è stato provato

`test/unit-ordinamento-strategia.js` (10 prove, registrato in `test/unit.js`),
senza database: al posto del pool un oggetto che registra le query, come in
`unit-sql-metadati.js`.

Un test di comportamento «l'ordinamento è giusto» non avrebbe visto niente: i
due percorsi danno lo stesso risultato finché nessuno sovrascrive nulla. Il modo
di vederlo è **sovrascrivere davvero**, ed è quello che il test fa — una
sottoclasse che restituisce ` ORDER BY marcatore_del_test`, e si controlla che
quel marcatore compaia nella SQL che `collectionFind` manda al server, su
entrambi i motori.

Le altre prove: la SQL prodotta senza sovrascrittura è **identica** a quella di
prima (backtick contro virgolette, SQL libero, JSON vuoto, sort assente); le
colonne arrivano a `buildOrderBy` con `nullable` corretto (`id` no, `nome` sì);
il catalogo delle colonne viene letto **una volta sola**; la paginazione a
chiave funziona con l'ordinamento di default e ripiega su OFFSET con un
ordinamento scelto dall'utente.

**Sensibilità verificata rompendo il codice di proposito**, rimettendo i due
difetti che il ticket descrive:

| difetto rimesso | esito |
|---|---|
| `componiSelezione` ricompone l'ordinamento da sé | **5 FAIL**, fra cui entrambi i motori sulla query vera |
| la SELECT torna a comporsi prima dei metadati | compreso nei 5: le colonne non arrivano più a `buildOrderBy` |

Ripristinati i file, zero fallimenti.

`npm test` passa (esito 0). `test/e2e.js` su MongoDB: i soliti 4 fallimenti
preesistenti (MongoDB non passa da questo codice).

**Non eseguiti**: `test/e2e-mysql.js` e `test/e2e-postgres.js`. PostgreSQL non è
in ascolto su 5432 su questa macchina e MySQL rifiuta l'utente `root` senza
password richiesto dall'harness — le istanze Docker sulle stesse porte
appartengono ad altri progetti e non le ho toccate. È il limite più serio di
questo ticket, perché qui si cambia la SQL che arriva a un server vero: il pool
finto prova che la stringa è quella giusta, non che i due motori la accettino.


---

## Verifica E2E sui due motori SQL — eseguita

Al momento della prima stesura MySQL e PostgreSQL non erano raggiungibili su
questa macchina. Sono poi stati avviati due container **dedicati e usa-e-getta**
(MySQL 8 su 3307, PostgreSQL 16 su 5433), che non toccano le istanze di altri
progetti presenti sulle porte consuete. Con quelli:

| suite | esito |
|---|---|
| `test/e2e-mysql.js` | 2 fallimenti — **gli stessi 2 anche senza queste modifiche** (misurato con `git stash`): preesistenti, riguardano la rinomina non atomica di un database |
| `test/e2e-postgres.js` | 3 fallimenti — **gli stessi 3 anche senza queste modifiche**: preesistenti, riguardano le FK fra schemi diversi |
| `test/e2e-backup-mysql.js` | tutti superati |
| `test/e2e-tetto-scrittura.js` | tutti superati (MySQL **e** PostgreSQL) |
| `test/e2e-tipi-mysql.js` | tutti superati |
| `test/e2e-collazione-mysql.js` | tutti superati |
| `test/e2e-query-engine.js` | tutti superati |
| `test/e2e-dbexport.js` | tutti superati |
| `test/e2e-sessions.js` | tutti superati |
| `test/e2e-script-risultati.js` | tutti superati |
| `test/e2e-mcp-mysql.js` | 1 fallimento — **lo stesso anche senza queste modifiche**: preesistente |
| `test/e2e-script-schede-ui.js` | fallisce all'apertura della modale — **identico anche senza queste modifiche**: preesistente |

**Nessun fallimento nuovo introdotto da queste modifiche**, su nessuna suite.
