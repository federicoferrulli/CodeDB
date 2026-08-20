# 25: Il modulo tabellare espone una porta sola

**Cosa costruire:** comporre un frammento SQL per un motore usando le regole di
quotatura di un altro non è più esprimibile, perché le funzioni del modulo
comune non sono più raggiungibili se non legate al loro dialetto.

Oggi il modulo esporta sia la funzione che lega il dialetto sia le quattro
funzioni crude. Le crude accettano qualunque regola di quotatura: chiedere
l'ordinamento di una griglia MySQL passando le regole di PostgreSQL produce
`ORDER BY "nome" ASC` senza che nulla protesti — provato. Non è una via di fuga
per il motore che deve divergere (danno esattamente ciò che dà il metodo della
strategia, non un grammo di più): è solo la possibilità di accoppiarle male, e
la riconciliazione dei metodi gemelli ne verserà altre lì dentro.

La correzione è una **cancellazione**, non una guardia in più: si toglie dalla
superficie pubblica ciò che serviva solo alla prova, e la prova passa dalla
stessa porta della produzione — cosa che già fa nella sua ultima sezione.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** ready-for-agent

- [ ] Il modulo comune espone soltanto la funzione che lega un dialetto; le funzioni crude non sono più importabili
- [ ] I test del modulo esercitano le funzioni attraverso il dialetto legato, non crude, e restano altrettanto specifici sulle differenze fra i due motori
- [ ] Nessun chiamante fuori dai test usava le funzioni crude: verificato, non supposto
- [ ] La suite unitaria e i test end-to-end dei due motori SQL passano invariati
