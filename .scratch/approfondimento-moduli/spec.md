# Approfondimento dei moduli di CodeDB

Status: ready-for-agent
Type: spec

Origine: revisione architetturale del 19 agosto 2026 (branch `develop`), dieci candidati
di approfondimento con le correzioni applicate dopo verifica diretta sul codice.

---

## Problem Statement

Chi lavora su CodeDB paga tre prezzi ricorrenti, e nessuno dei tre è visibile finché non
si è già dentro al lavoro.

**Le stesse decisioni sono prese in più punti.** Correggere la costruzione di una SELECT
paginata richiede due modifiche identiche, una per motore SQL, e nulla segnala la seconda.
Scrivere il nome di una tabella nel modo giusto per il motore in uso è deciso in sette
posti diversi, di cui uno solo sa anche *se* quel nome vada quotato. La stessa voce di
audit è composta a mano in una quindicina di handler.

**Le regole valgono dove qualcuno si è ricordato di applicarle.** I tetti su righe, byte e
tempo esistono come funzioni disponibili, non come vincoli imposti: un adattatore che
dimentica di chiamarli resta senza tetto, ed è già successo — l'esecuzione in scrittura di
una query aggregata gira senza limite di tempo su entrambi i motori SQL. Il Proxy
autorizzante lascia passare invariato ogni metodo che non compare nella sua tabella, quindi
un metodo aggiunto senza voce nasce scoperto anziché protetto.

**Ciò che si rompe non è ciò che si prova.** Otto moduli puri sono stati estratti per
renderli verificabili, e sono verificati; ma i difetti veri vivono nei chiamanti, che non
sono raggiungibili da alcun test perché il modulo di trasporto apre la connessione al
momento in cui viene importato, chiudendo un ciclo che tira dentro l'intera applicazione.
Sul server la situazione è speculare: gli handler vivono dentro una chiusura di 1880 righe,
e i due test che li sorvegliano sono ridotti a leggere il file come testo e a bilanciare le
graffe con un'espressione regolare.

Il costo non è estetico. Un difetto reale — l'intero esecutore di script morto a ogni
invocazione per uno scambio fra `session` e `sess` — è vissuto senza che nulla lo
segnalasse, perché quel percorso non ha test.

## Solution

Un programma in dieci parti indipendenti, ciascuna delle quali sposta una decisione da
molti posti a uno solo, e la mette dove sia possibile provarla.

Il criterio di chiusura è lo stesso per tutte, raggiunto in tre gradini successivi:

1. **Copertura** — la decisione è presa in un posto solo.
2. **Provabilità** — quel posto si può esercitare senza aprire un socket e senza un
   database reale.
3. **Impossibilità strutturale** — un test fallisce se qualcuno reintroduce la decisione
   fuori da quel posto.

Ogni gradino è utile da solo, quindi si consegna a gradini, non tutto in fondo.

Due difetti già presenti e verificati non aspettano il programma: si chiudono subito, come
correzioni a sé, ciascuna con il test di regressione che fallisce prima della correzione.

## User Stories

**I due buchi verificati**

1. Come chi usa CodeDB su un database di produzione, voglio che una query aggregata in
   scrittura abbia un tetto di tempo come ce l'ha una in lettura, così che una query
   sbagliata non tenga occupata una connessione per sempre.
2. Come manutentore, voglio che il tetto di tempo venga dalla stessa fonte configurabile
   degli altri tetti invece di essere un numero scritto a mano, così che cambiarlo sia una
   modifica sola.
3. Come manutentore, voglio che i campi del payload riservati al server siano tolti da una
   regola esplicita e non dall'ordine in cui compaiono le chiavi in un letterale, così che
   riordinare quelle chiavi non riapra un varco.
4. Come manutentore, voglio che il registro dell'esecuzione di uno script non sia
   costruibile dal client, così che la categoria con cui l'operazione finisce nell'audit
   non sia influenzabile da chi la richiede.

**Le decisioni duplicate**

5. Come manutentore, voglio correggere la costruzione di una SELECT paginata una volta
   sola, così che i due motori SQL non divergano in silenzio.
6. Come manutentore, voglio provare la costruzione di una SELECT senza avere un database
   acceso, così che un errore di paginazione si scopra in un secondo e non in un test
   end-to-end.
7. Come manutentore, voglio che «come si scrive un nome in questo motore» sia una domanda
   con una risposta sola, così che il difetto degli identificatori non quotati su
   PostgreSQL non possa ripresentarsi in sei punti diversi.
8. Come manutentore, voglio che la regola sappia anche *se* un nome vada quotato e non solo
   come, così che il comportamento sia quello giusto e non quello prudente.
9. Come manutentore, voglio scrivere una voce di audit chiamando una cosa sola, così che
   un'operazione amministrativa non possa finire senza traccia perché chi l'ha scritta ha
   dimenticato di copiare quelle righe.
10. Come manutentore, voglio che la ricerca della sessione a partire dal tab sia fatta in
    un posto solo, così che il messaggio d'errore mostrato all'utente sia lo stesso ovunque
    e non ci sia occasione di scambiare due variabili omonime.

**I tetti e le protezioni**

11. Come chi amministra un'installazione condivisa, voglio che i tetti su righe, byte e
    tempo siano imposti dalla giuntura e non lasciati alla memoria di chi scrive un
    adattatore, così che un motore aggiunto in futuro nasca già limitato.
12. Come chi amministra un'installazione condivisa, voglio che un metodo di strategia privo
    di regola di autorizzazione venga rifiutato anziché lasciato passare, così che
    dimenticare una voce nella tabella produca un errore evidente invece di un varco
    silenzioso.
13. Come manutentore, voglio un test che confronti la tabella delle autorizzazioni con i
    metodi pubblici delle strategie, così che sia impossibile aggiungere un metodo scoperto
    senza accorgersene.
14. Come manutentore, voglio che il divieto degli operatori che eseguono JavaScript sul
    server MongoDB sia definito una volta sola, così che le tre versioni oggi in giro non
    possano divergere.

**Il frontend**

15. Come chi usa CodeDB, voglio che la Split-View abbia le stesse capacità della vista
    Dati — virtualizzazione, selezione delle celle, scorrimento ai bordi, pannello delle
    chiavi esterne, geometrie — così che affiancare due tabelle non significhi rinunciare a
    metà dell'applicazione senza essere avvisato.
16. Come chi usa CodeDB su tabelle grandi, voglio che la Split-View non disegni tutte le
    righe in una volta, così che aprirne una non blocchi l'interfaccia.
17. Come manutentore, voglio che un miglioramento alla griglia arrivi a tutte e tre le
    viste per costruzione, così che il lavoro fatto in un punto non debba essere ripetuto
    negli altri due.
18. Come manutentore, voglio poter importare il modulo di trasporto senza tirarmi dietro
    toast, modali e icone, così che i file che lo usano diventino caricabili in un test.
19. Come manutentore, voglio provare la riconnessione automatica e l'annullamento su tab
    chiuso, così che i tre difetti già corretti in quel modulo abbiano una rete che
    impedisca loro di tornare.
20. Come manutentore, voglio che i moduli grandi del frontend siano raggiungibili da un
    test, così che i difetti che vivono nel *come vengono chiamate* le funzioni pure siano
    verificabili quanto le funzioni stesse.

**Il server**

21. Come manutentore, voglio poter invocare un handler passandogli un contesto finto, così
    che verificarne il comportamento non richieda di aprire un socket e una connessione.
22. Come manutentore, voglio che i quattro eventi di osservazione che oggi stanno fuori
    dalla giuntura vi rientrino, così che smettano di rifare a mano la ricerca della
    sessione e guadagnino la riconnessione che oggi non hanno.
23. Come manutentore, voglio che i punti in cui un'operazione lunga ha bisogno di
    comportarsi diversamente siano dichiarati ed elencati, così che «questo evento è
    speciale» smetta di essere un'affermazione da verificare a mano ogni volta.
24. Come manutentore, voglio che gli eventi che non toccano alcuna strategia siano
    riconosciuti come una famiglia a sé, così che non si tenti di farli passare per una
    giuntura pensata per i dati.
25. Come manutentore, voglio un test che fallisca se qualcuno registra un evento fuori
    dalle giunture previste, così che la situazione non si riformi fra sei mesi.

**Il filtro polimorfo**

26. Come manutentore, voglio che un filtro attraversi l'interfaccia della strategia in
    forma strutturata e non come testo, così che chi lo compone non debba sapere quale
    motore lo riceverà.
27. Come chi amministra un'installazione condivisa, voglio che l'autorizzazione legga i
    campi di un filtro anziché rianalizzarne il testo SQL, così che la protezione non
    dipenda dalla completezza di un'analisi sintattica.
28. Come manutentore, voglio che il metodo per leggere le righe riferite da una chiave
    esterna smetta di essere separato, così che l'interfaccia si accorci di un metodo
    esistente solo per aggirare l'ambiguità del filtro.

**Il modello di dominio**

29. Come nuovo arrivato sul progetto, voglio un glossario che distingua connessione,
    sessione e tab, così che leggere il codice non richieda di dedurre dai commenti quale
    delle tre un nome indichi.
30. Come futuro revisore dell'architettura, voglio trovare registrata la decisione di
    tenere separate le famiglie di evento, così da non riproporre l'unificazione che è già
    stata valutata e scartata.

## Implementation Decisions

### Vocabolario

Le decisioni usano il vocabolario di `/codebase-design` — modulo, interfaccia,
implementazione, profondità, giuntura, adattatore, leva, località — e i termini di dominio
di `CONTEXT.md`. Il livello «database» dell'interfaccia corrisponde allo schema su
PostgreSQL: la spec non cambia questa corrispondenza.

### Lotti

Le dieci parti sono indipendenti e si consegnano a lotti. L'ordine è per rapporto fra
conseguenza e costo, non per numerazione del report.

- **Lotto 0 — i due buchi verificati.** Il tetto di tempo mancante sull'esecuzione in
  scrittura; i due residui del payload di `query:execute`. Nessuna scelta di forma, nessuna
  dipendenza dal resto.
- **Lotto 1 — le decisioni duplicate meccaniche.** Il modulo comune ai due adattatori SQL;
  la regola unica per la scrittura degli identificatori.
- **Lotto 2 — le protezioni.** I tetti imposti dalla giuntura; il rifiuto in mancanza di
  regola nel Proxy autorizzante, con il test che confronta tabella e metodi pubblici; la
  definizione unica del divieto degli operatori server-side.
- **Lotto 3 — il trasporto del frontend.** Lo stacco del modulo di trasporto dal sacco di
  utilità; l'apertura del ciclo di import; i test sui chiamanti che questo rende possibili.
- **Lotto 4 — la griglia.** Il modulo unico dei risultati e le tre viste che diventano suoi
  chiamanti.
- **Lotto 5 — il server.** Il contesto passato invece che catturato; il rientro dei quattro
  eventi di osservazione; i punti di estensione delle operazioni lunghe resi espliciti; la
  giuntura amministrativa distinta.
- **Lotto 6 — il filtro strutturato.** Il più caro e il più caldo: si apre solo quando il
  lotto 1 è chiuso, per non avere due rifacimenti aperti sugli stessi file.

### Moduli e interfacce

**Il modulo tabellare comune ai due motori SQL.** Assorbe ciò che oggi i due adattatori
implementano in modo identico: costruzione della lista di selezione, dell'ordinamento,
della paginazione a chiave, composizione e lettura dell'identificatore di riga. Sono
funzioni pure: ricevono descrittori di colonna e restituiscono frammenti, senza toccare un
pool. I due adattatori restano per ciò che diverge davvero: scrittura degli identificatori,
tipi di colonna, DDL, geometrie, sessioni e lock.

**La regola di scrittura degli identificatori.** Una sola, condivisa fra frontend,
adattatori e motore di backup. Sa a quale famiglia di motore si riferisce, se il nome vada
quotato, e come raddoppiare il carattere di quotatura. Il candidato esiste già ed è il più
completo dei sette: gli altri sei diventano suoi chiamanti.

**I tetti imposti dalla giuntura.** L'interfaccia della strategia smette di offrire i tetti
come funzioni facoltative e li applica avvolgendo l'esecuzione. L'adattatore fornisce solo
il pezzo che varia fra motori. Il tetto di tempo diventa un valore configurabile letto
dalla stessa fonte degli altri, e vale su entrambi i rami — lettura e scrittura.

**Il Proxy autorizzante.** Il verso del default si inverte: un metodo privo di voce nella
tabella viene rifiutato, non lasciato passare. La tabella va completata prima
dell'inversione, altrimenti l'inversione rompe. Un test statico confronta la tabella con
l'elenco dei metodi pubblici delle tre strategie e fallisce sulle differenze.

**Il modulo di trasporto del frontend.** Esce dal sacco di utilità e diventa un modulo suo,
sul precedente già stabilito in casa per il modulo dei valori. Il socket diventa una
dipendenza accettata anziché creata al caricamento: è questo, non lo stacco in sé, che apre
il ciclo di import.

**La griglia dei risultati.** Un modulo che riceve righe, colonne e le capacità richieste, e
restituisce la griglia. Le tre viste — Dati, Query, Split-View — diventano chiamanti. Le
capacità che oggi solo la prima ha (virtualizzazione, paginazione a chiave, selezione delle
celle, scorrimento ai bordi, pannello delle chiavi esterne, geometrie, modifica inline)
diventano opzioni della stessa interfaccia, non implementazioni separate.

**Le tre famiglie di evento.** Il server riconosce tre famiglie invece di una:

- **Eventi sui dati** — delegano a una strategia; passano dalla giuntura esistente, che
  già applica sette decisioni ed è profonda. I quattro eventi di osservazione vi rientrano.
- **Eventi amministrativi** — non toccano alcuna strategia (vault, utenti, permessi, chiavi
  API, connessioni salvate, licenza, aggiornamenti, audit). Hanno una giuntura propria:
  audit e gate d'installazione sì, verifica della capability per database no, perché non
  hanno un database come bersaglio.
- **Operazioni lunghe** — esecuzione di query e di script, annullamento, backup. Hanno
  bisogno di punti di estensione che le altre due famiglie non hanno.

I punti di estensione delle operazioni lunghe sono otto, e vanno dichiarati esplicitamente
perché è la loro esistenza a giustificare la terza famiglia: rispondere prima che
l'operazione finisca; emettere avanzamento durante l'esecuzione; registrare un riferimento
di annullamento che cambia nel tempo anziché uno fissato all'ingresso; leggere lo stato
delle operazioni in corso senza registrarne una propria; interrompere un'esecuzione che
gira dentro CodeDB e non sul DBMS; decidere la categoria dell'audit a fine esecuzione
anziché all'ingresso; verificare la capability per singola istruzione anziché per evento;
operare su stato di sessione che non è una strategia.

**Il contesto della sessione.** Diventa un argomento invece di una cattura di chiusura. È la
modifica che rende gli handler invocabili da un test, e quindi il prerequisito del terzo
gradino del criterio di chiusura.

**Il filtro strutturato.** Attraversa l'interfaccia della strategia come dato, non come
testo. Ogni adattatore lo rende nel proprio dialetto parametrizzando. L'autorizzazione
legge i campi anziché rianalizzare SQL, e il metodo separato per le righe riferite da una
chiave esterna rientra nel metodo comune. È l'unica parte che cambia la forma di
un'interfaccia usata anche dal gateway MCP: il contratto va cambiato in entrambi i
chiamanti nello stesso lotto.

### Ciò che non cambia

L'accesso diretto del motore di backup al driver nativo resta: è dichiarato, motivato, e
autorizzato a parte sull'intera connessione. Non è il difetto, è il contorno.

Il formato Extended JSON fra client e server resta invariato in tutte le parti.

## Testing Decisions

### Che cosa rende buono un test, qui

Un test prova il **comportamento all'interfaccia**, non l'implementazione: si scrive contro
la stessa superficie che usano i chiamanti veri. Se per verificare qualcosa serve
raggiungere qualcosa *oltre* l'interfaccia, il modulo ha la forma sbagliata e va cambiata
la forma, non il test.

Ogni test scritto in questo programma va verificato **rompendo di proposito** il codice che
dovrebbe proteggere, almeno una volta. Un test che non fallisce mai non prova niente.

Per le due correzioni del lotto 0 il test di regressione si scrive **prima** e deve
fallire prima della correzione: sono difetti presenti, non ipotesi.

### Giunture su cui si prova

Tre esistenti, riusate:

- **L'interfaccia della strategia.** Già esercitata dal Proxy autorizzante e dai test
  end-to-end. Un adattatore finto in memoria a questa giuntura permette di provare i tetti
  senza un database: è il modo in cui si prova il lotto 2.
- **I moduli puri.** Il repo ne ha molti e li prova bene. Il modulo tabellare comune e la
  regola degli identificatori si provano così, senza infrastruttura.
- **La lettura statica del testo del codice.** Prior art esistente e riuscita: è il modo in
  cui è stato intercettato lo scambio fra variabili omonime. È il terzo gradino del
  criterio di chiusura per il lotto 2 (tabella contro metodi pubblici) e per il lotto 5
  (registrazione di eventi fuori dalle giunture previste).

Tre nuove, ciascuna con due adattatori veri e non ipotetici:

- **La registrazione dell'evento.** Adattatori: il contesto reale della sessione e un
  contesto finto. Giustifica la giuntura perché è ciò che rende gli handler invocabili.
- **Il trasporto del frontend.** Adattatori: il socket reale e un socket finto. Permette di
  provare riconnessione, annullamento su tab chiuso e marcatura dell'origine.
- **La griglia dei risultati.** Adattatori: le tre viste chiamanti.

L'ideale sarebbe una giuntura sola; qui sono tre perché il programma attraversa server,
adattatori e browser, che non condividono un ambiente di esecuzione.

### Prior art nel repo

Test unitari su moduli puri; test end-to-end per motore su database reale; un'istanza
usa-e-getta isolata su porta dedicata che non tocca il vault né la configurazione
dell'utente; test in Chromium con eventi tattili nativi per le assunzioni di piattaforma;
test statici che leggono i file sorgente come testo. Ognuna di queste forme ha già un
esempio funzionante da cui copiare la struttura.

### Copertura da guadagnare

Oggi non è raggiunto da alcun test unitario: il corpo degli handler socket; i tre file
grandi che disegnano una griglia; il modulo di trasporto del frontend; le funzioni di
costruzione delle query nei due adattatori SQL. Ognuno dei lotti sopra ne copre una parte,
ed è quella la misura del successo del lotto — non il numero di righe spostate.

## Out of Scope

- **Cambiare il comportamento visibile all'utente**, salvo dove è esplicitamente l'obiettivo
  (le capacità mancanti della Split-View) o dove il comportamento attuale è il difetto
  (l'esecuzione senza tetto di tempo).
- **Il gateway MCP**, salvo per l'adeguamento obbligato del contratto nel lotto 6.
- **Il motore di backup**: il suo accesso al driver nativo resta come è, e i suoi quattro
  eventi restano nella loro famiglia.
- **Introdurre un framework, un passo di build o un sistema di tipi.** L'applicazione è in
  JavaScript nativo senza build; nessuna parte di questo programma lo mette in discussione.
- **Il rifacimento della chiusura del server come riscrittura unica.** Il contesto passato
  invece che catturato è dentro il perimetro; smontare l'intero file in moduli non lo è.
- **Riscrivere i test esistenti** che già funzionano.

## Further Notes

**Una correzione da tenere presente.** La prima stesura della revisione dichiarava che il
tetto sui risultati fosse alzabile dal client tramite il payload di `query:execute`. È
falso: il campo viene scartato nella destrutturazione e ogni chiamata alle strategie passa
il valore del server. Restano due residui minori e veri, che sono nel lotto 0. Il candidato
che quel difetto sosteneva è stato declassato e la sua forma proposta era sbagliata: dei
quarantotto handler fuori dalla giuntura, solo quattro sono candidati puri.

Il modo in cui l'errore è nato vale più dell'errore: era stato verificato che la protezione
non venisse applicata, e da lì si era concluso — senza seguire il percorso fino in fondo —
che il campo arrivasse a destinazione. Le affermazioni di questo tipo vanno seguite fino
all'ultimo chiamante prima di essere scritte.

**Conteggi corretti.** Ottanta eventi socket: quarantotto registrati per la via generica,
trentadue per la giuntura che delega a una strategia.

**Nessun ADR pregresso da rispettare**: il repo non ne aveva. Il primo viene creato con
questa spec e riguarda le tre famiglie di evento, perché è la decisione che una futura
revisione dell'architettura riproporrebbe altrimenti — l'ha già fatto una volta.

**Ordine e concorrenza.** I lotti 1 e 6 toccano gli stessi file e non vanno aperti insieme.
Il lotto 5 tocca il file più caldo del repo: va aperto quando non c'è altro lavoro in corso
su di esso.
