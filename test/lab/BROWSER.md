# Laboratorio browser con database reali

`node test/lab/browser.cjs` avvia CodeDB isolato, prepara fixture proprie tramite
driver nativi e percorre l'interfaccia con Playwright. Richiede
`CODEDB_E2E_DESTRUCTIVE=1` e i tre database Docker del laboratorio. Crea e rimuove
solo database/schemi casuali registrati dal test harness; non usa configurazioni
o vault dell'utente. Le credenziali del laboratorio sono scritte in un INI
temporaneo, eliminato alla fine; le password sono omesse dal rapporto.

| Variabile | Default host Windows |
|---|---|
| `MONGO_PORT` | `37017` |
| `MYSQL_PORT`, `MYSQL_PASSWORD` | `33306`, `lab_mysql` |
| `PG_PORT`, `PG_PASSWORD` | `35432`, `lab_postgres` |
| `LAB_BROWSER_PORT` | `39040` |
| `LAB_REPORT_DIR` | `.scratch/lab-reports/browser` |
| `LAB_BROWSER_EXECUTABLE` | Chromium Playwright, poi Chrome installato |

In container impostare le porte interne dei servizi e installare Chromium con le
sue dipendenze. La connessione MongoDB usa sempre `directConnection=true`.
Le connessioni puntano a `127.0.0.1`: il runner deve condividere la rete dei
database, come fa `compose.yml` con `network_mode: service:rete`. La cache
Chromium deve essere leggibile nella `PLAYWRIGHT_BROWSERS_PATH` del runner.

## Copertura e oracoli

- Tre motori: MongoDB, MySQL e PostgreSQL, con 1.203 record ciascuno.
- Connessione dall'albero, apertura griglia e query digitata nell'editor reale.
- Editing di testo e decimale esatto, conferma e annullamento; lettura indipendente
  dal driver verifica la persistenza e che il BIGINT oltre 2^53 resti invariato.
- Risultati tabellari: confronto di `9007199254740993` e del decimale completo.
  Nel JSON Tree viene verificata esplicitamente la rappresentazione del BIGINT.
- Grafico con venti quantità: confronto della serie effettivamente disegnata,
  oltre alla presenza del canvas. La lettura dell'istanza ECharts è un oracolo,
  non viene usata per creare i risultati.
- Mappa con venti punti, selezione e zoom; riapertura dopo resize e nuova query.
- Viewport desktop 1440×1000 e mobile 390×844, controllo overflow, editing tramite
  doppio tocco touchscreen emulato e verifica dei dati nel database.
- Query SQL realmente lenta: heartbeat browser durante `SLEEP`/`pg_sleep`.
- Tutti i 1.203 risultati, finestra DOM inferiore a cento righe e scorrimento
  utente fino all'ultimo record. I tempi sono misure diagnostiche locali.
- Eccezioni JavaScript, errori console e richieste fallite raccolti nel rapporto.
- Sensibilità separata: il test altera temporaneamente il numero osservato nel
  DOM a `9007199254740992`, verifica che l'oracolo fallisca e ripristina il testo.
  Nessun file di produzione viene alterato e nessuna risposta socket è simulata.

Ogni scenario ha esito e durata propri e continua dopo un fallimento. I percorsi
di uno stesso motore condividono intenzionalmente la sessione, per verificare
anche le transizioni reali; se connessione o prima query falliscono, gli scenari
dipendenti di quel motore non vengono eseguiti. Il JSON e gli screenshot sono salvati nella directory
di rapporto; il processo restituisce un codice non zero se una verifica fallisce.

## Prima esecuzione completa

Il 21 ottobre 2026 (ora italiana), Chrome 155.0.8059.85 su Windows, MongoDB
8.0.34, MySQL 8.4.11 e PostgreSQL 17.5: **40 PASS e 2 FAIL su 42 verifiche**,
circa 41 secondi. Nessuna richiesta fallita. Tutte le fixture sono state rimosse.
Le tre prove di sensibilità hanno rilevato la corruzione intenzionale.

I due fallimenti riguardano la stessa classe di difetto: la mappa dopo selezione
di un punto, animazione, resize o cambio vista genera
`Invalid LatLng object: (NaN, NaN)`. Sono state osservate otto eccezioni asincrone
nei percorsi dei tre motori, riconducibili a `geo-vista.js:458` (`invalidateSize`)
e al completamento dell'animazione Leaflet. Nel percorso MongoDB la mappa mobile
rimane vuota con canvas 0×0; lo screenshot `errore-11.png` mostra il risultato.
Il rendering intercettato dalla console passa anche da `geo-vista.js:199`
(`inquadraTutto`) e `:454` (`aggiorna`). Il difetto è confermato; la correzione
della gestione delle animazioni richiede un intervento successivo sul prodotto.

Questa suite prova un browser e touchscreen emulato, non dispositivi fisici,
Safari o Firefox. Le geometrie sono GeoJSON nei documenti/campi JSON; i tipi
spaziali nativi e le relative conversioni sono coperti dal laboratorio integrità.
Non costituisce una prova di carico concorrente né una certificazione generale
di affidabilità. I fallimenti restano visibili finché il prodotto non viene corretto.
