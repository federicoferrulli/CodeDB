# 24: Contrarre — via il filtro testuale e il firewall sintattico

**Cosa costruire:** il filtro testuale non esiste più, e con esso le circa 460 righe di
analisi sintattica difensiva che esistevano soltanto perché quel testo attraversava
l'interfaccia della strategia.

Sparisce anche il metodo separato per leggere le righe riferite da una chiave esterna: era
un metodo a sé **dichiaratamente** perché sui motori SQL il filtro era un frammento grezzo
interpolato tal quale. Tolta la causa, rientra nel metodo comune e l'interfaccia si accorcia.

È il ticket che incassa il guadagno dell'intero lotto: finché il filtro testuale vive
accanto a quello strutturato, il costo è pagato e il beneficio no.

Attenzione: l'analisi sintattica difensiva va rimossa **solo** per la parte che serviva ai
filtri. Ciò che protegge l'esecuzione di query libere scritte dall'utente resta: quella
superficie non è toccata da questo lotto.

**Bloccato da:** 22, 23.

**Status:** in-progress — la contrazione è fatta per tutto ciò che era ancora vero; i primi due punti sono superati da una decisione presa sulla 22 e vanno riscritti (vedi sotto)

- [ ] Nessun chiamante passa più un filtro testuale, e le strategie non lo accettano più — **premessa superata**, vedi sotto
- [ ] L'analisi sintattica difensiva dei filtri è rimossa; quella delle query libere resta — **conseguenza del punto precedente**
- [x] Il metodo separato per le righe riferite non esiste più e la sua funzione è nel metodo comune
- [x] Un test dimostra che una query libera fuori dallo scope viene ancora negata
- [x] I test di autorizzazione, del gateway e i test end-to-end dei tre motori passano invariati

## La premessa dei primi due punti non è più vera

Il ticket parte da qui: «finché il filtro testuale vive accanto a quello
strutturato, il costo è pagato e il beneficio no». Era giusto quando il lotto è
stato scritto — allora il filtro testuale era **l'unica** via, e quella soltanto.

Lavorando la 22 è emersa una scelta di prodotto diversa, ed è stata presa: la
casella del filtro della griglia ha ora **due modalità**, e quella testuale è
diventata la modalità «condizione», dichiarata, con la sua icona e il suo
segnaposto. Non è più il modo in cui si filtra: è il modo in cui si scrive una
`WHERE` arbitraria quando serve, che su uno strumento da database è una
capacità vera e che togliere sarebbe una perdita.

Con quella scelta, i primi due punti di questo ticket chiedono di cancellare una
funzionalità **appena decisa**. Non li ho eseguiti, e non li ho nemmeno
reinterpretati per farli quadrare: sono superati, e vanno riscritti da chi
possiede la decisione.

**Il firewall sintattico (`auth/sqlClause.js`) resta quindi al suo posto**, e
non per inerzia: finché un sottoutente con uno scope può scrivere una `WHERE` a
mano, quelle righe sono l'unica cosa che gli impedisce di uscire dal perimetro.
Toglierle avrebbe aperto un buco, non incassato un guadagno.

**Che cosa resta da fare, quando la decisione sarà presa.** Se la modalità
«condizione» venisse un giorno tolta o riservata a chi non ha scope, il firewall
diventerebbe superfluo e la contrazione si potrebbe completare. Il ticket 23 ha
già provato la proprietà che la autorizza: con il filtro strutturato, uscire
dallo scope **non è esprimibile**.

## Che cosa è stato invece contratto

**Il metodo separato per le righe riferite non esiste più.** Era un metodo a sé
*dichiaratamente* perché sui motori SQL il filtro era un frammento grezzo
interpolato: tolta la causa (il pannello 🔗 usa il filtro strutturato dal ticket
22), è rientrato nel metodo comune.

Sono sparite **202 righe di metodo** più il loro contorno:

| dove | che cosa |
|---|---|
| `db/MongoDbStrategy.js` | `relatedRows` (57 righe) |
| `db/MySqlStrategy.js` | `relatedRows` (63) |
| `db/PostgreSqlStrategy.js` | `relatedRows` (66) |
| `db/DbStrategy.js` | la dichiarazione del metodo (16) |
| `server.js` | l'evento `relation:rows` e la sua voce di audit |
| `auth/capabilities.js` | la capability dell'evento e la voce del metodo |
| `auth/guardStrategy.js` | il caso speciale che il metodo richiedeva |
| `db/tetti.js` | il tetto di 200 righe che valeva solo per lui |

L'interfaccia delle strategie si è accorciata di un metodo, e la tabella delle
autorizzazioni di due voci.

## Le due difese che stavano per sparire con lui

Questa è la parte che vale la pena raccontare, perché il difetto era pronto a
succedere e a non farsi vedere.

`relatedRows` aveva due protezioni proprie, provate da `test/unit-rbac.js`:

1. il suo `colonna` non poteva essere un **operatore** MongoDB — `$where`,
   `profilo.$expr` — perché sarebbe diventato esecuzione di JavaScript sul
   server travestita da nome di campo;
2. il suo `valore` non poteva **portarne** uno.

Cancellando il metodo, quelle due difese sarebbero sparite con lui — mentre la
superficie che proteggevano si era solo **spostata**: ora è il filtro
strutturato a ricevere un nome di campo e un valore dal client. I test RBAC
hanno fatto esattamente il loro lavoro, diventando rossi.

Le difese sono venute dietro, nel posto giusto:

* `normalizzaFiltro` rifiuta un `campo` con un segmento vuoto o che comincia per
  `$`, con un messaggio che spiega perché («su MongoDB sarebbe un operatore, non
  un campo»);
* `MONGO_SERVER_JS_FIELDS` include ora `filtro` accanto a `filter` per tutti i
  metodi che lo accettano: i **valori** passano dallo stesso divieto;
* il Proxy autorizzante **normalizza sempre** il filtro strutturato, per chiunque
  e su ogni motore — root compreso, perché un nome di campo che diventa un
  operatore non è un permesso negato, è un'invariante. E lo fa **prima** di
  toccare il database, non dentro l'adattatore.

## Come è stato provato

I test che coprivano `relatedRows` sono stati **riscritti sulla via nuova**, non
cancellati: `test/e2e.js`, `test/e2e-mysql.js` e `test/e2e-postgres.js` chiedono
ora le righe riferite con `collection:find` e un filtro strutturato — cioè
provano il percorso che il pannello 🔗 usa davvero, che è copertura migliore di
prima. E ognuno dei tre ha guadagnato due prove nuove: il campo con prefisso
`$` rifiutato prima del database, e il valore con `$where` rifiutato.

In `test/unit-rbac.js` le cinque asserzioni su `relatedRows` sono diventate
cinque asserzioni sul filtro strutturato, compresa quella positiva: un percorso
annidato legittimo (`cliente._id`) deve continuare a passare.

Che una **query libera** fuori dallo scope venga ancora negata è provato da
`test/unit-filtro-autorizzazione.js` («il filtro TESTUALE conserva il suo
firewall») e dalle asserzioni già esistenti di `unit-rbac.js` su SQL Raw.

## Suite eseguite

`npm test` (esito 0) e, con i due container dedicati:

| suite | FAIL | baseline |
|---|---|---|
| `e2e.js` (MongoDB) | 4 | 4 |
| `e2e-mysql.js` | 2 | 2 |
| `e2e-postgres.js` | 3 | 3 |
| `e2e-rbac.js` | 0 | 0 |
| `e2e-rbac-mcp.js` | 0 | 0 |
| `e2e-mcp.js` | 0 | 0 |
| `e2e-mcp-mysql.js` | 1 | 1 |
| `e2e-backup.js` | 0 | 0 |
| `e2e-query-engine.js` | 0 | 0 |
| `e2e-filtro-strutturato.js` | 0 | — |
| `e2e-nulli-ordinati.js` | 0 | — |
| `e2e-osservazione.js` | 0 | — |

**Nessun fallimento nuovo.**
