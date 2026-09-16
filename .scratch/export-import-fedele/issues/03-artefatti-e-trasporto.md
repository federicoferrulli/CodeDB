Status: resolved
Blocked by: 02

# Fase 2 — Artefatti e trasporto

Piano: `docs/piano-export-import-database.md` §11, riga «2 — Artefatti e trasporto»;
§4 (formati), §7 (trasferimento e memoria limitata).

## Perimetro

`backup/lib/util.js`, `db/importUploads.js`, registro delle operazioni, e un modulo HTTP
dedicato integrato nel server. Download con `Content-Length`, `Content-Disposition`,
`ETag`, `Range`/`If-Range`, 206/416 e ripresa; upload a blocchi scritti su disco con
offset, hash di blocco e conferme persistenti.

## Criterio di uscita (dal piano)

Export, upload e download a memoria limitata; hash, finalizzazione, Range e ripresa HTTP
funzionanti; `.codedb.json` v1 ancora leggibile.

## Risposta

Fase 2 chiusa sul trasporto; il vecchio registro socket resta per compatibilità.

- Strato decisionale puro (turno precedente, confermato): `db/trasferimenti.js`
  (Range RFC 9110, ETag, If-Range mai cucito, blocchi idempotenti/conflitti,
  ticket firmati) e `db/artefattoStreaming.js` (lettore v1 senza materializzare,
  con `StringDecoder` per gli UTF-8 a cavallo dei blocchi). Prove cablate in
  `test/unit.js`, verdi.
- `db/uploadDisco.js` (nuovo): sessioni su disco sotto la radice del tenant
  (`caricamenti/<id>/dati.part` + `stato.json` atomico a ogni blocco), decisioni
  di `decidiBlocco` riusate e non riscritte, SHA-256 per blocco e digest di file
  ricalcolato alla finalizzazione, pubblicazione atomica (`dati.bin` +
  `manifesto.json`), ripresa dopo crash dallo stato su disco, TTL con spazzino
  per tenant, isolamento owner/attore, id validati (niente percorsi dal client).
  Niente tetto globale finto: senza elenco tenant non si conta, vale quello per
  owner. Prova: `test/unit-upload-disco.js`, cablato, verde; sensibilità
  verificata (digest disattivato → fallisce; ripristino → verde).
- `server/http-artefatti.js` (nuovo) + wiring in `server/operazioni.js` e
  `server/createServer.js`: POST creazione/blocco/finalizza/scarta e GET/HEAD
  download con `ETag` = SHA-256 del manifest, `Accept-Ranges`,
  `Content-Disposition`, `Cache-Control: no-store`, 200/206/416 e If-Range;
  ticket in `Authorization: Bearer` per l'upload e `?ticket=` per il download da
  navigazione; gate Origin uguale all'handshake; segreto da
  `CODEDB_ARTEFATTI_SECRET` o effimero (fail-closed al riavvio). Prova:
  `test/unit-http-artefatti.js` contro server effimero reale, verde;
  sensibilità verificata (controllo risorsa disattivato → il caso cross-risorsa
  fallisce; ripristino → verde).
- `artefatti:ticket` (amministrativo, tracciato senza il segreto, in
  `server/eventi-import.js` + `server/audit.js`): emette ticket legati a tenant
  e attore del chiamante. Registro eventi a 95, amministrativi a 32
  (`test/server-eventi-attesi.json`, `test/unit-giuntura-amministrativa.js`).
  Prova: `test/unit-artefatti-ticket.js` col modulo vero, verde.

Confini espliciti, non omissioni: «export a memoria limitata» vale per il motore
di backup riusato (scrive già in streaming su disco, non duplicato qui); il
percorso GUI che assembla il `.codedb.json` nel browser si chiude in Fase 5 col
wizard. Il vecchio `db/importUploads.js` in memoria resta per il path socket
storico. Retention dei finalizzati e riuso degli alias cloud: con la Fase 4.

## Addendum — audit, quota, retention (stesso turno, ciclo di vita §10)

Il data-plane nasceva senza tracce: Socket.IO audita, HTTP no.

- `registraEvento` in `creaModuloArtefatti` + wiring su
  `<tenant>/artefatti/trasferimenti.log`: ciclo di vita (avvio, finalizzazione,
  scarto, download completato/interrotto a fine stream, HEAD, 416) e ogni
  rifiuto; mai ticket né byte. Prova: `test/unit-audit-artefatti.js`, verde;
  sensibilità verificata.
- `usoTenant` + `quotaTenantBytes` (default illimitata, configurata
  dall'operatore): controllo all'avvio, prima di promettere spazio.
- `pulisciFinalizzatiDi`: di default conserva tutto (artefatti dell'utente),
  rimuove solo a scadenza configurata. Prove in `unit-upload-disco`,
  sensibilità verificata.
- Ticket solo a chi amministra il tenant (`canAdminTenant` in
  `artefatti:ticket`): un artefatto può contenere l'intero database, e un
  sottoutente con scope non deve aggirare i permessi per connessione. Prova in
  `unit-artefatti-ticket`, sensibilità verificata.
