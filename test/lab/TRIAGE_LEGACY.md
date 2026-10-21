# Triage della campagna E2E storica

**Chiusura delle ripetizioni CLI:** anche `e2e-griglia-viste.js` (5.337 ms) e
`e2e-uml-progetto-regressioni.js` (17.419 ms) superano il runner ufficiale dopo
copia filtrata e build UI. Report e manifest sorgenti:
`.scratch/lab-reports/docker/ripetizioni-finali/`. Insieme ai dieci risultati
verdi del batch precedente, tutte le dodici suite selezionate sono state
chiuse con esecuzione completa; non è stata ripetuta tutta la baseline.

Campagna iniziata il **20 ottobre 2026 alle 22:58:28 UTC**, nel container
`codedb-affidabilita-prove-1`, conclusa alle **23:27:51 UTC**:
**159 suite: 134 superate, 23 fallite, una incompleta e un timeout**.
I 25 risultati non verdi sono classificati qui: due difetti confermati,
un candidato, otto fixture corrette e 14 limiti/prerequisiti di esecuzione.
I candidati non sono inclusi nel conteggio dei difetti confermati.

Fonte primaria: `/laboratorio/rapporti/esecuzione.json` e i singoli
`/laboratorio/rapporti/<nome-suite>.log`, conservati dal coordinatore anche in
`.scratch/lab-reports/docker/`. Le verifiche aggiuntive descritte qui
sono state eseguite sul server isolato dell'harness, in Chrome locale, con
porte 393xx. Nessuna suite aggiuntiva è stata avviata nel namespace Docker
della campagna attiva. Nessun sorgente di produzione è stato modificato.

**Un test rosso non equivale automaticamente a un difetto del prodotto.**
La classificazione riguarda la causa osservata; una suite fermata in fase di
preparazione non certifica le verifiche che avrebbe eseguito dopo.

## Classificazione dei risultati non verdi

| Suite | Classificazione | Evidenza e seguito |
| --- | --- | --- |
| `e2e-arc-griglia.js` | **Difetto confermato** | Il menu contestuale aperto durante la chiusura di Modifica/Duplica viene richiuso quando termina lo smontaggio del dialogo. La regressione dedicata `test/lab/dialog-menu.cjs` fallisce per entrambe le finestre, mentre i due controlli aperti a chiusura completata passano. |
| `e2e.js` | **Difetto confermato** | La creazione esplicita di una collection MongoDB fallisce con `BSON field 'create.db' is an unknown field`. Il delegato inoltra l'intero payload come opzioni del driver; anche `tabId` viene trasmesso al comando Mongo. Riproduzione indipendente con driver di controllo e verifica dell'assenza della collection richiesta. |
| `e2e-griglia-fluidita.js` | **Candidato: contratto UX da decidere** | Il test pretende che Database rimanga aperto dopo Strumenti → Tema → Escape. `theme.js` chiude esplicitamente il navigatore all'apertura del tema. Riprodotto in Chrome: il navigatore sparisce subito; dopo Escape il focus torna correttamente al pulsante Database. Nessun blocco o perdita di dati osservato. Non è stata cambiata l'aspettativa del test per renderlo verde. |
| `e2e-griglia-viste.js` | **Fixture corretta e verificata in Linux** | La fixture marca il tab connesso, ma lascia visibile la schermata «Nessuna connessione aperta». Nel container il messaggio occupa circa 400 px e lascia al frame 114 px: toolbar e footer azzerano la griglia. La normale chiamata `renderWorkspace()` nella preparazione ripristina lo stato coerente; nello stesso container tutte le verifiche passano con griglia alta 349 px. |
| `e2e-uml-progetto-regressioni.js` | **Fixture corretta e verificata in Linux** | Il combobox Arc esiste nel fratello corretto, ma la guida iniziale si apre dopo la preparazione e lo rende inaccessibile al locator per ruolo. Nascondere gli overlay prima della risposta asincrona non ne impedisce la successiva apertura. Stato onboarding iniziale dichiarato prima della navigazione: entrambe le varianti MySQL/PostgreSQL passano nello stesso container, senza cambiare helper o prodotto. |
| `e2e-arc-campi.js` | **Fixture corretta** | La guida iniziale asincrona intercettava il primo clic. Stato onboarding iniziale ora esplicito. Suite completa superata su host. |
| `e2e-cronologia-posizione.js` | **Fixture corretta** | Enter arrivava prima del focus differito di Radix dopo Home: veniva selezionata ancora la connessione precedente. Attesa della condizione di focus effettiva, senza pausa arbitraria; suite superata. |
| `e2e-icone-uniformi.js` | **Fixture corretta** | Il test rimuoveva direttamente il nodo onboarding mentre conteneva il menu condiviso: `showContextMenu` riceveva un nodo nullo. Onboarding dichiarato già visto, rimozione DOM eliminata; suite completa superata. |
| `e2e-query-select.js` | **Fixture corretta** | Tentava di scegliere MySQL/PostgreSQL senza una connessione del relativo tipo: opzioni correttamente disabilitate da `renderNativeTargets()`. La fixture ora dichiara il contesto per ogni motore e verifica anche la disabilitazione del motore estraneo. Superati selezione, tastiera, focus, Escape, tocco e otto layout. |
| `e2e-rbac-ui.js` | **Fixture corretta** | Dopo gli screenshot del login rimane la viewport a 390 px. Il test attendeva la X desktop `#onboarding-close`, nascosta nel BottomSheet mobile. La guida era aperta e la sessione autenticata. Ora usa il comando mobile accessibile e attende la chiusura effettiva; login, creazione, sospensione e riattivazione dell'utente passano con MongoDB reale isolato. |
| `e2e-sql-integrita-ui.js` | **Fixture corretta** | Cercava solo `input`: il valore SQL TEXT usa una `textarea`, lasciando nell'elenco solo il campo generato disabilitato. Ora identifica i controlli per campo e invia l'evento input, necessario a impostare la modalità valore. Passano chiave originale, `_id` reale, modifica documento/inline e omissione della colonna generata. |
| `e2e-conteggi-navigatore.js` | **Limite ambiente** | `spawnSync docker ENOENT`: la suite vuole creare container PostgreSQL autonomi; il runner base non espone la CLI Docker. Fermata prima di provare i conteggi. Serve profilo con Docker sul sistema ospite. |
| `e2e-insert-types.js` | **Limite ambiente risolto nel rerun** | `INSERT_MYSQL_PORT` e `INSERT_PG_PORT` non erano impostate; la baseline si fermava alla guardia iniziale. Con gli alias configurati, la suite completa supera la ripetizione CLI in Linux. |
| `e2e-mongo-snapshot-types.js` | **Limite ambiente risolto nel rerun** | `EXPORT_MONGO_RS_PORT` era assente; la baseline si fermava alla guardia iniziale. Con la porta del replica set configurata, la suite completa supera la ripetizione CLI in Linux. |
| `e2e-mongosh-runtime.js` | **Limite ambiente: profilo nativo assente** | Connessione rifiutata su `127.0.0.1:27039`, indirizzo della fixture sql-native richiesto dal test. Il successivo `MongoTopologyClosedError` proviene dalla pulizia dopo il fallimento della connessione. Ripetizione assegnata al profilo nativo. |
| `e2e-mongosh-ui.js` | **Limite ambiente: profilo nativo assente** | Stessa connessione rifiutata su 27039 prima della prova UI. Il doppio errore finale è cleanup su client non connesso. Ripetizione assegnata al profilo nativo. |
| `e2e-query-dialetti-nativi.js` | **Limite della matrice versioni; compatibilità da separare** | Il catalogo dichiara PostgreSQL 18; il server della baseline è 17.5 e fornisce la keyword `RECHECK`, assente dal catalogo 18. La verifica globale dei cataloghi si ferma prima dei confronti delle query. Ciò non dimostra una riscrittura o esecuzione errata. Ripetere con l'oracolo PG18; l'eventuale completezza del completamento su PG17 è una verifica di compatibilità distinta. |
| `e2e-sql-mongo-tipi.js` | **Limite della matrice versioni** | `db/sqlCondizioniPostgres.json` dichiara PG18. Il test genera handler per tutte le condizioni e li invia anche al PG17.5 della baseline, che rifiuta `invalid_argument_for_xquery`. Errore nell'oracolo PostgreSQL prima del completamento del confronto. Ripetizione assegnata al profilo PG18. |
| `e2e-integrita-import.js` | **Prerequisito di autenticazione soddisfatto nel rerun** | La baseline saltava «MongoDB drop negato», che richiede `CODEDB_E2E_MONGO_AUTH=1` e `MONGO_ADMIN_URI`. La ripetizione CLI con il servizio MongoDB autenticato passa interamente, senza SKIP: anche quel caso è ora coperto. |
| `e2e-mobile-drawer-click.js` | **Limite di durata risolto nel rerun** | Baseline interrotta dal runner a 180.034 ms, vicino alla fine del terzo viewport. Host completo: **1.188 bersagli**, zero coperti e zero errori JavaScript. Ripetizione CLI Linux con budget 360 s: suite superata in **176.725 ms**, senza SKIP. |
| `e2e-contenitori.js` | **Prerequisito desktop/Android noto** | Avvio Electron non disponibile nel runner headless di base. Suite non prova un pacchetto desktop funzionante in questo ambiente. |
| `e2e-mobile-android.js` | **Prerequisito Android noto** | `adb.exe ENOENT`, emulatore e APK dedicati assenti. |
| `e2e-scorciatoie.js` | **Prerequisito desktop noto** | Electron non avviabile nell'ambiente della baseline. |
| `e2e-splash-android.js` | **Prerequisito Android noto** | `adb.exe ENOENT`, emulatore dedicato assente. |
| `e2e-zoom.js` | **Prerequisito desktop noto** | Electron non avviabile nell'ambiente della baseline. |

## Evidenze delle verifiche mirate

### Creazione esplicita di collection MongoDB

`server/eventi-dati.js:117` chiama
`strategy.createCollection(p.db, p.name, p)`. In
`db/MongoDbStrategy.js:498` l'intero terzo argomento viene deserializzato e
inoltrato a `MongoClient.db(db).createCollection()`: include anche campi del
protocollo CodeDB, estranei alle opzioni MongoDB.

Riproduzione indipendente: server su 39341, MongoDB su 37017 con
`directConnection=true`, database casuale `codedb_lab_create_<identificatore>`.
Il driver nativo crea `controllo_driver`; il socket collegato all'istanza
locale CodeDB riceve questa richiesta:

```json
{"tabId":"lab","db":"<database temporaneo>","name":"creata_via_ui"}
```

L'acknowledgment è
`{"ok":false,"error":"BSON field 'create.tabId' is an unknown field."}`.
La lettura indipendente del catalogo conferma il controllo presente e
`creata_via_ui` assente. Il database temporaneo è stato eliminato a fine
prova. Evidenza: `.scratch/lab-triage/mongo-create.json`.
Il nome del primo campo sconosciuto dipende dall'ordine del payload: nella
baseline è `db`, nella riproduzione è `tabId`; la causa è la stessa.

### Menu durante la chiusura dei dialoghi

In `ui/dialogs.tsx` il menu condiviso viene trasferito nel pannello del
dialogo. Durante l'uscita il CSS consente già di interagire con il workspace.
Un clic destro apre il popover, ma la pulizia finale lo sposta nel DOM e il
browser lo chiude. Nelle due riproduzioni:

```text
transizione: closing
subito dopo il clic: popover=true, overlay=editdoc-overlay / duprow-overlay
dopo la chiusura del dialogo: popover=false, hidden=false, overlay=null
```

Evidenze: `.scratch/lab-reports/dialog-menu.json` e i JSON/PNG in
`.scratch/lab-reports/dialog-menu/`. La suite dedicata mantiene i fallimenti:
due controlli verdi e due regressioni rosse. Non introdotta un'attesa nel
vecchio test che nasconda questo comportamento.

### Navigazione, tema e Split-View

Per Strumenti → Tema il navigatore è presente prima del clic e già assente
quando il tema appare. Dopo la chiusura completa il focus è su
`mobile-nav-dbs`, visibile e non inerte. Il ramo esplicito è
`public/js/theme.js`, funzione `apriModale()`, chiamata
`closeNavigationSheet(true)`. Screenshot:
`.scratch/lab-triage/fluidita/triage-tema-chiuso.png`.
Serve una decisione sul ritorno al contesto di navigazione; il test non è
stato indebolito e il comportamento non viene descritto come crash.

Per Split-View le tre prove locali erano verdi, anche con CPU rallentata 4×.
La diagnosi successiva nello stesso container ha isolato la fixture:
`#welcome` resta visibile insieme al tab connesso. La cornice viene manipolata
direttamente dal test senza chiamare `renderWorkspace()`. L'iframe ha altezza
114 px e la griglia 0 px, invariati anche dopo 750 ms: non è un'attesa di
rendering insufficiente. Screenshot e misure:
`.scratch/lab-triage/griglia-linux.png` e `griglia-linux.json`.

La sola aggiunta di `renderWorkspace()` dopo aver preparato il tab connesso
fa passare la suite nello stesso Linux: griglia alta **349 px**, prima riga
`0 → 125`, `scrollTop=4000` conservato e identità degli elementi `<th>`
invariata. Evidenze: `.scratch/lab-triage/griglia-linux-corretta.png` e
`griglia-linux-corretta.json`. La correzione è nel solo test, senza attese o
modifiche CSS che mascherino il risultato.

### Fixture corrette e risultati completi

| Suite ripetuta | Evidenze locali | Esito |
| --- | --- | --- |
| Gestione RBAC | `.scratch/lab-triage/rbac-ui.log`, `rbac-ui/triage-onboarding.png`, `rbac-ui-fixed.log`, `rbac-fixed/rbac-ui/report.json` | Originale rosso; correzione verde con MongoDB reale su 37017 e nomi database univoci. |
| Selettore query | `.scratch/lab-triage/query-select-fixed.log`, `query-select-fixed/checks.json` e 18 PNG nello stesso percorso | Tutte le verifiche verdi, otto layout. |
| Integrità UI SQL | `.scratch/lab-triage/sql-integrita-ui-fixed.log` | Tutte le asserzioni verdi; trasporto simulato dichiarato dalla suite. |
| Controlli mobili | `.scratch/lab-triage/mobile-drawer-click.log`, `mobile-drawer-click/report-tutti.json` | 1.188 bersagli, zero errori; tre viewport. |
| Split-View Linux | `.scratch/lab-triage/griglia-linux.json`, `griglia-linux-corretta.json` e relativi PNG | Originale rosso, preparazione coerente verde nello stesso Chromium/container. |
| Progettista UML Linux | `.scratch/lab-triage/uml-linux.json` e `uml-linux.png` | Originale rosso con onboarding aperto; inizializzazione già visto verde per MySQL e PostgreSQL nello stesso container. |

Gli screenshot del selettore inizialmente scritti nella cartella storica
`test-reports/query-select-2026-10-12/dopo` sono stati copiati in
`.scratch/lab-triage/query-select-fixed`. I 19 file tracciati sovrascritti
sono stati ripristinati alla baseline; il test supporta ora
`CODEDB_REPORT_ROOT`, per conservare i prossimi rapporti nel laboratorio.

Le ripetizioni su Chrome locale verificano la correzione delle fixture ma
non sostituiscono la ripetizione nella stessa versione Chromium del runner.
Le modifiche ai tre test precedenti (campi, cronologia, icone) erano già state
verificate e comunicate prima di questo audit. La diagnosi Linux successiva
ha chiuso anche il caso UML: nel JSON il `select` e il suo combobox fratello
sono montati e `arcReady=true`, mentre `onboarding-overlay` è aperto. La
sola inizializzazione della guida già vista prima della navigazione fa
passare azioni FK, protezione dello schema esterno, rinomina e metadati della
bozza per entrambi i motori. Non sono state introdotte attese o selezioni
forzate; la modifica interessa solo la preparazione del test.

## Da chiudere dopo questa rilevazione

Il batch CLI del **20 ottobre, 23:35:01–23:39:13 UTC**, ha concluso
**10 suite superate su 12**: `arc-campi`, `cronologia-posizione`,
`icone-uniformi`, `insert-types`, `integrita-import`, `mobile-drawer-click`,
`mongo-snapshot-types`, `query-select`, `rbac-ui`, `sql-integrita-ui`.
Nessuno di questi risultati contiene SKIP o righe FAIL. Fonte:
`.scratch/lab-reports/docker/ripetizioni/esecuzione.json`.

I due rossi del batch erano `griglia-viste` e `uml-progetto-regressioni`,
ancora eseguiti prima delle correzioni diagnosticate sopra. Le correzioni
sono già verdi nelle prove mirate nello stesso container; resta la loro
ultima verifica tramite il normale comando CLI.

1. Registrare la ripetizione CLI finale delle due ultime fixture, conservando
   separatamente baseline, primo batch e verifica finale.
2. Registrare i risultati dei confronti nativi con PG18 nel rapporto del
   relativo profilo. Tipi, snapshot e import con autenticazione sono già
   coperti dalla ripetizione CLI descritta sopra.
3. Decidere il comportamento UX atteso tornando dal tema al navigatore.
   Questo rimane l'unico candidato non risolto nel triage della baseline.
4. Desktop, Android e profili avanzati esclusi non sono copertura acquisita:
   richiedono le rispettive campagne. La baseline non contiene una prova
   equivalente di quei percorsi.
