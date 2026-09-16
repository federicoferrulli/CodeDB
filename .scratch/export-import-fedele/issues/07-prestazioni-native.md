Status: ready-for-agent
Blocked by: 06

# Fase 6 — Prestazioni native

Piano: `docs/piano-export-import-database.md` §11, riga «6 — Prestazioni native»;
§4 («Motori: criteri di scelta»), §12 («Benchmark riproducibile»).

## Perimetro

Backend PostgreSQL, MySQL e MongoDB nativi; limiti dei worker, caricamento massivo,
compressione e packaging.

## Criterio di uscita (dal piano)

Concorrenza misurata senza perdere la snapshot; confronto con il tool nativo a parità di
garanzie; CPU, RAM e disco entro i budget di §7.

## Stato parziale (verificato, senza binari né motori)

Nessun binario nativo installato (`pg_dump`, `mongodump`, `mysqlsh`, … assenti;
demone Docker fermo): l'esecuzione reale resta impossibile in questo ambiente.
Verificabile invece il contratto §4, implementato in `backup/lib/nativi.js`:

- `eseguiTool`: spawn con array (mai shell), ambiente aggiunto non sostituito,
  `windowsHide`, password solo su stdin, timeout e abort che uccidono l'intero
  albero (`taskkill /T` su Windows, gruppo su POSIX), rapporto con exit code.
- `versioneTool`: versione dal tool stesso, illeggibile = inutilizzabile.
- Vincoli rifiutati prima del lavoro: `--oplog` con selezione (mongodump),
  `--jobs` senza directory (pg_dump), `--jobs` con `--single-transaction`
  (pg_restore).
- `fileCredenziali`/`rigaPgpass`/`redigi`: segreti in file 0600 esclusivi o
  redatti nei log; `disponibilita`: variabile dedicata, PATH, assenza con
  istruzioni (mai fallback silenzioso).
- Prova: `test/unit-nativi.js` con spawn iniettato, verde; sensibilità
  verificata. Trovata per strada: un timer unref'd non tiene vivo il loop, il
  test usa un watchdog (documentato nel test).

Resta fuori (serve ambiente): esecuzione reale, limiti worker misurati,
confronto col tool nativo a pari garanzie, budget CPU/RAM/disco sui dataset di
`docs/benchmark-export-import.md`.
