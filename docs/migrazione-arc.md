# Migrazione Arc UI di CodeDB

Verifica del 7 ottobre 2026. Perimetro: applicazione operativa in `public/`, in italiano, rotta `/`. Il sito marketing `landing/` è escluso. Backend, autorizzazioni, contratti Socket.IO, BSON e persistenza non sono stati riscritti.

## Consultazione effettiva del server Arc

Dopo il login il server <https://uiarc.dev/api/mcp> è accessibile. Sono stati letti gli schemi e chiamati tutti e cinque i tool: `search_components`, `list_components`, `get_component`, `get_install_command`, `get_skill`. Consultati il catalogo Free, la categoria Inputs, 25 componenti e le skill entry point, design, composizione, accessibilità, responsive, movimento e checklist. [Evidenza della consultazione](../test-reports/arc/mcp-verifica.json).

Il precedente HTTP 401 conservato in `test-reports/arc/mcp-initialize.json` descrive il tentativo iniziale, prima del login, non un blocco attuale. I sorgenti Free erano stati acquisiti dal registry pubblico ufficiale durante quel blocco; le API sono state successivamente confrontate con il MCP autenticato. Non sono stati ricostruiti componenti Pro inaccessibili.

Comando effettivamente restituito da `get_install_command` per i campi:

```sh
npx shadcn@latest add https://uiarc.dev/r/date-picker.json https://uiarc.dev/r/calendar.json https://uiarc.dev/r/color-picker.json https://uiarc.dev/r/input.json https://uiarc.dev/r/select.json https://uiarc.dev/r/checkbox.json
```

L'integrazione segue l'installazione manuale documentata da Arc: codice locale in `ui/components/arc/`, senza rieseguire un generatore sulle personalizzazioni esistenti. [Fonti e hash originali](../ui/components/arc/provenienza.json), [installazione](https://uiarc.dev/docs/installation), [theming](https://uiarc.dev/docs/theming). Gli hash identificano i sorgenti ricevuti, prima degli adattamenti locali. Nessuna richiesta al server MCP o al registry avviene durante il normale utilizzo di CodeDB.

## Mappa dei componenti

| Componente precedente | Componente Arc adottato | File e superfici | Comportamento preservato e stato |
| --- | --- | --- | --- |
| Pulsanti dei template e azioni dei form dinamici | Button | `controls.tsx`, `editor-controls.tsx`; shell, toolbar, finestre, DDL, backup, sessioni, RBAC, onboarding | Migrazione reale; click, submit, disabled, messaggi di caricamento e permessi conservati |
| Input testuali, numerici, password, ricerca e file | Input | `public/index.html`, form e controller dinamici | Tutte le istanze applicative inventariate; ID, label, datalist, validazione, valori, eventi e reset conservati |
| Textarea, inclusi SQL/MQL, JSON/BSON, GeoJSON e override grafici | Textarea | Editor statici e dinamici, `snippet-manager.js`, `charts.js`, `geomap.js` | Controllo Arc; selezione, lint, formattazione e completamento restano collegati ai controller originali |
| Select dei form | Select | Connessioni/SSH, filtri, backup, import/export, grafici, UML, dettagli, snippet, cronologia e pannelli affiancati | Tutte le istanze inventariate; opzioni dinamiche, selezione, valore vuoto, disabilitazione e reset verificati |
| Checkbox e toggle basati su checkbox | Checkbox | Form statici, griglia e seleziona tutti, inserimento, NULL/PK, tema, UML, export | Stato misto, checked, disabled, Space, eventi e sincronizzazione programmatica verificati |
| Date e datetime-local | DatePicker + Calendar, composti con Input e Button | `date-field.tsx`, `inlineEdit.js`, `insert.js`, factory condivisa | Calendario Arc completo; data locale del calendario convertita senza spostare il valore UTC; secondi/millisecondi, ISO, limiti, reset e validazione conservati |
| Selettori colore nativi | ColorPicker + TextMorph | Tema e configuratore grafici | Popup Arc, Hex, slider, anteprima e persistenza; colori opachi come prima, contrasto sullo sfondo effettivo |
| Editor inline delle celle | Input, Select, DatePicker, Button | `inlineEdit.js`, `grid.js`, `splitview.js` | Enter/Escape/blur, booleani, date, ObjectId, BIGINT/DECIMAL, contesto congelato della scrittura |
| Campi di inserimento dinamici | Input, Select, Checkbox, DatePicker, Button | `insert.js` | Tipo/nome/valore, aggiunta/rimozione, false distinto da vuoto, null, campi obbligatori, payload esatti, bozza su errore |
| Duplica e modifica | Textarea, Checkbox, Button, Alert, Dialog | `cellselect.js` | Anteprima, chiavi, validazione, riapertura e un solo invio; eliminato il clone dei controlli React |
| Creazione e modifica dello schema | Input, Select, Checkbox, Button, Dialog | `schema-ops.js`, `details.js`, `uml-progetto.js` | Nomi, tipi, default, NULL, PK, auto incremento, relazioni e coda delle operazioni |
| Editor geometrico | Select, Textarea, Button, Dialog | `geomap.js`, inserimento e modifica | Opzioni dinamiche, GeoJSON, bozza e dialogo annidato; motore Leaflet conservato |
| Richiesta di testo e passphrase import connessioni | Input, Checkbox, Button, Dialog | `prompt.tsx`, `utils.chiediTesto`, `connection.js` | Promise, Enter/Escape, annullamento, password mascherata; rimosso l'ultimo prompt editabile del browser |
| Errori e notifiche | Alert, Toast | `errors.tsx`, `main.tsx`, `utils.js`, `avvisi.js`, export query vuota | Messaggi reali, errore/successo/avviso, durata, testo lungo e chiusura |
| Finestre applicative | Dialog | 38 overlay statici, palette e finestre dinamiche | Identità dei pannelli, valori, contenimento/ripristino del focus e annullamento tramite callback originali |
| Menu impostazioni | DropdownMenu | `settings.tsx`, `main.js` | Comandi originali, tastiera e visibilità RBAC |
| Benvenuto e workspace vuoto | EmptyState + Button | `main.tsx` | Apertura del wizard e visibilità per tab |

Il censimento browser iniziale comprende **118 nodi input/select/textarea**, di cui 36 modelli DOM nascosti; nessun campo applicativo privo del renderer Arc. Il controllo viene ripetuto dopo apertura e ricostruzione dei form dinamici. [Inventario sorgenti](../test-reports/arc/controlli-inventario.txt), [copertura runtime](../test-reports/arc/campi/report.json). Il numero non è un conteggio di componenti riutilizzabili: include istanze e modelli interni.

Non risultano radio o range applicativi da migrare. Gli slider del ColorPicker sono parte del componente Arc. Le textarea temporanee create soltanto per la clipboard, gli input hidden e i modelli nascosti non sono superfici editabili visibili.

### Componenti locali mantenuti intenzionalmente

| Componente locale | Candidato Arc valutato | Motivo e integrazione |
| --- | --- | --- |
| Griglia dati e selezione Excel | SortableDataTable | Il componente Arc documenta una tabella di consultazione; CodeDB richiede editing BSON, virtualizzazione, rettangoli di celle, copia/incolla e contesto DB. I suoi editor e checkbox sono Arc |
| Parser/editor SQL, MQL, BSON e autocomplete | InlineEdit, Combobox | Mantengono precisione, sintassi, lint, scorciatoie e completamento schema-aware. La superficie textarea/input è Arc |
| Tab riordinabili e paginazione con conteggio differito | Tabs, Pagination | Preview, drag, connessioni indipendenti e totale sconosciuto non corrispondono alle API standard; controller locali, azioni statiche Arc |
| Split-View ad albero | ResizablePanels | Il candidato documentato è orizzontale; CodeDB compone entrambi gli assi e mantiene stato per pannello. Campi e azioni del pannello sono Arc |
| Alberi DB, picker FK e menu contestuali della griglia | TreeView, Combobox, ContextMenu | Caricamento remoto, valori BSON, virtualizzazione, azioni asincrone e selezione di celle richiedono i motori esistenti; mantenuti operativi |
| Grafici, mappe, UML e grafo 3D | Nessun sostituto equivalente nel catalogo consultato | ECharts, Leaflet, JointJS e Three.js conservano capacità e dati; i configuratori usano i controlli Arc |
| Tabelle informative, pannelli, badge, skeleton e progressi specifici | HTML semantico e foundation | Gerarchia, densità, colonne virtuali e avanzamento server restano quelli del prodotto |
| Link e tooltip semplici | HTML e title | URL, download e semantica nativa conservati |
| Conferme distruttive sincrone del browser | Dialog | Mantenute esplicitamente: i guardrail originali dipendono dalla risposta sincrona e dal blocco dell'interazione prima di eliminazioni, revoche e interruzioni. Non sono dichiarate Dialog Arc; non contengono input editabili. Una conversione asincrona richiederebbe verificare nuovamente tutti i bersagli e i flussi distruttivi |

Le righe di questa tabella sono eccezioni tecniche dichiarate, non componenti Arc simulati tramite CSS. Le azioni interne ai motori specializzati restano locali dove necessario.

## Stack, tema e collegamento alla logica

La parte applicativa resta vanilla ESM. Le isole React 19 usano TypeScript, CSS Modules ed esbuild; non sono stati aggiunti Next.js, Tailwind o un router. React, Radix, Motion, Lucide React e compilatori sono dipendenze di sviluppo. Browser, Express, Electron e Android ricevono il bundle statico versionato `public/arc/ui.js` e `ui.css`. Gli script di packaging rigenerano il bundle; le esclusioni evitano di distribuire sorgenti UI e report.

`controls.tsx` sostituisce i controlli prima che i controller registrino i listener, anche nei template dinamici. `fields.tsx` conserva i select/checkbox/date/color originali come modelli nascosti: proprietà, opzioni e reset sono sincronizzati con componenti Arc effettivamente renderizzati. Le azioni utente emettono gli eventi attesi; le assegnazioni programmatiche non simulano click. Le isole degli editor vengono smontate quando sparisce la riga.

I dialoghi riutilizzano i pannelli originali senza clonare form o mappe. I popup appartengono alla finestra attiva; Escape chiude prima il popup, poi il dialogo. Il focus che entra nel calendario o nel Select non salva prematuramente la cella. I popup data/colore usano il top layer del browser per evitare il taglio da parte delle griglie e si chiudono quando il controllo scompare.

Il DatePicker non è un input nativo rinominato. Mostra il Calendar Arc completo, affiancato da Input Arc per l'ora UTC e da un campo ISO opzionale. Il TimePicker documentato gestisce HH:mm: non può sostituire da solo i valori database con secondi e millisecondi. Date impossibili e ore incomplete mantengono la bozza e impediscono l'invio, senza omettere silenziosamente il campo.

Foundation importata una sola volta; `public/css/arc-theme.css` centralizza il collegamento ai token CodeDB. Conservati indaco, Inter, font monospaziati, temi chiaro/scuro/personalizzati e densità da client database. Focus visibile e movimento ridotto si applicano anche ai portal.

Estensioni locali dei sorgenti Arc: Input/Textarea `bare` per conservare label e struttura DOM, Button `domContent` per etichette dei template fidati gestite dai controller, Dialog incorporato, toni dei Toast, Select con portal nel dialogo, ColorPicker compatto/opaco e testi italiani. Queste proprietà sono adattamenti locali, non API attribuite al catalogo ufficiale.

Rimossi i renderer e gli stili obsoleti di toast/menu impostazioni, il vecchio form di richiesta testo e la precedente gestione centrale di Escape. Gli stili dei motori locali restano dove hanno riferimenti reali. Le modifiche preesistenti non attinenti sono state conservate.

## Verifiche realmente eseguite

- Build esbuild, typecheck TypeScript e suite unitaria completa superati. Non esiste uno script lint generale nel progetto; eseguiti controllo sintattico dei file finali e `git diff --check`.
- [Suite Arc generale](../test-reports/arc/after/report.json): 14 gruppi; wizard, tre DBMS nel form, errore di connessione reale, dialoghi annidati, focus, Promise di annullamento, menu, notifiche, tema personalizzato e reload diretto di `/`.
- 38 overlay statici verificati a 390, 768 e 1440 px: 114 controlli di contenitori. Shell/wizard anche a 1024 px; temi chiaro, scuro e custom; movimento normale e ridotto. Non è una prova operativa di ogni azione amministrativa in ciascuna finestra.
- [Suite griglia](../test-reports/arc/griglia/report.json): 12 gruppi; inline, bool, date UTC, millisecondi, ObjectId, JSON/BSON, duplicazione, inserimento, geometria annidata, validazione, errori/riprova, NULL e pulizia delle isole.
- [Suite campi](../test-reports/arc/campi/report.json): 10 gruppi; inventario completo dei campi statici e dinamici, Select/Checkbox/reset, import cifrato, selezione mista, DDL, ColorPicker, palette/snippet, grafici e DatePicker da tastiera con min/max e reset.
- [Regressioni esistenti](../test-reports/arc/regressioni/report.json): 18 suite browser superate, oltre agli unitari. Coprono avvio, FK, geometrie, numeri esatti, incolla, selezione, UML, query virtuali, split, tocco, IntelliSense, grafo e palette. Gli unitari sono stati rieseguiti dopo aver aggiornato lo stub del renderer nel test VM; il report distingue l'esecuzione iniziale dalla ripetizione riuscita. Split e selezione sono stati rieseguiti anche dopo gli ultimi adattamenti dei pulsanti.
- [Browser e MongoDB reale](../test-reports/arc/mongodb/report.json): connessione dal wizard, lettura via Socket.IO, salvataggio con Input/Select/DatePicker, false e UTC con millisecondi; BSON Long oltre 53 bit intatto. Creato e rimosso soltanto un database temporaneo con nome univoco.
- Controprove sensibili: [annullamento](../test-reports/arc/sensitivity.json), [blur dell'editor](../test-reports/arc/griglia/report-mutant.json), [sincronizzazione programmatica Select](../test-reports/arc/campi/report-mutant.json). Le varianti intenzionalmente rotte falliscono; bundle e sorgenti di produzione non vengono mutati.
- Nessun errore JS/React o risorsa locale mancante nelle suite Arc. Assenza di richieste runtime verso Arc. L'app è client-side: non introduce un passaggio SSR/hydration.

Le suite senza database usano fixture del trasporto e i veri moduli UI; nessun mock è stato aggiunto al prodotto. Le prove con fixture verificano payload e comportamenti client, non l'esecuzione SQL sul DBMS.

### Limiti e fallimento esterno al frontend

La suite generale socket `node test/e2e.js`, eseguita con MongoDB reale, termina con **un fallimento**: «rinomina non atomica completata come copia verificata con origine conservata». È una prova socket che non carica la UI; backend e relativo test non sono stati modificati. Le altre asserzioni della suite passano. [Log completo](../test-reports/arc/e2e-mongodb-reale.log). Non è corretto dichiarare verde l'intera suite E2E del repository.

MySQL `localhost:3306` e PostgreSQL `localhost:5432` restituiscono ECONNREFUSED: scritture reali su questi DBMS non verificate. [Sonde locali](../test-reports/arc/database-locali.json). Non eseguiti installer Electron, APK Android, Safari/Firefox, lettore di schermo, restore completo, login RBAC reale o kill di sessioni DB. Non sono risultati superati.

La revisione Arc conserva alcune scelte di prodotto: densità e tipografia CodeDB, HTML semantico per pannelli semplici, gradienti funzionali del ColorPicker. Il focus visibile richiesto prevale sulla preferenza estetica della foundation originale. [Controllo CSS](../test-reports/arc/checklist-css.txt). Non introdotte animazioni decorative o sfocature fullscreen.

### Risorse e prestazioni

[Baseline](../test-reports/arc/performance.json) e [ultima misura](../test-reports/arc/performance-finale.json): tre avvii Chromium per versione, 1440×960, mediana, senza throttling. Risorse locali escluse le risposte del polling Socket.IO. Baseline letta da HEAD senza sostituire il working tree.

| Misura | Prima | Ultima esecuzione |
| --- | ---: | ---: |
| Risorse non compresse | 5.008.104 B | 5.649.888 B |
| First Contentful Paint | 484 ms | 444 ms |
| DOMContentLoaded | 738 ms | 751 ms |
| Tempo script | 156 ms | 244 ms |

Costo in risorse: **+641.784 B, circa +12,8%**. JS/CSS Arc: 627.764 B; gzip teorico 197.030 B. Express nella prova serve asset non compressi: gzip non è traffico misurato. Minificazione, tree shaking e riuso dei controller limitano l'aggiunta; restano React/Radix/Motion e il montaggio dei controlli. Il tempo script aumenta di circa 88 ms nell'ultima misura. I tempi variano con il carico della macchina: non si deduce un miglioramento FCP né una garanzia di produzione dal singolo confronto.

### Screenshot rappresentativi

- [Prima: connessione desktop](../test-reports/arc/before/connection-1440.png)
- [Dopo: connessione chiara desktop](../test-reports/arc/after/connection-light-1440.png)
- [Dopo: connessione scura mobile](../test-reports/arc/after/connection-dark-390.png)
- [Calendario nell'editor inline](../test-reports/arc/griglia/calendario-inline-1440.png)
- [Calendario a 390 px](../test-reports/arc/griglia/calendario-light-390.png)
- [Inserimento completo](../test-reports/arc/griglia/inserimento-light-1440.png)
- [ColorPicker scuro](../test-reports/arc/campi/colore-dark-1440.png)
- [Configuratore grafici](../test-reports/arc/campi/grafici-1440.png)
- [DatePicker con MongoDB reale](../test-reports/arc/mongodb/calendario-reale.png)

## Comandi riproducibili

```sh
npm start                         # http://localhost:3030
npm run build:ui
npm run typecheck:ui
npm run test:e2e:arc
npm run test:e2e:arc:regressioni
node test/e2e-arc-mongodb.js        # richiede MongoDB su localhost:27017
node test/arc-performance.cjs
npm test
```

`npm run dev:ui` ricompila durante lo sviluppo. Modificare i sorgenti `ui/` e rigenerare gli asset, mai correggere manualmente il bundle. Il rapporto descrive implementazione e limiti delle prove separatamente; non certifica i flussi reali non eseguiti.
