# 24: Contrarre — via il filtro testuale e il firewall sintattico

**Cosa costruire:** il filtro testuale non esiste più, e con esso le circa 460 righe di
analisi sintattica difensiva che esistevano soltanto perché quel testo attraversava
l'interfaccia della strategia.

Sparisce anche il metodo separato per leggere le righe riferite da una chiave esterna: era
un metodo a sé **dichiaratamente** perché sui motori SQL il filtro era un frammento grezzo
interpolato tal quale. Tolta la causa, rientra nel metodo comune e l'interfaccia si accorcia.

È il ticket che incassa il guadagno dell'intero lotto: finché il filtro testuale vive
accanto a quello strutturato, il costo è pagato e il beneficio no.

Attenzione: l'analisi sintattica difensiva va rimossa **solo** per la parte che serviva ai
filtri. Ciò che protegge l'esecuzione di query libere scritte dall'utente resta: quella
superficie non è toccata da questo lotto.

**Bloccato da:** 22, 23.

**Status:** ready-for-agent

- [ ] Nessun chiamante passa più un filtro testuale, e le strategie non lo accettano più
- [ ] L'analisi sintattica difensiva dei filtri è rimossa; quella delle query libere resta
- [ ] Il metodo separato per le righe riferite non esiste più e la sua funzione è nel metodo comune
- [ ] Un test dimostra che una query libera fuori dallo scope viene ancora negata
- [ ] I test di autorizzazione, del gateway e i test end-to-end dei tre motori passano invariati
