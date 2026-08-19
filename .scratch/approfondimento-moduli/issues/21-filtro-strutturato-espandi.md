# 21: Filtro strutturato accanto a quello testuale (espandi)

**Cosa costruire:** le tre strategie accettano un filtro come **dato** — un elenco di
condizioni con campo, operatore e valore — e ognuna lo rende nel proprio dialetto
parametrizzando. Il filtro testuale continua a funzionare accanto a quello nuovo: nessun
chiamante è ancora migrato e nulla si rompe.

Oggi lo stesso parametro significa tre cose diverse a seconda del motore: un frammento di
clausola grezzo sui due motori SQL, un documento sul motore documentale. La firma è piccola
ma l'invariante è enorme, e ogni chiamante deve sapere quale motore riceverà la chiamata —
il contrario della profondità.

È il lotto più caro e tocca l'area più calda del repo. Il blocco su 04 esiste perché lotto
1 e lotto 6 lavorano sugli stessi file e non vanno aperti insieme.

**Bloccato da:** 04.

**Status:** ready-for-agent

- [ ] Le tre strategie accettano il filtro strutturato e lo rendono parametrizzando
- [ ] Nessun valore finisce interpolato nel testo della query su nessuno dei tre motori
- [ ] Test unitari coprono la resa nei tre dialetti senza database
- [ ] Un test dimostra che un valore ostile non altera la struttura della query
- [ ] Il filtro testuale funziona come prima: l'intera suite passa invariata
