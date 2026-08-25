# Integrità di import e ripristino

Status: resolved
Type: spec

Origine: audit statico del 23 agosto 2026 sui percorsi capaci di eliminare o
corrompere dati durante import, backup incrementali e ripristino.

---

## Problem Statement

Chi usa CodeDB per importare o ripristinare un database può ricevere un esito
formalmente riuscito anche quando il contenuto finale non rappresenta l'artefatto
scelto. I casi verificati appartengono alla stessa classe: l'applicazione comincia a
mutare la destinazione prima di avere dimostrato che input, piano e strategia di
applicazione siano sicuri e completi.

Un file di esportazione dell'intero database può contenere DDL libero. La sua
validazione controlla la forma JSON, ma non il bersaglio delle istruzioni: importare
un file ricevuto da terzi può quindi eseguire una singola istruzione distruttiva con
le capability del principal.

Il ripristino applica layer e collezioni direttamente alla destinazione. Con `drop`
attivo, un errore dopo la prima cancellazione lascia una destinazione parziale. In
alcuni rami un `drop` fallito viene ignorato e l'operazione prosegue, mescolando dati
vecchi e nuovi. Senza `drop`, l'interfaccia promette upsert ma il layer full usa
inserimenti normali e può fallire dopo averne applicato solo una parte.

Gli incrementali SQL presuppongono una chiave stabile che non è garantita. Su tabelle
senza chiave primaria i layer possono duplicare righe e superare comunque la verifica
numerica. Su MySQL `REPLACE` implementa l'upsert come delete più insert, attivando
foreign key, cascade e trigger già presenti.

Infine, alcuni test E2E si collegano ai DBMS locali predefiniti come amministratore e
eliminano database o schemi con nomi fissi. I nomi sono da test, ma il processo non
dimostra che la destinazione sia usa-e-getta prima del primo `DROP`.

## Solution

CodeDB introdurrà un motore server-side unico per applicare artefatti di database. Il
motore riceve un artefatto già acquisito, ne produce un piano immutabile, valida
l'intero piano prima della prima mutazione, lo esegue attraverso un adattatore per
strategia e verifica lo stato finale. Import dell'intero database e restore useranno
la stessa giuntura; non resteranno due orchestrazioni con regole diverse.

Il motore applicherà un protocollo a fasi osservabili:

1. acquisizione e normalizzazione dell'artefatto;
2. verifica di integrità e provenienza disponibile;
3. validazione strutturale di ogni DDL e del suo bersaglio effettivo;
4. determinazione e verifica dell'identità stabile delle righe;
5. costruzione di un piano completo senza effetti;
6. creazione di staging o di una copia di sicurezza verificata della destinazione;
7. applicazione fail-closed del piano;
8. verifica di righe, collezioni e oggetti di schema sul risultato;
9. promozione secondo le garanzie reali del DBMS;
10. conservazione del recupero e dichiarazione esplicita dell'esito.

PostgreSQL userà lo swap atomico degli schemi quando applicabile. Per MongoDB e MySQL,
dove non esiste una rinomina atomica completa del database comprensiva di tutti gli
oggetti, CodeDB non fingerà atomicità: una destinazione esistente verrà prima protetta
da una copia di recupero verificata e mai rimossa automaticamente; il piano registrerà
ogni mutazione e, in caso di errore, tenterà il rollback lasciando sempre disponibile
la copia di recupero. Il risultato distinguerà `completato`, `ripristinato_dopo_errore`
e `intervento_richiesto`; nessun caso parziale sarà chiamato riuscito.

Gli incrementali verranno ammessi soltanto quando ogni collezione possiede una identità
stabile utilizzabile per l'upsert. La strategia scelta verrà registrata nel manifest e
riverificata prima del restore. MySQL userà un vero upsert, mai `REPLACE`.

L'import dell'intero database diventerà una **operazione lunga** secondo ADR-0001. Il
browser invierà una sola richiesta col tab e la destinazione congelati; avanzamento,
audit, annullamento e stato finale saranno responsabilità del server.

## User Stories

1. Come amministratore di un database di produzione, voglio che un artefatto venga
   validato integralmente prima della prima scrittura, così che un errore tardivo non
   distrugga dati sani.
2. Come amministratore, voglio importare un file ricevuto da terzi senza concedergli la
   possibilità di eseguire SQL arbitrario, così che il file descriva dati e schema ma
   non comandi estranei.
3. Come amministratore, voglio che ogni DDL sia autorizzata sul bersaglio che modifica
   realmente, così che nominare la collezione attesa in un altro punto del testo non
   aggiri il controllo.
4. Come amministratore, voglio che un `drop` negato interrompa l'operazione, così che
   “elimina e ricrea” non diventi silenziosamente “mescola vecchio e nuovo”.
5. Come amministratore, voglio che un restore fallito non lasci la sola copia sana
   parzialmente cancellata, così che il tentativo di recupero non peggiori l'incidente.
6. Come amministratore, voglio una copia di recupero verificata prima di sostituire una
   destinazione esistente su un DBMS privo di swap atomico, così che il rollback resti
   materialmente possibile.
7. Come amministratore PostgreSQL, voglio che lo schema nuovo venga promosso
   atomicamente, così che nessuna sessione osservi metà del ripristino.
8. Come amministratore MySQL, voglio che un upsert aggiorni la riga senza cancellarla,
   così che cascade e trigger di cancellazione non colpiscano dati correlati.
9. Come amministratore SQL, voglio che una tabella senza identità stabile venga esclusa
   da un incrementale con un errore chiaro, così che il restore non duplichi righe.
10. Come amministratore, voglio sapere quale chiave verrà usata per ogni upsert, così da
    poter giudicare la ripristinabilità prima dell'emergenza.
11. Come amministratore, voglio che la chiave dichiarata nel manifest venga confrontata
    con lo schema di destinazione, così che un manifest vecchio non venga applicato con
    assunzioni ormai false.
12. Come amministratore, voglio che la verifica finale confronti lo stato risultante e
    non il numero di operazioni eseguite, così che righe duplicate non contino come
    successo.
13. Come amministratore, voglio che la verifica comprenda collezioni, righe, indici,
    vincoli, view, routine, trigger, sequenze, validatori e opzioni, così che “completo”
    abbia lo stesso significato su tutti i motori.
14. Come amministratore, voglio distinguere un completamento da un rollback riuscito e
    da un recupero manuale necessario, così da non continuare a usare dati incerti.
15. Come utente dell'interfaccia, voglio che la conferma descriva le garanzie vere del
    DBMS scelto, così da non leggere “upsert” quando il motore eseguirà insert normali.
16. Come utente dell'interfaccia, voglio vedere la destinazione, la copia di recupero,
    il tipo di promozione e le collezioni coinvolte prima di confermare, così da evitare
    errori di bersaglio.
17. Come utente dell'interfaccia, voglio che chiudere un tab non trasformi una operazione
    ancora viva in un falso fallimento da ritentare, così da non applicare due volte gli
    stessi dati.
18. Come utente dell'interfaccia, voglio riaprire il tab e ritrovare lo stato di una
    operazione lunga, così da non dover dedurre l'esito dai dati.
19. Come principal con scope limitato, voglio che import e restore rispettino capability
    e scope come gli altri eventi sui dati, così che la nuova giuntura non diventi una
    scorciatoia autorizzativa.
20. Come proprietario della connessione, voglio che l'accesso nativo richiesto dal
    restore continui a richiedere l'intera connessione, così che gli scope parziali non
    vengano applicati solo nominalmente.
21. Come manutentore, voglio una sola rappresentazione del piano di import e restore,
    così che validazione, audit e verifica non divergano fra UI, CLI e MCP.
22. Come manutentore, voglio che il piano sia immutabile dopo la conferma, così che
    bersaglio o DDL non cambino fra anteprima ed esecuzione.
23. Come manutentore, voglio provare il motore con una strategia finta, così da esercitare
    errori in ogni fase senza toccare un database.
24. Come manutentore, voglio test E2E soltanto per le semantiche proprie dei DBMS, così
    che la maggior parte delle invarianti resti veloce e deterministica.
25. Come manutentore, voglio dimostrare la sensibilità di ogni test di integrità rompendo
    intenzionalmente la barriera protetta, così che un test sempre verde non venga
    scambiato per una prova.
26. Come sviluppatore, voglio che ogni E2E distruttivo generi nomi unici e verifichi
    l'ambiente prima del primo `DROP`, così che un database locale omonimo non venga
    scambiato per una fixture.
27. Come operatore CLI, voglio le stesse validazioni e lo stesso piano della UI, così che
    `--allow-unsafe-schema` resti una deroga esplicita e non una seconda implementazione.
28. Come client MCP, voglio che il token confermi il piano immutabile completo, così che
    anteprima ed esecuzione rappresentino la stessa mutazione.
29. Come revisore dell'audit, voglio che ogni fase e ogni tentativo di rollback siano
    registrati con il principal, la connessione e la destinazione, così da ricostruire
    esattamente cosa è accaduto.
30. Come amministratore, voglio che una copia di recupero venga rimossa solo con una
    richiesta successiva esplicita, così che un'apparente riuscita non consumi subito
    l'ultima possibilità di recupero.

## Implementation Decisions

### Confine di fiducia degli artefatti

- Un artefatto di database è input non fidato anche quando contiene checksum. Il checksum
  prova integrità rispetto al manifest, non autenticità.
- Export dell'intero database e backup convergono in una rappresentazione normalizzata:
  metadati del motore, collezioni, identità delle righe, dati, DDL delle collezioni e
  oggetti di schema.
- La validazione DDL estrae il tipo di istruzione e il bersaglio effettivo. Non usa la
  presenza testuale del nome atteso come prova.
- Sono ammesse soltanto le forme necessarie a ricreare l'oggetto dichiarato. DDL su altri
  database, collezioni, principal, filesystem o configurazione vengono rifiutate.
- La deroga CLI per schema non sicuro resta esplicita, fuori dalla UI e accompagnata da
  un audit che conserva il fatto che la validazione è stata scavalcata.

### Piano immutabile

- Validazione e normalizzazione producono un piano privo di funzioni e serializzabile.
- Il piano contiene connessione, motore, destinazione, collezioni, ordine, identità per
  upsert, politica di conflitto, oggetti differiti, conteggi attesi, staging, recupero e
  strategia di promozione.
- UI e MCP confermano l'impronta crittografica del piano. L'esecuzione usa il piano
  registrato, non ricostruisce la richiesta dagli argomenti della seconda chiamata.
- CLI costruisce lo stesso piano e lo mostra prima dell'esecuzione quando l'operazione
  può sostituire una destinazione esistente.

### Identità e incrementali

- Ogni file dati SQL nel manifest dichiara le colonne dell'identità stabile e la loro
  origine: chiave primaria oppure vincolo univoco interamente non nullo.
- Una collezione MongoDB usa `_id`; un `since-field` non sostituisce l'identità.
- Una tabella priva di identità stabile può partecipare a un full verso una destinazione
  vuota, ma non a layer incrementali o differenziali.
- Il restore riverifica che l'identità dichiarata esista ancora nella destinazione e che
  tutte le sue colonne siano presenti nelle righe del layer.
- La verifica finale usa cardinalità e identità distinte per collezione; la somma delle
  operazioni applicate non è una prova sufficiente.

### Applicazione per strategia

- MySQL usa `INSERT ... ON DUPLICATE KEY UPDATE`; `REPLACE` è vietato nel motore di
  applicazione.
- PostgreSQL usa `ON CONFLICT` sull'identità dichiarata. Se l'identità non è disponibile,
  il piano fallisce prima della prima mutazione.
- MongoDB applica `replaceOne`/bulk upsert su `_id`; un errore diverso da namespace
  inesistente durante il `drop` interrompe l'intero piano.
- Nessun adattatore ingoia genericamente un errore di eliminazione.

### Staging, recupero e promozione

- Una destinazione inesistente viene costruita in staging e verificata prima di essere
  esposta col nome richiesto.
- Una destinazione esistente richiede una copia di recupero full, integra e verificata
  prima della prima mutazione.
- PostgreSQL promuove con uno swap di schema transazionale.
- MySQL e MongoDB usano il protocollo di recupero dichiarato dal piano. Non dichiarano
  atomicità del database dove il DBMS non la offre; conservano staging e recupero finché
  l'operatore non li elimina esplicitamente.
- La cancellazione della destinazione non è mai una preparazione best-effort: o è
  completata e verificata, oppure il piano non procede.

### Evento e canali

- L'import dell'intero database diventa una operazione lunga, coerente con ADR-0001:
  avanzamento, annullamento cooperativo, audit, riferimento dell'operazione e risultato
  finale passano dalla sua giuntura.
- Il browser non invia più una sequenza di eventi di creazione, drop e import per ogni
  collezione. Acquisisce il file, lo invia entro i tetti del trasporto e avvia una sola
  operazione con tab e destinazione congelati.
- UI, CLI e MCP chiamano lo stesso motore. Le differenze di canale riguardano soltanto
  acquisizione, conferma e presentazione.
- L'accesso al driver nativo continua a richiedere capability sull'intera connessione;
  questa decisione non contraddice ADR-0001.

### Esito e UX

- Gli esiti canonici sono `completato`, `ripristinato_dopo_errore` e
  `intervento_richiesto`.
- L'interfaccia mostra sempre destinazione, staging, recupero, fase corrente e ultimo
  errore. Non usa “completato” quando esistono problemi o verifiche mancanti.
- Il testo senza `drop` non promette upsert finché il piano non ha verificato identità e
  politica di conflitto.
- Chiudere un tab separa la vista dall'operazione ma non la classifica come fallita. Lo
  stato resta interrogabile dopo la riapertura.

### Isolamento dei test distruttivi

- Ogni E2E genera un suffisso casuale per database e schemi e conserva i nomi risolti in
  memoria, senza interpolare input esterno.
- Prima del primo comando distruttivo il test pretende un flag esplicito di ambiente E2E
  e verifica che ogni nome contenga il marcatore generato nella stessa esecuzione.
- Il cleanup elimina soltanto i nomi registrati dalla fixture corrente.
- Le credenziali predefinite amministrative restano documentate, ma la loro presenza non
  è considerata prova che il server sia usa-e-getta.

## Testing Decisions

### Che cosa rende buono un test

Un test osserva il contratto del piano o dell'operazione lunga, non le funzioni private.
Deve dimostrare due proprietà: nessuna mutazione prima della validazione completa e
nessun esito riuscito per uno stato finale divergente. Ogni test di regressione viene
eseguito almeno una volta con la barriera deliberatamente rotta e deve fallire.

### Seam principale: motore server-side di applicazione artefatti

Una strategia finta registrante simula database, collezioni, righe, DDL, errori di drop,
errori al batch N, fallimenti di verifica e rollback. Attraverso l'interfaccia pubblica
del motore si provano:

- artefatto ostile respinto prima di ogni chiamata mutativa;
- piano immutabile e conferma legata alla sua impronta;
- `drop` fail-closed;
- identità obbligatoria per gli incrementali;
- staging e copia di recupero creati prima della mutazione;
- errore in ogni fase con esito e audit corretti;
- verifica finale capace di trovare duplicati e oggetti mancanti;
- impossibilità di chiamare riuscito un piano parziale.

Il prior art è il contesto finto degli handler, la strategia finta usata dai test della
giuntura e i test puri del motore di backup.

### Seam DBMS: E2E mirati

- MySQL: tabella padre/figlia con `ON DELETE CASCADE` e trigger; un incrementale aggiorna
  il padre senza cancellare il figlio né attivare il ramo delete.
- MySQL e PostgreSQL: tabella senza PK/unique; la creazione del piano incrementale fallisce
  prima di scrivere.
- PostgreSQL: un lettore concorrente osserva o lo schema vecchio o quello nuovo durante
  la promozione, mai uno stato intermedio.
- MongoDB: credenziali capaci di inserire ma non droppare; `drop` richiesto fallisce e
  nessun documento viene inserito.
- Tutti i motori: errore dopo una collezione applicata; la destinazione originale resta
  utilizzabile o viene ripristinata dalla copia di recupero, che resta disponibile.

Il prior art è nelle suite E2E per backup, PostgreSQL, RBAC e nell'harness usa-e-getta.

### Seam di ingresso: file e operazione lunga

Con socket e contesto finti si invoca l'evento reale di import. Si verifica che un file
contenente DDL su un altro bersaglio non produca chiamate alla strategia, che avanzamento
e audit siano associati al tab originario, che la chiusura della vista non causi un retry
e che la riapertura recuperi lo stato finale.

Un test statico sulla registrazione degli eventi garantisce che l'import appartenga a una
sola famiglia e passi dalla giuntura delle operazioni lunghe, secondo ADR-0001.

## Out of Scope

- Rendere atomica una operazione che il DBMS non sa rendere atomica e chiamarla tale.
- Catturare le cancellazioni nei backup incrementali: resta una limitazione dichiarata;
  questa spec impedisce duplicazioni e false riuscite, non introduce un change log.
- Firmare crittograficamente i backup o costruire una PKI. Gli artefatti restano non
  fidati anche quando hanno checksum.
- Cambiare Extended JSON, il formato dei dati della griglia o il significato di database
  come schema su PostgreSQL.
- Consentire SQL arbitrario nei file importati. SQL Raw scritto consapevolmente
  nell'editor Query resta una funzionalità distinta.
- Riscrivere le operazioni di singola riga o la query libera che non passano dal motore di
  applicazione artefatti.
- Eliminare automaticamente copie di recupero e staging vecchi: una politica di retention
  potrà essere specificata separatamente dopo che esisteranno stati affidabili.

## Further Notes

La specifica riapre un dettaglio lessicale di ADR-0001 senza contraddirne la decisione:
il glossario descrive il backup come operazione lunga, e l'import completo ne possiede le
stesse proprietà. Il nuovo evento deve quindi entrare nella terza famiglia invece di
essere una successione frontend di eventi sui dati.

Il formato dei manifest dovrà aumentare versione. I backup storici privi di identità
stabile possono essere ripristinati solo come full verso una destinazione vuota; non
devono essere reinterpretati come incrementali sicuri.

L'ordine di consegna è codificato nei ticket: prima confine di fiducia e identità, poi
semantica degli adattatori, quindi orchestrazione, canali, UX e prove reali. La suite E2E
non è il posto in cui scoprire le invarianti comuni: serve soltanto a confermare le
garanzie specifiche dei DBMS.

---

## Chiusura

Tutti e nove i ticket sono `resolved`. Il programma ha consegnato: il confine di fiducia
unico sugli artefatti (`db/artefatti.js`), il manifest v2 con identità stabile, gli upsert
SQL senza ramo delete, i drop fail-closed, il motore di piano/staging/recupero
(`db/importPlan.js`) condiviso da import e restore, l'import come operazione lunga
server-side, i tre esiti canonici veritieri, l'harness distruttivo che possiede i propri
bersagli e la matrice E2E sui tre DBMS.

La documentazione è stata allineata alla chiusura: `CLAUDE.md` descrive il motore unico di
applicazione degli artefatti (§8-bis) e il manifest v2, ed elenca i nuovi comandi di test;
`CONTEXT.md` nomina i termini di dominio introdotti — artefatto, bersaglio, piano,
impronta, identità stabile, staging, copia di recupero, promozione, esito.

Prove eseguite in questa sessione di chiusura: `npm test` (suite unitaria completa, verde)
e `npm run impronte` (62/62). Gli E2E che richiedono un DBMS non sono stati rieseguiti qui:
la loro esecuzione è quella documentata nei ticket 03 e 09, su container usa-e-getta con
MongoDB 7 autenticato, MySQL 8 e PostgreSQL 16.

Il difetto preesistente segnalato dal ticket 09 — in `e2e-script-schede-ui` una `SELECT`
senza righe non conservava le intestazioni — è stato corretto a parte, fuori dal perimetro
di questa spec: le colonne di un result set sono ora dichiarate dal motore e non dedotte
dalle righe. `e2e-script-schede-ui` passa verde su MySQL 8 reale.
