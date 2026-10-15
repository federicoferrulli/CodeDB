# Controllo qualità SQL nativo — 14 ottobre 2026

> Rapporto storico: i difetti sotto descritti sono stati successivamente corretti.
> Vedi [correzioni e nuova verifica](quality-risoluzione.md).

**Esito: correggere i problemi 1, 2 e 3 prima del rilascio.**

Le modifiche affidano l'esecuzione dei dialetti a PostgreSQL e MySQL reali e
mantengono una sessione SQL per la scheda. Il controllo riguarda questa
integrazione, i chiamanti, il recupero delle sessioni, gli splitter e i test
collegati. Non è un audit dell'intero insieme delle modifiche presenti nel
workspace, che comprende anche lavoro su export, UML e altri componenti.

Carico considerato: uso interattivo ordinario, con più documenti nella stessa
connessione e cambi di database/schema. I difetti non richiedono concorrenza
o carichi elevati.

## Da correggere

### 1. [P1] PostgreSQL scrive nello schema sbagliato dopo un rollback

Riferimento: [PostgreSqlStrategy.js:938](../../db/PostgreSqlStrategy.js#L938).

La strategia conserva in memoria lo schema impostato con `SET search_path`.
Il valore sul server può però essere annullato dalla transazione, mentre la
cache rimane invariata.

Riproduzione attraverso `query:execute`, su due schemi A e B contenenti una
tabella `prova(id INT)`:

1. Bersaglio A: `BEGIN`, poi `SAVEPOINT prima`.
2. Bersaglio B: `INSERT INTO prova VALUES(1)`.
3. Bersaglio B: `ROLLBACK TO SAVEPOINT prima`.
4. Bersaglio B: `INSERT INTO prova VALUES(2)`, poi `COMMIT`.

Atteso: A vuoto, B contiene 2. Ottenuto: **A contiene 2, B è vuoto**.
Riprodotto anche con `ROLLBACK` completo seguito da una nuova scrittura su B.

Correzione necessaria: rendere coerente il contesto effettivo prima delle query
ordinarie, senza anteporre `SET` ai comandi di recupero di una transazione
abortita. Una cache che ignora rollback, savepoint e modifiche SQL delle
impostazioni non può decidere da sola se il bersaglio è già corretto.

Impatto: scritture riuscite e confermate nello schema diverso da quello
richiesto, senza errore per l'utente.

### 2. [P1] MySQL usa un database diverso dal bersaglio dopo USE

Riferimenti: [MySqlStrategy.js:885](../../db/MySqlStrategy.js#L885),
[server/query.js:377](../../server/query.js#L377).

Il comando `USE` cambia il database della connessione reale ma lascia la cache
`lease.configurazione.database` sul vecchio valore.

Riproduzione attraverso `query:execute`, con database A e B e tabella `prova`
in entrambi:

1. Bersaglio A: `SELECT DATABASE()` conferma A.
2. Bersaglio A: `USE B`.
3. Si seleziona nuovamente A e si esegue `INSERT INTO prova VALUES(4)`.

Atteso: A contiene 4, B vuoto. Ottenuto: **A è vuoto, B contiene 4**.

Correzione necessaria: sincronizzare la cache quando un comando cambia database
oppure ristabilire il database richiesto prima di ogni operazione. L'aggiornamento
deve coprire anche l'esecuzione SQL diretta, non soltanto il caso intercettato
dal router.

Impatto: le modifiche possono colpire un altro database con tabelle omonime.

### 3. [P2] La sessione PostgreSQL non recupera una connessione persa

Riferimenti: [sqlSessione.js:29](../../db/sqlSessione.js#L29),
[server/query.js:305](../../server/query.js#L305),
[server/connessioni.js:124](../../server/connessioni.js#L124).

Le query singole conservano un client PostgreSQL acquisito dal pool. Se il
backend viene terminato mentre la scheda è inattiva, il client rimane nello
stato della sessione e viene riutilizzato dalle query successive.

La prova identifica il PID della sola connessione di test tramite
`pg_backend_pid()` e un `application_name` casuale, ne verifica la proprietà e
termina esclusivamente quel backend. Due successive richieste `SELECT 1 n`
falliscono entrambe con:

```text
Client has encountered a connection error and is not queryable
```

Il messaggio non viene riconosciuto da `isConnectionError`, quindi non parte
la riconnessione. Il server HTTP e l'altra connessione MySQL restano attivi;
**non è stato osservato un arresto del server CodeDB**. Gli eventi di errore
del client arrivano al gestore globale delle eccezioni.

Correzione necessaria: gestire gli errori dei client assegnati alle sessioni,
invalidare il client guasto e ripristinare la connessione attraverso il percorso
previsto, conservando il divieto di ripetere automaticamente scritture di esito
incerto e la segnalazione delle transazioni perse.

Impatto: la scheda SQL rimane inutilizzabile finché non si ristabilisce
manualmente la connessione.

## Verifiche eseguite

- `npm test`: **superato**, con codice di uscita 0. Il primo tentativo nel
  sandbox è stato impedito da `EACCES` su localhost; la suite è stata rieseguita
  con accesso locale autorizzato.
- Riproduzioni reali su **PostgreSQL 18.6** e **MySQL 8.4.11**, tramite un server
  CodeDB isolato e Socket.IO. Schemi e database casuali creati per la prova sono
  stati rimossi. Il vault dell'utente non è stato usato.
- I cambi ordinari di schema, prima del rollback, funzionano; HTTP e MySQL
  continuano a rispondere dopo la perdita della connessione PostgreSQL.
- I difetti descritti sono riprodotti sul codice attuale. Non sono state
  applicate correzioni al prodotto durante questo controllo.

La suite unitaria verde non copre questi incroci fra stato della sessione,
bersaglio e recupero. Le precedenti matrici E2E non sono state rieseguite in
questo controllo; qui sono state aggiunte prove mirate ai percorsi scoperti.
Nessuna certificazione di compatibilità totale deriva da questo esito.

Artefatti: [riproduzione](quality-repro.cjs), [risultati](quality-results.json),
[log reale](quality-repro.log), [log unitari](quality-unit.log).

Per riprodurre, con lo stack SQL nativo locale già avviato:

```powershell
$env:CODEDB_E2E_DESTRUCTIVE='1'
node test-reports/query-languages/quality-repro.cjs
```

Il riproduttore legge le credenziali locali senza stamparle e usa soltanto
bersagli casuali registrati come propri. Il codice di uscita 0 indica che la
raccolta delle evidenze e la pulizia sono terminate: i campi `expected` e
`actual` mostrano i difetti, non un collaudo superato.
