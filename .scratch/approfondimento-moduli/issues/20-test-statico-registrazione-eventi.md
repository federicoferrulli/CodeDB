# 20: Test statico sulla registrazione degli eventi

**Cosa costruire:** registrare un evento fuori dalle tre giunture previste fa fallire un
test. È il terzo gradino del criterio di chiusura: non basta che la situazione sia
sistemata, deve essere difficile riformarla.

Il modello esiste già nel repo: un test legge il codice come testo per trovare ciò che
nessun controllo di tipo troverebbe, ed è così che è stato intercettato lo scambio fra due
variabili omonime.

Il test deve anche verificare che ogni evento sia dichiarato in **una sola** famiglia, e che
la famiglia dichiarata corrisponda a ciò che l'handler fa davvero — almeno per il criterio
osservabile: chi tocca una strategia non può stare nella famiglia amministrativa.

**Bloccato da:** 17, 18, 19.

**Status:** done

- [x] Il test elenca tutti gli eventi registrati e ne verifica la famiglia
- [x] Registrare un evento fuori dalle tre giunture fa fallire il test
- [x] Dichiarare un evento in due famiglie fa fallire il test
- [x] Il test è stato verificato introducendo di proposito una registrazione fuori posto
- [x] Il messaggio di fallimento dice quale evento e cosa fare, non solo che qualcosa non torna

## Che cosa è stato fatto

`test/unit-registrazione-eventi.js` legge `server.js` come testo ed elenca gli
**80 eventi** socket con la giuntura da cui passano:

```
80 eventi — evento sui dati: 36 · evento amministrativo: 26 ·
            operazione lunga: 8 · via generica (eccezione dichiarata): 10
```

Le prime tre sono le famiglie di ADR-0001. La quarta non è un residuo: è
`ECCEZIONI_VIA_GENERICA`, la tabella **nuova** in cui ognuno dei dieci eventi
rimasti su `safeOn` dice perché ci sta — tre aprono o chiudono la sessione che
le tre giunture presuppongono (farli passare da una giuntura che comincia
cercando la sessione sarebbe circolare), tre verificano una capability che non
ha un database come bersaglio, quattro sono backup che accedono al driver
nativo. Aggiungere un'eccezione resta legittimo, ma richiede di **scriverne il
motivo**: è la differenza fra una decisione e una deriva.

## Che cosa fa fallire il test

| situazione | esito |
|---|---|
| un evento registrato con `safeOn()` senza essere dichiarato | **FAIL**, e il messaggio elenca le tre giunture fra cui scegliere |
| lo stesso evento registrato in due famiglie | **FAIL**, con **entrambe** le righe di server.js |
| un evento dichiarato amministrativo che tocca una strategia | **FAIL**, spiegando che così la capability per database non verrebbe mai verificata |
| un'eccezione dichiarata che non ha più il suo handler | **FAIL**: il motivo resterebbe lì a mentire |
| le tre tabelle delle famiglie si sovrappongono | **FAIL** |
| il riconoscimento stesso si rompe | **FAIL** («troppo pochi»), invece di passare per non aver trovato nulla |

Il messaggio dice **cosa fare**, non solo che qualcosa non torna. Per esempio:

```
FAIL ogni evento sulla via generica è un'eccezione dichiarata, col suo motivo
     "evento:fuori:posto" (server.js:3012) è registrato con safeOn() ma non è dichiarato.
     Cosa fare: scegli la sua famiglia (ADR-0001) e usane la giuntura —
       delegate()        se delega a una strategia;
       amministrativo()  se non tocca alcuna strategia;
       operazioneLunga() se usa i punti di estensione delle operazioni lunghe.
     Se è davvero un'eccezione, aggiungila a ECCEZIONI_VIA_GENERICA con il motivo.
```

## La corrispondenza fra famiglia dichiarata e ciò che l'handler fa

Il ticket chiede il criterio **osservabile**: chi tocca una strategia non può
stare nella famiglia amministrativa. Il test lo verifica leggendo il corpo di
ogni handler amministrativo e cercandovi `.strategy` o `sessions.get(`.

Vale la pena dire perché è il verso giusto e non il suo opposto: che un evento
sui dati deleghi davvero non serve provarlo — è `delegate` a passargli la
strategia, quindi non può non farlo. Il rischio sta dall'altra parte: un evento
che tocca i dati dichiarato amministrativo passerebbe **senza** che la
capability sul database bersaglio venga mai verificata. È un buco di sicurezza,
non un errore di catalogazione, e il messaggio lo dice.

## Che cosa il test NON garantisce

Sta scritto in testa al file, come per il guardiano strutturale del ticket 28.
Legge nomi di funzione, non semantica: vede chi registra dove, non vedrebbe una
giuntura invocata con un nome costruito a runtime. In `server.js` non ce ne
sono, e se l'elenco crollasse la guardia «troppo pochi» lo direbbe — ma la
promessa è quella, e non di più.

## Come è stato provato

**Sensibilità verificata introducendo di proposito una registrazione fuori
posto**, in quattro varianti (evento non dichiarato sulla via generica, evento
in due famiglie, amministrativo che tocca una strategia, eccezione senza
handler). Tutte e quattro producono un fallimento con il messaggio riportato
sopra; ripristinato il file, zero.

`npm test` (esito 0) e, con i due container dedicati: `e2e.js` 4 FAIL
(baseline 4), `e2e-mysql.js` 2 (baseline 2), `e2e-postgres.js` 3 (baseline 3),
`e2e-rbac.js` 0, `e2e-mcp.js` 0, `e2e-backup.js` 0. **Nessun fallimento nuovo.**

---

## Il lotto 16–20, chiuso

Questo era l'ultimo gradino. Il quadro finale degli 80 eventi socket:

* **36** passano dalla giuntura dei dati (`delegate`), quattro dei quali —
  gli eventi di osservazione — vi sono rientrati con il ticket 17, guadagnando
  la riconnessione automatica;
* **26** dalla giuntura amministrativa (`amministrativo`), che scrive l'audit
  al posto loro e non lascia dimenticarlo;
* **8** dalla giuntura delle operazioni lunghe (`operazioneLunga`), ciascuna con
  i suoi punti di estensione dichiarati;
* **10** restano sulla via generica, ognuno con il motivo scritto.

E tre test statici a guardia: questo, `unit-handler-scope.js` (che in questo
lotto ha fatto scattare **due volte** le proprie guardie contro il marcire) e
`unit-giuntura-amministrativa.js`.
