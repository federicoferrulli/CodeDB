# CodeDB: Microsoft Store e distribuzione indipendente

La stessa applicazione Electron con server Node incorporato produce due pacchetti:

| Canale | Pacchetto | Firma | Aggiornamenti |
| --- | --- | --- | --- |
| Sito e GitHub | Installer NSIS `.exe` | Senza firma per impostazione predefinita; Azure opzionale | electron-updater, GitHub Releases o feed HTTPS |
| Microsoft Store | `.appx` dedicato | Firma Microsoft dopo certificazione | Microsoft Store |

AppX è supportato dal builder 26.17.0 già installato ed è accettato da Partner
Center insieme a MSIX. Non occorre riscrivere l'app né rimuovere il server locale.
Il pacchetto usa `Windows.FullTrustApplication` e la capability `runFullTrust`:
la descrizione in fase di certificazione deve spiegare server loopback, connessioni
ai database, tunnel SSH, backup e processi mongosh.

## 1. Preparare l'account Store

Aprire [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com/) e
completare registrazione e verifica dell'identità. Il nuovo percorso offre
registrazione gratuita; scegliere il tipo di account appropriato all'attività.
Il nome riservato è **CodeDB Manager**. In Partner Center, aprire
**Gestione prodotto → Identità prodotto** per consultare i valori assegnati.

L'environment GitHub **microsoft-store** contiene queste **Variables**, non Secrets
(configurate e rilette tramite API il 16 ottobre 2026):

| Variabile | Valore |
| --- | --- |
| `MICROSOFT_STORE_IDENTITY_NAME` | `Keus.CodeDBManager` |
| `MICROSOFT_STORE_PUBLISHER` | `CN=60BDE555-366B-4374-9514-5F0B9271A94A` |
| `MICROSOFT_STORE_PUBLISHER_DISPLAY_NAME` | `Keus` |
| `MICROSOFT_STORE_VERSION` | `1.0.0.0` per il primo invio; incrementare per i successivi |

Nessun certificato, password o token Store serve alla compilazione. La versione
del pacchetto Store è indipendente dalla SemVer di CodeDB: il primo intero deve
essere 1..65535, i due intermedi 0..65535 e l'ultimo **0**, riservato allo Store.
Incrementare questa versione anche fra due beta con la stessa versione base.
Non cambiare l'identità dopo il primo invio.

## 2. Costruire e provare

Da Windows x64, con Node e dipendenze installate:

```powershell
npm ci
npm run build:win
npm run build:store:test
$env:CODEDB_STORE_TEST = 'true'
./test/e2e-windows-store.ps1
Remove-Item Env:CODEDB_STORE_TEST
```

L'installer e il feed sono in `dist/`; il pacchetto Store è in `dist/store/`.
`build:store:test` usa **CodeDB.ProvaStore**, editore e versione fittizi esclusivi
del collaudo; il nome dell'artefatto contiene `prova`. Non inviarlo a Partner Center.
L'AppX non firmato non è un installer da distribuire direttamente agli utenti.

Il test predefinito verifica manifest, versione, quattro icone, assenza del feed
NSIS e avvio del contenuto estratto con frontend e addon nativi. **Non equivale
all'installazione AppX.** Con `-Installa`, in una macchina di prova Windows con SDK
e Windows PowerShell 5.1 amministrativa, firma una copia con certificato usa e getta, installa
il pacchetto, lo attiva tramite Windows e verifica identità AppX reale, server
autonomo, frontend, addon e scrittura/rilettura cifrata del vault. Infine rimuove
pacchetto e certificati temporanei. L'artefatto originale resta senza firma.
Usare una macchina di prova: la prima installazione Store crea un profilo dedicato.

Il workflow **Distribuzioni Windows** esegue queste prove sui push pertinenti a
`develop`, `main` e `codex/**`; si può anche avviare manualmente con `prova=true`.
Produce gli artefatti `windows-indipendente` e `windows-store-prova`, con checksum.
Ha soltanto `contents: read`: non crea tag, release, bozze o invii allo Store.

## 3. Preparare il pacchetto per Partner Center

Configurate le quattro variabili, avviare **Distribuzioni Windows** manualmente
con `prova=false`. Il pacchetto sarà nell'artefatto **windows-store-partner-center**.
In locale impostare le stesse variabili e usare `npm run build:store`.
La build si ferma se identità/versione mancano o sono invalide; nessun ripiego
silenzioso sull'identità fittizia. Prima di ricostruire rimuovere gli AppX precedenti
da `dist/store/`: il collaudo rifiuta una selezione ambigua di pacchetti.

Caricare l'AppX in Partner Center, completare descrizione italiana, schermate,
privacy, licenza, classificazione e motivazione di `runFullTrust`. La certificazione
e l'eventuale firma Microsoft avvengono lì: una build riuscita non prova l'accettazione.
Il workflow non accetta credenziali e non effettua invii a Partner Center.

## 4. Sito, GitHub e aggiornamenti

L'EXE indipendente rimane utilizzabile senza Store. Con `CODEDB_WINDOWS_SIGNING=unsigned`
(default in assenza di credenziali) può essere costruito anche in modalità release.
Windows può mostrare editore sconosciuto e avvisi SmartScreen. Il feed resta HTTPS,
con verifica dei digest dei download; senza certificato manca la verifica dell'editore.
Non viene disabilitata la verifica Authenticode delle distribuzioni firmate.
I criteri di controllo applicazioni possono anche impedirne l'avvio: nel collaudo
locale del 16 ottobre 2026 Device Guard ha bloccato l'EXE non firmato. Lo stesso
pacchetto si avvia sul runner; non sono stati modificati i criteri del PC.

`windows-indipendente` contiene installer, blockmap, metadati di aggiornamento e
SHA256SUMS. La pubblicazione rimane una fase distinta: per gli aggiornamenti GitHub
caricare tutti gli asset del canale nella release della versione corrispondente;
per il sito usare un feed HTTPS configurato con `CODEDB_UPDATE_URL`.
La pipeline multipiattaforma `release.yml` continua a richiedere credenziali Apple
e Android per la bozza completa. La firma Windows Azure è facoltativa, attivata
da `CODEDB_WINDOWS_SIGNING=azure` nell'environment `release`, con credenziali complete.
Non configurarla per un individuo italiano senza idoneità Azure Public Trust.

Il pacchetto Store non contiene `app-update.yml` e non carica electron-updater:
«Controlla aggiornamenti» apre la raccolta aggiornamenti del Microsoft Store.
Le variabili del feed indipendente non cambiano questo comportamento.

Le due installazioni usano profili separati: `CodeDB` per NSIS, `CodeDB Store` per
AppX e `CodeDB Store Prova` per il collaudo (soggetti alla virtualizzazione Windows).
Non vengono copiati o cancellati
connessioni, password e backup durante il passaggio. Per migrare un profilo,
chiudere entrambe le app ed esportare/importare esplicitamente i dati desiderati;
conservare insieme file connessioni, cartella connessioni e vault, con la passphrase.

## Verifica del 16 ottobre 2026

La [pipeline Windows 38910297175](https://github.com/federicoferrulli/CodeDB/actions/runs/38910297175)
è riuscita sul codice `1b6a61a`, Windows Server 2022 x64. Ha costruito NSIS e AppX,
avviato entrambi i contenuti, installato e attivato l'AppX con identità Windows reale,
caricato Kerberos/CSFLE e verificato scrittura/rilettura cifrata del vault nel profilo
di prova. Per installare AppX sul runner serve Windows PowerShell 5.1: il modulo
Appx di Server 2022 non si carica in PowerShell 7.

Sono disponibili gli artefatti `windows-indipendente` e `windows-store-prova`,
conservati per 14 giorni. Sono passati anche `npm test` locale, `test:release` e
actionlint; la sensibilità del test che separa gli aggiornamenti è stata verificata
rimuovendo temporaneamente il controllo Store e osservando il fallimento atteso.
Le release GitHub esistenti sono rimaste invariate.

Non sono stati provati un aggiornamento completo fra due versioni installate,
connessioni a database reali o Windows ARM64. Certificazione,
firma Microsoft e aggiornamenti dal vero Store richiedono un invio
successivo a Partner Center; l'AppX di prova non è un pacchetto da inviare.

## Riferimenti

- [Firma Store e installer EXE/MSI](https://learn.microsoft.com/en-us/windows/apps/publish/get-started)
- [Registrazione account](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)
- [Requisiti e versioni pacchetti](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
- [AppX electron-builder v26](https://www.electron.build/v26/docs/appx/)
- [Rilevamento dell'identità AppX in Electron](https://www.electronjs.org/docs/latest/api/process#processwindowsstore-readonly)
- [Apertura della pagina aggiornamenti Store](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-store-app)
