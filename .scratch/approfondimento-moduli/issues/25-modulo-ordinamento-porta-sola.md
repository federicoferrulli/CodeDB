# 25: Il modulo tabellare espone una porta sola

**Cosa costruire:** comporre un frammento SQL per un motore usando le regole di
quotatura di un altro non è più esprimibile, perché le funzioni del modulo
comune non sono più raggiungibili se non legate al loro dialetto.

Oggi il modulo esporta sia la funzione che lega il dialetto sia le quattro
funzioni crude. Le crude accettano qualunque regola di quotatura: chiedere
l'ordinamento di una griglia MySQL passando le regole di PostgreSQL produce
`ORDER BY "nome" ASC` senza che nulla protesti — provato. Non è una via di fuga
per il motore che deve divergere (danno esattamente ciò che dà il metodo della
strategia, non un grammo di più): è solo la possibilità di accoppiarle male, e
la riconciliazione dei metodi gemelli ne verserà altre lì dentro.

La correzione è una **cancellazione**, non una guardia in più: si toglie dalla
superficie pubblica ciò che serviva solo alla prova, e la prova passa dalla
stessa porta della produzione — cosa che già fa nella sua ultima sezione.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** done

- [x] Il modulo comune espone soltanto la funzione che lega un dialetto; le funzioni crude non sono più importabili
- [x] I test del modulo esercitano le funzioni attraverso il dialetto legato, non crude, e restano altrettanto specifici sulle differenze fra i due motori
- [x] Nessun chiamante fuori dai test usava le funzioni crude: verificato, non supposto
- [x] La suite unitaria e i test end-to-end dei due motori SQL passano invariati

## Che cosa è stato fatto

Una cancellazione, come chiedeva il ticket: `db/sqlTabellare.js` esporta ora
`{ tabellare }` e basta. Le quattro funzioni crude restano nel file, non
esportate, con scritto accanto **perché** non lo sono — che è la parte che
serve a chi le ritroverà fra sei mesi e si chiederà se sia una dimenticanza.

**Verificato, non supposto**: `grep` su tutto il repo (escluso `node_modules`)
per `componiIdRiga|leggiIdRiga|componiOrdinamento|componiSelezione` non trova
più alcuna occorrenza fuori da `db/sqlTabellare.js`. Prima dell'intervento le
uniche erano in `test/unit-sql-tabellare.js`.

## Il test passa dalla porta della produzione

Le quattro sezioni del test usavano le funzioni crude passando il `qid` a mano.
Non era solo una porta in più: era una porta **che la produzione non ha**, e
provare da lì significa provare un'altra cosa — l'accoppiamento «ordinamento di
MySQL con le regole di PostgreSQL» che il ticket descrive è esattamente ciò che
il test poteva esprimere e il codice vero no.

Ora il test lega i due dialetti una volta sola in cima (`my`, `pg`) e chiama
`makeId`, `parseRowId`, `buildOrderBy`, `buildSelect`. **Resta altrettanto
specifico sulle differenze fra i due motori**: il backtick contro le virgolette
nell'`ORDER BY`, `<=> ?` contro `= $1` nel WHERE, la qualificazione della
tabella. Un solo caso ha cambiato forma — la data in Extended JSON, che prima
si guardava nell'oggetto decodificato passando `(id) => id` come dialetto finto,
e ora si guarda nel **parametro**, cioè in ciò che il driver riceve davvero.

C'è inoltre una prova nuova che la porta resti una sola: confronta le chiavi
esportate con `['tabellare']`.

## Come è stato provato

`node test/unit-sql-tabellare.js`: tutte le sezioni superate.

**Sensibilità verificata rompendo il codice di proposito**: rimettendo
`componiOrdinamento` fra le esportazioni, la prova sulla porta sola fallisce
citando per esteso il difetto che impedisce; ripristinato il file, esito 0.

`npm test` passa (esito 0).

**Non eseguiti, e va detto**: `test/e2e-mysql.js` e `test/e2e-postgres.js`. Su
questa macchina PostgreSQL non è in ascolto su 5432 e MySQL rifiuta l'utente
`root` senza password richiesto dall'harness (le istanze Docker presenti sulle
stesse porte appartengono ad altri progetti). Va però detto che questo ticket
**non tocca una riga di codice eseguito**: cambia solo quali nomi il modulo
esporta, e il controllo statico già presente nel test verifica che i due
adattatori continuino a prendere il tabellare da qui.


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
