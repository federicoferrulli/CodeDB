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

**Status:** done

- [x] I quattro eventi passano dalla giuntura dei dati
- [x] Nessuno dei quattro contiene più la ricerca della sessione fatta a mano
- [x] I due eventi che tolgono l'osservazione hanno una capability associata e rispondono al client
- [x] Un test dimostra che un sottoutente con capability di lettura può usarli tutti e quattro
- [x] Un test dimostra la riconnessione automatica su connessione caduta
- [x] L'osservazione delle collezioni e degli schemi continua a funzionare da capo a fondo

## Che cosa è stato fatto

I quattro eventi sono passati da `safeOn` a `delegate`, e con ciò hanno perso
quaranta righe: la ricerca della sessione fatta a mano, con lo stesso messaggio
d'errore copiato **quattro volte**, non c'è più in nessuno dei quattro.

```js
delegate('collection:watch', (strategy, p) => {
  const tab = normTabId(p.tabId);
  strategy.watch(p.db, p.coll, {
    onChange: (change) => socket.emit('collection:changed', { tabId: tab, db: p.db, coll: p.coll, ...change }),
    onUnavailable: () => socket.emit('watch:unavailable', { tabId: tab, db: p.db, coll: p.coll }),
  });
  return {};
});
```

**Il guadagno**: passando dalla giuntura ereditano `executeWithReconnect`, cioè
la riconnessione automatica che non avevano. Mettere in osservazione una
collezione su una connessione caduta non riprovava, e l'osservazione restava
spenta senza che nulla lo dicesse.

**I due difetti che il ticket segnalava, chiusi entrambi:**

* i due eventi che TOLGONO l'osservazione non avevano una **capability**. Sotto
  la giuntura sarebbero stati negati a ogni sottoutente — cioè il passaggio
  avrebbe rotto proprio chi ha i permessi più stretti. Ora dichiarano `read`, la
  stessa che serviva a metterla: si può smettere di osservare solo ciò che si
  era autorizzati a osservare;
* gli stessi due **non rispondevano** al client. Ora `delegate` risponde per
  loro.

## Come è stato provato

`test/unit-osservazione-giuntura.js` (9 prove, registrato in `test/unit.js`),
senza socket e senza database, sul contesto finto del ticket 16: tutti e quattro
rispondono e raggiungono il proprio metodo della strategia; senza sessione
danno il messaggio della giuntura; i push portano il `tabId` così il frontend
li instrada al tab giusto; un sottoutente con la **sola lettura** li usa tutti e
quattro, e uno **senza** capability viene negato su tutti e quattro — che è
l'altra faccia, perché una capability dichiarata dev'essere un controllo e non
un timbro.

`test/e2e-osservazione.js` (**nuovo**, MongoDB vero, 9 prove): l'osservazione
funziona da capo a fondo, un documento inserito produce la risposta del server
(cambiamento o indisponibilità — su MongoDB standalone i change stream non
esistono, e il test distingue i due casi invece di pretenderne uno), rimettere
l'osservazione è idempotente, e un tab inesistente riceve il messaggio della
giuntura.

**Una correzione al banco di prova, che vale la pena raccontare.** La prima
verifica di sensibilità è tornata «zero fallimenti» rimettendo il difetto — un
risultato assurdo. Il motivo: rimesso `collection:unwatch` senza risposta, il
test **si appendeva** invece di fallire, perché aspettava un ack che non
sarebbe mai arrivato. È esattamente il difetto 3 visto dal lato del test. Ora
`SocketFinto.chiama` ha una scadenza e un handler muto diventa un fallimento
che lo nomina, invece di un test appeso che non dice quale.

**Sensibilità verificata rompendo il codice di proposito**: rimessi il vecchio
`safeOn` senza risposta e tolte le due capability, **6 prove su 9 falliscono**;
ripristinati i file, zero.

Che la riconnessione sia davvero ereditata è verificato **staticamente** — che
`delegate` invochi la strategia attraverso `executeWithReconnect` — e il motivo
è dichiarato nel test: farla scattare significa far girare il vero ciclo di
ripristino, quattordici tentativi con attese crescenti, minuti dentro una suite
unitaria. Il primo tentativo di prova comportamentale è stato fatto, e ha
mostrato proprio questo.

## Suite eseguite

`npm test` (esito 0), `e2e.js` 4 FAIL (baseline 4), `e2e-rbac.js` 0,
`e2e-mysql.js` 2 FAIL (baseline 2), `e2e-osservazione.js` tutti superati.
**Nessun fallimento nuovo.**
