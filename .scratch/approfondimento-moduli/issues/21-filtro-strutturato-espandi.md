# 21: Filtro strutturato accanto a quello testuale (espandi)

**Cosa costruire:** le tre strategie accettano un filtro come **dato** — un elenco di
condizioni con campo, operatore e valore — e ognuna lo rende nel proprio dialetto
parametrizzando. Il filtro testuale continua a funzionare accanto a quello nuovo: nessun
chiamante è ancora migrato e nulla si rompe.

Oggi lo stesso parametro significa tre cose diverse a seconda del motore: un frammento di
clausola grezzo sui due motori SQL, un documento sul motore documentale. La firma è piccola
ma l'invariante è enorme, e ogni chiamante deve sapere quale motore riceverà la chiamata —
il contrario della profondità.

È il lotto più caro e tocca l'area più calda del repo. Il blocco su 04 esiste perché lotto
1 e lotto 6 lavorano sugli stessi file e non vanno aperti insieme.

**Bloccato da:** 04.

**Status:** done

- [x] Le tre strategie accettano il filtro strutturato e lo rendono parametrizzando
- [x] Nessun valore finisce interpolato nel testo della query su nessuno dei tre motori
- [x] Test unitari coprono la resa nei tre dialetti senza database
- [x] Un test dimostra che un valore ostile non altera la struttura della query
- [x] Il filtro testuale funziona come prima: l'intera suite passa invariata

## Che cosa è stato fatto

`db/filtro.js` è il filtro come **dato**:

```js
{ condizioni: [{ campo, operatore, valore }], unione: 'e' | 'o' }
```

Undici operatori (`uguale`, `diverso`, i quattro confronti, `contiene`,
`iniziaCon`, `finisceCon`, `dentro`, `vuoto`, `nonVuoto`) e due rese:
`rendiSql(filtro, dialetto, da)` e `rendiMongo(filtro)`. Il dialetto SQL porta
le due sole cose che cambiano fra i motori: come si quota un identificatore e
com'è fatto il segnaposto (`?` contro `$n` numerato).

**Il valore non attraversa mai il testo della query.** È questa — e non un
elenco di caratteri vietati — la ragione per cui un valore ostile non può
cambiare la struttura di ciò che viene eseguito. Su MongoDB l'equivalente è che
il valore finisce sempre in posizione di *valore*: un valore che somigli a
`{ $ne: null }` resta un oggetto confrontato per uguaglianza, non diventa un
operatore.

**Il modulo rifiuta invece di correggere**: operatore sconosciuto, campo
assente, numero di valori sbagliato, unione non riconosciuta sono errori del
chiamante. Indovinare cosa intendesse produrrebbe una query che filtra per
qualcos'altro senza dirlo.

**I due filtri convivono**, come chiede il ticket: quando ci sono entrambi
valgono entrambi, uniti da AND. È la condizione che permette ai ticket 22 e 23
di migrare un chiamante per volta. Un filtro solo resta scritto **com'è** — le
parentesi compaiono solo quando i due convivono, così il testo prodotto per il
filtro testuale è esattamente quello di prima.

Il `da` di `rendiSql` (il numero del primo parametro) non è un dettaglio: su
PostgreSQL il numero del segnaposto è la posizione **reale**, e con due
condizioni il limite diventa `$3` e il salto `$4`. Lasciarli fissi a `$1` e `$2`
farebbe leggere il limite al posto del filtro — in silenzio, con un risultato
plausibile.

## Un difetto trovato collegando il modulo

Il **conteggio** riceveva la clausola e non i parametri. Finché il filtro era un
frammento di testo la clausola bastava a se stessa; col filtro strutturato
contiene segnaposto, e mandarla nuda dà «no parameter $1» su PostgreSQL e un
errore di sintassi su MySQL. La griglia avrebbe mostrato le righe e poi fallito
sul **totale** — peggio che fallire subito, perché sembra un difetto del
conteggio e non del filtro. `countWithTimeout` e `conteggioCollezione` prendono
ora i parametri insieme alla clausola.

Lo stesso valeva per il **piano di esecuzione**: un EXPLAIN con i segnaposto
senza valori non è la stessa query. Ora li riceve.

E una nota di dialetto: la clausola `ESCAPE '\'` **non** viene scritta. Su
MySQL sarebbe una stringa non terminata, perché lì la barra rovesciata vale
anche dentro i letterali; ed è superflua, visto che la barra rovesciata è già il
carattere di escape predefinito del LIKE su entrambi i motori.

## Come è stato provato

`test/unit-filtro.js` (22 prove, registrato in `test/unit.js`, senza database):
la normalizzazione che rifiuta, la resa nei tre dialetti, il LIKE con i
metacaratteri neutralizzati (chi cerca «50%» cerca la stringa «50%»), la regex
di MongoDB con i suoi metacaratteri neutralizzati (senza, «S.p.A.» cercherebbe
qualsiasi carattere al posto dei punti, e una parentesi aperta farebbe *fallire*
la query), la numerazione dei segnaposto a partire da una posizione qualunque, e
i dialetti **veri** presi dagli adattatori attraverso `buildSelect`.

La prova che conta: **sei valori ostili** diversi producono sempre la
**stessa** clausola — cambia solo il parametro.

`test/e2e-filtro-strutturato.js` (**nuovo**, tre motori veri, 35 prove): dieci
filtri diversi su una tabella con quattro righe, e il confronto fra i motori.

```
OK   MySQL risponde come MongoDB a tutti i filtri
OK   PostgreSQL risponde come MongoDB a tutti i filtri
```

Il valore ostile `a' OR 1=1 --` è anche un **dato reale** della tabella: se
venisse interpretato invece che confrontato, il filtro non lo troverebbe — e il
test lo vedrebbe. Lo trova, su tutti e tre, e la tabella resta con le sue quattro
righe.

**Sensibilità verificata rompendo il codice di proposito**: rimettendo
l'interpolazione del valore nel testo al posto del parametro, 5 prove su 22
falliscono, fra cui «nessun valore ostile cambia la struttura della clausola»;
ripristinato il file, zero.

## Suite eseguite

`npm test` (esito 0) e, con i due container dedicati:

| suite | FAIL | baseline |
|---|---|---|
| `e2e.js` (MongoDB) | 4 | 4 |
| `e2e-mysql.js` | 2 | 2 |
| `e2e-postgres.js` | 3 | 3 |
| `e2e-query-engine.js` | 0 | 0 |
| `e2e-rbac.js` | 0 | 0 |
| `e2e-mcp.js` | 0 | 0 |

**Nessun fallimento nuovo.** Il filtro testuale funziona come prima: nessun
chiamante è ancora migrato, come chiede il ticket.
