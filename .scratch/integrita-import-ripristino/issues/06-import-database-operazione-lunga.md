# 06: Spostare l'import database in una operazione lunga

Status: resolved
Type: task
Blocked by: 05

Sostituire l'orchestrazione frontend per collezione con un unico evento server-side che
usa il motore del piano. L'evento appartiene alla famiglia delle operazioni lunghe di
ADR-0001.

- [x] Il browser non invia più sequenze autonome di drop, create, import e DDL
- [x] Tab, connessione e destinazione sono congelati all'avvio
- [x] Avanzamento, annullamento cooperativo, audit e stato finale passano dalla giuntura delle operazioni lunghe
- [x] La chiusura del tab non classifica come fallita un'operazione ancora viva e non genera retry
- [x] Riaprendo il tab è possibile recuperare lo stato dell'operazione
- [x] Capability e accesso all'intera connessione vengono verificati prima di accettare il piano
- [x] UI, CLI e MCP chiamano lo stesso motore
- [x] Il test della registrazione prova che l'evento appartiene a una sola famiglia
- [x] Socket e contesto finti esercitano l'evento reale senza rete o database

## Risposta

L'import database è ora una operazione lunga server-side con ack immediato, ID stabile,
progresso, AbortSignal, stato interrogabile e lease della sessione oltre la chiusura del
tab. Il browser carica anche file oltre 5 MB in blocchi senza effetti e avvia una sola
mutazione server-side. Anteprima ed esecuzione richiedono la stessa impronta. UI, comando
CLI `import` e tool MCP `import_database_artifact` usano `creaPianoImport` ed
`eseguiPianoImport`. I test reali della giuntura e della registrazione passano.

Upload e operazioni sono inoltre legati al soggetto autenticato, non al solo tenant. Lo
stato riverifica `manage` sulla connessione; i caricamenti hanno TTL temporizzato, quota
globale, quota per owner e limite di concorrenza, e lo stato pubblico non espone percorsi
assoluti delle copie di recupero.

Il registro conserva al massimo 100 esiti terminali per 24 ore, annulla i timer degli
esiti potati e rilascia adapter/sessione a operazione conclusa. L'evento
`database:import:list`, filtrato per owner, soggetto e capability, permette alla UI di
scoprire e riprendere automaticamente l'ultimo import della connessione.
