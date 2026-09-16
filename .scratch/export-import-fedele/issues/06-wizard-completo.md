Status: ready-for-agent
Blocked by: 05

# Fase 5 — Wizard completo

Piano: `docs/piano-export-import-database.md` §11, riga «5 — Wizard completo»; §3
(interfaccia: flusso di esportazione e importazione, accessibilità).

## Perimetro

`public/js/exportimport.js`, `public/js/import-status.js`, integrazione con il gestore
dei backup, modali e temi.

## Criterio di uscita (dal piano)

Tutte le scelte esposte, anteprima fedele all'esecuzione, progresso non bloccante, prove
su browser ed Electron, accessibilità.

## Stato parziale (verificato, senza browser)

- `public/js/export-selezione.js` (nuovo, ESM puro senza DOM): stato
  dell'albero di selezione a tre stati con colonne Struttura/Dati indipendenti —
  la ricerca restituisce visibilità e non tocca mai la selezione; il gruppo
  propaga ai figli (i dati solo dove hanno senso, le viste non votano); azioni
  globali tutto/nessuno/solo-struttura/solo-dati; riepilogo per la conferma;
  `perPiano()` alimenta `creaPianoExport` in personalizzata senza adattamenti
  (provato contro il piano vero). Il wizard futuro lo importa così com'è: una
  sola definizione di «selezionato». Prova: `test/unit-export-selezione.js`
  (dynamic import, 5000 oggetti), verde; sensibilità verificata.
- `public/js/import-mapping.js` (nuovo, ESM puro): mapping nomi con avvisi —
  collisioni fra sorgenti, fold delle maiuscole su PostgreSQL, nomi che
  esistono già; politica e database restano fuori. Prova:
  `test/unit-import-mapping.js`, verde; sensibilità verificata.
- `public/js/riepilogo-piano.js` (nuovo, ESM puro): l'anteprima come lettura
  del piano — titolo, voci, avvisi (orfane, vincoli omessi, non deducibili,
  drop con recupero) e impronta che viaggia con l'anteprima; senza impronta non
  si mostra nulla. Prova contro i piani veri (`unit-riepilogo-piano`), verde;
  sensibilità verificata.
- Resta fuori (serve browser/Electron): modali, integrazione backup manager,
  progresso non bloccante, temi, navigazione tastiera, screen reader, salvataggio
  diretto Electron — scriverli qui senza eseguirli violerebbe la regola
  «risolto significa verificato».
