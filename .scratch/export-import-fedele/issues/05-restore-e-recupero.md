Status: ready-for-agent
Blocked by: 04

# Fase 4 — Restore e recupero

Piano: `docs/piano-export-import-database.md` §11, riga «4 — Restore e recupero»;
§8 (import affidabile, promozione e recupero), §9 (che cosa significa «verificato»).

## Perimetro

`db/importPlan.js`, gli adapter, `db/importOperations.js`, lock e audit. Journal su disco
per tenant, ripresa che recupera **operazioni** e non solo byte.

## Criterio di uscita (dal piano)

Verifica completa di contenuti e schema; l'import selettivo preserva gli esclusi;
conflitti e crash/rollback gestiti; dipendenze esterne dello swap provate.

## Stato parziale (verificato, senza motori live)

- `db/diarioOperazioni.js` (nuovo): journal per tenant (`import-diario/`),
  voci atomiche all'accettazione, a ogni cambio di fase e all'esito; solo stato
  pubblico (niente adapter/strategy/segreti). `riconcilia` dichiara
  `intervento_richiesto` + `esitoIncerto` su ciò che era in volo — mai
  completato presunto, mai cancellato; idempotente.
- `db/importOperations.js`: diario opzionale (i contesti finti restano leggeri);
  `get`/`list` guariscono dal diario alla prima lettura; `cleanup` chiude anche
  il diario; la retention cancella il diario solo dei completati — le voci
  d'errore col recupero penzolante sopravvivono. Cablato in
  `server/operazioni.js` sotto la radice del tenant. Prova:
  `test/unit-diario-operazioni.js` (puro, crash simulato, esito felice, errore
  oltre la retention), verde; sensibilità verificata (riconcilia che assolve →
  fallisce; ripristino → verde).
- Già presenti e riusati: staging, recupero, verifica prima/dopo promozione,
  conflitti e rollback negli adapter (prove esistenti verdi).
- Resta fuori (serve ambiente): import selettivo che preserva gli esclusi su DB
  reale, dipendenze esterne dello swap PG (OID, grant, search_path), esito
  COMMIT incerto contro un DBMS vero.
