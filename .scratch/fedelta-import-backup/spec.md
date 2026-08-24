# Fedeltà del round-trip di import e backup

Status: ready-for-agent
Type: spec

Origine: diagnosi dinamica del 24 agosto 2026 sui percorsi `.codedb.json` e
backup/restore di MongoDB, MySQL e PostgreSQL.

---

## Problem Statement

Un export che termina correttamente non garantisce oggi che import o restore
ricostruiscano gli stessi valori, gli stessi tipi e lo stesso schema. Il difetto non è
limitato alle geometrie: i percorsi UI e CLI adottano codec e metadati differenti, e
alcuni valori vengono convertiti attraverso rappresentazioni JavaScript troppo povere.

Su MongoDB l'uso di Extended JSON relaxed negli artefatti può arrotondare un `Long`
oltre 53 bit e trasformare `Long(42)` o `Double(42.0)` in `Int32(42)`. Su PostgreSQL gli
array diventano testo JSON, le identity `ALWAYS` vengono nominate negli `INSERT`, le
sequenze dell'import UI non vengono riallineate e le espressioni delle colonne generate
non sono ricostruite. Su MySQL l'export UI legge tipi speciali con `SELECT *`: `BIGINT`,
binari, `BIT`, temporali e geometrie non hanno una rappresentazione archivistica
affidabile; inoltre le foreign key inline rendono la creazione dipendente dall'ordine.

L'export UI chiamato “database” omette anche parti dello schema che il backup tratta già:
opzioni e validator MongoDB, opzioni avanzate degli indici, view, routine, trigger,
eventi e sequenze SQL. Un esito verde può quindi descrivere un database utilizzabile ma
semanticamente diverso dall'origine.

## Solution

CodeDB introdurrà un contratto unico di round-trip per gli artefatti. Il contratto
separerà il formato usato nella UI dal formato archivistico, descriverà ogni colonna o
campo con i metadati necessari alla codifica e farà consumare a import UI e restore gli
stessi adattatori per tipo.

Un artefatto completo dovrà preservare:

1. valore e tipo logico di ogni dato rappresentabile dal DBMS;
2. nullabilità, default, identity, generazione e precisione delle colonne;
3. chiavi, indici e relative opzioni;
4. oggetti di schema necessari a ottenere lo stesso comportamento;
5. stato delle sequenze e SRID delle geometrie;
6. ordine e fasi necessarie a ricreare vincoli senza dipendere dall'ordine del file.

I formati storici resteranno leggibili. La compatibilità sarà esplicita: il lettore
riconoscerà la versione e applicherà soltanto conversioni non ambigue; non inventerà un
tipo BSON o SQL perso dall'artefatto.

## User Stories

1. Come utente MongoDB, voglio che `Long`, `Double`, `Decimal128` e gli altri tipi BSON
   tornino con lo stesso valore e lo stesso tipo dopo export/import o backup/restore.
2. Come utente PostgreSQL, voglio che array, `bytea`, intervalli, temporali e geometrie
   sopravvivano al round-trip senza diventare JSON o oggetti JavaScript.
3. Come utente PostgreSQL, voglio conservare colonne generate, identity e sequenze senza
   errori durante il caricamento né collisioni al primo inserimento successivo.
4. Come utente MySQL, voglio preservare `BIGINT`, binari, `BIT`, temporali, geometrie e
   colonne generate senza dipendere dalle conversioni predefinite di `mysql2`.
5. Come amministratore, voglio che tabelle con foreign key si ricreino in qualunque
   ordine valido dell'artefatto.
6. Come amministratore, voglio sapere se un export è completo oppure dati-only, così che
   view, trigger, routine, validator o opzioni mancanti non siano una sorpresa.
7. Come manutentore, voglio un solo codec archivistico per strategia, condiviso da UI e
   CLI, così che correggere un tipo non lasci rotto l'altro percorso.

## Implementation Decisions

### Formato archivistico

- MongoDB usa Extended JSON canonico (`relaxed: false`) per dati e metadati BSON.
- Il formato di trasporto della griglia non cambia: la canonicalizzazione riguarda
  soltanto artefatti destinati al round-trip.
- SQL usa una descrizione di colonna proveniente dal catalogo e un codec per famiglia di
  tipo; non deduce il significato dal solo valore JavaScript.
- Buffer, array SQL, JSON, temporali, intervalli e geometrie restano categorie distinte.
- Manifest e `.codedb.json` aumentano versione e dichiarano capacità e oggetti inclusi.

### PostgreSQL

- Gli array vengono passati come array nativi del driver o come testo PostgreSQL
  prodotto dal codec, mai come JSON generico.
- Le colonne generate sono escluse dai dati e ricostruite dalla loro espressione di
  catalogo.
- Un full preserva i valori identity. Per `GENERATED ALWAYS` il caricamento usa
  `OVERRIDING SYSTEM VALUE`; al termine tutte le sequenze vengono riallineate allo stato
  registrato nell'artefatto.
- `bytea`, intervalli, temporali e geometrie usano la stessa estrazione tipizzata già
  presente nel motore di backup.

### MySQL

- La connessione e le query archivistiche non lasciano che `mysql2` arrotondi i `BIGINT`.
- Binari e `BIT` usano rappresentazioni esadecimali; geometrie conservano WKB e SRID;
  temporali vengono estratti come testo con la precisione dichiarata.
- Le colonne generate sono escluse dagli `INSERT`.
- Foreign key e indici differibili vengono separati dal `CREATE TABLE` e applicati dopo
  la creazione e il caricamento di tutte le tabelle.

### Completezza dello schema

- MongoDB conserva opzioni delle collection, validator, view e tutte le opzioni
  ricreabili degli indici.
- MySQL e PostgreSQL conservano gli oggetti di schema supportati dal backup: view,
  routine, trigger, eventi o sequenze secondo il motore.
- Un oggetto non supportato produce una capability mancante o un errore esplicito prima
  dell'import; non viene omesso silenziosamente da un artefatto dichiarato completo.

## Testing Decisions

Una matrice pura verifica codec e manifest; E2E mirati verificano soltanto ciò che
dipende dal driver o dal DBMS. Ogni matrice contiene almeno:

- MongoDB: `Long` oltre 53 bit, `Long` piccolo, `Int32`, `Double` intero e frazionario,
  `Decimal128`, `Binary`, `Timestamp`, regex, date e valori annidati;
- PostgreSQL: array scalari e multidimensionali, `bytea`, JSON/JSONB, intervallo,
  timestamp con precisione, geometria, generated, serial e identity `ALWAYS`/`BY DEFAULT`;
- MySQL: signed/unsigned `BIGINT`, `BLOB`/`BINARY`, `BIT`, temporali frazionari,
  geometria con SRID, generated e foreign key tra tabelle esportate in ordine inverso;
- schema: opzioni avanzate degli indici, validator, view e almeno un oggetto eseguibile
  proprio di ciascun motore.

Ogni scenario esegue sia export/import sia backup/restore e confronta valore, tipo e
metadati risultanti. La sensibilità viene dimostrata almeno una volta ripristinando il
vecchio codec relaxed o il vecchio `SELECT *` e osservando il test rosso.

## Out of Scope

- Conversione automatica fra DBMS diversi: il round-trip è sullo stesso motore.
- Preservare oggetti che il DBMS di destinazione non sa creare o per cui il principal
  non possiede capability; il rifiuto esplicito è conforme.
- Cambiare EJSON usato dalla griglia, dagli editor o dalle API di singola riga.
- Atomicità, staging e recupero dopo errore, già coperti dalla specifica
  `integrita-import-ripristino`.

## Further Notes

Questa specifica è complementare a `integrita-import-ripristino`: quella impedisce
mutazioni parziali o non autorizzate, questa definisce quando il risultato è fedele.
Il motore unico previsto dalla specifica precedente dovrà consumare i codec e i manifest
definiti qui, senza incorporarli in una seconda implementazione.
