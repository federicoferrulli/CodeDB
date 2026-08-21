# 15: La Split-View diventa chiamante della griglia

**Cosa costruire:** affiancare due tabelle nello stesso spazio di lavoro non fa più perdere
metà dell'applicazione. La Split-View usa il modulo comune e guadagna le sei capacità che
oggi non ha: virtualizzazione, paginazione a chiave, selezione delle celle, scorrimento
automatico ai bordi, pannello delle chiavi esterne, geometrie.

È la terza copia della griglia, ed è quella che fa **meno** delle altre due: chi apre una
Split-View su una tabella grande oggi vede disegnare tutte le righe in una volta, senza
essere avvisato di ciò a cui sta rinunciando.

La geometria dell'albero dei riquadri — come si dividono, si ridimensionano e si trascinano
— non è toccata da questo ticket: è già coperta da test propri e resta com'è.

**Bloccato da:** 13.

**Status:** in-progress — due punti su cinque chiusi, gli altri dichiarati sotto

- [x] La Split-View usa il modulo comune e la terza copia della griglia è rimossa
- [x] Su una tabella grande le righe sono virtualizzate: un test lo dimostra
- [ ] Selezione delle celle, scorrimento ai bordi, pannello delle chiavi esterne e geometrie funzionano nei riquadri — **NON fatto**, vedi sotto
- [x] Modifica ed eliminazione dentro un riquadro continuano a funzionare
- [x] I test sulla geometria dell'albero dei riquadri passano invariati

## Che cosa è stato fatto

La terza copia della griglia non c'è più: il ciclo che disegnava tutte le righe
è diventato `disegnaRigaRiquadro`, e il corpo lo scrive `disegnaCorpo` del
modulo comune con la finestra calcolata da `finestraVirtuale`. **La
virtualizzazione c'è**: su 3.000 righe un riquadro ne tiene in DOM 24, con gli
spaziatori che dichiarano il resto. Lo scorrimento ridisegna la finestra, e
l'ascoltatore si aggancia **una volta sola per riquadro** — `updatePaneUI` viene
richiamata a ogni pagina e a ogni modifica, e un secondo ascoltatore
raddoppierebbe il lavoro a ogni giro.

Le capacità sono dichiarate in `CAPACITA_RIQUADRO`, ed è lì che si legge — per
la prima volta in un posto solo — che cosa un riquadro sa fare e che cosa no.
Accese: virtualizzazione, selezione delle righe, modifica in linea.

## Che cosa NON è stato fatto, e perché

**Cinque capacità restano spente**: selezione delle celle, scorrimento
automatico ai bordi, pannello delle chiavi esterne, geometrie, paginazione a
chiave. Non è una svista ed è scritto nel codice, accanto a ciascuna.

Il motivo è lo stesso per tutte, ed è strutturale: quei quattro moduli non sono
parametrici. `cellselect.js` (1.300 righe) si aggancia a `#grid tbody`, cerca le
celle con `document.querySelectorAll('#grid tbody td[data-c]')` e legge i dati
da `state.docs`/`state.columns`, cioè dal Proxy che punta al tab attivo.
`scorrimento-bordo.js` lavora sulla `.grid-wrap`. `fk-vista.js` e le geometrie
assumono lo stesso contenitore unico. Un riquadro ha invece il proprio
contenitore (`.pane-grid-wrap`) e i propri dati (`p.docs`, `p.columns`), che non
sono quelli del tab attivo — in una Split-View con due riquadri su due
connessioni diverse, "il tab attivo" non identifica nemmeno il riquadro giusto.

Accenderle richiede quindi di **parametrizzare quei moduli su contenitore e
sorgente delle righe** — la stessa operazione fatta qui per il disegno del
corpo, ma su quattro moduli e con una superficie molto più grande (gestori di
puntatore, cattura, navigazione con le frecce, appunti). È un lavoro di
dimensione paragonabile all'intero lotto 13–15, non un residuo di questo
ticket, e farlo a metà lascerebbe una selezione che funziona nel riquadro a
fuoco e silenziosamente sul riquadro sbagliato negli altri — cioè peggio di non
averla.

**Va aperto un ticket separato per ciascuno dei quattro moduli da
parametrizzare.** Fino ad allora il ticket resta `in-progress`: chi apre una
Split-View oggi guadagna la virtualizzazione (il difetto che il ticket chiama
«fa meno delle altre due» nella sua forma più visibile, su una tabella grande),
ma le altre cinque capacità restano dichiaratamente assenti invece che assenti
in silenzio.

## Come è stato provato

`test/e2e-griglia-viste.js` (Chromium): costruisce nel browser un tab con 3.000
righe, apre una Split-View promuovendo la collection a primo riquadro e misura
il DOM prodotto — 24 righe su 3.000, spaziatori presenti con altezza dichiarata
maggiore di zero.

`test/unit-split-layout.js` (geometria dell'albero dei riquadri): **tutti
superati, invariati** — quel codice non è stato toccato.
`test/e2e-avvio-ui.js`: tutti superati. `npm test`: esito 0.

Modifica ed eliminazione dentro un riquadro non sono state toccate: i pulsanti
✎ e ✕ e il doppio clic sulla cella si costruiscono nella stessa funzione di
prima, ora chiamata una riga per volta dal modulo comune invece che da un ciclo
scritto a mano.
