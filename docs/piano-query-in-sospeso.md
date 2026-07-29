# Piano — "Query in sospeso" (tracker delle query non portate a termine)

> Ambito deciso con Keus: **solo la tab ⚡ Query & Aggregate**. Nessuna modifica alla
> griglia dati (`grid.js`) né agli altri percorsi di lettura/scrittura.

## Obiettivo

Aggiungere un elemento in topbar che tiene traccia delle query avviate dalla tab
**⚡ Query & Aggregate** e **non portate a termine**, qualunque sia la causa
dell'interruzione:

- l'utente la mette **in pausa / la annulla** (tasto 🛑);
- la **connessione si interrompe** (socket down, tunnel SSH caduto, reconnect);
- la query **fallisce** con errore;
- la query **si blocca** e l'ack Socket.IO non torna mai.

Il pulsante mostra un badge con il numero di query in sospeso e, aprendolo, elenca
le voci indicando **da quale query ci si è fermati**, con la possibilità di
**riprenderla** (ricaricare il codice nell'editor e rilanciarla).

Il tasto 🛑 esegue un **annullamento reale lato server** (non solo lo stop
dell'attesa client): interrompe l'operazione in corso sul database
(`killOp` MongoDB / `KILL QUERY` MySQL / `pg_cancel_backend` PostgreSQL).

## Contesto tecnico (com'è oggi)

- Le query della tab partono da `runQuery()` in `public/js/query-tab.js:531`, che fa
  `emit('query:execute', …)` e aggiorna il badge con
  `updateQueryMetrics('running' | 'success' | 'error')`.
- Il server (`server.js:1067`, handler `safeOn('query:execute', …)`) esegue **dentro
  la callback di ack Socket.IO** e scrive l'audit (`auditQuery`) **solo quando la
  query termina** (ok o error).
- Il tasto 🛑 `#query-stop-btn` (`public/index.html:566`) oggi **si limita a
  nascondersi**: non annulla nulla e non lascia traccia.
- Conseguenza: **una query bloccata non produce audit** e, cambiando coll-tab o
  facendo F5, si perde quale query era rimasta appesa. È il buco da chiudere.

Il tracker vive **lato client**: è l'unico punto che "vede" una query ancora in volo
il cui ack non è (ancora) tornato. L'**annullamento reale** richiede invece un piccolo
intervento lato server (registro delle operazioni in volo per sessione + evento
`query:cancel` + metodo `cancelQuery` per strategia). La cifratura/segreti non sono
toccati.

## Componenti

### 1. Nuovo modulo `public/js/pending-queries.js`

Registro in memoria + persistenza in `sessionStorage` (chiave `codedb:pending`, in
linea con `session-restore.js`, così sopravvive a F5 e reconnect a caldo).

Forma della voce:

```js
{
  id,          // uuid locale
  code,        // testo della query
  engine,      // 'auto' | 'mongodb' | 'mysql' | 'postgresql' | 'crossdb'
  db, coll,    // target risolto lato client
  connName,    // nome connessione (dal tab attivo)
  tabId,       // tab di connessione d'origine
  collTabId,   // coll-tab d'origine (per il "Riprendi")
  startedAt,   // epoch ms
  endedAt,     // epoch ms | null
  elapsedMs,   // durata al termine | null
  status,      // vedi sotto
  error        // messaggio | null
}
```

Stati (`status`):

| stato          | significato                                             |
|----------------|---------------------------------------------------------|
| `running`      | avviata, ack non ancora tornato                         |
| `error`        | terminata con errore                                    |
| `paused`       | l'utente ha premuto 🛑 (annullata lato client)          |
| `disconnected` | connessione/socket caduta mentre era in volo            |
| `completata`   | terminata con successo (tenuta in "storico recente")    |
| `abbandonata`  | coll-tab/tab chiuso mentre era `running`                |

"In sospeso" = tutto ciò che **non** è `completata` (`running`, `error`, `paused`,
`disconnected`, `abbandonata`). Il badge conta queste.

API pubblica del modulo:

```js
track(meta) -> handle            // crea voce 'running', ritorna { id, done, fail }
handle.done(res)                 // -> 'completata' (+ elapsedMs)
handle.fail(err)                 // -> 'error'
markPaused(id) / markDisconnected(id) / markAbandoned(id)
list()                           // voci ordinate per startedAt desc
remove(id) / clearResolved()     // pulizia manuale / rimuovi le 'completata'
onChange(cb)                     // notifica per aggiornare badge + modale
```

Persistenza: `load()`/`save()` su `sessionStorage`; al reload, ogni voce che risulta
ancora `running` viene riclassificata `disconnected` (non possiamo sapere se il
server l'ha finita, e comunque l'ack andrebbe scartato da `utils.js` via `_tab`).

### 2. Aggancio in `runQuery()` (`public/js/query-tab.js`)

- Generare un **`runId`** (uuid client) e includerlo nel payload:
  `emit('query:execute', { …, runId })`. È la chiave con cui il server ritrova
  l'operazione da annullare.
- Prima dell'`emit`:
  `const h = trackPending({ runId, code, engine, db, coll, connName, tabId, collTabId });`
- Nel `.then(res)` → `h.done(res)`.
- Nel `.catch(err)` → `h.fail(err)`.
- Le voci che restano `running` (nessun `done/fail`) sono i blocchi: un **timeout
  soft** (default 30s, costante client) le lascia `running` ma le mostra come
  "⏳ in esecuzione da Ns" nella lista, senza ucciderle.

### 3. Tasto 🛑 (annullamento reale) reso tracciante

Nel wiring del bottone `#query-stop-btn` (oggi inerte), al click sulla query in corso:

- emette **`query:cancel` `{ tabId, runId }`** verso il server, che uccide
  l'operazione sul database (vedi sezione backend);
- chiama `markPaused(runId)` nel registro client e nasconde il badge di esecuzione;
- imposta `updateQueryMetrics('idle')` con messaggio "Annullata".
- Se il server risponde che l'operazione era già finita o non trovata, la voce resta
  comunque `paused`/`completata` in modo coerente (nessun errore bloccante all'utente).

### 3-bis. Annullamento reale lato server (backend)

Obiettivo: quando l'utente preme 🛑, l'operazione viene **davvero interrotta** sul
database, non solo abbandonata dal client.

**Registro delle operazioni in volo (per sessione).** In `server.js`, nel gestore
`safeOn('query:execute', …)` (`server.js:1067`): all'inizio si registra
`session.inflight.set(runId, opHandle)`, alla fine (finally) si rimuove. `opHandle`
contiene i dati necessari all'annullamento, popolati dalla strategia (vedi sotto).

**Nuovo evento `query:cancel` `{ tabId, runId }`.** Recupera la sessione dal `tabId`,
cerca `runId` in `session.inflight` e chiama `strategy.cancelQuery(opHandle)`.
Risposta `{ ok: true, cancelled: bool }`. Idempotente: `runId` sconosciuto/già finito
→ `{ ok: true, cancelled: false }` senza errore.

**Nuovo metodo `cancelQuery(opHandle)` nel Strategy Pattern** (`db/DbStrategy.js` come
no-op di base, override nelle tre strategie):

- **MongoDB** (`MongoDbStrategy.js`): taggare ogni find/aggregate del Query Engine con
  un **`comment: runId`** (opzione supportata dal driver). `cancelQuery` apre `admin`,
  fa `$currentOp` filtrando per quel `comment`, ricava l'`opid` e chiama `killOp`.
  Su standalone/permessi mancanti degrada a `cancelled: false` (come già fa
  `collection:watch` con `watch:unavailable`).
- **MySQL** (`MySqlStrategy.js`): eseguire la query del Query Engine su una
  **connessione dedicata** del pool di cui si cattura `CONNECTION_ID()`; salvarlo in
  `opHandle`. `cancelQuery` prende **un'altra** connessione dal pool ed esegue
  `KILL QUERY <id>`.
- **PostgreSQL** (`PostgreSqlStrategy.js`): catturare il `client.processID` della
  connessione che esegue la query in `opHandle`. `cancelQuery` esegue
  `SELECT pg_cancel_backend($1)` da un'altra connessione del pool.

**Audit.** L'annullamento riuscito viene tracciato in `ui-audit.log` come evento
`query:cancel` (categoria `write`, `op` "Annullamento query"), riusando `auditUi` come
gli altri eventi. Best-effort, non blocca.

**Timeout di sicurezza.** Opzionale ma consigliato: passare `maxTimeMS` (Mongo) e un
timeout di statement (MySQL/PostgreSQL) alle query del Query Engine, così un blocco
non trattenuto da nessuno viene comunque liberato lato server dopo un tetto massimo.

### 4. Interruzione di connessione

Nel modulo socket/riconnessione (`public/js/socket.js` / gestione `disconnect` del
socket): per ogni voce `running` chiamare `markDisconnected(id)`. Al ritorno del
socket restano in lista come "in sospeso — connessione caduta", pronte da riprendere.

### 5. Chiusura tab / coll-tab

In `colltabs.js` (chiusura coll-tab) e `tabs.js` (chiusura tab connessione): le voci
`running` appartenenti a quel `tabId`/`collTabId` passano a `abbandonata`.

### 6. Pulsante topbar + modale

- **Bottone**: nuovo `⏳` nell'area `.header-tools-wrap` (`public/index.html:226`,
  accanto a `⋮`), con badge numerico = voci in sospeso. Coerente con lo stile dei
  bottoni header esistenti.
- **Modale** `#modal-pending`: stessa impalcatura di `#modal-audit-log` /
  `#modal-health` (`public/index.html:1272` / `:1353`). Lista ordinata per tempo
  (più recenti in alto). La **prima voce non completata è "dove si è fermato"**,
  evidenziata.

Per ogni riga:

- testo query (troncato + espandibile), connessione, db/coll, engine;
- "avviata alle…", stato (badge colorato: in esecuzione / errore / in pausa /
  disconnessa / abbandonata), durata o messaggio d'errore.

Azioni per riga:

- **▶ Riprendi** — riattiva il tab/coll-tab d'origine, riempie
  `#query-editor-input` con `code` e rilancia `runQuery()`.
- **📋 Copia** il codice.
- **✔ Segna risolta** / **🗑 Rimuovi**.

Footer: **Pulisci completate** (`clearResolved`).

### 7. Modulo nuovo `public/js/pending-queries.js` — inizializzazione

- `initPendingQueries()` chiamata da `main.js` (come gli altri init di modale):
  carica da `sessionStorage`, riclassifica le `running` orfane, disegna il badge,
  registra i listener del bottone/modale e l'`onChange`.

## File toccati

| File                                | Modifica                                                     |
|-------------------------------------|--------------------------------------------------------------|
| `public/js/pending-queries.js`      | **nuovo** — registro, persistenza, badge, modale             |
| `public/js/query-tab.js`            | `runId` + `track/done/fail` in `runQuery()`; 🛑 → `query:cancel` + `markPaused` |
| `public/js/socket.js`               | `markDisconnected` sulle voci `running` al `disconnect`      |
| `public/js/colltabs.js`             | `markAbandoned` alla chiusura coll-tab                       |
| `public/js/tabs.js`                 | `markAbandoned` alla chiusura tab connessione                |
| `public/js/main.js`                 | `initPendingQueries()`                                       |
| `public/index.html`                 | bottone `⏳` + badge in header; modale `#modal-pending`       |
| `public/css/style.css`              | stile bottone/badge/modale (riuso classi esistenti)          |
| `server.js`                         | registro `session.inflight` in `query:execute`; evento `query:cancel`; audit |
| `db/DbStrategy.js`                  | `cancelQuery(opHandle)` no-op di base                        |
| `db/MongoDbStrategy.js`             | `comment: runId` su find/aggregate + `killOp` via `$currentOp` |
| `db/MySqlStrategy.js`               | cattura `CONNECTION_ID()` + `KILL QUERY`                     |
| `db/PostgreSqlStrategy.js`          | cattura `processID` + `pg_cancel_backend`                    |

Il **tracker** è interamente client; l'**annullamento reale** aggiunge un intervento
mirato su `server.js` e sulle strategie DB (nessuna modifica a cifratura/segreti).

## Persistenza & casi limite

- **F5 / reconnect a caldo**: le voci vivono in `sessionStorage`; le `running` orfane
  diventano `disconnected`. Coerente con `session-restore.js`.
- **Ack che torna dopo la pausa/abbandono**: `utils.js` scarta le risposte dei tab
  non più validi via `_tab`; una voce già `paused`/`abbandonata` non viene
  sovrascritta (guardia sullo stato in `done/fail`).
- **Query di successo**: restano brevemente come `completata` (storico recente),
  eliminabili con "Pulisci completate"; non incidono sul badge.
- **Chiusura del tab del browser**: `sessionStorage` si azzera by design (come la
  sessione ripristinabile).

## Test

- **Unit** `test/pending-queries.js` (senza DB, se estraibile la logica pura del
  registro): lifecycle `running → done/fail`, `markPaused/Disconnected/Abandoned`,
  persistenza load/save, `clearResolved`, conteggio badge.
- **Manuale**:
  1. query lenta/pesante → badge `running`, F5 → `disconnected`, **Riprendi**;
  2. 🛑 durante l'esecuzione → operazione **realmente uccisa** sul DB (verifica con
     `$currentOp` / `SHOW PROCESSLIST` / `pg_stat_activity`) → voce `paused`;
  3. stop del server/rete → `disconnected`;
  4. query errata → `error` con messaggio;
  5. chiusura coll-tab con query in volo → `abbandonata`;
  6. **Pulisci completate** e **Rimuovi** puliscono correttamente.
- **e2e cancellazione** (con DB reali, sulle tre strategie): avviare una query lenta
  (es. `SELECT SLEEP(10)` su MySQL, `pg_sleep(10)` su PostgreSQL, aggregate pesante o
  `$where`-free su MongoDB), inviare `query:cancel` e verificare che l'operazione
  sparisca dal server e che `cancelled: true`; `runId` inesistente → `cancelled: false`.

## Fasi

1. Modulo `pending-queries.js` (registro + persistenza + badge) e init in `main.js`.
2. Aggancio in `runQuery()` (con `runId`) e 🛑.
3. Hook di disconnessione (`socket.js`) e chiusura tab/coll-tab.
4. Modale con lista, evidenziazione "dove si è fermato" e azioni (Riprendi/Copia/
   Rimuovi/Pulisci).
5. **Annullamento reale lato server**: registro `session.inflight` + evento
   `query:cancel` in `server.js`, metodo `cancelQuery` nelle tre strategie, audit.
6. Test unit + e2e cancellazione + collaudo manuale.

## Fuori ambito (eventuale lavoro futuro)

- Estensione del tracker alle query della **griglia dati** (`grid.js`): resta limitato
  alla tab ⚡ Query & Aggregate.
