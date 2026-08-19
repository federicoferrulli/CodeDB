# 04: Riconciliare i metodi quasi-gemelli nel modulo comune

**Cosa costruire:** gli altri metodi che i due adattatori SQL implementano con lo stesso
nome — paginazione a chiave, informazioni sulle colonne, indici unici, chiave primaria,
conteggio stimato, elenco dei campi — hanno una sola implementazione nel modulo comune.

A differenza dei quattro del ticket precedente questi **non** sono identici: divergono su
dettagli di dialetto. La riconciliazione deve rendere le differenze esplicite come dati
del dialetto, non nasconderle dietro rami condizionali sparsi.

Ciò che diverge davvero — scrittura degli identificatori, tipi di colonna, DDL, geometrie,
sessioni e lock — resta negli adattatori e non entra nel modulo comune.

**Bloccato da:** 03.

**Status:** ready-for-agent

- [ ] Ogni metodo riconciliato ha una sola implementazione e test unitari senza database
- [ ] Le differenze fra i due motori sono dichiarate come dati, non come rami sparsi nel corpo
- [ ] Per ogni metodo riconciliato esiste un test che copre entrambi i dialetti
- [ ] I test end-to-end dei due motori SQL passano invariati
- [ ] L'interfaccia degli adattatori si è accorciata: i metodi spostati non vi compaiono più
