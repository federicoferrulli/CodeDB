# 19: I punti di estensione delle operazioni lunghe, dichiarati

**Cosa costruire:** gli otto punti che rendono speciale un'operazione lunga sono espliciti,
nominati e provati, invece di essere un'affermazione da riverificare a mano ogni volta che
qualcuno si chiede perché quell'evento non passa dalla giuntura dei dati.

Sono la terza famiglia di ADR-0001, ed è la loro esistenza a giustificarla:

1. rispondere prima che l'operazione finisca, e continuare a lavorare dopo la risposta;
2. emettere avanzamento durante l'esecuzione;
3. registrare un riferimento di annullamento che cambia nel tempo, anziché uno fissato
   all'ingresso — uno script ne cambia uno per istruzione;
4. leggere lo stato delle operazioni in corso senza registrarne una propria, che è il
   bisogno dell'evento di annullamento;
5. interrompere un'esecuzione che gira dentro CodeDB e non sul DBMS, e che quindi non si
   può fermare dal server del database;
6. decidere la categoria dell'audit a fine esecuzione anziché all'ingresso, perché su uno
   script interpretato la si conosce solo eseguendo;
7. verificare la capability per singola istruzione anziché per evento;
8. operare su stato di sessione che non è una strategia.

Ogni punto va reso un'estensione dichiarata della giuntura. Un'operazione lunga che non ne
usa nessuno non dovrebbe stare in questa famiglia: se ne emerge una, va spostata.

**Bloccato da:** 16.

**Status:** ready-for-agent

- [ ] Gli otto punti sono estensioni dichiarate, non comportamenti impliciti
- [ ] Ogni punto ha almeno un test che lo esercita attraverso l'interfaccia
- [ ] L'annullamento non entra più in conflitto con la registrazione dell'operazione in corso
- [ ] Pausa, ripresa, arresto e avanzamento di uno script funzionano da capo a fondo
- [ ] I test dell'esecutore di script, dell'annullamento delle query e delle schede di risultato passano invariati
