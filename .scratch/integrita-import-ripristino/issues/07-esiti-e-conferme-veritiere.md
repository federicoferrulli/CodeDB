# 07: Rendere esiti e conferme veritieri

Status: resolved
Type: task
Blocked by: 05, 06

Allineare l'interfaccia al contratto reale del piano. Eliminare la promessa che il full
senza drop faccia sempre upsert e rendere visibili staging, recupero e stato di rollback.

- [x] La conferma mostra connessione, destinazione, collezioni, identità e strategia di promozione
- [x] Il testo non promette upsert se il piano non lo ha dimostrato
- [x] `completato`, `ripristinato_dopo_errore` e `intervento_richiesto` hanno presentazioni distinte
- [x] Un risultato parziale non usa mai messaggi o stile di successo
- [x] La copia di recupero resta visibile con un'azione successiva esplicita per eliminarla
- [x] Un tab riaperto ricostruisce avanzamento ed esito senza rilanciare l'operazione
- [x] Test con socket finto coprono cambio e chiusura tab durante ogni stato
- [x] La sensibilità viene verificata facendo tornare intenzionalmente un falso `completato`

## Risposta

La conferma deriva esclusivamente dall'anteprima firmata del piano. Gli esiti canonici
hanno etichette e stili distinti; soltanto `completato` usa il successo. Recupero e
staging restano nel report con eliminazione esplicita, e lo stato è ricostruito dal
registro senza retry. La controprova che trasformava un rollback in `completato` ha reso
rosso il test del motore.

La descrizione visuale dei tre esiti terminali e ora un seam puro provato direttamente;
il rollback emette avanzamento `in_corso`/`completata`, quindi UI e audit possono
ricostruire anche il tentativo di recupero senza inferirlo dal solo stato finale.

Anche i restore UI, CLI e MCP conservano l'esito canonico completo. Il token MCP è
legato all'intera selezione confermata; la deroga CLI `--allow-unsafe-schema` resta
esplicita e fa parte dell'impronta auditabile.
