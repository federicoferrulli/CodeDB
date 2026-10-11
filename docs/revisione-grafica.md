# Revisione grafica CodeDB

Perimetro: intera applicazione operativa in `public/`, inclusi gli strumenti amministrativi. Escluso il sito marketing. Priorità confermata da Keus: query e modifica intensiva dei dati. La migrazione Arc già presente viene riutilizzata.

## Schede mobile — 11 ottobre 2026

Fino a 900px le barre delle connessioni e dei documenti e il contatore delle sessioni sono nascosti: resta il pulsante «Schede». L'elenco si apre nel BottomSheet Arc già usato da Connessioni e Database, con gli stessi controller delle schede e senza duplicare lo stato del workspace. Conserva selezione, bozze, riordino, menu di chiusura/disconnessione e accesso a Nuova connessione anche dall'elenco vuoto. Tornando al desktop il drawer si chiude e le barre ricompaiono. Il passaggio fra i drawer aggiorna stato accessibile e focus.

Verificati `npm run build:ui`, `npm run typecheck:ui`, `node test/e2e-revisione.js` e `node test/e2e-griglia-fluidita.js`. La suite Schede copre anche i menu annidati, il passaggio a Connessioni via Ctrl+B, il ritorno al desktop, il cambio di connessione senza perdere la bozza, disconnessione e stato vuoto. Layout generali su 11 viewport e tre temi; drawer Schede a 320, 390, 768 e 844px, incluso landscape. Screenshot ispezionati in `test-reports/schede-mobile-2026-10-11/copertura/`. Chromium, trasporto sintetico e server isolato; nessuna nuova verifica su Electron, Android o DB reali.

Controprova `node test/e2e-revisione.js --mutant=schede`: la selezione disattivata nella sola risposta HTTP del browser di test viene rilevata dall'asserzione «Lo switcher attiva il documento scelto». Nessuna mutazione nei sorgenti.

## Feedback navigazione — 11 ottobre 2026

La sezione Connessioni ha una testata fissa, senza comando di compressione. Il pulsante in alto a sinistra e Ctrl+B chiudono e riaprono l'intero navigatore desktop (Connessioni, Database e Strumenti), conservando la preferenza anche dopo il ricaricamento; il cambio verso mobile lascia accessibili gli stessi alberi nel BottomSheet. Database conserva il proprio comando di compressione. Rimossa l'etichetta «Sessioni» dalla barra delle connessioni attive; «Schede» compare solo fino a 900px.

Il comando desktop ha testo visibile: «Mostra pannello» a navigatore chiuso e «Nascondi pannello» a navigatore aperto. Rimane nell'header anche quando il pannello è nascosto; su mobile conserva la sola icona e il nome accessibile «Connessioni salvate». Le immagini del comando nelle due condizioni sono in `test-reports/navigazione-2026-10-11/comando-visibile/fluidita/`.

Verifiche eseguite sui sorgenti aggiornati: `node test/e2e-griglia-fluidita.js`, `node test/e2e-revisione.js`, `node test/e2e-uscita-editing.js` e `node test/unit-scorciatoie.js`, tutte superate. Copertura: navigatore completo, pulsante e Ctrl+B, focus, preferenza dopo ricaricamento, passaggio desktop/mobile, ricerca e scroll degli alberi, switcher mobile, 11 viewport e tre temi, uscita dall'editing. La controprova `node test/e2e-griglia-fluidita.js --mutant=drawer` fallisce sul controllo «Il comando chiude tutto il navigatore», disattivando il toggle nella sola risposta HTTP del test, senza mutare i sorgenti. Controlli di sintassi, `git diff --check` e detector Impeccable superati. Report e immagini in `test-reports/navigazione-2026-10-11/`; ispezionate le immagini desktop e mobile. Prove Chromium con trasporto sintetico e server isolato: Electron, Android e DB reali non rieseguiti per questo feedback. Il manifest del 9–10 ottobre resta un riferimento storico, non una verifica di queste modifiche.

## Revisione corrente — 9–10 ottobre 2026

Questa revisione parte dal working tree, incluse le modifiche locali al workbench e i nuovi `pane-runtime.js` e `query-document.js`. Non considera le prove precedenti come verifica del checkout corrente. Stato e diff iniziali sono conservati in `test-reports/revisione-2026-10-09/`; le acquisizioni correnti usano `CODEDB_REPORT_ROOT` per non sovrascrivere i report storici.

Direzione: superfici neutre, indaco per azioni/selezione, Inter per i comandi e JetBrains Mono per codice/dati; navigatore continuo, contesti distinti e un'unica logica fra desktop e mobile. Compattezza ottenuta dalla composizione, non dallo zoom. I valori booleani sono dati, non esiti. Su mobile BottomSheet Arc per connessioni/database, drawer dello schema query, switcher di documenti e passaggi espliciti fra editor/risultati devono lasciare spazio al lavoro.

Legenda stati: I = iniziale, C = caricamento/attività, P = popolato, V = vuoto/nessun risultato, E = errore/disconnessione, R = permessi/sola lettura, S = selezione, M = modifica/bozza. Gli stati elencati sono quelli da verificare, non attestazioni di copertura. Implementazione e verifica sono indipendenti.

### Correzioni richieste durante la revisione

Keus ha segnalato lag durante scorrimento/selezione, incoerenza fra connessioni e documenti aperti, e necessità di ridimensionare le colonne e leggere meglio le intestazioni. Queste segnalazioni riaprono la verifica delle righe S2, S3, D1, D2, Q1 e S4: i report precedenti non attestano gli ultimi cambiamenti.

- `griglia.js` conserva i nodi delle righe ancora visibili; i chiamanti forzano il ridisegno quando cambiano i dati. Anche la navigazione da tastiera nei pannelli usa il solo aggiornamento della finestra.
- L'alternanza delle righe segue l'indice del record, senza transizioni di sfondo durante lo scorrimento. La diagnosi con `test/e2e-griglia-fluidita.js` usa Chromium reale, 2.000 record e 30 colonne sintetiche, senza database: 60 passi di scroll creavano 2.132 righe DOM, ora 53; 25 estensioni orizzontali della selezione passano da 1.025 righe create a zero. Il profiler ha individuato ricostruzione DOM e animazioni delle righe alternate. Le prove che rimuovevano i selettori della shell non hanno risolto il costo residuo; quei selettori non sono stati modificati per supposizione.
- `table-resize.js` condivide misure e gesti fra Dati, risultati query e pannelli: mouse, Pointer Events touch, frecce e immissione numerica. Le larghezze restano nello stato del documento/pannello. Intestazioni da 13 px, peso 600, superficie e separatore più distinti, maniglia visibile. Non si modificano valori né ordinamenti.
- La connessione salvata riprende una sessione già aperta; una nuova sessione resta un'azione esplicita del menu. Schede dei documenti e viste hanno righe distinte. L'anteprima offre «Mantieni» e non sostituisce documenti con bozze o esecuzioni pendenti. L'esploratore esplicita la connessione e il livello «Schemi» su PostgreSQL.

Prova corretta eseguita: `node test/e2e-griglia-fluidita.js` (scorrimento, selezione, tre griglie, larghezze, assenza di query accidentali, cambio documento, touch simulato, immissione numerica, connessioni e anteprime). Screenshot ispezionati in `test-reports/revisione-2026-10-09/fluidita/colonne-desktop.png` e `colonne-mobile.png`; baseline del lag in `lag/prima.png` e `lag/misure.json`. Le 19 suite di regressione e le controprove sono superate; vedere il riepilogo corrente sotto. Il touch CDP non prova una tastiera virtuale nativa. Build UI e typecheck ripetuti dopo questi cambiamenti: superati.

| ID / Superficie e flusso | File, componenti e utilizzatori | Stati | Desktop | Mobile | Implementazione | Verifica | Evidenze correnti / ambiente / limiti |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 Avvio, onboarding, palette | `index.html`, `main.js`, `onboarding*.js`, `palette.js`, Arc EmptyState/Dialog | I,C,V,E | Shell e ricerca globale | Drawer e ricerca visibile | completata | superata | Arc: 14 gruppi e 40 overlay; design: 44 combinazioni; regressioni avvio/palette superate. UI Chromium e trasporto di fixture. |
| S2 Connessioni e documenti aperti | `tabs.js`, `tabbar.js`, `colltabs.js`, `workspace.js`, `query-document.js` | P,E,S,M,C | Livelli distinti, overflow e riordino | Switcher, azioni separate | completata | superata | workbench/report.json: 15 scenari; copertura/report.json: molte schede, bozze, riordino e focus; fluidita: ripresa sessione e anteprime. Stesso stato e stessi controller. |
| S3 Esploratore e ridimensionamento | `connmanager.js`, `dbtree.js`, `main.js`, `responsive.js`, `maniglia.js` | I,C,P,V,E,S | Navigatore continuo ridimensionabile | BottomSheet Arc, ricerca e scroll conservati | completata | superata | fluidita: resize desktop, sezioni e footer ancorati, BottomSheet a 6 viewport × 2 temi, larghezze piene, menu al 60%, ricerca e ritorno desktop; safe-area-attuale.log; Android IME reale. |
| S4 Split e pannelli incorporati | `split-layout.js`, `splitview.js`, `pane-runtime.js`, `state.js` | P,E,S,M,C | Contesti indipendenti, separatori | Pannelli raggiungibili, massimizzazione | completata | superata | workbench: 15 scenari simulati. workbench/reale.json: query concorrenti MongoDB/MySQL, focus cambiato prima della risposta, scritture e isolamento PostgreSQL. Renderer e backend reali. |
| C1 Connessioni salvate, gruppi, wizard, SSH | `connection.js`, `connmanager.js`, Arc Input/Select/Checkbox | I,C,P,V,E,M | Form raggruppati | Form a tutta larghezza | completata | superata | Wizard, autenticazione, SSH/opzioni/errori nelle suite Arc/design. Connessioni dirette reali ai tre DBMS. workbench/reale.json: server SSH effimero su loopback, pin errato rifiutato prima delle credenziali, pin corretto e query MongoDB realmente inoltrata; Decimal128 intatto. |
| D1 Griglie principali, risultati e pannelli | `grid.js`, `query-tab.js`, `splitview.js`, `utils.js`, `griglia.js` | C,P,V,E,R,S | Righe 30px, scroll locale | Righe 48px, scroll locale | completata | superata | fluidita: 2.000×30 celle, DOM conservato, resize mouse/touch/tastiera/numerico, main/query/pane; UML campione ridimensionabile. copertura: 11 viewport × 3 temi e geometria virtuale. Touch CDP, separato dalle prove native. |
| D2 Filtri, ordine, conteggi, selezione/copia | `grid.js`, `cellselect.js`, `cell-stats.js`, `grid.js` | P,V,E,S,C | Azioni vicino ai dati | Toolbar e menu raggiungibili | completata | superata | Suite selezione/copia/incolla e virtual-scroll superate; copertura distingue NULL/mancante/vuoto/0/false e copia integrale; workbench conserva filtri/selezioni nei documenti. |
| D3 Inspector, editing, inserimento, duplica, elimina | `inlineEdit.js`, `insert.js`, `cellselect.js`, `grid.js`, Arc campi/Dialog | P,R,M,E,C | Bersaglio esplicito, bozza su errore | Form ampi e controlli touch | completata | superata | uscita-editing: Escape, calendario, Applica/Annulla, ultima riga, uscita dai pulsanti, errore e bozza attraverso cambio vista a 1440/390. Mutazioni rilevate. Editing reale MongoDB/MySQL/PostgreSQL in workbench/reale. |
| D4 FK, numeri esatti, BSON, date e geometrie | `fk-*.js`, `valori-esatti.js`, `date-field.tsx`, `geomap.js` | P,V,R,M,E | Editor specializzati | Popup e form senza clipping | completata | superata | Regressioni FK/inserimento, numeri esatti, incolla atomico e geometrie superate. Arc: date UTC/millisecondi e campi. Tre DBMS reali: scritture, Decimal128 e restore senza arrotondamento. |
| Q1 SQL/MQL, aggregate, editor e completamento | `query-tab.js`, `query-editor.js`, `autocomplete.js`, `json-lint.js` | I,P,M,E,C | Editor, gutter e risultati | Passaggi Editor/Risultati espliciti | completata | superata | copertura: 11 viewport × 3 temi, editor/risultati e cursore conservati; intellisense nelle regressioni. Android: IME effettivamente aperta, campo/cursore raggiungibili e codice conservato. |
| Q2 Script, pausa/ripresa/stop, cronologia/snippet/sospese | `script-run.js`, `pending-queries.js`, `qe-history.js`, `snippet-manager.js` | P,C,E,M | Esecuzione per documento | Azioni visibili, stato conservato | completata | superata | workbench: script in background, pausa/stop/risposte tardive, cronologia/snippet/sospese. workbench/reale: query lente e annullamento MySQL. Nessuna equivalenza simulazione/DB dichiarata. |
| Q3 Risultati, JSON, errori e progressi | `query-tab.js`, `utils.js`, Arc Alert | C,P,V,E,S | Tabelle/JSON/grafici/mappe | Scroll locale, errore copiabile | completata | superata | Arc/design/superfici: tabella, JSON, ECharts, Leaflet, errori e progressi nei renderer veri con fixture. workbench/reale prova separatamente il trasporto e i tre DBMS. |
| H1 Dettagli, colonne, indici, vincoli, DDL | `details.js`, `schema-ops.js`, Arc campi | C,P,V,R,M,E | Tabelle informative e sezioni | Reflow dei form | completata | superata | Dettagli e form DDL in design/superfici; payload/validazione/bozza nei test Arc; indici e vincoli nelle suite UML/FK. UI desktop/mobile, trasporto controllato. |
| H2 UML esplorazione/progettazione | `uml*.js`, JointJS, Arc campi | C,P,V,S,M,E,R | Catalogo, canvas, coda DDL | Toolbar e accesso touch | completata | superata | JointJS reale: e2e-uml, progetto, regressioni e modalità superati; ridimensionamento campione 1440/390 e mutazione del resize rilevata. DDL progettuale verificato con fixture. |
| V1 Grafo 3D, percorsi e analisi | `graph3d.js`, `graph3d-*.js`, Three.js | C,P,V,S,E | Canvas e pannelli | Controlli e ridimensionamento | completata | superata | Three.js reale: immagini desktop/mobile chiaro/scuro in design; toolbar e percorsi in e2e-barra-grafo. Schema sintetico, nessun motore sostituito. |
| V2 Grafici risultati/selezione e configuratori | `charts.js`, `chart-*.js`, `cellgrafico.js`, ECharts | I,C,P,V,S,E,M | Canvas e configuratore | Configuratore raggiungibile | completata | superata | ECharts reale: grafici risultati/selezione, cambio tipo e configuratori in Arc/design/regressioni. Renderer ridimensionati, UI desktop/mobile; dati sintetici. |
| V3 Mappe, editor, selezioni multiple | `geo-vista.js`, `query-map.js`, `geomap.js`, `geomulti.js`, Leaflet | I,P,V,S,M,E | Canvas e legende | Touch, zoom e form | completata | superata | Leaflet reale: editor geometrico, geometrie nelle viste, selezioni e risultati in regressioni/design. Geometrie e metadati delle fixture; UI desktop/mobile. |
| T1 Import/export, mapping e anteprime | `exportimport.js`, `query-tab.js`, Arc campi/Dialog | I,C,P,V,E,M | Procedura e avanzamento | Form ampi | completata | superata | superfici: mapping/anteprime/form desktop/mobile. export-reale.log: roundtrip database MongoDB/MySQL su fixture possedute. Errori e dati estremi nelle suite esatte/import. |
| T2 Backup/restore | `backupmanager.js`, `backup/`, Arc campi/Dialog | I,C,P,V,E,R,M | Elenco, procedura, esiti | Reflow e azioni | completata | superata | superfici: progresso persistente e restore concorrenti; workbench/reale: backup e due restore MongoDB reali, operationId validato e Decimal128 intatto. backup-reale.log copre CLI full/incrementale/restore. |
| A1 Login/RBAC, utenti, permessi/API MCP | `auth.js`, `admin-rbac.js`, `auth/`, Arc Dialog | I,C,P,V,E,R,M | Form e tabelle | Form/reflow | completata | superata | rbac-ui/report.json: login errato/corretto e creazione/sospensione/riattivazione utenti reali a 390/1440; rbac-reale.log: autorizzazioni backend. UI API MCP nella suite superfici, senza inviare messaggi esterni. |
| A2 Vault/passphrase | `db/vault.js`, `passphrase.js`, Arc campi/Dialog | I,C,E,R,M | Stato e azioni espliciti | Form/reflow | completata | superata | superfici: UI vault/passphrase e errori desktop/mobile; vault-attuale.log: migrazione, cambio, sblocco e reset su vault temporaneo. Nessun vault personale utilizzato. |
| A3 Audit, salute e sessioni/lock | `auditlog.js`, `health.js`, `sessions.js` | C,P,V,E,R,S | Tabelle e dettagli | Scroll locale | completata | superata | superfici: audit/salute/sessioni e query lunga copiabile; sessioni-reali.log: sessioni/lock/cancel sui tre DBMS isolati. Autorefresh conserva lo scroll. |
| P1 Temi e personalizzazione | `theme.js`, `theme-colori.js`, token, Arc ColorPicker | P,M,E | Impostazioni a righe | Editor a colonna | completata | superata | unitari contrasto superati; copertura: 11 viewport × chiaro/scuro/custom; Arc ColorPicker e persistenza al reload. Nessuna dichiarazione di conformità WCAG completa o prova con lettore di schermo. |
| P2 Guida, shortcut, licenza, aggiornamenti | `onboarding*.js`, `scorciatoie-ui.js`, `about.js` | I,P,C,E | Finestre leggibili | Reflow | completata | superata | superfici: guida, shortcut, licenza, aggiornamenti desktop/mobile nei due temi; Arc: finestre dinamiche e tastiera. Non eseguita pubblicazione/installazione di una release. |
| X1 Dialog, drawer, menu, tooltip, toast, alert | `utils.js`, `responsive.js`, `ui/`, CSS condivisi | I,C,P,E,R,S,M | Focus, annidamento e ritorno | Focus/target/overlay | completata | superata | Arc e regressioni superate; menu in top layer, focus annidato, ritorno al comando, popup e BottomSheet. Passaggio mobile→desktop con dialog aperto verificato senza perdere il menu. |
| X2 Electron | `electron-main.js`, preload, aggiornamenti/file | I,P,C,E,M | Runtime nativo e finestre | non pertinente al contenitore desktop | completata | superata | contenitori/report-electron.json: Electron 43.2.0 reale, Chromium 150, profilo temporaneo, zoom nativo 100/200%, focus a 200%, resize e download SQL esatto. Mutazione che perde il testo rilevata. |
| X3 Android autonomo | `android/`, `viewport.js`, `responsive.js` | I,P,C,E,M | non pertinente al contenitore Android | WebView + Node Mobile, inset/file/tastiera | completata | superata | contenitori/report-android.json: APK debug, WebView Chromium 124 + Node Mobile, Android 15 x86_64; ricerca BottomSheet e query con IME reale, safe area, chiusura tastiera e rotazione. Build/strumentazione e controllo APK superati; emulatore dedicato, non telefono fisico. |

Baseline corrente: `baseline/design/dopo/report.json` (44 combinazioni) e `baseline/workbench/report.json` (15 scenari), sotto `test-reports/revisione-2026-10-09/`. UI Chromium reale, backend usa-e-getta; dati e risposte operative simulati. Le immagini griglia desktop, query mobile e split mobile sono state ispezionate. Nessun errore JS/HTTP nelle acquisizioni design; workbench controlla gli errori JS. Le prove non certificano scritture DB reali né contenitori nativi.

### Integrazione del 10 ottobre

- Navigatore desktop unico a sezioni collassabili e ridimensionabili; nessun albero duplicato. Il riferimento visivo della sidebar fornito da Keus guida questa composizione.
- BottomSheet Arc locale per Connessioni e Database/Schemi su mobile (60%/94%, maniglia espandibile anche da tastiera, chiusura visibile). Stessi nodi e controller spostati nel portal; ricerca, selezione, scroll e preferenza desktop conservati. La testata gestisce il trascinamento, il contenuto mantiene scroll e selezione nativi. Il browser non interroga Arc a runtime.
- L'uscita dall'editing virtuale era impedita da un guard che bloccava anche il ridisegno esplicito: ora protegge solo lo scroll. Applica/Annulla sono visibili, il primo Escape chiude un calendario aperto, il successivo annulla la cella. Blur e Invio conservano il comportamento esistente. Una mutazione HTTP isolata reintroduce il difetto e fa fallire la prova.
- Il movimento ridotto usava durate piccolissime ma positive su ogni elemento: queste attivavano transizioni di altezza sugli spaziatori virtuali. La durata è ora zero; la regola duplicata è stata rimossa.
- Eliminate le geometrie animate dei precedenti drawer Connessioni/Database: non compaiono più sul bordo durante zoom o cambio viewport. Gli alberi restano fuori flusso e invisibili con geometria conservata; un test con 80 database verifica scroll, riapertura e ritorno desktop. La controprova `scroll-mobile.log` riproduce la perdita 240→0. Su Android le icone di sistema hanno contrasto con la superficie chiara esterna alla WebView.
- Screenshot attuali: verifica-attuale/fluidita/navigatore-desktop.png, navigatore-mobile.png; verifica-attuale/uscita-editing/azioni-1440.png e azioni-390.png. La baseline precedente resta intatta. I conteggi DOM sono confrontabili; i tempi e i long task raccolti durante build concorrenti non sono presentati come guadagno di FPS.

Stato: **implementazione e verifica completate nel perimetro descritto**. Le 27 righe hanno superato le prove riportate, distinguendo dati simulati, database reali e contenitori nativi. Nessuna superficie censita resta da implementare. I limiti d'ambiente sotto non sono una dichiarazione di conformità WCAG completa.

### Esiti consolidati della revisione corrente

I percorsi relativi nelle righe della matrice partono da `test-reports/revisione-2026-10-09/verifica-attuale/`; i file `*.log` citati sono nella cartella superiore. Tutto ciò che segue la matrice storica è evidenza precedente.

`test-reports/revisione-2026-10-09/manifest-finale.json` collega comandi, log, ambienti e hash SHA-256 dei sorgenti consegnati. Le fixture reali, l'emulatore e i profili temporanei Electron sono stati chiusi/rimossi; screenshot e report restano disponibili.

1. **Unitari:** `npm test`, `npm run typecheck:ui`, `npm run build:ui`, `git diff --check` superati. I primi tentativi bloccati dal sandbox sono conservati dove diagnostici; gli esiti finali sono quelli indicati qui.
2. **UI reale con trasporto simulato:** `npm run test:e2e:design` (44 combinazioni), `npm run test:e2e:arc`, `npm run test:e2e:arc:regressioni` (19 suite), `node test/e2e-workbench.js` (15 scenari), `node test/e2e-revisione.js` (11 viewport × 3 temi), `node test/e2e-superfici.js` (52 combinazioni e 3 flussi), fluidità, uscita editing e safe area: superati.
3. **Backend/DB reali:** workbench a 3 DBMS con 7 scenari, tunnel SSH locale con chiave e credenziali usa-e-getta, RBAC UI/backend, backup/restore, export/import e sessioni su container posseduti dalla fixture. MongoDB 8 su 13717, MySQL 8.4 su 13318, PostgreSQL 17 su 15438; nessun database personale. Tutti gli esiti nei report/log dedicati.
4. **Browser:** Chromium, screenshot prima/dopo a dati equivalenti; temi chiaro/scuro/custom, reflow 320 CSS px, desktop/tablet/mobile e landscape. Le verifiche automatiche e da tastiera non attestano da sole conformità WCAG completa. Safari/Firefox, lettore di schermo e un telefono fisico non sono stati provati.
5. **Contenitori:** Electron reale con zoom nativo e file; Android debug con WebView/Node Mobile reali, Gradle strumentazione e controllo APK. I dati operativi nel test nativo sono sintetici: queste prove coprono il contenitore, non costituiscono ulteriori scritture DB reali.
6. **Dispositivo:** emulatore Android 15 x86_64 dedicato, IME realmente visibile (dumpsys e screenshot ADB), ricerca e query sopra la tastiera, codice conservato e rotazione. Il responsive Chromium/CDP rimane una prova distinta.

Controprove, nella cartella superiore `revisione-2026-10-09/`: `mutazioni-attuali/mutazioni.json` contiene 20 difetti rilevati; `mutazioni-extra/report.json` aggiunge larghezza/menu mobile, editing, UML, RBAC e restore. I report separati Electron rilevano perdita del testo e pannello chiuso visibile; la controprova SSH fallisce se la query aggira il tunnel. Nessuna mutazione resta nei sorgenti del prodotto.

La traccia diagnostica completa della griglia è conservata senza perdita in `fluidita/trace.json.gz` (SHA-256 del JSON decompresso: `b6af960e1c80c83035ad13840327d6da5430aab6ec48630d5477f185479a8b77`).

Screenshot ispezionati: [navigatore desktop](../test-reports/revisione-2026-10-09/verifica-attuale/fluidita/navigatore-desktop.png), [connessioni mobile scuro](../test-reports/revisione-2026-10-09/verifica-attuale/fluidita/sheet-dark-390.png), [mobile landscape](../test-reports/revisione-2026-10-09/verifica-attuale/fluidita/sheet-light-844.png), [editing](../test-reports/revisione-2026-10-09/verifica-attuale/uscita-editing/azioni-390.png), [Android con IME](../test-reports/revisione-2026-10-09/verifica-attuale/contenitori/android-sheet-ime-dispositivo.png). Baseline in `baseline/`, `lag/` e `uscita-prima/`, preservata.

Il BottomSheet deriva dal [componente Arc](https://uiarc.dev/components/bottom-sheet), con sorgenti locali, provenienza registrata e dipendenze già presenti. Strumenti è ancorato in fondo al navigatore; quando Database è collassato, la sua intestazione rimane subito sopra. Su mobile, width inline, focus, menu e safe area non ereditano la geometria desktop.

## Matrice storica (precedente alla revisione corrente)

Le sezioni successive conservano le evidenze della revisione precedente; non attestano il checkout corrente.

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
