# 13: Modulo unico della griglia, con la vista Dati come chiamante

**Cosa costruire:** esiste un modulo che riceve righe, colonne e le capacità richieste e
restituisce la griglia; la vista Dati funziona esattamente come oggi, ma attraverso di esso.

Oggi la griglia dei risultati è implementata tre volte — nella vista Dati, nella tab delle
query e nella Split-View — con capacità diverse e nessuna giuntura comune. Due delle tre
calcolano la finestra virtuale con la stessa aritmetica, nomi di variabile compresi.

Questo ticket porta il modulo e **un solo** chiamante: è la fetta che dimostra che
l'interfaccia regge prima di portarci sopra le altre due viste.

Le capacità che oggi ha solo la vista Dati — virtualizzazione, paginazione a chiave,
selezione delle celle, scorrimento ai bordi, pannello delle chiavi esterne, geometrie,
modifica inline — diventano opzioni della stessa interfaccia, non implementazioni separate.

**Bloccato da:** 11.

**Status:** done

- [x] La vista Dati usa il modulo e si comporta come prima, senza differenze visibili
- [x] Il modulo ha test che girano senza server, resi possibili dal ticket 11
- [x] Le capacità sono opzioni dichiarate all'interfaccia, non rami interni impliciti
- [x] Il gesto tattile e lo scorrimento automatico ai bordi continuano a funzionare, provati dal test in Chromium esistente
- [x] La modifica inline, l'inserimento e la selezione di celle funzionano come prima

## Che cosa è stato fatto

`public/js/griglia.js` non è una griglia "generica" che prova a fare tutto: è
ciò che le tre viste hanno **davvero** in comune e che nessuna dovrebbe rifare.

* **`finestraVirtuale(...)`** — quali righe stanno nella finestra visibile e
  quanto spazio lasciare sopra e sotto. È l'aritmetica che stava scritta due
  volte, in `grid.js` e in `query-tab.js`, con le stesse operazioni e nomi di
  variabile diversi (`OVERSCAN`/`QUERY_OVERSCAN`, `rowH`/`QUERY_ROW_H`).
  Funzione pura, senza DOM;
* **`disegnaCorpo(...)`** — le righe della finestra fra i due spaziatori, in un
  frammento attaccato una volta sola. Il disegno della **singola riga** arriva
  da fuori (`disegnaRiga(riga, indice)`): è ciò che cambia davvero fra le tre
  viste — documenti con `_id` e checkbox, righe di un result set senza identità,
  celle modificabili o no — e assorbirlo qui vorrebbe dire un ramo per ciascuna,
  cioè il modulo superficiale che questo lotto esiste per non fare;
* **`capacita({...})`** — le otto capacità, dichiarate all'interfaccia. Il
  valore non è tecnico ma di inventario: prima le tre copie avevano capacità
  diverse e non esisteva un posto in cui leggerlo, quindi «la Split-View non
  virtualizza» era una cosa che si scopriva usandola. Un nome sconosciuto è un
  **errore**, non un'opzione ignorata: `selezioneCelleAttiva: true` non deve
  poter lasciare `selezioneCelle` spenta per sempre in silenzio;
* **`vaVirtualizzata(...)`**, **`spaziatore(...)`**, **`scorrimentoPerRiga(...)`**
  — quest'ultima restituisce `null` quando la riga è già visibile, perché
  toccare lo scorrimento farebbe sobbalzare la griglia a ogni freccia.

La vista Dati (`grid.js`) è il chiamante: dichiara le sue otto capacità in
`CAPACITA_DATI`, e i suoi tre punti di disegno — render classico, finestra
virtuale, `ensureRowRendered` — passano dal modulo. La sua `spacer()` locale è
sparita.

## Che cosa NON è stato spostato, e perché

`buildRow`/`buildHead` restano in `grid.js`. Sono 200 righe che conoscono
`state`, la selezione di celle, l'editor inline, il pannello delle chiavi
esterne e le geometrie: portarle nel modulo comune significherebbe portarci
anche quelle dipendenze, e il modulo smetterebbe di essere caricabile in un
test — cioè perderebbe la proprietà che lo rende utile. Restano fuori anche la
paginazione, il piè di pagina e le azioni di eliminazione, che sono della vista
e non della griglia.

## Come è stato provato

`test/unit-griglia.js` (16 prove, registrato in `test/unit.js`), **senza server
e senza browser** — è ciò che il ticket 11 ha reso possibile. Al posto del DOM
c'è un documento finto: non si sta provando il DOM, si sta provando chi lo usa.

La prova che vale più delle altre è sugli **spazi**: per sei posizioni di
scorrimento diverse si verifica che `spazioSopra + righe disegnate + spazioSotto`
faccia esattamente l'altezza totale. È la proprietà che tiene onesta la barra di
scorrimento — se non torna, la barra dichiara una lunghezza e il contenuto ne ha
un'altra. Più i casi limite: cima, fondo, zero righe (nessuna divisione per
zero), soglia esatta, nessuno spaziatore da zero pixel, e il corpo **sostituito**
e non accodato (sbagliarlo raddoppia la tabella).

**Sensibilità verificata rompendo il codice di proposito**: tolto il margine di
overscan dall'indice iniziale, tolto lo spaziatore inferiore e tolto il
controllo sui nomi delle capacità, 4 prove su 16 falliscono; ripristinato il
file, zero.

Eseguiti in Chromium contro un server vero:

* `test/e2e-avvio-ui.js` — nessun errore JavaScript, griglia nel DOM, selezione
  di celle agganciata, trascinamento funzionante;
* `test/e2e-tocco-griglia.js` — **tutti superati**, compresi «la finestra
  virtuale è stata ricostruita durante il gesto» e «la riga sotto al dito
  avanza con lo scorrimento», che sono esattamente il codice toccato qui;
* `test/e2e-playwright.js` — **19 superati, 0 falliti**.

`npm test` passa (esito 0); `test/e2e.js` riporta i soliti 4 fallimenti
preesistenti.
