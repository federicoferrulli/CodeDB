# 07: Rendere affidabili le aggregazioni dei grafici

Status: ready-for-agent
Type: task
Blocked by: 04: Preservare numeri esatti nell'editing inline

**What to build:** Grafici e aggregazioni devono mantenere l'esattezza richiesta dal tipo
oppure rendere visibile che il valore mostrato è un'approssimazione.

- [ ] Long e Decimal vengono decodificati senza perdita preventiva di cifre
- [ ] Somma, media, minimo e massimo conservano l'esattezza quando il tipo lo consente
- [ ] Una conversione necessaria per il renderer mantiene il valore originale e mostra l'avviso
- [ ] I suggerimenti automatici non classificano come sicura una serie numerica approssimata
- [ ] Test coprono somme oltre 2^53 e decimali non rappresentabili in binario
- [ ] La controprova con accumulo Number rende rosso almeno un test

