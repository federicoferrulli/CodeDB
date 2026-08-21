# 23: Migrare il server e il gateway MCP al filtro strutturato

**Cosa costruire:** i due chiamanti del contratto che non sono il browser — il server e il
gateway per i client AI — passano al filtro strutturato.

Vanno fatti insieme perché condividono la stessa interfaccia: lasciarne uno indietro
significa mantenere due contratti vivi più a lungo del necessario, ed è proprio la
condizione che il ticket di contrazione deve poter chiudere.

Il gateway espone strumenti a client esterni: il cambiamento del contratto va riflesso
nella descrizione degli strumenti, altrimenti un client continua a mandare la forma vecchia.

**Bloccato da:** 21.

**Status:** done

- [x] Il server compone filtri strutturati
- [x] Il gateway compone filtri strutturati e la descrizione dei suoi strumenti è aggiornata
- [x] La verifica di autorizzazione legge i campi del filtro anziché rianalizzarne il testo
- [x] Un test dimostra che un filtro che esce dallo scope viene negato leggendo i campi
- [x] I test del gateway, quelli di autorizzazione e quelli end-to-end passano invariati

## Il server: non c'era niente da migrare, e va detto perché

Cercando dove server.js **compone** un filtro si trovano tre punti soli, tutti
nel Query Engine (la tab ⚡):

* il filtro MQL che l'utente ha **scritto a mano** nell'editor;
* l'uscita del traduttore `SqlToMql`/`MongoShell`, cioè ancora la query
  dell'utente, tradotta;
* il filtro vuoto.

Nessuno dei tre è «il server che compone un filtro per conto suo»: sono la query
dell'utente, che per definizione deve arrivare al motore **come è stata
scritta**. È lo stesso confine già dichiarato altrove in questo lotto — l'SQL
libero dell'ordinamento che il ticket 27 non riscrive mai, e la modalità
«condizione» della griglia che il ticket 22 ha conservato.

Migrarli sarebbe stato riscrivere la query dell'utente: non un miglioramento, un
difetto. La casella si spunta perché la verifica è stata fatta, non perché sia
stato cambiato del codice.

## Il gateway MCP

`query_data` accetta ora **`filtro`**, e la differenza rispetto a prima è che
funziona su **tutti e tre i motori**: fino a ieri un client AI doveva sapere in
anticipo se stava parlando con MongoDB (`filter` in Extended JSON) o con un
motore SQL (`sql` con una SELECT), cioè doveva conoscere il motore per porre la
domanda più semplice che ci sia.

La descrizione dello strumento — che è ciò che il client legge per decidere cosa
mandare — lo dichiara esplicitamente:

> PREFERISCI "filtro": è un filtro STRUTTURATO che funziona allo stesso modo su
> tutti e tre i motori e non richiede di sapere quale motore risponde. I suoi
> valori sono parametrizzati, quindi non possono alterare la query.

E lo schema del parametro elenca **tutti** gli operatori con la loro forma, così
un client non deve indovinarli. `filter`, `pipeline` e `sql` restano: servono
per ciò che un filtro non esprime — JOIN, GROUP BY, espressioni — e toglierli
avrebbe tolto capacità. Chiedere `filtro` e `sql` insieme è invece un errore
esplicito: sono due modi di dire la stessa cosa, e insieme si sommerebbero.

## L'autorizzazione legge i campi, non il testo

`assertScopedClauses` verifica ora il filtro strutturato **normalizzandolo**,
cioè leggendone i campi. Non c'è testo da analizzare.

La ragione per cui basta non è che ci si fidi di più: è che **uscire dallo scope
non è esprimibile**. Ogni `campo` diventa un identificatore quotato *intero* —
`altra_tabella.colonna` diventa \`altra_tabella.colonna\`, cioè il nome di una
colonna che non esiste, non un riferimento a un'altra tabella. Non c'è sintassi
da neutralizzare perché non c'è sintassi.

È esattamente la proprietà che autorizzerà il ticket 24 a cancellare le ~460
righe del firewall, e per questo è **provata** e non affermata.

## Come è stato provato

`test/unit-filtro-autorizzazione.js` (7 prove, registrato in `test/unit.js`):

* un filtro ben formato passa; uno malformato viene rifiutato leggendone i campi
  (campo assente, operatore sconosciuto, JSON rotto);
* **cinque tentativi di fuga** — `altra_tabella.colonna`,
  `x FROM segreti WHERE 1=1 --`, `x' UNION SELECT password FROM utenti --`,
  `x) OR (SELECT 1 FROM utenti`, `*` — producono tutti **un solo identificatore
  quotato**, verificato con un'espressione regolare che pretende esattamente
  quella forma e con un controllo che fuori dall'identificatore non compaia
  alcuna sintassi;
* un valore ostile non aggiunge struttura su nessuno dei due motori;
* i caratteri di controllo nel nome del campo sono rifiutati prima del motore;
* il filtro **testuale** conserva il suo firewall, e quando i due arrivano
  insieme si verificano **entrambi** — nessuno dei due può fare da porta di
  servizio all'altro.

## Suite eseguite

`npm test` (esito 0) e, con i due container dedicati:

| suite | FAIL | baseline |
|---|---|---|
| `e2e-mcp.js` | 0 | 0 |
| `e2e-mcp-mysql.js` | 1 | 1 (preesistente: DML in CTE) |
| `e2e-rbac.js` | 0 | 0 |
| `e2e-rbac-mcp.js` | 0 | 0 |
| `unit-mcp-auth.js` | 0 | 0 |

**Nessun fallimento nuovo.**

**Non provato sul campo, e va detto**: il parametro `filtro` del gateway non ha
un test end-to-end che lo eserciti attraverso un client MCP vero. La resa che
produce è la stessa provata sui tre motori da `test/e2e-filtro-strutturato.js`
(è la stessa chiamata a `collectionFind`), ma il percorso specifico dello
strumento MCP — schema, validazione dei parametri, risposta — resta coperto solo
dal fatto che il gateway si avvia e gli altri suoi strumenti passano.
