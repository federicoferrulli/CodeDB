# 20: Introdurre l'amministrazione tenant-level

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** Un principal delegato deve poter amministrare utenti, grant e chiavi
API tramite una capability tenant-level distinta dalle capability su connessione.

- [ ] La capability amministrativa non richiede un database o una collezione artificiali
- [ ] Owner e root conservano il comportamento attuale
- [ ] Un principal delegato può eseguire soltanto gli eventi amministrativi previsti
- [ ] Un grant su una connessione non conferisce implicitamente amministrazione tenant
- [ ] Audit e revoca immediata registrano correttamente il principal delegato
- [ ] Test di autorizzazione coprono allow e deny per utenti, grant e chiavi API
- [ ] La controprova che passa dalla verifica priva di connessione rende rosso il test

