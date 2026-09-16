# Guida operativa — export e import (parti verificate)

Stato: copre solo ciò che è implementato e provato (`npm test` verde, 17 suite
del piano). Il resto del piano resta nelle issue di
`.scratch/export-import-fedele/` e in `gate-stato.md`: questa guida non lo
promette.

## Piani: un contratto, non un modulo

Export (`db/exportPlan.js`), selezione import (`db/selezioneImport.js`) e
import/restore (`db/importPlan.js`) costruiscono oggetti immutabili firmati
dalla stessa impronta (`db/pianoComune.js`). L'anteprima mostra il piano, la
conferma ne fissa l'impronta, l'esecuzione la ricontrolla: se divergono,
l'esecuzione rifiuta. Il riepilogo per la UI è `public/js/riepilogo-piano.js`.

## Data-plane HTTP: i file viaggiano qui

I comandi restano su Socket.IO; i byte passano da:

- `POST /artefatti/caricamenti` → apre la sessione, risponde con `uploadId` e
  ticket di blocco. Serve il ticket `caricamenti`, emesso via socket con
  l'evento `artefatti:ticket` (solo chi amministra il tenant).
- `POST /artefatti/caricamenti/:id/blocco` → un blocco binario con header
  `x-codedb-offset` e `x-codedb-blocco-sha256`. Ripetere un blocco già scritto
  è idempotente; conflitti e buchi sono rifiutati (409).
- `POST /artefatti/caricamenti/:id/finalizza` → verifica dimensione e SHA-256
  dichiarati e pubblica manifest + ticket di download. Impronta errata: 409,
  niente pubblicato.
- `POST /artefatti/caricamenti/:id/scarta` → cancella l'incompleto.
- `GET /artefatti/:id/scarica?ticket=…` (anche HEAD) → 200/206/416 con `ETag`
  = SHA-256, `Accept-Ranges`, ripresa via `Range`/`If-Range`.

Autenticazione: ticket brevi (5 minuti) legati a risorsa, attore e tenant —
mai il token di sessione nell'URL. Ogni evento di ciclo di vita e ogni rifiuto
finisce in `<tenant>/artefatti/trasferimenti.log`, senza ticket né byte.

## Coerenza e diario: cosa dichiara ogni backup

Il manifest riporta `coerenza`: snapshot `repeatable-read` su MySQL e
PostgreSQL, topologia rilevata e assenza di snapshot globale su MongoDB.
Le operazioni di import scrivono un journal per tenant (`import-diario/`):
dopo un crash, la prima lettura dichiara `intervento_richiesto` a esito
incerto invece di presumere — mai completato presunto, mai cancellato da solo.

## Fedeltà dei tipi

Scritture EJSON sempre canoniche (`db/codecFedele.js`): `Long`, `Double`,
`Decimal128` e oltre-2^53 tornano distinti. I file relaxed storici restano
leggibili. Tabelle PostgreSQL senza chiave: keyset su `ctid`, mai `OFFSET`.

## Variabili

| Variabile | Default | Effetto |
|---|---|---|
| `CODEDB_ARTEFATTI_MAX_BYTES` | 10 GiB | Tetto del singolo artefatto |
| `CODEDB_ARTEFATTI_MAX_BLOCCO` | 4 MiB | Tetto del blocco (anche limite HTTP) |
| `CODEDB_ARTEFATTI_QUOTA_BYTES` | illimitata | Quota disco del tenant, controllo all'avvio |
| `CODEDB_ARTEFATTI_TTL_MS` | 24 h | Scadenza degli upload incompleti |
| `CODEDB_ARTEFATTI_RETENTION_MS` | mai | Scadenza dei finalizzati (opt-in) |
| `CODEDB_ARTEFATTI_SECRET` | effimero | Segreto HMAC dei ticket (riavvio li invalida) |
| `CODEDB_PG_DUMP`, … | PATH | Percorso del binario nativo dedicato |

## Non ancora (serve ambiente o browser)

Esecuzione degli export/import selettivi sui DBMS, tool nativi in esercizio,
wizard DOM con progresso e accessibilità, benchmark e gate E2E. Vedi
`gate-stato.md` per il dettaglio prova per prova.
