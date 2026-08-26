# 06: Rendere esatto e atomico l'incolla di celle

Status: ready-for-agent
Type: task
Blocked by: 04: Preservare numeri esatti nell'editing inline

**What to build:** L'incolla deve validare l'intero blocco con i tipi delle colonne e una
convenzione temporale esplicita prima di applicare la prima modifica.

- [ ] Numeri esatti usano il codec del ticket 04
- [ ] Date, timestamp locali e istanti UTC sono distinti e presentati senza conversioni implicite
- [ ] Tutte le celle vengono validate prima di inviare la prima mutazione
- [ ] Un errore identifica riga e colonna e lascia il database invariato
- [ ] Test coprono grandi interi, decimali, fusi e passaggi dell'ora legale
- [ ] La controprova che applica una cella prima del preflight rende rosso il test

