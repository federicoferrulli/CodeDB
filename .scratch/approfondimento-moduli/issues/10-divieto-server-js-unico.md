# 10: Definizione unica del divieto degli operatori server-side

**Cosa costruire:** il divieto degli operatori che fanno eseguire JavaScript al server
MongoDB è definito in un posto solo e chiamato da tutti.

Oggi ne esistono tre versioni: quella autorevole nel modulo delle capability, una copia
nel server, e una terza sotto forma di espressione regolare applicata al testo di un
messaggio d'errore. Tre versioni della stessa regola sono tre occasioni di divergere.

La copia nel server è **superficiale** nel senso preciso del termine: cancellarla concentra
la complessità nel modulo autorevole, senza che alcun chiamante ne assorba.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** done

- [x] Esiste una sola definizione del divieto, e le altre due sono rimosse
- [x] Tutti i punti che applicavano il divieto chiamano quella definizione
- [x] Un test copre il divieto attraverso almeno due percorsi diversi
- [x] Il gateway e i test di autorizzazione passano invariati

## Che cosa è stato fatto

La definizione autorevole resta `assertNoMongoServerJs` in
`auth/capabilities.js`, con il suo unico elenco `FORBIDDEN_MONGO_SERVER_JS`.
Le altre due sono sparite:

* la **copia in server.js** (`FORBIDDEN_MONGO_OPS` + `assertNoServerJs`, con un
  proprio elenco e un proprio messaggio) è stata cancellata, insieme al
  `safeParseForScan` che serviva solo a lei. Cancellarla non ha spostato
  complessità da nessuna parte: i cinque punti che la chiamavano ora chiamano
  la definizione autorevole;
* la **terza versione** era la più insidiosa e non somigliava a una regola:
  ```js
  try { assertNoServerJs(JSON.parse(testo)); } catch (err) {
    if (err && /\$where|\$function|\$accumulator/.test(err.message)) throw err;
  }
  ```
  cioè *riconoscere il divieto guardando il testo del messaggio d'errore*, per
  distinguerlo da un errore di sintassi. Si sarebbe rotta al primo cambio di
  frase, in silenzio e nella direzione peggiore — lasciando passare.

**Quel che quel `catch` voleva davvero** è che, per certi chiamanti, un testo
non analizzabile non sia un errore: verrà riletto più avanti dal traduttore o
dalla strategia e rifiutato lì, con il messaggio giusto. È una richiesta
legittima, e ora si dichiara: `assertNoMongoServerJs(code, label,
{ testoIllegibile: 'ignora' })`. Server.js la incapsula in `vietaJsLatoServer`,
usata nei suoi cinque punti. La distinzione la fa **chi chiama**, dicendola,
invece di dedurla da una stringa.

## Come è stato provato

`test/unit-divieto-server-js.js` (8 prove, registrato in `test/unit.js`), su
**due percorsi diversi** come chiede il ticket:

1. la definizione autorevole — i tre operatori vietati sia al primo livello sia
   annidati dentro un `$and` dentro un `$match` di una pipeline, una query
   legittima che passa, e le due condotte sul testo illeggibile (errore per chi
   non ha un secondo controllo, silenzio per chi lo dichiara);
2. il **Proxy autorizzante** — `$where` in un filtro e `$function` in una
   pipeline rifiutati *anche a root* (non è un permesso, è un'invariante), con
   la verifica che la query non raggiunga nemmeno la strategia; e una pipeline
   legittima che arriva intatta.

C'è poi un controllo statico che nessuna **quarta** versione ricompaia: cerca
nei file che applicavano il divieto i tre nomi vicini fra loro — è così che si
scrive un elenco proprio, che sia un Set, un array o un'alternativa in una
regex — dopo aver tolto i commenti, perché nominare `$where` spiegando il
divieto è legittimo.

**Sensibilità verificata rompendo il codice di proposito**: rimesso in server.js
un `new Set(['$where', '$function', '$accumulator'])`, il controllo statico
fallisce nominando il file; rimosso, torna verde.

Eseguiti: `npm test` (esito 0), `test/e2e-mcp.js` (tutti superati),
`test/e2e-rbac.js` (completato), `test/e2e-mongo-script.js` (tutti superati — è
il percorso dell'interprete, cioè quello che usava la versione con la regex sul
messaggio), `test/e2e.js` (4 fallimenti, gli stessi preesistenti).

**Non eseguiti**: gli E2E di MySQL e PostgreSQL, non applicabili — il divieto
riguarda solo MongoDB — e comunque non avviabili su questa macchina.
