# 05: Preservare numeri esatti durante l'inserimento

Status: ready-for-agent
Type: task
Blocked by: 04: Preservare numeri esatti nell'editing inline

**What to build:** La modale di inserimento deve applicare lo stesso contratto numerico
dell'editing inline, producendo valori identici per lo stesso testo e tipo.

- [ ] Inserimento ed editing condividono il codec esatto del ticket 04
- [ ] BIGINT, Long e Decimal conservano valore e tipo fino alla strategia
- [ ] Gli errori indicano la colonna e non inviano una mutazione parziale
- [ ] Test equivalenti inseriscono e modificano gli stessi valori limite
- [ ] Il valore riletto è identico nei due percorsi
- [ ] La controprova con conversione Number nell'inserimento rende rosso il test

