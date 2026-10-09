# Revisione grafica CodeDB

Perimetro: intera applicazione operativa in `public/`, inclusi gli strumenti amministrativi. Escluso il sito marketing. Priorità confermata da Keus: query e modifica intensiva dei dati. La migrazione Arc già presente viene riutilizzata.

## Matrice di lavoro

| Superficie | Attività principale | Problema osservato | Intervento | Stato | Verifica |
| --- | --- | --- | --- | --- | --- |
| Shell, connessioni, alberi e tab | Identificare connessione e tabella, cambiare contesto | Etichette da 9 px, livelli poco distinti, tre sidebar larghe nella vista Query | Gerarchia tipografica, barre più compatte, ricerca comandi visibile | Implementato | Baseline, screenshot, navigazione e palette |
| Dati e pannelli affiancati | Leggere, selezionare, modificare valori | Testo piccolo ma righe sovradimensionate dalle checkbox | Altezza coerente con virtualizzazione, testo dati leggibile, controlli compatti | Implementato | Misure 32/48 px; regressioni griglia, selezione, split e tocco |
| Toolbar dati | Cercare, filtrare, inserire, aggiornare | Su mobile i controlli si sovrappongono e il campo si riduce troppo | Tre righe funzionali su mobile | Implementato | Screenshot 390/768/1440 e interazioni Arc |
| Query e script | Scrivere ed eseguire codice, leggere risultati | Tre pannelli comprimono il codice; azione primaria tagliata su mobile | Schema richiudibile/ridimensionabile; bersaglio, azioni e stato a capo su mobile | Implementato | Toggle, drag 184→244 px, Escape, azioni dentro viewport, query virtuali |
| Dettagli e DDL | Leggere colonne, indici e vincoli | Celle con cornici ripetute e titoli piccoli | Tabelle a righe, sezioni distinte | Implementato | Screenshot Dettagli; DDL e UML progetto |
| Inserimento, modifica, date, FK, GeoJSON | Modificare dati con validazione | Densità incoerente tra campi e finestre | Scale comuni; DatePicker Arc riutilizzato | Implementato | Suite Arc griglia/campi, FK, geometrie; salvataggi MongoDB reali |
| Grafici e configuratori | Confrontare risultati e scegliere una rappresentazione | Etichette piccole e contenitori ripetuti | Configuratore a sezioni, canvas prioritario | Implementato | Cambio tipo ECharts e controlli dinamici; screenshot Arc |
| UML, grafo e mappe | Esplorare relazioni e geometrie | Cromatura diversa dagli altri strumenti | Barre/pannelli coerenti; motori conservati | Implementato | Suite UML, progetto, grafo, editor geometrico e viste mappa |
| Tema | Scegliere e personalizzare colori | Card per campo, elenco ed editor competono | Righe di impostazioni, editor distinto dall'elenco | Implementato | Screenshot, persistenza, unitari contrasto, ColorPicker |
| Backup, import/export e audit | Configurare e seguire operazioni | Tabelle e testi di aiuto poco leggibili | Densità da form e raggruppamenti coerenti | Implementato | Contenitori responsive, import cifrato, unitari; restore completo non provato |
| Salute, sessioni e utenti | Diagnosticare, autorizzare, intervenire | Gerarchie tipografiche diverse | Tabelle, strumenti e messaggi uniformati | Implementato | Contenitori responsive; azioni amministrative reali non provate |
| Login, vault, passphrase, wizard | Accedere e configurare una connessione | Titoli/istruzioni minuti | Form leggibili, azioni distinte | Implementato | Wizard tre DBMS, errore reale, focus e campi; login RBAC reale non provato |
| Menu, palette, notifiche, caricamento e vuoti | Trovare azioni e capire lo stato | Palette poco scopribile, selezione incoerente | Entrata visibile, stati semantici | Implementato | Tastiera/focus, caricamento/errore/riprova, notifiche e screenshot |
| Guida, scorciatoie, licenza e aggiornamenti | Consultare istruzioni e impostazioni | Scala e larghezza del testo incoerenti | Misura del testo e spaziatura condivise | Implementato | Inventario 38 overlay e finestra scorciatoie dinamica |

Baseline: `test-reports/design/prima/`, 28 combinazioni di superficie/larghezza, app vera con dati sintetici confinati alla prova. Diff e stato iniziali sono conservati in `test-reports/design/working-tree-iniziale.*`. Nessun dato dimostrativo è introdotto nel prodotto.

## Componenti e integrazione

Il server MCP Arc è stato consultato realmente: skill di design/composizione, ricerca del catalogo e schede Button, EmptyState e FilterToolbar. Il FilterToolbar a faccette non sostituisce il filtro SQL/MQL libero della piattaforma. La migrazione precedente valida è stata riutilizzata; non sono stati aggiunti pacchetti o componenti solo per cambiare l'aspetto. [Inventario completo Arc, API e motivazioni delle eccezioni](migrazione-arc.md).

| Componente precedente | Arc adottato e conservato | Superfici aggiornate |
| --- | --- | --- |
| Pulsanti e azioni | Button | Shell, toolbar, griglie, configuratori e finestre |
| Campi testuali, editor e ricerche | Input, Textarea | Wizard, form statici/dinamici, editing inline, palette, query |
| Select e checkbox | Select, Checkbox | Booleani, tipi, DDL, selezione griglia, configuratori |
| Date e colori | DatePicker + Calendar + Input UTC; ColorPicker | Celle, inserimento, form e tema |
| Finestre, impostazioni e messaggi | Dialog, DropdownMenu, Alert, Toast, EmptyState | 38 overlay, menu Impostazioni, errori/successi e primi passi |

Restano locali, con motivazione tecnica: griglie virtuali e selezione per precisione/volume dei dati; editor SQL/MQL per evidenziazione e completamento; alberi/FK/palette per ricerca remota e contesto; ECharts, Leaflet, JointJS e Three.js per grafici/geometrie/relazioni. I loro controlli applicativi usano Arc. Tabelle informative e separatori restano HTML semantico. Le conferme distruttive sincrone del browser restano quelle documentate nella migrazione: non sono presentate come Dialog Arc.

`workbench.css` compone l'app; `arc-theme.css` collega la foundation ai token CodeDB. Radice 16 px, corpo 13 px; etichette principali almeno 12 px; griglia 32 px su desktop e 48 px su touch/schermi stretti. La misura delle righe viene letta dal motore virtuale. Schema Query richiudibile e maniglia collegata al pannello corretto; gli stati ARIA seguono anche Escape e cambio breakpoint. Editor del tema a righe, elenco nascosto solo durante la modifica e ripristinato con Annulla.

Stack conservato: controller vanilla ESM, isole React già installate, build esbuild, Express e Socket.IO. Nessun router, Next.js o Tailwind aggiunto. Rimosso il caricamento di font non usati; Inter e JetBrains Mono rimangono. Report e screenshot esclusi coerentemente da entrambi i percorsi di packaging. L'app non interroga Arc a runtime.

## Verifiche del risultato

- `npm run build:ui` e `npm run typecheck:ui`: superati. Bundle Arc invariato rispetto alla migrazione precedente.
- `npm run test:e2e:arc`: superate tutte le tre suite, 14 + 12 + 10 gruppi. Campi statici/dinamici, selezione mista, reset, validazione, NULL, falsi booleani, errore/riprova, focus dei popup e millisecondi UTC. [Report generale](../test-reports/arc/after/report.json), [griglia](../test-reports/arc/griglia/report.json), [campi](../test-reports/arc/campi/report.json).
- 38 finestre a 390/768/1440 px; shell e wizard anche a 1024 px. Temi chiaro/scuro/personalizzato, movimento normale/ridotto, reload diretto di `/`. Nessun errore JavaScript/React o risorsa locale mancante rilevato.
- `npm run test:e2e:arc:regressioni`: **19 suite superate**, inclusa l'intera suite unitaria. [Risultati e durata](../test-reports/arc/regressioni/report.json).
- `npm run test:e2e:design`: **28 combinazioni** di superficie/larghezza; dati/query/dettagli/tema, misure delle righe, ricerca e ripristino focus, schema desktop/mobile, visibilità completa dei comandi Query. [Risultati](../test-reports/design/dopo/report.json).
- `node test/e2e-arc-mongodb.js`: collegamento e scritture reali tramite browser e Socket.IO su DB temporaneo, ripulito dal test. Input/Select/DatePicker salvano false, UTC e millisecondi; BSON Long oltre 53 bit intatto. [Prova reale](../test-reports/arc/mongodb/report.json).
- Controprova `node test/e2e-design.js --mutant`: **fallisce come previsto** quando il test forza etichette da 8 px, senza modificare il prodotto. [Log](../test-reports/design/sensibilita.log).
- Controllo sintattico dei moduli modificati e `git diff --check` sui sorgenti: superati. Il progetto non ha uno script lint generale. Detector Impeccable: un solo avviso su Inter, mantenuto perché parte dell'identità del client operativo.

La revisione indipendente prevista dalla skill ha rilevato il taglio del comando Query su mobile: corretto e protetto da un controllo dei rettangoli dei comandi, oltre al controllo dell'overflow della pagina. Il brief vincola la direzione a CodeDB operativo: non sono stati generati seed, concept alternativi o un comp approvato separatamente. Nessuna approvazione grafica viene presunta.

I test senza database usano fixture esclusivamente nel trasporto del test e i veri renderer/controller: non provano l'esecuzione SQL del backend. Gli overlay amministrativi sono stati controllati come UI, non come prova completa di ogni operazione. Non rieseguiti login RBAC reale, kill sessioni, restore completo, MySQL/PostgreSQL reali, installer Electron/APK o Safari/Firefox/lettore di schermo. La precedente prova socket MongoDB con un fallimento sul rename e le indisponibilità dei DB SQL sono riportate in `migrazione-arc.md`; questa revisione non le dichiara risolte. Non rimangono blocchi noti nell'implementazione grafica verificata.

## Risorse e prestazioni

Tre avvii Chromium a 1440×960 senza throttling, mediana: [misura finale](../test-reports/design/performance.json). Risorse locali non compresse 5.664.692 B, FCP 480 ms, DOMContentLoaded 1.020 ms, tempo script 459 ms. La misura Arc precedente registrava 5.649.888 B, 444/751/244 ms rispettivamente: aggiunta di **14.804 B (0,26%)**. Il bundle React/Arc è invariato: JS 579.282 B + CSS 48.482 B. Il costo aggiunto è soprattutto composizione CSS, senza nuove dipendenze.

I tempi sono peggiori rispetto al campione precedente e non vengono presentati come miglioramento: non sono un confronto A/B con carico e cache controllati, quindi non attribuiscono causalmente la differenza alla revisione. Le misure sono dati di questo ambiente, non garanzie di produzione.

## Screenshot e avvio

- [Prima: griglia desktop](../test-reports/design/prima/dati-dark-1440.png) → [Dopo](../test-reports/design/dopo/dati-dark-1440.png).
- [Query desktop](../test-reports/design/dopo/query-1440.png) e [Query mobile](../test-reports/design/dopo/query-390.png).
- [Griglia mobile](../test-reports/design/dopo/dati-light-390.png), [editor tema](../test-reports/design/dopo/tema-editor-1440.png).
- [Calendario inline](../test-reports/arc/griglia/calendario-inline-1440.png) e [calendario mobile](../test-reports/arc/griglia/calendario-light-390.png).

```sh
npm start                         # http://localhost:3030
npm run build:ui
npm run typecheck:ui
npm run test:e2e:design
npm run test:e2e:arc
npm run test:e2e:arc:regressioni
node test/e2e-arc-mongodb.js        # MongoDB locale richiesto
node test/arc-performance.cjs test-reports/design/performance.json
```

Il sistema durevole è descritto in `PRODUCT.md` e `DESIGN.md`. L'unica rotta dell'app è `/`; la lingua resta italiana. Il sito marketing non è stato modificato.

## Correzione datepicker nella griglia — 8 ottobre 2026

La cella affianca il DatePicker Arc standard e un Input Arc per l'ora UTC, inclusi secondi e millisecondi. Il TimePicker verificato tramite MCP Arc gestisce solo valori `HH:mm` a intervalli: l'Input permette invece di modificare la precisione completa del dato. Data e ora formano un'unica bozza, salvata con Invio dal campo ora o uscendo dalla cella. Escape chiude prima il calendario e poi annulla la modifica. Un'ora invalida resta correggibile e non viene inviata. Nessun pannello ISO aggiuntivo o pulsante Applica/Annulla nella griglia; i form conservano la composizione data/ora esistente. Rimosse le proprietà locali `compact`, `summary`, `popoverFooter` e `closeOnSelect` dal DatePicker.

Corretti anche gli stili degli input del calendario, che ereditavano il bordo dell'editor di cella, e la geometria della selezione: il cerchio segue l'altezza reale delle sei righe anche con i bersagli touch. Nessuna nuova dipendenza.

Build e typecheck superati; suite griglia (14 gruppi) e campi (10 gruppi) superate, più salvataggio MongoDB reale con browser nel fuso America/Los_Angeles. Verificati data e ora iniziali, modifica e salvataggio unico, validazione, annullamento, tastiera, movimento standard/ridotto, altezza della riga e allineamento del giorno a 390/768/1440 px, chiaro/scuro. Verificata anche la griglia virtualizzata: campo ora accessibile senza ritagli e altezza della riga invariata. Nessun errore JavaScript o risorsa locale mancante nelle suite browser.

La controprova `node test/e2e-arc-griglia.js --mutant-date` introduce soltanto nel browser il salvataggio prematuro alla scelta del giorno: il test fallisce prima della modifica dell'ora, come previsto. [Report della controprova](../test-reports/arc/griglia/report-date-mutant.json).

[Prima](../test-reports/arc/datepicker/prima-1440.png), [dopo desktop](../test-reports/arc/datepicker/inline-dark-1440.png), [dopo mobile](../test-reports/arc/datepicker/inline-light-390.png).
