# Correzioni e nuovo controllo qualità — 14 ottobre 2026

**Esito: i tre problemi del controllo precedente sono risolti e verificati sui
database reali. Nessun ulteriore difetto bloccante individuato nella revisione
finale del perimetro modificato.**

Le query ordinarie ristabiliscono la destinazione richiesta prima dell'esecuzione.
Le sessioni SQL riconoscono i client interrotti, consentono il ripristino senza
ripetere automaticamente l'operazione e rilasciano correttamente le risorse.

## Correzioni

1. **PostgreSQL dopo rollback/savepoint.** Eliminata la cache di `search_path` e
   del timeout. Lo schema richiesto viene applicato alle query ordinarie anche
   dopo rollback completo, savepoint annidati, `SET LOCAL`, `set_config`,
   `RESET ALL` e `DISCARD ALL`. I comandi di recupero continuano a precedere
   qualsiasi `SET`, anche quando la transazione è abortita.
   [PostgreSqlStrategy.js](../../db/PostgreSqlStrategy.js)

2. **MySQL dopo USE.** Il database richiesto viene ristabilito a ogni esecuzione,
   anche dopo un `USE` passato come SQL diretto. Le regressioni controllano il
   contenuto di entrambi i database, quindi una scrittura nella destinazione
   sbagliata non può passare inosservata.
   [MySqlStrategy.js](../../db/MySqlStrategy.js)

3. **Connessione SQL persa.** I client acquisiti hanno un listener di errore
   associato alla sessione; il client guasto non riceve altre query. I codici di
   perdita della connessione e i relativi messaggi dei driver attivano il
   ripristino. La richiesta fallita non viene ripetuta; l'errore segnala anche
   la perdita dello stato della precedente sessione SQL.
   [sqlSessione.js](../../db/sqlSessione.js),
   [connessioni.js](../../server/connessioni.js)

Durante la verifica sono emersi e sono stati corretti anche due problemi
collegati: il proxy dei tetti usava identità diverse per query e disconnessione,
lasciando client occupati e bloccando il ripristino; il riconoscimento locale
delle transazioni ignorava il dialetto nei commenti PostgreSQL annidati.
Ora apertura, query e chiusura condividono la stessa strategia, e il lexer usa
il dialetto effettivo anche per aggiornare lo stato della transazione.
[tetti.js](../../db/tetti.js)

## Prove eseguite

Motori: PostgreSQL **18.6**, MySQL **8.4.11**, MongoDB **8.0.29**.

| Prova | Risultato |
| --- | --- |
| `npm test` dopo l'ultima correzione | Tutta la suite superata, comprese le nuove unità sulle sessioni |
| `npm run test:e2e:sql-native` | 117 istruzioni native precedenti e 12 nuove regressioni superate |
| Nuove regressioni | Destinazione dopo rollback/savepoint/USE; configurazioni SQL; commenti annidati e letture protette; connessioni interrotte inattive e durante scritture; transazione persa; nessun replay; disconnessione con rollback e rilascio dei client |
| UI nativa reale | Copia sul motore scelto, DDL nella destinazione corretta, bozze e originale conservati, selettore mobile |
| Editor dei linguaggi | Completamento, formattazione, tastiera e dropdown desktop/mobile |
| Tetti di scrittura | Query realmente interrotte su PostgreSQL/MySQL e connessione successiva utilizzabile; nessun motore saltato |
| Cinque matrici SQL→MongoDB precedenti | 993 verifiche MongoDB, 715 confronti PostgreSQL, 319 MySQL |
| Suite aggiuntiva delle varianti | 73 verifiche MongoDB, 35 confronti PostgreSQL e 52 MySQL; comprende casi già presenti nelle matrici |
| Eventi, atomicità, integrità, migrazioni e percorso Socket.IO | Tutte le suite superate |
| Inventari reali delle keyword | 734 MySQL e 494 PostgreSQL; confronti delle query originali/formattate e dell'SQL comune superati |
| Failover MongoDB | 18 arresti reali del primario, elezione e recupero su tre container distinti |
| Stack SQL persistente | Autenticazione, stop/avvio, credenziali conservate e dati di prova persistenti |
| Sensibilità dei test | 13 mutazioni rilevate: 6 nuove e 7 precedenti, inclusa la copia UI |

Le nuove regressioni hanno fallito prima delle correzioni. Le mutazioni sono
state applicate soltanto nei processi di prova: ogni mutazione conteggiata ha
fallito su un'asserzione pertinente. Gli errori iniziali del caricatore di
mutazioni non sono stati conteggiati come prove riuscite.

## Check qualità finale

Riletti i percorsi di esecuzione, riconnessione e disconnessione, i proxy di
autorizzazione e dei limiti, il rilascio dei pool, la gestione dei listener e
i chiamanti dello stato SQL. Verificati anche l'assenza di ripetizioni automatiche
delle scritture, gli errori delle transazioni, l'isolamento dei bersagli e la
pulizia delle fixture. `git diff --check` non segnala problemi nei file modificati.

Il caso aggiuntivo dei commenti annidati è stato riprodotto sul database reale,
corretto e protetto con una mutazione dedicata. Dopo questa correzione sono state
rieseguite sia la suite unitaria completa sia quella SQL nativa completa.

**Verdetto: i difetti individuati nel perimetro sono chiusi.** La revisione
riguarda le modifiche SQL e di sessione; non è un audit delle modifiche estranee
presenti nello stesso workspace. Le prove coprono le versioni e gli scenari
elencati, non ogni estensione o combinazione possibile dei DBMS. I failover
usano tre container sullo stesso host, non tre macchine separate.

## Riproducibilità ed evidenze

- [Nuove regressioni reali](../../test/e2e-sql-native-sessioni.js)
- [Nuove unità sulle sessioni](../../test/unit-sql-sessioni.js)
- [Configurazione delle fixture e comandi](../../docs/sql-nativo.md)
- [Riepilogo strutturato](fix-risultati.json)
- [Suite nativa finale](fix-native-finale.log), [unitari finali](fix-unit-finale.log)
- [Failover](fix-failover.log), [persistenza](fix-provisioning.log)
- [UI nativa](fix-e2e-sql-native-ui.log), [tetti di scrittura](fix-e2e-tetto-scrittura.log)
- Matrici e regressioni supplementari: `fix-e2e-sql-mongo-*.log`, `fix-compatibilita.log`.
- Le 13 evidenze di mutazione sono elencate in `fix-risultati.json`.

Il [rapporto precedente](quality-verifica.md) e le sue evidenze restano conservati
come fotografia dei difetti prima della correzione.

I cinque container di prova e i loro volumi sono stati rimossi dopo il controllo
delle etichette di proprietà. Lo stack SQL persistente resta attivo e sano su
55432 e 53306. Le connessioni del vault dell'utente non sono state modificate.
