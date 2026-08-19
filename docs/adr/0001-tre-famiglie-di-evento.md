# Gli eventi sono tre famiglie, non una

CodeDB ha ottanta eventi socket, dei quali trentadue passano dalla giuntura che delega a
una strategia — e che applica sette decisioni: spoglio dei campi riservati al server,
classificazione per l'audit, verifica preventiva della capability, registrazione del
riferimento di annullamento, scrittura dell'audit, contesto attaccato all'errore, pulizia
finale. Gli altri quarantotto sono registrati per la via generica e rifanno a mano ciò che
gli serve.

La lettura naturale — e quella che una revisione dell'architettura ha effettivamente
proposto — è che quei quarantotto «sfuggano» alla giuntura e vadano ricondotti dentro.
**Abbiamo deciso di non farlo.** Classificandoli tutti, solo quattro (i due eventi di
osservazione delle collezioni e i due degli schemi) sono candidati puri; gli altri
quarantaquattro hanno un motivo che regge: ventisei non toccano alcuna strategia e non
hanno un database come bersaglio su cui verificare una capability, otto sono operazioni
lunghe che richiedono otto punti di estensione distinti che la giuntura non offre, quattro
sono backup autorizzati sull'intera connessione, tre governano il ciclo di vita della
sessione stessa (che la giuntura presuppone già esistente), due verificano una capability
che non ha bersaglio.

Forzarli in un'unica giuntura la renderebbe **superficiale** — un'interfaccia piena di
parametri opzionali e di rami, complessa quanto ciò che nasconde — proprio mentre oggi è
profonda. Riconosciamo quindi tre famiglie (evento sui dati, evento amministrativo,
operazione lunga), ciascuna con la propria giuntura, e mettiamo sotto tutte e tre solo ciò
che condividono davvero: la ricerca della sessione a partire dal tab, e la scrittura
dell'audit.

## Consequences

Un evento nuovo obbliga a dichiarare a quale famiglia appartiene. È il costo che paghiamo
in cambio del fatto che nessuna delle tre giunture debba accogliere casi che non le
somigliano.

I quattro candidati puri rientrano nella giuntura dei dati e vi guadagnano la riconnessione
automatica, che oggi non hanno.
