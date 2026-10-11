const fs=require('node:fs');
const file='docs/revisione-grafica.md';let text=fs.readFileSync(file,'utf8');
const evidence={
S1:'Arc: 14 gruppi e 40 overlay; design: 44 combinazioni; regressioni avvio/palette superate. UI Chromium e trasporto di fixture.',
S2:'workbench/report.json: 15 scenari; copertura/report.json: molte schede, bozze, riordino e focus; fluidita: ripresa sessione e anteprime. Stesso stato e stessi controller.',
S3:'fluidita: resize desktop, sezioni e footer ancorati, BottomSheet a 6 viewport × 2 temi, larghezze piene, menu al 60%, ricerca e ritorno desktop; safe-area-attuale.log; Android IME reale.',
S4:'workbench: 15 scenari simulati. workbench/reale.json: query concorrenti MongoDB/MySQL, focus cambiato prima della risposta, scritture e isolamento PostgreSQL. Renderer e backend reali.',
C1:'Wizard, autenticazione, SSH/opzioni/errori verificati come UI nelle suite Arc/design. Connessioni dirette reali ai tre DBMS. Non eseguito un tunnel SSH reale: manca un endpoint SSH di fixture autorizzato con credenziali dedicate.',
D1:'fluidita: 2.000×30 celle, DOM conservato, resize mouse/touch/tastiera/numerico, main/query/pane; UML campione ridimensionabile. copertura: 11 viewport × 3 temi e geometria virtuale. Touch CDP, separato dalle prove native.',
D2:'Suite selezione/copia/incolla e virtual-scroll superate; copertura distingue NULL/mancante/vuoto/0/false e copia integrale; workbench conserva filtri/selezioni nei documenti.',
D3:'uscita-editing: Escape, calendario, Applica/Annulla, ultima riga, uscita dai pulsanti, errore e bozza attraverso cambio vista a 1440/390. Mutazioni rilevate. Editing reale MongoDB/MySQL/PostgreSQL in workbench/reale.',
D4:'Regressioni FK/inserimento, numeri esatti, incolla atomico e geometrie superate. Arc: date UTC/millisecondi e campi. Tre DBMS reali: scritture, Decimal128 e restore senza arrotondamento.',
Q1:'copertura: 11 viewport × 3 temi, editor/risultati e cursore conservati; intellisense nelle regressioni. Android: IME effettivamente aperta, campo/cursore raggiungibili e codice conservato.',
Q2:'workbench: script in background, pausa/stop/risposte tardive, cronologia/snippet/sospese. workbench/reale: query lente e annullamento MySQL. Nessuna equivalenza simulazione/DB dichiarata.',
Q3:'Arc/design/superfici: tabella, JSON, ECharts, Leaflet, errori e progressi nei renderer veri con fixture. workbench/reale prova separatamente il trasporto e i tre DBMS.',
H1:'Dettagli e form DDL in design/superfici; payload/validazione/bozza nei test Arc; indici e vincoli nelle suite UML/FK. UI desktop/mobile, trasporto controllato.',
H2:'JointJS reale: e2e-uml, progetto, regressioni e modalità superati; ridimensionamento campione 1440/390 e mutazione del resize rilevata. DDL progettuale verificato con fixture.',
V1:'Three.js reale: immagini desktop/mobile chiaro/scuro in design; toolbar e percorsi in e2e-barra-grafo. Schema sintetico, nessun motore sostituito.',
V2:'ECharts reale: grafici risultati/selezione, cambio tipo e configuratori in Arc/design/regressioni. Renderer ridimensionati, UI desktop/mobile; dati sintetici.',
V3:'Leaflet reale: editor geometrico, geometrie nelle viste, selezioni e risultati in regressioni/design. Geometrie e metadati delle fixture; UI desktop/mobile.',
T1:'superfici: mapping/anteprime/form desktop/mobile. export-reale.log: roundtrip database MongoDB/MySQL su fixture possedute. Errori e dati estremi nelle suite esatte/import.',
T2:'superfici: progresso persistente e restore concorrenti; workbench/reale: backup e due restore MongoDB reali, operationId validato e Decimal128 intatto. backup-reale.log copre CLI full/incrementale/restore.',
A1:'rbac-ui/report.json: login errato/corretto e creazione/sospensione/riattivazione utenti reali a 390/1440; rbac-reale.log: autorizzazioni backend. UI API MCP nella suite superfici, senza inviare messaggi esterni.',
A2:'superfici: UI vault/passphrase e errori desktop/mobile; vault-attuale.log: migrazione, cambio, sblocco e reset su vault temporaneo. Nessun vault personale utilizzato.',
A3:'superfici: audit/salute/sessioni e query lunga copiabile; sessioni-reali.log: sessioni/lock/cancel sui tre DBMS isolati. Autorefresh conserva lo scroll.',
P1:'unitari contrasto superati; copertura: 11 viewport × chiaro/scuro/custom; Arc ColorPicker e persistenza al reload. Nessuna dichiarazione di conformità WCAG completa o prova con lettore di schermo.',
P2:'superfici: guida, shortcut, licenza, aggiornamenti desktop/mobile nei due temi; Arc: finestre dinamiche e tastiera. Non eseguita pubblicazione/installazione di una release.',
X1:'Arc e regressioni superate; menu in top layer, focus annidato, ritorno al comando, popup e BottomSheet. Passaggio mobile→desktop con dialog aperto verificato senza perdere il menu.',
X2:'contenitori/report-electron.json: Electron 43.2.0 reale, Chromium 150, profilo temporaneo, zoom nativo 100/200%, focus a 200%, resize e download SQL esatto. Mutazione che perde il testo rilevata.',
X3:'contenitori/report-android.json: APK debug, WebView Chromium 124 + Node Mobile, Android 15 x86_64; ricerca BottomSheet e query con IME reale, safe area, chiusura tastiera e rotazione. Build/strumentazione e controllo APK superati; emulatore dedicato, non telefono fisico.'
};
text=text.split('\n').map(line=>{const id=line.match(/^\| ([A-Z]\d+) /)?.[1];if(!evidence[id])return line;const cells=line.split('|');cells[6]=' completata ';cells[7]=id==='C1'?' parziale ':' superata ';cells[8]=` ${evidence[id]} `;return cells.join('|');}).join('\n');
text=text.replaceAll('`pager.js`','`grid.js`').replaceAll('`query-export.js`','`query-tab.js`').replaceAll('`export.js`, `import.js`','`exportimport.js`').replaceAll('`vault.js`, `passphrase.js`','`db/vault.js`, `passphrase.js`');
text=text.replace('Le nuove mutazioni e le regressioni estese sono ancora in corso.','Le 19 suite di regressione e le controprove sono superate; vedere il riepilogo corrente sotto.');
text=text.replace('Stato della consegna al presente aggiornamento: implementazione completata, verifica incompleta. Tutte le righe restano parziali finché l\'ultima esecuzione delle suite e dei contenitori non è consolidata; le prove già eseguite sono indicate distintamente.',`Stato: **implementazione completata, verifica incompleta** per il solo tunnel SSH reale della riga C1. La UI SSH è verificata; per completare l'integrazione serve un endpoint SSH di prova autorizzato con chiave/credenziali dedicate e accesso a un database di fixture. Nessuna superficie grafica è lasciata da implementare. Le altre 25 righe hanno superato le prove descritte, con i limiti d'ambiente dichiarati.

### Esiti consolidati della revisione corrente

I percorsi relativi nelle righe della matrice partono da \`test-reports/revisione-2026-10-09/verifica-attuale/\`; i file \`*.log\` citati sono nella cartella superiore. Tutto ciò che segue la matrice storica è evidenza precedente.

1. **Unitari:** \`npm test\`, \`npm run typecheck:ui\`, \`npm run build:ui\`, \`git diff --check\` superati. I primi tentativi bloccati dal sandbox sono conservati dove diagnostici; gli esiti finali sono quelli indicati qui.
2. **UI reale con trasporto simulato:** \`npm run test:e2e:design\` (44 combinazioni), \`npm run test:e2e:arc\`, \`npm run test:e2e:arc:regressioni\` (19 suite), \`node test/e2e-workbench.js\` (15 scenari), \`node test/e2e-revisione.js\` (11 viewport × 3 temi), \`node test/e2e-superfici.js\` (52 combinazioni e 3 flussi), fluidità, uscita editing e safe area: superati.
3. **Backend/DB reali:** workbench a 3 DBMS con 6 scenari, RBAC UI/backend, backup/restore, export/import e sessioni su container posseduti dalla fixture. MongoDB 8 su 13717, MySQL 8.4 su 13318, PostgreSQL 17 su 15438; nessun database personale. Tutti gli esiti nei report/log dedicati.
4. **Browser:** Chromium, screenshot prima/dopo a dati equivalenti; temi chiaro/scuro/custom, reflow 320 CSS px, desktop/tablet/mobile e landscape. Le verifiche automatiche e da tastiera non attestano da sole conformità WCAG completa. Safari/Firefox, lettore di schermo e un telefono fisico non sono stati provati.
5. **Contenitori:** Electron reale con zoom nativo e file; Android debug con WebView/Node Mobile reali, Gradle strumentazione e controllo APK. I dati operativi nel test nativo sono sintetici: queste prove coprono il contenitore, non costituiscono ulteriori scritture DB reali.
6. **Dispositivo:** emulatore Android 15 x86_64 dedicato, IME realmente visibile (dumpsys e screenshot ADB), ricerca e query sopra la tastiera, codice conservato e rotazione. Il responsive Chromium/CDP rimane una prova distinta.

Controprove: \`mutazioni-attuali/mutazioni.json\` contiene 20 difetti rilevati; \`mutazioni-extra/report.json\` aggiunge larghezza/menu mobile, editing, UML, RBAC e restore. La perdita del testo al resize Electron fallisce nel suo report separato. Nessuna mutazione resta nei sorgenti del prodotto.

Screenshot ispezionati: [navigatore desktop](../test-reports/revisione-2026-10-09/verifica-attuale/fluidita/navigatore-desktop.png), [connessioni mobile scuro](../test-reports/revisione-2026-10-09/verifica-attuale/fluidita/sheet-dark-390.png), [mobile landscape](../test-reports/revisione-2026-10-09/verifica-attuale/fluidita/sheet-light-844.png), [editing](../test-reports/revisione-2026-10-09/verifica-attuale/uscita-editing/azioni-390.png), [Android con IME](../test-reports/revisione-2026-10-09/verifica-attuale/contenitori/android-sheet-ime-dispositivo.png). Baseline in \`baseline/\`, \`lag/\` e \`uscita-prima/\`, preservata.

Il BottomSheet deriva dal [componente Arc](https://uiarc.dev/components/bottom-sheet), con sorgenti locali, provenienza registrata e dipendenze già presenti. Strumenti è ancorato in fondo al navigatore; quando Database è collassato, la sua intestazione rimane subito sopra. Su mobile, width inline, focus, menu e safe area non ereditano la geometria desktop.`.replaceAll('\`','`'));
fs.writeFileSync(file,text);
