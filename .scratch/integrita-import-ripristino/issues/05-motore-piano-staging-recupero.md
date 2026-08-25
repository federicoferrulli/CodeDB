# 05: Costruire il motore di piano, staging e recupero

Status: resolved
Type: task
Blocked by: 01, 02, 03, 04

Creare il seam principale della specifica: un motore server-side che costruisce un piano
immutabile, protegge la destinazione, applica l'artefatto, verifica il risultato e
promuove o recupera secondo la strategia.

- [x] Nessuna mutazione avviene prima della validazione completa del piano
- [x] Una destinazione esistente dispone di una copia di recupero full verificata
- [x] PostgreSQL promuove lo staging con swap di schema atomico
- [x] MySQL e MongoDB dichiarano le garanzie reali e conservano staging/recupero fino a eliminazione esplicita
- [x] Un errore in ogni fase produce `ripristinato_dopo_errore` o `intervento_richiesto`, mai un falso successo
- [x] La verifica finale copre dati, collezioni e oggetti di schema
- [x] Il piano e la sua impronta restano immutabili fra anteprima ed esecuzione
- [x] Il motore è provato con una strategia finta registrante senza database
- [x] Ogni test di fase viene reso rosso rompendo intenzionalmente la barriera corrispondente

## Commenti

Su DBMS senza swap completo non va promessa atomicità. La proprietà richiesta è che una
copia verificata e recuperabile sopravviva sempre all'operazione.

## Risposta

Introdotti il piano immutabile con impronta SHA-256, l'orchestratore a fasi e l'adapter
reale. La validazione precede staging e righe; una destinazione esistente riceve un full
verificato. PostgreSQL rinomina gli schemi nella stessa transazione; MongoDB e MySQL
promuovono da una copia verificata e conservano recupero/staging. La verifica controlla
nomi, cardinalità, identità distinte, indici MongoDB e oggetti SQL differiti. I test
registranti coprono errori pre-mutazione, staging, applicazione, entrambe le verifiche,
promozione e recupero. Disabilitando l'impronta, il test dell'alterazione è diventato
rosso.
