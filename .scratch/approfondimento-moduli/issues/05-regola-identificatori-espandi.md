# 05: Regola unica per la scrittura degli identificatori (espandi)

**Cosa costruire:** esiste un modulo condiviso, usabile dal frontend, dagli adattatori e
dal motore di backup, che sa per ogni motore **se** un nome vada quotato e come raddoppiare
il carattere di quotatura.

Oggi la stessa decisione è presa in sette punti diversi, e uno solo di questi sa anche *se*
quotare: gli altri quotano sempre o mai. È la classe di difetto per cui un nome con
maiuscole su PostgreSQL viene abbassato e la tabella non si trova.

Questo ticket **espande soltanto**: nessun chiamante viene ancora migrato, le sette copie
restano al loro posto e nulla cambia nel comportamento.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** ready-for-agent

- [ ] Il modulo condiviso è importabile dal frontend, dagli adattatori e dal motore di backup
- [ ] Copre le tre famiglie di motore e distingue il caso in cui la quotatura non serve
- [ ] Ha test unitari, compresi i nomi che richiedono il raddoppio del carattere di quotatura e i nomi qualificati da uno schema
- [ ] Almeno un test è stato verificato rompendo di proposito il codice che protegge
- [ ] Nessun comportamento esistente è cambiato: la suite passa invariata
