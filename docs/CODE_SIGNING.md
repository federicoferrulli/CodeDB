# Firma e release di CodeDB

La distribuzione passa da `.github/workflows/release.yml`: Windows NSIS x64,
macOS DMG/ZIP x64 e arm64, Linux AppImage/DEB/RPM x64, Android APK/AAB con
runtime autonomo. Tutti questi target sono obbligatori. iOS non è ancora un
progetto compilabile e non compare come job riuscito.

## Modalità

| Modalità | Desktop | Android | GitHub |
| --- | --- | --- | --- |
| Locale / workflow manuale con `pubblica=false` | Windows senza firma; macOS ad hoc; Linux | APK debug installabile, ID `.debug` | Soli artefatti CI, nessuna release |
| Credenziali parziali o non valide | Errore; nessun ripiego senza firma | Errore di configurazione/firma | Nessuna bozza completa |
| Tag o workflow con `pubblica=true` | Azure su Windows; Developer ID e notarizzazione su macOS | APK e AAB con chiave persistente | Unica bozza, pubblicazione manuale |

`npm run release:win|mac|linux` **prepara soltanto** il pacchetto di distribuzione.
Il caricamento è stato spostato nel job finale: i singoli builder non ricevono
un token GitHub e usano sempre `--publish never`. Questo evita bozze parziali
create contemporaneamente dalle piattaforme. `dist:*` resta un percorso locale
con @electron/packager, senza la qualifica di release firmata.

## Versioni e fonti verificate

Il lockfile mantiene Electron **43.7.9**, electron-builder/app-builder-lib
**26.17.0**, electron-updater **6.8.9**, @electron/osx-sign **1.3.3** e
@electron/notarize **2.5.0**. Le dipendenze applicative restano alle versioni precedenti.
Sono aggiunti soltanto gli strumenti di build `@babel/parser` **7.29.9** e
`regexpu-core` **6.5.3**, fissati nel lockfile per la compatibilità Unicode Android.
Le opzioni sono validate contro lo schema installato, inclusa una fixture
con opzione sconosciuta che deve essere rifiutata.

- [Configurazione Windows v26](https://www.electron.build/v26/docs/win/):
  `win.azureSignOptions`, non `win.sign` della v27. Il codice installato
  `windowsSignAzureManager.js` invoca `TrustedSigning` PowerShell >=0.5.0.
- [Configurazione macOS v26](https://www.electron.build/v26/docs/mac/):
  firma e notarizzazione integrate, senza hook di notarizzazione duplicati.
- [Configurazione Linux v26](https://www.electron.build/v26/docs/linux/):
  RPM è un target FPM supportato. I nomi d'architettura reali sono `x86_64`
  per RPM/AppImage e `amd64` per DEB; la raccolta usa il mapping del builder.
- [Hardened Runtime Apple](https://developer.apple.com/documentation/security/hardened-runtime):
  eccezioni motivate nella sezione macOS qui sotto.
- [Azure Login e OIDC](https://github.com/Azure/login),
  [Artifact Signing e autenticazione](https://github.com/Azure/artifact-signing-action):
  login federato e successivo uso di Azure CLI tramite DefaultAzureCredential.
- [Compatibilità AGP 8.9](https://developer.android.com/build/releases/agp-8-9-0-release-notes):
  AGP 8.9.2, Gradle 8.11.1, JDK 17 minimo, SDK/build-tools 35.
- [Firma Android](https://developer.android.com/studio/publish/app-signing):
  APK con apksigner; AAB con jarsigner.

CI: Node **24.14.0**, Windows 2022, Ubuntu 24.04, macOS 15 Intel/arm64 e
Xcode 16.4; Android usa Temurin 17, NDK 27.2.12479018 e CMake 3.22.1.
Le prove del backend Android usano **Node 18.20.4**, uguale al runtime incorporato.
I due runner Mac installano le dipendenze native per la propria architettura.
`beforePack` rifiuta un pacchetto con piattaforma/CPU diverse dall'host: copiare
un addon Windows o Intel in un pacchetto Linux o ARM non costituisce cross-compilazione.

## GitHub Secrets e Variables

Creare l'environment **release**, limitandolo a branch/tag fidati e proteggendo
le modifiche al workflow. Configurare qui i valori di distribuzione. Le build
manuali senza pubblicazione usano **build-test**, che non necessita di secret.
Il workflow non ha trigger pull_request. Solo il job Windows ha `id-token: write`;
solo il job `bozza` ha `contents: write`.

| Nome esatto | Tipo | Piattaforma | Obbligatorietà e formato |
| --- | --- | --- | --- |
| `AZURE_CODE_SIGNING_ENDPOINT` | Variable | Windows | Release: URL regionale HTTPS `https://<regione>.codesigning.azure.net/` |
| `AZURE_CODE_SIGNING_ACCOUNT` | Variable | Windows | Release: nome account Artifact Signing |
| `AZURE_CERT_PROFILE` | Variable | Windows | Release: nome certificate profile pubblico |
| `AZURE_PUBLISHER_NAME` | Variable | Windows | Release: Common Name esatto dell'identità verificata; stabile fra versioni |
| `AZURE_CLIENT_ID` | Secret | Windows | Release: UUID application/client dell'app Entra federata |
| `AZURE_TENANT_ID` | Secret | Windows | Release: UUID directory Entra |
| `AZURE_SUBSCRIPTION_ID` | Secret | Windows | Release: UUID sottoscrizione |
| `CSC_LINK` | Secret | macOS | Release: certificato Developer ID Application **con chiave privata**, P12 in Base64; localmente anche percorso del P12 |
| `CSC_KEY_PASSWORD` | Secret | macOS | Release: password non vuota del P12 |
| `APPLE_ID` | Secret | macOS | Release: email dell'account Apple Developer |
| `APPLE_APP_SPECIFIC_PASSWORD` | Secret | macOS | Release: password specifica per app per notarytool |
| `APPLE_TEAM_ID` | Variable | macOS | Release: identificativo Team di 10 caratteri maiuscoli |
| `ANDROID_KEYSTORE_BASE64` | Secret | Android | Release CI: JKS/keystore in Base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Secret | Android | Release: password del keystore, nome preesistente conservato |
| `ANDROID_KEY_ALIAS` | Secret | Android | Release: alias della chiave privata persistente |
| `ANDROID_KEY_PASSWORD` | Secret | Android | Release: password della chiave |
| `ANDROID_VERSION_CODE_BASE` | Variable | Android | Facoltativa: intero >=0, default 0; sommato a github.run_number |
| `CODEDB_REQUIRE_GPG` | Variable | Integrità | `true` rende GPG obbligatorio; `false`/assente lo rende opzionale |
| `GPG_PRIVATE_KEY` | Secret | Integrità | Chiave segreta esportata **ASCII armored**, non Base64; attiva la firma quando presente |
| `GPG_PASSPHRASE` | Secret | Integrità | Passphrase della chiave; assente solo per una chiave senza passphrase |
| `GPG_KEY_FINGERPRINT` | Variable | Integrità | Obbligatorio con GPG: fingerprint completo esadecimale senza spazi |
| `GITHUB_TOKEN` | Secret automatico | GitHub | Esportato come `GH_TOKEN` soltanto nel caricamento finale |

Variabili di processo, non secret da creare: `ANDROID_KEYSTORE_PATH` punta al
file decodificato in `RUNNER_TEMP`; `ANDROID_VERSION_CODE` è calcolato dal workflow;
`CODEDB_RELEASE=true` impone i prerequisiti; `CODEDB_BUILD_ARCH` seleziona la CPU.
`APP_BUILDER_TMP_DIR` confina il materiale Apple nella directory temporanea del runner.
Per GPG locale si possono indicare `GPG_BINARY` e `GPGCONF_BINARY` se non sono nel PATH.

## Windows: Azure Artifact Signing

Occorrono un account Artifact Signing, verifica dell'identità completata, un
profilo **Public Trust** e un principal Entra con ruolo **Artifact Signing
Certificate Profile Signer** sul profilo. Alcune interfacce conservano il nome
precedente Trusted Signing. L'endpoint deve corrispondere alla regione dell'account.

Configurare una federated credential Entra con issuer
`https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`
e subject `repo:federicoferrulli/CodeDB:environment:release` (adeguare se il repository cambia).
`azure/login@v3` apre la sessione CLI; l'integrazione nativa v26 usa
DefaultAzureCredential e raggiunge AzureCliCredential. Nessun client secret è
necessario in CI. Il logout è gestito dal post-step di Azure Login.

Per una build locale firmata, usare `az login` e `az account set --subscription ...`
con la stessa identità autorizzata, quindi impostare le variabili della tabella.
Se OIDC non è disponibile, l'integrazione supporta EnvironmentCredential con
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`: è un'alternativa locale,
non un secret aggiunto al workflow. Non combinare Azure con WIN_CSC_LINK/PFX.

Il builder firma EXE, DLL e addon `.node`, oltre a installer e disinstallatore NSIS,
con SHA-256 e timestamp RFC3161 `http://timestamp.acs.microsoft.com`. La verifica
nativa controlla Authenticode, Common Name e timestamp. `verifyUpdateCodeSignature`
rimane attivo; l'editore finisce in `app-update.yml`. Una firma valida non promette
l'assenza immediata di avvisi SmartScreen: la reputazione è un controllo distinto.

## macOS: Developer ID, notarizzazione e archivi

Occorrono Apple Developer Program, Developer ID Application esportabile in P12,
Team e account abilitati alla notarizzazione. Il builder importa il P12 in un
portachiavi temporaneo e seleziona esplicitamente il Team. La ricerca casuale nel
portachiavi utente resta disattivata. Il tipo è `distribution`: nessun ripiego su
Mac Developer. Cleanup del builder e step `always()` rimuovono il materiale temporaneo.

La notarizzazione integrata invia l'app, attende l'esito e applica il ticket prima
di ZIP/DMG. Il DMG è firmato; il ticket è applicato all'app che contiene, non viene
eseguita una seconda notarizzazione del DMG. La verifica estrae ogni ZIP e monta
ogni DMG in sola lettura: `codesign --verify --deep --strict`, Team, flag runtime,
`stapler validate` e `spctl --assess` sull'app. Nessun controllo Gatekeeper viene disabilitato.

Entitlements deliberati:

| Eccezione | App principale | Helper | Motivo |
| --- | --- | --- | --- |
| `com.apple.security.cs.allow-jit` | Sì | Sì | V8/Electron, anche su arm64 |
| `com.apple.security.cs.allow-unsigned-executable-memory` | No | No | Nessun componente rilevato richiede memoria eseguibile senza MAP_JIT |
| `com.apple.security.cs.disable-library-validation` | Sì | No | `db/mongoshRuntime.js` fa fork dello stesso eseguibile in modalità Node; `CODEDB_MONGOSH_CRYPT_SHARED_LIB_PATH` carica una libreria MongoDB esterna, con Team diverso |
| `com.apple.security.network.client/server` | No | No | Sono permessi App Sandbox; questa distribuzione Developer ID non attiva App Sandbox |

Gli addon inclusi sono firmati dal builder. La compatibilità della libreria MongoDB
esterna va provata con quella effettivamente distribuita dall'operatore; il test di
avvio carica gli addon inclusi, non verifica CSFLE contro un database.
Senza credenziali viene usata identità ad hoc `-`, senza Hardened Runtime né
notarizzazione: serve per sviluppo/prove, non per distribuzione o aggiornamenti firmati.

## Android: continuità della chiave

ApplicationId `com.codedb.android`, versionName da package.json, ABI ARM64, ARMv7 e
x86_64 rimangono invariati. Il debug usa `com.codedb.android.debug` e la normale chiave
di sviluppo. Gradle sync/help e debug non richiedono credenziali; task release
richiedono tutte le variabili, un file esistente e versionCode esplicito. Password
errata o alias inesistente fanno fallire la firma Gradle, senza fallback debug.

Generare **una sola volta**, fuori dal checkout (password richieste interattivamente):

```sh
keytool -genkeypair -keystore /percorso/privato/codedb.jks -storetype JKS -alias codedb -keyalg RSA -keysize 3072 -validity 10000
```

Per APK distribuiti direttamente la chiave è l'identità di firma dell'app e deve
rimanere la stessa. Con Play App Signing l'**upload key** dell'AAB può essere diversa
dalla chiave con cui Google firma gli APK. La pipeline usa una sola chiave configurata
per APK/AAB: non sostituirla con una upload key diversa se si vogliono aggiornare
installazioni APK esistenti. Nessuna pubblicazione Play Store viene configurata.

`versionCode = ANDROID_VERSION_CODE_BASE + github.run_number`, massimo 2100000000.
Prima del primo uso scegliere un offset che superi tutti i codici già distribuiti.
Rieseguire la stessa run mantiene il codice; una nuova run lo incrementa. Migrare o
ricreare il workflow richiede riallineare l'offset. Non riutilizzare un codice già
caricato su uno store per un nuovo contenuto.

APK e AAB vengono verificati separatamente: apksigner controlla anche il digest del
certificato atteso; jarsigner usa il keystore fidato e l'alias, con `-strict`.
Il controllo del contenuto visita anche `base/lib` e `base/assets` dell'AAB.
Entrambi sono artefatti CI e asset della bozza GitHub. Il keystore è rimosso con
`always()`, Gradle usa `--no-daemon`, la cache Gradle CI è disattivata.

La prova su libnode 18.20.4 ha rilevato l'assenza di `Intl` e delle proprietà Unicode
nelle regex, che impediva l'avvio di fast-uri e del router MCP. `android/unicode.cjs`
usa [regexpu-core](https://github.com/mathiasbynens/regexpu-core) durante la preparazione
per espandere le proprietà in intervalli: comprende le regex letterali e i pattern
emoji dinamici di Zod. Un nuovo pattern dinamico sconosciuto ferma la preparazione.
La trasformazione riguarda solo la copia delle dipendenze destinata all'APK;
non modifica il runtime desktop, non elimina controlli URI e conserva gli identificatori
Unicode. I dati Unicode del trasformatore sono fissati dal lockfile. Questo non
aggiunge `Intl`: funzionalità che lo richiedano necessitano ancora di una build Node con ICU.

## Base64 e GPG

Usare gli stessi comandi per P12 e JKS. I file generati restano in una directory
privata, non nel repository, nelle cache o negli artefatti CI.

```sh
# Linux (GNU coreutils)
base64 -w 0 /percorso/privato/codedb.jks > /percorso/privato/codedb.base64
# macOS (BSD): -i è diverso da GNU; tr rimuove le interruzioni di riga
base64 -i /percorso/privato/codedb.jks | tr -d '\n' > /percorso/privato/codedb.base64
```

```powershell
[IO.File]::WriteAllText('C:\privato\codedb.base64', [Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\privato\codedb.jks')))
```

Chiave GPG separata dalla firma dei pacchetti:

```sh
gpg --quick-generate-key 'CodeDB Release <indirizzo-controllato@example.org>' rsa3072 sign 2y
gpg --list-secret-keys --with-subkey-fingerprint
# Sostituire FINGERPRINT con il valore completo della propria chiave.
gpg --armor --export-secret-keys FINGERPRINT > /percorso/privato/release-private.asc
gpg --armor --export FINGERPRINT > /percorso/pubblico/release-public.asc
```

`GPG_PRIVATE_KEY` contiene il primo export. L'import in CI usa stdin e un GNUPGHOME
usa-e-getta, con pulizia in finally; la passphrase passa su stdin, non nella riga
comando. Il fingerprint viene confrontato con la chiave importata e con VALIDSIG.
`CODEDB-RELEASE-KEY.asc` contiene soltanto la chiave pubblica e viene incluso nel manifest.
Pubblicare il fingerprint anche su un canale indipendente dalla release: **nessuna
chiave reale/fingerprint è stata scelta da questa configurazione**.

```sh
gpg --show-keys --with-fingerprint CODEDB-RELEASE-KEY.asc
# Confrontare prima il fingerprint con il canale indipendente.
gpg --import CODEDB-RELEASE-KEY.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS              # Linux
shasum -a 256 -c SHA256SUMS          # macOS
node tools/release-assets.cjs verifica /percorso/asset  # anche Windows
```

Per il comando Node, impostare `GPG_KEY_FINGERPRINT` al fingerprint fidato quando
è presente `SHA256SUMS.asc`; `CODEDB_REQUIRE_GPG=true` rifiuta anche una firma assente.

Il manifest è creato dopo firma/notarizzazione e raccolta. Include tutti gli asset
finali con nomi relativi e ordinamento deterministico; esclude solo se stesso e la
propria firma `.asc`, per evitare autoreferenze. GPG firma il manifest, non modifica
AppImage/DEB/RPM. Non viene presentata come firma nativa RPM o DEB.

## Uso e prima release

```sh
npm ci
npm test
npm run build:ui
npm run typecheck:ui
npm run test:release
node test/unit-release-gpg.cjs        # richiede gpg e gpgconf
npm run build:win                    # su Windows
npm run build:mac                    # sul Mac della CPU richiesta
npm run build:linux                  # su Linux
npm run build:linux:docker           # da Windows, sorgenti in sola lettura
npm run build:android                # APK debug + lint, con toolchain Android
```

`CODEDB_BUILD_ARCH=x64|arm64` deve coincidere con la CPU dell'host. La pipeline
produce entrambe le architetture Mac su runner separati. Conservare una cartella
output pulita per ogni build: la raccolta rifiuta asset duplicati o metadati di
versioni precedenti. `build:all` è soltanto una sequenza dei tre comandi e non
sostituisce i runner nativi richiesti dai moduli.

1. Configurare identità/secret/variables e protezioni dell'environment release.
2. Eseguire Actions → Build e release → Run workflow con `pubblica=false`.
   Controllare tutti i target, compreso l'avvio nativo e l'emulatore Android.
3. Per la prima prova firmata usare `pubblica=true` su un commit fidato, oppure
   inviare un tag SemVer uguale a package.json. Restano accettati `v*` e `[0-9]*`;
   viene usato il tag effettivo, senza crearne uno alternativo per la stessa versione.
4. Attendere `bozza`: la release resta draft; stable/prerelease deriva da SemVer.
   `INCOMPLETA` significa che caricamento/verifica non sono conclusi. Un retry
   rimuove il vecchio manifest e riconcilia tutti gli asset. Una release già
   pubblicata viene rifiutata prima di ogni modifica.
5. Scaricare e provare gli installer, confrontare firme e checksum, quindi
   pubblicare manualmente la bozza su GitHub. Non modificare gli asset dopo i checksum.

La raccolta conserva le blockmap e fonde **solo** i metadati Mac omonimi delle due
architetture. Controlla versione, nomi/URL relativi, SHA-512 e dimensioni dove il
builder le emette, percorso/hash legacy e presenza degli asset obbligatori. Con il
provider GitHub di questa versione il builder produce `latest.yml` anche per beta;
l'updater 6.8.9 prova il canale prerelease e accetta il fallback latest. Perciò non
si rinominano arbitrariamente i metadati in `beta*.yml`, né si inventa un manifest
per ogni formato. Il job finale ricontrolla dimensioni e SHA-256 remoti via API GitHub.

Gli aggiornamenti automatici richiedono una prova distinta fra due versioni firmate
pubblicate, sulla stessa identità e architettura: check, download, installazione,
riavvio e conservazione dei dati. La sola validazione dei metadati non prova quel flusso.

## iOS: requisito autonomo confermato, prerequisiti concreti

Non esistono `ios/`, progetto/workspace Xcode, scheme, bundle ID iOS o provisioning
profile. Nessuna dipendenza Capacitor/Tauri è stata aggiunta. Keus ha confermato
che il futuro client deve mantenere il server Node incorporato.

[Node.js Mobile](https://github.com/nodejs-mobile/nodejs-mobile) offre un percorso
iOS nativo, ma la presenza di un framework non prova la compatibilità di CodeDB.
La [FAQ ufficiale](https://github.com/nodejs-mobile/nodejs-mobile/blob/main/doc_mobile/FAQ.md)
segnala limiti su creazione di processi e addon. La ricognizione locale trova:

- `db/mongoshRuntime.js` usa child_process.fork; utility CLI di backup possono
  creare processi. Su iOS occorre un modello compatibile per queste funzioni,
  senza trasformare l'app in un semplice client remoto.
- `kerberos` e `mongodb-client-encryption` richiedono una verifica/build per iOS;
  gli addon desktop non possono essere copiati nel bundle. L'attuale preparazione
  Android li omette: non è prova di supporto mobile alle funzioni native.
- Il bootstrap Node 18 ha ponti per i moduli ESM condivisi; il progetto iOS deve
  scegliere/verificare un runtime aggiornato, le API VM usate da mongosh e il
  comportamento JIT sul dispositivo, oltre al simulatore.
- Servono host Swift/Objective-C, integrazione del framework, thread Node,
  WKWebView e loopback autenticato, directory sandbox, document picker, gestione
  sospensione/riavvio, TLS/connessioni DB e test su dispositivo.

Il passo successivo è un prototipo nativo con questi criteri di accettazione.
Solo dopo: bundle ID/scheme reali, Team/certificato Apple Distribution, profilo
per il canale scelto e exportOptions conforme alla versione Xcode. Non vengono
creati plist con valori inventati né un job verde senza IPA. Gli script di checksum,
verifica SemVer e GPG sono già riutilizzabili. Generare un'IPA ed esportarla non
equivale a distribuirla tramite App Store Connect/TestFlight; gli store restano fuori perimetro.

## Stato delle verifiche

Prove locali del 15 ottobre 2026 e sui runner GitHub del 16 ottobre 2026,
con log locali in `.scratch/code-signing-tools/`:

| Ambito | Esito provato | Verifica ancora necessaria |
| --- | --- | --- |
| Configurazioni | Schema builder installato, actionlint 1.7.12, parser PowerShell, sintassi Bash, XML plist e coerenza lockfile; build native sui cinque runner | Run con credenziali di distribuzione |
| Regressioni | `npm test`, build e typecheck UI, safe area Chromium; fixture negative per credenziali, schema, asset, canali, checksum, retry e versione desktop | Nessun database remoto esercitato da queste prove |
| Windows | NSIS senza credenziali costruito localmente e su Windows 2022; app impacchettata avviata con frontend e addon Kerberos/CSFLE | Firma Azure, timestamp e identità di produzione sul runner Windows |
| Linux | AppImage, DEB e RPM costruiti in container e sul runner Ubuntu 24.04; controlli rpm/dpkg, metadati e avvio grafico dell'AppImage estratta con addon nativi riusciti | Prova d'installazione nei sistemi destinatari |
| macOS | DMG/ZIP ad hoc costruiti sui runner macOS 15 Intel e ARM64; app avviata con frontend e caricamento reale degli addon Kerberos/CSFLE su entrambi | Developer ID, notarizzazione, ticket e Gatekeeper con identità di distribuzione |
| Android | APK debug, lint, backend Node 18 e test WebView sull'emulatore API 35 x86_64 riusciti anche in CI; APK/AAB con chiave usa-e-getta, firme apksigner/jarsigner e contenuto ABI verificati localmente | Chiave persistente di produzione, dispositivi ARM e database reali |
| GPG | Chiave temporanea, firma e verifica pubblica; manifest alterato e fingerprint errato rifiutati | Identità pubblica/fingerprint di distribuzione da scegliere e conservare |
| iOS | Assenza di progetto confermata, requisito autonomo e dipendenze da portare documentati | Prototipo Node nativo, progetto Xcode e identità/provisioning reali |

La [run GitHub 38881085878](https://github.com/federicoferrulli/CodeDB/actions/runs/38881085878)
del 16 ottobre 2026 è terminata con successo sul commit
`72a3520ce8feaacffb88db6acf57e4cdc0713e8b`, branch `codex/verify-release-actions`,
avviata manualmente con `pubblica=false`: otto job riusciti, `bozza` escluso.
L'[artifact release-completa](https://github.com/federicoferrulli/CodeDB/actions/runs/38881085878/artifacts/12037963296)
contiene i pacchetti di prova, i metadati Mac fusi e `SHA256SUMS`, verificati dal
job di raccolta; viene conservato per 14 giorni. In questa modalità Android
produce l'APK debug: l'AAB firmato resta coperto dalle prove locali indicate sopra.
Il confronto API prima/dopo conferma le sette release esistenti invariate,
senza creazione di release o bozze.

La prima esecuzione ha evidenziato due difetti corretti prima della run riuscita:
`setup-android@v3` richiedeva il pacchetto SDK obsoleto `tools` (ora installa
esplicitamente `platform-tools` con command-line tools fissati); gli array `arch`
nei target Mac imponevano entrambe le CPU su ciascun runner (ora i target sono
`dmg` e `zip`, con CPU selezionata dalla CLI). Il test di regressione usa il
risolutore reale di electron-builder ed è stato visto fallire con la vecchia
configurazione e passare con quella corretta. `npm run test:release` e actionlint
sono passati anche localmente prima del secondo invio.

La regressione Unicode Android è stata riprodotta sul libnode originale prima
della trasformazione e il test nativo è poi passato. Le chiavi temporanee usate
nelle prove sono state rimosse; gli APK/AAB locali firmati con quelle chiavi sono
soltanto fixture, non pacchetti da distribuire. Java locale 21 e Node host 26 sono
distinti dalle versioni fissate per CI; il container Linux ha usato Node 24.15.

Le firme Azure/Apple/Android di produzione richiedono credenziali esterne e una
run sui runner indicati: non sono dichiarate verificate in loro assenza. Il runtime
Android upstream 18.20.4 conserva il limite già documentato dell'allineamento ELF
a 4 KB; APK/AAB firmati non certificano compatibilità con dispositivi a pagine
16 KB o accettazione Google Play. Nessuna release è stata pubblicata e nessun
aggiornamento automatico fra due versioni firmate è stato provato.
