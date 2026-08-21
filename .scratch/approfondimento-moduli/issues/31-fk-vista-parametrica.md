# 31: Il pannello delle chiavi esterne si apre da qualunque griglia

**Cosa costruire:** `fk-vista.js` riceve la griglia da cui è stato invocato, invece di
assumere quella della vista Dati.

L'indicatore 🔗 sulle colonne collegate e il pannello che scorre da destra con la riga
riferita oggi esistono solo nella vista Dati. Lo strato puro `fk-relazioni.js` — che
normalizza i descrittori delle tre sorgenti e sceglie la colonna-etichetta — è già
indipendente e non va toccato.

**Bloccato da:** 13.

**Status:** ready-for-agent

- [ ] Il pannello riceve contesto (tab, db, collection) e contenitore dal chiamante
- [ ] La vista Dati si comporta come oggi
- [ ] La capacità `chiaviEsterne` di un riquadro Split-View si accende, con un test
- [ ] Due riquadri su connessioni diverse mostrano ciascuno le PROPRIE relazioni
