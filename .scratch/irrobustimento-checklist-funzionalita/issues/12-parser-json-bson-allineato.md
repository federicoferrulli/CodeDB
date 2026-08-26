# 12: Allineare il parser JSON/BSON al motore di esecuzione

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** Un documento dichiarato valido dal lint deve usare soltanto costruttori
supportati dal motore e non deve perdere valori per chiavi duplicate ignorate.

- [ ] Parser, lint, formattatore e motore condividono il vocabolario dei costruttori BSON
- [ ] Un costruttore sconosciuto produce un errore con posizione
- [ ] Le chiavi duplicate vengono rilevate dopo la normalizzazione del nome
- [ ] Formattazione e minificazione continuano a preservare alla lettera i numeri grandi
- [ ] Test coprono costruttori ammessi, vietati e chiavi equivalenti duplicate
- [ ] La controprova che accetta qualunque identificatore rende rosso il test

