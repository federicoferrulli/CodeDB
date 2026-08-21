# 06: Migrare i chiamanti alla regola unica e rimuovere le copie (contrai)

**Cosa costruire:** tutti i punti che oggi decidono da sé come scrivere un identificatore
chiamano il modulo condiviso, e le copie sparse non esistono più.

I chiamanti sono sette: i due adattatori SQL, il modulo DDL di PostgreSQL, il motore dei
JOIN virtuali, la selezione di celle del frontend, il vocabolario dei dialetti, e il motore
di backup.

**Bloccato da:** 05.

**Status:** done

- [x] Ogni chiamante usa il modulo condiviso
- [x] Nessuna copia della regola sopravvive nel repo, verificato con una ricerca
- [x] Un test copre il caso del nome con maiuscole su PostgreSQL attraverso almeno due chiamanti diversi
- [x] I test end-to-end dei tre motori e quelli di backup passano invariati

## Che cosa è stato fatto

I sette chiamanti previsti sono migrati, e ne sono emersi **due in più** che il
ticket non elencava ma che decidevano la stessa cosa da sé:

| chiamante | prima | ora |
|---|---|---|
| `db/MySqlStrategy.js` | `mysql.escapeId(name, true)` | `quotaSempre(name, 'mysql')` |
| `db/PostgreSqlStrategy.js` | `'"' + … + '"'` a mano | `quotaSempre` / `quotaQualificato` |
| `db/pg-ddl.js` | idem, terza copia | `quotaSempre` |
| `db/VirtualJoinEngine.js` | un `qid` che sceglieva l'apice con `includes('postgres')` | `quotaSempre(name, type)` |
| `public/js/cellselect.js` | apice scelto a mano + `split/join` | `quotaSempre` / `quotaQualificato` |
| `public/js/sql-dialetti.js` | la sola copia che sapeva *se* quotare | ri-esporta il modulo (fatto nella 05) |
| `backup/lib/engine.js` | `pgQid` a mano + 10 `mysql.escapeId` | `quotaSempre`, via `pgQid`/`myQid` |
| **`backup/lib/restore.js`** *(non elencato)* | 4 `mysql.escapeId` e un raddoppio del backtick scritto a mano nella riqualificazione delle DDL | `myQid` |
| **`public/js/query-tab.js`** *(non elencato)* | backtick MySQL scritti a mano nell'export `.sql` dei risultati | `quotaSempre` col motore in uso |

Sull'ultimo vale la pena essere espliciti, perché è l'unico punto in cui il
**comportamento cambia**: l'export `.sql` dei risultati della tab ⚡ scriveva i
nomi di colonna fra backtick qualunque fosse il motore, cioè produceva uno
script non eseguibile su PostgreSQL. È lo stesso difetto che il commento
immediatamente sopra, in quello stesso file, dichiara di aver già corretto per
gli **apici dei valori** (dove la barra rovesciata è un'estensione MySQL e lo
standard è il raddoppio): la quotatura dei nomi era rimasta indietro. Ora il
motore è quello che sceglie anche il completamento automatico.

Gli adattatori, il DDL, il backup e i JOIN virtuali usano `quotaSempre`: quotano
sempre come facevano prima, quindi il loro SQL non cambia di un carattere.

## Come è stato provato, e che cosa NON copre

`test/unit-identificatori.js` cresce di sei prove:

* **quattro chiamanti diversi**, non due: il nome `Prova` arriva quotato fino
  in fondo attraverso l'adattatore PostgreSQL (`"diego"."Prova"`), il DDL di
  PostgreSQL, i JOIN virtuali (con strategie finte che registrano la query
  composta) e — per contrasto — l'adattatore MySQL, dove `Prova` prende il
  backtick e non il doppio apice;
* un **controllo statico** che rilegge `db/`, `backup/`, `mcp/`, `auth/`,
  `public/js/` e `server.js` cercando le forme che le copie avevano davvero.
  Dichiara anche ciò che non sa vedere: riconosce il raddoppio del backtick,
  `mysql.escapeId` e lo `split(apice).join(…)`, ma una copia scritta in una
  forma nuova gli sfugge. Le tre occorrenze di raddoppio del doppio apice che
  restano nel repo sono **CSV** (RFC 4180, un'altra regola) e sono elencate nel
  test una per una, così una quarta si fa notare;
* un controllo che ognuno dei nove chiamanti passi davvero dal modulo.

**Sensibilità verificata rompendo il codice di proposito**: rimettendo in
`db/pg-ddl.js` la vecchia riga scritta a mano, il controllo statico fallisce
nominando il file; ripristinato, zero fallimenti.

`npm test` passa (codice di uscita 0).

**Non provato, e va detto.** I test E2E dei tre motori non sono stati eseguiti:
PostgreSQL non è in ascolto su questa macchina e MySQL rifiuta l'accesso
all'utente `root` senza password che l'harness richiede. Quello di MongoDB è
stato eseguito e riporta **4 fallimenti — gli stessi 4, identici, anche con le
modifiche messe da parte** (verificato con `git stash`): sono preesistenti e non
riguardano questo lotto, che su MongoDB non tocca nulla. Restano quindi non
verificati sul campo il backup MySQL, il ripristino MySQL e le DDL PostgreSQL;
per questi valgono i test unitari e il fatto che le funzioni sostituite siano
carattere per carattere equivalenti a quelle di prima.


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
