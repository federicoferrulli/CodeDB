# Copertura dei linguaggi Query e Aggregate

Verifica della versione 0.2.1-beta.1, aggiornata il 15 ottobre 2026.

**Architettura scelta per i dialetti completi: motori SQL nativi.** PostgreSQL
viene eseguito da PostgreSQL e MySQL da MySQL, sui rispettivi dati autorevoli.
Il menu del bersaglio apre una copia della query sulla connessione SQL scelta;
non trasferisce automaticamente dati da MongoDB. Sono disponibili avvio locale
con volumi persistenti, sessioni SQL conservate, recupero nativo dai savepoint
e risultati senza perdita di precisione. Vedi [configurazione e comportamento
del percorso nativo](sql-nativo.md).

Il [controllo qualità successivo e le regressioni](../test-reports/query-languages/quality-risoluzione.md)
verificano anche la destinazione dopo rollback/savepoint/USE, la perdita e il
recupero delle connessioni SQL e il rilascio delle sessioni attraverso i proxy.

Il successivo [audit approfondito SQL/MQL](../test-reports/query-languages/quality-audit-completo.md)
include anche stato transazionale nativo, diagnostica MySQL, instradamento,
escape Unicode, campi BSON e consumo dei cursori. Gli script MQL leggono oltre
la pagina predefinita della griglia: il budget di 10.000 documenti per lettura
produce un errore esplicito se superato; una lettura troncata per righe o byte
non viene consegnata alle istruzioni successive. `limit()` e `$limit` restano
disponibili per restringere intenzionalmente i risultati. Il conteggio scaduto
non viene convertito in zero.

Le limitazioni SQL→MongoDB elencate in questo documento descrivono il traduttore,
non il percorso nativo. Le prove native includono CAST, tipi estesi, domini,
dipendenze ALTER/CASCADE, trigger con transizioni e INSTEAD OF, procedure e
diagnostica, cursori, handler, SQL dinamico, scritture JOIN, INTERSECT/EXCEPT,
INSERT SELECT, CTE, funzioni finestra ed errori reali con savepoint. Non costituiscono
una certificazione di ogni versione o estensione dei due DBMS.

Il catalogo dell’editor copre tutte le keyword esposte dai server verificati:
**734/734 per MySQL 8.4.11 e 494/494 per PostgreSQL 18.6**. Questa verifica
non certifica una traduzione integrale dei due linguaggi SQL in MongoDB.
SQL nativo, MQL e interprete della shell seguono percorsi distinti.

| Percorso | Copertura verificata | Confine |
| --- | --- | --- |
| MySQL nativo | Catalogo keyword completo rispetto a `INFORMATION_SCHEMA.KEYWORDS`; SQL originale trasmesso al driver | Sintassi e funzioni dipendono dal server; rimangono i controlli RBAC, scope e I/O |
| PostgreSQL nativo | Catalogo keyword completo rispetto a `pg_get_keywords()`; SQL originale trasmesso al driver | Le estensioni, compreso PostGIS, devono essere installate sul server |
| MQL documenti e pipeline | Operatoristica trasmessa al driver senza una whitelist basata sul catalogo dell’editor; tipi BSON preservati | Il server decide disponibilità e validità degli operatori; `$where`, `$function` e `$accumulator` restano vietati |
| Shell MongoDB controllata | Comandi nativi, sessioni e transazioni, CRUD, indici, metadati, cursori, cicli e funzioni controllate | Interprete con RBAC per operazione; variabili limitate al run |
| mongosh nativo | Runtime e helper ufficiali, Node.js, moduli e file, variabili/sessioni/cursori fra esecuzioni, change stream live | Amministratore dell'installazione; privilegi MongoDB nativi; stato legato alla connessione |
| SQL su MongoDB | Traduzione del sottoinsieme descritto sotto, con prove su MongoDB 8.0 | Non sostituisce un motore SQL MySQL o PostgreSQL |

## Editor e conservazione del testo

`query-cataloghi.mjs` contiene anche 343 nomi di funzioni MySQL e 621 PostgreSQL
estratti dalle fonti indicate nel file. Sono cataloghi documentali, non una
certificazione di tutte le funzioni interne o installate mediante estensioni.
Per MongoDB contiene 151 espressioni, 47 stadi, 30 operatori di filtro,
19 di aggiornamento, 25 accumulatori e 32 operatori finestra; gli insiemi
si sovrappongono. La presenza nel catalogo non installa funzionalità Search.

Il formattatore e il minificatore conservano operatori composti, parametri,
commenti eseguibili MySQL, stringhe PostgreSQL concatenate tramite a capo
e differenze fra commenti e operatori (`#`, `--`). Le prove attraversano tutte
le keyword, tutte le funzioni suggerite e tutti gli operatori MQL nominali
del catalogo. Gli alias e le parole usate come nomi mantengono la loro grafia.

## SQL traducibile in MongoDB

- `SELECT` anche senza `FROM`, colonne e alias, espressioni aritmetiche, `CASE`, `CAST` nei tipi
  gestiti, `DISTINCT` anche sull’intero documento prima di ordinamento e limite.
- Ottantatré funzioni scalari nel registro condiviso `sql-mongo-funzioni.mjs`:
  numeriche, trigonometriche, stringhe, gestione dei null, componenti delle date
  e istante corrente. Lo stesso registro alimenta editor e traduttore.
- Predicati fra colonne ed espressioni, parentesi, `AND`, `OR`, `NOT`,
  `IN`, `BETWEEN`, `LIKE`, `ILIKE`, `IS NULL`, `IS TRUE`, `IS FALSE` e
  `IS [NOT] DISTINCT FROM`, inclusi i confronti con NULL.
  La negazione e le espressioni rispettano il valore sconosciuto dei null.
- `WITH` e `WITH RECURSIVE`, anche con elenco dei nomi di colonna; derived table nella `FROM` e nelle
  JOIN; `INNER`, `LEFT`, `RIGHT`, `FULL OUTER`, `CROSS JOIN`, `USING`, condizioni `ON` multiple
  e confronti diversi dall’uguaglianza. I null non si uniscono per uguaglianza.
- `GROUP BY` su colonne, espressioni, alias e posizioni; `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `RANGE_AGG`, `RANGE_INTERSECT_AGG`
  su espressioni, anche con `DISTINCT` e `FILTER (WHERE ...)`. Gli aggregati possono stare
  dentro espressioni e CASE; HAVING usa la stessa algebra di predicati della WHERE.
  Sono gestiti `UNION` e `UNION ALL`, `ORDER BY` su espressioni, alias e posizioni,
  `LIMIT` e `OFFSET`. UNION associa le colonne delle proiezioni esplicite per posizione, applica la deduplicazione
  a ogni operatore DISTINCT e applica l’ordinamento finale all’unione completa.
  `NULLS FIRST/LAST` è gestito esplicitamente. SUM su valori tutti NULL restituisce NULL;
  gli aggregati senza GROUP BY restituiscono una riga anche quando l’input è vuoto.
- Diciotto funzioni con `OVER`: `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `PERCENT_RANK`,
  `CUME_DIST`, `NTILE`, `LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE`,
  `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `RANGE_AGG`, `RANGE_INTERSECT_AGG`. Il registro è condiviso con IntelliSense.
  Sono gestiti PARTITION BY, ordinamenti multipli, finestre nominate con WINDOW,
  frame ROWS/RANGE/GROUPS, EXCLUDE CURRENT ROW/GROUP/TIES/NO OTHERS e
  aggregati di gruppo come argomenti delle finestre dopo HAVING. FILTER è disponibile
  anche sugli aggregati finestra; una finestra può comparire direttamente nella ORDER BY.
- Sottoquery scalari, `EXISTS`/`NOT EXISTS`, `IN`/`NOT IN`, confronti `ANY`/`SOME`/`ALL`,
  anche correlate con riferimenti qualificati e su più livelli. Sono verificate in SELECT,
  WHERE, HAVING, ORDER BY e negli argomenti degli aggregati. Una sottoquery scalare vuota
  produce NULL, una con più righe produce errore. IN/ANY/ALL distinguono insieme vuoto
  e valori NULL. I nomi interni non sovrascrivono i documenti; tutte le collezioni
  lette, anche da RETURNING, vengono sottoposte ai controlli RBAC.
- `INSERT ... VALUES`, `UPDATE` anche con espressioni nella `SET`, `DELETE`,
  `TRUNCATE`, creazione/eliminazione di database e collezioni, `CREATE [UNIQUE]
  INDEX` e `DROP INDEX nome ON collezione`. INSERT, UPDATE e DELETE supportano
  `RETURNING *`, colonne, alias ed espressioni scalari.
- `UPDATE` e `DELETE` con `ORDER BY` e `LIMIT`, compreso limite zero e combinazione
  con RETURNING. `INSERT ... ON CONFLICT [(colonne)] DO NOTHING`,
  `ON CONFLICT (colonne) DO UPDATE SET ... [WHERE ...]` con `excluded.colonna` e
  `ON DUPLICATE KEY UPDATE` con `VALUES(colonna)`. Le assegnazioni di ON CONFLICT
  sono simultanee; quelle di ON DUPLICATE KEY UPDATE sono sequenziali, come nei
  rispettivi motori di riferimento.
- `INTERSECT` e `EXCEPT`, con `ALL` oppure deduplicazione, NULL, associazione
  posizionale delle colonne e parentesi. INTERSECT ha precedenza maggiore di
  UNION/EXCEPT. Le proiezioni devono dichiarare esplicitamente le colonne.
- `INSERT ... SELECT`, anche con operatori insiemistici; `UPDATE ... FROM`,
  `UPDATE ... JOIN`, `DELETE ... USING`, `DELETE alias FROM ... JOIN` e sottoquery
  scalari nelle assegnazioni. Il bersaglio è una sola tabella; corrispondenze
  multiple della JOIN non provocano aggiornamenti ripetuti della stessa riga.
- `CREATE TABLE` con tipi, DEFAULT, NOT NULL, PRIMARY KEY, UNIQUE e CHECK,
  anche vincoli nominati e chiavi composte. Le tabelle con schema ammettono
  INSERT senza elenco di colonne, DEFAULT nei valori e DEFAULT VALUES.
- `ALTER TABLE` con ADD/DROP/RENAME COLUMN, ALTER COLUMN TYPE e USING,
  SET/DROP DEFAULT, SET/DROP NOT NULL, MODIFY/CHANGE COLUMN e aggiunta/rimozione
  di vincoli. Le migrazioni verificano i dati preesistenti e hanno un registro
  persistente per il recupero dopo un'interruzione.
  Sono gestiti anche ADD COLUMN IF NOT EXISTS, SET DATA TYPE ... USING,
  RENAME CONSTRAINT, RENAME INDEX/KEY (anche indici espliciti) e DROP CHECK.
  La rinomina aggiorna FK e indici dipendenti; DROP COLUMN/CONSTRAINT CASCADE
  rimuove le dipendenze coperte dal catalogo, comprese FK autoriferite.
- Trigger `BEFORE/AFTER INSERT/UPDATE/DELETE ... FOR EACH ROW` su SQL, CRUD
  MQL, griglia, import e cascate FK, con OLD/NEW, corpi singoli o BEGIN/END e
  rollback. BEFORE INSERT/UPDATE può assegnare NEW; OLD resta di sola lettura.
  Disponibili WHEN, eventi multipli con OR e ordine esplicito FOLLOWS/PRECEDES.
  UPDATE OF seleziona le colonne assegnate, anche senza variazione del valore.
- `CREATE [OR REPLACE] PROCEDURE`, `DROP PROCEDURE` e `CALL`, con parametri IN,
  corpi BEGIN/END oppure dollar-quoted, istruzioni DML/SELECT, DECLARE, SET,
  assegnazione `:=`, IF/ELSIF/ELSEIF/ELSE, WHILE, LOOP, REPEAT/UNTIL,
  EXIT/CONTINUE WHEN, RETURN, SIGNAL/RAISE EXCEPTION e CALL annidate.
  Cursori dichiarati con SELECT, OPEN/FETCH NEXT/CLOSE, FOUND per FETCH in
  PL/pgSQL e handler MySQL CONTINUE/EXIT per NOT FOUND, SQLSTATE, condizioni
  nominate con DECLARE CONDITION, SQLWARNING e SQLEXCEPTION sulle condizioni
  procedurali. Sono gestiti SIGNAL e RESIGNAL, anche fra CALL annidate.
  Sono gestiti i formati SQL e i costrutti
  PL/pgSQL elencati, non tutto il linguaggio delle procedure dei due server.

Una scrittura viene eseguita solo dopo aver consumato l’intera istruzione:
clausole finali non tradotte e virgolette non chiuse producono un errore prima
di accedere al database. `DELETE ... LIMIT 1` seleziona e cancella al massimo
una riga nella stessa transazione.

### Esecuzione dei costrutti avanzati

RIGHT/FULL JOIN usano un ramo anti-join per le righe destre senza corrispondenza,
conservando duplicati, filtri delle CTE e JOIN precedenti. Le colonne proiettate
del lato assente diventano NULL. Con USING il campo non qualificato è coalescente;
i campi qualificati dei due lati conservano il proprio valore o NULL.

Le finestre sono calcolate da aggregazioni MongoDB, senza `$function` o eval.
I frame ROWS più comuni usano accumulatori nativi; ranghi e frame con peer complessi
usano array della partizione. Questi ultimi restano soggetti ai limiti di memoria
e dimensione dei documenti MongoDB e possono costare più di una finestra nativa SQL.
L’offset di LAG/LEAD, l’indice di NTH_VALUE e il numero di gruppi NTILE devono
essere interi costanti. RANGE con offset richiede una sola chiave numerica;
gli intervalli temporali SQL non sono tradotti. Le finestre sono ammesse nella
SELECT, anche dentro espressioni; per ordinarle si può usare l’alias nella ORDER BY.
La semantica di riferimento dei peer e dei frame è descritta nella
[documentazione PostgreSQL](https://www.postgresql.org/docs/18/functions-window.html).

Le CTE ricorsive eseguono il termine iniziale e poi il termine ricorsivo sul solo
delta dell’iterazione precedente. UNION elimina anche i duplicati già visitati;
UNION ALL li conserva. Il formato gestito è un termine iniziale UNION [ALL] un
termine ricorsivo, con colonne di output esplicite. Il limite predefinito è di
1000 iterazioni (`CODEDB_SQL_RECURSION_LIMIT`); si applicano inoltre il timeout,
l’annullamento e i budget di byte. Ogni CTE materializzata ha un tetto di 12 MiB
per lasciare spazio nel comando BSON; il piano completo e la memoria complessiva
sono controllati separatamente. Un superamento produce un errore, non risultati
parziali. Non vengono create collezioni temporanee. Sui replica set e sui cluster
le letture delle iterazioni usano uno snapshot; sugli standalone mantengono la
consistenza delle singole letture MongoDB. Tutte le sorgenti fisiche, anche nel
termine ricorsivo, vengono autorizzate prima dell’esecuzione.

RETURNING esegue mutazione e lettura del risultato nella stessa transazione:
INSERT/UPDATE restituiscono i valori nuovi, DELETE quelli precedenti. Errori
nella proiezione, limiti e annullamento prima del commit causano rollback.
Sono richiesti sia il permesso di lettura sia quello della mutazione.
**Richiede un replica set o un cluster MongoDB con transazioni**: uno standalone
non offre una transazione atomica su più documenti, quindi il comando viene
rifiutato prima di scrivere. Questo requisito deriva dal
[modello transazionale MongoDB](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/).

Le scritture con LIMIT e gestione dei conflitti richiedono la stessa garanzia
transazionale. I conflitti usano gli indici univoci reali: un ON CONFLICT con
bersaglio senza indice univoco viene rifiutato prima della mutazione. Sono gestiti
indici ordinari, anche composti, e gli indici parziali generati dagli UNIQUE
dello schema SQL. Altri indici parziali, sparse e chiavi speciali non sono
emulati. Nelle collezioni libere la semantica dei valori mancanti/NULL resta quella
MongoDB, non quella dei vincoli UNIQUE SQL. Il controllo delle collisioni viene
ripetuto dopo una transazione abortita per inserimento concorrente; gli esiti
incerti del commit non vengono rieseguiti come nuove scritture.

Le sottoquery sono pipeline `$lookup`, senza JavaScript remoto. EXISTS evita
la proiezione non necessaria nelle SELECT semplici senza OFFSET; combinazioni
con HAVING, UNION, DISTINCT/OFFSET conservano ancora parti del piano completo
e non hanno una garanzia generale di eliminazione delle espressioni inutilizzate.
Gli array dei risultati intermedi rimangono soggetti ai limiti BSON di MongoDB.
I casi con NULL seguono le regole delle
[espressioni di sottoquery SQL](https://www.postgresql.org/docs/18/functions-subquery.html).

### Insiemi, sorgenti delle scritture e schema SQL

INTERSECT/EXCEPT contano le molteplicità e associano le colonne per posizione.
Sono provati duplicati, NULL, precedenza, parentesi e insiemi vuoti, secondo le
[regole PostgreSQL](https://www.postgresql.org/docs/18/queries-union.html).
INSERT SELECT e scritture con JOIN leggono e modificano nello stesso snapshot.
I rami UNION principali vengono materializzati con cap di righe/byte quando
MongoDB non consente `$unionWith` nella transazione. Le UNION annidate in
`$lookup` dentro una scrittura non hanno ancora questo adattamento.

Lo schema di CREATE TABLE è persistito nel validatore della collezione.
NOT NULL, intervalli degli interi, lunghezze testuali e CHECK sono applicati
da validatori nativi; PRIMARY KEY e UNIQUE da indici reali. UNIQUE esclude
i NULL tramite un indice parziale, anche nelle chiavi composte. I controlli
valgono anche per MQL/driver senza bypass della validazione; DEFAULT e
conversioni di assegnazione appartengono invece al percorso SQL. Riferimenti:
[validazione MongoDB](https://www.mongodb.com/docs/manual/core/schema-validation/specify-query-expression-rules/)
e [indici parziali](https://www.mongodb.com/docs/manual/core/index-partial/).

Sono rappresentati TINYINT, SMALLINT, INT, BIGINT, DECIMAL(p,s) con precisione
massima 34, REAL/DOUBLE, TEXT/VARCHAR/CHAR, BOOLEAN, DATE/TIMESTAMP, UUID e JSON,
con gli alias dichiarati dal parser. Sono disponibili anche ENUM testuali e
TINYINT/SMALLINT/INT/BIGINT UNSIGNED: il massimo 18446744073709551615 resta
esatto usando Decimal128. I DEFAULT sono verificati anche quando la tabella
è vuota. Non sono emulate la conversione degli ENUM in ordinali e le relative
regole MySQL di ordinamento/collazione. BIGINT e letterali decimali estesi non
passano da un Number arrotondato; gli interi BSON oltre 2^53 restano Extended
JSON nel trasporto. Le assegnazioni intere/decimali arrotondano i pareggi
allontanandosi da zero. Testo JSON invalido in INSERT/UPDATE fallisce prima
del commit. Le prove includono UUID confrontato con CHAR(36) su MySQL e
booleani MySQL normalizzati. REAL non impone la precisione float32, CHAR non
emula il padding, JSON null e SQL NULL non hanno rappresentazioni distinte,
DATE/TIMESTAMP usano BSON Date in UTC e precisione in millisecondi. Non sono
replicati tutti gli attributi, le conversioni implicite e le collazioni SQL.
Il campo `_id` conserva unicità e immutabilità native di MongoDB; una PRIMARY
KEY SQL su `_id` riutilizza l’indice già esistente. Una stringa JSON già tipizzata
proveniente da SELECT o da una colonna richiede ancora la propagazione completa
del tipo dell’espressione, distinta dalla conversione di testo SQL in JSON.

Sono disponibili anche BYTEA, BINARY(n), VARBINARY(n) e TINYBLOB/BLOB/MEDIUMBLOB/
LONGBLOB, rappresentati come BSON Binary. I letterali `X'00ff'` conservano ogni
byte; BINARY aggiunge zeri a destra, VARBINARY conserva la lunghezza, i validatori
nativi applicano i limiti anche ai client esterni. Sono provati default,
parametri delle procedure, UPDATE, ALTER e trasporto socket EJSON. HEX e
OCTET_LENGTH leggono i binari; HEX è provato anche con UTF-8, NULL, numeri
negativi e interi a 64 bit. Non è ancora distinta la provenienza SQL di un
DECIMAL e di un intero UNSIGNED rappresentati entrambi come Decimal128 nei
casi di overflow delle conversioni. Mancano la sintassi bytea escape PostgreSQL
e tutte le conversioni binarie implicite del dialetto. Le conversioni binarie
richiedono MongoDB 8.0; valgono comunque i limiti BSON per documento.
Riferimenti: [conversioni MongoDB](https://www.mongodb.com/docs/v8.0/reference/operator/aggregation/convert/),
[BINARY e VARBINARY MySQL](https://dev.mysql.com/doc/refman/8.4/en/binary-varbinary.html).

FOREIGN KEY su tabelle create con schema SQL gestisce chiavi composte,
RESTRICT/NO ACTION immediati, ON UPDATE/DELETE CASCADE e SET NULL. Controlli
e cascata appartengono alla transazione della scrittura; un documento di coordinamento
impedisce il write skew fra scritture concorrenti con vincoli. Le tabelle
lette o modificate dalle cascata devono essere autorizzate. DROP TABLE di un
genitore riferito, TRUNCATE di un genitore e la rimozione isolata dell’indice
di un vincolo SQL vengono rifiutati.
Anche shell/script MQL CRUD (comprese pipeline di aggiornamento e upsert),
modifica/inserimento/cancellazione dalla griglia e import EJSON/BSON a blocchi
usano questi controlli. Il blocco importato viene annullato se viola una FK;
un bulkWrite della shell rimane una sequenza di operazioni separate.
**Le chiavi esterne non sono un vincolo nativo MongoDB**: client esterni,
materializzazioni `$out`/`$merge`, DDL native e percorsi di ripristino/promozione
non sono tutti intercettati. Non è certificata la concorrenza di ogni DDL con DML.
Le verifiche leggono le tabelle coinvolte e le scritture interessate si
coordinano a livello di database: costo e scalabilità non sono quelli di un
indice FK SQL. Non è una garanzia relazionale per ogni percorso dell’applicazione.

### Migrazioni ALTER TABLE

Il registro `_codedb_sql_migrations` conserva validatori e indici precedenti
e successivi. La conversione dei documenti e il marcatore di commit stanno
nella stessa transazione. Durante la migrazione un validatore impedisce
inserimenti/aggiornamenti esterni ordinari; le sostituzioni interne sono
autorizzate esplicitamente. Gli errori prima del commit ripristinano lo schema
precedente. Dopo il commit il recupero completa il nuovo schema: anche una
risposta persa viene distinta da un rollback. Ripetere lo stesso ALTER dopo
un'interruzione completa il recupero senza applicare due volte l'aggiunta.
Finché rimane un registro pendente, le scritture coordinate segnalano la
migrazione da recuperare; non utilizzano uno schema parzialmente installato.

Servono transazioni e permessi MongoDB per collMod, indici e bypass interno
della validazione. Valgono i limiti di righe, byte e tempo configurati; le
migrazioni oltre il budget falliscono con ripristino. La prova comprende errori
sulla seconda riga, interruzioni simulate prima/dopo il commit, risposta persa,
annullamento e concorrenza con sei scritture. Sono verificati anche tre arresti
reali dell'intero container primario (SIGKILL): dopo la barriera, dopo la prima riga
convertita e dopo il commit. Il replica set elegge un altro primario e il
recupero mantiene la conversione singola, gli indici e il registro coerenti.
Un quarto arresto durante un aggiornamento MQL con BEFORE/AFTER verifica che
il retry non duplichi dati o effetti dei trigger. Due ulteriori arresti durante
la rinomina di un indice, prima e dopo il commit, verificano nome e unicità.
Tre prove aggiunte arrestano il primario dopo la barriera di una tabella figlia,
dopo il commit della rinomina riferita da FK e durante il ripristino di un
savepoint. Verificano schemi coordinati, vincoli ancora attivi e audit non duplicati.
Altre tre prove arrestano il primario durante ALTER DOMAIN prima/dopo il commit
e dopo il commit di una rinomina con routine dipendente: cataloghi, validatori
delle tabelle coinvolte e corpo della routine restano coerenti al recupero.
La fixture usa tre container MongoDB 8.0, con processi e volumi distinti, sullo
stesso host Docker. Non prova guasti di macchine o dischi fisici separati,
partizioni di rete o sharding. Ogni operazione deve terminare mentre il nodo
arrestato è ancora spento; un watchdog di test lo ripristina dopo 20 secondi
soltanto per consentire il cleanup, dichiarando la prova fallita.
Le ricostruzioni degli indici delle migrazioni usano commitQuorum majority:
il quorum predefinito votingMembers si bloccava con un nodo assente. Il recupero
elimina prima i nomi obsoleti e poi ricrea quelli desiderati, evitando il
conflitto MongoDB fra indici identici con nomi diversi. Riferimento:
[quorum degli indici MongoDB](https://www.mongodb.com/docs/v8.0/reference/command/createindexes/).
Le letture esterne possono osservare
fasi diverse della DDL; amministratori con bypass e DDL esterne non partecipano
al coordinamento. Non è una DDL transazionale PostgreSQL generale.

Le rinomine delle colonne aggiornano i riferimenti delle FK, comprese quelle
autoriferite, e le chiavi, filtri parziali e proiezioni degli indici espliciti.
DROP COLUMN elimina gli indici dipendenti; CASCADE elimina le FK e i trigger
che riferiscono la colonna tramite OLD/NEW o UPDATE OF. La rinomina aggiorna
questi riferimenti nei trigger, che vengono ricompilati sul nuovo schema.
Validatori delle tabelle figlie e indici sono nel registro di recupero;
le modifiche ai trigger sono nella transazione dei dati. Occorre il permesso
DDL anche sulle tabelle dipendenti. Non vengono convertite automaticamente
le colonne delle altre tabelle: tipi FK incompatibili restano un errore.
Non sono ancora gestiti RENAME TABLE, dipendenze generali dentro query dei
corpi delle routine, viste, colonne generate, partizioni e tutte le opzioni
specifiche dei DBMS. La riscrittura OLD/NEW inline è una scelta di CodeDB,
non la riscrittura generale delle funzioni testuali PL/pgSQL.
MongoDB 8 non rivalida automaticamente le righe esistenti con collMod:
CodeDB le verifica nella migrazione.
Vedi [collMod e validazione](https://www.mongodb.com/docs/v8.0/reference/command/collMod/).

### Array, range e domini

Gli array dei tipi rappresentabili con base 1 sono conservati come array BSON,
inclusi NULL ed elementi numerici esatti. Gli altri usano il valore canonico
`{_sqlArray:true,lower:[...],values:[...]}`, verificato dal validatore nativo.
Sono disponibili costruttori `ARRAY[...]`,
tipi `INT[]`/`INT ARRAY` e analoghi, cast `::`/`CAST`, accesso agli elementi
con limiti inferiori anche negativi, `ANY/SOME/ALL`, contenimento e sovrapposizione e le funzioni array
del registro. I validatori nativi verificano tipo degli elementi, limiti,
rettangolarità e profondità massima di sei dimensioni. Le dimensioni nella
dichiarazione del tipo non impongono una lunghezza, come in PostgreSQL.
Procedure, trigger e conversioni ALTER mantengono gli array.
ARRAY_CAT e `||` gestiscono dimensioni uguali o differenti di uno, verificando
la forma del risultato; ARRAY_REPLACE attraversa anche gli array multidimensionali.
ARRAY_POSITION/REMOVE e APPEND/PREPEND rispettano i limiti dimensionali e gli
SQLSTATE verificati su PostgreSQL. I NULL negli array restano distinti dall'array NULL.
ARRAY_FILL e ARRAY_DIMS leggono/conservano dimensioni e limiti. Le slice gestiscono
estremi omessi, limiti parzialmente esterni, indici misti e risultati vuoti.
UPDATE assegna elementi e slice anche multidimensionali; l'estensione è ammessa
solo per array monodimensionali e riempie con NULL le celle intermedie, come
PostgreSQL. Le assegnazioni e ARRAY_FILL hanno un budget di un milione di elementi.
I letterali testuali con limiti espliciti funzionano nei cast costanti, INSERT,
UPDATE letterali, default e parametri. Routine, trigger e ALTER conservano i limiti.

`PRIMARY KEY`/`UNIQUE` su array confrontano il valore intero nella transazione
protetta dal lock SQL: un indice multikey MongoDB confronterebbe invece i singoli
elementi. **Questi vincoli sugli array non proteggono i client esterni** che
aggirano CodeDB. Il testo proveniente da colonne ed espressioni viene convertito
in array mediante un parser di espressioni MongoDB, senza JavaScript remoto.
Sono verificati dimensioni, limiti, escape, stringhe NULL distinte da NULL e
input malformati. La conversione inversa in TEXT conserva forma e limiti.
Indici numerici non interi e assegnazioni di slice da testo sono confrontati
con PostgreSQL. Restano tutte le coercizioni implicite dei letterali, le funzioni
non presenti nel registro e la parità testuale di tutti i tipi degli elementi.
Confronti, ORDER BY, finestre, MIN/MAX e GREATEST/LEAST usano chiavi SQL che
ordinano elementi, dimensioni e limiti. L'ordinamento richiede chiavi calcolate:
non mantiene automaticamente le prestazioni di un indice MongoDB sul campo.
Gli operatori JSON non sono reinterpretati come operatori array.
Riferimento: [array PostgreSQL](https://www.postgresql.org/docs/18/arrays.html).

`INT4RANGE`, `INT8RANGE`, `NUMRANGE`, `DATERANGE`, `TSRANGE` e `TSTZRANGE`
usano un documento BSON canonico con `_sqlRange`, `empty`, `lower`, `upper`,
`lowerInc`, `upperInc`. Sono disponibili costruttori, cast testuali, estremi
inclusi/esclusi o illimitati, range vuoti, `LOWER/UPPER`, `ISEMPTY`, funzioni
sugli estremi e operatori `@>`, `<@`, `&&`. Gli intervalli discreti diventano
`[lower,upper)`; il validatore nativo richiede la rappresentazione canonica,
anche nell'ordine dei campi, per rendere efficace UNIQUE sull'intero documento.
Il binding nelle routine conserva gli estremi. Sono disponibili i sei tipi
multirange corrispondenti, con `_sqlMultirange` e `ranges`, costruttori variadici,
cast testuali, MULTIRANGE, RANGE_MERGE, estremi e predicati. La normalizzazione
ordina, elimina gli intervalli vuoti e fonde componenti sovrapposte o adiacenti.
Gli operatori `+`, `-`, `*`, `<<`, `>>`, `&<`, `&>`, `-|-` e i confronti espliciti
sono confrontati con PostgreSQL. UNIQUE applica la rappresentazione canonica
intera anche tramite indice nativo. RANGE_AGG e RANGE_INTERSECT_AGG gestiscono
range e multirange, NULL, input vuoti, DISTINCT, FILTER, GROUP BY/HAVING e finestre.
ORDER BY confronta i limiti e le inclusioni; CAST in TEXT serializza range e
multirange canonici. Restano UNNEST, range definiti dall'utente, tutte le
conversioni/forme testuali e i valori temporali infinity. NUMRANGE conserva i limiti Decimal128 e i range temporali
la risoluzione in millisecondi di BSON Date. Non equivale ai timestamp PostgreSQL
in microsecondi o alla precisione arbitraria di NUMERIC.
Riferimento: [range PostgreSQL](https://www.postgresql.org/docs/18/rangetypes.html).

`CREATE DOMAIN`, domini derivati, DEFAULT, NOT NULL e CHECK su VALUE sono
persistiti in `_codedb_sql_domains`. `ALTER DOMAIN` gestisce default, nullabilità
e aggiunta/rimozione/rinomina di CHECK, verificando i dati preesistenti su tutte le tabelle
dipendenti. Catalogo e validatori partecipano al recupero della migrazione;
le definizioni di colonna esplicite restano distinte dai valori ereditati.
Le scritture native rispettano i validatori risultanti. I tipi dei parametri
sono verificati anche nelle routine con corpo testuale. `DROP DOMAIN CASCADE`
elimina domini derivati, colonne dipendenti, indici, vincoli, default/CHECK con
CAST e routine con firme o corpi BEGIN ATOMIC dipendenti, preservando le altre
colonne e le righe. Sono ammesse tabelle rimaste senza colonne SQL, come in
PostgreSQL. La migrazione di più tabelle usa il registro di recupero; prima
della modifica verifica il permesso DDL su tutte le dipendenze.
Una dipendenza nel DEFAULT di un altro dominio elimina quel dominio e le sue
dipendenze; una dipendenza nel suo CHECK elimina soltanto il vincolo. Le colonne
dei domini sopravvissuti conservano i dati e ricevono validatori ricompilati.
Anche i CAST nella condizione WHEN di un trigger impediscono DROP senza CASCADE;
CASCADE elimina il trigger dipendente, conservando la tabella.
ADD CHECK NOT VALID impone il vincolo alle nuove scritture
senza rifiutare i dati già presenti; VALIDATE CONSTRAINT verifica tutti i dati
dipendenti prima di aggiornare il catalogo. Un ALTER TYPE che converte valori
applica anche i CHECK NOT VALID: l'esenzione riguarda soltanto valori preesistenti
non convertiti. La verifica comprende gli array di
domini in CodeDB; PostgreSQL 18 rifiuta VALIDATE quando dipendenze di quel tipo
richiedono una scansione non supportata dal motore. CAST e :: risolvono il
catalogo per richiesta e applicano i CHECK ereditati, NOT NULL e i vincoli degli
elementi degli array; un array NULL resta distinto da un elemento NULL.
ALTER DOMAIN ricompila anche i CHECK di tabella con CAST dipendenti.
Restano rinomina del dominio, collazioni, CAST dei tipi base JSON/ENUM/UUID
e l'intera algebra dei domini composti. Questi CAST non supportati sono
rifiutati esplicitamente, per evitare di restituire valori non convertiti.
I CHECK dei domini si applicano al DEFAULT quando viene usato, non alla sua
definizione; la parità di tutte le conversioni non è dichiarata.
Negli array di domini, CHECK e NOT NULL si applicano agli elementi; il DEFAULT
scalare del dominio non diventa il default dell'intero array. ALTER DOMAIN
verifica anche questi dati e richiede il permesso DDL sulle tabelle coinvolte.
Riferimenti: [CREATE DOMAIN PostgreSQL](https://www.postgresql.org/docs/18/sql-createdomain.html)
e [DROP DOMAIN PostgreSQL](https://www.postgresql.org/docs/18/sql-dropdomain.html).

### Trigger

Le definizioni risiedono in `_codedb_sql_triggers`. I trigger BEFORE e AFTER
usano lo stesso interprete delle procedure e la stessa transazione della
scrittura SQL, MQL CRUD, griglia, import EJSON/BSON e cascate FK.
OLD/NEW mantengono le immagini della singola modifica anche negli
upsert successivi della stessa riga. UPDATE senza variazione del valore attiva
comunque il trigger. Errori e ricorsione oltre 32 chiamate annullano dati ed
effetti dei trigger; i permessi sono quelli correnti del chiamante.
ALTER TRIGGER ... ON ... RENAME TO conserva definizione, ordine esplicito e
stato abilitato/disabilitato, aggiornando il catalogo nella stessa transazione.
ALTER TABLE ENABLE/DISABLE TRIGGER gestisce il nome, USER e ALL quando non ci
sono FOREIGN KEY coinvolte. Stato e modifiche dello schema sono atomici; CREATE
OR REPLACE riattiva il trigger, come PostgreSQL. ALL con FK è rifiutato esplicitamente:
la sospensione dei trigger interni dei vincoli PostgreSQL non è implementata.

BEFORE può modificare NEW prima dei controlli del documento; OLD resta
immutabile. Le sue query vedono ancora la riga originale. Per gli aggiornamenti
MQL il server calcola l'immagine proposta nella raccolta interna
`_codedb_sql_trigger_stage`, nella stessa transazione: valgono gli operatori,
le pipeline, le variabili let e gli array posizionali del server. La riga
temporanea è rimossa prima del commit. I campi BSON non assegnati dal trigger
conservano i byte originali, anche tag storici e date oltre il range JavaScript.
Questo percorso richiede accesso del collegamento MongoDB alla raccolta interna
e aggiunge letture/scritture per riga; non ha il costo di un trigger SQL nativo.
Le opzioni di proiezione o salto della scrittura non possono nascondere OLD/NEW.

WHEN esegue il corpo soltanto se la condizione è TRUE; FALSE e NULL non lo
eseguono. Nei BEFORE legge NEW dopo gli eventuali trigger precedenti. Eventi
INSERT OR UPDATE OR DELETE possono condividere il corpo; nel corpo l'immagine
non disponibile diventa NULL, mentre WHEN rifiuta riferimenti non disponibili
per uno degli eventi. Le autorizzazioni del corpo sono verificate anche quando
la condizione è falsa. Sono provati SQL, MQL e import BSON.

FOLLOWS/PRECEDES richiede un trigger esistente della stessa tabella, fase ed
evento singolo. La posizione è persistita e sopravvive alla rimozione del
riferimento. Nei gruppi senza ordine esplicito resta l'ordine alfabetico
PostgreSQL; una volta assegnato un ordine esplicito, nuove definizioni senza
clausola vengono aggiunte in fondo. Non è ancora una modalità MySQL generale
per l'ordine di creazione, né una selezione coerente del dialetto per gruppi
che mescolano eventi multipli e ordinamento MySQL.

Le cascate attivano i trigger anche sui figli: è il comportamento PostgreSQL,
diverso da MySQL, dove le azioni delle FK non attivano i trigger. Manca una
selezione del dialetto per scegliere fra queste semantiche incompatibili.

Sono confrontati corpi MySQL e funzioni trigger equivalenti PostgreSQL: il parser
MongoDB accetta il corpo inline, non ancora CREATE FUNCTION ... RETURNS trigger
ed EXECUTE FUNCTION. UPDATE OF è verificato su SQL e CRUD MQL: conta il campo
assegnato, non una differenza OLD/NEW; i cambiamenti prodotti da un altro BEFORE
non aggiungono bersagli. Le sostituzioni MQL interessano tutti i campi; le
pipeline con replaceRoot/replaceWith/project sono considerate sostituzioni.
Sono disponibili anche BEFORE/AFTER `FOR EACH STATEMENT`, compreso il default
senza FOR, e TRUNCATE. I trigger di istruzione vengono eseguiti una volta anche
con zero righe interessate; OLD/NEW per riga non sono disponibili. I percorsi
CRUD MQL e griglia li eseguono per comando; gli import per blocco. Un bulk MQL
mantiene l'evento per la singola operazione. Mancano INSTEAD OF, RETURN NULL per
saltare una riga, transition tables e trigger differibili.
Client esterni, `$out`/`$merge`, DDL
native e ripristini/promozioni non sono tutti intercettati.
Non sono replicate tutte le regole dei due motori sulla visibilità delle altre righe di
una scrittura multipla. Array e range sono gestiti nel binding; i parametri
JSON/BSON documentali generali richiedono ancora estensioni. Riferimenti:
[trigger PostgreSQL](https://www.postgresql.org/docs/18/sql-createtrigger.html)
e [trigger MySQL](https://dev.mysql.com/doc/refman/8.4/en/trigger-syntax.html).

### Procedure

Le definizioni sono persistite in `_codedb_sql_procedures` e reinterpretate
alla CALL, senza eval o JavaScript sul server MongoDB. Ogni chiamata è una
transazione; le CALL annidate condividono sessione, timeout e budget, senza
commit intermedi. Errori, limiti e timeout annullano anche le istruzioni precedenti.
Tutti i rami sono autorizzati prima della prima scrittura e ogni istruzione
viene ricontrollata con il principal corrente. Non si ereditano privilegi del
definente. Servono un replica set e i permessi sulle operazioni del corpo,
oltre alla lettura della procedura. Il limite è 10000 passi e 32 chiamate annidate, insieme al
timeout di aggregazione e ai normali cap dei risultati.

Sono confrontati corpi MySQL BEGIN/END, PostgreSQL LANGUAGE SQL con BEGIN
ATOMIC o dollar quote e il sottoinsieme PL/pgSQL con DECLARE, assegnazioni,
IF/ELSIF/ELSE, WHILE LOOP, LOOP, EXIT/CONTINUE WHEN e RETURN. REPEAT/UNTIL ed ELSEIF
sono confrontati con MySQL; SIGNAL/RAISE non gestiti interrompono e annullano
la chiamata, eccetto gli avvisi SQLSTATE classe 01 che consentono di proseguire.
I cursori vengono materializzati all'OPEN nello snapshot della CALL, con cap
di righe e budget complessivo di byte per tutti quelli aperti. FETCH associa
le colonne per posizione; usare alias distinti. CLOSE libera il risultato
e permette di riaprire il cursore. Il formato MySQL preserva le variabili
all'esaurimento e attiva l'handler NOT FOUND; il formato LANGUAGE PLPGSQL le
imposta a NULL e aggiorna FOUND per FETCH. CONTINUE riprende dopo FETCH, EXIT
termina il corpo della routine dopo il proprio handler. Anche i corpi degli
handler e le sorgenti dei cursori sono autorizzati prima della CALL.
Sono verificati parametri, risultati vuoti, riapertura, errori di stato/arità,
BIGINT esatto, rollback e limiti. Gli handler per SQLSTATE esatto hanno precedenza
sugli handler di classe; un handler può dichiarare più condizioni. RESIGNAL
propaga lo stato, eventualmente sostituendolo insieme a MESSAGE_TEXT, senza
riattivare lo stesso handler durante l'uscita da IF/cicli. Un chiamante esterno
può intercettarlo. Questi casi sono confrontati con MySQL 8.4.

Nelle CALL principali sono disponibili SAVEPOINT, ROLLBACK TO e RELEASE
SAVEPOINT. Ogni DML ha un punto di ripristino implicito: SIGNAL da trigger e
violazioni FK annullano tutta l'istruzione, incluse cascate e audit, conservando
le istruzioni precedenti per un handler CONTINUE/EXIT. I controlli anticipati
di unicità e validazione evitano l'aborto nativo per i casi coperti. SQLSTATE
distingue 23505/23502/23514/23503 e le corrispondenti condizioni MySQL;
RESIGNAL conserva questa distinzione. I blocchi PL/pgSQL EXCEPTION annidati
annullano le scritture del blocco preservando le variabili, con WHEN SQLSTATE,
condizioni nominate, OTHERS e RAISE senza argomenti.
I corpi degli handler sono autorizzati anche se non eseguiti.
Il catalogo PostgreSQL 18 comprende 247 nomi per 251 SQLSTATE, conservando i
nomi associati a più codici. Sono verificati su PostgreSQL e MongoDB con RAISE
e handler espliciti; questo prova il riconoscimento delle condizioni, non che
MongoDB produca nativamente tutti quegli errori. Sono disponibili anche RAISE
SQLSTATE, RAISE con nome di condizione e USING MESSAGE/ERRCODE costante.
Le conversioni testuali invalide usano `22P02` nel percorso PostgreSQL e
`22018` negli handler MySQL. OTHERS esclude query_canceled e assert_failure.
Riferimento: [codici PostgreSQL 18](https://www.postgresql.org/docs/18/errcodes-appendix.html).

Il ripristino usa immagini BSON delle collezioni toccate, nella stessa
transazione: non esegue nuovamente i trigger e conserva i byte. Il budget è
complessivo e il limite è 128 punti annidati; leggere/ripristinare intere
collezioni ha un costo maggiore dei savepoint nativi. In caso di failover,
withTransaction ripete l'intera CALL e ricrea i punti. Sono provati anche
savepoint omonimi MySQL, indici parziali, cap, scope e precisione BSON.

Le pipeline di lettura nelle CALL materializzano le sorgenti nello snapshot
della transazione, incluse le sue scritture, poi valutano le espressioni pure
con `$documents` fuori dalla transazione. Anche lookup e union usano le immagini
lette nello stesso snapshot. Divisione per zero e conversioni invalide native
sono quindi intercettabili anche in SELECT, INSERT SELECT, UPDATE FROM e cursori,
senza rigiocare istruzioni o perdere le modifiche precedenti. I dati intermedi
rispettano i cap e il limite complessivo BSON del comando (16 MiB meno margine).
Questo percorso aggiunge letture e memoria; non ha le prestazioni dei savepoint
di un motore SQL nativo.

Gli indici multikey e speciali vengono ora provati dal server su una collezione
temporanea contenente lo snapshot corrente, prima della scrittura transazionale.
E11000 nativo diventa `unique_violation` senza abortire lo snapshot; sono provati
rollback del blocco protetto e prosecuzione della CALL. Gli indici e le collazioni
sono riprodotti, il TTL è escluso dalla copia e la collezione è eliminata in finally.
La creazione degli indici usa il quorum di maggioranza; il DROP della copia viene
ripetuto fino a tre tentativi per gli errori di cambio primario/rete. Se la prima
risposta è incerta e la collezione risulta già assente, la pulizia è conclusa.
Il costo è una copia della collezione per candidato, entro i budget esistenti;
un arresto del processo CodeDB può lasciare una collezione `_codedb_sql_probe_*`.
Anche gli errori nativi 16755 (geometria per indice 2dsphere), 171 (array paralleli
in un indice composto) e 66 (_id immutabile) sono provati dal server sulla copia:
diventano condizioni `data_exception` 22000 con codice e causa originali.
Per gli aggiornamenti la prova sostituisce l'immagine precedente, conservando
la verifica nativa dell'immutabilità. Questi codici MongoDB non hanno una
corrispondenza esatta con un identico comando PostgreSQL/MySQL.
Non è ancora un emulatore generale delle subtransazioni: errori del server
che abortiscono la transazione (inclusi errori di scrittura non anticipati
e conflitti con client esterni) non possono essere intercettati
per continuare nello stesso snapshot. Restano rollback completo o retry nativo,
senza commit parziale. EXCEPTION e handler sono verificati anche nei trigger
richiamati direttamente da SQL/MQL. Non sono disponibili savepoint persistenti
fra richieste SQL autonome; SAVEPOINT esplicito resta limitato alle CALL,
fuori dal corpo dei trigger.

I corpi SQL `BEGIN ATOMIC` registrano dipendenze da tabelle, colonne e CALL.
ALTER TYPE e DROP senza CASCADE rifiutano dipendenze coperte; le rinomine dei
riferimenti diretti e DROP COLUMN CASCADE aggiornano/eliminano il catalogo nella
transazione della migrazione. DROP PROCEDURE CASCADE segue le chiamate dipendenti
e controlla il permesso DDL su ogni routine. Il binding attraversa CTE,
derived table, sottoquery correlate, SELECT * e alias omonimi in scope diversi.
Le rinomine conservano i nomi proiettati dalle query interne. Non è un catalogo
PostgreSQL generale: restano SQL dinamico, dipendenze da funzioni/tipi nelle
espressioni e costrutti non compilabili dal traduttore. I corpi testuali PL/pgSQL e
MySQL non ricevono artificialmente queste dipendenze, come previsto dal modello
PostgreSQL per i corpi stringa. CALL in BEGIN ATOMIC è un'estensione CodeDB:
PostgreSQL 18.4 la rifiuta. Riferimento:
[dipendenze PostgreSQL](https://www.postgresql.org/docs/18/ddl-depend.html).
Restano condizioni numeriche MySQL, GET DIAGNOSTICS, altri attributi SIGNAL,
scope lessicale delle dichiarazioni annidate e diagnostica SQLSTATE completa.
Mancano cursori SCROLL,
parametri del cursore, record/refcursor restituiti e WHERE CURRENT OF.
FOUND non è ancora aggiornato
da tutti gli altri comandi PL/pgSQL. Riferimenti:
[cursori MySQL](https://dev.mysql.com/doc/refman/8.4/en/cursors.html),
[handler MySQL](https://dev.mysql.com/doc/refman/8.4/en/declare-handler.html),
[cursori PL/pgSQL](https://www.postgresql.org/docs/18/plpgsql-cursors.html).
Gli splitter dell’editor e del server preservano il corpo
prima della CALL successiva. Riferimenti:
[CREATE PROCEDURE PostgreSQL](https://www.postgresql.org/docs/18/sql-createprocedure.html)
e [CREATE PROCEDURE MySQL](https://dev.mysql.com/doc/refman/8.4/en/create-procedure.html).
MySQL non rende automaticamente atomica una CALL: il riferimento nelle prove
di rollback usa una transazione esplicita. CodeDB restituisce l’ultimo risultato
del corpo, senza emulare result set multipli o parametri OUT.

### Differenze semantiche e funzionalità ancora mancanti

Il dialetto SQL su MongoDB combina costrutti comuni ed estensioni dei due
DBMS; non offre attualmente una modalità che riproduca tutte le regole di uno
specifico server. Gli identificatori SQL MongoDB usano backtick; le virgolette
doppie delimitano stringhe. `LENGTH` conta caratteri: per i byte è disponibile
`OCTET_LENGTH`. Le date seguono gli operatori MongoDB, normalmente in UTC.
`GREATEST` e `LEAST` propagano i null; `CONCAT` propaga i null.
Il comportamento preesistente di `LIKE` è sensibile alle maiuscole per
pattern con prefisso letterale, insensibile per pattern senza quel prefisso;
`ILIKE` chiede sempre il confronto insensibile. Non è una collazione SQL.

Gli arrotondamenti di `ROUND` seguono `$round`, compresi i pareggi verso il
numero pari. La conversione di maiuscole e minuscole eredita i limiti degli
operatori MongoDB, senza emulare le collazioni SQL.
Vedi [arrotondamento MongoDB](https://www.mongodb.com/docs/v8.0/reference/operator/aggregation/round/)
e [conversione delle maiuscole](https://www.mongodb.com/docs/v8.0/reference/operator/aggregation/toupper/).

In assenza di NULLS FIRST/LAST, l’ordinamento mantiene la convenzione MongoDB/MySQL
(NULL prima in ASC e dopo in DESC), diversa dal valore predefinito PostgreSQL.
SELECT * sulle JOIN mantiene la rappresentazione documentale con i lati uniti
annidati sotto il loro alias; per colonne piatte usare una proiezione esplicita.

Restano fuori dalla traduzione: CTE ricorsive annidate, ricorsione mutua,
SEARCH/CYCLE, CTE contenenti scritture, raggruppamenti
ROLLUP/CUBE/GROUPING SETS, scritture su più bersagli,
sottoquery nelle condizioni ON delle JOIN,
confronti di righe/tuple, LATERAL, funzioni aggregate diverse dalle sette
elencate e le funzioni scalari non presenti nel registro. Le correlazioni
richiedono nomi qualificati: senza un catalogo di schema non si può scegliere
in modo generale fra colonna interna ed esterna con lo stesso nome. Non sono
implementati ON CONFLICT ON CONSTRAINT, inferenza di indici parziali,
le varianti MySQL con alias della riga inserita e controllo SQL delle
transazioni. Restano le varianti ALTER/TRIGGER elencate sopra, identità/sequence/auto_increment, colonne
generate, altri tipi personalizzati/spaziali e le varianti di domini/array/range
elencate sopra, vincoli differibili, MATCH FULL e SET DEFAULT referenziale.
INSERT VALUES accetta espressioni scalari senza riferimenti a colonne e DEFAULT.
Lo schema non risolve ancora completamente i tipi
delle espressioni, le coercizioni fra operandi insiemistici, SELECT * e i nomi
di colonna inesistenti. Nelle procedure mancano OUT/INOUT, overload, le varianti
di cursori e handler elencate sopra, SQL dinamico, DDL e CTE ricorsive nel corpo.
**La compatibilità totale con PostgreSQL e MySQL non è raggiunta**, né è
certificata dalle prove qui descritte.

## Shell MongoDB

Dal 15 ottobre il percorso dei comandi nativi comprende `db.runCommand()` e
`db.adminCommand()`: il documento viene eseguito dal server MongoDB, senza
una whitelist delle keyword nel catalogo dell'editor. Richiede `manage`
sull'intera connessione, perché un comando amministrativo può coinvolgere
database e collezioni indiretti. Restano vietati il JavaScript remoto
(`$where`, `$function`, `$accumulator`, eval e mapReduce) e l'iniezione dei
campi di protocollo della sessione. Le operazioni CRUD e di metadati continuano
a usare i permessi specifici e gli scope esistenti.

`db.getMongo().startSession()` espone `getDatabase`, `startTransaction`,
`commitTransaction`, `abortTransaction`, `withTransaction`, `endSession`,
`hasEnded` e gli accessi ai tempi di sessione. Il contesto segue ciascun
oggetto database della sessione: due sessioni nello stesso script restano
isolate. Letture e scritture condividono la transazione reale; le sessioni
aperte vengono chiuse alla fine del run, anche dopo un errore o un limite,
annullando le transazioni non confermate. Le variabili e le sessioni non
sopravvivono fra esecuzioni indipendenti dell'editor. `await`, funzioni `async`
e callback transazionali sono gestiti dall'interprete, senza eval.

Sono disponibili aggregazioni a livello database, informazioni sulle collezioni,
opzioni di creazione e validatori, nomi e indici, creazione multipla,
indici nascosti, statistiche e conteggi nativi. `distinct` usa il driver:
espande gli array come MongoDB, invece di raggruppare l'array intero.
Comando singolo e script usano lo stesso percorso per conteggi e distinct.
Gli `_id` testuali restano stringhe; i Long restano esatti anche nei validatori
e nelle condizioni degli indici parziali. `getMore` conserva la sessione del
comando iniziale e i cursori aperti vengono chiusi a fine run.
`createIndexes` accetta i key pattern della shell e applica le opzioni a ogni
indice; `dropIndexes` rispetta nome, key pattern o elenco di nomi, conservando
gli indici non selezionati. Anche la DDL conserva la sessione: un DROP vietato
in transazione viene rifiutato dal server, senza essere eseguito fuori da essa.

L'ultima espressione dello script viene mostrata nei risultati: documenti e
array direttamente, valori scalari nella colonna `valore`. I metodi CRUD
restituiscono i nomi mongosh (`matchedCount`, `modifiedCount`, `deletedCount`,
identificativi e documento di `findOneAnd…`). I vecchi alias dei conteggi
restano leggibili dagli script salvati, senza comparire nel JSON nativo.
Il catch conserva codice, nome, label e dettagli pubblici degli errori DB.

`bulkWrite` supporta `insertOne`, `updateOne`, `updateMany`, `replaceOne`,
`deleteOne` e `deleteMany`. Le operazioni vengono eseguite in sequenza
attraverso l’host autorizzante, con budget, filtro esplicito e permessi per
ogni operazione. `ordered: false` prosegue dopo gli errori ordinari; i limiti
di esecuzione interrompono il batch. Non è una transazione: un errore può
lasciare operazioni già applicate. Risultati ed errori conservano conteggi,
identificativi per posizione, codice, errori per operazione e risultato
parziale. Dentro una sessione transazionale esplicita partecipano alla stessa
transazione. Il batch viene eseguito per operazione, non con un unico comando
bulkWrite sul protocollo.

Le pipeline di aggiornamento arrivano al driver. Opzioni come `collation`,
`hint`, `allowDiskUse`, `batchSize`, `readPreference`, `readConcern` e
`maxTimeMS` vengono inoltrate sia dalla shell singola sia dagli script.
Il timeout richiesto può restringere il tetto del server; il commento utente
conserva l’identità necessaria all’annullamento. `explain()` restituisce
il piano invece di eseguire una normale lettura. Le opzioni non gestite
producono un errore, senza essere ignorate.

Questo percorso controllato copre i metodi elencati; il runtime completo è
disponibile selezionando **mongosh nativo (amministratore)**, descritto sotto.
I comandi equivalenti del server restano accessibili attraverso `runCommand`
quando consentiti, anche nel percorso controllato.
Le estensioni Search/Atlas richiedono il servizio corrispondente; non sono state
provate con le fixture locali. Le versioni verificate sono MySQL 8.4.11,
PostgreSQL 18.6 e MongoDB 8.0.29. Non è una certificazione di tutte le versioni,
estensioni o combinazioni sintattiche.

Le nuove prove comprendono 20 gruppi reali in `test/e2e-query-nativo-completo.js` e
`test/unit-mongo-nativo.js`; i log di questa verifica e delle mutazioni sono in
`test-reports/query-native-2026-10-15/`. Sono rilevate dieci mutazioni intenzionali
in memoria: sessione, scope, opzioni, precisione, BSON, errori, comandi, DDL,
selezione degli indici e adattamento delle chiavi. Riferimenti dei contratti:
[metodi mongosh](https://www.mongodb.com/docs/mongodb-shell/reference/methods/)
e [transazioni](https://www.mongodb.com/docs/manual/reference/method/session.starttransaction/),
[createIndexes](https://www.mongodb.com/docs/manual/reference/method/db.collection.createindexes/)
e [dropIndexes](https://www.mongodb.com/docs/manual/reference/method/db.collection.dropindexes/).

## Runtime mongosh nativo

Nel menu del bersaglio di Query & Aggregate seleziona **mongosh nativo
(amministratore)** su una connessione MongoDB. Sono incorporati i componenti
ufficiali `@mongosh/shell-api` e `@mongosh/shell-evaluator` **5.9.2**, con
`@mongosh/service-provider-node-driver` **5.6.2**. Gli helper provengono dalla
libreria ufficiale; il catalogo dell'autocompletamento si rigenera con
`node tools/aggiorna-mongosh.cjs` e viene verificato rispetto alle sue firme.

Un processo Node separato per tab mantiene variabili, funzioni, classi,
cursori e sessioni fra esecuzioni. `load`, `require`, import dinamico, `console`,
`passwordPrompt`, `show`, `use`, `config`, bulk builder, viste, plan cache,
`rs`, `sh`, `sp` e gli altri helper sono quelli della versione incorporata.
L'ultima espressione viene resa come risultato, `print` come output live anche
prima di un errore; i cursori
mostrano un batch e `it` legge quello successivo. Long e Decimal conservano la
precisione; BigInt JavaScript viene mostrato come testo con suffisso `n`, senza
troncamento a 64 bit. Gli oggetti circolari sono mostrati come testo ispezionato.

Il runtime segue le trasformazioni JavaScript di mongosh, compreso l'attesa
implicita delle operazioni asincrone. Non è una certificazione di ogni sintassi
ECMAScript: per esempio `await` e `for await` espliciti al livello principale
non sono accettati dall'evaluator incorporato, come nella CLI verificata;
si possono usare le chiamate con attesa implicita e funzioni `async`.

Per osservare eventi nell'editor esegui:

```javascript
db.eventi.watch([], { fullDocument: 'updateLookup', maxAwaitTimeMS: 1000 })
```

Il pannello continua a ricevere eventi mentre esegui altre query, mostra il
resume token e permette di chiudere ciascuno stream. Conserva gli ultimi
200 eventi per stream, con tetto di byte e conteggio degli omessi; al massimo
10 stream visualizzati contemporaneamente e 20 cronologie. Se invece assegni
il cursore a una variabile, resta sotto il controllo dello script:
`const eventi = db.eventi.watch()` seguito da `eventi.tryNext()` in esecuzioni
successive. Le opzioni `resumeAfter` e `startAfter` sono inoltrate al driver.
Il driver riprende gli stream dopo errori di rete recuperabili; un token scaduto
o un errore non recuperabile viene segnalato, senza inventare eventi mancanti.

**Azzera runtime**, `quit()`, disconnessione, revoca e arresto dell'app chiudono
sessioni e stream. Lo stato non è salvato su disco e non sopravvive alla chiusura
della connessione o al riavvio: per riprendere usa un token conservato con
`resumeAfter`. Lo stop di una query e il timeout azzerano il processo anche
se sta eseguendo un ciclo infinito. Il timeout predefinito è 60 secondi,
configurabile con `CODEDB_MONGOSH_TIMEOUT_MS`; gli stream già aperti non scadono
con la query. Resta il tetto `CODEDB_MAX_RESULT_BYTES` per risultati e cronologia.

Il runtime ha accesso a Node.js e ai file **del server**, con i privilegi del
processo CodeDB: non è una sandbox. Richiede `isInstallAdmin` (uso locale con
RBAC spento, oppure owner elencato in `CODEDB_VAULT_ADMINS`/`CODEDB_OWNER_EMAIL`).
Essere owner di un tenant o avere `manage` su una connessione non basta.
Qui i comandi MongoDB seguono i privilegi delle credenziali native e non gli
scope per collezione dell'interprete controllato. Le API native non sono
filtrate da una lista locale di keyword; il server decide cosa supporta.

Verifica del 15 ottobre: MongoDB **8.0.29**, replica set a tre container, test
Socket.IO e Chromium con dati reali, cambio del primario e ripresa degli eventi,
transazioni mantenute fra query, annullamento e pulizia. I log e lo screenshot
sono in `test-reports/mongosh-2026-10-15/`. Sono rilevate mutazioni intenzionali
di persistenza, lettura dello stream, permessi, serializzazione BSON e formattazione.
Sono rieseguite le suite native SQL, del percorso controllato e RBAC.
Le verifiche aggiuntive sotto coprono Atlas Local, sharding, Kerberos/CSFLE
e l'installer Windows. Non certificano ogni versione o configurazione del server.

Per riprodurre le prove mongosh da PowerShell, con Docker avviato:

```powershell
docker compose -f test/fixtures/sql-native-databases.yml up -d --wait
node test/fixtures/sql-native-init.cjs
$env:CODEDB_E2E_DESTRUCTIVE='1'
$env:NODE_OPTIONS='--require=./test/fixtures/sql-native-dns.cjs'
node test/e2e-mongosh-runtime.js
node test/e2e-mongosh-ui.js
docker compose -f test/fixtures/sql-native-databases.yml down --volumes
```

Esegui queste due suite in sequenza: il test runtime cambia il primario della
fixture e può far scadere una connessione avviata contemporaneamente dalla UI.
La pulizia elimina soltanto lo stack di test; i database di ogni prova hanno
nomi casuali registrati. I log diagnostici e le esecuzioni con mutanti sono
separati dai log delle suite superate.

### Verifiche avanzate su ambienti reali, 15 ottobre 2026

| Ambiente | Verifica effettiva |
| --- | --- |
| Atlas Local, MongoDB 8.0.34 e mongot | Creazione, elenco, aggiornamento e rimozione degli indici Search; risultati testuali attesi; indice Vector Search e ordine dei vicini per similarità |
| MongoDB 8.0.29, mongos, config server e due shard | `sh.enableSharding`, `shardCollection`, split e migrazione di chunk; verifica dei chunk su entrambi gli shard; eventi da entrambi, ripresa dal token e transazione distribuita |
| MongoDB Enterprise 8.0.34 e MIT Kerberos 1.19.2 su Linux | Connessione iniziale di CodeDB e runtime mongosh con GSSAPI, identità autenticata, CRUD; rifiuto di una nuova connessione dopo `kdestroy` |
| MongoDB Enterprise 8.0.34, CSFLE con KMS locale | Key vault, chiave dati, cifratura esplicita e automatica, query cifrata e decifratura; verifica indipendente del BSON binario sottotipo 6 sul server; chiave errata rifiutata |
| Parser CSFLE | `mongocryptd` 8.0.34 reale e, separatamente, DLL ufficiale `crypt_shared` 8.2.12 su Windows; verifica della versione effettivamente caricata dal driver |
| Installer NSIS Windows x64 | Build, installazione silenziosa, avvio Electron 43.7.9/Node 24.21.0, esecuzione delle prove avanzate dall'app installata in ASAR, disinstallazione e conservazione del profilo |

La suite avanzata passa attraverso `query:execute` con il motore `mongosh`;
le verifiche sul contenuto cifrato e sui chunk usano un client indipendente.
I log, lo screenshot e l'esito delle mutazioni sono in
`test-reports/mongosh-advanced-2026-10-15/`.
Rimuovere intenzionalmente il collegamento al parser fa fallire il test CSFLE;
simulare un modulo nativo mancante fa fallire il controllo prima della build.
La suite unitaria completa è superata.

Le dipendenze native per il driver CodeDB e per mongosh hanno versioni distinte.
`npm ci` deve consentire gli script di installazione di `kerberos` e
`mongodb-client-encryption`; `allowScripts` li abilita anche con npm 12.
Il controllo `tools/verifica-mongosh-nativi.cjs`, eseguito prima del packaging,
verifica caricamento e compatibilità di versione per entrambi i driver.
Con npm 12.2.0 resta una diagnostica di peer opzionali sulla copia del driver
di `@mongosh/service-provider-core`, usata dal pacchetto per i tipi e non
caricata dal suo JavaScript. La prova di installazione pulita è registrata;
questa diagnostica non è indicata come risolta. I due driver effettivamente
eseguiti hanno superato le prove native descritte sopra.

La cifratura automatica richiede anche un componente di analisi installato
dall'amministratore. `CODEDB_MONGOSH_CRYPT_SHARED_LIB_PATH` indica il percorso
assoluto della libreria ufficiale; se impostato, la libreria è obbligatoria e
un errore di caricamento non viene nascosto. In alternativa,
`CODEDB_MONGOSH_MONGOCRYPTD_URI` indica un `mongocryptd` già avviato e disabilita
lo spawn automatico. Senza questi valori valgono i comportamenti predefiniti
del driver. Le opzioni sono inoltrate dal listener ufficiale di mongosh;
`new Mongo(uri, fleOptions)` mantiene la sintassi della shell.
Riferimenti: [opzioni mongosh](https://www.mongodb.com/docs/mongodb-shell/reference/options/)
e [componente di analisi della cifratura](https://www.mongodb.com/docs/v8.0/core/queryable-encryption/install-library/).

Per riprodurre le prove da PowerShell:

```powershell
docker compose -f test/fixtures/mongo-advanced.yml up -d
node test/fixtures/mongo-advanced-init.cjs
$env:CODEDB_E2E_DESTRUCTIVE='1'
node test/e2e-mongosh-advanced.cjs
docker build -f test/fixtures/mongo-kerberos.Dockerfile -t codedb-mongo-kerberos-test .
docker run --rm --hostname mongo.kerberos.test codedb-mongo-kerberos-test
npm run build:win -- --config test/fixtures/mongosh-electron-builder.cjs
node test/e2e-mongosh-electron.cjs
docker compose -f test/fixtures/mongo-advanced.yml down --volumes
```

Per provare anche `crypt_shared`, scaricare la libreria dal sito MongoDB,
impostare `CODEDB_MONGOSH_CRYPT_SHARED_LIB_PATH` e ripetere le due suite avanzate
e Electron. Il checksum della libreria usata è registrato nel rapporto.
L'installer di collaudo ha nome e identità `CodeDBMongoshTest`, output sotto
`.scratch`, collegamenti disabilitati e un profilo separato attraverso
`CODEDB_ELECTRON_USER_DATA_DIR`. Non sostituisce l'installazione CodeDB dell'utente.
La DLL di prova non è redistribuita nell'installer.

Restano **non verificati** Atlas cloud e Stream Processing: l'utente ha
confermato di non avere un progetto/cluster cloud. Atlas Local non sostituisce
questa verifica. Sono inoltre fuori dall'evidenza raccolta Active Directory/SSPI
su Windows, KMS cloud, installer macOS/Linux, firma del codice e aggiornamento
tramite una release pubblicata. Il test Kerberos usa MIT su Linux; il test
CSFLE usa chiavi locali; l'installer Windows è privo di firma.

## Verifiche riproducibili

| Comando | Prova |
| --- | --- |
| `npm test` | Suite unitaria, inclusi cataloghi, traduzione, routing, sicurezza e opzioni |
| `node test/e2e-mongosh-runtime.js` | Runtime ufficiale, helper, BSON, sessioni persistenti, stream/resume/failover, annullamento e pulizia su MongoDB reale |
| `node test/e2e-mongosh-ui.js` | Interfaccia reale: selezione runtime, variabili, eventi live, token, chiusura e reset |
| `node test/e2e-mongosh-advanced.cjs` | Atlas Local Search/Vector, cluster a due shard, stream e CSFLE reale |
| `node test/e2e-mongosh-electron.cjs` | Installazione/disinstallazione NSIS e suite avanzata dall'app installata |
| `node test/e2e-mongosh-kerberos.cjs` | Da eseguire nella fixture Docker: ticket MIT, GSSAPI e rifiuto senza ticket |
| `node test/e2e-query-copertura.js` | Risultati reali attraverso socket su MongoDB: funzioni del registro, NULL, JOIN, CTE, DDL, UPDATE, bulkWrite, opzioni ed explain |
| `node test/e2e-sql-mongo-avanzato.js` | JOIN, finestre, CTE, aggregati, sottoquery, insiemi, scritture relazionali, tipi/vincoli, procedure e RETURNING via socket; confronto PostgreSQL/MySQL tramite PGPORT/MYSQL_PORT |
| `node test/e2e-sql-mongo-atomicita.js` | Rollback, limiti righe/byte, annullamento, CTE, cardinalità delle sottoquery e dieci upsert concorrenti sulla stessa chiave |
| `node test/e2e-sql-mongo-integrita.js` | RBAC reale su procedure e cascata, rollback/timeout delle CALL, BIGINT esatto, concorrenza e FK su shell, griglia e import |
| `node test/e2e-sql-mongo-migrazioni.js` | ALTER: rollback, recupero prima/dopo commit, risposta persa, annullamento, concorrenza; trigger/CALL annidate e scope; ENUM/UNSIGNED |
| `node test/e2e-sql-mongo-eventi.js` | Trigger BEFORE/AFTER su CRUD MQL, griglia, import e cascate; OLD/NEW, BSON esatto, rollback, scope, cursori e handler |
| `node test/e2e-sql-mongo-varianti.js` | Varianti ALTER/trigger, confronto NULL, handler SQLSTATE e RESIGNAL; gli stessi casi sono inclusi nella suite avanzata via socket |
| `node test/e2e-sql-mongo-completamento.js` | Savepoint, EXCEPTION, FK/indici/trigger dipendenti, UPDATE OF, binari, scope e BSON; confronti PostgreSQL/MySQL |
| `node test/e2e-sql-mongo-tipi.js` | Array, range, domini, CAST, trigger per istruzione, dipendenze delle routine, condizioni PostgreSQL ed errori nativi con savepoint |
| `node test/e2e-sql-mongo-estesi.js` | Limiti/slice/assegnazioni array, sei multirange, validazione differita dei domini, stato trigger, scope SQL annidati e E11000 nativo con savepoint |
| `node test/e2e-sql-mongo-estesi.js --compatibilita` | Ordinamenti SQL, conversioni testuali, aggregati range/multirange, CAST e CASCADE dei domini, rinomina trigger, errori geospaziali/multikey/_id e rollback a metà migrazione |
| `node test/e2e-sql-mongo-failover.js` | Diciotto arresti reali del container primario, nuova elezione e verifica di ALTER, indici, trigger, dipendenze FK/routine anche annidate, domini/VALIDATE/CASCADE e savepoint con indici multikey |
| `node test/e2e-query-dialetti-nativi.js` | Inventari keyword dei server; 14 query native confrontate con formattazione/minificazione; 6 query comuni confrontate sui tre DBMS |
| `node test/e2e-query-languages.js` | Dropdown, tastiera, formattazione e dimensioni desktop/mobile in Chromium; trasporto simulato |

I test sui database sono stati eseguiti su container dedicati con volumi
usa-e-getta, senza dati o volumi dell'utente.
Per l’estensione avanzata sono passate **378 verifiche su MongoDB, via socket
e driver**, con **270 confronti su PostgreSQL e 273 su MySQL** per i costrutti
disponibili nei rispettivi dialetti. Sono passate anche le 71 prove MongoDB
preesistenti, la suite unitaria completa e le prove separate di atomicità.
È verificato anche findOneAndReplace attraverso interprete e socket, con
lettura/scrittura autorizzate e trigger nei percorsi protetti.
La fixture MongoDB crea database casuali, ne verifica la proprietà prima di
cancellarli e richiede `CODEDB_E2E_DESTRUCTIVE=1`. I percorsi nativi sono in
sola lettura. Le porte si configurano con `MONGO_PORT`, `MYSQL_PORT` e `PGPORT`.

Le suite `unit-query-copertura`, `unit-sql-mongo-copertura`,
`unit-mongo-copertura` e `e2e-query-dialetti-nativi` espongono `--mutant`:
alterano il codice soltanto in memoria e **devono fallire**. La sensibilità
è stata verificata rimuovendo il dialetto dal minificatore, invertendo UPPER
e interrompendo l’inoltro delle opzioni. Queste prove coprono il perimetro
dichiarato, non ogni query o combinazione possibile dei linguaggi.

La suite `e2e-sql-mongo-atomicita` accetta `--mutant=join`, `window`, `cte`,
`rollback`, `distinct`, `filter`, `subquery`, `limit` e `conflict`:
tutte e nove le alterazioni in memoria sono state rilevate dai test, comprese
cardinalità non valida accettata, righe modificate oltre il limite e conflitto
ignorato. I nuovi test avanzati usano MONGO_PORT=27039
come default; richiedono un database di test con transazioni.

Anche `node test/unit-sql-mongo-runtime.js --mutant` è fallito come previsto:
rimuovere il controllo delle sorgenti di RETURNING fa rilevare al test un accesso
fuori scope. Il codice alterato vive soltanto nel processo di prova.

La suite `e2e-sql-mongo-integrita` accetta `--mutant=insieme`, `sorgente`,
`join_scrittura`, `schema`, `foreign`, `procedura`, `permessi` e `precisione`.
Le otto alterazioni sono state rilevate: molteplicità errata, INSERT vuota,
assegnazione JOIN errata, validatore indebolito, FK ignorata, CALL senza rollback,
privilegi non verificati e arrotondamento del letterale BIGINT. I controlli
precedenti sono stati rieseguiti. Log in `test-reports/query-languages/*-14.log`.
La nuova esecuzione riesegue le nove mutazioni di atomicità, le otto di integrità,
le due unitarie e aggiunge `integrita --mutant=mql` e `migrazioni --mutant=alter`,
`recupero`, `trigger`, `controllo`, `enum`, `unsigned`, `parentesi`, `letterale`,
`nomi`. Un'ulteriore mutazione del riconoscimento CHANGE COLUMN verifica il
nuovo caso IntelliSense: **30 regressioni intenzionali rilevate**, senza
modificare i sorgenti su disco. I log aggiornati sono
`test-reports/query-languages/*migrazioni*.log`.
Anche `unit-sql-mongo-schema.js --mutant` fallisce come previsto quando si
rimuove la conservazione dei numeri esatti durante la lettura di testo JSON.
Chromium usa un browser reale con trasporto DB simulato. Un primo avvio parallelo
è scaduto durante il caricamento; la ripetizione isolata è passata senza errori JS.

L'estensione precedente aggiungeva 31 gruppi di verifiche reali in `eventi` e quattro
failover. I log sono `test-reports/query-languages/eventi-*.log`. I mutanti
`mql`, `singolo`, `bson`, `griglia`, `before`, `cascata`, `cursore`, `handler` e
`opzioni` e `nullid` disattivano separatamente i comportamenti coperti.
I dieci mutanti sono stati rilevati. Anche
`node test/unit-sql-split-client.js --mutant=handler` fallisce come previsto
alterando il confine del corpo di un handler IF. La prova
`node test/unit-mongo-copertura.js --mutant=replace` rileva la rimozione del
metodo findOneAndReplace dall'interprete: dodici regressioni intenzionali
rilevate nell'estensione precedente, senza modificare i sorgenti su disco.

La fixture attuale si avvia con `node test/fixtures/sql-replica-containers.js start`
e si elimina con lo stesso comando seguito da `stop`: usa soltanto i tre
container `codedb-sql-node-27039`, `codedb-sql-node-27040`, `codedb-sql-node-27041`,
etichettati `codedb.test=sql-replica`. Le porte sono pubblicate sul loopback;
il replica set `codedbtest` annuncia `host.docker.internal`. Nei soli processi
di test Windows impostare `NODE_OPTIONS=--require=./test/fixtures/sql-replica-dns.cjs`
per risolvere quel nome sul loopback. Non si modifica il DNS di sistema.
Impostare `CODEDB_E2E_DESTRUCTIVE=1`, `MONGO_PORT=27039` e, per il failover,
`CODEDB_E2E_FAILOVER_NODES=1`. Il runner controlla membri e proprietà dei
container prima di arrestarli, poi li riavvia e aspetta tutti e tre sani.
PostgreSQL e MySQL sono container dedicati sulle porte 55439 e 33339.
I log dell'estensione precedente sono `test-reports/query-languages/varianti-*.log`.
Quell'estensione aggiunge 73 controlli alla suite avanzata e porta a 32
i gruppi reali degli eventi MQL/griglia/import. Sono stati rilevati undici
mutanti di `e2e-sql-mongo-varianti`: `when`, `eventi`, `ordine`, `indice`,
`vincolo`, `drop_check`, `recupero_indice`, `precedenza`, `resignal`, `atomica`,
`distinct`. Anche `e2e-sql-mongo-failover --mutant=quorum` e
`unit-sql-split-client --mutant=handler` falliscono come previsto: tredici
alterazioni intenzionali rilevate. Il mutante del quorum ripristina
votingMembers e fallisce per mancato completamento con il nodo offline;
non basta un errore di connessione o una mutazione non applicata.
Le prove diagnostiche `*-prima-correzione.log` e `*-diagnostica.log` richiesero
interventi manuali: non sono conteggiate fra i failover superati.

L'estensione del 14 ottobre aggiunge **112 controlli MongoDB**, con **30
confronti PostgreSQL e 45 MySQL**, nella suite `e2e-sql-mongo-completamento`.
Sono rieseguite le 378 verifiche avanzate (270 PostgreSQL, 273 MySQL), i 32
gruppi MQL/griglia/import, atomicità, integrità, migrazioni, il percorso socket,
i dialetti nativi e `npm test`. La prova socket ha trovato e fatto correggere
una perdita dei valori Binary nella serializzazione JSON dei piani: ora usa
EJSON anche per filtri, proiezioni e explain. I nove failover comprendono
le sei prove precedenti, due migrazioni con FK dipendenti e il rollback a savepoint.
Log: `test-reports/query-languages/completamento-*.log`.
I mutanti `rollback`, `trigger_of`, `fk_rename`, `padding`, `exception`,
`indice`, `hex` della suite nuova e `unit-query-dialetti-server --mutant=bson`
verificano che i controlli falliscano quando viene alterata l'implementazione.
Non sono stati ripetuti Chromium/Electron né prove su macchine fisiche distinte.

Resta disponibile il vecchio fixture a tre processi nello stesso container
con `CODEDB_E2E_FAILOVER_CONTAINER=codedb-sql-failover-mongo`; la prova corrente
usa i tre container distinti descritti sopra.

L'estensione array/range/domini aggiunge **218 controlli MongoDB, 178 confronti
PostgreSQL e un confronto MySQL** nella suite `e2e-sql-mongo-tipi`. Include
NULL, forma multidimensionale, concatenazione/sostituzione, JOIN e cascata su
chiavi array, default e vincoli dei domini anche negli array, range canonici ed
estremi esatti, CAST, trigger statement su zero righe/TRUNCATE/upsert,
dipendenze delle routine e recupero dagli errori di espressione. Sono eseguiti
inoltre tutti i **251 SQLSTATE dei 247 nomi** del catalogo PostgreSQL, tramite
RAISE e handler. EXCLUDED funziona in maiuscolo e con lettere miste sia nelle
assegnazioni sia nel WHERE dell'upsert.

Sono rieseguite le suite precedenti: avanzata (378 MongoDB, 270 PostgreSQL,
273 MySQL), completamento (112 MongoDB, 30 PostgreSQL, 45 MySQL), 32 gruppi
MQL/griglia/import, atomicità, integrità, migrazioni, percorso socket e dialetti
nativi. Il totale delle tre suite con contatori è **708 MongoDB, 478 PostgreSQL,
319 MySQL**. Anche `npm test` è passato. Chromium ha verificato dropdown reale,
nuove funzioni array/range, tastiera, formattazione e dimensioni desktop/mobile;
questa prova UI usa un trasporto DB simulato. Dopo un timeout iniziale al
caricamento, la ripetizione isolata è passata senza errori JavaScript.

Sono rilevate **21 mutazioni** della nuova suite: `snapshot`, `array_index`,
`array_shape`, `domains`, `range`, `statement`, `routine`, `domain_rollback`,
`array_fk`, `cast_null`, `cast_overflow`, `domain_state`, `native_state`,
`duplicate_condition`, `cast_binary`, `array_cat`, `array_replace`,
`domain_array`, `default_boundary`, `statement_columns`, `excluded_case`.
Sono rieseguite anche le sette mutazioni della suite completamento e quella
BSON del routing server: **29 regressioni intenzionali rilevate**. Le mutazioni
avvengono soltanto in memoria; errori infrastrutturali o mutazioni non applicate
non valgono come successo. Log correnti: `test-reports/query-languages/tipi-*.log`.
Non sono verificati installer Electron, sharding o guasti su host fisici distinti.

L'estensione successiva, verificata su PostgreSQL **18.6**, MySQL **8.4.11** e
MongoDB **8.0**, aggiunge **116 verifiche MongoDB e 104 confronti PostgreSQL**
in `e2e-sql-mongo-estesi`. Comprende slice e assegnazioni, limiti negativi,
default/parametri/trigger, sei multirange, algebra e confronti, CHECK NOT VALID,
VALIDATE, conversioni ALTER TYPE, stato dei trigger, alias e SELECT * in scope
annidati, E11000 multikey anche con collation. Questi costrutti PostgreSQL non
vengono contati come confronti MySQL.

Sono rieseguite tutte le suite precedenti elencate sopra, `npm test`, il percorso
socket con **83 funzioni**, inventari nativi e confronto SQL comune. Il totale
delle quattro suite con contatori è **824 MongoDB, 582 PostgreSQL, 319 MySQL**.
Chromium verifica i nuovi completamenti e i controlli dell'editor con trasporto
simulato; dopo un timeout iniziale durante il caricamento, la ripetizione isolata
passa senza errori JavaScript. Le prove di database usano invece server reali.

Sono rilevate **42 mutazioni**: le 29 precedenti e 13 nuove (`array_bounds`,
`array_slice`, `array_write`, `array_native`, `multirange_merge`,
`multirange_difference`, `domain_not_valid`, `domain_validate`, `domain_conversion`,
`trigger_state`, `nested_scope`, `nested_alias`, `native_probe`). I **16 failover**
includono le 12 prove precedenti e arresti durante preflight dell'indice multikey,
commit dello stato del trigger, migrazione della routine annidata e VALIDATE del
dominio. Restano tre container sullo stesso host, non macchine fisiche distinte.
Log e riepilogo: `test-reports/query-languages/estesi-*.log` e
`test-reports/query-languages/estesi-risultati.json`. La compatibilità SQL totale
non è raggiunta; i limiti descritti nelle sezioni sopra restano aperti.

L'estensione conversioni/ordinamenti del 14 ottobre aggiunge **169 controlli
MongoDB e 133 confronti PostgreSQL** in `e2e-sql-mongo-estesi --compatibilita`.
Copre ordinamenti ed estremi di array/range/multirange, aggregati anche finestra,
conversioni testuali, indici non interi, CAST di domini e array di domini,
ricompilazione dei CHECK, DROP DOMAIN CASCADE con dipendenze nei DEFAULT,
CHECK, WHEN e corpi SQL annidati. Verifica anche rinomina dei trigger,
errori nativi 66/16755/171, rollback a metà migrazione, permessi e recupero
della pulizia del preflight dopo una risposta DROP incerta.

Sono rieseguite le quattro suite precedenti con contatori: il totale è
**993 verifiche MongoDB, 715 confronti PostgreSQL e 319 MySQL**. Passano anche
i 32 gruppi MQL/griglia/import, atomicità, integrità, migrazioni, percorso socket
con 83 funzioni scalari, inventari dei dialetti e confronto SQL comune.
Anche `npm test` è passato sulla versione finale del codice.
Le estensioni proprie di PostgreSQL non sono conteggiate come confronti MySQL.
Chromium verifica i nuovi completamenti, tastiera, formattazione e dimensioni
desktop/mobile; il trasporto DB della sola prova UI resta simulato.
Il caricamento ora attende DOM e applicazione pronta senza dipendere dal load
delle risorse esterne, dopo il timeout riscontrato nel primo tentativo.

Sono rilevate **62 mutazioni**, tutte in memoria: le 42 precedenti e 20 nuove
(`sort_sql`, `range_aggregate`, `range_intersection`, `array_text`,
`array_text_output`, `cast_domain`, `cast_domain_array`, `cascade_domain`,
`cascade_types`, `domain_recompile`, `trigger_rename`, `native_geo`,
`native_parallel`, `native_immutable`, `cascade_recovery`, `array_index_cast`,
`cascade_default`, `cascade_check`, `cascade_trigger`, `native_cleanup`).

La ripetizione completa supera **18 failover reali**, inclusi CASCADE prima e
dopo il commit. Il primo tentativo ha trovato un errore 11602 durante il DROP
della copia di preflight: la pulizia ora ripete il comando idempotente anche
quando la collezione è già stata rimossa e usa maggioranza per gli indici.
Il tentativo fallito e la riproduzione diagnostica sono conservati separatamente
e non conteggiati come una suite completa riuscita. Restano tre container sullo
stesso host; non sono verificati sharding, installer Electron o guasti su
macchine fisiche distinte. Log e riepilogo: `test-reports/query-languages/compat-*.log`
e `test-reports/query-languages/compat-risultati.json`.

La compatibilità totale resta incompleta: rimangono, fra gli altri, CAST dei
tipi base JSON/ENUM/UUID, funzioni trigger PostgreSQL e transition tables,
tipi/precisioni non rappresentabili nei valori BSON adottati e costrutti
procedurali descritti sopra. Gli errori non anticipati che distruggono la
transazione richiedono ancora rollback completo o retry: il preflight non
ricrea uno snapshot già perso. La copertura verificata non equivale a
conformità integrale a PostgreSQL, MySQL o allo standard SQL.
