# 05: Costruire il motore di piano, staging e recupero

Status: ready-for-agent
Type: task
Blocked by: 01, 02, 03, 04

Creare il seam principale della specifica: un motore server-side che costruisce un piano
immutabile, protegge la destinazione, applica l'artefatto, verifica il risultato e
promuove o recupera secondo la strategia.

- [ ] Nessuna mutazione avviene prima della validazione completa del piano
- [ ] Una destinazione esistente dispone di una copia di recupero full verificata
- [ ] PostgreSQL promuove lo staging con swap di schema atomico
- [ ] MySQL e MongoDB dichiarano le garanzie reali e conservano staging/recupero fino a eliminazione esplicita
- [ ] Un errore in ogni fase produce `ripristinato_dopo_errore` o `intervento_richiesto`, mai un falso successo
- [ ] La verifica finale copre dati, collezioni e oggetti di schema
- [ ] Il piano e la sua impronta restano immutabili fra anteprima ed esecuzione
- [ ] Il motore è provato con una strategia finta registrante senza database
- [ ] Ogni test di fase viene reso rosso rompendo intenzionalmente la barriera corrispondente

## Commenti

Su DBMS senza swap completo non va promessa atomicità. La proprietà richiesta è che una
copia verificata e recuperabile sopravviva sempre all'operazione.

