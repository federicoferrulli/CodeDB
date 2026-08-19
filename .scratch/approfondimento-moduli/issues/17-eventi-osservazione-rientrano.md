# 17: I quattro eventi di osservazione rientrano nella giuntura dei dati

**Cosa costruire:** i due eventi che mettono in osservazione una collezione e uno schema, e
i due che la tolgono, passano dalla giuntura che delega a una strategia, invece di rifare a
mano la ricerca della sessione con lo stesso messaggio d'errore copiato.

Sono i **quattro soli** candidati puri fra i quarantotto eventi registrati per la via
generica: la classificazione ha mostrato che gli altri quarantaquattro hanno un motivo che
regge, e la decisione di non ricondurli tutti dentro è registrata in ADR-0001.

Passando dalla giuntura guadagnano la riconnessione automatica, che oggi non hanno: un
evento di osservazione su una connessione caduta non riprova.

Attenzione a due dettagli emersi dalla classificazione: i due eventi che tolgono
l'osservazione non hanno una capability associata, e sono registrati con un handler che non
risponde. Entrambe le cose vanno risolte perché il passaggio non neghi l'operazione ai
sottoutenti né lasci il client in attesa.

**Bloccato da:** 16.

**Status:** ready-for-agent

- [ ] I quattro eventi passano dalla giuntura dei dati
- [ ] Nessuno dei quattro contiene più la ricerca della sessione fatta a mano
- [ ] I due eventi che tolgono l'osservazione hanno una capability associata e rispondono al client
- [ ] Un test dimostra che un sottoutente con capability di lettura può usarli tutti e quattro
- [ ] Un test dimostra la riconnessione automatica su connessione caduta
- [ ] L'osservazione delle collezioni e degli schemi continua a funzionare da capo a fondo
