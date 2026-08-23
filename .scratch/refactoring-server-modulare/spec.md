# Refactoring modulare e testabile del server CodeDB

Status: ready-for-agent
Type: spec

Origine: pianificazione del 23 agosto 2026 sullo stato corrente del server, dopo il
completamento del lotto che ha introdotto il contesto socket esplicito e le tre famiglie
di evento definite dall'ADR-0001.

---

## Problem Statement

Il server di CodeDB concentra in un solo modulo più di cinquemila righe e responsabilità
che cambiano per ragioni indipendenti: costruzione di Express e Socket.IO, sicurezza del
trasporto, autenticazione HTTP e WebSocket, lifecycle del processo, vault, persistenza
delle connessioni, apertura e riconnessione delle sessioni, audit, esecuzione di query,
coordinamento degli script, backup, gateway MCP e oltre ottanta eventi.

Questa concentrazione rende costoso capire quale parte debba cambiare, obbliga i test a
caricare molta più infrastruttura di quella necessaria e mantiene numeroso stato mutabile
a livello di modulo. Importare il server crea già Express, HTTP e Socket.IO; molte
dipendenze vengono costruite direttamente; avvio, arresto e gestione delle eccezioni
usano il processo globale. Anche quando una funzione è esportata per essere provata, il
suo ambiente resta quello dell'intero server.

Il problema non è il numero di righe in sé. Dividere il file per dimensione produrrebbe
molti moduli superficiali collegati da un enorme oggetto di dipendenze, lasciando intatta
la complessità. Il problema è che responsabilità macroscopiche diverse non possiedono
ancora interfacce profonde: il chiamante deve conoscere stato globale, ordine di avvio,
forma delle sessioni e dettagli di trasporto che dovrebbero restare locali.

Una parte dei test protegge regole importanti leggendo il testo del modulo e cercando
nomi, corpi e tabelle con espressioni regolari. Questi guardiani sono stati utili, ma
legano la verifica alla posizione fisica dell'implementazione. Una semplice estrazione
in un altro modulo può farli fallire senza alcuna regressione, oppure renderli ciechi se
continuano a leggere soltanto il vecchio entrypoint.

Il refactoring deve quindi modularizzare davvero il server, preservando integralmente il
protocollo osservabile e le decisioni di sicurezza. Non è accettabile nascondere o
disabilitare funzionalità per rendere più semplice l'estrazione, né dichiarare conclusa
una fase solo perché il codice è stato spostato.

## Solution

Trasformare il server in un composition root piccolo che costruisce e collega moduli
profondi, ciascuno responsabile di una sola funzione macroscopica. L'entrypoint deve
limitarsi a creare l'applicazione e avviarla; importarlo non deve aprire porte, registrare
handler sul processo, inizializzare il control plane, modificare il vault o lasciare
risorse attive.

La principale interfaccia applicativa sarà una factory che restituisce Express, server
HTTP e Socket.IO insieme alle operazioni esplicite di avvio e arresto. Sotto questa seam,
un router socket profondo continuerà a far rispettare le tre famiglie dell'ADR-0001 e
nasconderà ack, errori, rivalidazione del principal, risoluzione della sessione,
riconnessione, audit e annullamento.

Le capacità macroscopiche diventeranno moduli distinti: sicurezza del trasporto,
lifecycle del processo, sessioni socket, repository cifrato delle connessioni, runtime
delle sessioni DB, autenticazione e amministrazione, audit UI, esecuzione di un blocco di
query, coordinamento dei run di script, backup e informazioni applicative. Gli eventi
saranno raggruppati per capacità, non uno per file e non soltanto per prefisso del nome.

Il lavoro procederà per migrazioni verticali verificabili. Prima si congela il
comportamento corrente e si rende il catalogo degli eventi interrogabile; poi si
estraggono le politiche pure, i moduli con stato, il router e i gruppi di eventi; soltanto
alla fine si introduce il composition root definitivo e si riduce l'entrypoint. Ogni fase
deve lasciare il server avviabile e la suite almeno al livello della baseline misurata.

## User Stories

1. Come manutentore, voglio trovare nell'entrypoint soltanto composizione e avvio, così da
   capire immediatamente da dove parte l'applicazione.
2. Come manutentore, voglio importare la factory dell'applicazione senza aprire una porta,
   così da poterla usare nei test senza effetti collaterali nascosti.
3. Come manutentore, voglio avviare e arrestare un'istanza tramite una piccola interfaccia,
   così da non dover governare separatamente HTTP, Socket.IO, MCP e control plane.
4. Come manutentore, voglio creare più istanze isolate nello stesso processo di prova,
   così da scoprire eventuale stato globale condiviso accidentalmente.
5. Come manutentore, voglio passare le dipendenze che cambiano nei test, così da non dover
   sostituire moduli tramite cache o modificare variabili globali.
6. Come manutentore, voglio che ogni modulo abbia una responsabilità macroscopica, così
   che una modifica al vault non richieda di conoscere il coordinatore degli script.
7. Come manutentore, voglio evitare un contenitore universale di dipendenze, così che ogni
   modulo dichiari soltanto ciò che usa davvero.
8. Come manutentore, voglio conservare le tre famiglie di evento, così che eventi sui dati,
   amministrativi e operazioni lunghe non vengano forzati in un'interfaccia superficiale.
9. Come manutentore, voglio interrogare il catalogo degli eventi come dati, così da
   verificarne completezza e famiglia senza analizzare un file monolitico.
10. Come manutentore, voglio che un evento nuovo debba dichiarare famiglia e politica di
    audit, così che una registrazione fuori posto fallisca immediatamente.
11. Come manutentore, voglio che il router socket gestisca uniformemente gli ack, così che
    nessun handler lasci il browser in attesa di una risposta che non arriva.
12. Come manutentore, voglio che gli errori passino da un solo traduttore, così che tutti
    gli eventi continuino a restituire messaggi italiani utili.
13. Come amministratore, voglio che la rivalidazione del principal resti applicata a ogni
    famiglia di evento, così che una revoca abbia effetto anche sui socket già aperti.
14. Come amministratore, voglio che le strategie vive ricevano il principal aggiornato,
    così che un grant revocato non sopravviva dentro una sessione DB esistente.
15. Come manutentore, voglio che la ricerca della sessione dal tab viva in un solo modulo,
    così che messaggi, riconnessione e pulizia non divergano fra eventi.
16. Come utente, voglio che due richieste concorrenti di connessione sullo stesso tab
    restino serializzate, così che non nascano client o tunnel orfani.
17. Come amministratore, voglio che i limiti globali, per socket e per IP restino invariati,
    così che il refactoring non apra nuove vie di esaurimento delle risorse.
18. Come manutentore, voglio che chiudere una sessione annulli run e riconnessioni, elimini
    i depositi e chiuda il tunnel, così che il ciclo di vita abbia una sola proprietaria.
19. Come manutentore, voglio che i contatori delle sessioni siano incapsulati, così che
    ogni acquisizione abbia per costruzione un rilascio corrispondente.
20. Come utente, voglio che la riconnessione automatica conservi comportamento e messaggi,
    così che una perdita temporanea del DB non peggiori dopo il refactoring.
21. Come amministratore, voglio che i segreti restino cifrati e isolati per tenant, così
    che la modularizzazione non indebolisca il vault.
22. Come amministratore, voglio che sblocco, migrazione, cambio passphrase e reset restino
    operazioni verificabili e recuperabili, così da non perdere l'unica copia dei segreti.
23. Come manutentore, voglio che lo stato della chiave del vault appartenga a un'istanza
    esplicita, così che non sia una variabile globale difficile da isolare nei test.
24. Come manutentore della CLI, voglio che lettura e decifratura delle connessioni usino le
    stesse regole del server, così che i due percorsi non divergano al prossimo formato.
25. Come utente RBAC, voglio che le mie connessioni salvate restino separate da quelle di
    altri tenant, così che list, get, save, import ed export non cambino perimetro.
26. Come amministratore, voglio che login, logout e handshake continuino a distinguere
    token UI e API key MCP, così che una chiave MCP non diventi una sessione UI.
27. Come amministratore, voglio che il freno ai tentativi di login conservi scadenza e
    potatura, così che non diventi né aggirabile né una perdita di memoria.
28. Come manutentore, voglio provare l'autenticazione HTTP senza un control plane reale,
    così da coprire successo, rifiuto, ambiguità e rate limit rapidamente.
29. Come utente, voglio che query SQL, MQL, Mongo shell e Virtual JOIN restituiscano gli
    stessi risultati e gli stessi metadati di audit di prima.
30. Come manutentore, voglio provare l'esecuzione di un blocco attraverso una sessione
    finta, così da non caricare Socket.IO o aprire un database.
31. Come amministratore, voglio che i campi riservati al server restino non controllabili
    dal client, così che tetti e riferimenti di annullamento non siano falsificabili.
32. Come utente, voglio avviare, mettere in pausa, riprendere e interrompere uno script
    con la stessa semantica, così che il refactoring non alteri i run in corso.
33. Come utente, voglio continuare a ricevere avanzamento e risultati intermedi, così che
    gli script lunghi restino osservabili.
34. Come manutentore, voglio che il coordinatore degli script possieda run e depositi,
    così che nessun handler debba manipolarne direttamente le mappe.
35. Come amministratore, voglio che l'audit di uno script sia deciso dopo averne conosciuto
    le istruzioni eseguite, così che una scrittura non venga classificata come lettura.
36. Come amministratore, voglio che backup e restore conservino autorizzazione sull'intera
    connessione, confinamento per tenant e verifica dei percorsi.
37. Come utente, voglio che rinominare un database tramite dump mantenga la barriera di
    verifica prima dell'eventuale eliminazione dell'origine.
38. Come manutentore, voglio provare le operazioni di backup con adapter locali, così da
    distinguere orchestrazione, policy dei percorsi e motore di backup.
39. Come amministratore, voglio che Origin, Host, TLS e autenticazione di rete restino
    controlli indipendenti, così che un proxy HTTPS non venga scambiato per autenticazione.
40. Come manutentore, voglio provare le decisioni di esposizione senza terminare il
    processo di test, così da verificare ogni combinazione di configurazione.
41. Come utente desktop, voglio che aggiornamenti, licenza e informazioni applicative
    continuino a funzionare sia in Electron sia nel server standalone.
42. Come manutentore, voglio che il ponte desktop sia un adapter esplicito, così da
    provarne presenza e assenza senza modificare il globale del processo.
43. Come amministratore, voglio che lo shutdown chiuda MCP, control plane, sessioni DB,
    Socket.IO e HTTP nell'ordine corretto, così da non lasciare risorse o dati temporanei.
44. Come manutentore, voglio provare lo shutdown senza chiamare davvero process.exit,
    così da coprire successo, timeout e fallimenti parziali.
45. Come manutentore, voglio che una seconda chiamata a stop sia innocua, così che segnali
    concorrenti non eseguano due volte la chiusura.
46. Come manutentore, voglio sostituire i test legati alla posizione del testo quando
    esiste una migliore interfaccia osservabile, così che gli spostamenti interni non li
    rompano.
47. Come manutentore, voglio conservare guardiani statici soltanto per proprietà davvero
    statiche, così che continuino a segnalare omissioni che nessuna esecuzione vede.
48. Come manutentore, voglio che ogni nuova seam abbia almeno un adapter reale e uno di
    prova, così che non venga introdotta indirection puramente ipotetica.
49. Come manutentore, voglio completare una capacità per volta, così che ogni fase possa
    essere revisionata e rilasciata senza attendere la fine dell'intero programma.
50. Come utente di CodeDB, voglio che nomi evento, payload, ack, push, errori e comportamento
    visibile restino compatibili, così che il refactoring non richieda modifiche al client.

## Implementation Decisions

### Principi e vincoli

- Si useranno i termini modulo, interfaccia, implementazione, seam e adapter; i concetti
  del dominio seguiranno il glossario del progetto.
- L'ADR sulle tre famiglie di evento resta vincolante. Il refactoring ne sposta
  l'implementazione ma non unifica le famiglie e non modifica i loro criteri.
- Il contesto socket esplicito e il socket finto esistenti sono il punto di partenza, non
  lavoro da rifare.
- I moduli saranno disegnati per responsabilità macroscopica. Non verrà creato un modulo
  per evento, per funzione ausiliaria o per semplice pass-through.
- Le dipendenze saranno accettate dalle factory dei moduli. Non verrà esposto un unico
  contenitore universale; ogni factory riceverà soltanto le dipendenze necessarie.
- Configurazione e variabili d'ambiente saranno lette al composition root oppure tramite
  un adapter di configurazione. Le decisioni interne non leggeranno arbitrariamente il
  processo globale.
- La migrazione sarà incrementale e manterrà un solo percorso di produzione per ciascun
  comportamento. Non verranno mantenute due implementazioni complete dietro un flag.

### Composition root

- Una factory applicativa costruirà Express, HTTP e Socket.IO e collegherà autenticazione,
  gateway MCP, eventi e lifecycle.
- La sua interfaccia pubblica comprenderà gli oggetti necessari all'integrazione e le
  operazioni asincrone di avvio e arresto.
- La costruzione non ascolterà una porta. L'ascolto avverrà soltanto chiamando start.
- L'avvio sarà idempotente oppure rifiuterà esplicitamente una seconda chiamata; l'arresto
  sarà idempotente.
- L'entrypoint manterrà l'avvio diretto da Node e l'uso incorporato da Electron, senza
  cambiare comandi o packaging.

### Sicurezza del trasporto e lifecycle

- Origin, Host, whitelist, trust proxy, bind esposto, requisito TLS e requisito RBAC
  formeranno un modulo di policy privo di process.exit. Restituirà decisioni o lancerà
  errori descrittivi; sarà il composition root a decidere l'uscita del processo.
- La diagnostica dell'handshake continuerà a usare la stessa policy dell'handshake reale.
- Il lifecycle possiederà registrazione e rimozione degli handler globali, ordine di
  shutdown, timeout di sicurezza e codice di uscita.
- Logger, timer, clock e process exit saranno dipendenze sostituibili nelle prove.
- Lo shutdown chiuderà nell'ordine MCP, control plane, sessioni socket, Socket.IO e HTTP;
  un fallimento locale non impedirà il tentativo di chiudere le risorse successive.

### Router socket e catalogo eventi

- Il router socket sarà la seam comune più alta per gli eventi. Presenterà operazioni
  distinte per evento sui dati, evento amministrativo, operazione lunga ed eccezione
  motivata della via generica.
- Il router possiederà rivalidazione del principal, ack unico, traduzione degli errori,
  risoluzione della sessione, rimozione dei campi server-only, riconnessione, capability,
  audit e pulizia dei riferimenti operativi secondo la famiglia.
- Cataloghi di famiglia, audit ed estensioni saranno dati esportati e validati, non testo
  da estrarre dall'implementazione.
- La registrazione di tutti gli eventi sarà enumerabile in una prova. Duplicati, eventi
  senza famiglia, eccezioni senza motivo e policy orfane saranno errori.
- I gruppi di handler saranno organizzati per capacità: applicazione, vault, connessioni,
  identità, database e collezioni, query, script, osservazione e backup.
- Un gruppo potrà registrare più eventi coesi; non dovrà duplicare le regole del router.

### Repository cifrato delle connessioni

- Un modulo possiederà persistenza delle connessioni salvate, isolamento per tenant,
  cifratura dei campi segreti, stato bloccato del vault, import, export e rotazione sicura.
- Lo stato oggi distribuito in variabili di modulo diventerà stato dell'istanza del
  repository. Due istanze in una prova non condivideranno chiave o contatori.
- Il modulo crittografico esistente resterà l'unico proprietario degli algoritmi e del
  formato del vault. Il nuovo repository orchestrerà tali primitive senza copiarle.
- Server e CLI condivideranno parsing, risoluzione dei file e decifratura. La CLI manterrà
  il proprio comportamento di sola lettura dove richiesto.
- Migrazione e reset manterranno copie recuperabili e verifica dopo la scrittura. Nessuna
  semplificazione potrà trasformare un'operazione recuperabile in una cancellazione.

### Runtime delle connessioni e delle sessioni

- Un modulo per l'apertura delle connessioni risolverà configurazione effettiva, tunnel,
  strategia, proxy autorizzante e teardown in caso di apertura parziale.
- Un modulo per le sessioni legate ai tab possiederà mappa delle sessioni, limiti, lock,
  contatori, riconnessione, chiusura e propagazione del principal aggiornato.
- I budget usati da UI e MCP saranno coordinati tramite una piccola interfaccia di
  acquisizione e rilascio, senza permettere contatori negativi o doppi rilasci.
- Il gateway MCP continuerà a usare lo stesso percorso di apertura e teardown della UI.
- La rinomina tramite dump resterà un'operazione amministrativa sulla connessione intera,
  con verifica indipendente prima dell'eliminazione opzionale dell'origine.

### Autenticazione e amministrazione

- Inizializzazione del control plane, entitlement, risoluzione di token e API key,
  invalidazione dei socket e lock fra grant e connessioni saranno raccolti in un runtime
  di autenticazione.
- Le route HTTP di login e logout saranno registrate da un modulo dedicato usando tale
  runtime.
- Il rate limit manterrà lo stesso comportamento, ma clock e storage in memoria saranno
  posseduti da un'istanza sostituibile.
- Gli handler amministrativi di utenti, grant, ruoli, API key e preferenze useranno
  l'interfaccia del runtime e non accederanno direttamente allo stato globale.

### Audit UI

- Classificazione, attore, dettagli, bersaglio, conteggi e troncamento formeranno una
  policy unica.
- Il router applicherà la policy agli eventi sui dati e amministrativi; query e script
  potranno fornire la categoria solo quando diventa conoscibile.
- L'interfaccia di audit accetterà record di dominio e nasconderà file, rotazione e formato
  persistito.
- Gli eventi di sola lettura non tracciati continueranno a dichiararne esplicitamente il
  motivo.

### Query e script

- Un Query Executor eseguirà un singolo blocco e restituirà risultato, categoria, nome
  dell'operazione e bersaglio utile all'audit. Non conoscerà Socket.IO.
- Il Query Executor conserverà selezione del motore, SQL-to-MQL, Mongo shell, interprete
  sicuro, Virtual JOIN, limiti, riconnessione e divieto di JavaScript lato server.
- Uno Script Coordinator possiederà run, stato, avanzamento, pausa, ripresa, abort,
  risultati su disco e finalizzazione dell'audit.
- Il coordinatore riceverà un adapter per inviare avanzamento; la sua implementazione non
  emetterà direttamente su un socket globale.
- Query singola e istruzione di script riuseranno lo stesso Query Executor, evitando due
  interpretazioni della stessa sintassi.
- I punti di estensione delle operazioni lunghe resteranno dichiarati e verificati.

### Backup e informazioni applicative

- Gli eventi di backup saranno raccolti in un modulo di orchestrazione che usa i motori
  esistenti, le policy dei percorsi e un adapter di notifica.
- L'accesso al driver nativo resterà autorizzato sull'intera connessione e non verrà
  forzato attraverso lo scope di una singola collezione.
- Informazioni di versione, licenza, dipendenze vendorizzate e capacità desktop saranno
  fornite da un modulo dedicato con filesystem e ponte desktop sostituibili.
- Il ponte desktop globale sarà letto soltanto dall'adapter di produzione.

### Ordine di consegna

1. Misurare la baseline e censire eventi, route, export, stato globale e risorse.
2. Rendere cataloghi e policy degli eventi interrogabili; migrare i guardiani che
   dipendono inutilmente dal testo del monolite.
3. Estrarre policy pure: sicurezza rete, audit, informazioni applicative e lock.
4. Estrarre repository cifrato e consolidare le regole condivise con la CLI.
5. Estrarre apertura delle connessioni e runtime delle sessioni.
6. Estrarre Query Executor e poi Script Coordinator.
7. Estrarre runtime di autenticazione, route HTTP e gruppi amministrativi.
8. Introdurre il router socket come proprietario delle giunture e migrare i gruppi di
   eventi una capacità alla volta.
9. Estrarre orchestrazione backup e osservazione.
10. Introdurre il composition root definitivo e ridurre l'entrypoint.
11. Rimuovere esportazioni e seam temporanee, aggiornare documentazione e verificare la
    suite completa.

Ogni passo sarà un cambiamento revisionabile che lascia un solo percorso attivo. I passi
che toccano il repository cifrato, il runtime delle sessioni e il coordinatore degli
script non saranno eseguiti in parallelo sullo stesso stato di lavoro.

## Testing Decisions

### Qualità dei test

- Un buon test descrive un risultato osservabile attraverso l'interfaccia usata dai
  chiamanti reali. Non legge lo stato interno e non richiede modifiche quando cambia solo
  l'implementazione.
- Si preferirà la seam più alta che renda il difetto deterministico. La factory
  applicativa coprirà composizione, avvio e arresto; il router socket coprirà il protocollo
  degli eventi; le interfacce dei moduli profondi copriranno invarianti che non conviene
  ricostruire passando dall'intera applicazione.
- Un test statico resterà solo quando la proprietà è statica per natura, per esempio la
  completezza fra cataloghi dichiarativi. Non dovrà dipendere dal fatto che una tabella
  viva in uno specifico file.
- Ogni nuovo test di regressione o guardiano strutturale sarà verificato almeno una volta
  rompendo intenzionalmente la regola protetta e osservando il fallimento.
- I test non useranno vault, configurazione o backup reali dell'utente.

### Moduli e comportamenti da provare

- Factory applicativa: costruzione senza effetti, start, stop, idempotenza, porta
  effimera, istanze isolate e fallimento parziale dell'avvio.
- Sicurezza: combinazioni di Origin/Host, whitelist, proxy, TLS, bind pubblico, RBAC e
  override esplicito per rete non autenticata.
- Lifecycle: ordine di chiusura, timeout, seconda chiamata, eccezioni recuperabili e
  fatali senza terminare il runner.
- Router: registrazione completa, unicità della famiglia, ack singolo, errori, campi
  server-only, sessione assente, riconnessione, capability, audit e rivalidazione.
- Repository: round-trip INI, chiavi vietate, tenant, cifratura, vault bloccato, passphrase
  errata, migrazione v1-v2, cambio passphrase, import, export, reset recuperabile e
  scrittura atomica.
- Runtime sessioni: lock concorrenti, budget, apertura parziale, tunnel, doppia chiusura,
  attesa di riconnessione annullata, run abortiti e principal aggiornato.
- Autenticazione: RBAC spento, login riuscito, credenziali errate, login ambiguo, rate
  limit, logout, token revocato e separazione fra token UI e API key.
- Query Executor: tutti i motori accettati, query di lettura e scrittura, SQL-to-MQL,
  script Mongo, Virtual JOIN, limiti, annullamento, errori contestualizzati e audit.
- Script Coordinator: transizioni del run, risposta anticipata, avanzamento, pausa,
  ripresa, abort, stop su errore, depositi, pulizia e categoria finale.
- Backup: confinamento dei percorsi, capability sull'intera connessione, catalogo,
  verifica, restore, notifiche e barriera della rinomina.
- Informazioni applicative: dipendenze con forme storiche della licenza, file mancanti,
  capacità desktop e assenza del ponte Electron.

### Adapter di prova

- Socket finto e contesto finto esistenti per gli eventi.
- Strategia finta minimale, con soli metodi richiesti dalla prova.
- Filesystem temporaneo per vault, connessioni, backup e risultati di script.
- Clock e timer controllabili per rate limit, rivalidazione, riconnessione e shutdown.
- Logger in memoria per verificare messaggi e audit senza scrivere nei log reali.
- Process adapter per segnali e codici di uscita.
- Adapter in memoria per control plane, entitlement e ponte desktop.
- Server HTTP su porta effimera per le route e l'handshake.

### Prior art

Il progetto possiede già socket e contesto finti, strategie finte, test unitari dei lock,
test di lifecycle, test del payload di esecuzione, test del vault, harness end-to-end
isolati per MongoDB, MySQL, PostgreSQL, MCP e RBAC, oltre ai guardiani delle tre famiglie.
Queste forme verranno estese invece di introdurre un nuovo framework di test.

### Verifica per fase

Prima di ogni estrazione si registra la baseline delle suite pertinenti. Dopo
l'estrazione si eseguono almeno i test unitari del modulo e delle giunture attraversate;
prima di chiudere una fase si esegue la suite unitaria completa. Le milestone su sessioni,
query, script, autenticazione e backup richiedono anche gli end-to-end pertinenti. La fase
finale richiede tutte le suite disponibili, inclusi i tre DBMS, MCP, RBAC, vault, backup
ed Electron dove l'ambiente lo consente. Ogni mancata esecuzione o dipendenza esterna
assente sarà dichiarata, non assimilata a un successo.

## Out of Scope

- Cambiare nomi degli eventi, payload, ack, push o protocollo Extended JSON.
- Cambiare il comportamento visibile della UI o richiedere modifiche al frontend, salvo
  adeguamenti interni non osservabili necessari a mantenere il protocollo.
- Unificare le tre famiglie di evento o riaprire la decisione dell'ADR-0001.
- Riscrivere strategie MongoDB, MySQL o PostgreSQL, traduttori, interpreti, motori di
  backup o gateway MCP se non quanto necessario per ricevere una dipendenza condivisa.
- Cambiare schema o contenuto del control plane RBAC.
- Cambiare formato del vault, cifratura, KDF o formato dei file delle connessioni.
- Cambiare semantica di capability, scope, grant o isolamento multi-tenant.
- Introdurre TypeScript, framework applicativi, container di dependency injection, build
  step o un nuovo test runner.
- Migliorare prestazioni o aggiungere funzionalità non necessarie alla modularizzazione.
- Correggere incidentalmente difetti funzionali scoperti durante l'estrazione: saranno
  documentati e trattati in ticket separati, salvo che impediscano una migrazione fedele.
- Suddividere i moduli fino a ottenere un file per funzione o per evento.

## Further Notes

La specifica precedente sui moduli dichiarava fuori perimetro lo smontaggio completo del
server. Il lotto server di quella specifica è stato completato e costituisce ora il
prerequisito di questa: contesto esplicito, tre famiglie e relativi guardiani non devono
essere rimossi.

Lo stato corrente comprende una nuova coppia di eventi per le preferenze del tenant;
perciò i conteggi storici di ottanta eventi non sono più una costante affidabile. La
completezza dovrà derivare dal catalogo effettivo, non da una soglia numerica scritta nel
test.

Il criterio di completamento non è una riduzione arbitraria delle righe dell'entrypoint.
Il programma è concluso quando:

- l'entrypoint contiene soltanto composizione minima e avvio;
- importare l'applicazione non produce effetti esterni;
- ogni stato mutabile ha un proprietario esplicito e isolabile;
- ogni gruppo di eventi attraversa il router e una sola famiglia dichiarata;
- nessun gruppo replica ack, error handling, capability, audit o session lookup;
- server e CLI condividono le regole di persistenza e decifratura applicabili;
- start e stop sono esercitabili senza processi figli;
- i test strutturali non dipendono dalla posizione dell'implementazione;
- i test di sensibilità hanno dimostrato di rilevare le regressioni protette;
- tutte le suite eseguibili non introducono fallimenti rispetto alla baseline;
- eventuali suite non eseguite e limiti dell'ambiente sono dichiarati esplicitamente.

Il file è attualmente interessato da modifiche locali non appartenenti a questa
specifica. L'implementazione dovrà partire dallo stato effettivo del ramo, preservarle e
non usare operazioni distruttive per ricostruire una baseline pulita.
