# 06: Rendere esatto e atomico l'incolla di celle

Status: completed
Type: task
Blocked by: 04: Preservare numeri esatti nell'editing inline

**What to build:** L'incolla deve validare l'intero blocco con i tipi delle colonne e una
convenzione temporale esplicita prima di applicare la prima modifica.

- [x] Numeri esatti usano il codec del ticket 04
- [x] Date, timestamp locali e istanti UTC sono distinti e presentati senza conversioni implicite
- [x] Tutte le celle vengono validate prima di inviare la prima mutazione
- [x] Un errore identifica riga e colonna e lascia il database invariato
- [x] Test coprono grandi interi, decimali, fusi e passaggi dell'ora legale
- [x] La controprova che applica una cella prima del preflight rende rosso il test

**Cosa c'era già (dal ticket 04) e cosa mancava:** `coercePasted` (public/js/cellselect.js)
usava già il codec esatto di `valori-esatti.js` per i numeri, e `pasteIntoGrid` costruiva già
l'intero blocco (`try { grid.forEach… } catch`) PRIMA di mandare qualunque `doc:update` — quindi
atomicità del preflight ed errore con riga/colonna erano già a posto. Il difetto vero era nella
convenzione temporale: `coercePasted` controllava `valueType(current) === 'date'` PRIMA del tipo
DICHIARATO dalla colonna. Su ogni motore SQL una colonna già valorizzata arriva in EJSON come
`{$date}` qualunque sia il suo tipo — quindi quel controllo catturava SEMPRE una cella non vuota,
e una DATE o una DATETIME naive finivano trattate come istante (pretendendo un fuso esplicito che
non hanno mai avuto). Il ramo che distingueva DATE/DATETIME/TIMESTAMPTZ dal tipo di colonna
esisteva già più sotto nella funzione, ma era irraggiungibile per qualunque cella non nulla. Fix:
i controlli sul tipo dichiarato dalla colonna vengono ora PRIMA del controllo generico
`type === 'date'`, che resta come ultima risorsa per MongoDB (nessun tipo di colonna SQL, un
`$date` è sempre un istante).

Test: `test/e2e-incolla-esatto-atomico.js` (Chromium). Sensibilità verificata rompendo di
proposito sia l'ordine dei controlli in `coercePasted` sia l'atomicità di `pasteIntoGrid`
(scrittura anticipata dentro il ciclo di validazione): in entrambi i casi il test è diventato
rosso, poi il codice è stato ripristinato.

