# 27: Autenticare il server locale di Electron

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** Electron deve aprire o riutilizzare soltanto il server CodeDB che
dimostra di appartenere alla stessa istanza mediante un segreto casuale non pubblico.

- [ ] Ogni avvio genera o riceve un'identità casuale per istanza
- [ ] Il controllo localhost richiede una prova legata a tale identità, non un marker statico
- [ ] Il segreto non viene esposto alla pagina, ai log o a processi estranei
- [ ] Un servizio che occupa la porta e restituisce il marker pubblico viene rifiutato
- [ ] Un server autentico con prova errata viene rifiutato senza mostrare la sua pagina
- [ ] Test di processo coprono server autentico, processo estraneo e riuso valido
- [ ] La controprova basata sul solo marker rende rosso il test
