# Coordinamento fra la issue 29 (Claude) e la issue 30 (Codex)

Le due issue toccano lo stesso file (`public/js/cellselect.js`) e la stessa
tabella delle capacità (`CAPACITA_RIQUADRO` in `public/js/splitview.js`). La 30
è **bloccata dalla 29**, quindi l'ordine è: prima passa la 29, poi la 30 parte
dal seme che la 29 lascia.

## Chi tocca che cosa

| File | 29 (Claude) | 30 (Codex) |
|---|---|---|
| `public/js/cellselect.js` | **riscrive**: da modulo agganciato a `#grid` a fabbrica `creaSelezioneCelle(aggancio)` | ritocca **solo** il blocco «Scorrimento automatico ai bordi» |
| `public/js/scorrimento-bordo.js` | non tocca | suo |
| `public/js/splitview.js` | aggiunge `data-r`/`data-c`, crea l'aggancio del riquadro, accende `selezioneCelle` | accende **solo** `scorrimentoAiBordi` |
| `public/css/style.css` | de-scopa `.cell-selected`/`.cell-focus` da `#grid` | non tocca |
| `test/e2e-selezione-celle-viste.js` | suo (nuovo) | non tocca |
| `test/e2e-tocco-griglia.js` | non tocca (deve passare invariato) | suo |

## Il seme che la 29 lascia alla 30

Dopo la 29, dentro `cellselect.js` il ciclo di scorrimento **non cerca più**
nulla: legge `aggancio.contenitore()` e `aggancio.thead()`, che il chiamante
fornisce. Quindi i primi due punti della 30

* «il ciclo di scorrimento riceve il contenitore invece di cercarlo»
* «le coordinate sotto l'intestazione `sticky` si calcolano dal contenitore
  ricevuto»

sono **già veri** a fine 29 — l'aggancio del riquadro Split-View restituisce
`.pane-grid-wrap` e il proprio `thead`. Alla 30 restano quindi le due cose che
la 29 dichiaratamente **non** fa:

1. la prova in Chromium che il gesto (dito + scorrimento automatico) funzioni
   **dentro un riquadro** e non solo nella vista Dati;
2. l'accensione di `scorrimentoAiBordi: true` in `CAPACITA_RIQUADRO`, che la 29
   lascia a `false` **con il commento che rimanda alla 30** — non per svista.

Se la 30 vuole anche estrarre il ciclo in un proprio strato DOM (per esempio
`scorrimento-bordo.js` che cresce di una funzione `agganciaScorrimento({...})`),
il punto di taglio è la coppia `passo()` / `aggiornaPuntatore()` di
`cellselect.js`: dipendono ormai solo da `contenitore()`, `bordo`,
`trascinamentoVivo()` e da una richiamata `suScorrimento()` — nient'altro del
modulo.

## Regola pratica

Chi arriva secondo fa `git pull`/rebase prima di iniziare: la 29 riscrive
`cellselect.js` per intero, e un merge su quel file scritto in parallelo
sarebbe da rifare a mano.

## Stato issue 30 (Codex)

Codex ha lasciato intatti i file condivisi finché la 29 non viene committata.
Il test Chromium reale della 30 è rosso e ha individuato il punto ancora da
correggere: durante lo scroll `updatePaneUI` svuota il `tbody` prima di salvare
la posizione, quindi il browser riporta `scrollTop` a zero. Dopo il commit della
29, la 30 preserverà la posizione durante il ridisegno, accenderà la capability
e chiuderà il test tattile nel riquadro.

---

## Stato: la 29 è ATTERRATA

`cellselect.js` è ora la fabbrica `creaSelezioneCelle(aggancio)`. Per la 30:

* `A.contenitore()` e `A.thead()` sono già i punti da cui il ciclo legge — nella
  vista Dati sono `.grid-wrap` e `#grid thead`, in un riquadro `.pane-grid-wrap`
  e il `thead` del riquadro (vedi `aggancioRiquadro` in `splitview.js`);
* `CAPACITA_RIQUADRO.scorrimentoAiBordi` è ancora `false`, con accanto il
  commento che rimanda alla 30: è la riga da cambiare;
* le celle di un riquadro portano già `data-r`/`data-c`, quindi
  `elementsFromPoint` trova la cella come nella vista Dati;
* `test/e2e-selezione-celle-viste.js` è nuovo e non tocca lo scorrimento:
  `test/e2e-scorrimento-bordi.js` e `public/js/scorrimento-bordo-dom.js` restano
  interamente della 30.

**Attenzione**: si lavora nello stesso working tree. Niente `git stash -u` —
porta via anche i file non tracciati dell'altro.
