# 06: Spostare l'import database in una operazione lunga

Status: ready-for-agent
Type: task
Blocked by: 05

Sostituire l'orchestrazione frontend per collezione con un unico evento server-side che
usa il motore del piano. L'evento appartiene alla famiglia delle operazioni lunghe di
ADR-0001.

- [ ] Il browser non invia più sequenze autonome di drop, create, import e DDL
- [ ] Tab, connessione e destinazione sono congelati all'avvio
- [ ] Avanzamento, annullamento cooperativo, audit e stato finale passano dalla giuntura delle operazioni lunghe
- [ ] La chiusura del tab non classifica come fallita un'operazione ancora viva e non genera retry
- [ ] Riaprendo il tab è possibile recuperare lo stato dell'operazione
- [ ] Capability e accesso all'intera connessione vengono verificati prima di accettare il piano
- [ ] UI, CLI e MCP chiamano lo stesso motore
- [ ] Il test della registrazione prova che l'evento appartiene a una sola famiglia
- [ ] Socket e contesto finti esercitano l'evento reale senza rete o database

