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

**Status:** ready-for-agent

- [ ] Il modulo riceve contenitore e sorgente delle righe come argomenti
- [ ] La vista Dati continua a funzionare identica, provata dai test in Chromium esistenti
- [ ] Due griglie nella stessa pagina hanno selezioni indipendenti, provato da un test
- [ ] La capacità `selezioneCelle` di un riquadro Split-View si accende e il test lo dimostra
