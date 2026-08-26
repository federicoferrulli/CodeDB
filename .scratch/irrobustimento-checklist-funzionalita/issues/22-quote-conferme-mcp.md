# 22: Limitare le conferme MCP pendenti

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** Le conferme MCP devono avere consumo di memoria prevedibile mediante
quote per principal e globali, espresse sia in numero sia in byte.

- [ ] Ogni conferma registra il proprio costo entro un budget misurabile
- [ ] Limiti per principal impediscono a una chiave di esaurire la quota globale
- [ ] Il limite globale protegge il processo anche con molti principal
- [ ] Scadenza e consumo della conferma liberano immediatamente piano e chiusure
- [ ] Il superamento della quota produce un errore stabile senza creare una nuova conferma
- [ ] Test con piani numerosi e grandi verificano limite, cleanup e successiva riusabilità
- [ ] La controprova senza quota rende rosso il test di memoria contabilizzata

