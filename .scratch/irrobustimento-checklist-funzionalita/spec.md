# Irrobustimento trasversale della checklist funzionale

Status: ready-for-agent
Type: spec

Origine: audit statico del 26 agosto 2026 sulle ventitré aree di
`CHECKLIST-FUNZIONALITA.md`.

---

## Problem Statement

Chi usa CodeDB può incontrare comportamenti formalmente riusciti ma non fedeli alla
propria intenzione: una rinomina può perdere scritture concorrenti, valori numerici
esatti possono essere arrotondati, risposte fuori ordine possono essere mostrate nel
bersaglio sbagliato e un artefatto incrementale può non rappresentare le cancellazioni.
Altri percorsi accettano implicitamente identità non verificate, input ambiguo o risorse
senza un tetto, esponendo il server a blocchi, consumo di memoria o perdita di audit.

Questi difetti attraversano tutte le aree della checklist. Non sono ventitré anomalie
isolate: ricadono in sei classi comuni.

1. Il bersaglio o l'identità osservati all'inizio non vengono congelati fino alla fine.
2. Un valore esatto viene trasformato in una rappresentazione approssimata.
3. Un ripiego silenzioso inventa metadati o interpreta input ambiguo.
4. Un'operazione dichiara successo senza aver dimostrato lo stato finale promesso.
5. Un confine di fiducia accetta un'identità o una mutazione senza autorizzazione
   sufficiente.
6. Input, richieste pendenti o visualizzazioni non hanno un budget esplicito.

Il risultato per l'utente può essere perdita o modifica dei dati sbagliati, una vista che
non corrisponde alla collezione indicata, ripristini incompleti, diagnosi false, export
pericolosi da aprire e indisponibilità dell'applicazione. Poiché i percorsi coinvolti
sono normali funzionalità di amministrazione, l'interfaccia non deve affidarsi alla
prudenza dell'utente per conservare integrità e sicurezza.

## Solution

CodeDB introdurrà contratti trasversali verificabili per identità, esattezza, coerenza
temporale, autorizzazione e budget. Ogni operazione conserverà un contesto immutabile con
principal, connessione, tab, database, collezione e generazione della richiesta; una
risposta potrà produrre effetti soltanto se quel contesto è ancora quello corrente.

I valori numerici e temporali attraverseranno browser, eventi e strategie senza
conversioni implicite. La rappresentazione EJSON e i metadati della colonna guideranno
editing, inserimento, incolla e grafici. Quando CodeDB non conosce SRID, identità stabile,
tipo o fuso, fermerà la mutazione con un errore parlante invece di inventare un valore.

Le operazioni distruttive dimostreranno la propria postcondizione prima di eliminare la
copia sana. La rinomina proteggerà le scritture concorrenti; gli artefatti incrementali
descriveranno anche le cancellazioni; import e restore rifiuteranno input strutturalmente
ambiguo prima della prima mutazione. Gli esiti canonici già definiti per gli artefatti
continueranno a distinguere completamento, recupero riuscito e intervento richiesto.

I confini SSH ed Electron autenticheranno l'identità della controparte. Le capability
amministrative saranno espresse al livello tenant quando non esiste una collezione come
bersaglio. Preferenze condivise, conferme MCP e audit avranno autorizzazione, schema,
quote e persistenza osservabile.

L'interfaccia applicherà budget espliciti a schemi, grafi, regex e richieste pendenti. Il
superamento di un budget produrrà degradazione progressiva o un errore controllato, mai
un blocco indefinito. CSV, JSON/BSON, relazioni composite e diagnostica useranno parser e
modelli strutturati, evitando euristiche che perdono informazione.

## User Stories

1. Come amministratore, voglio rinominare un database senza perdere scritture concorrenti,
   così che il nome cambi ma lo stato confermato resti completo.
2. Come amministratore, voglio che l'origine venga eliminata solo dopo una verifica dello
   stato finale, così che un confronto basato su una copia vecchia non autorizzi un drop.
3. Come utente SSH, voglio approvare o fissare la chiave dell'host anche durante il test
   della connessione, così che test e apertura reale riconoscano lo stesso server.
4. Come utente SSH, voglio che un errore di persistenza del fingerprint renda il test non
   riuscito, così che una connessione apparentemente sicura non resti senza pinning.
5. Come utente desktop, voglio che Electron riconosca crittograficamente il proprio server
   locale, così che un altro processo non possa mostrarmi una falsa interfaccia CodeDB.
6. Come utente della griglia, voglio che una pagina arrivata in ritardo venga scartata,
   così che righe di condizioni o ordinamenti diversi non vengano mescolate.
7. Come utente della Split View, voglio che ogni riquadro mostri soltanto righe richieste
   dal suo contesto corrente, così che il titolo e i dati descrivano lo stesso bersaglio.
8. Come utente della Split View, voglio che una modifica conservi il contesto immutabile
   del riquadro, così che una risposta vecchia non provochi scritture su un'altra collezione.
9. Come utente dell'IntelliSense, voglio che una DDL renda obsolete anche le richieste di
   schema già in corso, così che una risposta tardiva non ripristini suggerimenti vecchi.
10. Come utente SQL, voglio modificare un BIGINT senza arrotondarlo, così che identificativi
    e contatori oltre la precisione JavaScript restino esatti.
11. Come utente MongoDB, voglio modificare un Long o Decimal EJSON senza convertirlo in
    `Number`, così che tipo e valore BSON siano preservati.
12. Come utente della modale di inserimento, voglio la stessa semantica numerica dell'editor
    inline, così che due percorsi equivalenti non producano dati diversi.
13. Come utente del copia e incolla, voglio una validazione esatta dell'intero blocco prima
    della prima scrittura, così che un errore non lasci una selezione applicata a metà.
14. Come utente del copia e incolla, voglio scegliere o conoscere la convenzione temporale,
    così che una data senza fuso non cambi istante silenziosamente.
15. Come analista, voglio che grafici e aggregazioni dichiarino quando un numero è
    approssimato, così che non prenda decisioni su somme apparentemente esatte.
16. Come analista finanziario, voglio aggregazioni decimali esatte quando il tipo lo
    richiede, così che totali e medie non accumulino errori binari.
17. Come utente GIS, voglio che lo SRID originale venga preservato durante una modifica,
    così che le coordinate non vengano reinterpretate in un altro sistema.
18. Come utente GIS, voglio un errore chiaro quando CodeDB non può conoscere lo SRID,
    così che l'assenza di metadata non diventi SRID 0 o 4326.
19. Come utente SQL, voglio vedere una foreign key composita come una sola relazione
    ordinata, così che ogni colonna locale corrisponda a quella referenziata corretta.
20. Come utente della griglia, voglio modificare una relazione composita atomicamente,
    così che non rimanga una chiave esterna parzialmente aggiornata.
21. Come autore di script Mongo, voglio un limite deterministico sulle regex, così che un
    pattern costoso non blocchi tutte le sessioni CodeDB.
22. Come amministratore del servizio, voglio poter interrompere una regex allo scadere del
    budget, così che il limite non dipenda da euristiche sul testo del pattern.
23. Come utente dell'export CSV, voglio header e celle conformi al formato CSV, così che
    virgole, quote e righe nuove non cambino la struttura del file.
24. Come utente dell'export CSV, voglio una modalità sicura per fogli elettronici, così che
    dati non fidati non vengano eseguiti come formule quando apro il file.
25. Come utente dell'import CSV, voglio che quote non chiuse e righe di ampiezza errata
    vengano rifiutate prima dell'import, così che colonne mancanti o extra non siano perse.
26. Come utente dell'import CSV, voglio un resoconto preciso di riga e colonna dell'errore,
    così che possa correggere il file senza tentativi distruttivi.
27. Come utente JSON/BSON, voglio che il lint riconosca solo costruttori supportati dal
    motore, così che un documento dichiarato valido sia anche eseguibile.
28. Come utente JSON/BSON, voglio essere avvisato delle chiavi duplicate, così che una
    normalizzazione non elimini silenziosamente un valore.
29. Come amministratore dei backup, voglio che un incrementale rappresenti inserimenti,
    modifiche e cancellazioni, così che il restore ricostruisca lo stato della sorgente.
30. Come amministratore dei backup, voglio che una catena storica priva di cancellazioni
    dichiari esplicitamente la propria limitazione, così che non venga scambiata per una
    ricostruzione completa.
31. Come operatore delle sessioni, voglio terminare la stessa sessione che ho ispezionato,
    così che il riciclo di un identificatore non colpisca un altro principal.
32. Come operatore delle sessioni, voglio una conferma che mostri un'identità stabile della
    sessione, così che PID e operation ID non siano l'unica prova.
33. Come revisore, voglio che ogni record di audit confermato sia persistito oppure
    dichiarato fallito, così che la vista in memoria non nasconda una perdita su disco.
34. Come revisore, voglio rotazioni serializzate e numerate, così che eventi concorrenti
    non gareggino sullo stesso file.
35. Come amministratore delegato, voglio usare una capability amministrativa tenant-level,
    così che la gestione di principal e grant non richieda un bersaglio artificiale.
36. Come owner, voglio distinguere amministrazione tenant e capability su una connessione,
    così che un grant locale non allarghi accidentalmente i poteri globali.
37. Come sottoutente, voglio che le preferenze personali appartengano al mio principal,
    così che non modifichi involontariamente l'esperienza degli altri.
38. Come owner, voglio che le preferenze condivise richiedano amministrazione e siano
    validate e tracciate, così che scorciatoie o temi tenant-wide siano governabili.
39. Come client MCP, voglio quote chiare sulle conferme pendenti, così che un errore del
    client non consumi memoria senza limite.
40. Come amministratore MCP, voglio limiti per principal e globali espressi anche in byte,
    così che pochi piani grandi non aggirino un semplice limite numerico.
41. Come utente UML, voglio una sintesi progressiva degli schemi molto grandi, così che la
    visualizzazione rimanga interattiva.
42. Come utente del grafo 3D, voglio che effetti e dettagli si riducano oltre una soglia,
    così che un catalogo grande non saturi memoria o GPU.
43. Come utente della diagnostica, voglio che una dipendenza verso un altro database sia
    distinta da un ciclo interno, così che l'ordine suggerito non produca falsi positivi.
44. Come manutentore, voglio che i cicli siano calcolati con un algoritmo che ne dimostri
    l'appartenenza, così che “non ordinato” non significhi automaticamente “ciclico”.
45. Come manutentore, voglio contratti condivisi per precisione, contesto e budget, così
    che ogni nuova vista erediti le stesse garanzie.
46. Come manutentore, voglio testare risposte fuori ordine con socket controllabili, così
    che le race siano riproducibili senza dipendere dalla rete reale.
47. Come manutentore, voglio testare operazioni distruttive con strategie finte registranti,
    così che sia dimostrabile l'assenza di mutazioni prima delle barriere.
48. Come manutentore, voglio E2E limitati alle garanzie specifiche dei DBMS e dei processi,
    così che la suite comune resti veloce e deterministica.
49. Come manutentore, voglio rompere deliberatamente ogni barriera nuova almeno una volta,
    così che un test incapace di fallire non venga considerato una prova.

## Implementation Decisions

### Contesto immutabile e coerenza temporale

- Ogni richiesta browser che può aggiornare una vista riceve una generazione monotona e
  conserva tab, database, collezione, condizione, ordinamento e pagina richiesti.
- Una risposta modifica la vista soltanto se generazione e contesto coincidono ancora.
  Questa regola vale per griglia, caricamento incrementale, Split View e schema
  dell'IntelliSense.
- Una mutazione non legge il bersaglio da stato globale mutabile dopo che l'utente l'ha
  iniziata. Il comando conserva il contesto del riquadro o del tab che l'ha originata.
- Invalidare uno schema incrementa la generazione e invalida sia il valore memorizzato sia
  le richieste in corso; una risposta vecchia non può ripopolare la cache.

### Rappresentazione esatta dei valori

- Un solo codec di dominio converte tra input testuale, EJSON, tipo di colonna e valore
  trasportato. Editor inline, inserimento e clipboard usano il medesimo contratto.
- BIGINT, BSON Long e Decimal non attraversano mai `Number` prima della strategia. La
  rappresentazione testuale canonica resta esatta e conserva il tipo.
- Le date prive di fuso non vengono interpretate implicitamente. Il contratto distingue
  data, timestamp locale e istante UTC e l'interfaccia rende visibile la scelta.
- Grafici e statistiche usano aritmetica esatta dove il tipo la richiede. Quando una
  visualizzazione deve approssimare, conserva il valore originale e mostra l'avviso.
- La modifica di una geometria conserva lo SRID letto dal valore o dai metadata. SRID
  ignoto è uno stato esplicito che impedisce la scrittura, non un valore predefinito.

### Relazioni e diagnostica strutturate

- Le foreign key sono descritte a livello di vincolo, con coppie ordinate di colonne
  locali e referenziate. Una relazione composita non viene appiattita in relazioni
  indipendenti.
- Il selettore di relazione applica atomicamente tutte le colonne del vincolo oppure non
  offre la mutazione quando il valore referenziato non è completo.
- L'analisi delle dipendenze costruisce il grafo interno solo con nodi presenti nel
  database osservato e registra separatamente le dipendenze esterne.
- I cicli vengono individuati tramite componenti fortemente connesse; nodi esclusi da un
  ordinamento per cause diverse non vengono chiamati ciclici.

### Operazioni distruttive e artefatti

- La rinomina è un'operazione lunga. Il piano dichiara la garanzia disponibile per il
  motore e congela o recupera le scritture avvenute fra copia e promozione.
- L'origine viene eliminata soltanto quando la postcondizione confronta lo stato corrente,
  non soltanto l'artefatto creato all'inizio. Se la garanzia non è disponibile, CodeDB
  conserva l'origine e restituisce un esito non completato.
- Gli incrementali e differenziali di nuova versione rappresentano le cancellazioni con
  tombstone o con un log ordinato prodotto da una sorgente affidabile del DBMS.
- Manifest e piano dichiarano esplicitamente la semantica delle cancellazioni. Una catena
  storica che non le possiede non può dichiarare equivalenza completa con la sorgente.
- Questa decisione estende deliberatamente la precedente specifica di integrità di import
  e ripristino, dove la cattura delle cancellazioni era fuori perimetro. Non contraddice
  il suo motore unico di applicazione degli artefatti: ne amplia il contratto del layer.

### Parsing e scambio di file

- L'import CSV usa un parser strutturale che conserva posizione e stato delle quote e
  rifiuta EOF dentro una cella quotata, righe con ampiezza diversa e header duplicati.
- L'intero file viene validato e sottoposto a budget prima della prima mutazione. Anteprima
  ed esecuzione condividono la stessa rappresentazione normalizzata.
- L'export CSV applica escaping uniforme a header e celle. La modalità sicura per fogli
  elettronici neutralizza valori che iniziano con caratteri interpretabili come formula;
  l'export letterale resta un'opzione esplicita.
- Il parser JSON/BSON usa lo stesso vocabolario di costruttori del motore di esecuzione e
  segnala chiavi duplicate dopo la normalizzazione del nome.

### Confini di fiducia e autorizzazione

- Test e apertura di una connessione SSH passano dallo stesso protocollo di verifica. Una
  chiave sconosciuta richiede approvazione esplicita o una politica TOFU persistita prima
  che l'operazione sia dichiarata riuscita.
- Electron avvia o riutilizza soltanto un server che dimostra di possedere un segreto
  casuale della stessa istanza. Un marker pubblico non costituisce identità.
- Le capability su connessione mantengono un bersaglio e uno scope. L'amministrazione di
  principal, grant, chiavi API e preferenze condivise usa invece una capability tenant-level
  coerente con la famiglia degli eventi amministrativi dell'ADR-0001.
- Le preferenze personali sono indicizzate anche per principal. Le preferenze condivise
  hanno chiavi e schema ammessi, limite di dimensione, autorizzazione amministrativa e audit.

### Budget, isolamento e osservabilità

- Le regex fornite dagli script vengono eseguite fuori dal thread dell'evento, in un
  ambiente terminabile allo scadere del budget. Le euristiche preventive restano una
  difesa aggiuntiva, non la garanzia principale.
- Le conferme MCP pendenti hanno limiti per principal e globali su numero e byte, una sola
  scadenza autorevole, pulizia temporizzata e comportamento deterministico di rifiuto.
- UML e grafo 3D ricevono un riepilogo entro budget e caricano dettagli progressivamente.
  Effetti grafici, particelle e conservazione del buffer vengono ridotti oltre soglie
  misurate e accessibili alla diagnostica.
- L'audit usa una coda seriale per destinazione. Append, flush e rotazione hanno esito
  osservabile; un errore su disco non viene rappresentato come record persistito.
- Il kill di una sessione usa l'identità più stabile offerta dal DBMS e la rivalida subito
  prima del comando. Un identificatore numerico riciclato non è prova sufficiente.

### Eventi e ADR

- Le nuove operazioni rispettano le tre famiglie dell'ADR-0001. Rinominare e applicare una
  catena di artefatti sono operazioni lunghe; preferenze condivise e identità Electron
  appartengono agli eventi amministrativi; letture e mutazioni di collezioni restano
  eventi sui dati.
- Nessuna giuntura universale viene introdotta. I contratti condivisi sono valori e
  validatori profondi consumati dalle tre giunture, non parametri opzionali aggiunti a una
  giuntura superficiale.
- La ricerca globale e la sua appartenenza alle strategie, stabilite dall'ADR-0002, non
  cambiano.

## Testing Decisions

### Che cosa rende buono un test

Un test osserva il comportamento al confine pubblico: evento e acknowledgment, comando e
postcondizione, file e rappresentazione importata, vista e contesto mostrato. Non asserisce
nomi di funzioni private o dettagli di memorizzazione. Per una mutazione dimostra sia il
risultato corretto sia l'assenza di effetti sul bersaglio sbagliato. Per un limite dimostra
che il lavoro viene terminato e che il server resta responsivo.

Ogni regressione critica deve essere sottoposta a prova di sensibilità: si disattiva
temporaneamente la barriera che dovrebbe proteggerla e il test deve fallire per la ragione
attesa.

### Seam principale: confine browser-evento

Un socket controllabile riceve le richieste reali delle viste e permette di consegnare gli
acknowledgment in qualunque ordine. Attraverso le API pubbliche di griglia, Split View e
IntelliSense si prova che:

- una pagina di una generazione precedente non compare nella vista corrente;
- cambiare collezione prima dell'ack non cambia il bersaglio della mutazione originaria;
- invalidare lo schema impedisce a una richiesta vecchia di ripopolare la cache;
- BIGINT, Long, Decimal, date e geometrie attraversano editor, insert e clipboard senza
  perdita o ripieghi impliciti;
- una foreign key composita viene mostrata e modificata come vincolo unico.

Il prior art è costituito dai test delle viste di selezione celle, dello stato dei tab,
della Split View, dell'IntelliSense e dai test puri EJSON/BSON già presenti.

### Seam server: evento pubblico con strategia finta

Una strategia finta registrante espone le stesse operazioni pubbliche delle strategie reali
e consente di sospendere copia, promozione, audit e kill. Attraverso gli eventi reali si
prova che:

- una scrittura concorrente durante la rinomina viene inclusa o impedisce il completamento;
- nessun drop dell'origine avviene prima della verifica corrente;
- una capability tenant-level autorizza soltanto gli eventi amministrativi previsti;
- una preferenza condivisa non può essere scritta da un principal privo di amministrazione;
- errori di append o rotazione dell'audit diventano osservabili;
- quote MCP rifiutano piani oltre numero o byte ammessi e liberano memoria alla scadenza;
- una sessione che cambia identità fra ispezione e kill non viene terminata.

Il prior art è costituito dalle strategie finte dei test delle giunture, dai test di scope
degli handler, dalle suite RBAC/MCP e dai test unitari del motore degli artefatti.

### Seam puro: codec, parser e modelli

Test tabellari attraversano l'interfaccia pubblica dei codec e dei parser con valori limite:

- interi a `2^53 - 1`, `2^53`, `2^53 + 1` e limiti signed/unsigned a 64 bit;
- decimali con molte cifre, esponenti e zeri significativi;
- date con e senza fuso e passaggi dell'ora legale;
- CSV con quote, virgole, CRLF, righe nuove, formule, celle mancanti o extra;
- costruttori BSON ammessi e vietati, chiavi duplicate e numeri non rappresentabili;
- FK composite, dipendenze esterne, autoanelli e componenti fortemente connesse.

Il prior art è costituito dai test unitari di JSON/BSON, statistiche celle, tipi colonna,
calcoli, relazioni e layout.

### Seam dipendente dall'ambiente: E2E mirati

- PostgreSQL e MySQL: geometria con SRID non predefinito, metadata negati e modifica che
  deve preservare lo SRID o fallire prima della scrittura.
- PostgreSQL: foreign key composita e sessione identificata da PID più istante di avvio.
- MongoDB, MySQL e PostgreSQL: rinomina con scrittore concorrente e verifica dello stato
  finale prima della rimozione dell'origine.
- Backup: full, inserimento, aggiornamento, cancellazione, incrementale e restore devono
  ricostruire esattamente identità e cardinalità finali.
- SSH: test e connessione contro host con chiave nota, nuova e cambiata.
- Electron: processo estraneo sulla porta prevista e server autentico con segreto errato.
- Regex: pattern avverso deve scadere lasciando responsivi handshake e un secondo evento.

Questi E2E usano esclusivamente ambienti usa-e-getta e nomi posseduti dall'harness. Il
prior art è nelle suite E2E MongoDB, MySQL, PostgreSQL, backup, RBAC, MCP e nell'harness
isolato già adottato dal progetto.

## Out of Scope

- Cambiare il significato di database come schema su PostgreSQL.
- Unificare le tre famiglie di eventi o riaprire ADR-0001.
- Spostare la ricerca globale fuori dalle strategie o riaprire ADR-0002.
- Garantire atomicità globale quando il DBMS non la offre; in quel caso CodeDB deve
  dichiarare il limite e conservare una copia sana, non simulare la garanzia.
- Correggere o riscrivere librerie grafiche vendorizzate; il perimetro riguarda i dati e i
  budget con cui CodeDB le alimenta.
- Rendere sicuro l'apertura di un CSV letterale in ogni programma esterno. CodeDB fornisce
  una modalità sicura per fogli elettronici e rende esplicita quella letterale.
- Introdurre una PKI generale per processi locali o host SSH. Servono identità per istanza
  e pinning affidabile, non una nuova infrastruttura di certificazione.
- Migrare automaticamente catene di backup storiche prive di informazione sulle
  cancellazioni. Restano leggibili con semantica e limiti espliciti.

## Further Notes

La specifica raggruppa i ventitré rilievi dell'audit per causa comune, ma pretende una
regressione tracciabile per ciascuna area della checklist. Una correzione locale non chiude
la relativa classe: per esempio sostituire una singola chiamata a `Number` non basta se
insert, clipboard o grafici continuano a perdere precisione.

L'estensione degli incrementali riapre consapevolmente una scelta della precedente
specifica “Integrità di import e ripristino”: lì le cancellazioni erano dichiarate fuori
perimetro. Il motore di piano, staging, copia di recupero, promozione ed esiti resta il
fondamento e non deve essere duplicato.

La consegna consigliata procede per barriere riusabili: prima contesto immutabile e codec
esatto; poi operazioni distruttive e artefatti; quindi fiducia e autorizzazione; infine
budget, parsing e visualizzazioni. Ogni fase deve lasciare verde la suite unitaria completa
e aggiungere soltanto gli E2E necessari a dimostrare semantiche esterne.
