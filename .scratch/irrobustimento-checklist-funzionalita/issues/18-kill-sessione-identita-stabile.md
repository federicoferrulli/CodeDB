# 18: Terminare una sessione mediante identità stabile

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** L'operatore deve terminare la stessa sessione che ha ispezionato, non
una sessione successiva che abbia riutilizzato lo stesso identificatore numerico.

- [ ] Ogni strategia espone l'identità più stabile disponibile oltre al PID o operation ID
- [ ] La richiesta di kill conserva l'identità osservata nella conferma
- [ ] La strategia rivalida tale identità immediatamente prima del comando distruttivo
- [ ] Un'identità cambiata produce un rifiuto parlante e non termina alcuna sessione
- [ ] Test simulano la sostituzione della sessione fra elenco e kill
- [ ] La controprova basata sul solo identificatore numerico rende rosso il test

