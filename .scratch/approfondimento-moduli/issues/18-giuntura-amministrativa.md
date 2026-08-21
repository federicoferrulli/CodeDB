# 18: La giuntura amministrativa

**Cosa costruire:** i ventisei eventi che non toccano alcuna strategia — vault, utenti,
permessi, chiavi API, connessioni salvate, licenza, aggiornamenti, audit — hanno una
giuntura propria, e la scrittura della voce di audit smette di essere copiata a mano.

Sono la seconda delle tre famiglie riconosciute in ADR-0001. Non hanno un database come
bersaglio, quindi la verifica della capability per database non li riguarda: hanno invece
gate d'installazione e audit, che oggi una quindicina di loro compone a mano riga per riga.

La ricerca della sessione, dove serve, viene da sotto: è condivisa con le altre due
famiglie.

**Bloccato da:** 16.

**Status:** done

- [x] Gli eventi amministrativi passano dalla loro giuntura
- [x] La voce di audit è scritta da un posto solo; nessuna composizione a mano sopravvive
- [x] Un evento amministrativo nuovo scrive l'audit senza che chi lo aggiunge debba ricordarsene, e un test lo dimostra
- [x] I gate d'installazione e le verifiche di amministrazione valgono come prima
- [x] I test di autorizzazione, quelli del vault e quelli end-to-end passano invariati

## Che cosa è stato fatto

I ventisei eventi che non toccano alcuna strategia passano ora da
`amministrativo(evento, fn)`, la giuntura della seconda famiglia di ADR-0001.

**La giuntura fa una cosa sola, ed è quella che veniva dimenticata**: scrive la
voce di audit. Non tocca i gate — restano nei corpi degli handler, dove sono
sempre stati. Spostarli avrebbe cambiato semantica di sicurezza in un punto in
cui «valgono come prima» è precisamente ciò che il ticket chiede, e la garanzia
più forte che quel requisito sia rispettato è non averli toccati affatto.

**L'audit diventa una dichiarazione.** `EVENTI_AMMINISTRATIVI` è la tabella: per
ogni evento, l'etichetta da scrivere nello storico e, dove serve, come ricavare
il bersaglio e i dettagli dal payload o dall'esito. Le nove composizioni a mano
sono sparite dai corpi:

```js
// prima, in nove handler diversi, ripetuta:
auditUi({ event: 'users:create', category: 'write', status: 'ok',
          op: 'Creazione sottoutente', ...auditActor(principal), target: user.email });

// ora, una riga nella tabella:
'users:create': { op: 'Creazione sottoutente', bersaglio: (p, res) => res.user.email },
```

**`tracciato: false` non è una scappatoia.** È la voce degli eventi di sola
lettura — elenchi, stato del vault, testo della licenza — e ognuno dice **perché**
(`NON_TRACCIATO('elenco, senza effetti')`). Registrare nello storico ogni
apertura di un elenco lo riempirebbe di righe che non raccontano nulla,
seppellendo quelle che contano; e `audit:list` tracciato riempirebbe lo storico
di se stesso.

Due miglioramenti non richiesti ma dovuti, emersi scrivendo la tabella:

* l'audit viene scritto **anche in caso di errore** (`status: 'error'` con il
  messaggio). Prima le nove righe a mano stavano tutte dopo il percorso felice:
  un cambio di passphrase fallito, o una revoca di permessi andata male, non
  lasciavano alcuna traccia — che è il caso in cui una traccia serve di più;
* `vault:setPassphrase` conserva la sua etichetta **dinamica**: una migrazione
  del vault è un'altra cosa da un semplice cambio, e leggere «Cambio
  passphrase» dove il vault è stato migrato nasconderebbe l'operazione più
  delicata. La tabella accetta quindi un `op` funzione.

## Un difetto trovato di rimbalzo

Migrando i ventisei eventi, `test/unit-handler-scope.js` è passato da 44
handler riconosciuti a **18**, e ha fallito con «Troppo pochi: il riconoscimento
è da aggiornare». Cercava soltanto `safeOn('…')`.

Quel controllo protegge da uno scambio fra due variabili omonime che aveva
ucciso l'intero esecutore di script. Se l'asserzione «troppo pochi» non ci fosse
stata, sarebbe rimasto verde continuando a sorvegliare due terzi in meno del
codice — un test che si spegne senza dirlo. Ora riconosce le **tre** giunture
(`safeOn`, `delegate`, `amministrativo`) e copre 80 handler.

## Come è stato provato

`test/unit-giuntura-amministrativa.js` (9 prove, registrato in `test/unit.js`),
sul contesto finto del ticket 16.

La prova che conta è **comportamentale**, non una lettura del sorgente: si
scrive una copia di server.js con dentro un evento amministrativo che nessuno ha
dichiarato, la si carica, e si verifica che `registraEventi` **rifiuti**:

```
Evento amministrativo "evento:nuovo:non:dichiarato" non dichiarato in
EVENTI_AMMINISTRATIVI. Cosa fare: aggiungi una voce con l'etichetta da scrivere
nello storico, oppure dichiara NON_TRACCIATO(motivo) se è una lettura senza
effetti.
```

L'errore arriva **all'avvio**, non il giorno in cui serve leggere lo storico e
la riga non c'è. Ed è questo che rende vero il terzo requisito del ticket: chi
aggiunge un evento amministrativo non deve *ricordarsi* dell'audit — non può
procedere senza dichiararlo.

Le altre prove: i 26 passano dalla giuntura e nessuno è rimasto anche sulla via
generica; nessun `auditUi` a mano sopravvive **dentro il corpo** di un handler
amministrativo; la voce si compone in una funzione sola; ogni voce della tabella
o ha un'etichetta o dice perché non è tracciata (una voce a metà sarebbe un modo
di dimenticare l'audit passando dal controllo); gli eventi di lettura rispondono
come prima e uno che fallisce risponde con l'errore spiegato.

**Sensibilità verificata rompendo il codice di proposito**, nei due sensi:

| difetto introdotto | esito |
|---|---|
| un evento amministrativo nuovo, non dichiarato | `registraEventi` **lancia** all'avvio, con il messaggio riportato sopra |
| torna un `auditUi({…})` a mano dentro `users:create` | **FAIL** «nessuna composizione a mano dell'audit sopravvive», con l'evento nominato |

Ripristinati i file, zero fallimenti.

## Suite eseguite

`npm test` (esito 0) e, con i due container dedicati:

| suite | FAIL | baseline |
|---|---|---|
| `e2e.js` (MongoDB) | 4 | 4 |
| `e2e-rbac.js` | 0 | 0 |
| `e2e-rbac-mcp.js` | 0 | 0 |
| `e2e-vault-passphrase.js` | 0 | 0 |
| `e2e-mcp.js` | 0 | 0 |

**Nessun fallimento nuovo.**
