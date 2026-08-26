# 26: Unificare il pinning SSH di test e connessione

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** Test e apertura di una connessione SSH devono verificare la stessa
identità host e dichiarare successo soltanto dopo approvazione e persistenza del pinning.

- [ ] Entrambi i percorsi usano un solo protocollo di verifica della chiave host
- [ ] Una chiave nuova richiede approvazione esplicita oppure TOFU persistito con successo
- [ ] Un errore di persistenza impedisce di dichiarare riusciti test e connessione
- [ ] Una chiave cambiata viene rifiutata prima dell'autenticazione delle credenziali
- [ ] Test coprono chiave nuova, nota, cambiata e archivio non scrivibile
- [ ] La controprova che salta il pinning durante il test rende rosso il test

