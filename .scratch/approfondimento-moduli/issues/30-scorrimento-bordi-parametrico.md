# 30: Lo scorrimento automatico ai bordi vale per qualunque contenitore

**Cosa costruire:** il gesto che fa scorrere il contenitore quando la selezione arriva al
bordo funziona su un riquadro della Split-View, non solo sulla `.grid-wrap` della vista
Dati.

Lo strato puro (`scorrimento-bordo.js`, la velocità) è già indipendente dal DOM ed è già
provato. Quello che non lo è: il ciclo `requestAnimationFrame` e la rilettura della cella
con `elementsFromPoint` vivono dentro `cellselect.js`, agganciati alla `.grid-wrap` unica.

**Bloccato da:** 29 (il gesto parte dalla selezione di celle).

**Status:** ready-for-agent

- [ ] Il ciclo di scorrimento riceve il contenitore invece di cercarlo
- [ ] Le coordinate sotto l'intestazione `sticky` si calcolano dal contenitore ricevuto
- [ ] `test/e2e-tocco-griglia.js` passa invariato sulla vista Dati
- [ ] Un test in Chromium dimostra lo stesso gesto dentro un riquadro Split-View
