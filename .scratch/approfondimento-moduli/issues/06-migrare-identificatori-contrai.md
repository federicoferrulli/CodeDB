# 06: Migrare i chiamanti alla regola unica e rimuovere le copie (contrai)

**Cosa costruire:** tutti i punti che oggi decidono da sé come scrivere un identificatore
chiamano il modulo condiviso, e le copie sparse non esistono più.

I chiamanti sono sette: i due adattatori SQL, il modulo DDL di PostgreSQL, il motore dei
JOIN virtuali, la selezione di celle del frontend, il vocabolario dei dialetti, e il motore
di backup.

**Bloccato da:** 05.

**Status:** ready-for-agent

- [ ] Ogni chiamante usa il modulo condiviso
- [ ] Nessuna copia della regola sopravvive nel repo, verificato con una ricerca
- [ ] Un test copre il caso del nome con maiuscole su PostgreSQL attraverso almeno due chiamanti diversi
- [ ] I test end-to-end dei tre motori e quelli di backup passano invariati
