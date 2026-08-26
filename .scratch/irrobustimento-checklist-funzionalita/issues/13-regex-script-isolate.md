# 13: Isolare le regex degli script con un budget terminabile

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** Una regex costosa in uno script Mongo deve scadere senza bloccare il
thread degli eventi o rendere indisponibili le altre sessioni.

- [ ] La valutazione avviene in un ambiente isolato che può essere terminato
- [ ] Tempo, dimensione dell'input e dimensione del pattern hanno budget espliciti
- [ ] Lo scadere produce un errore parlante associato al run
- [ ] Dopo il timeout handshake e un secondo evento rispondono normalmente
- [ ] Le euristiche esistenti restano una difesa preventiva, non l'unica barriera
- [ ] La controprova sul thread principale rende rosso il test di responsività

