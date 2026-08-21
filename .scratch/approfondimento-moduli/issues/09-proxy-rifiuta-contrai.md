# 09: Il Proxy autorizzante rifiuta in mancanza di regola (contrai)

**Cosa costruire:** un metodo di strategia privo di voce nella tabella viene **negato**
anziché lasciato passare. La leva del Proxy — «aggiungere un handler o un tool non può
aprire un buco» — diventa vera invece che quasi vera.

L'inversione è sicura solo dopo che la tabella è completa: da sola romperebbe ogni
chiamante di un metodo non ancora elencato. È il motivo del blocco.

L'accesso diretto al driver da parte del motore di backup resta come è: è dichiarato e
autorizzato a parte sull'intera connessione.

**Bloccato da:** 08.

**Status:** done

- [x] Un metodo privo di voce viene rifiutato con un errore parlante
- [x] Un test dimostra il rifiuto e **fallisce prima** dell'inversione
- [x] Il motore di backup continua a funzionare, provato dai suoi test end-to-end
- [x] I test di autorizzazione, quelli del gateway e quelli end-to-end passano invariati

## Che cosa è stato fatto

`auth/guardStrategy.js` distingue ora tre casi invece di due:

1. **non è una funzione** (`type`, `currentDb`, `client`, `pool`): passa. È da
   qui che il motore di backup prende il driver nativo, ed è autorizzato a
   parte sull'intera connessione (`canWholeConnection`);
2. **ha una voce che dichiara `cap: null`**: passa, e il *perché* è scritto
   nella voce (`spec.motivo`);
3. **non ha alcuna voce**: **negato**, con un errore che nomina il metodo e dice
   dove si dichiara.

Root non è un'eccezione, e vale la pena dirlo: `can()` gli concede tutto, ma qui
non c'è niente da concedere — c'è una regola che manca.

L'inversione è sicura perché la tabella è completa (ticket 08) **e resta
completa**: `test/unit-tabella-autorizzazioni.js` confronta le chiavi della
tabella con i prototipi veri delle tre strategie, quindi aggiungere un metodo a
un adattatore rompe quel test *prima* che qualcuno arrivi a chiamarlo. Le due
cose insieme sono la leva: senza il test statico l'inversione sarebbe solo un
modo diverso di rompersi.

**Una conseguenza da conoscere.** Il rifiuto viene **lanciato**, non restituito
come promise rigettata: per un metodo senza voce non si sa se sia sincrono o
asincrono, e le voci esistenti lo dichiarano con `sync`. Un chiamante scritto
come `strategy.metodoNuovo().catch(…)` vedrebbe quindi un'eccezione invece di un
rifiuto. È accettabile perché per costruzione quel percorso è irraggiungibile —
il test statico impedisce che un metodo arrivi in produzione senza voce — e
perché un errore rumoroso è esattamente ciò che si vuole in quel punto.

## Come è stato provato

Cinque prove aggiunte a `test/unit-tabella-autorizzazioni.js`: il rifiuto di un
metodo non classificato (anche a root), il messaggio che nomina il metodo e
indica `METHOD_CAPABILITY`, il passaggio di una voce dichiaratamente fuori dai
dati (`cancelQuery`), il passaggio delle proprietà (il `pool` che serve al
backup), e il fatto che i metodi classificati continuino a funzionare — perché
il rifiuto non diventi la risposta a tutto.

**Le prove falliscono prima dell'inversione**, come chiede il ticket:
rimettendo il vecchio comportamento («ciò che non si trova passa»), le due
prove sul rifiuto falliscono; ripristinato il file, zero fallimenti.

Eseguiti: `npm test` (esito 0), `test/e2e-rbac.js` e `test/e2e-rbac-mcp.js`
(entrambi completati), `test/e2e-mcp.js` (tutti superati), `test/e2e-backup.js`
(tutti superati — è la prova che l'accesso diretto al driver da parte del motore
di backup continua a funzionare), `test/e2e.js` su MongoDB (**4 fallimenti, gli
stessi 4 che si hanno con le modifiche messe da parte**: preesistenti).

**Non eseguiti, e va detto**: gli E2E di MySQL e PostgreSQL, e
`e2e-backup-mysql.js`. PostgreSQL non è in ascolto su questa macchina e MySQL
rifiuta l'utente `root` senza password che l'harness richiede. Il backup MySQL
usa gli stessi accessi al driver (`strategy.pool`) provati dal backup MongoDB
(`strategy.client`), che è il percorso che questa inversione poteva rompere.


---

## Verifica E2E sui due motori SQL — eseguita

Al momento della prima stesura MySQL e PostgreSQL non erano raggiungibili su
questa macchina. Sono poi stati avviati due container **dedicati e usa-e-getta**
(MySQL 8 su 3307, PostgreSQL 16 su 5433), che non toccano le istanze di altri
progetti presenti sulle porte consuete. Con quelli:

| suite | esito |
|---|---|
| `test/e2e-mysql.js` | 2 fallimenti — **gli stessi 2 anche senza queste modifiche** (misurato con `git stash`): preesistenti, riguardano la rinomina non atomica di un database |
| `test/e2e-postgres.js` | 3 fallimenti — **gli stessi 3 anche senza queste modifiche**: preesistenti, riguardano le FK fra schemi diversi |
| `test/e2e-backup-mysql.js` | tutti superati |
| `test/e2e-tetto-scrittura.js` | tutti superati (MySQL **e** PostgreSQL) |
| `test/e2e-tipi-mysql.js` | tutti superati |
| `test/e2e-collazione-mysql.js` | tutti superati |
| `test/e2e-query-engine.js` | tutti superati |
| `test/e2e-dbexport.js` | tutti superati |
| `test/e2e-sessions.js` | tutti superati |
| `test/e2e-script-risultati.js` | tutti superati |
| `test/e2e-mcp-mysql.js` | 1 fallimento — **lo stesso anche senza queste modifiche**: preesistente |
| `test/e2e-script-schede-ui.js` | fallisce all'apertura della modale — **identico anche senza queste modifiche**: preesistente |

**Nessun fallimento nuovo introdotto da queste modifiche**, su nessuna suite.
