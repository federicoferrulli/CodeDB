# 29: La selezione di celle accetta il contenitore e i dati, invece di cercarli

**Cosa costruire:** `cellselect.js` riceve il contenitore della griglia e la sorgente delle
righe come dipendenze, invece di cercare `#grid tbody` e leggere `state.docs`.

Oggi la selezione di celle esiste **solo** nella vista Dati, e non per scelta: si aggancia
a `#grid tbody`, cerca le celle con `document.querySelectorAll('#grid tbody td[data-c]')` e
prende i dati dal Proxy `state`, che punta al tab attivo. Un riquadro della Split-View ha
invece il proprio contenitore (`.pane-grid-wrap`) e i propri dati (`p.docs`, `p.columns`) —
e in una Split-View con due riquadri su due connessioni diverse «il tab attivo» non
identifica nemmeno il riquadro giusto.

È il primo dei quattro moduli che il ticket 15 ha dovuto lasciare fuori, con la ragione
scritta lì: accendere la capacità a metà darebbe una selezione che funziona nel riquadro a
fuoco e scrive silenziosamente su quello sbagliato negli altri, cioè peggio di non averla.

**Bloccato da:** 13.

**Status:** done

- [x] Il modulo riceve contenitore e sorgente delle righe come argomenti
- [x] La vista Dati continua a funzionare identica, provata dai test in Chromium esistenti
- [x] Due griglie nella stessa pagina hanno selezioni indipendenti, provato da un test
- [x] La capacità `selezioneCelle` di un riquadro Split-View si accende e il test lo dimostra

## Che cosa è stato fatto

### L'aggancio

`creaSelezioneCelle(aggancio)` costruisce **un'istanza per griglia**. L'aggancio è
la typedef `AggancioSelezione` in testa a `cellselect.js`, e mette per iscritto
tutto ciò che il modulo prima andava a prendersi da solo: `tbody`, `thead()`,
`contenitore()`, `info()`, `righe()`, `colonne()`, `bersaglio()`, `stato()`,
`visibile()`, `contesto()`, `assicuraRiga()`, `ricarica()`, `modificaRiga()`,
`eliminaRighe()`, `motivoNoScrittura()`. Un aggancio incompleto è un **errore
all'aggancio**, con il nome del campo mancante: passarne uno a metà non deve
produrre una selezione che funziona finché non si tocca la voce sbagliata.

Il modulo si è diviso in due:

* **fuori dalla fabbrica** le funzioni che non conoscono alcuna griglia — i
  formati di copia, i letterali SQL, il parser degli appunti, `rectKeys`.
  Ricostruirle per istanza le avrebbe fatte sembrare parte dello stato;
* **dentro**, tutto il resto, con l'aggancio come **primo argomento**. Non è una
  chiusura che nasconde `A`: una funzione che dipende dalla griglia lo dichiara
  nella propria firma, e questo è ciò che rende ovvio, leggendo, quali funzioni
  sono legate a una griglia e quali no.

Anche `A.trascinando` e `A.seq` (il sequenziatore del riassunto asincrono) sono
passati **per istanza**: erano variabili del modulo, e con due griglie a schermo
un flag unico avrebbe saltato il riassunto della griglia ferma perché l'altra si
stava trascinando, e un sequenziatore unico avrebbe scartato le risposte di una
come «sorpassate» da quelle dell'altra.

### La centralina

Appunti, tastiera e movimento del mouse arrivano dal `document`: **non portano
scritto a quale griglia si riferiscono**. Finché la griglia era una sola la
domanda non esisteva. La regola è quella che l'utente si aspetta: comanda
l'ultima griglia **toccata**, finché resta visibile; se nessuna è stata ancora
toccata — Ctrl+A appena caricata la pagina, che funzionava e doveva continuare a
funzionare — comanda la prima visibile.

Gli ascoltatori su `document` sono **uno per il modulo**, non uno per istanza:
un riquadro che si chiude non ha alcun momento in cui qualcuno pensi a smontare
la sua selezione, quindi con un ascoltatore per riquadro se ne sarebbe accumulato
uno a ogni apertura. La potatura del registro è **per raggiungibilità**
(`tbody.isConnected`), l'unico modo che non si può dimenticare di chiamare.

### Il CSS

`#grid td.cell-selected` è diventato `td.cell-selected`, e le tre regole di
tocco (`user-select`, `touch-callout`, `touch-action`) sono passate da
`#grid tbody` a `tbody.selezione-celle`, classe che `creaSelezioneCelle` mette
sul `tbody` che aggancia. Senza, la capacità accesa in un riquadro sarebbe stata
funzionante ma **invisibile**, e col dito la cella selezionata avrebbe continuato
a far scorrere la tabella invece di allargare la selezione.

### La Split-View

`CAPACITA_RIQUADRO.selezioneCelle` è **accesa**. Il riquadro ha il suo
`aggancioRiquadro(paneId, paneEl, p)`, le sue celle portano `data-r`/`data-c` (la
riga è l'indice ASSOLUTO in `p.docs`, non quello della finestra virtuale, perché
la selezione deve sopravvivere al ridisegno) e le intestazioni `data-c` per il
Ctrl+clic sulla colonna. Il bersaglio delle scritture è il riquadro e non il tab
attivo (CDB-A18): in una Split-View su due connessioni i due non coincidono
affatto.

L'istanza si crea una volta per riquadro e si ricrea se il `tbody` cambia — il
confronto è sull'elemento e non su «esiste già», perché `renderSplitView`
ricostruisce il DOM e un'istanza agganciata al `tbody` di prima resterebbe viva
puntando a un elemento staccato: una selezione che non risponde più e che nulla
segnala.

## Che cosa NON è stato fatto, e perché

`scorrimentoAiBordi` resta **spenta** per i riquadri. Il ciclo riceve ormai il
contenitore giusto (`A.contenitore()`) e l'intestazione giusta (`A.thead()`),
quindi tecnicamente funzionerebbe — ma nessun test lo dimostra dentro un
riquadro, e una capacità dichiarata su una parola invece che su una prova è
esattamente ciò che l'inventario delle capacità esiste per non fare. È il
perimetro della **issue 30**, in lavorazione in parallelo; il confine fra le due
è scritto in `.scratch/approfondimento-moduli/COORDINAMENTO-29-30.md`.

Restano spente anche `chiaviEsterne` e `geometrie`: quei moduli (`fk-vista.js`,
le geometrie) sono ancora agganciati a `#grid` e allo `state` del tab attivo.
Sono i ticket successivi dei quattro annunciati dal 15.

## Come è stato provato

`test/e2e-selezione-celle-viste.js` (Chromium, **28 prove**, senza database):

* **due griglie finte nella stessa pagina**: un trascinamento su una seleziona
  6 celle, l'altra resta a zero — sia nello stato sia nelle celle *dipinte*;
* **lo smistamento della tastiera**: Ctrl+A va alla griglia toccata per ultima, e
  toccando l'altra il comando passa davvero a lei senza toccare la prima;
* **il riquadro Split-View vero**: le celle portano le coordinate, il
  trascinamento seleziona il rettangolo, una sola cella ha il fuoco, la
  selezione **sopravvive al ridisegno** e il menu contestuale si apre lì dentro;
* **il CSS che morde**: non le classi, lo **stile calcolato** — la cella scelta
  ha uno sfondo diverso dalle altre e `touch-action: none`. Sono le due cose che
  il de-scoping da `#grid` doveva ottenere, e che le classi da sole non provano;
* **il BERSAGLIO delle scritture**, che è il difetto chiamato per nome dalla
  issue. Non basta leggere il codice: si costruisce la condizione vera — un
  riquadro su una connessione **diversa** da quella del tab attivo — si incolla
  davvero dalla voce di menu «Incolla», e si guarda con un socket finto
  (`impostaSocket`) che cosa è partito. Il `doc:update` porta il `db`, la `coll`
  e il `tabId` del RIQUADRO mentre `state` ne dichiara altri;
* **la modifica inline del riquadro**, che il de-scoping poteva rompere: doppio
  clic, editor aperto, e il testo ancora selezionabile dentro la cella;
* **la vista Dati invariata**: stesso trascinamento, stato ancora in
  `state.cellSel`, `applyCellSelection()` senza argomenti che ridipinge come la
  chiama `grid.js`, e il `tbody` marcato `.selezione-celle`.

**Sensibilità verificata rompendo il codice di proposito**, in due passate:

1. tre rotture insieme — celle cercate su tutto il `document`, nessuno che prende
   il comando al clic, selezione non riapplicata dopo il disegno del riquadro →
   **3 prove falliscono**, e sono le tre giuste;
2. le due protezioni aggiunte dopo la revisione — l'eccezione `td.editing`
   rimessa su `#grid`, e il contesto del riquadro che torna a leggere il tab
   attivo → **4 prove falliscono**, fra cui *«la scrittura va sulla tabella del
   RIQUADRO»*, che riporta `db_del_tab_attivo.tabella_del_tab_attivo`: la
   scrittura silenziosa sulla tabella sbagliata, riprodotta e colta.

Ripristinato il codice, zero fallimenti in entrambi i casi.

Test esistenti, eseguiti e **tutti superati invariati**: `npm test`,
`test/e2e-avvio-ui.js`, `test/e2e-tocco-griglia.js` (compresi i due casi sul
gesto tattile che toccano proprio questo codice), `test/e2e-griglia-viste.js`,
`test/e2e-palette.js`, `test/e2e-filtro-rapido-ui.js`,
`test/unit-split-layout.js`.

`test/e2e-playwright.js` riporta **10 superati / 1 fallito**: il fallimento è
l'apertura della connessione salvata `mongodb_locale`, che richiede un MongoDB
in ascolto. **Verificato preesistente**: stesso 10/1 sul codice senza queste
modifiche.

## Che cosa ha cambiato la revisione

`/code-review` su due assi ha prodotto rilievi veri, tutti chiusi:

* **`ambito` è un termine VIETATO dal glossario** (`CONTEXT.md:114`, riservato
  come sinonimo da evitare di *Scope*, il perimetro di un'autorizzazione).
  Rinominato ovunque in **`aggancio`** — il concetto è dove il modulo si attacca,
  non un perimetro di permessi;
* **`user-select: text` sulla cella in modifica era rimasta su `#grid`** mentre
  `user-select: none` era passato a `tbody.selezione-celle`. Un riquadro ha
  `modificaInline` acceso: la sua cella in modifica avrebbe perso la selezione
  del testo. Corretta la classe, e aggiunta la prova;
* **eliminare N righe dal menu del riquadro chiedeva N conferme** e faceva N
  riletture, perché l'eliminazione singola veniva chiamata in un ciclo. Estratta
  `eliminaRigheRiquadro`, che è ora anche il percorso del pulsante 🗑 esistente:
  la classe, non l'istanza;
* **le colonne del riquadro venivano ricalcolate** (`new Set(docs.flatMap(...))`)
  a ogni cella selezionata, e potevano non coincidere con quelle davvero
  disegnate — cioè `data-c` avrebbe indicizzato un altro elenco. Ora la
  selezione legge `p.colonneMostrate`, scritta da chi disegna;
* **la validazione dell'aggancio passava su `null`**, esplodendo poi senza dire
  quale campo mancasse. Ora `== null`, con il nome del campo e della griglia;
* `nome` era un campo morto, ora compare nel messaggio d'errore; `righe()` e
  `colonne()` erano letti dentro il ciclo su ogni cella; l'istanza si registrava
  prima di essere completa; il vocabolario dello smistamento mescolava due
  metafore (`alTimone`/`comanda`).

Il solo rilievo **non** chiuso è l'alias locale `const contenitore = () => …`
dentro il blocco dello scorrimento ai bordi: è una pura indirezione, ma quel
blocco è il perimetro della issue 30, in lavorazione in parallelo — toglierlo
adesso creerebbe un conflitto sul lavoro di un altro senza alcun guadagno.
