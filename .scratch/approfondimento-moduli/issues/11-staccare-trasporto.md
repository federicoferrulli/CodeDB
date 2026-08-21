# 11: Staccare il trasporto dal sacco di utilità

**Cosa costruire:** il modulo che manda gli eventi al server esce dal sacco di funzioni di
utilità del frontend e diventa un modulo suo, con il socket **accettato** come dipendenza
invece che creato al momento in cui il modulo viene importato.

Oggi due moduli convivono in un file solo: uno superficiale — una quarantina di funzioni
scorrelate, dai toast alle icone alle modali — e uno profondo, il trasporto, che assorbe la
riconnessione delle sole connessioni salvate, l'annullamento su tab chiuso e la marcatura
dell'origine della risposta. Il secondo è invisibile perché sepolto nel primo, e importarlo
tira dentro tutto il resto.

È il socket creato al caricamento, non lo stacco in sé, a chiudere il ciclo di import che
rende non caricabili in prova quasi tutti i file grandi del frontend: entrambe le cose vanno
fatte in questo ticket, altrimenti il ciclo resta.

Il precedente esiste già in casa: il modulo dei valori è stato staccato e ri-esportato
proprio perché chi ha bisogno solo di quello non debba caricare l'intera applicazione.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** done

- [x] Il trasporto è un modulo proprio, importabile senza tirarsi dietro toast, modali e icone
- [x] Il socket è accettato come dipendenza, non creato al caricamento del modulo
- [x] Almeno un modulo grande del frontend che prima non era caricabile in prova ora lo è, dimostrato da un test che lo importa
- [x] L'applicazione si avvia senza errori, provato dal test di avvio dell'interfaccia
- [x] Nessun comportamento visibile all'utente è cambiato

## Che cosa è stato fatto

`public/js/trasporto.js` è il modulo nuovo: `emit`, `emitFireAndForget`,
`isForActiveTab`. Dietro tre nomi ci stanno tre decisioni che nessun chiamante
deve rifare — a quale tab appartiene la richiesta, quando riconnettere, quando
annullare — ed erano sepolte fra una quarantina di funzioni scorrelate.
`utils.js` le **ri-esporta**, quindi i quarantasette moduli che le importavano
da lì non sono stati toccati: è la stessa scelta già fatta per `valori.js`.

**Il socket si accetta, non si crea.** `socket.js` non chiama più `io(…)`
all'atto dell'import: lo apre alla prima usata, dietro un rimando che lascia
scritte come prima tutte le `socket.emit(…)` del frontend. `impostaSocket(finto)`
è il punto in cui un test mette il proprio, ed è ciò che rende possibile il
ticket 12.

**Tre catene di import spezzate**, tutte della stessa specie: qualcosa che gira
al *caricamento* del modulo e che esiste solo nel browser.

1. `io(…)` in socket.js — la creazione del socket, come da ticket;
2. `document.addEventListener(…)` in utils.js, tre righe che chiudono il menu
   contestuale. Ora sotto `if (typeof document !== 'undefined')`: nella pagina
   non cambia nulla, fuori è la differenza fra caricabile e no;
3. `localStorage.getItem(…)` in connmanager.js, letto al primo livello del
   modulo per sapere quali cartelle della sidebar sono chiuse. Ora con la stessa
   lettura difensiva che `migraChiave`, due righe più sopra, già faceva.

**Una dipendenza invertita.** `tabs.js` importava `markAbandonedByTab` da
`pending-queries.js`, e quell'unica riga tirava dentro un pannello
dell'interfaccia — che a sua volta tira dentro la tab delle query, i coll-tab e
l'esecutore di script, cioè l'intera applicazione. Un modulo di base, che dice
soltanto quali tab esistono e quale è attivo, non può dipendere da un pannello:
è il verso sbagliato. Ora `tabs.js` espone `allaChiusura(fn)` e il pannello si
annuncia da sé. (`safeUUID` viene preso da `valori.js`, dove sta davvero,
invece che da `utils.js` che lo ri-esporta.)

**`toast` è uscito in `avvisi.js`**, modulo foglia senza import: il trasporto ne
ha bisogno per dire che una riconnessione è riuscita o fallita, e importare per
questo l'intero `utils.js` avrebbe rimesso in piedi il ciclo. `utils.js` lo
ri-esporta, quindi i 31 moduli che lo importavano da lì non cambiano.

## Che cosa è caricabile ora, e che cosa no

Prima: **nessun** modulo che risalisse a `socket.js`, cioè quasi tutto il
frontend. Ora caricano fuori dal browser: `trasporto.js`, `socket.js`,
`avvisi.js`, `tabs.js`, `state.js`, `utils.js` (1084 righe, importato da 47
moduli), `uml.js`, `details.js`.

Non caricano ancora `grid.js`, `query-tab.js`, `main.js`, `cellselect.js`,
`splitview.js`, `connmanager.js`, `inlineEdit.js`: **si fermano su
`window is not defined`**, cioè su altri effetti al caricamento della stessa
specie dei tre chiusi qui. Non li ho inseguiti: sono fuori dal perimetro di
questo ticket, e chiuderli uno per uno senza un criterio è il modo di non
finirli mai. Va detto invece che il ticket 13, che porta la griglia in un modulo
suo, li incontrerà.

## Come è stato provato

`test/e2e-avvio-ui.js` (Chromium + server usa e getta): la UI si carica senza un
solo errore JavaScript, la griglia è nel DOM, la selezione di celle è agganciata
e il trascinamento funziona. È il test che copre esattamente il rischio di
questo ticket — un `ReferenceError` dentro un `init*`, invisibile a un controllo
di sintassi. `npm test` passa (esito 0); `test/e2e.js` riporta i soliti 4
fallimenti preesistenti.

Il comportamento visibile all'utente non cambia: nessuna funzione è stata
riscritta, solo spostata, e i punti d'importazione storici continuano a
funzionare.
