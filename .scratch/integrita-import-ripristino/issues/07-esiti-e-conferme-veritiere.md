# 07: Rendere esiti e conferme veritieri

Status: ready-for-agent
Type: task
Blocked by: 05, 06

Allineare l'interfaccia al contratto reale del piano. Eliminare la promessa che il full
senza drop faccia sempre upsert e rendere visibili staging, recupero e stato di rollback.

- [ ] La conferma mostra connessione, destinazione, collezioni, identità e strategia di promozione
- [ ] Il testo non promette upsert se il piano non lo ha dimostrato
- [ ] `completato`, `ripristinato_dopo_errore` e `intervento_richiesto` hanno presentazioni distinte
- [ ] Un risultato parziale non usa mai messaggi o stile di successo
- [ ] La copia di recupero resta visibile con un'azione successiva esplicita per eliminarla
- [ ] Un tab riaperto ricostruisce avanzamento ed esito senza rilanciare l'operazione
- [ ] Test con socket finto coprono cambio e chiusura tab durante ogni stato
- [ ] La sensibilità viene verificata facendo tornare intenzionalmente un falso `completato`

