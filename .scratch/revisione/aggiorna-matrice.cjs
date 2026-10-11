const fs=require('node:fs');
const file='docs/revisione-grafica.md';
let text=fs.readFileSync(file,'utf8');
text=text.replace('Revisione corrente — 9 ottobre 2026','Revisione corrente — 9–10 ottobre 2026');
text=text.replace('Su mobile drawer, switcher di documenti','Su mobile BottomSheet Arc per connessioni/database, drawer dello schema query, switcher di documenti');
const rows={
S1:['completata','parziale','UI Chromium reale: avvio, onboarding e palette nelle suite Arc/design; regressioni correnti in corso.'],
S2:['completata','parziale','fluidita e copertura: ripresa sessione, anteprime/bozze, switcher e riordino da menu. workbench: 15 scenari; nuova regressione finale in corso.'],
S3:['completata','parziale','fluidita: sezioni desktop, tastiera, BottomSheet mobile, ricerca conservata, menu annidato e ritorno agli stessi nodi. Touch/IME nativo da completare.'],
S4:['completata','parziale','workbench/reale.json: query concorrenti MongoDB/MySQL, cambio focus, scritture MySQL/PostgreSQL e isolamento schemi. UI simulata copre risposte tardive e bozze.'],
C1:['completata','parziale','Arc/design: wizard dei tre motori, SSH e opzioni; connessioni reali MongoDB/MySQL/PostgreSQL su fixture. Tunnel SSH con server reale non verificato.'],
D1:['completata','parziale','fluidita: righe DOM 2132→53 nello scroll, 1025→0 nella selezione; resize mouse/touch/tastiera, larghezze per documento e query a una colonna. Controlli visivi chiaro/scuro/custom in copertura.'],
D2:['completata','parziale','copertura e workbench: selezione, filtri, copia integrale, densità e geometria virtuale. Suite regressioni finali in corso.'],
D3:['completata','parziale','uscita-editing: Escape, calendario, Applica/Annulla desktop/mobile, bozza dopo errore; mutazione del guard virtuale rilevata. workbench/reale: scritture sui tre DBMS.'],
D4:['completata','parziale','workbench/reale: Decimal128 esatto e restore concorrenti; suite Arc/regressioni: FK, date, geometrie e numeri esatti. Verifica finale in corso.'],
Q1:['completata','parziale','copertura: 11 viewport × 3 temi e cursore conservato; editor/input min-height corretto. IME Android reale ancora da completare.'],
Q2:['completata','parziale','workbench: script e annullamento, stati per documento; workbench/reale: annullamento query MySQL. Ripetizione corrente in corso.'],
Q3:['completata','parziale','design/Arc e superfici: renderer veri, risultati JSON e errori su trasporto simulato. Esecuzioni reali separate in workbench/reale.'],
H1:['completata','parziale','design e superfici: dettagli e modali schema desktop/mobile; DDL e vincoli nelle regressioni UML/FK.'],
H2:['completata','parziale','JointJS reale, UML progetto e modalità nelle regressioni. e2e-uml verifica anche resize delle colonne del campione a 1440/390.'],
V1:['completata','parziale','Three.js reale con schema simulato: screenshot design e controlli della toolbar nelle regressioni.'],
V2:['completata','parziale','ECharts reale: design e superfici desktop/mobile, regressioni selezione; dati simulati.'],
V3:['completata','parziale','Leaflet reale: design e regressioni editor/selezione multipla/query; trasporto geometrie simulato.'],
T1:['completata','parziale','superfici: form/mapping; dbexport reale MongoDB/MySQL già eseguito su fixture isolate. Nuova verifica visuale corrente in corso.'],
T2:['completata','parziale','workbench/reale: backup e due restore MongoDB concorrenti, operationId e Decimal128 verificati; superfici: persistenza progresso dopo chiusura e cambio contesto.'],
A1:['completata','parziale','superfici: UI amministrazione/MCP desktop/mobile. Backend RBAC reale superato; login/gestione utenti dalla UI reale in corso.'],
A2:['completata','parziale','superfici: vault/passphrase e errori desktop/mobile; solo profilo isolato. Suite vault disponibile, verifica corrente da completare.'],
A3:['completata','parziale','superfici: audit/salute/sessioni, SQL lungo copiabile; sessioni/lock/cancel reali sui tre container già superati.'],
P1:['completata','parziale','Unitari contrasto e copertura 11 viewport × chiaro/scuro/custom; editor e pannelli reali. Nessuna attestazione globale WCAG.'],
P2:['completata','parziale','superfici: guida, shortcut, licenza e aggiornamenti a 390/1440 nei due temi; nessuna pubblicazione o installazione release.'],
X1:['completata','parziale','Menu tastiera e popup annidati, ripristino focus, BottomSheet locale integrato. Arc/regressioni correnti in corso.'],
X2:['completata','parziale','Electron reale: avvio, resize, zoom 100/200%, focus e download SQL già provati. Ripetizione dopo ultimi cambiamenti richiesta.'],
X3:['completata','parziale','APK debug, build e strumentazione Android 15 emulatore dedicato superate; Node Mobile autonomo. Tastiera IME e rotazione sulla build finale ancora in corso.']
};
text=text.split('\n').map(line=>{
 const id=line.match(/^\| ([A-Z]\d+) /)?.[1];if(!rows[id])return line;
 const cells=line.split('|');const [implementation,verification,evidence]=rows[id];
 cells[6]=` ${implementation} `;cells[7]=` ${verification} `;cells[8]=` ${evidence} Report sotto test-reports/revisione-2026-10-09/verifica-attuale salvo diversa indicazione. `;
 if(id==='S3')cells[5]=' BottomSheet Arc, ricerca e scroll conservati ';
 return cells.join('|');
}).join('\n');
for(const [from,to] of Object.entries({'`backup-manager.js`':'`backupmanager.js`','`auth-ui.js`':'`auth.js`','`vault-ui.js`':'`vault.js`','`audit-log.js`':'`auditlog.js`','`valori.js`, `righe.js`':'`utils.js`, `griglia.js`','`cellselect.js`, `righe.js`':'`cellselect.js`, `grid.js`','`exportimport.js`':'`export.js`, `import.js`'}))text=text.replaceAll(from,to);
text=text.replace('## Matrice storica (precedente alla revisione corrente)',`### Integrazione del 10 ottobre

- Navigatore desktop unico a sezioni collassabili e ridimensionabili; nessun albero duplicato. Il riferimento visivo della sidebar fornito da Keus guida questa composizione.
- BottomSheet Arc locale per Connessioni e Database/Schemi su mobile (60%/94%, maniglia espandibile anche da tastiera, chiusura visibile). Stessi nodi e controller spostati nel portal; ricerca, selezione, scroll e preferenza desktop conservati. La testata gestisce il trascinamento, il contenuto mantiene scroll e selezione nativi. Il browser non interroga Arc a runtime.
- L'uscita dall'editing virtuale era impedita da un guard che bloccava anche il ridisegno esplicito: ora protegge solo lo scroll. Applica/Annulla sono visibili, il primo Escape chiude un calendario aperto, il successivo annulla la cella. Blur e Invio conservano il comportamento esistente. Una mutazione HTTP isolata reintroduce il difetto e fa fallire la prova.
- Il movimento ridotto usava durate piccolissime ma positive su ogni elemento: queste attivavano transizioni di altezza sugli spaziatori virtuali. La durata è ora zero; la regola duplicata è stata rimossa.
- Screenshot attuali: verifica-attuale/fluidita/navigatore-desktop.png, navigatore-mobile.png; verifica-attuale/uscita-editing/azioni-1440.png e azioni-390.png. La baseline precedente resta intatta. I conteggi DOM sono confrontabili; i tempi e i long task raccolti durante build concorrenti non sono presentati come guadagno di FPS.

Stato della consegna al presente aggiornamento: implementazione completata, verifica incompleta. Tutte le righe restano parziali finché l'ultima esecuzione delle suite e dei contenitori non è consolidata; le prove già eseguite sono indicate distintamente.

## Matrice storica (precedente alla revisione corrente)

Le sezioni successive conservano le evidenze della revisione precedente; non attestano il checkout corrente.`);
fs.writeFileSync(file,text);
