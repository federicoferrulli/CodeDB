# 07: I tetti imposti dalla giuntura, con adattatore finto

**Cosa costruire:** i tetti su righe, byte e tempo smettono di essere funzioni che ogni
adattatore può ricordarsi o dimenticarsi di chiamare, e diventano vincoli che la giuntura
applica avvolgendo l'esecuzione. L'adattatore fornisce solo il pezzo che varia fra motori.

Oggi la loro applicazione è a macchia: alcuni tetti valgono su un motore e non sugli altri,
e il difetto chiuso dal ticket 01 era un caso di questa classe. Un motore aggiunto in
futuro deve nascere già limitato.

Il ticket porta anche l'adattatore finto in memoria che rende i tetti provabili senza un
database acceso: è la giuntura su cui si appoggeranno le prove dei lotti successivi.

**Bloccato da:** 01.

**Status:** done

- [x] I tetti sono applicati dalla giuntura per tutti e tre i motori
- [x] Un adattatore finto in memoria permette di provarli senza database
- [x] Esiste un test per ciascun tetto — righe, byte, tempo — che dimostra l'interruzione
- [x] Un adattatore che non fa nulla per rispettarli viene comunque limitato, e un test lo prova
- [x] Almeno un test è stato verificato rompendo di proposito il codice che protegge
- [x] I test end-to-end dei tre motori passano invariati

## Che cosa è stato fatto

`db/tetti.js` avvolge una strategia e impone i tre tetti dall'esterno.
`DbFactory.getStrategy` la restituisce già avvolta: è l'unico punto in cui le
strategie vengono create, quindi è il punto in cui **un motore aggiunto in
futuro nasce limitato senza doversene ricordare**.

I tre tetti non si applicano allo stesso modo, e il modulo lo dice:

* **righe** e **byte** si applicano al risultato — sono un troncamento, e la
  bandiera di troncamento viene alzata: un risultato tagliato in silenzio è
  peggio di uno rifiutato. I nomi delle chiavi non sono gli stessi ovunque
  (`docs`/`truncated` per la griglia e la tab ⚡, `righe`/`troncato` per il
  pannello delle chiavi esterne), quindi sono **dichiarati** nella tabella dei
  metodi soggetti: è ciò che permette alla giuntura di troncare senza sapere
  nulla del metodo che sta avvolgendo.
* **tempo** non si può applicare al risultato, perché arriva dopo. La giuntura
  tiene un cane da guardia che smette di aspettare, con un **margine di grazia**
  sopra al tetto vero (un quarto, minimo due secondi). Il margine non è
  prudenza generica: serve a far vincere il messaggio preciso del motore
  («query interrotta dopo 30 s») su quello generico della giuntura. Senza, i
  due arriverebbero insieme e vincerebbe il caso.

**La macchia trovata e chiusa.** Il budget di byte valeva sulla
`collectionFind` di tutti e tre i motori ma **non** sulla `collectionAggregate`
di MySQL e PostgreSQL — cioè proprio dove arrivano i risultati grossi, quelli
della tab ⚡. Su MongoDB c'era, perché lì `collectCapped` lo porta con sé.
Nessuno lo aveva scritto da nessuna parte: era un `truncateBySize` non chiamato.

**Che cosa resta all'adattatore.** Solo il pezzo che varia fra motori: come si
ferma una query mentre è in corso, e — nuovo — `fuoriDalTettoDiTempo(metodo,
args)`, con cui dichiarare che una certa esecuzione non va fermata. La risposta
predefinita di `DbStrategy` è **no**, così un motore nuovo nasce limitato e per
uscirne deve dirlo. L'unico che lo dice è MongoDB, per le pipeline che
materializzano (`$out`/`$merge`): fermarle a metà lascerebbe la collection di
destinazione scritta a metà, cioè lo stato incoerente che il tetto dovrebbe
evitare. Quell'esclusione prima viveva dentro `collectionAggregate`, dove era
anche la sola cosa che teneva il `maxTimeMS` lontano dalla pipeline; ora è
dichiarata dove la giuntura la può leggere.

**Perché gli adattatori chiamano ancora `resultCap` e compagni.** Non è un
residuo: là il tetto è un'**ottimizzazione** (scrivere `LIMIT 500` nella query
evita di portare in memoria cinque milioni di righe per buttarne via
4.999.500), qui è la **garanzia**. Quando l'adattatore ha già rispettato il
tetto, il passaggio dalla giuntura non taglia nulla.

## L'adattatore finto

`test/adattatore-finto.js` è deliberatamente **disobbediente**: ignora
`maxRows`, non conta i byte, non ha alcun timeout, e restituisce esattamente le
righe che gli si dice, quando gli si dice. È questa disobbedienza a rendere il
test significativo — se il risultato arriva limitato lo stesso, il limite non
può venire da lui. Non eredita da `DbStrategy` di proposito: ereditare
porterebbe con sé `fuoriDalTettoDiTempo`, e chi legge il test si chiederebbe se
il comportamento provato venga dalla classe base o dalla giuntura.

È la giuntura su cui si appoggeranno le prove dei lotti successivi.

## Come è stato provato

`test/unit-tetti.js` (19 prove, registrato in `test/unit.js`), senza alcun
database — circa 4 secondi:

* **righe**: 5.000 righe dall'adattatore, 500 al chiamante, troncamento
  dichiarato; `maxRows` alza il tetto; sotto il tetto non si tocca niente; il
  pannello delle chiavi esterne ha il proprio massimo di 200;
* **byte**: 100 righe da 50 KB con budget da 200 KB vengono tagliate benché
  siano ben sotto il tetto delle righe — e la stessa prova sulla
  `collectionAggregate`, che è la macchia chiusa; budget `<= 0` disattiva;
* **tempo**: un adattatore senza alcun timeout viene interrotto lo stesso; il
  margine di grazia lascia rispondere chi risponde in tempo; il conteggio
  degrada a «totale sconosciuto» invece di fallire; tetto `<= 0` disattiva;
  l'esclusione dichiarata dall'adattatore vale **per esecuzione**, non per
  adattatore (la `aggregate` esclusa passa, la `find` dello stesso oggetto no);
  e un errore che arriva **dopo** la scadenza non diventa un rifiuto non
  gestito — l'esecuzione abbandonata continua, e senza un gestore il processo
  morirebbe;
* **la giuntura non disturba il resto**: i metodi non soggetti passano intatti,
  le proprietà e le scritture attraversano il Proxy (il backup legge
  `strategy.pool`, il Query Engine scrive `strategy.currentDb`), gli argomenti
  arrivano invariati;
* **i tre motori veri** escono dalla fabbrica già avvolti, e MongoDB dichiara
  fuori dal tetto `$out`/`$merge` **solo se finali** — un `$out` a metà
  pipeline non è una materializzazione valida e non va esclusa.

**Sensibilità verificata rompendo il codice di proposito**: tolta
l'applicazione del budget di byte e portata la scadenza a dieci minuti,
6 prove su 19 falliscono; ripristinato il file, zero.

`npm test` passa (codice di uscita 0).

**Non provato, e va detto.** Gli E2E di MySQL e PostgreSQL non sono eseguibili
qui (PostgreSQL non è in ascolto; MySQL rifiuta l'utente `root` senza password
che l'harness richiede). Quello di MongoDB è stato eseguito: **4 fallimenti,
gli stessi 4 che si hanno con le modifiche messe da parte** — preesistenti.
Resta quindi non verificato sul campo che il cane da guardia non preempti i
messaggi di timeout dei due motori SQL: per questo vale il margine di grazia,
che è la ragione per cui esiste.


---

## Verifica E2E sui tre motori — eseguita

Con due container dedicati e usa-e-getta (MySQL 8 su 3307, PostgreSQL 16 su
5433), avviati senza toccare le istanze di altri progetti presenti sulle porte
consuete:

* `test/e2e-tetto-scrittura.js` — **tutti superati su MySQL e PostgreSQL**. È la
  prova che conta per questo ticket: una scrittura che dorme 8 secondi viene
  interrotta entro il tetto di 2, non lascia traccia (rollback dell'istruzione
  annullata) e la connessione successiva è sana. Il cane da guardia della
  giuntura **non ha preempito** il messaggio del motore — è esattamente ciò a
  cui serve il margine di grazia, e finora era l'unica cosa di questo ticket a
  restare non verificata sul campo;
* `test/e2e-mysql.js` (2 fallimenti) e `test/e2e-postgres.js` (3): **gli stessi
  anche senza queste modifiche**, misurato con `git stash`. Preesistenti;
* `test/e2e-query-engine.js`, `test/e2e-dbexport.js`, `test/e2e-sessions.js`,
  `test/e2e-backup-mysql.js`, `test/e2e-tipi-mysql.js`,
  `test/e2e-collazione-mysql.js`, `test/e2e-script-risultati.js` — tutti
  superati;
* `test/e2e.js` su MongoDB — i soliti 4 fallimenti preesistenti.

**Nessun fallimento nuovo introdotto dai tetti**, su nessuna suite.
