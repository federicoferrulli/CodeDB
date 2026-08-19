# 22: Migrare i chiamanti del frontend al filtro strutturato

**Cosa costruire:** la griglia e il pannello delle chiavi esterne compongono filtri
strutturati invece di frammenti di testo, e smettono di dover sapere quale motore riceverà
la richiesta.

Il pannello delle chiavi esterne è il caso più istruttivo: oggi il filtro con cui cerca le
righe riferite deve essere parametrizzato dentro ciascuna strategia, proprio perché quello
che gli arriva dal frontend è testo grezzo.

**Bloccato da:** 21.

**Status:** ready-for-agent

- [ ] La griglia compone filtri strutturati
- [ ] Il pannello delle chiavi esterne compone filtri strutturati
- [ ] Nessun frammento di clausola è più costruito nel browser, verificato con una ricerca
- [ ] Filtrare una griglia e cercare nell'elenco delle righe riferite funziona sui tre motori
- [ ] I test end-to-end dei tre motori passano invariati
