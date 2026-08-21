# 32: Le celle geometriche si disegnano in qualunque griglia

**Cosa costruire:** una cella che contiene una geometria si riconosce e si apre su mappa
anche in un riquadro della Split-View e — dove ha senso — nella tabella dei risultati.

Il riconoscimento (`geo-risultati.js`) e la vista (`geo-vista.js`) sono già moduli riusabili
e già usati da due chiamanti diversi: manca l'aggancio dalla cella di una griglia che non
sia quella della vista Dati.

**Bloccato da:** 13.

**Status:** ready-for-agent

- [ ] La resa di una cella geometrica è una funzione che una qualunque griglia può chiamare
- [ ] La capacità `geometrie` di un riquadro Split-View si accende, con un test
- [ ] La vista Dati si comporta come oggi
