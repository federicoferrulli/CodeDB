# 15: La Split-View diventa chiamante della griglia

**Cosa costruire:** affiancare due tabelle nello stesso spazio di lavoro non fa più perdere
metà dell'applicazione. La Split-View usa il modulo comune e guadagna le sei capacità che
oggi non ha: virtualizzazione, paginazione a chiave, selezione delle celle, scorrimento
automatico ai bordi, pannello delle chiavi esterne, geometrie.

È la terza copia della griglia, ed è quella che fa **meno** delle altre due: chi apre una
Split-View su una tabella grande oggi vede disegnare tutte le righe in una volta, senza
essere avvisato di ciò a cui sta rinunciando.

La geometria dell'albero dei riquadri — come si dividono, si ridimensionano e si trascinano
— non è toccata da questo ticket: è già coperta da test propri e resta com'è.

**Bloccato da:** 13.

**Status:** ready-for-agent

- [ ] La Split-View usa il modulo comune e la terza copia della griglia è rimossa
- [ ] Su una tabella grande le righe sono virtualizzate: un test lo dimostra
- [ ] Selezione delle celle, scorrimento ai bordi, pannello delle chiavi esterne e geometrie funzionano nei riquadri
- [ ] Modifica ed eliminazione dentro un riquadro continuano a funzionare
- [ ] I test sulla geometria dell'albero dei riquadri passano invariati
