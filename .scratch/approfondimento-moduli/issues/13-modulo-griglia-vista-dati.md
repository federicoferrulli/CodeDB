# 13: Modulo unico della griglia, con la vista Dati come chiamante

**Cosa costruire:** esiste un modulo che riceve righe, colonne e le capacità richieste e
restituisce la griglia; la vista Dati funziona esattamente come oggi, ma attraverso di esso.

Oggi la griglia dei risultati è implementata tre volte — nella vista Dati, nella tab delle
query e nella Split-View — con capacità diverse e nessuna giuntura comune. Due delle tre
calcolano la finestra virtuale con la stessa aritmetica, nomi di variabile compresi.

Questo ticket porta il modulo e **un solo** chiamante: è la fetta che dimostra che
l'interfaccia regge prima di portarci sopra le altre due viste.

Le capacità che oggi ha solo la vista Dati — virtualizzazione, paginazione a chiave,
selezione delle celle, scorrimento ai bordi, pannello delle chiavi esterne, geometrie,
modifica inline — diventano opzioni della stessa interfaccia, non implementazioni separate.

**Bloccato da:** 11.

**Status:** ready-for-agent

- [ ] La vista Dati usa il modulo e si comporta come prima, senza differenze visibili
- [ ] Il modulo ha test che girano senza server, resi possibili dal ticket 11
- [ ] Le capacità sono opzioni dichiarate all'interfaccia, non rami interni impliciti
- [ ] Il gesto tattile e lo scorrimento automatico ai bordi continuano a funzionare, provati dal test in Chromium esistente
- [ ] La modifica inline, l'inserimento e la selezione di celle funzionano come prima
