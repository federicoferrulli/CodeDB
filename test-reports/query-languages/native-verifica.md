# Verifica del percorso SQL nativo — 14 ottobre 2026

Motori reali: **PostgreSQL 18.6, MySQL 8.4.11, MongoDB 8.0.29**.
Server CodeDB e vault isolati per le prove; database e schemi temporanei registrati
dalle fixture. Nessun database personale è stato usato come bersaglio dei test.

| Prova | Esito e copertura |
| --- | --- |
| `npm test` | Suite unitaria completa superata |
| `e2e-sql-native.js` | 117 istruzioni attraverso Socket.IO: tipi, CAST, precisione, Unicode, JSON null/SQL NULL, sessioni, temp table, ALTER, trigger, routine, cursori, SQL dinamico, vincoli, query relazionali, errori e savepoint, script e DELIMITER |
| `e2e-sql-native-ui.js` | Chromium con tre connessioni reali; DDL sulla destinazione PostgreSQL/MySQL, originale MongoDB e bozze conservati; selettore mobile |
| `e2e-sql-native-provisioning.js` | Autenticazione su entrambi i motori locali, stop/avvio, password identiche e dati conservati nei volumi; tabelle di prova rimosse |
| Regressioni SQL→MongoDB | 993 casi MongoDB, 715 confronti PostgreSQL, 319 confronti MySQL nelle cinque matrici avanzato/completamento/tipi/estesi/compatibilità |
| Regressioni supplementari | Eventi MQL, atomicità, integrità, migrazioni, inventari keyword e percorso query Socket.IO superati |
| `e2e-sql-mongo-failover.js` | 18 arresti del primario con nuova elezione e recupero su tre container distinti |
| Sensibilità dei test | Rilevate sei mutazioni backend: dialetto errato, sessione restituita al pool, SET prima del recupero, perdita di precisione PG/MySQL, DELIMITER non interpretato. Rilevata anche la mutazione UI che riusa una bozza invece di aprire la copia |

Le mutazioni vengono applicate soltanto nei processi/risposte HTTP di test, senza
modificare i file del prodotto. Ogni mutazione fallisce su un'asserzione pertinente;
gli errori di avvio del caricatore non sono considerati prova di sensibilità.

Log: `native-unit.log`, `native-e2e.log`, `native-ui.log`, `native-persistenza.log`,
`native-e2e-*.log`, `native-regressione-compat.log`, `native-failover.log` e
`native-mutant-*.log`. Versioni e conteggio native: `native-risultati.json`.

Lo stack persistente resta disponibile su `127.0.0.1:55432` e
`127.0.0.1:53306`; la configurazione riservata resta in `.env.sql-native`, escluso
da Git e dai pacchetti. Le connessioni del vault dell'utente non sono state
modificate e i dati MongoDB non sono stati migrati automaticamente.

Queste prove verificano i casi elencati, non ogni combinazione sintattica, versione,
estensione o client amministrativo dei DBMS. I failover usano tre container sullo
stesso host, non tre macchine. I controlli RBAC, di scope e di I/O restano attivi.
