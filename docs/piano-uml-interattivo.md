# Piano — UML interattivo con JointJS

Stato: piano del 16 settembre 2026. **Parzialmente implementato** — vedi
«[Stato dell'implementazione](#stato-dellimplementazione)» in fondo, che dichiara
riga per riga che cosa è stato consegnato, che cosa è stato consegnato per una
via diversa da quella qui proposta, e che cosa resta fuori.

## Obiettivo e perimetro

Rendere UML uno spazio principale di lavoro di CodeDB: comporre un diagramma come in un editor visuale, comprendere lo schema, consultare i dati reali e seguire i collegamenti senza perdere il contesto. Il riferimento a draw.io riguarda la manipolazione del diagramma; il valore specifico di CodeDB è il collegamento con il database.

La prima versione completa comprende esplorazione, composizione, salvataggio, esportazione e accesso ai dati. Include nodi di progetto e relazioni logiche modificabili, oltre agli oggetti letti dal database. Le modifiche del diagramma non eseguono DDL implicitamente. Le operazioni reali su tabelle e colonne restano disponibili tramite i flussi CodeDB esistenti, con bersaglio esplicito e aggiornamento del diagramma dopo l'esito.

Un progettista di migrazioni che trasformi un intero modello in DDL, la collaborazione simultanea e l'importazione del formato draw.io non sono richiesti per questo perimetro e non sono inclusi. La loro assenza non limita trascinamento, editing del modello, consultazione o salvataggio.

## Evidenze nel codice attuale

| Area | Stato osservato | Conseguenza per il piano |
|---|---|---|
| `public/js/uml.js` | SVG ricostruito con `innerHTML`; oggetto focale e vicini; esclusione degli auto-riferimenti | Sostituire il renderer con Graph/Paper JointJS e includere cicli e relazioni tra tutti i nodi visibili |
| Campi UML | `MAXF: 11`, nomi e tipi abbreviati; richiesta iniziale di 24 campi | Distinguere sintesi nel nodo da metadati completi consultabili |
| Accesso | `loadUml()` richiede database e collection; ingresso nel menu Visualizza | Rendere UML una vista evidente e apribile anche dal database |
| `db/schemaProgressivo.js` | Pagine di collection, campi tagliati fino a 200 e relazioni tagliate senza cursori propri | Aggiungere una continuazione reale per ogni risorsa; alzare i tetti non risolve |
| `server/eventi-dati.js` | `db:schema` legge tutto tramite `dbSchema()` prima di limitare il risultato | La paginazione attuale riduce il payload, non il lavoro sul database |
| Strategie SQL | `dbSchema()` restituisce relazioni meno ricche di `columnRelations()` | Riutilizzare la semantica delle relazioni già necessaria alla griglia, preservando coppie di colonne e destinazione |
| MongoDB | `dbSchema()` campiona 50 documenti per collection | Esplicitare campionamento e copertura: non chiamarlo schema esaustivo |
| Dati collegati | `collection:relations`, `collection:find`, `fk-relazioni.js`, `fk-vista.js` già presenti | Riutilizzare filtri strutturati, EJSON e descrittori, senza un secondo motore di query |
| Stato | `state` segue il tab attivo; un canvas DOM condiviso | Congelare contesto e identità richiesta; una risposta tardiva non deve cambiare un altro diagramma |

## Esperienza prevista

Ingresso «UML» visibile accanto alle altre viste. Dal database si apre la panoramica; da una tabella si apre il suo contesto. Il cambio di vista conserva posizione, selezione e modifiche.

```text
UML · connessione / database     Diagramma: Vendite     Salvato
[Esplora | Modifica diagramma] [Annulla] [Ripeti] [Disponi] [Esporta]
┌──────────────────┬─────────────────────────────────┬──────────────────────┐
│ Cerca oggetti    │                                 │ Dettagli selezione   │
│ Tabelle         │    clienti ───────── ordini       │ Campi / Vincoli      │
│ Collezioni      │                       │          │ Indici / Relazioni   │
│ Viste           │                    righe_ordine  │ Note / Proprietà     │
│ Note / Gruppi   │                                 │ Apri dati            │
├──────────────────┴─────────────────────────────────┴──────────────────────┤
│ Dati dell'oggetto selezionato · filtri · paginazione · Apri nella griglia │
└─────────────────────────────────────────────────────────────────────────┘
```

Catalogo e ispettore sono richiudibili; i dati si aprono su richiesta. Su schermi piccoli l'ispettore diventa un pannello sovrapposto. La vista intera è utilizzabile anche senza aprire il pannello dati.

### Interazioni da consegnare

| Azione | Comportamento atteso |
|---|---|
| Trascinare un oggetto dal catalogo | Inserisce la tabella/collection nella posizione del rilascio, corretta anche dopo zoom e pan; un oggetto già presente viene evidenziato |
| Trascinare nodi | Spostamento singolo o multiplo; snap alla griglia disattivabile; collegamenti seguono i campi |
| Selezionare | Clic, selezione multipla con modificatore, rettangolo di selezione e selezione da catalogo |
| Navigare | Pan, zoom al puntatore, adatta alla vista, centra selezione, pulsanti equivalenti e mini-mappa |
| Organizzare | Allinea, distribuisci, blocca posizione, raggruppa e comprimi; disposizione automatica esplicita che rispetta i nodi bloccati |
| Esplorare | Cerca tabelle e campi, evidenzia relazioni, espandi vicini, torna alla selezione precedente |
| Modificare | Aggiungi nota, gruppo, entità di progetto e relativi campi; duplica elementi di progetto; modifica etichette e colori |
| Collegare campi | Trascina da una porta a un'altra; scegli nome, cardinalità e coppie di colonne nel caso composito; crea una relazione logica |
| Rimuovere | «Rimuovi dal diagramma» nasconde un oggetto reale; elimina una nota o un oggetto di progetto; non elimina tabelle o vincoli nel DB |
| Annullare/ripetere | Una voce per gesto completo, compreso spostamento multiplo; riguarda il diagramma, non scritture DB già eseguite |
| Aprire dati | Clic su «Dati» o doppio clic sul titolo apre dati reali; azione separata per aprire la griglia completa o Split-View |

In «Esplora» i gesti principali sono navigazione e consultazione; in «Modifica diagramma» si attivano spostamenti, strumenti e collegamenti. Tastiera: Esc annulla il gesto, frecce spostano la selezione in modifica, Canc rimuove dal diagramma, Ctrl/Cmd+Z e Ripeti agiscono solo quando il canvas ha il fuoco. Non intercettare scorciatoie negli editor di testo. Tutte le azioni di trascinamento hanno un'alternativa tramite pulsanti o menu.

### Nodi e relazioni leggibili

I nodi reali mostrano nome, database/schema, tipo di oggetto, colonne con tipo esatto e indicatori PK/FK/nullabilità quando noti. Espansione e ricerca consentono di raggiungere ogni campo; l'ispettore mostra senza abbreviazioni default, indici, vincoli, commenti e attributi disponibili. Le viste sono identificate come tali e incluse nel catalogo quando supportate, senza inventare relazioni o proprietà non disponibili.

Le relazioni hanno tre origini esplicite: **vincolo DB**, **rilevata**, **logica del diagramma**. Usare etichette e tratteggi oltre al colore. Cardinalità e opzionalità derivano dai vincoli effettivi oppure sono indicate come ipotesi; `many: true` da solo non prova una cardinalità completa. Una FK composta è un collegamento con tutte le coppie ordinate, non più relazioni indipendenti. Auto-riferimenti, collegamenti paralleli e destinazioni in altri schemi sono gestiti esplicitamente.

I campi fuori dalla porzione visibile del nodo mantengono un riferimento nell'ispettore; i link si ancorano a una porta riassuntiva dichiarata finché il campo non viene espanso. Non ancorare una relazione alla riga di un altro campo.

### Significato di «dati completi»

1. **Metadati:** tutti quelli esposti dal DB e autorizzati sono raggiungibili, anche oltre i limiti della prima pagina. La UI distingue «caricato», «parziale», «non disponibile» ed «errore».
2. **Righe/documenti:** consultazione paginata di tutti i risultati autorizzati, filtri e ordinamento tramite i percorsi esistenti. Nessun caricamento indiscriminato dell'intera tabella nei nodi.
3. **Valori:** dettaglio della riga/documento con EJSON, array, sottodocumenti e valori lunghi; nessuna perdita di precisione introdotta dall'UML.
4. **MongoDB:** campi e percentuali osservati riportano campione e data. Offrire approfondimento con budget esplicito; nemmeno un campione più grande certifica l'assenza di altri campi.

Selezionando una riga e una relazione si possono consultare i record collegati. Il filtro usa tutte le coppie della FK, preserva tipi e null e verifica la destinazione autorizzata; una relazione euristica non risolvibile mostra il motivo. La relazione senza riga selezionata apre il dettaglio del collegamento, non una query arbitraria. Le modifiche ai dati usano la griglia esistente.

## Scelta JointJS

Base proposta: **JointJS Community**, versione fissata e risorse locali sotto `public/vendor/`, caricate quando si apre UML. Conservare vanilla JavaScript, funzionamento offline di Electron, licenza e avvisi della distribuzione. Verificare packaging e service worker. Non introdurre un framework o un CDN a runtime.

JointJS gestisce modello grafico, rendering SVG, nodi, porte, collegamenti ed eventi. L'applicazione gestisce semantica DB, pannelli, salvataggio e comandi. Non mettere dati delle righe o credenziali negli attributi serializzati del grafo.

JointJS+ è un prodotto distinto: selezione avanzata, Stencil, PaperScroller, Navigator e CommandManager non vanno presunti disponibili nella Community. Il piano Community include implementazioni mirate delle interazioni richieste. Prima di implementarle, uno spike deve misurare quanto codice serve rispetto ai componenti Plus; un eventuale acquisto o cambio di distribuzione richiede una decisione esplicita, ma non è un prerequisito nascosto del piano.

Fonti: [distinzione JointJS e JointJS+](https://www.jointjs.com/), [documentazione ufficiale](https://docs.jointjs.com/). I dettagli tecnici verificati sono raccolti nella [ricerca JointJS](ricerca-jointjs.md).

## Architettura e contratti

### Tre stati distinti

- **Schema osservato:** metadati letti dal backend, con identità e completezza; non è modificabile trascinando un nodo.
- **Documento del diagramma:** posizioni, dimensioni, nodi presenti/nascosti, gruppi, note, entità di progetto, relazioni logiche e instradamento manuale.
- **Stato della vista:** zoom, pan, selezione, pannelli, richieste attive e dati temporanei.

Identificare gli oggetti con una tupla codificata di connessione, database/schema, tipo e nome; evitare concatenazioni ambigue con punti. Le relazioni reali hanno identità di vincolo e coppie ordinate. Le rinomine confermate dall'app aggiornano i riferimenti; cambi esterni ambigui richiedono riconciliazione, non associazioni per somiglianza.

Usare Graph/Paper per la rappresentazione; mantenere un documento CodeDB versionato come formato di salvataggio, con conversione esplicita. Importare solo tipi e attributi ammessi, non istanziare classi arbitrarie da un JSON esterno.

### Schema progressivo realmente completabile

Estendere il contratto progressivo mantenendo compatibili i consumatori esistenti: catalogo oggetti, campi per oggetto e relazioni devono avere cursori indipendenti, indicazione di fine e revisione dello schema. Le pagine si uniscono per identità e non possono declassare dettagli già caricati.

Una pagina successiva non deve rieseguire ogni campionamento MongoDB. Le strategie devono leggere solo la porzione richiesta o utilizzare uno snapshot di metadati limitato, con scadenza e invalidazione. Il nuovo percorso paginato passa dalle stesse verifiche RBAC del percorso corrente; i conteggi sono calcolati sugli oggetti autorizzati. Per SQL privilegiare query di catalogo aggregate rispetto a una query per ogni colonna o relazione.

Riutilizzare il descrittore di `columnRelations()` e la logica di `fk-relazioni.js`, estendendoli solo dove servono attributi reali ulteriori. `dbSchema()` non deve continuare a scartare colonne di destinazione, origine del collegamento e struttura delle FK composite. Preservare i campi legacy necessari al grafo 3D e agli altri consumatori durante la migrazione.

### Integrazione e ciclo di vita

`uml.js` resta il coordinatore pubblico; separare soltanto modello puro, gestione JointJS e persistenza quando la separazione evita dipendenze DOM nei test. Integrare `main.js`, `workspace.js`, tab/coll-tab e ripristino sessione per l'ingresso a livello database e la vista UML primaria.

Ogni lettura cattura tab, connessione, database, diagramma e generazione della richiesta. Alla risposta verificare identità e revisione prima di aggiornare cache o DOM. Gestire cambio database nello stesso tab, chiusura tab, riconnessione e logout. Alla dismissione rimuovere Paper, listener, observer e timer.

`schema:changed` e DDL locali invalidano i dati pertinenti e riconciliano lo schema senza azzerare il layout. Nuovi oggetti vengono segnalati nel catalogo; oggetti rimossi diventano riferimenti non risolti, con scelta di rimozione o ricollegamento. Nessuna relazione logica viene promossa a vincolo perché il nome coincide.

### Persistenza ed export

Diagrammi nominati, salvataggio automatico locale e stato «salvato / modifiche non salvate / errore». Utilizzare IndexedDB nativo per documenti e revisione: chiave per installazione/origine, utente, connessione e database. Un controllo di revisione evita sovrascritture silenziose fra finestre. Le connessioni temporanee usano un'identità temporanea e offrono export prima della chiusura.

Salvare il documento e le preferenze, escludendo righe, segreti e cache sensibili. Al riavvio caricare lo schema autorizzato e riconciliare i riferimenti. Al cambio utente non riaprire documenti del precedente; alla revoca dei permessi rimuovere dalla vista anche i metadati già caricati. Gestire quota e indisponibilità dello storage lasciando esportabili le modifiche.

Export/import JSON CodeDB versionato con limiti di dimensione, conteggio e validazione; export SVG e PNG del diagramma intero o della selezione, con stile incorporato e senza script, risorse remote o righe del pannello dati. Importazione in anteprima con riepilogo degli oggetti non risolti; non sovrascrivere il documento corrente senza una scelta esplicita. Il JSON permette trasferimento manuale, non sincronizzazione automatica fra dispositivi.

## Fasi di consegna

| Fase | Lavoro | Criterio di uscita |
|---|---|---|
| 1. Spike JointJS | Caricamento locale; nodo con campi e porte; link composito e auto-riferimento; drag, zoom, tema, smontaggio; inventario Community/Plus e layout disponibile | Browser ed Electron offline mostrano e manipolano un piccolo schema; scelta delle dipendenze documentata |
| 2. Fondamenta schema | Identità, descrittori relazioni, tipi SQL completi, paginazione campi/relazioni/catalogo, copertura MongoDB, scope e invalidazione | Raggiungibili tutti i metadati autorizzati di fixture oltre i tetti attuali, senza ripetere scansioni complete per pagina |
| 3. Esplorazione | Nuovo renderer, ingresso database, catalogo, ricerca, ispettore, espansione vicini, layout iniziale, selezione, pan/zoom e mini-mappa | Si esplorano schema e singola tabella senza perdere campi, auto-riferimenti o identità cross-schema |
| 4. Editing completo | Drag dal catalogo e sul canvas, multi-selezione, allineamento, gruppi, note, entità di progetto, link logici, annulla/ripeti | Un diagramma costruito e modificato è ripristinabile gesto per gesto; nessuna interazione del canvas scrive nel DB |
| 5. Lavoro sui dati | Pannello paginato, filtri, dettaglio EJSON, navigazione dei record collegati, apertura griglia/Split-View e comandi schema esistenti | Percorso cliente → ordini → righe funziona con FK semplici/composite e permessi limitati |
| 6. Persistenza e scambio | Diagrammi nominati, autosave, revisione, ripristino, riconciliazione, JSON/SVG/PNG | Riavvio e round-trip JSON conservano il documento; errori storage e modifiche esterne non fanno perdere lavoro |
| 7. Verifica e sostituzione | Accessibilità, prestazioni, race, RBAC, temi, offline e regressioni dei consumatori condivisi; rimozione del renderer precedente | Passano i criteri sotto; nessuna doppia implementazione lasciata come soluzione definitiva |

Le fasi sono incrementi verificabili della stessa feature: il completamento della fase 3 non equivale alla consegna dell'intero perimetro. La fase 1 deve validare presto anche la fattibilità di export, mini-mappa e cronologia nella distribuzione scelta.

## Verifica richiesta prima di dichiarare completato

Test puri nel sistema Node esistente per identità, merge pagine, relazioni composite, comandi annullabili e importazione. Test di integrazione dei contratti nelle harness DB già presenti. Prove browser sui gesti reali, non soltanto sui metodi del modello. Per ogni nuova protezione logica introdotta, verificare almeno una volta che la prova fallisca con una mutazione deliberata del comportamento protetto, poi ripristinare il codice e rieseguire.

| Scenario | Risultato da dimostrare |
|---|---|
| 250 tabelle, una con oltre 200 colonne, oltre 1.000 relazioni complessive | Nessun elemento irraggiungibile; fine caricamento corretta e nessun ciclo di «carica altri» |
| FK composta, due FK sugli stessi nodi, auto-FK, nomi omonimi in schemi diversi | Porte, identità e filtri corretti; nessuna fusione per nome |
| Passaggio rapido fra database e tab durante caricamento | Nessun dato, errore o autosave applicato al contesto sbagliato |
| Campi MongoDB rari, array e collection vuota | Campione dichiarato, tipi preservati, nessuna falsa completezza |
| Scope RBAC ristretto e revoca a sessione aperta | Nessuna esposizione di nomi, conteggi o righe non autorizzati; nuova lettura sempre autorizzata dal server |
| Drag dopo zoom/pan, spostamento multiplo, annulla/ripeti | Coordinate corrette e una singola azione annullabile per gesto |
| Import con HTML/script, tipi arbitrari, coordinate invalide o file enorme | Rifiuto o testo innocuo; nessuna esecuzione e documento corrente intatto |
| Refresh schema, rinomina o rimozione reale | Layout conservato e riferimenti riconciliati o segnalati, senza perdita silenziosa |
| Refresh pagina, riavvio Electron, quota storage, due finestre | Ripristino verificato oppure errore recuperabile; nessuna sovrascrittura silenziosa |
| Tastiera, tema chiaro/scuro, viewport ridotta | Tutte le azioni principali raggiungibili, focus visibile, stato non affidato solo ai colori |
| Grafo 3D, IntelliSense e pannello FK dopo le modifiche condivise | Contratti precedenti ancora funzionanti e autorizzazioni equivalenti |

Prestazioni: fissare hardware/browser e fixture nella fase 1. Obiettivi iniziali da misurare: trascinamento con p95 dei frame sotto 33 ms su 100 nodi/200 relazioni; nessun blocco UI oltre 100 ms durante inserimenti incrementali ordinari. Separare tempi DB, costruzione del modello e rendering. Su 1.000 oggetti di catalogo usare caricamento e visibilità progressivi, con il numero degli oggetti non disegnati sempre esplicito. Non promettere che 1.000 nodi espansi simultanei abbiano lo stesso costo di 100 nodi compatti.

Usare rendering asincrono/batch JointJS e dettaglio proporzionato allo zoom prima di aggiungere worker o altre dipendenze. Il layout automatico non deve rilanciare un calcolo globale ad ogni trascinamento; la libreria di layout eventualmente necessaria viene scelta dopo lo spike, con versione e costo dichiarati.

## Definizione di completamento

Keus può aprire UML da un database, trovare e trascinare oggetti, leggere ogni metadato disponibile, manipolare nodi e collegamenti logici, consultare dati e record riferiti, annullare modifiche al diagramma, salvare, chiudere, riaprire ed esportare il lavoro. L'esperienza funziona con i tre DBMS, i permessi reali, browser ed Electron, senza dipendere dalla rete per caricare JointJS.

Questo piano è basato sull'ispezione del codice e su fonti ufficiali. I criteri sopra sono verifiche da eseguire durante l'implementazione, non risultati di test già ottenuti.


---

## Stato dell'implementazione

Aggiornato al 16 settembre 2026 (terza passata: chiusura del perimetro —
gruppi annidati, contratto di paginazione corretto, incrementali, sagoma,
scenari e misure). Questa sezione è un rendiconto, non una
promessa: ciò che è dichiarato «fatto» è stato eseguito almeno una volta, ciò
che non lo è resta scritto qui come lavoro aperto.

### Consegnato

| Fase | Che cosa | Dove |
|---|---|---|
| 1 | JointJS Community 4.3.3 vendorizzato (MPL-2.0), caricato solo all'apertura della vista | `public/vendor/joint/`, `uml-paper.js` |
| 1 | Nodo con campi e porte, link composito, auto-riferimento, smontaggio pulito | `uml-paper.js` |
| 1 | Misure fissate: fixture, hardware e browser sotto in «Misure» | `test/e2e-uml-prestazioni.js` |
| 2 | Tre cursori indipendenti (catalogo, campi, relazioni) con revisione e fine per risorsa; relazioni paginate sul catalogo intero con rilevanza stabile al focus | `db/schemaProgressivo.js` |
| 2 | Fusione che non perde i pendenti: la pagina fusa dichiara ciò che manca ancora, non l'ultima risposta | `uml-modello.js` (`unisciPagine`) |
| 2 | Snapshot di sessione con scadenza e invalidazione: la seconda pagina non rilegge il catalogo né rifà il campionamento MongoDB | `db/schemaSnapshot.js`, `server/eventi-dati.js` |
| 2 | Copertura del campionamento dichiarata: documenti osservati e data viaggiano con lo schema e l'ispettore li mostra sempre | `MongoDbStrategy.js`, `uml.js` |
| 3 | Renderer sostituito: il precedente non esiste più | `uml.js` |
| 3 | Ingresso a livello **database** (coll-tab del database, menu dell'albero) | `colltabs.js`, `dbtree.js`, `workspace.js` |
| 3 | Catalogo cercabile (nomi e campi), ispettore, selezione, pan/zoom al puntatore, minimappa congelata durante i gesti, disposizione iniziale | `uml.js`, `uml-paper.js` |
| 3 | Metadati **completi** per oggetto (colonne e indici interi) via `collection:stats` | `uml.js` |
| 4 | Trascinamento dal catalogo e sul canvas, selezione multipla e rettangolo, spostamento di gruppo, note, entità di progetto, relazioni logiche, annulla/ripeti per gesto, blocco posizione, aggancio alla griglia | `uml.js`, `uml-paper.js` |
| 4 | Gesto nato al primo movimento: scegliere senza spostare non apre voci fantasma né autosave | `uml-paper.js` |
| 4 | Allineamento (sei modi) e distribuzione (due assi) dal menu «Ordina», una voce di storia per gesto, bloccati rispettati | `uml-modello.js`, `uml.js`, `uml-paper.js`, `index.html` |
| 4 | Gruppi anche annidati, con cornice, compressione su segnaposto esterno, normalizzazione anti-cicli all'import, crea/sciogli/rinomina da menu e ispettore | `uml-modello.js`, `uml.js`, `uml-paper.js` |
| 4 | Instradamento manuale: maniglie `linkTools.Vertices` (Community), aggiunta col clic, vertici salvati nel documento, «Raddrizza» da menu e ispettore | `uml-paper.js`, `uml.js`, `uml-modello.js` |
| 5 | Pannello dati paginato, scelta della riga, dettaglio EJSON con lo stesso albero della griglia, **righe collegate** con tutte le coppie della FK, apertura nella griglia e in Split-View | `uml.js` |
| 5 | Pan e rettangolo su eventi di puntatore, pizzico per lo zoom: il canvas si usa anche col dito | `uml-paper.js` |
| 6 | Diagrammi nominati, autosave, revisione contro sovrascritture fra finestre, ripristino dopo ricarica, riconciliazione, rinomina/duplica/elimina, export JSON/SVG/PNG sempre a dettaglio pieno, import validato | `uml-store.js`, `uml-modello.js`, `uml.js` |
| 6 | Storage indisponibile dichiarato senza mentire: niente più «salvato» sopra l'errore, lavoro in memoria ed export disponibili | `uml.js` |
| 7 | Rendering asincrono/batch, pittura differenziale della selezione, operazioni incrementali (aggiunta/sostituzione/spostamento senza rebuild), sagoma sotto zoom 0.5 | `uml-paper.js`, `uml.js`, `uml-modello.js` (`stessaStruttura`) |
| — | Identità dei vincoli nello schema: `constraint`, `ordine`, `toField`, `origine` sulle relazioni dei tre motori | `MySqlStrategy.js`, `PostgreSqlStrategy.js`, `DbStrategy.js` |

Verifiche eseguite: `test/unit-uml-modello.js` e `test/unit-schema-progressivo.js`
(nel giro di `npm test`), `test/e2e-uml.js`, `test/e2e-uml-scenari.js` e
`test/e2e-uml-prestazioni.js` (Chromium, JointJS vero, nessun database). La
sensibilità è stata verificata rompendo di proposito, una alla volta, le
protezioni che sorvegliano — fra le nuove: bordo di allineamento, riscrittura
degli archi su gruppo compresso e annidato, validazione degli instradamenti,
nascondiglio esterno, fusione dei pendenti (il drenaggio ha trovato il difetto
vero: oltre la prima pagina del catalogo le colonne sparivano in silenzio).
Rieseguiti senza regressioni: `npm test`, `e2e-avvio-ui`,
`e2e-icone-uniformi`, `e2e-contrasto-viste`, `e2e-altezza-riga`.

### Corretto in revisione (16 settembre 2026)

Tre difetti trovati rileggendo il lavoro, tutti e tre invisibili ai test
com'erano scritti.

1. **L'impronta dei permessi dello snapshot non guardava i permessi**
   (`db/schemaSnapshot.js`). Elencava `role` e `scopes`, due nomi che sul
   principal non esistono: `auth/principal.js` costruisce `root`, `owner`,
   `connScope`, `capabilities`, `tenantCapabilities` e `grants`, e lo scope
   vive in `grants[].scope`. Una revoca a caldo che restringe un grant —
   stesso utente, stesso id — lasciava quindi l'impronta identica, e lo
   snapshot continuava a servire i nomi degli oggetti appena tolti fino alla
   scadenza: una fuga di metadati, non una cache stantia, cioè proprio ciò che
   la proprietà 2 dell'intestazione di quel modulo dichiara di impedire.
   L'impronta si prende ora sul principal INTERO, così un campo di
   autorizzazione aggiunto domani è coperto senza che nessuno se ne ricordi.
   Il test usava una forma di principal inventata (`{ id, scopes }`) e cambiava
   l'identità insieme allo scope: passava anche ignorando lo scope del tutto.
   Ora usa `makePrincipal` vero e tiene ferma l'identità.
2. **Il Grafo 3D perdeva le relazioni oltre la prima pagina del catalogo**
   (`public/js/graph3d.js`). Con un cursore proprio per le relazioni, chi manda
   solo `cursor` riceve a ogni pagina la stessa prima fetta: prima dei tre
   cursori le relazioni erano filtrate sulla fetta corrente e paginare il
   catalogo se le portava dietro. «Carica la porzione successiva» manda ora
   anche `relationCursor` e `revisione`, e non fonde una pagina di una
   revisione diversa. Nessun test copriva un consumatore che pagina il catalogo
   SENZA `relationCursor` — cioè il consumatore reale: ora c'è
   (`unit-schema-progressivo.js`, punto 3-bis).
3. **`test/e2e-uml.js` non arrivava in fondo.** Un toast ancora aperto
   («Rimosso dal diagramma», 3,5 s di vita, `position: fixed` in basso al
   centro e largo fino a 760 px) copriva l'angolo del canvas su cui il test
   preme il tasto destro e si prendeva il clic, quindi il menu del canvas non
   si apriva mai. Il test toglie ora i toast residui prima del gesto. Passato
   quel punto sono emerse tre asserzioni sui gruppi che non erano mai state
   eseguite: contavano gli elementi del canvas in valore ASSOLUTO, quindi la
   nota creata da un passo precedente le sfalsava tutte di uno. Sono ora
   relative a una misura di partenza, che è ciò che «i due membri spariscono
   dietro un segnaposto» significa davvero.

Poi tre minori, chiusi nella stessa passata.

4. **La chiave di `instradamenti` non era validata** (`uml-modello.js`). Il
   valore sì, la chiave no — mentre per i nodi c'è `leggiChiave`. `JSON.parse`,
   cioè la via da cui il documento arriva davvero, crea `__proto__` come
   proprietà PROPRIA: misurato, un file con `"__proto__": [due punti]`
   riassegnava il prototipo di `doc.instradamenti` e faceva restituire a
   `instradamenti["0"]` dei vertici che quel collegamento non ha mai avuto,
   senza alcun avviso. Ora i nomi riservati sono rifiutati e DICHIARATI. Il
   test va scritto con `JSON.parse` e non con un letterale: `{ __proto__: … }`
   viene consumato alla costruzione dell'oggetto e non arriverebbe mai alla
   funzione, quindi scritto così passerebbe anche senza la protezione.
5. **`joint.css` non è vendorizzato, e ora è una scelta dichiarata**
   (`public/vendor/joint/PROVENIENZA.txt`). Misurato su questa versione: nulla
   di funzionale ne dipende — `position: relative` sul Paper lo scrive JointJS
   inline, e `.connection-wrap` (la fascia invisibile che rende cliccabile un
   collegamento sottile, l'unica regola non cosmetica di quel foglio) non viene
   emessa affatto dal markup dei link usato qui. `e2e-uml.js` sorveglia adesso
   l'assunzione, così un aggiornamento di JointJS che ricominciasse a emetterla
   non renderebbe i collegamenti incentrabili in silenzio.
6. **Catalogo e diagramma sono due conteggi diversi, e ora si vede**
   (`uml.js`, piede del catalogo). Un diagramma nuovo nasce con le tabelle
   lette FINO A QUEL MOMENTO: su un catalogo che arriva a pezzi, quelle delle
   pagine successive restavano nel catalogo e basta, mentre il piede diceva
   «tutti i metadati letti» — vero sui metadati, muto sul disegno. Su 250
   tabelle erano 170 assenti dal diagramma senza che nulla lo dichiarasse. Il
   piede lo dice ora, anche dopo un «Rimuovi dal diagramma».

Sensibilità verificata su tutte e sei: rimettendo l'impronta cieca allo scope,
togliendo `relationCursor` al drenaggio, spegnendo `nascondiglioGruppi`,
togliendo il rifiuto delle chiavi riservate e azzerando la nota del piede, i
rispettivi test falliscono.

### Misure

Macchina: Intel Core Ultra 7 155H x22, 31.4 GB. Browser: Chromium 151 headless
(raster software — i numeri valgono per l'ambiente di prova, vedi sotto).
Fixture: 100 tabelle da 8 campi, 200 relazioni, socket finto istantaneo,
viewport 1600×950 (`test/e2e-uml-prestazioni.js`).

| Misura | Prima | Dopo |
|---|---|---|
| Inserimento da catalogo (max/media su 10) | 3520 / 2885 ms (rebuild completo) | 249 / 164 ms (aggiunta incrementale) |
| Trascinamento, p50 dei fotogrammi | — | ~21 ms |
| Trascinamento, p95 dei fotogrammi | ~83 ms | ~69 ms (minimappa congelata, sagoma) |

Due letture oneste di questi numeri. Primo: su 5 nodi lo stesso ambiente
misura p95 ~68 ms contro ~64 di 100 nodi — la coda è il pavimento
dell'headless (raster software + input via CDP), non la scala: il diagramma
scala, l'ambiente no. Secondo: il gate nel test è p95 sotto 100 ms, non i 33
del piano — cattura le regressioni vere (una pittura da 130 ms o un rebuild da
secondi lo sfondano), ma i 33 ms restano da misurare su hardware reale con GPU,
qui non disponibile. Il dettaglio proporzionato allo zoom c'è (sagoma sotto
0.5, export sempre pieno e provato) e non è servito a spostare il p95:
resta perché su cento nodi la vista intera resta leggibile come struttura.

### Consegnato per una via diversa da quella proposta

* **Completezza dei metadati (fase 2).** Il piano chiedeva cursori indipendenti
  per catalogo, campi e relazioni dentro `db:schema` — consegnati
  (`schemaProgressivo.js`) — ma la via dei metadati **interi** del singolo
  oggetto resta `collection:stats` invece di una pagina campi dedicata. Il
  risultato per l'utente è quello richiesto — nessun metadato dell'oggetto che
  sta guardando gli è precluso — senza scaricare l'intero database.
* **Lettura parziale del catalogo (fase 2).** Il piano ammetteva due strade:
  leggere solo la porzione richiesta oppure uno snapshot con scadenza e
  invalidazione. Si è presa la seconda (`schemaSnapshot.js`): la prima pagina
  costa ancora una lettura intera, le successive no e su MongoDB non rifanno il
  campionamento. Le query di catalogo aggregate per SQL non sono state scritte.
* **Anteprima dell'import.** È un riepilogo testuale con il conteggio degli
  elementi e degli oggetti non risolti, dentro la richiesta di conferma, invece
  di una vista dedicata. Il documento corrente non viene comunque sostituito
  senza una scelta esplicita.

### Non consegnato, e perché conta

1. **Prove contro DBMS veri.** Qui non c'è alcun database in ascolto, quindi
   restano non eseguibili: 250 tabelle reali oltre i tetti, revoca RBAC a caldo
   contro l'UML, cambio rapido di database con dati veri. Le prove girano sui
   contratti (drenaggio su `limitaSchema`+`unisciSchema` veri, paginatore finto
   e stupido nel browser) e sull'invalidazione dello snapshot (unit, principal
   compreso) — il filo contro il DBMS va teso dove un DBMS c'è.
2. **Electron: riavvio, pacchetto offline, quota reale.** Il ripristino dopo
   ricaricamento è provato nel browser; il riavvio dell'app desktop, il
   funzionamento senza rete del pacchetto e la quota di IndexedDB esaurita
   davvero no.
3. **p95 sotto 33 ms su hardware reale.** Vedi «Misure»: in headless la coda è
   ambientale. Serve una macchina con GPU, la stessa fixture e lo stesso
   script — i gate attuali non vanno inseguiti, vanno rifissati lì.
