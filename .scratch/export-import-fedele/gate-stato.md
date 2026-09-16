# Stato dei gate di rilascio (§12 del piano)

Verificato il 16 settembre 2026 in questo ambiente (nessun DBMS, nessun Docker,
nessun browser). Ogni gate dice la sua prova o il suo blocco — non esistono
gate «quasi superati».

## Prima dei gate: che cosa è RAGGIUNGIBILE

Un modulo verde e irraggiungibile non è una funzione consegnata, quindi questa
sezione viene prima dei gate. Verificato da `test/unit-wizard-export.js`, che
segue la catena di import vera a partire da `main.js` e controlla ogni `#id`
usato dal codice contro il markup: un modulo scollegato o un id scritto male
falliscono il test invece di restare silenziosi.

| Modulo | Chiamante in produzione |
|---|---|
| `db/exportCatalogo.js`, `db/exportPlan.js` | evento `database:export:plan` |
| `db/selezioneImport.js` | evento `database:import:selezione` |
| `backup/lib/nativi.js` | `backendDisponibile`, dal piano di export |
| `db/artefattoStreaming.js` | `importUploads.finish` |
| `public/js/export-selezione.js` | albero del wizard `#dbexport-overlay` |
| `public/js/riepilogo-piano.js` | `piano-anteprima.js` → conferma di export e import |
| `public/js/import-mapping.js` | avvisi di collisione in `#dbimport-mapping` |

Cablati già prima: `db/codecFedele.js`, `db/mongoTopologia.js`,
`db/pianoComune.js`, `db/diarioOperazioni.js`, `db/trasferimenti.js`,
`db/uploadDisco.js`, `server/http-artefatti.js`, evento `artefatti:ticket`.

**Resta senza cablaggio una cosa sola, e va dichiarata**: il data-plane HTTP
(`/artefatti/...`) è montato e nessun client lo usa — l'upload dell'import
passa ancora per Socket.IO. È superficie senza funzione finché il
trasferimento a blocchi su disco non sostituisce quella via; chi rilascia
decida se tenerlo dietro una variabile nel frattempo.

**Ceiling dichiarati del cablaggio nuovo**, perché «collegato» non vuol dire
«completo»:

* l'export ESEGUE ancora dal browser, evento per evento. Il piano ne decide il
  perimetro e l'ordine — non è una decorazione, è ciò che viene esportato — ma
  il motore server-side dell'export (§7) resta da scrivere;
* la selezione di import è **costruita, firmata e validata** prima di ogni
  scrittura (rifiuta `fondi` senza identità stabile, e i dati che l'archivio
  non contiene), ma l'esecutore non onora ancora le politiche per oggetto:
  `crea-se-assente` e `sostituisci` corrispondono a ciò che fa già, `accoda` e
  `fondi` sono dichiarate e non eseguibili;
* `backup/lib/nativi.js` è collegato per la **disponibilità** (il piano dichiara
  `backend: nativo|incorporato` guardando i binari, invece di prometterlo); i
  dump nativi veri non sono ancora invocati.

## I gate

| Gate (§12) | Stato | Prova / blocco |
|---|---|---|
| Round trip | IN ATTESA | Richiede i tre DBMS live: origine → file → nuova destinazione con confronto nativo |
| Selezione | PARZIALE | Piani/chiusura/ordine/esclusioni/mapping provati senza DB (`unit-piano-export`, `unit-export-catalogo`, `unit-export-selezione`, `unit-import-mapping`) e ora raggiungibili dai due eventi (`unit-piano-export-evento`: piano firmato, connessione dalla sessione, database di sistema rifiutato lato server); FK cicliche/esterne e schemi omonimi solo su cataloghi finti |
| Consistenza | PARZIALE | Snapshot REPEATABLE READ e keyset ctid nel codice + prove di forma; writer concorrenti e DDL durante export solo su motori live |
| Verifica sensibile | VERIFICATO | Ogni suite ha la sua mutazione osservata fallire e il ripristino verde (piano, catalogo, trasferimenti, streaming, upload, HTTP, ticket, codec+ctid, diario, selezione, mapping, nativi, topologia/dump). Comprese le guardie nuove: liveness del diario (istanza e battito, isolate una per una), revoca del ticket, tetto incrementale del lettore streaming |
| Guasti | PARZIALE | Crash export/import, 416/If-Range, conflitti blocchi, timeout/abort nativi, retention diario, **operazione viva non dichiarata orfana** (istanza propria e battito altrui): provati. Disco pieno, COMMIT incerto su DBMS: in attesa |
| Sicurezza | PARZIALE | Cross-tenant, attore, traversal, id validati, ticket solo ad admin tenant, **revoca dell'attore su ticket ancora in corso**, Origin, audit del data-plane senza segreti, quota/retention, **ownerId validato e non riscritto**, **credenziali Mongo fuori dagli argomenti**: provati. Scope dei tool nativi su DB reale: in attesa |
| Compatibilità | PARZIALE | File storici relaxed e v1 leggibili: provato. Versioni tool/DB e charset/collation su motori: in attesa. **Su Windows i lanciatori `.cmd` non sono più candidati** (`spawn` con `shell: false` li rifiuta): serve l'eseguibile vero |
| GUI | PARZIALE | Wizard cablato e caricato senza errori JS (`e2e-avvio-ui`), contrasto verde nei due temi (`e2e-contrasto-viste`), id e catena di import provati (`unit-wizard-export`). Cambio tab a metà export, migliaia di oggetti nell'albero, tastiera e screen reader: in attesa di prove nel browser |

Suite unitaria: verde (`npm test`), incluse le 16 suite del piano.
E2E e benchmark: bloccati dall'ambiente, dataset e metodo fissati in
`docs/benchmark-export-import.md`.
