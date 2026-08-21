# 16: Il contesto della sessione diventa un argomento

**Cosa costruire:** un handler di evento si può invocare passandogli un contesto costruito
per la prova — socket finto, sessioni finte, principal finto — senza aprire un socket vero
né una connessione a un database.

Oggi la giuntura vive dentro una chiusura di quasi duemila righe per catturare socket,
sessioni e principal: non esiste alcun punto in cui sostituire il comportamento senza
modificare lì dentro. La conseguenza si vede nei test, che sono ridotti a leggere il file
come testo e a bilanciare le graffe con un'espressione regolare — ed è così che è stato
scoperto uno scambio fra due variabili omonime che aveva ucciso l'intero esecutore di
script a ogni invocazione, vissuto a lungo perché quel percorso non ha test.

È il prerequisito di tutto il resto del lotto e va fatto in un colpo: un server a metà
strada fra cattura e passaggio del contesto è peggio di entrambi gli stati.

Il blocco su 02 e 10 è per **conflitto sugli stessi file**, non per dipendenza logica.

**Bloccato da:** 02, 10.

**Status:** done

- [x] Il contesto della sessione è passato agli handler, non catturato dalla chiusura
- [x] Esiste un contesto finto che permette di invocare un handler in un test
- [x] Almeno tre handler di famiglie diverse hanno un test unitario che li invoca
- [x] Nessun comportamento è cambiato: l'intera suite end-to-end passa invariata
- [x] I test che leggono il file come testo continuano a passare, o sono sostituiti da test che invocano davvero il codice

## Che cosa è stato fatto

La chiusura anonima di `io.on('connection', (socket) => { … })` — duemiladuecento
righe — è diventata **due funzioni con un nome**:

* `creaContestoSocket(socket)` costruisce il contesto: `{ socket, ip, principal,
  sessions }`. È l'unica via da cui entrano identità e sessioni;
* `registraEventi(ctx)` registra gli ottanta eventi sul contesto ricevuto.

`io.on('connection')` conserva soltanto i controlli sui limiti di connessione —
che devono rifiutare *prima* che un contesto esista — e poi chiama
`registraEventi(creaContestoSocket(socket))`. Entrambe sono esportate, e
importare `server.js` **non** avvia il listener (`require.main === module` era
già lì).

**La modifica è deliberatamente piccola, e il motivo conta.** Il ticket chiede
che il contesto sia un argomento, non che ottanta corpi di handler vengano
riscritti: convertirli tutti a `(payload, cb, ctx)` sarebbe stato un diff di
duemila righe sul file più critico del repo, con lo stesso identico effetto
osservabile. `principal` resta una variabile locale — sono 107 riferimenti —
ma è **seminata dal contesto** (`let principal = ctx.principal`), che è la sola
differenza necessaria perché un test possa dire chi è l'utente. `sessions`
viene destrutturata dal contesto invece di essere creata lì dentro.

`rivalidaPrincipal` scrive ora in **tre** posti allineati: la locale, `ctx` e
`socket.principal`. Lasciare il contesto indietro darebbe due identità diverse
per lo stesso socket, ed è esattamente la classe di difetto che questo lotto
combatte.

`safeOn` passa il contesto agli handler come **terzo argomento**. Quelli storici
lo ignorano; è il punto d'appoggio su cui si innestano le giunture dei ticket
17–19, che potranno riceverlo invece di catturarlo.

## Come è stato provato

`test/contesto-finto.js` (**nuovo**): un `SocketFinto` che registra gli handler
invece di ascoltare la rete e sa invocarli restituendo l'ack come **promessa**
(un callback sincrono nasconderebbe ogni difetto di ordine), più
`sessioneFinta()` e `contestoFinto()`.

Una scelta merita di essere detta: `contestoFinto` **non** scrive
`socket.principal`. Metterlo anche lì renderebbe indistinguibile una giuntura
che legge il contesto da una che se lo risolve da sé dal socket — cioè
renderebbe cieca proprio la prova che il contesto conti.

`test/unit-giuntura-socket.js` (12 prove, registrato in `test/unit.js`): gli
handler vengono **chiamati**, senza socket vero e senza database. Tre famiglie
diverse secondo ADR-0001:

* **evento sui dati** — `db:list` delega alla strategia della sessione indicata
  dal tabId; senza sessione rifiuta; l'errore della strategia torna come
  messaggio e non come eccezione; i campi riservati al server (`maxRows`,
  `opHandle`) vengono tolti dal payload del client, e con un `runId` il
  riferimento di annullamento lo mette il server;
* **evento amministrativo** — `vault:status` risponde **senza alcuna sessione
  aperta**, che è la ragione per cui ADR-0001 lo tiene in una famiglia sua;
* **operazione lunga** — `query:cancel` lavora sullo stato della sessione, e su
  un `runId` sconosciuto non dichiara annullato ciò che non ha trovato.

Più due prove sul contesto in quanto tale: due contesti hanno sessioni
**indipendenti** (il contesto non è diventato uno stato globale), e l'identità
che la giuntura usa è quella del contesto — verificata via `auth:me`, che la
espone.

**Sensibilità verificata rompendo il codice di proposito**, nei due modi in cui
il contesto si può scavalcare:

| difetto introdotto | esito |
|---|---|
| `registraEventi` si crea le proprie `sessions` invece di prenderle dal contesto | **7 FAIL** su 12 |
| `registraEventi` risolve il principal da sé (`principalOf(socket)`) | **FAIL** «l'identità che la giuntura usa è quella del CONTESTO» |
| i campi riservati al server non vengono più tolti | **FAIL** sulla prova corrispondente |

Ripristinato ogni volta il file, zero fallimenti.

**I controlli statici restano e passano.** `unit-handler-scope.js` e
`unit-scritture-bersaglio.js` leggono ancora server.js come testo, e continuano
a servire: vedono cose che nessuna invocazione vede (un nome non legato in un
ramo mai percorso dai test). Non sono più però l'**unica** cosa possibile, che
era il punto del ticket.

## Suite eseguite

`npm test` (esito 0) e, con i due container dedicati (MySQL 8 su 3307,
PostgreSQL 16 su 5433):

| suite | FAIL | baseline |
|---|---|---|
| `e2e.js` (MongoDB) | 4 | 4 |
| `e2e-mysql.js` | 2 | 2 |
| `e2e-postgres.js` | 3 | 3 |
| `e2e-rbac.js` | 0 | 0 |
| `e2e-mcp.js` | 0 | 0 |
| `e2e-script-runner.js` | 0 | 0 |
| `e2e-sessions.js` | 0 | 0 |
| `e2e-backup.js` | 0 | 0 |

**Nessun fallimento nuovo.** I fallimenti residui sono preesistenti e misurati
con `git stash`.
