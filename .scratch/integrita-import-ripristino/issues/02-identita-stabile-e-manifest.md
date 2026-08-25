# 02: Dichiarare l'identità stabile nei manifest

Status: resolved
Type: task
Blocked by: nessuno

Definire la regola unica con cui un layer riconosce la stessa riga nel tempo e registrarla
nel manifest. Un timestamp seleziona le modifiche ma non identifica la riga.

- [x] MongoDB dichiara `_id` come identità
- [x] SQL dichiara PK oppure un vincolo univoco interamente non nullo
- [x] Una tabella senza identità stabile è ammessa nel full verso destinazione vuota ma rifiutata negli incrementali/differenziali
- [x] Il restore riverifica identità, colonne e compatibilità col manifest prima di scrivere
- [x] La versione del manifest distingue i nuovi backup da quelli storici
- [x] I backup storici non vengono promossi implicitamente a incrementali sicuri
- [x] La verifica finale confronta cardinalità e identità distinte, non la somma delle scritture
- [x] Un test rotto intenzionalmente dimostra di intercettare la duplicazione dei layer

## Commenti

Questo ticket è il prerequisito semantico degli upsert MySQL e PostgreSQL.

## Risposta

Introdotto il manifest v2 con identità stabile, schema delle colonne e cardinalità della
sorgente. MongoDB dichiara esclusivamente `_id`; MySQL e PostgreSQL scelgono una chiave
primaria oppure un vincolo univoco interamente `NOT NULL`. I backup incrementali e
differenziali senza identità vengono rifiutati, mentre il full senza identità è ammesso
soltanto verso una destinazione vuota. I manifest storici restano utilizzabili come full
ma non vengono accettati come base o layer di una catena incrementale.

Il restore esegue prima delle scritture il preflight dell'intera catena e riverifica
colonne, tipi, nullabilità, identità e compatibilità col database di destinazione. La
verifica finale confronta la cardinalità e il numero di identità distinte effettivamente
presenti con i valori dichiarati dalla sorgente, mantenendo separato il conteggio delle
scritture applicate.

La suite unitaria completa e la verifica dei marcatori passano. La sensibilità è stata
provata sostituendo temporaneamente il conteggio delle identità distinte con quello delle
scritture: il caso con layer sovrapposti è diventato rosso, quindi la prova intercetta la
duplicazione. Gli E2E MongoDB e MySQL non sono stati eseguiti fino alla semantica del
backup perché i servizi locali sulle porte `27017` e `3306` non erano disponibili.
