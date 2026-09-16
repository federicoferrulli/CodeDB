Status: resolved

# Fase 0 — Baseline e matrice

Piano: `docs/piano-export-import-database.md` §11, riga «0 — Baseline e matrice».

## Perimetro

Inventario di ciò che il repo copre OGGI, senza cambiare comportamento: strategie,
`backup/lib/*`, helper di tipi e schema, test esistenti. Versioni, topologie e oggetti
per i tre motori. Baseline prestazionale e dataset di prova fissati.

## Criterio di uscita (dal piano)

Copertura attuale riprodotta, perdite e limiti classificati; dataset e ambiente di
benchmark fissati; formato contenitore e tool scelti.

## Note

La matrice di §6 (dati, schema e oggetti) è un **deliverable** di questa fase e viene
poi mantenuta dai test: ogni riga deve dire se è coperta, coperta parzialmente o non
coperta, e da quale prova.

## Risposta

Fase 0 chiusa. Tre deliverable:

- `docs/matrice-fedelta-export-import.md` — la matrice di §6, con i verdetti distinti fra
  il percorso **backup** e il percorso **`.codedb.json`**, che non hanno la stessa
  fedelta'. Ogni riga dice se il verdetto e' misurato, letto dal codice o non verificato.
- `docs/adr/0003-contenitore-e-strumenti-dell-export.md` — il contenitore resta la
  cartella di backup; lo ZIP entra solo come confezionamento finale opzionale; gli
  strumenti nativi NON si scelgono in Fase 0, per mancanza di baseline.
- `docs/benchmark-export-import.md` — cinque profili di dataset, ambiente da dichiarare,
  sei tempi da tenere separati. Nessuna misura eseguita.

Riscontri principali (misurati, non supposti):

1. Il motore di backup **scrive** in EJSON relaxed e **rilegge** in canonico. Il valore
   non si perde (la patch CDB-04 copre i Long oltre 2^53), ma il TIPO si': `Double(3)` e
   `Long(5)` tornano `Int32`. Il canonico round-trippa tutti e quindici i casi provati.
2. La patch CDB-04 vale per effetto collaterale di caricamento (`DbFactory` importa
   `MongoDbStrategy`). In un processo che carica solo `backup/lib/engine.js` non c'e'.
3. L'export `.codedb.json` dell'interfaccia NON applica i rimedi conservativi del motore
   di backup: un BLOB/`bytea` diventa `{"0":0,"1":255,...}`, un `DATETIME(6)` perde i
   microsecondi, un `TIMESTAMP` passa per il fuso del client. Il difetto e' noto e
   corretto in **un percorso solo**.
4. PostgreSQL: tipi definiti dall'utente, estensioni, RLS/policy, ACL/owner, Large Object,
   partizioni ed ereditarieta' non sono coperti da nessuno dei due percorsi.

Baseline dei test: `npm test` verde. Era rossa, per un difetto del test e non del codice —
`test/unit-sql-write-batch.js` delimitava il corpo del metodo con `'
  }
'` su un
checkout Windows a CRLF, quindi il metodo si riduceva a tre caratteri: la prima asserzione
falliva sempre e le due negative passavano sempre. Corretto normalizzando i fine riga;
sensibilita' verificata rompendo di proposito `executeWriteBatch`.

Gli E2E sui motori veri non sono eseguibili in questo ambiente: MongoDB, MySQL e
PostgreSQL non rispondono e il demone Docker non e' attivo. Le righe «non verificato»
della matrice restano tali finche' non c'e' un ambiente con i tre motori.
