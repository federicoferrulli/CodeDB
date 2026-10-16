# CodeDB per Android

APK autonomo: Node.js Mobile esegue il server CodeDB nel processo dell'app;
la WebView visualizza la stessa interfaccia del desktop. MongoDB, MySQL,
PostgreSQL e tunnel SSH usano gli stessi driver JavaScript. Non occorre un PC
con CodeDB avviato. I database devono essere raggiungibili dal telefono:
`localhost` indica il telefono, non il PC.

## Release GitHub

Per firma multipiattaforma, variabili e prima release vedere [CODE_SIGNING.md](../docs/CODE_SIGNING.md).

Il workflow `.github/workflows/release.yml` costruisce anche Android al push
dei tag esistenti (`v*` e `[0-9]*`). La versione viene da `package.json`;
`versionCode` somma ANDROID_VERSION_CODE_BASE al numero crescente della run del workflow. L'APK viene
allegato insieme all’AAB alla bozza del tag effettivo dopo le build desktop e la prova
su emulatore. Non modifica il modo in cui la release viene pubblicata.

Prima del primo tag configura in GitHub → Settings → Secrets and variables →
Actions questi quattro secret:

| Secret | Contenuto |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | File keystore codificato in base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Password del keystore |
| `ANDROID_KEY_ALIAS` | Alias della chiave, ad esempio `codedb` |
| `ANDROID_KEY_PASSWORD` | Password della chiave |

Genera la chiave **una sola volta**, con `keytool` del JDK:

```sh
keytool -genkeypair -keystore codedb.jks -storetype JKS -alias codedb -keyalg RSA -keysize 3072 -validity 10000
```

Su PowerShell, per ottenere il valore del primo secret:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path codedb.jks)))
```

Conserva chiave e password fuori dal repository, con una copia di sicurezza.
Android accetta un aggiornamento solo se firmato dalla stessa chiave. Non
generiamo una nuova chiave a ogni tag. Se manca un secret, il job di release
Android fallisce con un messaggio esplicito; la bozza finale richiede il successo di tutti i target.
L'avvio manuale senza pubblicazione produce un APK debug installabile come
app separata (`com.codedb.android.debug`), senza richiedere secret.

## Build locale

Servono Node.js 20+, JDK 17, Gradle 8.11.1 e Android SDK con platform 35,
build-tools 35.0.0, NDK 27.2.12479018 e CMake 3.22.1. Il workflow installa
questi strumenti automaticamente. Puoi aprire `android/` in Android Studio.
La preparazione include solo i sorgenti tracciati da Git: aggiungere a Git i
nuovi file del backend prima di costruire una versione che li usa.

```sh
npm run prepare:android
node android/test.cjs
gradle -p android assembleDebug
node android/test.cjs android/app/build/outputs/apk/debug/app-debug.apk
gradle -p android connectedDebugAndroidTest
```

Per la release locale imposta `ANDROID_VERSION_CODE` a un intero crescente,
`ANDROID_KEYSTORE_PATH` al percorso assoluto e le tre variabili della firma
come i secret sopra, quindi `npm run release:android` (APK e AAB).
Senza configurazione completa Gradle rifiuta i task release;
per prove locali usa `npm run build:android` oppure `assembleDebug`.

## Dati, file e ciclo di vita

All'avvio una scena Canvas nativa compone i tre livelli del database, con
orbite di dati e ingresso del marchio. Al primo fotogramma dell'interfaccia
pronta lascia spazio all'app con un'uscita di 360 ms, senza attese minime
aggiunte. Rispetta la scala delle animazioni Android: con animazioni rimosse
mostra il simbolo fermo e passa subito all'app; in background interrompe il
disegno. Il layout si adatta all'orientamento e ai caratteri ingranditi.
Un errore ferma l'animazione e offre «Riprova». Le barre di stato e navigazione seguono il tema scelto, compresi
i temi personalizzati e le anteprime; l'ultimo tema salvato viene ricordato
anche per lo splash successivo. I colori delle icone si adattano allo sfondo.
Su Android 12+ anche lo starting window del sistema ricorda la scelta chiara
o scura; segue Android in modalità automatica. Per un tema personalizzato usa
questa base nei primissimi istanti, poi la scena nativa applica i colori esatti.
La scelta viene comunicata tramite l'API Android
[`setSplashScreenTheme`](https://developer.android.com/reference/android/window/SplashScreen#setSplashScreenTheme(int)),
senza ricreare l'Activity quando l'utente cambia tema.

Indietro chiude prima la finestra, il menu o il pannello aperto e poi torna
al sistema. I pannelli inferiori si trascinano dalla testata; lo schema delle
query si chiude scorrendo verso sinistra e conserva lo scorrimento verticale.
Un doppio tocco su una tabella o un campo inserisce il nome nel punto scelto
dell'editor e mostra una conferma, senza aprire la tastiera dietro lo schema.

`node test/e2e-mobile-shell.js` verifica layout, temi, doppio tocco e gesti
touch nel browser; `connectedDebugAndroidTest` verifica anche splash,
barre native, persistenza del tema, Indietro e inset sulla WebView Android.
Confronta inoltre i fotogrammi per verificare movimento, animazioni rimosse,
errore e ripresa, e controlla la conclusione unica della transizione e i testi
su schermi piccoli, orizzontali e con font ingranditi al 160%.
`node test/e2e-mobile-android.js` installa l'APK debug nell'emulatore dedicato
`emulator-5580` (1080×2400), prova Indietro da entrambi i bordi e salva
le schermate native in `test-reports/mobile-shell/android`.
Con quell'app già avviata, `node test/e2e-splash-android.js` acquisisce anche
gli avvii nei tre temi, in orizzontale e con animazioni rimosse, e registra
il video dell'apertura reale in `test-reports/splash-mobile`.

Vault, connessioni, backup, log e risultati persistono nella directory privata
`files/data`; i sorgenti vengono estratti in una directory privata distinta per
versione (non nella cache eliminabile da Android) e sostituiti
all'aggiornamento. La disinstallazione cancella i dati locali. Il backup
automatico Android è disattivato per non esportare i segreti dell'app.
Importazione e salvataggio usano il selettore documenti Android, senza
permesso di accesso generale alla memoria. I download passano a blocchi
dalla WebView al documento scelto, compresi Blob, CSV, JSON e immagini.
Apertura, scrittura e chiusura del documento avvengono in sequenza su un thread
dedicato, così un provider lento non blocca l'interfaccia Android. Il test nativo
verifica la risposta della UI mentre la scrittura resta in attesa.

Il server ascolta solo su loopback, con un cookie HttpOnly
casuale necessario anche per WebSocket e MCP. I link esterni vanno al browser;
non ricevono il ponte per i file. TLS non viene aggirato per i database.
La porta viene scelta libera al primo avvio e conservata in `files/data/porta-http.json`:
cronologia, preferenze e diagrammi mantengono così la stessa origine WebView.
Se un'altra app occupa quella porta, CodeDB chiede di liberarla senza cambiare
origine e far apparire vuoti i dati salvati.

Il server vive finché vive il processo Android. Android può sospendere o
terminare l'app in background: tenere l'app in primo piano durante query,
backup e importazioni. Non è un servizio server permanente in background.
Le utilità esterne (`mongodump`, `pg_dump`, `mysqldump`) non sono incluse;
restano disponibili i motori di import/export e backup JavaScript di CodeDB.

## Runtime e verifiche

Il binario ufficiale [Node.js Mobile 18.20.4](https://github.com/nodejs-mobile/nodejs-mobile/releases/tag/v18.20.4)
è fissato con SHA-256. È un runtime upstream datato: aggiornare Node.js Mobile
quando disponibile. Le librerie ufficiali hanno allineamento ELF da 4 KB:
la compatibilità con telefoni configurati con pagine da 16 KB non è garantita
e richiede una nuova build del runtime upstream, non soltanto di questo APK.
L'APK include ARM64, ARMv7 e x86_64, richiede Android 7+ e Android
System WebView aggiornato. Il job usa un emulatore Android 15 x86_64; non
certifica tutte le architetture, le versioni Android o i database remoti.

`node android/test.cjs` controlla il contenuto preparato, l'avvio reale del
backend, l'estrazione ZIP tramite il JDK, la persistenza dell'origine fra due
processi, il conflitto di porta e il rifiuto di HTTP/WebSocket senza cookie.
`connectedDebugAndroidTest` carica davvero libnode nell'emulatore e
controlla HTTP e Socket.IO dalla WebView. I test non sostituiscono una prova
dei database e delle operazioni lunghe sul proprio telefono.

La WebView e la schermata di avvio vivono in un contenitore che rispetta
barre di sistema, notch e tastiera. Gli inset già applicati vengono azzerati
prima di raggiungere il contenuto web, evitando margini doppi. Il test nativo
verifica anche notch laterale/superiore e apertura/chiusura della tastiera
mediante inset controllati, sul runtime Android reale.

`node test/e2e-safe-area.js` verifica l'interfaccia web con Chromium: safe area
verticale e orizzontale, tablet/desktop, modali, drawer e menu. La tastiera e
il pan sono simulati tramite `visualViewport`; il pinch zoom non ridispone
il layout. Su browser mobile gli stessi limiti proteggono anche la barra
inferiore, la palette e il pannello delle relazioni.

Per Node 18 il bootstrap precarica i moduli condivisi di identificatori, funzioni SQL e blocchi SQL
con `import()` e li espone al ponte CommonJS esistente; la preparazione assegna
inoltre l'estensione `.mjs` alla copia Android del modulo di analisi MCP.
I sorgenti e il comportamento del desktop restano invariati.

Il libnode incluso non dispone di ICU/`Intl` e rifiuta le proprietà Unicode nelle
regex. `prepare.cjs` le espande con `unicode.cjs` nella sola copia delle dipendenze
Android, conservando identificatori Unicode e controlli URI; comprende i pattern
emoji dinamici di Zod e rifiuta nuovi pattern dinamici non riconosciuti. Le versioni
degli strumenti e i dati Unicode sono fissati nel lockfile. La verifica di avvio
sull'emulatore rimane obbligatoria: il solo Node 18 del computer dispone di ICU
e non riproduce questa differenza.
