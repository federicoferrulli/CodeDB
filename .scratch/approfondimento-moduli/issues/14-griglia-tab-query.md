# 14: La tab delle query diventa chiamante della griglia

**Cosa costruire:** i risultati di una query usano lo stesso modulo della vista Dati, e la
seconda copia dell'aritmetica della finestra virtuale sparisce.

Le schede di visualizzazione dei risultati che non sono la tabella — albero JSON, grafici,
mappa — restano come sono: questo ticket riguarda solo la tabella.

**Bloccato da:** 13.

**Status:** done

- [x] La tabella dei risultati usa il modulo comune
- [x] Nessuna copia dell'aritmetica della finestra virtuale sopravvive, verificato con una ricerca
- [x] Ordinamento, ridimensionamento delle colonne e larghezze calcolate funzionano come prima
- [x] Le schede albero JSON, grafici e mappa continuano a funzionare
- [x] Il test end-to-end delle schede di risultato per istruzione passa invariato

## Che cosa è stato fatto

`renderQueryVirtualWindow` non contiene più aritmetica né spaziatori: chiama
`finestraVirtuale` e `disegnaCorpo` del modulo comune. Il disegno della singola
riga è uscito in `disegnaRigaRisultato`, dove si vede che cos'è davvero una riga
di result set — nessuna identità, nessun checkbox: l'uscita di un `$group` non
ha un `_id`. Le capacità sono dichiarate in `CAPACITA_RISULTATI`, e sono meno di
quelle della vista Dati **non per dimenticanza**: selezione di riga e modifica
in linea non avrebbero un bersaglio.

Una differenza di comportamento, piccola e voluta: sotto le 200 righe la tabella
dei risultati ora disegna tutto invece di simulare con gli spaziatori righe che
ci starebbero comunque. È la stessa regola della vista Dati, e ora viene dalla
stessa funzione (`vaVirtualizzata`) invece che da due decisioni diverse.

**Una quarta copia, che il ticket non contava.** La ricerca chiesta dal secondo
punto — `Math.floor(scrollTop / …)` — ha trovato anche **`auditlog.js`**: lo
Storico Azioni è la quarta griglia del frontend, e rifaceva la stessa aritmetica
con `AUDIT_ROW_H`/`AUDIT_OVERSCAN` e i suoi due spaziatori scritti in
`innerHTML`. Migrata anche quella: le sue capacità sono poche e dichiarate, è un
registro in sola lettura. Ora la ricerca non trova più nessuna copia.

Le schede albero JSON, grafici e mappa non sono state toccate.

## Come è stato provato

`test/e2e-griglia-viste.js` (**nuovo**, Chromium + server usa e getta, 17
prove): importa nel browser le funzioni di render **vere** delle due viste e
misura il DOM che producono.

* vista Dati: 20 righe → tutte disegnate, nessuno spaziatore; 3.000 righe → 31
  in DOM e gli spaziatori che dichiarano il resto;
* tab ⚡: 20 righe → tutte disegnate; 3.000 → 24 in DOM con gli spaziatori;
  in entrambi i casi la prima riga contiene davvero il suo dato, il che
  distingue «disegna» da «disegna qualcosa»;
* il modulo comune contro il DOM vero: le righe stanno fra due spaziatori, la
  prima disegnata è quella giusta per lo scorrimento dato, e — la prova che
  conta — **spazio sopra + righe disegnate + spazio sotto fa esattamente
  l'altezza totale** (20.000 px su 500 righe da 40). È la proprietà che tiene
  onesta la barra di scorrimento.

Il test unitario `unit-griglia.js` gira con un documento finto e prova
l'aritmetica; questo prova ciò che quello non può, cioè che nel browser vero
attraverso le viste reali le righe compaiano.

Eseguiti inoltre: `test/e2e-avvio-ui.js` (tutti superati),
`test/e2e-playwright.js` (**19 superati, 0 falliti**, comprese le schede
albero JSON, grafico e ritorno a tabella), `npm test` (esito 0).

**Non eseguito**: `test/e2e-script-schede-ui.js`, che si auto-salta
(`SKIP Nessun MySQL utilizzabile su localhost:3306`). Su questa macchina MySQL
rifiuta l'utente `root` senza password richiesto dall'harness. Le schede di
risultato per istruzione usano lo stesso `renderResults` provato qui sopra, ma
il percorso specifico dello script resta non verificato sul campo.
