# 03: Modulo tabellare comune — le quattro funzioni identiche

**Cosa costruire:** la composizione dell'identificatore di riga, la sua lettura, la
costruzione dell'ordinamento e quella della lista di selezione smettono di esistere in due
copie, una per motore SQL, e vivono in un modulo solo che i due adattatori chiamano.

Le quattro sono oggi byte per byte identiche fra i due adattatori, messaggio d'errore e
costanti compresi: correggerne una richiede due modifiche, e nulla segnala la seconda.

Sono funzioni pure — ricevono descrittori di colonna e restituiscono frammenti — quindi si
provano senza alcun database acceso, che oggi non è possibile per nessuna di esse.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** done

- [x] Le quattro funzioni hanno una sola implementazione, chiamata da entrambi gli adattatori SQL
- [x] Ognuna ha test unitari che girano senza database
- [x] Almeno un test è stato verificato rompendo di proposito il codice che protegge
- [x] I test end-to-end dei due motori SQL passano invariati
- [x] Il comportamento osservabile non cambia in nessun caso

---

## Che cosa è stato fatto, e che cosa NON è stato provato

Le quattro funzioni vivono in `db/sqlTabellare.js`, legate al dialetto
(`qid`, `qtable`, `whereFromId`) che resta di ciascun adattatore. Test:
`test/unit-sql-tabellare.js`, registrato in `test/unit.js`, nessun database.

**La sensibilità dei test è stata verificata** rompendo di proposito il codice,
tre volte: tolto il ripiego sull'intera riga in `componiIdRiga`, tolta la
quotatura della colonna in `componiOrdinamento`, e rimessa una copia locale in
`MySqlStrategy`. Tutte e tre fanno fallire la suite.

**Estensione oltre le quattro funzioni, dichiarata.** La prima stesura aveva
aggiunto una *terza* copia di `parseClientValue`: chiudeva quattro duplicati e
ne apriva uno, cioè allargava la classe di difetto che stava chiudendo. Le
quattro funzioni di conversione EJSON ↔ parametri SQL (`toSqlValue`,
`parseClientValue`, `deserializeClientObject`, `serializeRow`) erano anch'esse
byte per byte identiche nei due adattatori: ora stanno in `db/sqlValori.js`, e
il test sorveglia che non ricompaiano. Restano fuori le geometrie, dove il
formato nativo di PostgreSQL non ha corrispettivo su MySQL.

**Gli E2E dei due motori sono stati eseguiti davvero**, contro MySQL 8 e
PostGIS 16 in container, e confrontati con la stessa esecuzione su HEAD:
- MySQL: 2 fallimenti (`db:rename` non atomica), **identici prima e dopo**;
- PostgreSQL: 3 fallimenti al punto 9-bis (FK fra schemi) che interrompono la
  corsa, **identici prima e dopo**.

Sono difetti preesistenti e scorrelati da questa modifica: "invariati" è quindi
provato nel senso letterale, ma i due motori **non** hanno una corsa E2E verde
da cui partire, e le fasi successive al punto 9-bis su PostgreSQL restano non
coperte da questa verifica.
