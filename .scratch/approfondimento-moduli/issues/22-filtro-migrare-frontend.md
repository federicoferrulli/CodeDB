# 22: Migrare i chiamanti del frontend al filtro strutturato

**Cosa costruire:** la griglia e il pannello delle chiavi esterne compongono filtri
strutturati invece di frammenti di testo, e smettono di dover sapere quale motore riceverà
la richiesta.

Il pannello delle chiavi esterne è il caso più istruttivo: oggi il filtro con cui cerca le
righe riferite deve essere parametrizzato dentro ciascuna strategia, proprio perché quello
che gli arriva dal frontend è testo grezzo.

**Bloccato da:** 21.

**Status:** done

- [x] La griglia compone filtri strutturati
- [x] Il pannello delle chiavi esterne compone filtri strutturati
- [x] Nessun frammento di clausola è più costruito nel browser, verificato con una ricerca
- [x] Filtrare una griglia e cercare nell'elenco delle righe riferite funziona sui tre motori
- [x] I test end-to-end dei tre motori passano invariati

## La forma scelta: due modalità, non una casella sostituita

Il ticket dice «filtri strutturati **invece di** frammenti di testo». Applicato
alla lettera avrebbe tolto la possibilità di scrivere una `WHERE` arbitraria
nella vista Dati — una capacità vera per uno strumento da database. La forma
concordata è un'altra, e punta alla **velocità**:

La casella del filtro è ora un gruppo con un pulsante a sinistra che alterna
due modalità:

* **👁 Filtro rapido** (predefinita): si scrive del testo e si cerca in **tutte
  le colonne**. Il filtro viene composto nel browser come dato strutturato e
  ogni motore lo rende nel proprio dialetto parametrizzando. Chi scrive **non
  deve sapere quale motore ha davanti**, che è il difetto vero che il ticket
  descrive: prima la stessa casella voleva un documento MQL su MongoDB e un
  frammento `WHERE` sui due motori SQL;
* **Condizione**: la casella di prima, per chi vuole scrivere una `WHERE` o un
  documento MQL a mano.

Cambiare modalità **non riesegue** la query e **svuota** la casella: il testo
scritto per una modalità quasi mai ha senso nell'altra, e rieseguire mostrerebbe
un errore o — peggio — un risultato plausibile e sbagliato.

## Che cosa è stato migrato

**La griglia** (`public/js/grid.js`) manda ora il filtro secondo la modalità, in
**cinque** punti, che è il numero che conta: bastava dimenticarne uno per avere
una vista che filtra in un modo e un'altra in un altro.

| punto | perché non poteva restare indietro |
|---|---|
| la query della griglia | è il filtro |
| il **conteggio** disaccoppiato | un totale che non descrive le righe mostrate |
| lo **scorrimento infinito** | scorrendo comparirebbero righe che il filtro escludeva |
| il **piano di esecuzione** | spiegherebbe un'altra query |
| l'**eliminazione in blocco** | cancellerebbe in base a qualcosa che l'utente non ha mai visto |

L'ultimo era il più pericoloso: in modalità rapida il testo digitato è una
parola, e mandarlo come `filter` a `collection:deleteMany` l'avrebbe fatto
interpretare come una `WHERE`. Ora `collectionDeleteMany` compone la clausola
con lo stesso `buildSelect` della lettura, parametri compresi — cioè cancella
esattamente ciò che era a schermo.

**Il pannello delle chiavi esterne** (`public/js/fk-vista.js`) — «il caso più
istruttivo», dice il ticket — non usa più `relation:rows`. Chiede
`collection:find` con una condizione strutturata (`campo uguale valore` per la
riga riferita) e con il **filtro rapido** per l'elenco cercabile, che è
esattamente la stessa ricerca della griglia. Questo è ciò che permette al ticket
24 di cancellare il metodo separato.

**Verificato con una ricerca**: nessun frammento di clausola viene più costruito
nel browser, e `relation:rows` non compare più in alcun file di `public/js/`.

## Due difetti trovati collegando le due metà

1. **I valori tipizzati.** I valori del filtro viaggiano in Extended JSON come
   tutto il resto del protocollo: una data è `{ $date: … }`, un ObjectId
   `{ $oid: … }`. Passati al driver così com'erano venivano confrontati come
   **oggetti**, e una data non avrebbe mai trovato nulla — e il riferimento a un
   `_id` su MongoDB nemmeno, che avrebbe rotto il pannello 🔗 appena migrato.
   Ora tornano tipi nativi su tutti e tre i motori (`valoreNativo` su SQL,
   `EJSON.deserialize` + promozione degli ObjectId su MongoDB).
2. **Il LIKE su una colonna non testuale.** Su PostgreSQL `intero LIKE testo`
   non esiste come operatore e la query **fallisce** invece di non trovare
   nulla: la ricerca rapida sarebbe stata inutilizzabile su qualunque tabella
   con una colonna numerica. Il dialetto dichiara ora come si confronta una
   colonna come testo (`::text` su PostgreSQL, niente su MySQL — dove un CAST
   esplicito sposterebbe la collation del confronto, con l'errore 1267 che
   questo repo conosce bene).

## Come è stato provato

`test/unit-filtro-rapido.js` (15 prove, registrato in `test/unit.js`, senza
browser): la composizione, l'`_id` escluso (su MongoDB è un ObjectId e cercarvi
testo non trova mai nulla; su SQL è la chiave, che non si cerca a occhio), il
tetto di sei colonne (quaranta `LIKE` in OR a ogni battuta sarebbero corretti e
inutilizzabili), il testo vuoto che dà **nessun filtro** e non un filtro vuoto —
un filtro senza condizioni mostrerebbe tutte le righe facendo credere che la
ricerca non abbia trovato differenze — e che le due chiavi `filter` e `filtro`
**non partano mai insieme**.

Più la prova che le due metà combacino: ciò che il browser compone viene
normalizzato dal modulo del server e reso in SQL e in MQL senza lamentele.

`test/e2e-filtro-rapido-ui.js` (**nuovo**, Chromium, 15 prove): il pulsante
esiste, parte in modalità rapida con l'occhio, alterna cambiando icona,
segnaposto e svuotando la casella. E soprattutto, con un socket finto installato
nella pagina, si guarda **che cosa parte davvero**: in modalità rapida il filtro
strutturato e non il testo, in modalità condizione il testo e non il filtro.

**Sensibilità verificata rompendo il codice di proposito**: fatto mandare il
testo grezzo anche in modalità rapida, e unite le colonne in AND invece che in
OR, 4 prove su 15 falliscono; ripristinato il file, zero.

## Suite eseguite

`npm test` (esito 0) e, con i due container dedicati:

| suite | FAIL | baseline |
|---|---|---|
| `e2e.js` (MongoDB) | 4 | 4 |
| `e2e-mysql.js` | 2 | 2 |
| `e2e-postgres.js` | 3 | 3 |
| `e2e-filtro-strutturato.js` (tre motori) | 0 | — |
| `e2e-griglia-viste.js` | 0 | 0 |
| `e2e-avvio-ui.js` | 0 | 0 |
| `e2e-playwright.js` | 0 su 19 | 0 su 19 |

**Nessun fallimento nuovo.**

**Non provato sul campo, e va detto**: l'uso *interattivo* del pannello 🔗
migrato — aprirlo su una cella, cercare, scegliere un valore — non ha un test
in Chromium. Le sue due richieste sono coperte dai test del filtro sui tre
motori, e la pagina si carica senza errori, ma il gesto completo no.
