# Il contenitore dell'export è la cartella di backup, non uno ZIP

`piano-export-import-database.md` §4 elenca fra i formati un «archivio CodeDB versionato»
in «contenitore standard ZIP64», e dichiara insieme che Node non implementa ZIP nella
libreria standard, quindi servirebbe una dipendenza streaming mantenuta. La Fase 0 deve
scegliere il contenitore prima che qualcuno cominci a scriverlo.

**Abbiamo deciso che il contenitore dell'archivio CodeDB resta la cartella di backup già
esistente** — `manifest.json`, `data/<oggetto>.ndjson[.gz]`, `schema/<oggetto>.sql`, ogni
file con la propria impronta SHA-256 — **e che lo ZIP entra solo come confezionamento
finale, opzionale, per il download di un artefatto già finalizzato e verificato.**

La ragione è che tutte le proprietà che il piano chiede all'archivio ce le ha già la
cartella, e nessuna gliele dà lo ZIP. Ogni file è compresso singolarmente con `zlib`, che
è nella libreria standard; l'impronta è dei byte effettivi di ciascun file, quindi un
troncamento si vede sul file e non sull'intero archivio; il ripristino selettivo apre solo
i file che gli servono, con `fs.createReadStream`, senza indice centrale da leggere né da
fidarsi. Un contenitore ZIP aggiungerebbe una dipendenza di terze parti sul percorso più
critico del prodotto — quello che riscrive i database dell'utente — per riguadagnare
proprietà che già esistono, e porterebbe con sé la sua superficie: traversal, nomi
duplicati, collisioni Unicode, decompression bomb, che §10 elenca come cose da rifiutare e
che senza ZIP semplicemente non si presentano.

La doppia compressione che §4 vieta qui non è nemmeno esprimibile: se lo ZIP di
confezionamento viene aggiunto, i file dati sono già `.gz` e vanno **memorizzati** senza
comprimerli di nuovo.

**Per gli strumenti nativi la decisione è di non sceglierne nessuno in Fase 0.**
`pg_dump`/`pg_restore`, MySQL Shell e `mongodump` restano il perimetro della Fase 6 e la
loro scelta richiede la baseline prestazionale che la Fase 0 non ha potuto misurare —
questo ambiente non ha nessuno dei tre motori né un demone Docker. Sceglierli adesso
sarebbe fissare una dipendenza di packaging (disponibilità e licenza su Electron
Windows/macOS/Linux) sulla base di nessuna misura.

## Consequences

Il lavoro della Fase 2 sul trasporto riguarda **file su disco**, non voci di un archivio:
il download può servire direttamente un `.ndjson.gz` finalizzato con `Range`/`If-Range` e
`ETag` senza alcuno strato in mezzo, e la ripresa è quella di HTTP. Scaricare un intero
database come **un** file richiede invece il confezionamento, che è quindi una funzione a
sé e non un prerequisito: fino a quel momento un export multi-oggetto si scarica a file, o
non si scarica.

Il formato resta quello che `backup/lib/util.js` e `restore.js` già leggono, quindi la
compatibilità con i backup storici non è un lavoro aggiuntivo. Restano da decidere in Fase
6, con numeri veri, sia lo ZIP di confezionamento sia i backend nativi; questa decisione
non li preclude e non li promette.
