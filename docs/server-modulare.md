# Server modulare

`server.js` è la facciata compatibile con i launcher esistenti. Importarlo non
apre porte, non legge il vault e non registra listener sul processo. Le proprietà
storiche `app`, `server` e `io` costruiscono pigramente l'istanza predefinita;
`startServer()` la avvia. `node server.js` e `bin/codedb.js` usano `runCli()`, che
possiede i listener del processo e la chiusura su SIGINT/SIGTERM. Electron continua
a usare `startServer()` senza installare quei listener.

## Creare e arrestare un'istanza

```js
const path = require('path');
const { createServer } = require('./server');

const dati = path.resolve('dati-istanza');
const servizio = createServer({
  config: {
    env: {
      HOST: '127.0.0.1', PORT: 0,
      CODEDB_CONNECTIONS_FILE: path.join(dati, 'connections.ini'),
      CODEDB_CONNECTIONS_DIR: path.join(dati, 'conns'),
      CODEDB_BACKUPS_DIR: path.join(dati, 'backups'),
      CODEDB_SCRIPT_RESULTS_DIR: path.join(dati, 'results'),
      CODEDB_UI_AUDIT_FILE: path.join(dati, 'ui-audit.log'),
      CODEDB_MCP_AUDIT_FILE: path.join(dati, 'mcp-audit.log'),
    },
  },
});

await servizio.start();
console.log(servizio.server.address().port);
// Alla fine del lavoro:
await servizio.stop();
```

L'ambiente viene copiato alla costruzione; `config.env` sovrascrive i valori del
processo senza modificarli. `PORT: 0` lascia scegliere una porta libera al sistema.
`config.rootDir` individua le risorse del progetto; `config.desktop` permette di
fornire il ponte Electron esplicitamente (`null` per escluderlo).

Sessioni, quote, lock, autenticazione, vault e gateway MCP appartengono all'istanza.
Per isolare anche i dati persistenti occorrono percorsi distinti, come nell'esempio,
e un control plane distinto se RBAC è attivo. I percorsi predefiniti conservano
il comportamento dei launcher esistenti.

`start()` è asincrono e risolve quando la porta è in ascolto. Avvii concorrenti
condividono la stessa Promise. Un errore di inizializzazione o una porta occupata
provocano il rigetto dopo il rilascio delle risorse già create.

`stop()` è idempotente, attende un eventuale avvio in corso, rifiuta nuove
operazioni e attende quelle accettate. Ferma gli script, chiude sessioni DB,
tunnel, upload, gateway MCP e control plane, elimina i depositi dei risultati
e completa l'audit. Non termina il processo. Un'istanza arrestata non si riavvia:
si crea una nuova istanza. Il launcher CLI applica un limite di cinque secondi
alla chiusura prima di forzare l'uscita.

## Responsabilità

| Modulo in `server/` | Responsabilità |
| --- | --- |
| `createServer.js` | Composizione e ciclo di vita |
| `configurazione.js`, `dipendenze.js` | Configurazione e adapter sostituibili |
| `trasporto.js` | HTTP, Socket.IO, Origin/Host, TLS e gate di rete |
| `socket.js` | Contesto del socket, ack, rivalidazione, lease e chiusura |
| `eventi-*.js` | Registrazione degli eventi per funzionalità |
| `identita.js` | Login/logout, principal, control plane e autorizzazioni |
| `vault.js` | Crittografia, passphrase e connessioni salvate |
| `connessioni.js`, `budget.js`, `lock.js` | Strategie, tunnel, riconnessioni e quote |
| `query.js` | Esecuzione SQL, MongoDB e Virtual JOIN |
| `operazioni.js` | Import e vincoli delle operazioni sui database |
| `audit.js`, `informazioni.js`, `errori.js` | Audit, informazioni installazione ed errori |
| `mcp.js`, `processo.js` | Gateway MCP e integrazione con il processo CLI |

Le strategie DB, il motore di backup, RBAC e l'interprete degli script restano
nei rispettivi moduli del progetto. I 94 eventi Socket.IO conservano nome,
famiglia di registrazione e protocollo degli acknowledgment.

## Test

`createServer({ dependencies })` permette di sostituire `DbFactory`,
`openSshTunnel`, `AppStore`, `createEntitlementProvider`, `makeAuditor` e
`ScriptResults`. Un adapter sostitutivo deve implementare i metodi usati dalla
prova. Non serve modificare `require.cache` o avviare un database per verificare
il ciclo di vita.

Per gli handler, `registraEventi(contesto)` accetta il contesto di
`test/contesto-finto.js`. `test/server-fixture.js` compone inoltre la giuntura
Socket.IO con registratori e adapter finti. Il catalogo atteso in
`test/server-eventi-attesi.json` protegge la compatibilità del protocollo.

```sh
node test/unit-server-modulare.js
npm test
# Su database di prova, mai sui dati dell'utente:
npm run test:e2e:all
```

Le nuove prove coprono istanze simultanee, isolamento di vault/upload/audit e
risultati degli script, errori di avvio, arresto durante avvio/login/lavoro,
rivalidazione concorrente, payload malformati, ack monouso e rilascio dei tunnel.
Una prova con 100 strategie finte verifica il budget condiviso UI/MCP e il
rilascio completo durante l'arresto con un client MCP ancora collegato. Il canale
SSE delle notifiche viene chiuso prima di attendere le richieste HTTP pendenti.
I test di processo verificano import senza effetti, avvio diretto e launcher CLI.
I test E2E verificano i driver e il protocollo con database reali.

## Correzioni emerse durante la verifica

- L'avvio RBAC ignora anche `NamespaceNotFound` nella rimozione dell'indice
  storico delle preferenze: su un control plane nuovo la collezione non esiste.
- L'identità delle sessioni PostgreSQL conserva i microsecondi di
  `backend_start`, necessari al confronto prima di annullare o terminare un backend.
- L'export JSON MySQL conserva il CRS delle geometrie. L'import usa il CRS del
  valore, oppure lo SRID della colonna; per i file storici privi di entrambi usa
  il riferimento cartesiano SRID 0. Il vecchio formato non permette di ricostruire
  un eventuale CRS originario non dichiarato. Le modifiche inline mantengono il
  controllo rigoroso sullo SRID e non modificano la cache durante il binding.
