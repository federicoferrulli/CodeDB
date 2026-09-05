# 07: Rendere affidabili le aggregazioni dei grafici

Status: done
Type: task
Blocked by: 04: Preservare numeri esatti nell'editing inline

**What to build:** Grafici e aggregazioni devono mantenere l'esattezza richiesta dal tipo
oppure rendere visibile che il valore mostrato è un'approssimazione.

- [x] Long e Decimal vengono decodificati senza perdita preventiva di cifre
- [x] Somma, media, minimo e massimo conservano l'esattezza quando il tipo lo consente
- [x] Una conversione necessaria per il renderer mantiene il valore originale e mostra l'avviso
- [x] I suggerimenti automatici non classificano come sicura una serie numerica approssimata
- [x] Test coprono somme oltre 2^53 e decimali non rappresentabili in binario
- [x] La controprova con accumulo Number rende rosso almeno un test

