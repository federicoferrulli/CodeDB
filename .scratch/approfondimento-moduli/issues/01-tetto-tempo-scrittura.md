# 01: Tetto di tempo sull'esecuzione in scrittura

**Cosa costruire:** una query aggregata eseguita in scrittura viene interrotta dal tetto di
tempo esattamente come già accade per una eseguita in lettura, su entrambi i motori SQL.
Oggi il tetto vale solo sul ramo di sola lettura, quindi una query di scrittura sbagliata
tiene occupata una connessione senza limite.

Il valore non è più un numero scritto nel corpo del metodo: viene letto dalla stessa fonte
configurabile che governa gli altri tetti dell'interfaccia della strategia.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** ready-for-agent

- [ ] Esiste un test che dimostra l'assenza del tetto sul ramo di scrittura e che **fallisce prima** della correzione, su entrambi i motori SQL
- [ ] Dopo la correzione il test passa e il tetto vale su entrambi i rami dei due motori
- [ ] Il valore del tetto proviene dalla fonte configurabile dell'interfaccia della strategia, non da una costante ripetuta
- [ ] Cambiare la configurazione cambia il comportamento osservato in un test
- [ ] Il comportamento su MongoDB resta invariato
